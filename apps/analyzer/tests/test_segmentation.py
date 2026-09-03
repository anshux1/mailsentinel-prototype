"""Tests for Phase P9: Bounded, deterministic container segmentation."""

import hashlib
import socket
from datetime import datetime

import pytest

from app.contracts.models import ContainerFormat
from app.parsing.parser import ParseLimitError, parse_message
from app.segmentation import detect_container, segment


def _assert_no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: object, **kwargs: object) -> None:
        raise RuntimeError("network access forbidden during segmentation")

    monkeypatch.setattr(socket, "socket", forbidden)


def test_mbox_crlf_and_lf_with_escaping(monkeypatch: pytest.MonkeyPatch) -> None:
    _assert_no_network(monkeypatch)

    msg1 = (
        b"From alice@example.com Mon Jan 01 10:00:00 2024\r\n"
        b"From: Alice <alice@example.com>\r\n"
        b"Subject: First Mbox CRLF\r\n"
        b"Date: Mon, 1 Jan 2024 10:00:00 +0000\r\n"
        b"Message-ID: <msg1@example.com>\r\n"
        b"\r\n"
        b">From quoted line in body\r\n"
        b">>From double quoted\r\n"
        b"From: not a separator line\r\n"
        b"\r\n"
    )
    msg2 = (
        b"From bob@example.com Mon Jan 01 11:00:00 2024\r\n"
        b"From: Bob <bob@example.com>\r\n"
        b"Subject: Second Mbox CRLF\r\n"
        b"Date: Mon, 1 Jan 2024 11:00:00 +0000\r\n"
        b"Message-ID: <msg2@example.com>\r\n"
        b"\r\n"
        b"Body of second message\r\n"
    )
    mbox_crlf = msg1 + msg2

    assert detect_container(mbox_crlf) == ContainerFormat.MBOX

    result = segment(mbox_crlf)
    assert result.container_format == ContainerFormat.MBOX
    assert result.message_count == 2
    assert len(result.segments) == 2

    # Verify offset slicing reproducibility
    s0 = result.segments[0]
    assert s0.index == 0
    slice0 = mbox_crlf[s0.byte_offset : s0.byte_offset + s0.byte_length]
    assert hashlib.sha256(slice0).hexdigest() == s0.sha256
    assert s0.summary.from_address == "alice@example.com"
    assert s0.summary.from_display_name == "Alice"
    assert s0.summary.subject == "First Mbox CRLF"
    assert s0.summary.message_id == "<msg1@example.com>"
    assert isinstance(s0.summary.date, datetime)
    assert b">From quoted line in body" in slice0
    assert b"From: not a separator line" in slice0

    s1 = result.segments[1]
    assert s1.index == 1
    slice1 = mbox_crlf[s1.byte_offset : s1.byte_offset + s1.byte_length]
    assert hashlib.sha256(slice1).hexdigest() == s1.sha256
    assert s1.summary.from_address == "bob@example.com"
    assert s1.summary.subject == "Second Mbox CRLF"

    # Test N messages with LF line endings
    n_messages = []
    for i in range(5):
        n_messages.append(
            f"From user{i}@example.com Mon Jan 01 {10 + i:02d}:00:00 2024\n"
            f"From: User {i} <user{i}@example.com>\n"
            f"Subject: Message {i}\n"
            f"Date: Mon, 1 Jan 2024 {10 + i:02d}:00:00 +0000\n"
            f"Message-ID: <user{i}@example.com>\n"
            f"\n"
            f"Body {i}\n"
            f">From preserved in body\n\n".encode()
        )
    mbox_lf = b"".join(n_messages)
    res_lf = segment(mbox_lf)
    assert res_lf.container_format == ContainerFormat.MBOX
    assert res_lf.message_count == 5
    for i, seg in enumerate(res_lf.segments):
        sub_slice = mbox_lf[seg.byte_offset : seg.byte_offset + seg.byte_length]
        assert hashlib.sha256(sub_slice).hexdigest() == seg.sha256
        assert seg.summary.from_address == f"user{i}@example.com"
        assert b">From preserved in body" in sub_slice


def test_bare_concatenation_and_body_from_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    _assert_no_network(monkeypatch)

    # 1. Regression Guard: Message whose body contains a line starting with From:
    single_body_from = (
        b"From: sender@example.com\r\n"
        b"Subject: Notes on From header\r\n"
        b"Date: Mon, 1 Jan 2024 10:00:00 +0000\r\n"
        b"\r\n"
        b"Hello team,\r\n"
        b"\r\n"
        b"From: is a common email header.\r\n"
        b"From: another@example.com is what he wrote.\r\n"
        b"\r\n"
        b"Regards,\r\n"
        b"Sender\r\n"
    )
    assert detect_container(single_body_from) == ContainerFormat.SINGLE
    res_single = segment(single_body_from)
    assert res_single.container_format == ContainerFormat.SINGLE
    assert res_single.message_count == 1
    assert res_single.segments[0].byte_length == len(single_body_from)
    assert res_single.segments[0].sha256 == hashlib.sha256(single_body_from).hexdigest()

    # 2. Genuine Bare Concatenation: Consecutive RFC 5322 messages
    m1 = (
        b"From: user1@example.com\r\n"
        b"To: dest1@example.com\r\n"
        b"Subject: Concat Message 1\r\n"
        b"Date: Mon, 1 Jan 2024 10:00:00 +0000\r\n"
        b"\r\n"
        b"Body of message 1\r\n"
    )
    m2 = (
        b"From: user2@example.com\r\n"
        b"To: dest2@example.com\r\n"
        b"Subject: Concat Message 2\r\n"
        b"Date: Mon, 1 Jan 2024 11:00:00 +0000\r\n"
        b"Message-ID: <concat2@example.com>\r\n"
        b"\r\n"
        b"Body of message 2\r\n"
    )
    m3 = (
        b"From: user3@example.com\r\n"
        b"To: dest3@example.com\r\n"
        b"Subject: Concat Message 3\r\n"
        b"Date: Mon, 1 Jan 2024 12:00:00 +0000\r\n"
        b"Message-ID: <concat3@example.com>\r\n"
        b"\r\n"
        b"Body of message 3\r\n"
    )
    bare_stream = m1 + b"\r\n" + m2 + b"\r\n" + m3

    assert detect_container(bare_stream) == ContainerFormat.BARE_CONCATENATION
    res_bare = segment(bare_stream)
    assert res_bare.container_format == ContainerFormat.BARE_CONCATENATION
    assert res_bare.message_count == 3
    assert len(res_bare.segments) == 3

    for idx, seg in enumerate(res_bare.segments):
        sub_bytes = bare_stream[seg.byte_offset : seg.byte_offset + seg.byte_length]
        assert hashlib.sha256(sub_bytes).hexdigest() == seg.sha256
        assert seg.summary.from_address == f"user{idx + 1}@example.com"
        assert seg.summary.subject == f"Concat Message {idx + 1}"


def test_multipart_digest(monkeypatch: pytest.MonkeyPatch) -> None:
    _assert_no_network(monkeypatch)

    digest_content = (
        b'Content-Type: multipart/digest; boundary="boundary-digest-42"\r\n'
        b"Subject: Daily Digest\r\n"
        b"\r\n"
        b"--boundary-digest-42\r\n"
        b"Content-Type: message/rfc822\r\n"
        b"\r\n"
        b"From: digest-user1@example.com\r\n"
        b"Subject: Article 1\r\n"
        b"Date: Mon, 1 Jan 2024 08:00:00 +0000\r\n"
        b"\r\n"
        b"Content of article 1\r\n"
        b"--boundary-digest-42\r\n"
        b"Content-Type: message/rfc822\r\n"
        b"\r\n"
        b"From: digest-user2@example.com\r\n"
        b"Subject: Article 2\r\n"
        b"Date: Mon, 1 Jan 2024 09:00:00 +0000\r\n"
        b"\r\n"
        b"Content of article 2\r\n"
        b"--boundary-digest-42--\r\n"
    )

    assert detect_container(digest_content) == ContainerFormat.MULTIPART_DIGEST
    res_digest = segment(digest_content)
    assert res_digest.container_format == ContainerFormat.MULTIPART_DIGEST
    assert res_digest.message_count == 2
    assert len(res_digest.segments) == 2

    s0 = res_digest.segments[0]
    b0 = digest_content[s0.byte_offset : s0.byte_offset + s0.byte_length]
    assert hashlib.sha256(b0).hexdigest() == s0.sha256
    assert s0.summary.from_address == "digest-user1@example.com"
    assert s0.summary.subject == "Article 1"

    s1 = res_digest.segments[1]
    b1 = digest_content[s1.byte_offset : s1.byte_offset + s1.byte_length]
    assert hashlib.sha256(b1).hexdigest() == s1.sha256
    assert s1.summary.from_address == "digest-user2@example.com"
    assert s1.summary.subject == "Article 2"


def test_trailing_message_data_warning() -> None:
    # 1. Normal single message has no trailing warning
    clean_msg = b"From: a@b.com\r\nSubject: Hi\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\n\r\nClean body"
    parsed_clean = parse_message(
        clean_msg,
        max_bytes=1_000_000,
        max_parts=50,
        max_depth=10,
        max_headers=100,
        max_attachment_bytes=1_000_000,
    )
    assert not any("trailing_message_data" in w for w in parsed_clean.warnings)

    # 2. Single multipart message followed by trailing junk raises trailing_message_data
    multipart_with_trailing = (
        b'Content-Type: multipart/mixed; boundary="test-sep"\r\n'
        b"From: normal@example.com\r\n"
        b"\r\n"
        b"--test-sep\r\n"
        b"Content-Type: text/plain\r\n"
        b"\r\n"
        b"Hello world\r\n"
        b"--test-sep--\r\n"
        b"TRAILING UNPARSED JUNK OR APPENDED MESSAGE DATA"
    )
    parsed_trailing = parse_message(
        multipart_with_trailing,
        max_bytes=1_000_000,
        max_parts=50,
        max_depth=10,
        max_headers=100,
        max_attachment_bytes=1_000_000,
    )
    assert any("trailing_message_data" in w for w in parsed_trailing.warnings)


def test_adversarial_bounds_and_determinism(monkeypatch: pytest.MonkeyPatch) -> None:
    _assert_no_network(monkeypatch)

    # 1. Bounded refusal on 100k tiny messages
    tiny_stream = b"From a@b Mon Jan 1 00:00:00 2024\n\n" * 1000
    with pytest.raises(ParseLimitError) as exc_info:
        segment(tiny_stream, max_container_messages=100)
    assert exc_info.value.code == "container_limit_exceeded"

    # 2. Oversized container byte bound
    large_container = b"From a@b Mon Jan 1 00:00:00 2024\n\n" * 10
    with pytest.raises(ParseLimitError) as exc_info:
        segment(large_container, max_container_bytes=50)
    assert exc_info.value.code == "container_too_large"

    # 3. Single oversized message bound
    msg_oversized = b"From a@b Mon Jan 1 00:00:00 2024\nFrom: a@b.com\nSubject: Huge\n\n" + (b"A" * 1000)
    with pytest.raises(ParseLimitError) as exc_info:
        segment(msg_oversized, max_eml_bytes=500)
    assert exc_info.value.code == "evidence_too_large"

    # 4. Null bytes and malformed input handling
    null_bytes_input = b"From user@test.com Mon Jan 1 00:00:00 2024\r\n\x00\x00\x00\r\n"
    res_null = segment(null_bytes_input)
    assert res_null.message_count == 1
    assert res_null.segments[0].byte_length == len(null_bytes_input)

    # 5. Determinism: Identical input yields identical output
    res1 = segment(null_bytes_input)
    res2 = segment(null_bytes_input)
    assert res1.model_dump() == res2.model_dump()
