import socket

import pytest

from app.parsing.parser import ParsedPart, ParseLimitError, parse_message, sanitize_filename


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure no network calls are ever made by the analyzer parser."""

    def _fail_socket(*args: object, **kwargs: object) -> None:
        raise RuntimeError("Unexpected network access attempt in offline parser")

    monkeypatch.setattr(socket, "socket", _fail_socket)
    monkeypatch.setattr(socket, "getaddrinfo", _fail_socket)
    monkeypatch.setattr(socket, "gethostbyname", _fail_socket)


def test_empty_or_whitespace_message_rejected() -> None:
    for raw in [b"", b"   \r\n\t  ", b"\x00\x00\x00"]:
        with pytest.raises(ParseLimitError, match="message is empty|no readable structure"):
            parse_message(
                raw,
                max_bytes=1000,
                max_parts=10,
                max_depth=5,
                max_headers=10,
                max_attachment_bytes=1000,
            )


def test_evidence_size_limit_enforced() -> None:
    raw = b"From: a@b.com\n\nBody"
    with pytest.raises(ParseLimitError, match="message exceeds configured size limit") as exc:
        parse_message(
            raw,
            max_bytes=len(raw) - 1,
            max_parts=10,
            max_depth=5,
            max_headers=10,
            max_attachment_bytes=1000,
        )
    assert exc.value.code == "evidence_too_large"


def test_header_count_limit_enforced() -> None:
    headers = b"".join(f"X-Header-{i}: value\n".encode() for i in range(15))
    raw = headers + b"\nBody"
    with pytest.raises(ParseLimitError, match="message contains too many headers") as exc:
        parse_message(
            raw,
            max_bytes=100_000,
            max_parts=10,
            max_depth=5,
            max_headers=10,
            max_attachment_bytes=1000,
        )
    assert exc.value.code == "header_limit_exceeded"


def test_header_value_limit_enforced() -> None:
    long_value = b"A" * 15_000
    raw = b"X-Big-Header: " + long_value + b"\n\nBody"
    with pytest.raises(ParseLimitError, match="header value exceeds maximum length") as exc:
        parse_message(
            raw,
            max_bytes=100_000,
            max_parts=10,
            max_depth=5,
            max_headers=10,
            max_attachment_bytes=1000,
            max_header_value_bytes=10_000,
        )
    assert exc.value.code == "header_limit_exceeded"


def test_mime_nesting_depth_limit_enforced() -> None:
    body = b"deep content"
    for i in range(10):
        body = (
            (f'Content-Type: multipart/mixed; boundary="b{i}"\n\n--b{i}\n').encode() + body + f"\n--b{i}--\n".encode()
        )

    with pytest.raises(ParseLimitError, match="MIME nesting exceeds configured limit") as exc:
        parse_message(
            body,
            max_bytes=100_000,
            max_parts=100,
            max_depth=3,
            max_headers=50,
            max_attachment_bytes=1000,
        )
    assert exc.value.code == "mime_limit_exceeded"


def test_mime_parts_count_limit_enforced() -> None:
    parts = [b"--boundary123\nContent-Type: text/plain\n\npart" for _ in range(12)]
    raw = b'Content-Type: multipart/mixed; boundary="boundary123"\n\n' + b"\n".join(parts) + b"\n--boundary123--\n"
    with pytest.raises(ParseLimitError, match="message contains too many MIME parts") as exc:
        parse_message(
            raw,
            max_bytes=100_000,
            max_parts=5,
            max_depth=10,
            max_headers=50,
            max_attachment_bytes=1000,
        )
    assert exc.value.code == "mime_limit_exceeded"


def test_attachment_bytes_limit_enforced() -> None:
    attachment_payload = b"X" * 2000
    raw = (
        b'Content-Type: multipart/mixed; boundary="b1"\n\n'
        b"--b1\n"
        b"Content-Type: application/octet-stream\n"
        b'Content-Disposition: attachment; filename="large.dat"\n\n' + attachment_payload + b"\n--b1--\n"
    )
    with pytest.raises(ParseLimitError, match="attachments exceed configured size limit") as exc:
        parse_message(
            raw,
            max_bytes=100_000,
            max_parts=10,
            max_depth=5,
            max_headers=10,
            max_attachment_bytes=1000,
        )
    assert exc.value.code == "attachment_limit_exceeded"


def test_non_attachment_payload_limit_enforced() -> None:
    big_body = b"A" * 2000
    raw = b"Content-Type: text/plain\n\n" + big_body
    with pytest.raises(
        ParseLimitError,
        match="decoded non-attachment payload exceeds configured limit|decoded text exceeds configured limit",
    ) as exc:
        parse_message(
            raw,
            max_bytes=100_000,
            max_parts=10,
            max_depth=5,
            max_headers=10,
            max_attachment_bytes=10_000,
            max_non_attachment_bytes=1000,
        )
    assert exc.value.code == "mime_limit_exceeded"


def test_filename_path_traversal_sanitization() -> None:
    cases = [
        ("../../etc/passwd", "passwd", True),
        ("..\\..\\Windows\\System32\\cmd.exe", "cmd.exe", True),
        ("/var/log/malware.exe", "malware.exe", True),
        ("C:\\Program Files\\evil.dll", "evil.dll", True),
        ("foo/\x00/bar.js", "bar.js", True),
        ("..", None, True),
        ("/", None, True),
        ("normal_document.pdf", "normal_document.pdf", False),
    ]
    for raw_name, expected, had_traversal in cases:
        sanitized, traversal_detected = sanitize_filename(raw_name)
        assert sanitized == expected, f"Failed for {raw_name}: got {sanitized}, expected {expected}"
        assert traversal_detected == had_traversal, f"Failed traversal flag for {raw_name}"


def test_parser_normalizes_attachment_path_traversal_with_warning() -> None:
    raw = (
        b'Content-Type: multipart/mixed; boundary="b"\n\n'
        b"--b\n"
        b"Content-Type: application/octet-stream\n"
        b'Content-Disposition: attachment; filename="../../boot.ini"\n\n'
        b"data\n"
        b"--b--\n"
    )
    parsed = parse_message(
        raw,
        max_bytes=100_000,
        max_parts=10,
        max_depth=5,
        max_headers=10,
        max_attachment_bytes=10_000,
    )
    assert len(parsed.parts) == 1
    assert parsed.parts[0].filename == "boot.ini"
    assert any("path_traversal_filename" in w for w in parsed.warnings)


def test_malformed_encoding_recorded_as_warning() -> None:
    raw = b"Content-Type: text/plain; charset=nonexistent-encoding-999\n\nHello malformed charset\n"
    parsed = parse_message(
        raw,
        max_bytes=100_000,
        max_parts=10,
        max_depth=5,
        max_headers=10,
        max_attachment_bytes=10_000,
    )
    assert "Hello malformed charset" in parsed.plain_text
    assert any("malformed_encoding" in w for w in parsed.warnings)


def test_malformed_base64_recorded_as_warning() -> None:
    raw = b"Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n???NotValidBase64???\n"
    parsed = parse_message(
        raw,
        max_bytes=100_000,
        max_parts=10,
        max_depth=5,
        max_headers=10,
        max_attachment_bytes=10_000,
    )
    assert any("InvalidBase64" in w or "malformed" in w for w in parsed.warnings)


def test_parsed_part_digest_is_deterministic() -> None:
    part1 = ParsedPart("1", "text/plain", None, "file.txt", b"payload123", False)
    part2 = ParsedPart("1", "text/plain", None, "file.txt", b"payload123", False)
    assert part1.digest == part2.digest
    assert len(part1.digest) == 64
