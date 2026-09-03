from functools import lru_cache
from pathlib import Path
from typing import Literal, Self

from pydantic import AnyHttpUrl, Field, PostgresDsn, RedisDsn, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.contracts.models import MAX_INDICATORS


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False, env_ignore_empty=True)

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
    max_eml_bytes: int = Field(default=26_214_400, le=50_000_000)
    max_mime_parts: int = Field(default=200, le=200)
    max_mime_depth: int = Field(default=30, le=100)
    max_header_count: int = Field(default=1_000, le=1_000)
    max_urls: int = 500
    max_attachment_bytes: int = Field(default=10_485_760, le=50_000_000)
    execution_timeout_seconds: float = Field(default=120.0, gt=0, le=3_600.0)
    enrichment_max_requests: int = Field(default=10, ge=0, le=1_000)
    enrichment_cache_ttl_seconds: float = Field(default=86_400.0, ge=0, le=604_800.0)
    enrichment_live_cache_ttl_seconds: float = Field(default=3_600.0, ge=0, le=604_800.0)
    enrichment_connect_timeout_seconds: float = Field(default=2.0, gt=0, le=2.0)
    enrichment_read_timeout_seconds: float = Field(default=3.0, gt=0, le=3.0)
    maxmind_db_path: Path | None = None
    abuseipdb_api_key: SecretStr | None = None
    offline_reputation_path: Path | None = None
    enrichment_mode: Literal["fixture", "offline", "live"] = "fixture"
    analysis_version: str = Field(default="prototype-1", min_length=1)
    retention_days: int = Field(default=90, le=3_650)
    max_container_messages: int = Field(default=500, le=10_000)
    max_container_bytes: int = Field(default=104_857_600, le=536_870_912)
    max_nested_message_depth: int = Field(default=3, le=10)
    max_nested_messages: int = Field(default=10, le=100)

    @field_validator(
        "max_eml_bytes",
        "max_mime_parts",
        "max_mime_depth",
        "max_header_count",
        "max_urls",
        "max_attachment_bytes",
        "retention_days",
        "max_container_messages",
        "max_container_bytes",
        "max_nested_message_depth",
        "max_nested_messages",
    )
    @classmethod
    def positive_limit(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("resource limits must be positive")
        return value

    @field_validator("max_urls")
    @classmethod
    def validate_max_urls_bound(cls, value: int) -> int:
        if value > MAX_INDICATORS:
            raise ValueError(f"max_urls cannot exceed indicator contract limit ({MAX_INDICATORS})")
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
