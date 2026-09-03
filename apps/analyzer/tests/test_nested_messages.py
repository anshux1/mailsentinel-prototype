"""Tests for Phase P10: Nested message analysis and conservative scoring."""

import hashlib
from datetime import UTC, datetime

from app.analysis import analyze_bytes
from app.contracts.models import (
    AnalysisResult,
    VerdictValue,
)
from app.core.settings import Settings


def _test_settings(**kwargs: object) -> Settings:
    defaults = {
        "_env_file": None,
        "app_env": "test",
        "database_url": "postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel",
        "s3_access_key_id": "mailsentinel",
        "s3_secret_access_key": "mailsentinel-secret",
        "analyzer_service_token": "analyzer-token-change-me",
        "enrichment_mode": "offline",
    }
    defaults.update(kwargs)
    return Settings(**defaults)  # type: ignore[arg-type]


def test_benign_forwarding_malicious_cites_path() -> None:
    settings = _test_settings()
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    # Malicious nested message has a link mismatch, malicious content, and dangerous attachment
    nested_eml = (
        b"From: phisher@evil.com\r\n"
        b"To: victim@example.com\r\n"
        b"Subject: URGENT: Wire Transfer Required Immediately\r\n"
        b"Date: Mon, 1 Jan 2024 10:00:00 +0000\r\n"
        b'Content-Type: multipart/mixed; boundary="nested-sep"\r\n'
        b"\r\n"
        b"--nested-sep\r\n"
        b"Content-Type: text/html\r\n"
        b"\r\n"
        b'<a href="http://198.51.100.1/steal">https://paypal.com/verify</a>\r\n'
        b"--nested-sep\r\n"
        b"Content-Type: application/octet-stream\r\n"
        b'Content-Disposition: attachment; filename="invoice.exe"\r\n'
        b"\r\n"
        b"MZpayload...\r\n"
        b"--nested-sep--\r\n"
    )

    # Parent message: Benign employee forwarding the suspicious email to the security team
    parent_eml = (
        b"From: employee@company.com\r\n"
        b"To: secops@company.com\r\n"
        b"Subject: FW: Potential phishing email received\r\n"
        b"Date: Mon, 1 Jan 2024 11:00:00 +0000\r\n"
        b'Content-Type: multipart/mixed; boundary="parent-sep"\r\n'
        b"\r\n"
        b"--parent-sep\r\n"
        b"Content-Type: text/plain\r\n"
        b"\r\n"
        b"Hi SecOps, forwarding this suspicious email for analysis.\r\n"
        b"--parent-sep\r\n"
        b"Content-Type: message/rfc822\r\n"
        b"\r\n" + nested_eml + b"\r\n--parent-sep--\r\n"
    )

    result = analyze_bytes(
        run_id="run_nested_malicious",
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256=hashlib.sha256(parent_eml).hexdigest(),
        artifact_byte_size=len(parent_eml),
        raw=parent_eml,
        settings=settings,
        now=fixed_time,
    )

    # Nested message observation verified
    assert len(result.nested_messages) == 1
    nested_obs = result.nested_messages[0]
    assert nested_obs.path == "1.2"
    assert nested_obs.depth == 1
    assert nested_obs.verdict in (VerdictValue.MALICIOUS, VerdictValue.SUSPICIOUS)
    assert nested_obs.score.final_score >= 35

    # Parent verdict reflects the nested finding
    assert result.verdict in (VerdictValue.SUSPICIOUS, VerdictValue.MALICIOUS)
    nested_findings = [f for f in result.findings if f.rule_id.startswith("nested.")]
    assert len(nested_findings) >= 1
    assert any("1.2" in f.evidence_refs for f in nested_findings)


def test_benign_forward_of_benign_stays_benign() -> None:
    settings = _test_settings()
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    nested_eml = (
        b"From: colleague@company.com\r\n"
        b"To: employee@company.com\r\n"
        b"Subject: Project Notes\r\n"
        b"Date: Mon, 1 Jan 2024 10:00:00 +0000\r\n"
        b"\r\n"
        b"Here are the notes from our team sync.\r\n"
    )

    parent_eml = (
        b"From: employee@company.com\r\n"
        b"To: manager@company.com\r\n"
        b"Subject: FW: Project Notes\r\n"
        b"Date: Mon, 1 Jan 2024 11:00:00 +0000\r\n"
        b'Content-Type: multipart/mixed; boundary="p-sep"\r\n'
        b"\r\n"
        b"--p-sep\r\n"
        b"Content-Type: text/plain\r\n"
        b"\r\n"
        b"Forwarding project notes.\r\n"
        b"--p-sep\r\n"
        b"Content-Type: message/rfc822\r\n"
        b"\r\n" + nested_eml + b"\r\n--p-sep--\r\n"
    )

    result = analyze_bytes(
        run_id="run_nested_benign",
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256=hashlib.sha256(parent_eml).hexdigest(),
        artifact_byte_size=len(parent_eml),
        raw=parent_eml,
        settings=settings,
        now=fixed_time,
    )

    assert len(result.nested_messages) == 1
    assert result.nested_messages[0].verdict == VerdictValue.BENIGN
    # A benign forward of a benign message stays benign
    assert result.verdict == VerdictValue.BENIGN
    assert result.score.final_score <= 10
    assert not any(f.rule_id == "nested.malicious_forwarded_message" for f in result.findings)


def test_double_nesting_and_depth_cap() -> None:
    settings = _test_settings(max_nested_message_depth=2, max_nested_messages=5)
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    level3 = (
        b"From: deep@example.com\r\nSubject: Level 3\r\nDate: Mon, 1 Jan 2024 09:00:00 +0000\r\n\r\nDeepest message\r\n"
    )

    level2 = (
        b"From: mid@example.com\r\n"
        b"Subject: Level 2\r\n"
        b"Date: Mon, 1 Jan 2024 10:00:00 +0000\r\n"
        b'Content-Type: multipart/mixed; boundary="l2-sep"\r\n'
        b"\r\n"
        b"--l2-sep\r\n"
        b"Content-Type: text/plain\r\n"
        b"\r\n"
        b"Mid level\r\n"
        b"--l2-sep\r\n"
        b"Content-Type: message/rfc822\r\n"
        b"\r\n" + level3 + b"\r\n--l2-sep--\r\n"
    )

    level1 = (
        b"From: top@example.com\r\n"
        b"Subject: Level 1\r\n"
        b"Date: Mon, 1 Jan 2024 11:00:00 +0000\r\n"
        b'Content-Type: multipart/mixed; boundary="l1-sep"\r\n'
        b"\r\n"
        b"--l1-sep\r\n"
        b"Content-Type: text/plain\r\n"
        b"\r\n"
        b"Top level\r\n"
        b"--l1-sep\r\n"
        b"Content-Type: message/rfc822\r\n"
        b"\r\n" + level2 + b"\r\n--l1-sep--\r\n"
    )

    result = analyze_bytes(
        run_id="run_multi_depth",
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256=hashlib.sha256(level1).hexdigest(),
        artifact_byte_size=len(level1),
        raw=level1,
        settings=settings,
        now=fixed_time,
    )

    # With max_nested_message_depth=2, depth 1 and depth 2 are analyzed, but not depth 3
    depths = [msg.depth for msg in result.nested_messages]
    assert depths == [1, 2]
    assert all(d <= 2 for d in depths)

    # Test MAX_NESTED_MESSAGES cap
    settings_cap1 = _test_settings(max_nested_message_depth=5, max_nested_messages=1)
    res_cap1 = analyze_bytes(
        run_id="run_cap1",
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256=hashlib.sha256(level1).hexdigest(),
        artifact_byte_size=len(level1),
        raw=level1,
        settings=settings_cap1,
        now=fixed_time,
    )
    assert len(res_cap1.nested_messages) == 1


def test_nested_message_hostile_headers() -> None:
    settings = _test_settings(max_header_count=100)
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    # Nested message with 200 headers (exceeding configured max_header_count of 100)
    hostile_headers = b"\r\n".join(f"X-Spam-Header-{i}: value-{i}".encode() for i in range(200))
    nested_hostile = (
        b"From: hostile@example.com\r\nSubject: Hostile Headers\r\n" + hostile_headers + b"\r\n\r\nHostile body"
    )

    parent_eml = (
        b"From: forwarder@company.com\r\n"
        b"Subject: Forward of hostile\r\n"
        b'Content-Type: multipart/mixed; boundary="sep"\r\n'
        b"\r\n"
        b"--sep\r\n"
        b"Content-Type: message/rfc822\r\n"
        b"\r\n" + nested_hostile + b"\r\n--sep--\r\n"
    )

    # Must complete safely without raising an unhandled exception or escaping limits
    result = analyze_bytes(
        run_id="run_hostile_nested",
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256=hashlib.sha256(parent_eml).hexdigest(),
        artifact_byte_size=len(parent_eml),
        raw=parent_eml,
        settings=settings,
        now=fixed_time,
    )

    assert len(result.nested_messages) == 1
    nested_obs = result.nested_messages[0]
    # Warning recorded safely
    assert any("header_limit_exceeded" in w for w in nested_obs.parser_warnings)


def test_determinism_and_snapshot_v1_2_0() -> None:
    settings = _test_settings()
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    raw = (
        b"From: sender@example.com\r\n"
        b"To: dest@example.com\r\n"
        b"Subject: Test\r\n"
        b"Date: Mon, 1 Jan 2024 10:00:00 +0000\r\n"
        b"\r\n"
        b"Simple body\r\n"
    )

    res1 = analyze_bytes(
        run_id="run_det_1",
        organization_id="org1",
        case_id="case1",
        artifact_sha256=hashlib.sha256(raw).hexdigest(),
        artifact_byte_size=len(raw),
        raw=raw,
        settings=settings,
        now=fixed_time,
    )
    res2 = analyze_bytes(
        run_id="run_det_1",
        organization_id="org1",
        case_id="case1",
        artifact_sha256=hashlib.sha256(raw).hexdigest(),
        artifact_byte_size=len(raw),
        raw=raw,
        settings=settings,
        now=fixed_time,
    )

    assert res1.schema_version == "1.2.0"
    assert res1.ruleset_version == "v1.2.0"
    assert res1.model_dump() == res2.model_dump()

    # Verify backward compatible deserialization into AnalysisResult
    serialized = res1.model_dump_json()
    deserialized = AnalysisResult.model_validate_json(serialized)
    assert deserialized.nested_messages == []
    assert deserialized.container_suspected is False
