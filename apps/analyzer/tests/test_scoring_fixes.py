import socket
from datetime import UTC, datetime
from hashlib import sha256

import pytest

from app.analysis import analyze_bytes
from app.contracts.models import (
    MAX_FINDINGS,
    AddressObservation,
    AnalysisResult,
    AuthenticationObservation,
    EnrichmentObservation,
    FindingCategory,
    IndicatorObservation,
    MimePartObservation,
    ReceivedHop,
    ScoreBreakdown,
    SeverityValue,
    VerdictValue,
)
from app.core.settings import Settings
from app.scoring.rules import _finding_sort_key, _to_utc, score_findings, verdict_for


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure scoring is completely offline with zero network access."""

    def _fail_socket(*args: object, **kwargs: object) -> None:
        raise RuntimeError("Unexpected network access attempt in scoring")

    monkeypatch.setattr(socket, "socket", _fail_socket)
    monkeypatch.setattr(socket, "getaddrinfo", _fail_socket)
    monkeypatch.setattr(socket, "gethostbyname", _fail_socket)


def test_sender_domain_mismatch_ignores_to_and_cc() -> None:
    # Single sender domain, but different recipient (To/Cc) domains
    addresses = [
        AddressObservation(
            value="billing@legit.example",
            address="billing@legit.example",
            display_name="Billing",
            domain="legit.example",
            source="from",
        ),
        AddressObservation(
            value="customer@gmail.example",
            address="customer@gmail.example",
            display_name="Customer",
            domain="gmail.example",
            source="to",
        ),
        AddressObservation(
            value="auditor@yahoo.example",
            address="auditor@yahoo.example",
            display_name="Auditor",
            domain="yahoo.example",
            source="cc",
        ),
    ]

    breakdown = score_findings(
        addresses=addresses,
        authentication=[],
        received=[],
        indicators=[],
        mime_parts=[],
        warnings=[],
        enrichment=[],
    )

    # Must NOT flag sender.domain.mismatch because only To and Cc differ
    rule_ids = [f.rule_id for f in breakdown.contributions]
    assert "sender.domain.mismatch" not in rule_ids
    assert breakdown.final_score == 0


def test_sender_domain_mismatch_detects_conflicting_sender_headers() -> None:
    # From domain differs from Reply-To and Return-Path
    addresses = [
        AddressObservation(
            value="billing@legit.example",
            address="billing@legit.example",
            display_name="Billing",
            domain="legit.example",
            source="from",
        ),
        AddressObservation(
            value="phisher@attacker.example",
            address="phisher@attacker.example",
            display_name="Support",
            domain="attacker.example",
            source="reply-to",
        ),
    ]

    breakdown = score_findings(
        addresses=addresses,
        authentication=[],
        received=[],
        indicators=[],
        mime_parts=[],
        warnings=[],
        enrichment=[],
    )

    finding = next(f for f in breakdown.contributions if f.rule_id == "sender.domain.mismatch")
    assert finding.category == FindingCategory.HEADERS
    assert finding.severity == SeverityValue.MEDIUM
    assert finding.score_contribution == 18
    assert breakdown.final_score == 18


def test_sender_domain_mismatch_with_sender_header() -> None:
    addresses = [
        AddressObservation(
            value="ceo@company.example",
            address="ceo@company.example",
            domain="company.example",
            source="from",
        ),
        AddressObservation(
            value="agent@outside.example",
            address="agent@outside.example",
            domain="outside.example",
            source="sender",
        ),
        AddressObservation(
            value="staff@company.example",
            address="staff@company.example",
            domain="company.example",
            source="to",
        ),
    ]

    breakdown = score_findings(
        addresses=addresses,
        authentication=[],
        received=[],
        indicators=[],
        mime_parts=[],
        warnings=[],
        enrichment=[],
    )

    rule_ids = [f.rule_id for f in breakdown.contributions]
    assert "sender.domain.mismatch" in rule_ids


def test_mixed_aware_and_naive_received_timestamps_never_crash() -> None:
    # Construct hops with mixed naive and aware datetimes, plus None
    aware_ts = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    naive_ts = datetime(2026, 1, 1, 11, 0)  # Naive, offset unknown

    hops = [
        ReceivedHop(
            position=1,
            from_host="mta1.example",
            by_host="mta2.example",
            source_ip="1.1.1.1",
            timestamp=aware_ts,
            parse_warning=None,
        ),
        # Manually create hop with naive datetime or bypass validator to test score_findings resiliency
        ReceivedHop.model_construct(
            position=2,
            from_host="mta0.example",
            by_host="mta1.example",
            source_ip="2.2.2.2",
            timestamp=naive_ts,
            parse_warning=None,
        ),
        ReceivedHop(
            position=3,
            from_host=None,
            by_host=None,
            source_ip=None,
            timestamp=None,
            parse_warning="received header is incomplete",
        ),
    ]

    # This MUST NOT raise TypeError: can't compare offset-naive and offset-aware datetimes
    breakdown = score_findings(
        addresses=[],
        authentication=[],
        received=hops,
        indicators=[],
        mime_parts=[],
        warnings=[],
        enrichment=[],
    )

    # Delivery order: 12:00 then 11:00 -> in delivery order (newest first)
    rule_ids = [f.rule_id for f in breakdown.contributions]
    assert "routing.timestamp.order" not in rule_ids
    assert "routing.malformed" in rule_ids


def test_out_of_order_received_timestamps_detected() -> None:
    # Hop 1 (most recent recipient) has older timestamp than hop 2
    hop1_ts = datetime(2026, 1, 1, 10, 0, tzinfo=UTC)
    hop2_ts = datetime(2026, 1, 1, 11, 0, tzinfo=UTC)

    hops = [
        ReceivedHop(position=1, from_host="a", by_host="b", timestamp=hop1_ts),
        ReceivedHop(position=2, from_host="c", by_host="a", timestamp=hop2_ts),
    ]

    breakdown = score_findings(
        addresses=[],
        authentication=[],
        received=hops,
        indicators=[],
        mime_parts=[],
        warnings=[],
        enrichment=[],
    )

    finding = next(f for f in breakdown.contributions if f.rule_id == "routing.timestamp.order")
    assert finding.severity == SeverityValue.MEDIUM
    assert finding.score_contribution == 10


def test_url_userinfo_scoring_detection() -> None:
    # URL indicator with userinfo in metadata source
    indicators = [
        IndicatorObservation(
            kind="url",
            value="https://admin:***@evil.example/login",
            normalized_value="https://evil.example/login",
            source="body;userinfo",
        ),
        IndicatorObservation(
            kind="url",
            value="https://clean.example/about",
            normalized_value="https://clean.example/about",
            source="body",
        ),
    ]

    breakdown = score_findings(
        addresses=[],
        authentication=[],
        received=[],
        indicators=indicators,
        mime_parts=[],
        warnings=[],
        enrichment=[],
    )

    finding = next(f for f in breakdown.contributions if f.rule_id == "url.userinfo")
    assert finding.category == FindingCategory.URL
    assert finding.severity == SeverityValue.HIGH
    assert finding.score_contribution == 20
    assert breakdown.final_score == 20


def test_to_utc_helper() -> None:
    assert _to_utc(None) is None
    naive = datetime(2026, 1, 1, 0, 0)
    aware = _to_utc(naive)
    assert aware is not None
    assert aware.tzinfo == UTC
    assert aware.year == 2026


def test_verdict_mapping_thresholds() -> None:
    assert verdict_for(0).value == "benign"
    assert verdict_for(10).value == "benign"
    assert verdict_for(11).value == "unknown"
    assert verdict_for(34).value == "unknown"
    assert verdict_for(35).value == "suspicious"
    assert verdict_for(69).value == "suspicious"
    assert verdict_for(70).value == "malicious"
    assert verdict_for(100).value == "malicious"


def test_evidence_refs_populated_for_all_rule_families() -> None:
    from app.contracts.models import (
        AuthenticationObservation,
        EnrichmentObservation,
        MimePartObservation,
    )

    addresses = [
        AddressObservation(value="a@from.com", domain="from.com", source="from"),
        AddressObservation(value="b@reply.com", domain="reply.com", source="reply-to"),
    ]
    auth = [
        AuthenticationObservation(method="spf", result="fail", source="authentication-results"),
    ]
    hops = [
        ReceivedHop(position=1, from_host="a", by_host="b", parse_warning="incomplete"),
    ]
    indicators = [
        IndicatorObservation(
            kind="url",
            value="https://admin:***@evil.com",
            normalized_value="https://evil.com",
            source="body;userinfo",
        ),
    ]
    mime_parts = [
        MimePartObservation(
            part_id="1.1",
            content_type="application/octet-stream",
            byte_size=100,
            filename="trojan.exe",
            dangerous_extension=True,
        ),
    ]
    enrichment = [
        EnrichmentObservation(
            indicator="https://evil.com",
            provider="fixture",
            mode="fixture",
            reputation="malicious",
            score=95,
        ),
    ]
    breakdown = score_findings(
        addresses=addresses,
        authentication=auth,
        received=hops,
        indicators=indicators,
        mime_parts=mime_parts,
        warnings=["malformed_mime"],
        enrichment=enrichment,
    )

    # Every nonzero finding must have nonempty, meaningful evidence references
    assert len(breakdown.contributions) > 0
    for finding in breakdown.contributions:
        assert len(finding.evidence_refs) > 0
        assert all(ref for ref in finding.evidence_refs)

    sender_finding = next(f for f in breakdown.contributions if f.rule_id == "sender.domain.mismatch")
    assert any("from.com" in ref for ref in sender_finding.evidence_refs)

    auth_finding = next(f for f in breakdown.contributions if "auth.spf" in f.rule_id)
    assert any("spf=fail" in ref for ref in auth_finding.evidence_refs)

    attach_finding = next(f for f in breakdown.contributions if "attachment.dangerous" in f.rule_id)
    assert "trojan.exe" in attach_finding.evidence_refs


def test_bounded_findings_over_500_mixed_rule_families() -> None:
    """Construct >500 potential findings across multiple families and verify bounds, determinism, and validity."""
    auth = [
        AuthenticationObservation(
            method=f"spf{i % 10}",
            result="fail",
            source=f"auth-header-{i}",
        )
        for i in range(60)
    ]
    mime_parts = [
        MimePartObservation(
            part_id=f"part_{i}",
            content_type="application/octet-stream",
            byte_size=1000,
            filename=f"payload_{i}.exe",
            dangerous_extension=True,
            type_extension_mismatch=True,
        )
        for i in range(60)
    ]
    indicators = [
        IndicatorObservation(
            kind="url",
            value=f"https://admin{i}:secret{i}@threat-host{i}.example/path",
            normalized_value=f"https://threat-host{i}.example/path",
            source="body;userinfo",
        )
        for i in range(300)
    ]
    enrichment = [
        EnrichmentObservation(
            indicator=f"https://intel-indicator{i}.example/malware",
            provider=f"feed_{i % 5}",
            mode="offline",
            reputation="malicious",
            score=95,
        )
        for i in range(300)
    ]
    addresses = [
        AddressObservation(value="ceo@company.example", domain="company.example", source="from"),
        AddressObservation(value="phisher@spoof.example", domain="spoof.example", source="reply-to"),
    ]
    hops = [ReceivedHop(position=1, parse_warning="truncated header")]
    warnings = ["parser warned"]

    # Total potential findings:
    # 60 (auth) + 120 (mime) + 300 (url) + 300 (enrichment) + 1 (sender) + 1 (hop) + 1 (warn) = 783
    breakdown1 = score_findings(
        addresses=addresses,
        authentication=auth,
        received=hops,
        indicators=indicators,
        mime_parts=mime_parts,
        warnings=warnings,
        enrichment=enrichment,
    )

    # 1. Bounded exactly at MAX_FINDINGS (500)
    assert len(breakdown1.contributions) == MAX_FINDINGS
    assert len(breakdown1.contributions) <= 500

    # 2. Score and verdict consistency
    total_contribution = sum(c.score_contribution for c in breakdown1.contributions)
    expected_score = max(0, min(100, breakdown1.base_score + total_contribution))
    assert breakdown1.final_score == expected_score
    assert breakdown1.final_score == 100
    assert verdict_for(breakdown1.final_score) == VerdictValue.MALICIOUS

    # 3. Deterministic ordering: sorted by rule_id then source, explanation, evidence_refs
    keys = [_finding_sort_key(f) for f in breakdown1.contributions]
    assert keys == sorted(keys)

    # 4. Input permutation determinism: reversed inputs produce identical output
    breakdown2 = score_findings(
        addresses=addresses[::-1],
        authentication=auth[::-1],
        received=hops[::-1],
        indicators=indicators[::-1],
        mime_parts=mime_parts[::-1],
        warnings=warnings[::-1],
        enrichment=enrichment[::-1],
    )
    assert len(breakdown2.contributions) == MAX_FINDINGS
    assert [f.model_dump() for f in breakdown1.contributions] == [f.model_dump() for f in breakdown2.contributions]

    # 5. Explainability preserved: diverse rule families are represented and not starved
    rule_ids = {f.rule_id for f in breakdown1.contributions}
    assert "sender.domain.mismatch" in rule_ids
    assert "routing.malformed" in rule_ids
    assert "parser.defect" in rule_ids
    assert any(r.startswith("auth.") for r in rule_ids)
    assert "attachment.dangerous_extension" in rule_ids
    assert "attachment.type_mismatch" in rule_ids
    assert "url.userinfo" in rule_ids
    assert "enrichment.malicious" in rule_ids

    # 6. Public contract & AnalysisResult validity (no ValidationError)
    sb_validated = ScoreBreakdown.model_validate(breakdown1.model_dump())
    assert sb_validated.final_score == 100
    assert len(sb_validated.contributions) == MAX_FINDINGS

    result = AnalysisResult(
        schema_version="1.0.0",
        ruleset_version="1.0.0",
        analysis_version="1.0.0",
        analysis_run_id="run_regression_over500",
        organization_id="org_01",
        case_id="case_01",
        artifact_sha256="a" * 64,
        artifact_byte_size=2048,
        findings=breakdown1.contributions,
        score=breakdown1,
        verdict=verdict_for(breakdown1.final_score),
        confidence=0.85,
        analyzed_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    assert result.verdict == VerdictValue.MALICIOUS
    assert len(result.findings) == MAX_FINDINGS
    assert len(result.score.contributions) == MAX_FINDINGS


def test_bounded_findings_single_rule_overflow() -> None:
    """A single rule generating >500 findings is cleanly bounded at MAX_FINDINGS and validates."""
    enrichment = [
        EnrichmentObservation(
            indicator=f"https://malicious-domain-{i:04d}.example",
            provider="threat_intel",
            mode="offline",
            reputation="malicious",
            score=90,
        )
        for i in range(650)
    ]

    breakdown = score_findings(
        addresses=[],
        authentication=[],
        received=[],
        indicators=[],
        mime_parts=[],
        warnings=[],
        enrichment=enrichment,
    )

    assert len(breakdown.contributions) == MAX_FINDINGS
    assert all(f.rule_id == "enrichment.malicious" for f in breakdown.contributions)
    keys = [_finding_sort_key(f) for f in breakdown.contributions]
    assert keys == sorted(keys)
    assert breakdown.final_score == 100

    sb = ScoreBreakdown.model_validate(breakdown.model_dump())
    assert sb.final_score == 100

    result = AnalysisResult(
        schema_version="1.0.0",
        ruleset_version="1.0.0",
        analysis_version="1.0.0",
        analysis_run_id="run_single_rule_overflow",
        organization_id="org_01",
        case_id="case_01",
        artifact_sha256="b" * 64,
        artifact_byte_size=4096,
        findings=breakdown.contributions,
        score=breakdown,
        verdict=verdict_for(breakdown.final_score),
        confidence=0.75,
        analyzed_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    assert result.verdict == VerdictValue.MALICIOUS
    assert len(result.findings) == MAX_FINDINGS


def test_analyze_bytes_pipeline_handles_over_500_findings_end_to_end() -> None:
    """The complete analyze_bytes pipeline must not fail validation when an email generates >500 findings."""
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://user:pass@localhost:5432/mailsentinel",  # type: ignore[arg-type]
        s3_access_key_id="mailsentinel",
        s3_secret_access_key="mailsentinel-secret",  # type: ignore[arg-type]
        analyzer_service_token="analyzer-token-change-me",  # type: ignore[arg-type]
        enrichment_mode="fixture",
        max_urls=1000,
        max_eml_bytes=1_000_000,
    )

    # Construct message with 600 URLs with userinfo in the body.
    # In fixture mode, URLs containing "phishing" will ALSO produce malicious enrichment items!
    # So 600 userinfo URLs + 600 malicious enrichment items = 1200 potential findings (>500).
    links = "\n".join(f"https://user{i}:pass@phishing{i}.example/login" for i in range(600))
    raw = (
        b"From: phisher@attack.example\n"
        b"Subject: Many links\n"
        b"MIME-Version: 1.0\n"
        b"Content-Type: text/plain; charset=utf-8\n\n" + links.encode("utf-8")
    )

    result = analyze_bytes(
        run_id="run_pipeline_over500",
        organization_id="org_01",
        case_id="case_01",
        artifact_sha256=sha256(raw).hexdigest(),
        artifact_byte_size=len(raw),
        raw=raw,
        settings=settings,
        now=datetime(2026, 1, 1, tzinfo=UTC),
    )

    assert result is not None
    assert len(result.findings) == MAX_FINDINGS
    assert len(result.score.contributions) == MAX_FINDINGS
    assert result.verdict == VerdictValue.MALICIOUS
    assert result.score.final_score == 100
    assert all(f.evidence_refs for f in result.findings)
    # Both url.userinfo and enrichment.malicious are present in bounded output
    rules_in_findings = {f.rule_id for f in result.findings}
    assert "url.userinfo" in rules_in_findings
    assert "enrichment.malicious" in rules_in_findings
