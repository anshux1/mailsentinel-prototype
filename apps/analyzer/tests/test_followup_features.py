from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from unittest.mock import Mock

import pytest

from app.analysis import AnalysisError, run_analysis
from app.contracts.models import (
    AddressObservation,
    AnalysisPhase,
    AnalysisStatusValue,
    AuthenticationObservation,
    DateObservation,
    IdentityObservation,
    IndicatorObservation,
)
from app.enrichment.providers import (
    AbuseIPDBProvider,
    FixtureProvider,
    InMemoryIndicatorCache,
    OfflineProvider,
    enrich,
)
from app.extraction.extract import (
    extract_addresses,
    extract_auth_conflicts,
    extract_authentication,
    extract_content_indicators,
    extract_date,
    extract_identity,
    extract_link_mismatches,
    extract_message_ids,
    extract_received,
    extract_routing_anomalies,
)
from app.parsing.parser import ParsedMessage
from app.persistence.interfaces import InMemoryAnalysisRepository, RunInput
from app.scoring.rules import score_findings


def test_richer_identity_date_auth_and_routing_observations() -> None:
    message = ParsedMessage(
        headers=[
            ("From", "PayPal Support <fraud@attacker.example>"),
            ("Date", "Wed, 01 Jan 2020 00:00:00 +0000"),
            ("Message-ID", "<x@unrelated.example>"),
            ("Authentication-Results", "mx.example; spf=pass; dkim=pass"),
            ("Received-SPF", "fail (bad) receiver=other.example"),
            ("DKIM-Signature", "v=1; a=rsa-sha256; d=attacker.example; s=mail; i=@attacker.example"),
            ("Received", "from 8.8.8.8 by edge.example; Wed, 01 Jan 2026 00:00:01 +0000"),
            ("Received", "from 10.0.0.1 by origin.example; Wed, 01 Jan 2026 00:00:02 +0000"),
        ]
    )
    addresses = extract_addresses(message)
    identities = extract_identity(message, addresses)
    assert any(item.inconsistency_type == "brand_impersonation" for item in identities)

    dates = extract_date(message, extract_received(message), datetime(2026, 1, 1, tzinfo=UTC))
    assert dates[0].parsed_date == datetime(2020, 1, 1, tzinfo=UTC)
    assert "stale_date" in dates[0].anomalies
    assert "routing_timestamp_mismatch" in dates[0].anomalies

    auth = extract_authentication(message)
    assert any(item.source == "received-spf" and item.result == "fail" for item in auth)
    assert any(item.source == "dkim-signature" and item.algorithm == "rsa-sha256" for item in auth)
    assert any(item.method == "spf" for item in extract_auth_conflicts(auth))

    hops = extract_received(message)
    assert hops[0].private_to_public is True
    assert any(item.anomaly_type == "private_to_public_transition" for item in extract_routing_anomalies(hops))

    ids = extract_message_ids(message, addresses)
    assert ids[0].is_valid_syntax is True
    assert "domain_mismatch" in ids[0].anomalies


def test_content_and_link_observations_are_bounded_and_network_free() -> None:
    message = ParsedMessage(
        plain_text="Your account is suspended. Verify your password immediately.",
        html_text='<a href="https://attacker.example/login">https://legitimate.example/login</a>',
    )
    content = extract_content_indicators(message)
    assert any(item.category == "credential_harvesting" for item in content)
    assert all(len(item.snippet) <= 200 for item in content)
    mismatch = extract_link_mismatches(message)
    assert mismatch[0].display_domain == "legitimate.example"
    assert mismatch[0].actual_domain == "attacker.example"
    assert all(len(item.actual_href) <= 500 for item in mismatch)


def test_offline_file_provider_and_ttl_cache(tmp_path: Path) -> None:
    path = tmp_path / "reputation.json"
    path.write_text(
        json.dumps({"8.8.8.8": {"reputation": "suspicious", "score": 60, "asn": "AS9009", "country": "RU"}})
    )
    indicator = IndicatorObservation(kind="ip", value="8.8.8.8", normalized_value="8.8.8.8", source="body")
    provider = OfflineProvider(database_path=path)
    result = provider.lookup(indicator)
    assert result is not None
    assert result.details.asn == "AS9009"
    assert result.details.country == "RU"

    calls = 0

    class CountingProvider:
        name = "fixture"

        def lookup(self, item: IndicatorObservation):  # type: ignore[no-untyped-def]
            nonlocal calls
            calls += 1
            return FixtureProvider().lookup(item)

    cache = InMemoryIndicatorCache(ttl_seconds=60)
    enrich([indicator], "offline", provider=CountingProvider(), cache=cache)
    enrich([indicator], "offline", provider=CountingProvider(), cache=cache)
    assert calls == 1


def test_live_provider_never_sends_private_ip_and_sanitizes_payload(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    provider = AbuseIPDBProvider(api_key="secret-key", endpoint="https://intel.example/check")
    fetch = Mock(return_value={"data": {"abuseConfidenceScore": 90, "countryCode": "US", "asn": 123}})
    monkeypatch.setattr(provider, "_fetch", fetch)
    private = IndicatorObservation(
        kind="ip", value="127.0.0.1", normalized_value="127.0.0.1", source="body", private_or_reserved=True
    )
    public = IndicatorObservation(
        kind="ip", value="8.8.8.8", normalized_value="8.8.8.8", source="body", private_or_reserved=False
    )
    assert provider.lookup(private) is None
    result = provider.lookup(public)
    assert result is not None and result.reputation == "malicious"
    fetch.assert_called_once_with("8.8.8.8")


def test_followup_scoring_and_benign_calibration() -> None:
    addresses = [
        AddressObservation(value="a@example.com", address="a@example.com", domain="example.com", source="from")
    ]
    positive = score_findings(
        addresses=addresses,
        authentication=[
            AuthenticationObservation(
                method="spf", result="pass", declaring_host="mx.example.com", domain="example.com"
            ),
            AuthenticationObservation(
                method="dkim", result="pass", declaring_host="mx.example.com", domain="example.com"
            ),
            AuthenticationObservation(
                method="dmarc", result="pass", declaring_host="mx.example.com", domain="example.com"
            ),
        ],
        received=[],
        indicators=[],
        mime_parts=[],
        warnings=[],
        enrichment=[],
        identity_observations=[
            IdentityObservation(
                source="from",
                display_name="CEO",
                address="a@example.com",
                claimed_identity="CEO",
                inconsistency_type="x",
                explanation="spoof",
            )
        ],
        date_observations=[DateObservation(raw_value="bad", anomalies=["future_date"])],
    )
    ids = {item.rule_id for item in positive.contributions}
    assert "identity.display_name_spoofing" in ids
    assert "date.future" in ids
    assert "auth.aligned.pass" in ids
    assert positive.final_score >= 0


def test_in_memory_audit_phase_and_watchdog() -> None:
    body = b"From: a@example.com\n\nhello"
    key = "organizations/o/cases/c/artifacts/a.eml"
    repo = InMemoryAnalysisRepository([RunInput("run", "o", "c", key, sha256(body).hexdigest(), len(body))])
    repo.mark_queued("run")
    assert repo.claim("run") is True
    assert repo.get_detailed_status("run").phase == AnalysisPhase.FETCHING_EVIDENCE
    assert repo.get_audit_records("run")[0].action == "analysis.run.claimed"

    class SlowStore:
        def read_verified(self, *args: object, **kwargs: object) -> bytes:
            time.sleep(0.1)
            return body

    watchdog_repo = InMemoryAnalysisRepository(
        [RunInput("run_slow", "o", "c", key, sha256(body).hexdigest(), len(body))]
    )
    from app.core.settings import Settings

    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url="postgresql://u:p@localhost/db",
        s3_access_key_id="access",
        s3_secret_access_key="secret-key-123456",
        analyzer_service_token="analyzer-token-123456",
        execution_timeout_seconds=0.01,
    )
    with pytest.raises(AnalysisError, match="configured timeout"):
        run_analysis("run_slow", repository=watchdog_repo, evidence_store=SlowStore(), settings=settings)
    assert watchdog_repo.get_status("run_slow") == AnalysisStatusValue.FAILED
    assert watchdog_repo.retryable["run_slow"] is True
