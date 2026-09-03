from datetime import UTC, datetime
from hashlib import sha256

import pytest

from app.analysis import AnalysisError, analyze_bytes, run_analysis
from app.contracts.models import AnalysisStatusValue, VerdictValue
from app.core.settings import Settings
from app.persistence.interfaces import InMemoryAnalysisRepository, MemoryEvidenceStore, RunInput

MESSAGE = (
    b"From: Billing <billing@sender.example>\n"
    b"Reply-To: help@other.example\n"
    b"Authentication-Results: mx.example; spf=fail (bad); dmarc=fail\n"
    b"Received: from 10.0.0.2 by mx.example; Wed, 01 Jan 2026 00:00:00 +0000\n"
    b"Subject: Account update\nMIME-Version: 1.0\n"
    b"Content-Type: text/plain; charset=utf-8\n\n"
    b"Please visit https://phishing.example/login\n"
)


VALID: dict[str, object] = {
    "app_env": "test",
    "database_url": "postgresql://user:password@localhost:5432/mailsentinel",
    "s3_access_key_id": "mailsentinel",
    "s3_secret_access_key": "mailsentinel-secret",
    "analyzer_service_token": "analyzer-token-change-me",
    "enrichment_mode": "fixture",
}


def make_test_settings(**overrides: object) -> Settings:
    return Settings(_env_file=None, **(VALID | overrides))  # type: ignore[call-arg, arg-type]


def test_analysis_is_deterministic_and_explainable() -> None:
    settings = make_test_settings()
    result = analyze_bytes(
        run_id="run_01",
        organization_id="org_01",
        case_id="case_01",
        artifact_sha256=sha256(MESSAGE).hexdigest(),
        artifact_byte_size=len(MESSAGE),
        raw=MESSAGE,
        settings=settings,
        now=datetime(2026, 1, 1, tzinfo=UTC),
    )
    assert result.verdict in {VerdictValue.SUSPICIOUS, VerdictValue.MALICIOUS}
    assert result.score.final_score == min(100, sum(item.score_contribution for item in result.findings))
    assert all(item.explanation and item.rule_id for item in result.findings)
    assert result.analyzed_at == datetime(2026, 1, 1, tzinfo=UTC)


def test_run_is_idempotent_and_persists_result() -> None:
    settings = make_test_settings()
    key = "organizations/org_01/cases/case_01/artifacts/a.eml"
    repository = InMemoryAnalysisRepository(
        [RunInput("run_01", "org_01", "case_01", key, sha256(MESSAGE).hexdigest(), len(MESSAGE))]
    )
    store = MemoryEvidenceStore({key: MESSAGE})
    result = run_analysis("run_01", repository=repository, evidence_store=store, settings=settings)
    assert result is not None
    assert repository.states["run_01"] == AnalysisStatusValue.COMPLETED
    assert run_analysis("run_01", repository=repository, evidence_store=store, settings=settings) is None
    assert len(repository.results) == 1


def test_tampered_evidence_is_terminal_failure() -> None:
    settings = make_test_settings()
    key = "organizations/org_01/cases/case_01/artifacts/a.eml"
    repository = InMemoryAnalysisRepository([RunInput("run_01", "org_01", "case_01", key, "a" * 64, len(MESSAGE))])
    with pytest.raises(AnalysisError, match="evidence_digest_mismatch"):
        run_analysis(
            "run_01",
            repository=repository,
            evidence_store=MemoryEvidenceStore({key: MESSAGE}),
            settings=settings,
        )
    assert repository.states["run_01"] == AnalysisStatusValue.FAILED
    assert repository.failures["run_01"][0] == "evidence_digest_mismatch"


def test_message_limit_is_reported() -> None:
    settings = make_test_settings(max_eml_bytes=10)
    with pytest.raises(AnalysisError, match="evidence_too_large"):
        analyze_bytes(
            run_id="run_01",
            organization_id="org_01",
            case_id="case_01",
            artifact_sha256="a" * 64,
            artifact_byte_size=len(MESSAGE),
            raw=MESSAGE,
            settings=settings,
        )


def test_concurrent_processing_raises_retryable_error() -> None:
    settings = make_test_settings()
    key = "organizations/org_01/cases/case_01/artifacts/a.eml"
    repository = InMemoryAnalysisRepository(
        [RunInput("run_01", "org_01", "case_01", key, sha256(MESSAGE).hexdigest(), len(MESSAGE))]
    )
    # Manually transition to PROCESSING to simulate another active worker
    repository.claim("run_01")
    store = MemoryEvidenceStore({key: MESSAGE})

    with pytest.raises(AnalysisError) as exc_info:
        run_analysis("run_01", repository=repository, evidence_store=store, settings=settings)

    assert exc_info.value.code == "analysis_run_concurrent_processing"
    assert exc_info.value.retryable is True


def test_duplicate_delivery_preserves_completed_state() -> None:
    settings = make_test_settings()
    key = "organizations/org_01/cases/case_01/artifacts/a.eml"
    repository = InMemoryAnalysisRepository(
        [RunInput("run_01", "org_01", "case_01", key, sha256(MESSAGE).hexdigest(), len(MESSAGE))]
    )
    store = MemoryEvidenceStore({key: MESSAGE})
    result = run_analysis("run_01", repository=repository, evidence_store=store, settings=settings)
    assert result is not None
    assert repository.states["run_01"] == AnalysisStatusValue.COMPLETED

    # Duplicate delivery
    second_result = run_analysis("run_01", repository=repository, evidence_store=store, settings=settings)
    assert second_result is None
    assert repository.states["run_01"] == AnalysisStatusValue.COMPLETED


def test_storage_failure_is_classified_retryable() -> None:
    settings = make_test_settings()
    key = "organizations/org_01/cases/case_01/artifacts/a.eml"
    repository = InMemoryAnalysisRepository(
        [RunInput("run_01", "org_01", "case_01", key, sha256(MESSAGE).hexdigest(), len(MESSAGE))]
    )

    class FailingEvidenceStore:
        def read_verified(self, *args: object, **kwargs: object) -> bytes:
            raise ValueError("evidence_storage_unavailable")

    with pytest.raises(AnalysisError) as exc_info:
        run_analysis("run_01", repository=repository, evidence_store=FailingEvidenceStore(), settings=settings)

    assert exc_info.value.code == "evidence_storage_unavailable"
    assert exc_info.value.retryable is True
    assert repository.states["run_01"] == AnalysisStatusValue.FAILED
    assert repository.retryable["run_01"] is True
