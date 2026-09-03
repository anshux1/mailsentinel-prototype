import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import uuid4

import psycopg
import pytest

from app.contracts.models import (
    AnalysisResult,
    AnalysisStatusValue,
    ScoreBreakdown,
    VerdictValue,
)
from app.persistence.interfaces import InMemoryAnalysisRepository, MemoryEvidenceStore, RunInput
from app.persistence.postgres import PostgresAnalysisRepository

VALID_MESSAGE = b"From: a@b.com\nSubject: Hi\n\nHello"


def make_result(
    run_id: str,
    analysis_version: str = "prototype-1",
    schema_version: str = "1",
) -> AnalysisResult:
    return AnalysisResult(
        analysis_version=analysis_version,
        schema_version=schema_version,
        analysis_run_id=run_id,
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256=sha256(VALID_MESSAGE).hexdigest(),
        artifact_byte_size=len(VALID_MESSAGE),
        score=ScoreBreakdown(base_score=10, contributions=[], final_score=10),
        verdict=VerdictValue.BENIGN,
        confidence=0.9,
        analyzed_at=datetime.now(UTC),
    )


# --- In-Memory Repository Tests ---


def test_in_memory_transition_matrix() -> None:
    repo = InMemoryAnalysisRepository([RunInput("r1", "org1", "case1", "key1", "hash1", 100)])
    assert repo.get_status("r1") == AnalysisStatusValue.ACCEPTED

    # accepted -> queued
    repo.mark_queued("r1")
    assert repo.get_status("r1") == AnalysisStatusValue.QUEUED

    # queued -> processing
    assert repo.claim("r1") is True
    assert repo.get_status("r1") == AnalysisStatusValue.PROCESSING

    # Cannot claim already processing
    assert repo.claim("r1") is False

    # processing -> completed
    result = make_result("r1")
    repo.save_completed(result)
    assert repo.get_status("r1") == AnalysisStatusValue.COMPLETED

    # Cannot claim completed
    assert repo.claim("r1") is False

    # Cannot transition completed -> queued
    repo.mark_queued("r1")
    assert repo.get_status("r1") == AnalysisStatusValue.COMPLETED

    # Cannot save_failed on completed (completed state preserved)
    repo.save_failed("r1", "err", "msg", False)
    assert repo.get_status("r1") == AnalysisStatusValue.COMPLETED


def test_in_memory_invalid_transitions_rejected() -> None:
    repo = InMemoryAnalysisRepository([RunInput("r2", "org1", "case1", "key1", "hash1", 100)])
    result = make_result("r2")

    # Cannot complete from accepted directly
    with pytest.raises(ValueError, match="expected 'processing'"):
        repo.save_completed(result)

    repo.mark_queued("r2")
    # Cannot complete from queued directly
    with pytest.raises(ValueError, match="expected 'processing'"):
        repo.save_completed(result)


def test_in_memory_duplicate_completion_idempotency_and_conflict() -> None:
    repo = InMemoryAnalysisRepository([RunInput("r1", "org1", "case1", "key1", "hash1", 100)])
    repo.claim("r1")
    result1 = make_result("r1", analysis_version="v1", schema_version="1")
    repo.save_completed(result1)
    assert repo.get_status("r1") == AnalysisStatusValue.COMPLETED

    # Duplicate delivery with exact same versions: preserved
    repo.save_completed(result1)
    assert repo.get_status("r1") == AnalysisStatusValue.COMPLETED

    # Conflict: different version
    result_conflict = make_result("r1", analysis_version="v2", schema_version="1")
    with pytest.raises(ValueError, match="conflict"):
        repo.save_completed(result_conflict)


def test_in_memory_concurrent_claim() -> None:
    repo = InMemoryAnalysisRepository([RunInput("r1", "org1", "case1", "key1", "hash1", 100)])
    repo.mark_queued("r1")

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(repo.claim, "r1") for _ in range(10)]
        results = [f.result() for f in futures]

    assert results.count(True) == 1
    assert results.count(False) == 9
    assert repo.attempts["r1"] == 1


def test_in_memory_stuck_claim_recovery() -> None:
    repo = InMemoryAnalysisRepository(
        [RunInput("r1", "org1", "case1", "key1", "hash1", 100)],
        stuck_timeout_seconds=5.0,
    )
    assert repo.claim("r1") is True
    assert repo.get_status("r1") == AnalysisStatusValue.PROCESSING
    assert repo.claim("r1") is False

    # Simulate crash: updated_at in past
    repo.updated_at["r1"] = datetime.now(UTC) - timedelta(seconds=10)

    # Reclaim succeeds
    assert repo.claim("r1") is True
    assert repo.attempts["r1"] == 2


def test_in_memory_failed_at_and_retryable_transition() -> None:
    repo = InMemoryAnalysisRepository([RunInput("r1", "org1", "case1", "key1", "hash1", 100)])
    repo.claim("r1")

    # Save retryable failure
    repo.save_failed("r1", "evidence_storage_unavailable", "storage down", retryable=True, request_id="req-1")
    assert repo.get_status("r1") == AnalysisStatusValue.FAILED
    assert "r1" in repo.failed_at
    assert repo.failures["r1"][0] == "evidence_storage_unavailable"
    assert repo.failures["r1"][1] == "storage down"

    # Retryable failed can be marked queued / reclaimed
    assert repo.claim("r1") is True
    assert repo.get_status("r1") == AnalysisStatusValue.PROCESSING

    # Terminal failure cannot be reclaimed
    repo.save_failed("r1", "evidence_digest_mismatch", "bad digest", retryable=False)
    assert repo.claim("r1") is False


# --- PostgreSQL Repository Integration Tests ---


@pytest.fixture
def pg_repo() -> PostgresAnalysisRepository:
    import os

    db_url = os.environ.get("DATABASE_URL", "postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel")
    return PostgresAnalysisRepository(db_url, stuck_timeout_seconds=5.0)


@pytest.fixture
def pg_seed_run(pg_repo: PostgresAnalysisRepository) -> tuple[str, str, str, str]:
    uid = uuid4().hex[:8]
    org_id = f"org_{uid}"
    case_id = f"case_{uid}"
    ev_id = f"ev_{uid}"
    run_id = f"run_{uid}"
    obj_key = f"organizations/{org_id}/cases/{case_id}/artifacts/artifact_{uid}.eml"

    with psycopg.connect(pg_repo.database_url) as conn:
        with conn.transaction():
            conn.execute(
                "INSERT INTO organizations (id, name) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (org_id, f"Test Org {uid}"),
            )
            conn.execute(
                "INSERT INTO cases (id, organization_id, title) VALUES (%s, %s, %s)",
                (case_id, org_id, f"Case {uid}"),
            )
            conn.execute(
                """
                INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (ev_id, org_id, case_id, obj_key, sha256(VALID_MESSAGE).hexdigest(), len(VALID_MESSAGE)),
            )
            conn.execute(
                """
                INSERT INTO analysis_runs (id, organization_id, case_id, evidence_id, status)
                VALUES (%s, %s, %s, %s, 'accepted')
                """,
                (run_id, org_id, case_id, ev_id),
            )
    return org_id, case_id, ev_id, run_id


def test_postgres_run_id_alias(pg_repo: PostgresAnalysisRepository, pg_seed_run: tuple[str, str, str, str]) -> None:
    org_id, _, _, run_id = pg_seed_run
    run_input = pg_repo.get_run(run_id)
    assert run_input is not None
    assert run_input.analysis_run_id == run_id
    assert run_input.organization_id == org_id


def test_postgres_transition_matrix(
    pg_repo: PostgresAnalysisRepository, pg_seed_run: tuple[str, str, str, str]
) -> None:
    _, _, _, run_id = pg_seed_run
    assert pg_repo.get_status(run_id) == AnalysisStatusValue.ACCEPTED

    # accepted -> queued
    pg_repo.mark_queued(run_id)
    assert pg_repo.get_status(run_id) == AnalysisStatusValue.QUEUED

    # queued -> processing
    assert pg_repo.claim(run_id) is True
    assert pg_repo.get_status(run_id) == AnalysisStatusValue.PROCESSING

    # Cannot claim already processing
    assert pg_repo.claim(run_id) is False

    # processing -> completed
    result = make_result(run_id)
    pg_repo.save_completed(result)
    assert pg_repo.get_status(run_id) == AnalysisStatusValue.COMPLETED

    # Cannot claim completed
    assert pg_repo.claim(run_id) is False

    # Completed state preserved on save_failed
    pg_repo.save_failed(run_id, "err", "msg", False)
    assert pg_repo.get_status(run_id) == AnalysisStatusValue.COMPLETED


def test_postgres_duplicate_completion_and_conflict(
    pg_repo: PostgresAnalysisRepository, pg_seed_run: tuple[str, str, str, str]
) -> None:
    _, _, _, run_id = pg_seed_run
    pg_repo.claim(run_id)
    result = make_result(run_id, analysis_version="v1", schema_version="1")
    pg_repo.save_completed(result)

    # Idempotent write: duplicate delivery preserves completed state
    pg_repo.save_completed(result)
    assert pg_repo.get_status(run_id) == AnalysisStatusValue.COMPLETED

    # Conflict: version mismatch raises
    result_conflict = make_result(run_id, analysis_version="v2", schema_version="1")
    with pytest.raises(ValueError, match="conflict"):
        pg_repo.save_completed(result_conflict)


def test_postgres_concurrent_claim(pg_repo: PostgresAnalysisRepository, pg_seed_run: tuple[str, str, str, str]) -> None:
    _, _, _, run_id = pg_seed_run
    pg_repo.mark_queued(run_id)

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(pg_repo.claim, run_id) for _ in range(8)]
        results = [f.result() for f in futures]

    assert results.count(True) == 1
    assert results.count(False) == 7


def test_postgres_stuck_claim_recovery(
    pg_repo: PostgresAnalysisRepository, pg_seed_run: tuple[str, str, str, str]
) -> None:
    _, _, _, run_id = pg_seed_run
    assert pg_repo.claim(run_id) is True
    assert pg_repo.claim(run_id) is False

    # Manually backdate updated_at to simulate crashed worker
    with psycopg.connect(pg_repo.database_url) as conn:
        with conn.transaction():
            conn.execute(
                "UPDATE analysis_runs SET updated_at = now() - INTERVAL '10 seconds' WHERE id = %s",
                (run_id,),
            )

    # Reclaiming succeeds because timeout is 5.0 seconds
    assert pg_repo.claim(run_id) is True


def test_postgres_rollback_on_failed_at(
    pg_repo: PostgresAnalysisRepository, pg_seed_run: tuple[str, str, str, str]
) -> None:
    _, _, _, run_id = pg_seed_run
    pg_repo.claim(run_id)

    # Save failed records failed_at, failure_code, failure_message, retryable
    pg_repo.save_failed(run_id, "evidence_storage_unavailable", "network failure", retryable=True, request_id="req-123")
    assert pg_repo.get_status(run_id) == AnalysisStatusValue.FAILED

    with psycopg.connect(pg_repo.database_url) as conn:
        row = conn.execute(
            "SELECT failed_at, failure_code, failure_message, retryable FROM analysis_runs WHERE id = %s",
            (run_id,),
        ).fetchone()
        assert row is not None
        assert row[0] is not None  # failed_at
        assert row[1] == "evidence_storage_unavailable"
        assert row[2] == "network failure"
        assert row[3] is True  # retryable

    # Retryable failed can be re-claimed
    assert pg_repo.claim(run_id) is True
    assert pg_repo.get_status(run_id) == AnalysisStatusValue.PROCESSING


def test_postgres_save_completed_stores_distinct_ruleset_and_analysis_versions(
    pg_repo: PostgresAnalysisRepository, pg_seed_run: tuple[str, str, str, str]
) -> None:
    _, _, _, run_id = pg_seed_run
    pg_repo.claim(run_id)
    result = AnalysisResult(
        analysis_version="prototype-1",
        ruleset_version="2.0.0",
        schema_version="1.0.0",
        analysis_run_id=run_id,
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256=sha256(VALID_MESSAGE).hexdigest(),
        artifact_byte_size=len(VALID_MESSAGE),
        score=ScoreBreakdown(base_score=10, contributions=[], final_score=10),
        verdict=VerdictValue.BENIGN,
        confidence=0.9,
        analyzed_at=datetime.now(UTC),
    )
    pg_repo.save_completed(result)

    with psycopg.connect(pg_repo.database_url) as conn:
        row = conn.execute(
            "SELECT analysis_version, ruleset_version, result_schema_version FROM analysis_runs WHERE id = %s",
            (run_id,),
        ).fetchone()
        assert row is not None
        assert row[0] == "prototype-1"
        assert row[1] == "2.0.0"
        assert row[2] == "1.0.0"


def test_postgres_ruleset_version_conflict(
    pg_repo: PostgresAnalysisRepository, pg_seed_run: tuple[str, str, str, str]
) -> None:
    _, _, _, run_id = pg_seed_run
    pg_repo.claim(run_id)
    result1 = AnalysisResult(
        analysis_version="prototype-1",
        ruleset_version="1.0.0",
        schema_version="1.0.0",
        analysis_run_id=run_id,
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256=sha256(VALID_MESSAGE).hexdigest(),
        artifact_byte_size=len(VALID_MESSAGE),
        score=ScoreBreakdown(base_score=10, contributions=[], final_score=10),
        verdict=VerdictValue.BENIGN,
        confidence=0.9,
        analyzed_at=datetime.now(UTC),
    )
    pg_repo.save_completed(result1)

    # Different ruleset_version raises conflict
    result2 = AnalysisResult(
        analysis_version="prototype-1",
        ruleset_version="1.1.0",
        schema_version="1.0.0",
        analysis_run_id=run_id,
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256=sha256(VALID_MESSAGE).hexdigest(),
        artifact_byte_size=len(VALID_MESSAGE),
        score=ScoreBreakdown(base_score=10, contributions=[], final_score=10),
        verdict=VerdictValue.BENIGN,
        confidence=0.9,
        analyzed_at=datetime.now(UTC),
    )
    with pytest.raises(ValueError, match="conflict: analysis run already completed with version"):
        pg_repo.save_completed(result2)


def test_in_memory_ruleset_version_conflict() -> None:
    repo = InMemoryAnalysisRepository([RunInput("r_v", "org1", "case1", "key1", "hash1", 100)])
    repo.claim("r_v")
    res1 = AnalysisResult(
        analysis_version="prototype-1",
        ruleset_version="1.0.0",
        schema_version="1.0.0",
        analysis_run_id="r_v",
        organization_id="org1",
        case_id="case1",
        artifact_sha256=sha256(VALID_MESSAGE).hexdigest(),
        artifact_byte_size=len(VALID_MESSAGE),
        score=ScoreBreakdown(base_score=10, contributions=[], final_score=10),
        verdict=VerdictValue.BENIGN,
        confidence=0.9,
        analyzed_at=datetime.now(UTC),
    )
    repo.save_completed(res1)

    # Idempotent re-save matches
    repo.save_completed(res1)

    res2 = AnalysisResult(
        analysis_version="prototype-1",
        ruleset_version="1.1.0",
        schema_version="1.0.0",
        analysis_run_id="r_v",
        organization_id="org1",
        case_id="case1",
        artifact_sha256=sha256(VALID_MESSAGE).hexdigest(),
        artifact_byte_size=len(VALID_MESSAGE),
        score=ScoreBreakdown(base_score=10, contributions=[], final_score=10),
        verdict=VerdictValue.BENIGN,
        confidence=0.9,
        analyzed_at=datetime.now(UTC),
    )
    with pytest.raises(ValueError, match="conflict"):
        repo.save_completed(res2)


def test_run_analysis_cross_tenant_object_key_rejection() -> None:
    from app.analysis import AnalysisError, run_analysis
    from app.core.settings import Settings
    from app.persistence.interfaces import MemoryEvidenceStore

    key_cross_org = "organizations/org_other/cases/case_01/artifacts/a.eml"
    run_input = RunInput("r_cross", "org_01", "case_01", key_cross_org, "a" * 64, len(VALID_MESSAGE))
    repo = InMemoryAnalysisRepository([run_input])
    store = MemoryEvidenceStore({key_cross_org: VALID_MESSAGE})
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        app_env="test",
        database_url="postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel",  # type: ignore[arg-type]
        s3_access_key_id="mailsentinel",
        s3_secret_access_key="mailsentinel-secret",  # type: ignore[arg-type]
        analyzer_service_token="analyzer-token-change-me",  # type: ignore[arg-type]
    )
    with pytest.raises(AnalysisError, match="intake_invalid") as exc_info:
        run_analysis("r_cross", repository=repo, evidence_store=store, settings=settings)
    assert exc_info.value.code == "intake_invalid"
    assert exc_info.value.retryable is False


def test_memory_evidence_store_constant_time_digest_comparison(monkeypatch: pytest.MonkeyPatch) -> None:
    data = b"From: test@example.com\nSubject: Secret\n\nEvidence payload"
    expected_hex = sha256(data).hexdigest()
    key = "organizations/org_01/cases/case_01/artifacts/artifact_01.eml"
    store = MemoryEvidenceStore({key: data})

    # Track secrets.compare_digest calls to ensure constant-time comparison is executed
    called_with: list[tuple[str, str]] = []
    real_compare = secrets.compare_digest

    def spy_compare(a: str, b: str) -> bool:
        called_with.append((a, b))
        return real_compare(a, b)

    monkeypatch.setattr(secrets, "compare_digest", spy_compare)

    # 1. Matching lowercase digest
    res = store.read_verified(key, expected_hex, len(data), max_bytes=10_000, expected_scope=("org_01", "case_01"))
    assert res == data
    assert len(called_with) == 1
    assert called_with[0] == (expected_hex.lower(), expected_hex.lower())

    # 2. Case-insensitive match with uppercase digest
    called_with.clear()
    res_upper = store.read_verified(
        key, expected_hex.upper(), len(data), max_bytes=10_000, expected_scope=("org_01", "case_01")
    )
    assert res_upper == data
    assert len(called_with) == 1
    assert called_with[0] == (expected_hex.lower(), expected_hex.lower())

    # 3. Mismatched digest raises evidence_digest_mismatch
    called_with.clear()
    with pytest.raises(ValueError, match="evidence_digest_mismatch"):
        store.read_verified(key, "0" * 64, len(data), max_bytes=10_000, expected_scope=("org_01", "case_01"))
    assert len(called_with) == 1
    assert called_with[0] == (expected_hex.lower(), "0" * 64)
