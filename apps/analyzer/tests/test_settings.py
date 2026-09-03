from pathlib import Path
from typing import Any, cast

import pytest
from pydantic import ValidationError

from app.core.settings import Settings

VALID = {
    "app_env": "development",
    "database_url": "postgresql://user:password@localhost:5432/mailsentinel",
    "s3_access_key_id": "mailsentinel",
    "s3_secret_access_key": "mailsentinel-secret",
    "analyzer_service_token": "analyzer-token-change-me",
    "enrichment_mode": "fixture",
}


def settings(**overrides: object) -> Settings:
    merged = cast(dict[str, Any], VALID | overrides)
    return Settings(_env_file=None, **merged)  # type: ignore[call-arg]


def test_valid_development_fixture_settings() -> None:
    assert settings().enrichment_mode == "fixture"


@pytest.mark.parametrize(
    "overrides",
    [
        {"analyzer_service_token": "short"},
        {"database_url": "not-a-url"},
        {"max_eml_bytes": 0},
        {"enrichment_mode": "invalid"},
        {"max_urls": 0},
        {"max_urls": 1001},
    ],
)
def test_invalid_settings(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        settings(**overrides)


def test_max_urls_contract_bounds() -> None:
    s = settings(max_urls=1000)
    assert s.max_urls == 1000
    with pytest.raises(ValidationError, match="max_urls cannot exceed indicator contract limit"):
        settings(max_urls=1001)
    with pytest.raises(ValidationError, match="resource limits must be positive"):
        settings(max_urls=0)


def test_missing_core_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    values: dict[str, Any] = VALID.copy()
    values.pop("analyzer_service_token")
    monkeypatch.delenv("ANALYZER_SERVICE_TOKEN")
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **values)  # type: ignore[call-arg]


@pytest.mark.parametrize("api_key", [None, ""])
def test_live_mode_requires_provider_key(api_key: str | None) -> None:
    with pytest.raises(ValidationError, match="ABUSEIPDB_API_KEY"):
        settings(enrichment_mode="live", abuseipdb_api_key=api_key)


def test_example_documents_every_setting() -> None:
    example = (Path(__file__).parents[1] / ".env.example").read_text()
    documented = {line.split("=", 1)[0] for line in example.splitlines() if "=" in line}
    for name in Settings.model_fields:
        assert name.upper() in documented
