# mypy: disable-error-code="no-untyped-call"

import dramatiq
from dramatiq.brokers.redis import RedisBroker
from dramatiq.brokers.stub import StubBroker
from dramatiq.middleware import AgeLimit, Retries, default_middleware

from app.core.settings import get_settings

settings = get_settings()


def configured_middleware() -> list[object]:
    """Use Dramatiq defaults once, overriding only setup policies."""
    return [
        AgeLimit(max_age=15 * 60 * 1_000)
        if middleware is AgeLimit
        else Retries(max_retries=3, min_backoff=1_000, max_backoff=30_000)
        if middleware is Retries
        else middleware()
        for middleware in default_middleware
    ]


middleware = configured_middleware()
broker = (
    StubBroker(middleware=middleware)
    if settings.app_env == "test"
    else RedisBroker(url=str(settings.redis_url), middleware=middleware)
)
dramatiq.set_broker(broker)


@dramatiq.actor(queue_name="analysis", max_retries=3)
def setup_analysis(analysis_run_id: str) -> None:
    """Acknowledge idempotent setup work without producing a verdict.

    `analysis_run_id` is the queue idempotency key. Product persistence will use
    an atomic status transition before any future analysis work.
    """
    if not analysis_run_id:
        raise ValueError("analysis_run_id is required")
