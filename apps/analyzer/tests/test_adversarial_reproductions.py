"""Targeted adversarial reproductions validating security and reliability fixes."""

import io
from hashlib import sha256
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from app.analysis import AnalysisError, run_analysis
from app.contracts.models import (
    AnalysisStatusValue,
    EnrichmentDetails,
    EnrichmentObservation,
)
from app.core.settings import Settings
from app.extraction.extract import extract_headers
from app.parsing.parser import ParseLimitError, parse_message
from app.persistence.interfaces import InMemoryAnalysisRepository, MemoryEvidenceStore, RunInput
from app.persistence.s3 import S3EvidenceStore

TEST_SETTINGS = Settings(  # type: ignore[call-arg]
    _env_file=None,
    app_env="test",
    database_url="postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel",  # type: ignore[arg-type]
    s3_access_key_id="mailsentinel",
    s3_secret_access_key="mailsentinel-secret",  # type: ignore[arg-type]
    analyzer_service_token="analyzer-token-change-me",  # type: ignore[arg-type]
    enrichment_mode="fixture",
    max_eml_bytes=100_000,
    max_attachment_bytes=50_000,
    max_mime_parts=10,
    max_mime_depth=5,
    max_header_count=20,
)

VALID_KEY = "organizations/org_01/cases/case_01/artifacts/artifact_01.eml"
SAMPLE_BODY = b"From: a@b.com\nSubject: Adversarial Test\n\nPayload"
SAMPLE_SHA = sha256(SAMPLE_BODY).hexdigest()


class ClosableBytesIO(io.BytesIO):
    """Mock StreamingBody that tracks close() calls."""

    def __init__(self, initial_bytes: bytes = b"") -> None:
        super().__init__(initial_bytes)
        self.was_closed = False

    def close(self) -> None:
        self.was_closed = True
        super().close()


# ==============================================================================
# Focus 1: S3EvidenceStore Adversarial Reproductions
# ==============================================================================


def test_s3_preflight_rejects_oversized_content_length_before_get() -> None:
    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    # HEAD indicates 200KB which exceeds max_bytes (100KB)
    mock_client.head_object.return_value = {"ContentLength": 200_000}
    store.client = mock_client

    with pytest.raises(ValueError, match="evidence_too_large"):
        store.read_verified(
            VALID_KEY,
            expected_sha256=SAMPLE_SHA,
            expected_size=200_000,
            max_bytes=100_000,
        )

    # get_object must NOT have been called because preflight fast-rejected
    mock_client.get_object.assert_not_called()


def test_s3_preflight_rejects_size_mismatch_before_get() -> None:
    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    mock_client.head_object.return_value = {"ContentLength": 500}
    store.client = mock_client

    with pytest.raises(ValueError, match="evidence_size_mismatch"):
        store.read_verified(
            VALID_KEY,
            expected_sha256=SAMPLE_SHA,
            expected_size=1000,
            max_bytes=100_000,
        )

    mock_client.get_object.assert_not_called()


def test_s3_preflight_rejects_metadata_digest_mismatch() -> None:
    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    mock_client.head_object.return_value = {
        "ContentLength": len(SAMPLE_BODY),
        "Metadata": {"sha256": "f" * 64},
    }
    store.client = mock_client

    with pytest.raises(ValueError, match="evidence_digest_mismatch"):
        store.read_verified(
            VALID_KEY,
            expected_sha256=SAMPLE_SHA,
            expected_size=len(SAMPLE_BODY),
            max_bytes=100_000,
        )

    mock_client.get_object.assert_not_called()


def test_s3_body_closed_on_successful_read() -> None:
    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    mock_client.head_object.return_value = {"ContentLength": len(SAMPLE_BODY)}
    body = ClosableBytesIO(SAMPLE_BODY)
    mock_client.get_object.return_value = {"Body": body}
    store.client = mock_client

    data = store.read_verified(
        VALID_KEY,
        expected_sha256=SAMPLE_SHA,
        expected_size=len(SAMPLE_BODY),
        max_bytes=100_000,
    )
    assert data == SAMPLE_BODY
    assert body.was_closed is True


def test_s3_body_closed_on_stream_limit_violation() -> None:
    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    # Rogue server reported 50 bytes in HEAD, but streams 150 bytes (exceeding expected_size 50)
    mock_client.head_object.return_value = {"ContentLength": 50}
    body = ClosableBytesIO(b"X" * 150)
    mock_client.get_object.return_value = {"Body": body}
    store.client = mock_client

    with pytest.raises(ValueError, match="evidence_size_mismatch"):
        store.read_verified(
            VALID_KEY,
            expected_sha256=SAMPLE_SHA,
            expected_size=50,
            max_bytes=100_000,
        )

    assert body.was_closed is True


def test_s3_body_closed_on_digest_mismatch() -> None:
    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    mock_client.head_object.return_value = {"ContentLength": len(SAMPLE_BODY)}
    body = ClosableBytesIO(SAMPLE_BODY)
    mock_client.get_object.return_value = {"Body": body}
    store.client = mock_client

    with pytest.raises(ValueError, match="evidence_digest_mismatch"):
        store.read_verified(
            VALID_KEY,
            expected_sha256="0" * 64,
            expected_size=len(SAMPLE_BODY),
            max_bytes=100_000,
        )

    assert body.was_closed is True


def test_s3_scope_revalidation_rejects_path_traversal() -> None:
    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    store.client = mock_client

    traversal_keys = [
        "organizations/org_01/cases/case_01/artifacts/../../other/case/artifact.eml",
        "organizations/org_01/cases/case_01/artifacts/..\\..\\secret.eml",
        "/organizations/org_01/cases/case_01/artifacts/file.eml",
        "organizations/org_01/cases/case_01/artifacts/file\x00.eml",
        "organizations/org_01/cases/case_01/artifacts//double_slash.eml",
    ]
    for bad_key in traversal_keys:
        with pytest.raises(ValueError, match="evidence_not_found"):
            store.read_verified(
                bad_key,
                expected_sha256=SAMPLE_SHA,
                expected_size=10,
                max_bytes=100_000,
            )
    mock_client.head_object.assert_not_called()
    mock_client.get_object.assert_not_called()


def test_s3_scope_revalidation_checks_expected_scope() -> None:
    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    store.client = mock_client

    # Key is valid syntax for org_01/case_01, but caller requested org_99/case_99
    with pytest.raises(ValueError, match="evidence_not_found"):
        store.read_verified(
            VALID_KEY,
            expected_sha256=SAMPLE_SHA,
            expected_size=10,
            max_bytes=100_000,
            expected_scope=("org_99", "case_99"),
        )
    mock_client.head_object.assert_not_called()


def test_s3_safe_error_mapping_does_not_leak_botocore_exception() -> None:
    store = S3EvidenceStore(TEST_SETTINGS)
    mock_client = MagicMock()
    mock_client.head_object.side_effect = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "Secret AWS token expired at https://internal.corp"}},
        "HeadObject",
    )
    store.client = mock_client

    with pytest.raises(ValueError) as exc_info:
        store.read_verified(
            VALID_KEY,
            expected_sha256=SAMPLE_SHA,
            expected_size=10,
            max_bytes=100_000,
        )

    # Safe code returned without leaking internal details
    assert str(exc_info.value) == "evidence_storage_unavailable"
    # __cause__ must be None (from None)
    assert exc_info.value.__cause__ is None


# ==============================================================================
# Focus 2: Parser Resource Exhaustion & Malformed MIME
# ==============================================================================


def test_parser_container_bomb_exhaustion_defense() -> None:
    # Build a tree of empty multipart containers that has few leaf parts but exceeds max_parts
    nested = b"Content-Type: multipart/mixed; boundary=root\n\n"
    for i in range(15):
        nested += f"--root\nContent-Type: multipart/related; boundary=sub{i}\n\n--sub{i}--\n".encode()
    nested += b"--root--\n"

    with pytest.raises(ParseLimitError, match="message contains too many MIME parts"):
        parse_message(
            nested,
            max_bytes=100_000,
            max_parts=10,
            max_depth=10,
            max_headers=20,
            max_attachment_bytes=50_000,
        )


def test_parser_total_payload_limit_across_parts() -> None:
    # 5 parts of 2500 bytes = 12500 bytes, exceeding max_non_attachment_bytes of 10000 bytes
    parts = [b"--b\nContent-Type: text/plain\n\n" + (b"A" * 2500) for _ in range(5)]
    raw = b"Content-Type: multipart/mixed; boundary=b\n\n" + b"\n".join(parts) + b"\n--b--\n"

    with pytest.raises(
        ParseLimitError,
        match="decoded non-attachment payload exceeds configured limit|decoded plain text exceeds configured limit",
    ):
        parse_message(
            raw,
            max_bytes=50_000,
            max_parts=20,
            max_depth=5,
            max_headers=20,
            max_attachment_bytes=50_000,
            max_non_attachment_bytes=10_000,
        )


def test_parser_malformed_encoding_does_not_crash_on_unexpected_get_content() -> None:
    # Malformed / unknown CTE and charset
    raw = (
        b"From: a@b.com\n"
        b"Content-Type: text/plain; charset=non-existent-charset-123\n"
        b"Content-Transfer-Encoding: 7bit\n\n"
        b"Some ascii content with raw bytes \x80\x81\xff\n"
    )
    parsed = parse_message(
        raw,
        max_bytes=100_000,
        max_parts=10,
        max_depth=5,
        max_headers=20,
        max_attachment_bytes=50_000,
    )
    assert len(parsed.parts) == 1
    assert any("malformed_encoding" in w for w in parsed.warnings)
    assert "Some ascii content" in parsed.plain_text


def test_extract_headers_sanitizes_null_bytes_without_failing_json() -> None:
    # Headers containing null bytes must be stripped for safe JSONB storage
    raw = b"From: attacker\x00@evil.com\nSubject: Evil\x00Subject\n\nBody"
    parsed = parse_message(
        raw,
        max_bytes=100_000,
        max_parts=10,
        max_depth=5,
        max_headers=20,
        max_attachment_bytes=50_000,
    )
    headers = extract_headers(parsed)
    for h in headers:
        assert "\x00" not in h.name
        assert "\x00" not in h.value
    assert any(h.malformed for h in headers)


# ==============================================================================
# Focus 4 & 5: Public Contracts, Worker Idempotency & Secret Isolation
# ==============================================================================


def test_enrichment_observation_strictly_typed_no_any() -> None:
    # details field must accept EnrichmentDetails instance
    details = EnrichmentDetails(deterministic=True, category="phishing", raw_score=90)
    obs = EnrichmentObservation(
        indicator="evil.example",
        provider="fixture",
        mode="fixture",
        details=details,
    )
    assert isinstance(obs.details, EnrichmentDetails)
    assert obs.details.deterministic is True
    assert obs.details.category == "phishing"


def test_worker_idempotent_duplicate_delivery() -> None:
    run_input = RunInput("run_idem", "org_01", "case_01", VALID_KEY, SAMPLE_SHA, len(SAMPLE_BODY))
    repo = InMemoryAnalysisRepository([run_input])
    store = MemoryEvidenceStore({VALID_KEY: SAMPLE_BODY})

    # First run succeeds
    first = run_analysis("run_idem", repository=repo, evidence_store=store, settings=TEST_SETTINGS)
    assert first is not None
    assert repo.get_status("run_idem") == AnalysisStatusValue.COMPLETED

    # Duplicate delivery returns None and preserves completed state
    second = run_analysis("run_idem", repository=repo, evidence_store=store, settings=TEST_SETTINGS)
    assert second is None
    assert repo.get_status("run_idem") == AnalysisStatusValue.COMPLETED


def test_secret_token_in_request_id_never_persisted_to_failure() -> None:
    run_input = RunInput("run_sec", "org_01", "case_01", VALID_KEY, SAMPLE_SHA, len(SAMPLE_BODY))
    repo = InMemoryAnalysisRepository([run_input])
    mock_store = MagicMock()
    mock_store.read_verified.side_effect = ValueError("evidence_not_found")

    secret_token = "BEARER-SECRET-TOKEN-DO-NOT-LEAK-9999"
    with pytest.raises(AnalysisError):
        run_analysis(
            "run_sec",
            repository=repo,
            evidence_store=mock_store,
            settings=TEST_SETTINGS,
            request_id=secret_token,
        )

    failure = repo.failures["run_sec"]
    assert secret_token not in failure[0]
    assert secret_token not in failure[1]
