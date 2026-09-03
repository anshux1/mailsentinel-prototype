"""Pure orchestration for one bounded, deterministic forensic analysis."""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import UTC, datetime
from threading import Thread

from app.contracts.models import (
    MAX_ENRICHMENT,
    MAX_PARSER_WARNINGS,
    AnalysisFailureCode,
    AnalysisResult,
    AnalysisStatusValue,
)
from app.core.settings import Settings
from app.enrichment.providers import EnrichmentConfig, InMemoryIndicatorCache, enrich
from app.extraction.extract import (
    extract_addresses,
    extract_auth_conflicts,
    extract_authentication,
    extract_content_indicators,
    extract_date,
    extract_headers,
    extract_identity,
    extract_indicators,
    extract_link_mismatches,
    extract_message_ids,
    extract_mime_parts,
    extract_nested_messages,
    extract_received,
    extract_routing_anomalies,
)
from app.parsing.parser import ParsedMessage, parse_message
from app.persistence.interfaces import AnalysisRepository, EvidenceStore
from app.scoring.rules import RULESET_VERSION, confidence_for, score_findings, verdict_for
from app.segmentation import ContainerFormat, detect_container

PhaseCallback = Callable[[str, int | None], None]
_ANALYSIS_CACHES: dict[str, InMemoryIndicatorCache] = {}


class AnalysisError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.retryable = retryable


def analyze_bytes(
    *,
    run_id: str,
    organization_id: str,
    case_id: str,
    artifact_sha256: str,
    artifact_byte_size: int,
    raw: bytes,
    settings: Settings,
    now: datetime | None = None,
    phase_callback: PhaseCallback | None = None,
) -> AnalysisResult:
    """Analyze bytes without network access or side effects.

    ``phase_callback`` is intentionally optional so this function remains useful
    as a pure unit-test API.  Callback failures are not allowed to change the
    analysis result.
    """

    def phase(name: str, progress: int | None) -> None:
        if phase_callback is not None:
            try:
                phase_callback(name, progress)
            except Exception:
                # Status reporting is observability, never an analysis dependency.
                pass

    analysis_time = now or datetime.now(UTC)
    if analysis_time.tzinfo is None or analysis_time.utcoffset() is None:
        analysis_time = analysis_time.replace(tzinfo=UTC)
    else:
        analysis_time = analysis_time.astimezone(UTC)

    phase("parsing", 30)
    try:
        parsed: ParsedMessage = parse_message(
            raw,
            max_bytes=settings.max_eml_bytes,
            max_parts=settings.max_mime_parts,
            max_depth=settings.max_mime_depth,
            max_headers=settings.max_header_count,
            max_attachment_bytes=settings.max_attachment_bytes,
        )
    except ValueError as error:
        code = getattr(error, "code", "message_invalid")
        raise AnalysisError(code, str(error), retryable=False) from error

    phase("extracting", 50)
    headers = extract_headers(parsed)
    addresses = extract_addresses(parsed)
    authentication = extract_authentication(parsed)
    auth_conflicts = extract_auth_conflicts(authentication)
    received = extract_received(parsed)
    routing_anomalies = extract_routing_anomalies(received)
    mime_parts = extract_mime_parts(parsed)
    indicators = extract_indicators(parsed, settings.max_urls)
    identity_observations = extract_identity(parsed, addresses)
    date_observations = extract_date(parsed, received, analysis_time)
    message_id_observations = extract_message_ids(parsed, addresses)
    content_indicators = extract_content_indicators(parsed)
    link_mismatches = extract_link_mismatches(parsed)
    nested_messages = extract_nested_messages(
        raw,
        analysis_time=analysis_time,
        max_urls=settings.max_urls,
        max_nested_depth=settings.max_nested_message_depth,
        max_nested_messages=settings.max_nested_messages,
        max_eml_bytes=settings.max_eml_bytes,
        max_mime_parts=settings.max_mime_parts,
        max_mime_depth=settings.max_mime_depth,
        max_headers=settings.max_header_count,
        max_attachment_bytes=settings.max_attachment_bytes,
    )

    phase("enriching", 70)
    live = settings.enrichment_mode == "live"
    # Separate caches preserve the shorter live-provider TTL.
    cache_ttl = (
        getattr(settings, "enrichment_live_cache_ttl_seconds", 3_600.0)
        if live
        else getattr(settings, "enrichment_cache_ttl_seconds", 86_400.0)
    )
    cache_key = settings.enrichment_mode
    cache = _ANALYSIS_CACHES.get(cache_key)
    if cache is None or cache.ttl_seconds != cache_ttl:
        cache = InMemoryIndicatorCache(ttl_seconds=cache_ttl)
        _ANALYSIS_CACHES[cache_key] = cache
    config = EnrichmentConfig(
        mode=settings.enrichment_mode,
        max_requests=getattr(settings, "enrichment_max_requests", 10),
        cache_ttl_seconds=getattr(settings, "enrichment_cache_ttl_seconds", 86_400.0),
        live_cache_ttl_seconds=getattr(settings, "enrichment_live_cache_ttl_seconds", 3_600.0),
        connect_timeout_seconds=getattr(settings, "enrichment_connect_timeout_seconds", 2.0),
        read_timeout_seconds=getattr(settings, "enrichment_read_timeout_seconds", 3.0),
        offline_database_path=getattr(settings, "offline_reputation_path", None),
        maxmind_database_path=settings.maxmind_db_path,
        live_api_key=(settings.abuseipdb_api_key.get_secret_value() if settings.abuseipdb_api_key else None),
    )
    enrichment = enrich(indicators, settings.enrichment_mode, config=config, cache=cache)[:MAX_ENRICHMENT]

    phase("scoring", 90)
    score = score_findings(
        addresses=addresses,
        authentication=authentication,
        received=received,
        indicators=indicators,
        mime_parts=mime_parts,
        warnings=parsed.warnings,
        enrichment=enrichment,
        identity_observations=identity_observations,
        date_observations=date_observations,
        message_id_observations=message_id_observations,
        content_indicators=content_indicators,
        link_mismatches=link_mismatches,
        routing_anomalies=routing_anomalies,
        auth_conflicts=auth_conflicts,
        nested_messages=nested_messages,
    )
    container_suspected = any("trailing_message_data" in w for w in parsed.warnings) or (
        detect_container(raw) != ContainerFormat.SINGLE
    )
    return AnalysisResult(
        schema_version="1.2.0",
        ruleset_version=RULESET_VERSION,
        analysis_version=settings.analysis_version,
        analysis_run_id=run_id,
        organization_id=organization_id,
        case_id=case_id,
        artifact_sha256=artifact_sha256,
        artifact_byte_size=artifact_byte_size,
        headers=headers,
        addresses=addresses,
        received_hops=received,
        authentication=authentication,
        mime_parts=mime_parts,
        indicators=indicators,
        enrichment=enrichment,
        parser_warnings=parsed.warnings[:MAX_PARSER_WARNINGS],
        identity_observations=identity_observations,
        date_observations=date_observations,
        message_id_observations=message_id_observations,
        content_indicators=content_indicators,
        link_mismatches=link_mismatches,
        routing_anomalies=routing_anomalies,
        auth_conflicts=auth_conflicts,
        findings=score.contributions,
        score=score,
        verdict=verdict_for(score.final_score),
        confidence=confidence_for(
            part_count=len(parsed.parts),
            warnings=parsed.warnings,
            enrichment_count=len(enrichment),
            indicator_count=len(indicators),
        ),
        analyzed_at=analysis_time,
        container_suspected=container_suspected,
        nested_messages=nested_messages,
    )


def _safe_failure_code(code: str) -> str:
    try:
        return AnalysisFailureCode(code).value
    except ValueError:
        return AnalysisFailureCode.ANALYSIS_FAILED.value


def _set_phase(repository: AnalysisRepository, run_id: str, phase: str, progress: int | None) -> None:
    callback = getattr(repository, "update_phase", None)
    if callable(callback):
        try:
            callback(run_id, phase, progress)
        except Exception:
            # A missing/temporarily unavailable progress store must not fail work.
            pass


def _run_with_watchdog(callback: Callable[[], AnalysisResult], timeout_seconds: float) -> AnalysisResult:
    """Run a pipeline in a daemon thread and return promptly on a hung dependency.

    Python cannot safely kill a running thread.  The daemon boundary ensures a
    stuck storage/provider operation cannot keep process shutdown hostage; the
    repository is marked retryable by the caller when the watchdog fires.
    """
    result: list[AnalysisResult] = []
    error: list[BaseException] = []

    def target() -> None:
        try:
            result.append(callback())
        except BaseException as exception:  # noqa: BLE001 - transport all worker errors to caller
            error.append(exception)

    worker = Thread(target=target, name="mailsentinel-analysis", daemon=True)
    worker.start()
    worker.join(timeout=max(0.001, timeout_seconds))
    if worker.is_alive():
        raise TimeoutError("analysis execution exceeded configured watchdog")
    if error:
        raise error[0]
    if not result:
        raise RuntimeError("analysis pipeline returned no result")
    return result[0]


def run_analysis(
    run_id: str,
    *,
    repository: AnalysisRepository,
    evidence_store: EvidenceStore,
    settings: Settings,
    request_id: str | None = None,
    phase_callback: PhaseCallback | None = None,
) -> AnalysisResult | None:
    """Claim, execute, and persist one idempotent analysis."""
    run = repository.get_run(run_id)
    if run is None:
        raise AnalysisError("analysis_run_not_found", "analysis run was not found", retryable=False)
    safe_id = re.compile(r"^[A-Za-z0-9_-]+$")
    if not safe_id.fullmatch(run.organization_id) or not safe_id.fullmatch(run.case_id):
        error = AnalysisError("intake_invalid", "organization or case identifier is invalid", retryable=False)
        repository.save_failed(run_id, error.code, error.message, error.retryable, request_id)
        raise error
    expected_prefix = f"organizations/{run.organization_id}/cases/{run.case_id}/artifacts/"
    valid_object_key = re.fullmatch(r"[A-Za-z0-9_-]+\.eml", run.object_key.removeprefix(expected_prefix))
    if (
        not run.object_key.startswith(expected_prefix)
        or valid_object_key is None
        or ".." in run.object_key
        or "\\" in run.object_key
        or "\x00" in run.object_key
    ):
        error = AnalysisError(
            "intake_invalid",
            "artifact object key does not match organization and case",
            retryable=False,
        )
        repository.save_failed(run_id, error.code, error.message, error.retryable, request_id)
        raise error

    def phase(name: str, progress: int | None) -> None:
        _set_phase(repository, run_id, name, progress)
        if phase_callback is not None:
            try:
                phase_callback(name, progress)
            except Exception:
                pass

    repository.mark_queued(run_id)
    phase("queued", 0)
    if not repository.claim(run_id):
        status = repository.get_status(run_id)
        if status in {AnalysisStatusValue.COMPLETED, AnalysisStatusValue.FAILED}:
            return None
        if status == AnalysisStatusValue.PROCESSING:
            raise AnalysisError(
                "analysis_run_concurrent_processing",
                "analysis run is currently being processed by another worker",
                retryable=True,
            )
        return None

    def execute() -> AnalysisResult:
        phase("fetching_evidence", 10)
        raw = evidence_store.read_verified(
            run.object_key,
            expected_sha256=run.sha256,
            expected_size=run.byte_size,
            max_bytes=settings.max_eml_bytes,
            expected_scope=(run.organization_id, run.case_id),
        )
        result = analyze_bytes(
            run_id=run.analysis_run_id,
            organization_id=run.organization_id,
            case_id=run.case_id,
            artifact_sha256=run.sha256,
            artifact_byte_size=run.byte_size,
            raw=raw,
            settings=settings,
            phase_callback=phase,
        )
        repository.save_completed(result)
        phase("completed", 100)
        return result

    try:
        return _run_with_watchdog(execute, getattr(settings, "execution_timeout_seconds", 120.0))
    except TimeoutError as error:
        repository.save_failed(
            run_id,
            "analysis_failed",
            "analysis execution exceeded the configured timeout",
            True,
            request_id,
        )
        raise AnalysisError(
            "analysis_failed", "analysis execution exceeded the configured timeout", retryable=True
        ) from error
    except AnalysisError as error:
        repository.save_failed(
            run_id,
            _safe_failure_code(error.code),
            error.message[:500],
            error.retryable,
            request_id,
        )
        raise
    except ValueError as error:
        evidence_errors = {
            "evidence_not_found",
            "evidence_too_large",
            "evidence_size_mismatch",
            "evidence_digest_mismatch",
            "evidence_storage_unavailable",
        }
        code = str(error) if str(error) in evidence_errors else "analysis_failed"
        retryable = code == "evidence_storage_unavailable"
        repository.save_failed(run_id, code, code.replace("_", " "), retryable, request_id)
        raise AnalysisError(code, code.replace("_", " "), retryable=retryable) from error
    except Exception as error:
        repository.save_failed(run_id, "analysis_failed", "analysis could not be completed", False, request_id)
        raise AnalysisError("analysis_failed", "analysis could not be completed", retryable=False) from error
