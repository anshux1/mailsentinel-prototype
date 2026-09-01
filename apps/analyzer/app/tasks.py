import dramatiq
from dramatiq.brokers.redis import RedisBroker

from app.core.settings import get_settings

settings = get_settings()
broker = RedisBroker(url=settings.redis_url)
dramatiq.set_broker(broker)


@dramatiq.actor(max_retries=0)
def setup_analysis(analysis_run_id: str) -> str:
    """A safe setup actor: acknowledge work without producing a verdict."""
    return f"deferred:{analysis_run_id}"
