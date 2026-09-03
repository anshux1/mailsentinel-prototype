from hashlib import sha256
from unittest.mock import MagicMock, patch

import pytest
from dramatiq import Message
from dramatiq.brokers.stub import StubBroker

from app.analysis import AnalysisError, run_analysis
from app.contracts.models import AnalysisStatusValue
from app.core.settings import Settings
from app.persistence.interfaces import InMemoryAnalysisRepository, MemoryEvidenceStore, RunInput
from app.tasks.broker import broker, process_analysis, setup_analysis

MESSAGE = b"From: a@b.com\nSubject: Hi\n\nHello"

TEST_SETTINGS = Settings(  # type: ignore[call-arg]
    _env_file=None,
    app_env="test",
    database_url="postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel",  # type: ignore[arg-type]
    s3_access_key_id="mailsentinel",
    s3_secret_access_key="mailsentinel-secret",  # type: ignore[arg-type]
    analyzer_service_token="analyzer-token-change-me",  # type: ignore[arg-type]
    enrichment_mode="fixture",
)


def test_broker_configures_each_default_middleware_once() -> None:
    middleware_types = [type(item) for item in broker.middleware]
    assert len(middleware_types) == len(set(middleware_types))


def test_setup_actor_uses_analysis_run_as_idempotency_key() -> None:
    assert isinstance(broker, StubBroker)
    queue = broker.queues["analysis"]
    while not queue.empty():
        queue.get_nowait()
    setup_analysis.send("run_setup_01")
    message = Message.decode(queue.get_nowait())
    assert message.args == ("run_setup_01",)


def test_setup_actor_never_creates_a_verdict() -> None:
    assert setup_analysis.fn("run_setup_01") is None


def test_process_actor_payload_is_analysis_run_id_only() -> None:
    assert isinstance(broker, StubBroker)
    queue = broker.queues["analysis"]
    while not queue.empty():
        queue.get_nowait()
    process_analysis.send("run_process_01")
    message = Message.decode(queue.get_nowait())
    assert message.args == ("run_process_01",)


def test_retry_classification_storage_is_retryable() -> None:
    key = "organizations/org1/cases/case1/artifacts/a.eml"
    repo = InMemoryAnalysisRepository([RunInput("r1", "org1", "case1", key, sha256(MESSAGE).hexdigest(), len(MESSAGE))])

    mock_store = MagicMock()
    mock_store.read_verified.side_effect = ValueError("evidence_storage_unavailable")

    with pytest.raises(AnalysisError) as exc_info:
        run_analysis("r1", repository=repo, evidence_store=mock_store, settings=TEST_SETTINGS)

    assert exc_info.value.code == "evidence_storage_unavailable"
    assert exc_info.value.retryable is True
    assert repo.get_status("r1") == AnalysisStatusValue.FAILED
    assert repo.retryable["r1"] is True


@pytest.mark.parametrize(
    "error_code",
    [
        "evidence_not_found",
        "evidence_too_large",
        "evidence_size_mismatch",
        "evidence_digest_mismatch",
    ],
)
def test_retry_classification_evidence_errors_are_terminal(error_code: str) -> None:
    key = "organizations/org1/cases/case1/artifacts/a.eml"
    repo = InMemoryAnalysisRepository([RunInput("r1", "org1", "case1", key, sha256(MESSAGE).hexdigest(), len(MESSAGE))])

    mock_store = MagicMock()
    mock_store.read_verified.side_effect = ValueError(error_code)

    with pytest.raises(AnalysisError) as exc_info:
        run_analysis("r1", repository=repo, evidence_store=mock_store, settings=TEST_SETTINGS)

    assert exc_info.value.code == error_code
    assert exc_info.value.retryable is False
    assert repo.get_status("r1") == AnalysisStatusValue.FAILED
    assert repo.retryable["r1"] is False


def test_retry_classification_parser_error_is_terminal() -> None:
    key = "organizations/org1/cases/case1/artifacts/a.eml"
    repo = InMemoryAnalysisRepository([RunInput("r1", "org1", "case1", key, sha256(MESSAGE).hexdigest(), len(MESSAGE))])
    store = MemoryEvidenceStore({key: MESSAGE})

    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        app_env="test",
        database_url="postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel",  # type: ignore[arg-type]
        s3_access_key_id="mailsentinel",
        s3_secret_access_key="mailsentinel-secret",  # type: ignore[arg-type]
        analyzer_service_token="analyzer-token-change-me",  # type: ignore[arg-type]
        enrichment_mode="fixture",
        max_header_count=1,
    )

    with pytest.raises(AnalysisError) as exc_info:
        run_analysis("r1", repository=repo, evidence_store=store, settings=settings)

    assert exc_info.value.retryable is False
    assert repo.get_status("r1") == AnalysisStatusValue.FAILED


def test_safe_request_id_handling() -> None:
    key = "organizations/org1/cases/case1/artifacts/a.eml"
    repo = InMemoryAnalysisRepository([RunInput("r1", "org1", "case1", key, sha256(MESSAGE).hexdigest(), len(MESSAGE))])
    mock_store = MagicMock()
    mock_store.read_verified.side_effect = ValueError("evidence_not_found")

    secret_request_id = "req-super-secret-token-12345"
    with pytest.raises(AnalysisError):
        run_analysis(
            "r1",
            repository=repo,
            evidence_store=mock_store,
            settings=TEST_SETTINGS,
            request_id=secret_request_id,
        )

    # Verify request_id does not leak into failure code or message
    failure_tuple = repo.failures["r1"]
    assert secret_request_id not in failure_tuple[0]  # code
    assert secret_request_id not in failure_tuple[1]  # message


def test_duplicate_delivery_on_completed_run() -> None:
    key = "organizations/org1/cases/case1/artifacts/a.eml"
    repo = InMemoryAnalysisRepository([RunInput("r1", "org1", "case1", key, sha256(MESSAGE).hexdigest(), len(MESSAGE))])
    store = MemoryEvidenceStore({key: MESSAGE})

    # First run completes
    res1 = run_analysis("r1", repository=repo, evidence_store=store, settings=TEST_SETTINGS)
    assert res1 is not None
    assert repo.get_status("r1") == AnalysisStatusValue.COMPLETED

    # Duplicate delivery returns None cleanly and preserves completed state
    res2 = run_analysis("r1", repository=repo, evidence_store=store, settings=TEST_SETTINGS)
    assert res2 is None
    assert repo.get_status("r1") == AnalysisStatusValue.COMPLETED


def test_process_analysis_worker_reraises_retryable() -> None:
    with patch("app.tasks.broker.run_analysis") as mock_run:
        mock_run.side_effect = AnalysisError("evidence_storage_unavailable", "down", retryable=True)
        with pytest.raises(AnalysisError):
            process_analysis.fn("r1")


def test_process_analysis_worker_acknowledges_terminal() -> None:
    with patch("app.tasks.broker.run_analysis") as mock_run:
        mock_run.side_effect = AnalysisError("evidence_not_found", "missing", retryable=False)
        # Should not raise; terminal error acknowledged
        process_analysis.fn("r1")


def test_missing_run_raises_terminal_error() -> None:
    repo = InMemoryAnalysisRepository([])
    store = MemoryEvidenceStore({})

    with pytest.raises(AnalysisError) as exc_info:
        run_analysis("r_missing", repository=repo, evidence_store=store, settings=TEST_SETTINGS)

    assert exc_info.value.code == "analysis_run_not_found"
    assert exc_info.value.retryable is False


def test_process_analysis_accepts_dict_payload() -> None:
    with patch("app.tasks.broker.run_analysis") as mock_run:
        mock_run.return_value = None
        process_analysis.fn({"analysisRunId": "run_dict_01", "requestId": "req_123"})
        mock_run.assert_called_once()
        assert mock_run.call_args[0][0] == "run_dict_01"
        assert mock_run.call_args[1]["request_id"] == "req_123"


def test_setup_analysis_accepts_dict_payload() -> None:
    setup_analysis.fn({"analysisRunId": "run_setup_dict"})
    with pytest.raises(ValueError, match="analysis_run_id is required"):
        setup_analysis.fn({})


def test_s3_evidence_store_maps_nosuchkey_to_evidence_not_found() -> None:
    from botocore.exceptions import ClientError

    from app.persistence.s3 import S3EvidenceStore

    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    mock_client.get_object.side_effect = ClientError(
        {"Error": {"Code": "NoSuchKey", "Message": "The specified key does not exist."}},
        "GetObject",
    )
    store.client = mock_client

    with pytest.raises(ValueError, match="evidence_not_found"):
        store.read_verified(
            "organizations/org1/cases/case1/artifacts/missing.eml",
            expected_sha256="a" * 64,
            expected_size=100,
            max_bytes=1000,
        )
