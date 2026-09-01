from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["test", "development", "demo", "production"] = "development"
    database_url: str = "postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel"
    redis_url: str = "redis://localhost:6379/0"
    s3_endpoint: str = "http://localhost:9000"
    s3_bucket: str = "mailsentinel-evidence"
    analyzer_service_token: SecretStr = SecretStr("local-development-token-change-me")
    max_eml_bytes: int = 26_214_400
    enrichment_mode: Literal["fixture", "offline", "live"] = "fixture"
    analysis_version: str = "prototype-1"

    @field_validator("max_eml_bytes")
    @classmethod
    def positive_limit(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("max_eml_bytes must be positive")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
