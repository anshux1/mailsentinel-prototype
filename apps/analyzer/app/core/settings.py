from functools import lru_cache
from pathlib import Path
from typing import Literal, Self

from pydantic import AnyHttpUrl, Field, PostgresDsn, RedisDsn, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    app_env: Literal["test", "development", "demo", "production"] = "development"
    database_url: PostgresDsn
    redis_url: RedisDsn = RedisDsn("redis://localhost:6379/0")
    s3_endpoint: AnyHttpUrl = AnyHttpUrl("http://localhost:9000")
    s3_region: str = Field(default="us-east-1", min_length=1)
    s3_bucket: str = Field(default="mailsentinel-evidence", min_length=1)
    s3_access_key_id: str = Field(min_length=1)
    s3_secret_access_key: SecretStr
    s3_force_path_style: bool = True
    analyzer_service_token: SecretStr
    max_eml_bytes: int = 26_214_400
    max_mime_parts: int = 200
    max_header_count: int = 1_000
    max_urls: int = 500
    max_attachment_bytes: int = 10_485_760
    maxmind_db_path: Path | None = None
    abuseipdb_api_key: SecretStr | None = None
    enrichment_mode: Literal["fixture", "offline", "live"] = "fixture"
    analysis_version: str = Field(default="prototype-1", min_length=1)
    retention_days: int = 90

    @field_validator(
        "max_eml_bytes",
        "max_mime_parts",
        "max_header_count",
        "max_urls",
        "max_attachment_bytes",
        "retention_days",
    )
    @classmethod
    def positive_limit(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("resource limits must be positive")
        return value

    @field_validator("analyzer_service_token", "s3_secret_access_key")
    @classmethod
    def minimum_secret_length(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < 16:
            raise ValueError("secret must contain at least 16 characters")
        return value

    @model_validator(mode="after")
    def require_live_provider_configuration(self) -> Self:
        if self.enrichment_mode == "live" and (
            self.abuseipdb_api_key is None or not self.abuseipdb_api_key.get_secret_value()
        ):
            raise ValueError("ABUSEIPDB_API_KEY is required when ENRICHMENT_MODE=live")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
