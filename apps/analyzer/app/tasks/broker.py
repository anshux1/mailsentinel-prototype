# mypy: disable-error-code="no-untyped-call"

import dramatiq
from dramatiq.brokers.redis import RedisBroker
from dramatiq.brokers.stub import StubBroker
from dramatiq.middleware import AgeLimit, Retries

from app.core.settings import get_settings

settings = get_settings()
broker = StubBroker() if settings.app_env == "test" else RedisBroker(url=str(settings.redis_url))
broker.add_middleware(AgeLimit(max_age=15 * 60 * 1_000))
broker.add_middleware(Retries(max_retries=3, min_backoff=1_000, max_backoff=30_000))
dramatiq.set_broker(broker)


@dramatiq.actor(queue_name="analysis", max_retries=3)
def setup_analysis(analysis_run_id: str) -> None:
    """Acknowledge idempotent setup work without producing a verdict.

    `analysis_run_id` is the queue idempotency key. Product persistence will use
    an atomic status transition before any future analysis work.
    """
    if not analysis_run_id:
        raise ValueError("analysis_run_id is required")
