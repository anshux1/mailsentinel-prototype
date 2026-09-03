"""Bounded, deterministic container segmentation for mbox, bare concatenation, and multipart/digest.

Per RFC 4155, RFC 5322, RFC 2046. Zero network access, authoritative byte slicing.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from email import policy
from email.parser import BytesHeaderParser
from email.utils import parseaddr, parsedate_to_datetime

from app.contracts.models import (
    ContainerFormat,
    ContainerMessageSummary,
    ContainerSegment,
    SegmentationResult,
    validate_hop_timestamp,
)
from app.parsing.parser import ParseLimitError

_STANDARD_HEADERS = {
    "date",
    "subject",
    "to",
    "message-id",
    "received",
    "mime-version",
    "content-type",
    "cc",
    "bcc",
    "reply-to",
    "return-path",
    "delivered-to",
    "dkim-signature",
}

_MBOX_FROM_RE = re.compile(rb"(?:^|\r?\n)From ")
_HEADER_FIELD_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def extract_safe_summary(message_bytes: bytes) -> ContainerMessageSummary:
    """Extract bounded safe summary from message headers without reading message bodies."""
    # Read only the header portion up to the first blank line
    blank_m = re.search(rb"\r?\n\r?\n", message_bytes[:100_000])
    header_bytes = message_bytes[: blank_m.start()] if blank_m else message_bytes[:100_000]

    try:
        msg = BytesHeaderParser(policy=policy.default).parsebytes(header_bytes)
    except Exception:
        return ContainerMessageSummary()

    from_addr: str | None = None
    from_name: str | None = None
    from_header = msg.get("From")
    if from_header:
        try:
            display_name, addr = parseaddr(str(from_header))
            from_addr = addr[:320] if addr else None
            from_name = display_name[:320] if display_name else None
        except Exception:
            pass

    subject: str | None = None
    raw_subj = msg.get("Subject")
    if raw_subj is not None:
        subject = str(raw_subj).strip()[:500] or None

    date_val: datetime | None = None
    raw_date = msg.get("Date")
    if raw_date:
        try:
            parsed_dt = parsedate_to_datetime(str(raw_date))
            if parsed_dt.tzinfo is None or parsed_dt.utcoffset() is None:
                parsed_dt = parsed_dt.replace(tzinfo=UTC)
            date_val = validate_hop_timestamp(parsed_dt)
        except Exception:
            date_val = None

    msg_id: str | None = None
    raw_id = msg.get("Message-ID")
    if raw_id is not None:
        clean_id = str(raw_id).strip()[:500]
        msg_id = clean_id or None

    return ContainerMessageSummary(
        from_address=from_addr,
        from_display_name=from_name,
        subject=subject,
        date=date_val,
        message_id=msg_id,
    )


def find_bare_boundaries(raw: bytes, max_messages: int = 500) -> list[int]:
    """Identify top-level message boundaries in bare concatenated RFC 5322 streams."""
    first_blank = re.search(rb"\r?\n\r?\n", raw)
    if not first_blank:
        return [0]

    first_header_bytes = raw[: first_blank.start()]
    # If the first message is multipart, candidate top-level messages can only appear
    # AFTER the final closing boundary (--boundary--)
    boundary_m = re.search(
        rb"""(?i)content-type:\s*multipart/[^;]+;[^\r\n]*boundary=["']?([^"'\s;\r\n]+)""",
        first_header_bytes,
    )

    search_start = first_blank.end()
    if boundary_m:
        boundary_str = boundary_m.group(1)
        close_delim = rb"--" + re.escape(boundary_str) + rb"--"
        close_m = re.search(close_delim, raw)
        if close_m:
            search_start = close_m.end()

    boundaries = [0]
    pattern = re.compile(rb"(?:\r?\n\r?\n)([A-Za-z0-9_-]+:[ \t][^\r\n]*)")
    blank_pattern = re.compile(rb"\r?\n\r?\n")

    # Search the original buffer with absolute positions. Repeatedly slicing the
    # remaining suffix made adversarial input quadratic in both time and memory.
    for m in pattern.finditer(raw, search_start):
        candidate_start = m.start(1)
        term_blank = blank_pattern.search(raw, candidate_start)
        if not term_blank:
            break

        header_block = raw[candidate_start : term_blank.start()]
        lines = header_block.splitlines()

        valid = True
        found_from = False
        other_headers: set[str] = set()

        for line in lines:
            if not line:
                continue
            if line.startswith((b" ", b"\t")):
                # Valid RFC 5322 folded header line
                continue
            colon_idx = line.find(b":")
            if colon_idx == -1:
                valid = False
                break
            h_name = line[:colon_idx].decode("ascii", "ignore").strip().lower()
            if not _HEADER_FIELD_RE.match(h_name):
                valid = False
                break
            if h_name in ("from", "sender"):
                found_from = True
            elif h_name in _STANDARD_HEADERS:
                other_headers.add(h_name)

        if valid and found_from and len(other_headers) >= 2:
            boundaries.append(candidate_start)
            if len(boundaries) > max_messages:
                return boundaries

    return boundaries


def detect_container(raw: bytes) -> ContainerFormat:
    """Detect whether input is mbox, multipart/digest, bare concatenation, or single."""
    if not raw:
        return ContainerFormat.SINGLE

    # 1. mbox per RFC 4155 starts with "From "
    clean_prefix = raw[3:] if raw.startswith(b"\xef\xbb\xbf") else raw
    if clean_prefix.startswith(b"From "):
        return ContainerFormat.MBOX

    # 2. Check top-level headers for multipart/digest
    blank_m = re.search(rb"\r?\n\r?\n", raw[:10_000])
    top_headers = raw[: blank_m.start()] if blank_m else raw[:10_000]
    if re.search(rb"(?i)^content-type:\s*multipart/digest", top_headers, re.MULTILINE):
        return ContainerFormat.MULTIPART_DIGEST

    # 3. Bare concatenation
    boundaries = find_bare_boundaries(raw, max_messages=2)
    if len(boundaries) > 1:
        return ContainerFormat.BARE_CONCATENATION

    return ContainerFormat.SINGLE


def segment(
    raw: bytes,
    *,
    max_container_bytes: int = 104_857_600,
    max_container_messages: int = 500,
    max_eml_bytes: int = 26_214_400,
) -> SegmentationResult:
    """Segment a container into bounded, deterministic message slices.

    Zero network access. Offsets are strictly authoritative: slicing original bytes
    by [byte_offset, byte_offset + byte_length) reproduces the reported sha256.
    """
    if not raw or not raw.strip(b"\x00 \t\r\n"):
        raise ParseLimitError("message_invalid", "container is empty")

    if len(raw) > max_container_bytes:
        raise ParseLimitError(
            "container_too_large",
            f"container byte size ({len(raw)}) exceeds maximum allowed ({max_container_bytes})",
        )

    fmt = detect_container(raw)

    segments: list[ContainerSegment] = []

    if fmt == ContainerFormat.MBOX:
        clean_prefix = raw[3:] if raw.startswith(b"\xef\xbb\xbf") else raw
        bom_offset = 3 if raw.startswith(b"\xef\xbb\xbf") else 0

        offsets: list[int] = []
        if clean_prefix.startswith(b"From "):
            offsets.append(bom_offset)

        # Subsequent From separators preceded by a newline
        for m in re.finditer(rb"(?:\r?\n)From ", raw):
            from_start = m.end() - 5
            if not offsets or from_start != offsets[0]:
                offsets.append(from_start)
                if len(offsets) > max_container_messages:
                    raise ParseLimitError(
                        "container_limit_exceeded",
                        f"container exceeds maximum message count of {max_container_messages}",
                    )

        for i, start in enumerate(offsets):
            end = offsets[i + 1] if i + 1 < len(offsets) else len(raw)
            length = end - start
            if length > max_eml_bytes:
                raise ParseLimitError(
                    "evidence_too_large",
                    f"message at index {i} exceeds maximum allowed size ({max_eml_bytes})",
                )
            slice_bytes = raw[start:end]
            sha = hashlib.sha256(slice_bytes).hexdigest()
            summary = extract_safe_summary(slice_bytes)
            segments.append(
                ContainerSegment(
                    index=i,
                    byte_offset=start,
                    byte_length=length,
                    sha256=sha,
                    summary=summary,
                )
            )

    elif fmt == ContainerFormat.MULTIPART_DIGEST:
        first_blank = re.search(rb"\r?\n\r?\n", raw[:100_000])
        top_headers = raw[: first_blank.start()] if first_blank else raw[:100_000]
        try:
            parsed_headers = BytesHeaderParser(policy=policy.default).parsebytes(top_headers + b"\r\n\r\n")
            boundary_value = parsed_headers.get_boundary()
        except Exception:
            boundary_value = None

        if not boundary_value or len(boundary_value) > 200:
            fmt = ContainerFormat.SINGLE
        else:
            boundary = boundary_value.encode("ascii", "strict")
            delim = rb"--" + boundary
            pattern = re.compile(rb"(?:^|\r?\n)" + re.escape(delim) + rb"(--)?([ \t]*\r?\n)?")
            match_iter = pattern.finditer(raw)
            m_curr = next(match_iter, None)
            for m_next in match_iter:
                if m_curr is None or m_curr.group(1) == rb"--":
                    break

                part_start = m_curr.end()
                part_end = m_next.start()
                part_raw = raw[part_start:part_end]
                if part_raw.endswith(rb"\r\n"):
                    part_end -= 2
                elif part_raw.endswith(rb"\n"):
                    part_end -= 1

                part_content = raw[part_start:part_end]
                blank_m = re.search(rb"\r?\n\r?\n", part_content[:4000])
                msg_start = part_start
                if blank_m:
                    header_candidate = part_content[: blank_m.start()]
                    if re.search(rb"(?i)\bcontent-type\s*:", header_candidate) or len(header_candidate.strip()) == 0:
                        msg_start = part_start + blank_m.end()

                msg_length = part_end - msg_start
                if msg_length <= 0:
                    continue

                if len(segments) >= max_container_messages:
                    raise ParseLimitError(
                        "container_limit_exceeded",
                        f"container exceeds maximum message count of {max_container_messages}",
                    )
                if msg_length > max_eml_bytes:
                    raise ParseLimitError(
                        "evidence_too_large",
                        f"message at index {len(segments)} exceeds maximum allowed size ({max_eml_bytes})",
                    )

                slice_bytes = raw[msg_start:part_end]
                sha = hashlib.sha256(slice_bytes).hexdigest()
                summary = extract_safe_summary(slice_bytes)
                segments.append(
                    ContainerSegment(
                        index=len(segments),
                        byte_offset=msg_start,
                        byte_length=msg_length,
                        sha256=sha,
                        summary=summary,
                    )
                )
                m_curr = m_next

    elif fmt == ContainerFormat.BARE_CONCATENATION:
        boundaries = find_bare_boundaries(raw, max_messages=max_container_messages)
        if len(boundaries) > max_container_messages:
            raise ParseLimitError(
                "container_limit_exceeded",
                f"container exceeds maximum message count of {max_container_messages}",
            )

        for i, start in enumerate(boundaries):
            end = boundaries[i + 1] if i + 1 < len(boundaries) else len(raw)
            length = end - start
            if length > max_eml_bytes:
                raise ParseLimitError(
                    "evidence_too_large",
                    f"message at index {i} exceeds maximum allowed size ({max_eml_bytes})",
                )
            slice_bytes = raw[start:end]
            sha = hashlib.sha256(slice_bytes).hexdigest()
            summary = extract_safe_summary(slice_bytes)
            segments.append(
                ContainerSegment(
                    index=i,
                    byte_offset=start,
                    byte_length=length,
                    sha256=sha,
                    summary=summary,
                )
            )

    if not segments or fmt == ContainerFormat.SINGLE:
        fmt = ContainerFormat.SINGLE
        if len(raw) > max_eml_bytes:
            raise ParseLimitError(
                "evidence_too_large",
                f"message exceeds maximum allowed size ({max_eml_bytes})",
            )
        sha = hashlib.sha256(raw).hexdigest()
        summary = extract_safe_summary(raw)
        segments = [
            ContainerSegment(
                index=0,
                byte_offset=0,
                byte_length=len(raw),
                sha256=sha,
                summary=summary,
            )
        ]

    return SegmentationResult(
        container_format=fmt,
        message_count=len(segments),
        segments=segments,
    )
