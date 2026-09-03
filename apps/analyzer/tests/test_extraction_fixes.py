import socket
from datetime import UTC, datetime

import pytest

from app.extraction.extract import (
    _domain,
    _normalize_url,
    _safe_ip,
    extract_addresses,
    extract_indicators,
    extract_mime_parts,
    extract_received,
)
from app.parsing.parser import ParsedMessage, ParsedPart


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure no network calls are made during extraction."""

    def _fail_socket(*args: object, **kwargs: object) -> None:
        raise RuntimeError("Unexpected network access attempt in extraction")

    monkeypatch.setattr(socket, "socket", _fail_socket)
    monkeypatch.setattr(socket, "getaddrinfo", _fail_socket)
    monkeypatch.setattr(socket, "gethostbyname", _fail_socket)


def test_html_href_and_src_extracted_before_tag_stripping() -> None:
    html = """
    <html>
      <body>
        <p>Please review your invoice: <a href="https://hidden-phish.example/login">Click Here</a></p>
        <img src="https://tracker.example/pixel.gif" alt="logo" />
        <a href='https://single-quote.example/path'>Single</a>
        <a href=https://unquoted.example/path>Unquoted</a>
        <a href="  https://padded.example/path  ">Padded</a>
        <a href="https://entity.example/test?a=1&amp;b=2">Entity</a>
        <a href="https://phish.example/a">Visit https://legit.example/b</a>
      </body>
    </html>
    """
    message = ParsedMessage(plain_text="", html_text=html)
    indicators = extract_indicators(message, max_urls=50)
    urls = [ind.normalized_value for ind in indicators if ind.kind == "url"]

    # All href and src URLs must be extracted even though HTML tags were stripped
    assert "https://hidden-phish.example/login" in urls
    assert "https://tracker.example/pixel.gif" in urls
    assert "https://single-quote.example/path" in urls
    assert "https://unquoted.example/path" in urls
    assert "https://padded.example/path" in urls
    assert "https://entity.example/test?a=1&b=2" in urls
    # Both the href target and the link text URL should be extracted
    assert "https://phish.example/a" in urls
    assert "https://legit.example/b" in urls


def test_html_extraction_ordering_and_max_urls_limit() -> None:
    html = """
    <a href="https://first.example/1">One</a>
    <a href="https://second.example/2">Two</a>
    <a href="https://third.example/3">Three</a>
    """
    message = ParsedMessage(plain_text="Visit https://fourth.example/4", html_text=html)
    # With max_urls=2, only first 2 unique URLs in order should be returned
    indicators = extract_indicators(message, max_urls=2)
    urls = [ind.normalized_value for ind in indicators if ind.kind == "url"]
    assert urls == ["https://first.example/1", "https://second.example/2"]


def test_url_userinfo_prevents_credential_leakage_and_retains_metadata() -> None:
    raw_url = "https://admin:SuperSecretPassword123!@evil.example/login?token=abc"
    res = _normalize_url(raw_url)
    assert res is not None
    safe_val, normalized, has_userinfo = res

    # Credentials must NEVER leak into normalized_value
    assert "SuperSecretPassword123!" not in normalized
    assert "admin" not in normalized
    assert "@" not in normalized
    assert normalized == "https://evil.example/login?token=abc"

    # Password must be redacted in display value
    assert "SuperSecretPassword123!" not in safe_val
    assert safe_val == "https://admin:***@evil.example/login?token=abc"
    assert has_userinfo is True

    # When extracted from message, metadata indicates userinfo
    message = ParsedMessage(plain_text=raw_url, html_text="")
    indicators = extract_indicators(message, max_urls=10)
    url_ind = next(ind for ind in indicators if ind.kind == "url")
    assert url_ind.normalized_value == "https://evil.example/login?token=abc"
    assert "SuperSecretPassword123!" not in url_ind.value
    assert "userinfo" in url_ind.source


def test_url_userinfo_without_password_redacted_to_prevent_token_leakage() -> None:
    token_url = "https://SECRET_API_TOKEN_12345@evil.example/webhook"
    res = _normalize_url(token_url)
    assert res is not None
    safe_val, normalized, has_userinfo = res
    assert "SECRET_API_TOKEN_12345" not in normalized
    assert "SECRET_API_TOKEN_12345" not in safe_val
    assert safe_val == "https://***@evil.example/webhook"
    assert has_userinfo is True


def test_safe_ip_and_local_ipv6_classification() -> None:
    cases: list[tuple[str, str, bool]] = [
        # IPv4
        ("127.0.0.1", "127.0.0.1", True),
        ("10.0.0.1", "10.0.0.1", True),
        ("172.16.0.1", "172.16.0.1", True),
        ("192.168.1.1", "192.168.1.1", True),
        ("169.254.1.1", "169.254.1.1", True),
        ("224.0.0.1", "224.0.0.1", True),
        ("255.255.255.255", "255.255.255.255", True),
        ("8.8.8.8", "8.8.8.8", False),
        ("1.1.1.1", "1.1.1.1", False),
        # IPv6
        ("::1", "::1", True),
        ("fe80::1", "fe80::1", True),
        ("fc00::1", "fc00::1", True),
        ("fd12:3456:789a::1", "fd12:3456:789a::1", True),
        ("2001:db8::1", "2001:db8::1", True),
        ("ff02::1", "ff02::1", True),
        ("::", "::", True),
        ("2607:f8b0:4005:809::200e", "2607:f8b0:4005:809::200e", False),
        # Bracketed and IPv6-prefixed
        ("[::1]", "::1", True),
        ("[IPv6:2001:db8::1]", "2001:db8::1", True),
        # IPv4-mapped IPv6
        ("::ffff:127.0.0.1", "::ffff:127.0.0.1", True),
        ("::ffff:192.168.1.1", "::ffff:192.168.1.1", True),
        ("::ffff:8.8.8.8", "::ffff:8.8.8.8", False),
    ]
    for raw_ip, expected_ip, expected_private in cases:
        result = _safe_ip(raw_ip)
        assert result is not None, f"Failed parsing {raw_ip}"
        parsed_ip, is_private = result
        assert parsed_ip == expected_ip
        assert is_private == expected_private, f"Failed privacy flag for {raw_ip}"


def test_ipv6_url_safe_normalization() -> None:
    # IPv6 URL should retain brackets in host/netloc
    res = _normalize_url("http://[2001:db8::1]:8080/index.html")
    assert res is not None
    _, normalized, _ = res
    assert normalized == "http://[2001:db8::1]:8080/index.html"

    # Default port 80 stripped
    res2 = _normalize_url("http://[2001:db8::1]:80/index.html")
    assert res2 is not None
    _, normalized2, _ = res2
    assert normalized2 == "http://[2001:db8::1]/index.html"


def test_received_hops_extract_ipv6_and_handle_mixed_timestamps() -> None:
    message = ParsedMessage()
    message.headers = [
        (
            "Received",
            "from mail.example ([2001:db8::1]) by mx.example; Wed, 01 Jan 2026 00:00:00 +0000",
        ),
        (
            "Received",
            "from relay.example ([IPv6:fe80::1]) by mail.example; 01 Jan 2026 00:01:00",
        ),
        (
            "Received",
            "from sender.example (192.168.1.1) by relay.example; Wed, 01 Jan 2026 02:00:00 +0200",
        ),
        (
            "Received",
            "from client.example by sender.example; invalid-timestamp-here",
        ),
    ]

    hops = extract_received(message)
    assert len(hops) == 4

    # Hop 1: IPv6 bracketed
    assert hops[0].source_ip == "2001:db8::1"
    assert hops[0].private_source is True
    assert hops[0].timestamp == datetime(2026, 1, 1, 0, 0, tzinfo=UTC)

    # Hop 2: IPv6 with IPv6: prefix and naive timestamp normalized to UTC
    assert hops[1].source_ip == "fe80::1"
    assert hops[1].private_source is True
    assert hops[1].timestamp == datetime(2026, 1, 1, 0, 1, tzinfo=UTC)
    assert hops[1].timestamp.tzinfo is not None

    # Hop 3: IPv4 private, non-UTC offset normalized to UTC
    assert hops[2].source_ip == "192.168.1.1"
    assert hops[2].private_source is True
    assert hops[2].timestamp == datetime(2026, 1, 1, 0, 0, tzinfo=UTC)

    # Hop 4: Invalid timestamp is gracefully None without crashing
    assert hops[3].timestamp is None


def test_extract_addresses_and_domain() -> None:
    message = ParsedMessage()
    message.headers = [
        ("From", "Alice <alice@sender.example>"),
        ("Sender", "Agent <agent@agent.example>"),
        ("Reply-To", "help@reply.example"),
        ("Return-Path", "<bounce@bounce.example>"),
        ("To", "Bob <bob@recipient.example>"),
        ("Cc", "Charlie <charlie@cc.example>"),
    ]
    addresses = extract_addresses(message)
    sources = {a.source: a.domain for a in addresses}
    assert sources["from"] == "sender.example"
    assert sources["sender"] == "agent.example"
    assert sources["reply-to"] == "reply.example"
    assert sources["return-path"] == "bounce.example"
    assert sources["to"] == "recipient.example"
    assert sources["cc"] == "cc.example"
    assert _domain("invalid") is None
    assert _domain("foo@bar.com") == "bar.com"


def test_extract_mime_parts_sanitizes_filenames() -> None:
    message = ParsedMessage()
    message.parts = [
        ParsedPart(
            part_id="1",
            content_type="application/octet-stream",
            disposition="attachment",
            filename="../../malicious.exe",
            payload=b"payload",
            is_attachment=True,
        ),
        ParsedPart(
            part_id="2",
            content_type="text/plain",
            disposition=None,
            filename=None,
            payload=b"text",
            is_attachment=False,
        ),
    ]
    observations = extract_mime_parts(message)
    assert len(observations) == 2
    assert observations[0].filename == "malicious.exe"
    assert observations[0].dangerous_extension is True


def test_indicators_bounded_under_url_derived_domain_ip_email_combinations() -> None:
    from app.contracts.models import MAX_INDICATORS, AnalysisResult, ScoreBreakdown, VerdictValue

    # Generate 600 unique URLs with distinct domains, 600 IPs, and 100 emails
    urls = [f"https://host-{i}.example.org/path/{i}" for i in range(600)]
    ips = [f"198.51.100.{(i % 250) + 1}" for i in range(600)]
    emails = [f"alert-{i}@sender-{i}.example.com" for i in range(100)]

    body = "\n".join(urls + ips + emails)
    message = ParsedMessage(plain_text=body, html_text="")

    # Even with max_urls=500 (or default), 500 URLs + 500 domains + 500 IPs + 100 emails = 1600
    indicators = extract_indicators(message, max_urls=500)

    # Must NOT produce more indicators than contract collection max (1000)
    assert len(indicators) <= MAX_INDICATORS
    assert len(indicators) == MAX_INDICATORS

    # Must validate cleanly into AnalysisResult without ValidationError
    result = AnalysisResult(
        analysis_version="prototype-1",
        analysis_run_id="run_bound_test",
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256="a" * 64,
        artifact_byte_size=len(body.encode()),
        indicators=indicators,
        score=ScoreBreakdown(base_score=0, contributions=[], final_score=0),
        verdict=VerdictValue.BENIGN,
        confidence=0.5,
        analyzed_at=datetime.now(UTC),
    )
    assert len(result.indicators) == MAX_INDICATORS

    # Verify deterministic ordering: URLs and their derived domains appear first in order
    assert indicators[0].kind == "url"
    assert indicators[0].normalized_value == "https://host-0.example.org/path/0"
    assert indicators[1].kind == "domain"
    assert indicators[1].normalized_value == "host-0.example.org"
    assert indicators[2].kind == "url"
    assert indicators[2].normalized_value == "https://host-1.example.org/path/1"
    assert indicators[3].kind == "domain"
    assert indicators[3].normalized_value == "host-1.example.org"


def test_valid_bounded_message_with_many_indicators_validates_analysis_result() -> None:
    from app.analysis import analyze_bytes
    from app.contracts.models import MAX_INDICATORS
    from app.core.settings import Settings

    # Build a valid message with > 500 URLs, IPs, and emails
    urls = [f"https://domain-{i}.example.net/page/{i}" for i in range(600)]
    ips = [f"203.0.113.{(i % 250) + 1}" for i in range(200)]
    emails = [f"contact-{i}@mail-{i}.example.org" for i in range(50)]
    raw = (
        b"From: sender@example.com\r\n"
        b"To: recipient@example.com\r\n"
        b"Subject: High Volume Indicators\r\n"
        b"Content-Type: text/plain\r\n\r\n" + "\n".join(urls + ips + emails).encode("ascii")
    )

    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        app_env="test",
        database_url="postgresql://user:pass@localhost:5432/db",  # type: ignore[arg-type]
        s3_access_key_id="test-key",
        s3_secret_access_key="test-secret-key-16chars",  # type: ignore[arg-type]
        analyzer_service_token="test-token-16chars-minimum",  # type: ignore[arg-type]
        max_urls=500,
    )

    # analyze_bytes must succeed without AnalysisResult validation failure
    analysis_result = analyze_bytes(
        run_id="run_high_volume",
        organization_id="org_test",
        case_id="case_test",
        artifact_sha256="b" * 64,
        artifact_byte_size=len(raw),
        raw=raw,
        settings=settings,
    )
    assert len(analysis_result.indicators) <= MAX_INDICATORS
    assert len(analysis_result.enrichment) <= MAX_INDICATORS
    assert analysis_result.analysis_run_id == "run_high_volume"


def test_extract_indicators_max_urls_edge_cases() -> None:
    from app.contracts.models import MAX_INDICATORS

    text = "Visit https://site.example/1 and https://site.example/2 and contact info@site.example 192.168.1.1"
    message = ParsedMessage(plain_text=text, html_text="")

    # max_urls <= 0: no URLs or IPs, but emails still allowed up to limit
    inds_zero = extract_indicators(message, max_urls=0)
    assert not any(i.kind in ("url", "ip") for i in inds_zero)
    assert any(i.kind == "domain" and i.source == "email" for i in inds_zero)

    # max_urls negative: safely treated as 0
    inds_neg = extract_indicators(message, max_urls=-10)
    assert not any(i.kind in ("url", "ip") for i in inds_neg)

    # max_urls=1: exactly 1 URL returned
    inds_one = extract_indicators(message, max_urls=1)
    urls = [i for i in inds_one if i.kind == "url"]
    assert len(urls) == 1
    assert urls[0].normalized_value == "https://site.example/1"

    # max_urls exceeding MAX_INDICATORS is clamped
    huge_message = ParsedMessage(
        plain_text="\n".join(f"https://s{i}.example/a" for i in range(1200)),
        html_text="",
    )
    inds_clamped = extract_indicators(huge_message, max_urls=5000)
    assert len(inds_clamped) == MAX_INDICATORS


def test_all_extraction_helpers_enforce_contract_bounds() -> None:
    from app.contracts.models import (
        MAX_ADDRESSES,
        MAX_AUTHENTICATION,
        MAX_HEADERS,
        MAX_MIME_PARTS,
        MAX_RECEIVED_HOPS,
    )
    from app.extraction.extract import extract_authentication, extract_headers

    # Addresses bound
    msg_addr = ParsedMessage()
    msg_addr.headers = [("To", f"user{i} <u{i}@example.com>") for i in range(150)]
    addresses = extract_addresses(msg_addr)
    assert len(addresses) == MAX_ADDRESSES

    # Headers bound
    msg_hdr = ParsedMessage()
    msg_hdr.headers = [(f"X-Header-{i}", f"val-{i}") for i in range(1500)]
    headers = extract_headers(msg_hdr)
    assert len(headers) == MAX_HEADERS

    # Authentication bound
    msg_auth = ParsedMessage()
    msg_auth.headers = [("Authentication-Results", "mx.example; spf=pass; dkim=pass") for _ in range(150)]
    auth = extract_authentication(msg_auth)
    assert len(auth) == MAX_AUTHENTICATION

    # Received bound
    msg_rec = ParsedMessage()
    msg_rec.headers = [("Received", f"from mail{i}.example by mx.example") for i in range(250)]
    hops = extract_received(msg_rec)
    assert len(hops) == MAX_RECEIVED_HOPS

    # Mime parts bound
    msg_mime = ParsedMessage()
    msg_mime.parts = [
        ParsedPart(
            part_id=str(i),
            content_type="text/plain",
            disposition=None,
            filename=None,
            payload=b"hi",
            is_attachment=False,
        )
        for i in range(250)
    ]
    parts = extract_mime_parts(msg_mime)
    assert len(parts) == MAX_MIME_PARTS
