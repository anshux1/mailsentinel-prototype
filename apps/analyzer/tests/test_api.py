from fastapi.testclient import TestClient

from app.core.settings import get_settings
from app.main import app


def test_live_health() -> None:
    assert TestClient(app).get("/health/live").json() == {"ok": True}


def test_intake_requires_token() -> None:
    response = TestClient(app).post("/v1/analyses", json={})
    assert response.status_code == 401


def test_valid_intake() -> None:
    payload = {
        "case_id": "case_01",
        "organization_id": "org_01",
        "analysis_run_id": "run_01",
        "artifact": {
            "object_key": "organizations/org_01/cases/case_01/artifacts/a.eml",
            "sha256": "a" * 64,
            "byte_size": 1,
        },
        "requested_at": "2026-01-01T00:00:00Z",
    }
    token = get_settings().analyzer_service_token.get_secret_value()
    response = TestClient(app).post("/v1/analyses", json=payload, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 202
    assert response.json()["status"] == "accepted"
