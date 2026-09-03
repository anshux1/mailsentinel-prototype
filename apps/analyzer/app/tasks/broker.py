# mypy: disable-error-code="no-untyped-call"

import time

import dramatiq
from dramatiq.brokers.redis import RedisBroker
from dramatiq.brokers.stub import StubBroker
from dramatiq.middleware import AgeLimit, Retries, TimeLimit, default_middleware

from app.analysis import AnalysisError, run_analysis
from app.core.logging import (
    analysis_run_id_context,
    get_structured_logger,
    log_event,
    request_id_context,
    safe_request_id,
)
from app.core.settings import get_settings
from app.persistence.postgres import PostgresAnalysisRepository
from app.persistence.s3 import S3EvidenceStore

settings = get_settings()
logger = get_structured_logger("mailsentinel.worker")


def configured_middleware() -> list[object]:
    """Use Dramatiq defaults once, overriding only setup policies."""
    return [
        TimeLimit(time_limit=max(1_000, int(settings.execution_timeout_seconds * 1_000)))
        if middleware is TimeLimit
        else AgeLimit(max_age=15 * 60 * 1_000)
        if middleware is AgeLimit
        else Retries(max_retries=3, min_backoff=1_000, max_backoff=30_000)
        if middleware is Retries
        else middleware()
        for middleware in default_middleware
    ]


middleware = configured_middleware()
broker = (
    StubBroker(middleware=middleware)
    if settings.app_env == "test"
    else RedisBroker(url=str(settings.redis_url), middleware=middleware)
)
dramatiq.set_broker(broker)


@dramatiq.actor(queue_name="analysis", max_retries=3)
def setup_analysis(analysis_run_id: str | dict[str, object]) -> None:
    """Compatibility setup actor; it validates the queue id but does no analysis."""
    if isinstance(analysis_run_id, dict):
        run_id = (
            analysis_run_id.get("analysisRunId") or analysis_run_id.get("analysis_run_id") or analysis_run_id.get("id")
        )
    else:
        run_id = analysis_run_id
    if not run_id:
        raise ValueError("analysis_run_id is required")


@dramatiq.actor(queue_name="analysis", max_retries=3)
def process_analysis(analysis_run_id: str | dict[str, object], request_id: str | None = None) -> None:
    """Run one idempotent analysis using authoritative database metadata."""
    if isinstance(analysis_run_id, dict):
        run_id = (
            analysis_run_id.get("analysisRunId") or analysis_run_id.get("analysis_run_id") or analysis_run_id.get("id")
        )
        req_id = analysis_run_id.get("requestId") or analysis_run_id.get("request_id") or request_id
    else:
        run_id = str(analysis_run_id) if analysis_run_id else ""
        req_id = request_id

    if not run_id:
        raise ValueError("analysis_run_id is required")
    normalized_run_id = str(run_id)
    normalized_request_id = str(req_id)[:120] if req_id is not None else None
    run_token = analysis_run_id_context.set(normalized_run_id)
    request_token = request_id_context.set(safe_request_id(normalized_request_id))
    started = time.perf_counter()
    log_event(logger, 20, "analysis.started", phase="queued")
    try:
        repository = PostgresAnalysisRepository(str(settings.database_url))
        store = S3EvidenceStore(settings)
        result = run_analysis(
            normalized_run_id,
            repository=repository,
            evidence_store=store,
            settings=settings,
            request_id=normalized_request_id,
            phase_callback=lambda phase, progress: log_event(
                logger,
                20,
                "analysis.phase",
                phase=phase,
                progress=progress,
            ),
        )
        log_event(
            logger,
            20,
            "analysis.completed",
            phase="completed",
            durationMs=round((time.perf_counter() - started) * 1000, 2),
            indicatorCount=len(result.indicators) if result is not None else 0,
            enrichmentCount=len(result.enrichment) if result is not None else 0,
            warningCount=len(result.parser_warnings) if result is not None else 0,
            score=result.score.final_score if result is not None else None,
            verdict=result.verdict.value if result is not None else None,
            confidence=result.confidence if result is not None else None,
        )
    except AnalysisError as error:
        log_event(
            logger,
            40 if error.retryable else 30,
            "analysis.failed",
            phase="failed",
            durationMs=round((time.perf_counter() - started) * 1000, 2),
        )
        if error.retryable:
            raise
        # Terminal failures are persisted by run_analysis and acknowledged.
        return
    except Exception as error:
        # Transport/configuration failures are safe to retry; never serialize
        # the exception message because it may contain provider or credential data.
        log_event(
            logger,
            40,
            "analysis.failed",
            phase="failed",
            durationMs=round((time.perf_counter() - started) * 1000, 2),
            errorType=type(error).__name__,
        )
        raise
    finally:
        request_id_context.reset(request_token)
        analysis_run_id_context.reset(run_token)
