"""PII-safe structured JSON logging for the private analyzer."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

request_id_context: ContextVar[str | None] = ContextVar("request_id", default=None)
analysis_run_id_context: ContextVar[str | None] = ContextVar("analysis_run_id", default=None)

# Fields that are never accepted as structured data. Values are also bounded.
_FORBIDDEN_PARTS = (
    "raw",
    "body",
    "html",
    "payload",
    "password",
    "secret",
    "token",
    "authorization",
    "cookie",
    "credential",
    "attachment",
)
_REQUEST_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)


def safe_request_id(value: str | None) -> str | None:
    """Keep caller-controlled IDs useful for correlation without echoing secrets."""
    if not value:
        return None
    bounded = value[:120]
    if _REQUEST_ID_RE.fullmatch(bounded) or re.fullmatch(r"req_[0-9a-f]{24}", bounded):
        return bounded
    return f"req_{hashlib.sha256(bounded.encode('utf-8', 'replace')).hexdigest()[:24]}"


_SAFE_FIELDS = {
    "requestId",
    "analysisRunId",
    "phase",
    "durationMs",
    "progress",
    "byteSize",
    "headerCount",
    "mimePartCount",
    "indicatorCount",
    "enrichmentCount",
    "warningCount",
    "score",
    "verdict",
    "confidence",
    "errorType",
}


def _safe_key(key: str) -> bool:
    lower = key.lower()
    return key in _SAFE_FIELDS and not any(part in lower for part in _FORBIDDEN_PARTS)


def _safe_value(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value if not isinstance(value, str) else value[:500]
    if isinstance(value, (list, tuple)):
        return [_safe_value(item) for item in value[:20]]
    return str(value)[:200]


class SafeJsonFormatter(logging.Formatter):
    """Format only an allow-listed event and safe count/identity fields."""

    def format(self, record: logging.LogRecord) -> str:
        fields = getattr(record, "safe_fields", {})
        safe_fields = {
            key: _safe_value(value) for key, value in fields.items() if isinstance(key, str) and _safe_key(key)
        }
        request_id = safe_fields.pop("requestId", None) or request_id_context.get()
        run_id = safe_fields.pop("analysisRunId", None) or analysis_run_id_context.get()
        # ``message`` is intentionally not copied from arbitrary logger input:
        # callers must use the static event name to avoid hostile body leakage.
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "event": str(getattr(record, "event", record.name))[:120],
        }
        safe_request = safe_request_id(str(request_id))
        if safe_request:
            payload["requestId"] = safe_request
        if run_id:
            payload["analysisRunId"] = str(run_id)[:160]
        payload.update(safe_fields)
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def get_structured_logger(name: str = "mailsentinel.analyzer") -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(SafeJsonFormatter())
        logger.addHandler(handler)
    return logger


def log_event(logger: logging.Logger, level: int, event: str, **safe_fields: Any) -> None:
    """Emit a static event with allow-listed metadata only."""
    logger.log(level, event, extra={"event": event, "safe_fields": safe_fields})
