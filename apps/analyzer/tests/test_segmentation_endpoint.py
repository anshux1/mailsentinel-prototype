"""Tests for Phase P11: POST /v1/evidence/segment service endpoint."""

import hashlib
import json
import logging
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.core.settings import get_settings
from app.main import app, get_evidence_store
from app.persistence.interfaces import MemoryEvidenceStore


@pytest.fixture(autouse=True)
def clean_dependency_overrides() -> Any:
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def test_bearer_authentication() -> None:
    client = TestClient(app)
    payload = {
        "caseId": "case_01",
        "organizationId": "org_01",
        "evidenceId": "ev_01",
        "objectKey": "organizations/org_01/cases/case_01/artifacts/test.mbox",
        "sha256": "a" * 64,
        "byteSize": 100,
    }

    # 1. Missing Authorization header
    res_missing = client.post("/v1/evidence/segment", json=payload)
    assert res_missing.status_code == 401

    # 2. Invalid bearer token
    res_invalid = client.post("/v1/evidence/segment", json=payload, headers={"Authorization": "Bearer wrong-token"})
    assert res_invalid.status_code == 401


def test_digest_mismatch_refused() -> None:
    token = get_settings().analyzer_service_token.get_secret_value()
    client = TestClient(app)

    key = "organizations/org_01/cases/case_01/artifacts/sample.eml"
    data = b"From: a@b.com\r\nSubject: Hi\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\n\r\nHello"
    bad_sha = "0" * 64

    store = MemoryEvidenceStore({key: data})
    app.dependency_overrides[get_evidence_store] = lambda: store

    payload = {
        "caseId": "case_01",
        "organizationId": "org_01",
        "evidenceId": "ev_01",
        "objectKey": key,
        "sha256": bad_sha,
        "byteSize": len(data),
    }

    res = client.post("/v1/evidence/segment", json=payload, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 400
    assert "digest mismatch" in res.json().get("detail", "")


def test_unknown_key_404_and_storage_unavailable_503() -> None:
    token = get_settings().analyzer_service_token.get_secret_value()
    client = TestClient(app)

    store = MemoryEvidenceStore({})
    app.dependency_overrides[get_evidence_store] = lambda: store

    # 1. 404 on unknown key
    payload = {
        "caseId": "case_01",
        "organizationId": "org_01",
        "evidenceId": "ev_01",
        "objectKey": "organizations/org_01/cases/case_01/artifacts/unknown.eml",
        "sha256": "a" * 64,
        "byteSize": 100,
    }
    res_404 = client.post("/v1/evidence/segment", json=payload, headers={"Authorization": f"Bearer {token}"})
    assert res_404.status_code == 404

    # 2. 503 on storage unavailable
    class FailingStore:
        def read_verified(self, *args: Any, **kwargs: Any) -> bytes:
            raise ValueError("evidence_storage_unavailable")

    app.dependency_overrides[get_evidence_store] = lambda: FailingStore()
    res_503 = client.post("/v1/evidence/segment", json=payload, headers={"Authorization": f"Bearer {token}"})
    assert res_503.status_code == 503


def test_oversized_container_refused() -> None:
    token = get_settings().analyzer_service_token.get_secret_value()
    client = TestClient(app)

    key = "organizations/org_01/cases/case_01/artifacts/huge.mbox"

    class HugeStore:
        def read_verified(self, *args: Any, **kwargs: Any) -> bytes:
            raise ValueError("evidence_too_large")

    app.dependency_overrides[get_evidence_store] = lambda: HugeStore()

    payload = {
        "caseId": "case_01",
        "organizationId": "org_01",
        "evidenceId": "ev_huge",
        "objectKey": key,
        "sha256": "b" * 64,
        "byteSize": 200_000_000,
    }

    res = client.post("/v1/evidence/segment", json=payload, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 413


def test_timeout_path_returns_safely() -> None:
    token = get_settings().analyzer_service_token.get_secret_value()
    client = TestClient(app)

    key = "organizations/org_01/cases/case_01/artifacts/timeout.mbox"
    data = b"From a@b.com Mon Jan 1 00:00:00 2024\r\nFrom: a@b.com\r\nSubject: Timeout\r\n\r\nBody"
    store = MemoryEvidenceStore({key: data})
    app.dependency_overrides[get_evidence_store] = lambda: store

    payload = {
        "caseId": "case_01",
        "organizationId": "org_01",
        "evidenceId": "ev_to",
        "objectKey": key,
        "sha256": hashlib.sha256(data).hexdigest(),
        "byteSize": len(data),
    }

    with patch("app.main._run_segment_with_watchdog", side_effect=TimeoutError()):
        res = client.post("/v1/evidence/segment", json=payload, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 504


def test_log_assertion_no_bodies_headers_keys_or_tokens(caplog: pytest.LogCaptureFixture) -> None:
    token = get_settings().analyzer_service_token.get_secret_value()
    client = TestClient(app)

    secret_body = "HIGHLY_CONFIDENTIAL_PATIENT_RECORDS"
    raw_content = (
        f"From user@test.com Mon Jan 1 00:00:00 2024\r\n"
        f"From: Doctor <doc@clinic.com>\r\n"
        f"Subject: Medical Consultation\r\n"
        f"Date: Mon, 1 Jan 2024 10:00:00 +0000\r\n"
        f"\r\n"
        f"{secret_body}\r\n"
    ).encode()

    key = "organizations/org_01/cases/case_01/artifacts/container.mbox"
    store = MemoryEvidenceStore({key: raw_content})
    app.dependency_overrides[get_evidence_store] = lambda: store

    payload = {
        "caseId": "case_01",
        "organizationId": "org_01",
        "evidenceId": "ev_safe_log",
        "objectKey": key,
        "sha256": hashlib.sha256(raw_content).hexdigest(),
        "byteSize": len(raw_content),
    }

    caplog.set_level(logging.INFO)
    res = client.post("/v1/evidence/segment", json=payload, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200

    captured_logs = caplog.text
    # Assert no sensitive content appears in output logs
    assert secret_body not in captured_logs
    assert token not in captured_logs
    assert key not in captured_logs
    assert "Doctor <doc@clinic.com>" not in captured_logs


def test_response_shape_carries_no_message_content() -> None:
    token = get_settings().analyzer_service_token.get_secret_value()
    client = TestClient(app)

    secret_body_1 = "SECRET_PAYLOAD_PORTION_ONE"
    secret_body_2 = "SECRET_PAYLOAD_PORTION_TWO"

    m1 = (
        f"From: user1@example.com\r\n"
        f"To: dest1@example.com\r\n"
        f"Subject: First Topic\r\n"
        f"Date: Mon, 1 Jan 2024 10:00:00 +0000\r\n"
        f"\r\n"
        f"{secret_body_1}\r\n"
    ).encode()
    m2 = (
        f"From: user2@example.com\r\n"
        f"To: dest2@example.com\r\n"
        f"Subject: Second Topic\r\n"
        f"Date: Mon, 1 Jan 2024 11:00:00 +0000\r\n"
        f"\r\n"
        f"{secret_body_2}\r\n"
    ).encode()
    container_bytes = m1 + b"\r\n" + m2

    key = "organizations/org_01/cases/case_01/artifacts/data.eml"
    store = MemoryEvidenceStore({key: container_bytes})
    app.dependency_overrides[get_evidence_store] = lambda: store

    payload = {
        "caseId": "case_01",
        "organizationId": "org_01",
        "evidenceId": "ev_shape",
        "objectKey": key,
        "sha256": hashlib.sha256(container_bytes).hexdigest(),
        "byteSize": len(container_bytes),
    }

    res = client.post("/v1/evidence/segment", json=payload, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    data = res.json()

    # Response structure assertions
    assert data["containerFormat"] == "bare_concatenation"
    assert data["messageCount"] == 2
    assert len(data["segments"]) == 2

    # Verify no raw body content or raw header lines are returned
    raw_json_str = json.dumps(data)
    assert secret_body_1 not in raw_json_str
    assert secret_body_2 not in raw_json_str
    assert "SECRET" not in raw_json_str
    assert "To: dest1@example.com" not in raw_json_str

    # Only safe summaries are provided
    assert data["segments"][0]["summary"]["fromAddress"] == "user1@example.com"
    assert data["segments"][0]["summary"]["subject"] == "First Topic"
    assert data["segments"][1]["summary"]["fromAddress"] == "user2@example.com"
    assert data["segments"][1]["summary"]["subject"] == "Second Topic"
