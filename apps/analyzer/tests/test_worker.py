from dramatiq import Message
from dramatiq.brokers.stub import StubBroker

from app.tasks.broker import broker, setup_analysis


def test_broker_configures_each_default_middleware_once() -> None:
    middleware_types = [type(item) for item in broker.middleware]
    assert len(middleware_types) == len(set(middleware_types))


def test_setup_actor_uses_analysis_run_as_idempotency_key() -> None:
    assert isinstance(broker, StubBroker)
    queue = broker.queues["analysis"]
    while not queue.empty():
        queue.get_nowait()
    setup_analysis.send("run_setup_01")
    message = Message.decode(queue.get_nowait())
    assert message.args == ("run_setup_01",)


def test_setup_actor_never_creates_a_verdict() -> None:
    assert setup_analysis.fn("run_setup_01") is None
