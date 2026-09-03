"""Bounded RFC 5322/MIME parsing. This module never executes or renders message content."""

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from email import policy
from email.message import Message
from email.parser import BytesParser
from email.utils import getaddresses
from hashlib import sha256

_TRAVERSAL_PATTERN = re.compile(r"(?:\.\.[/\\]|[/\\]\.\.|^[/\\]|[a-zA-Z]:[/\\]|\x00)")


def sanitize_filename(name: str | None) -> tuple[str | None, bool]:
    """Sanitize and normalize filename to prevent path traversal and strip control chars.

    Returns:
        (sanitized_filename, had_traversal)
    """
    if not name:
        return None, False
    original = name
    had_traversal = bool(_TRAVERSAL_PATTERN.search(original))

    # Strip null bytes and control characters (\x00-\x1f, \x7f)
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    if not cleaned:
        return None, True

    # Strip Windows drive prefix like C: or D:
    cleaned = re.sub(r"^[a-zA-Z]:", "", cleaned)
    # Normalize backslashes to forward slashes
    cleaned = cleaned.replace("\\", "/")
    # Split into path components and filter out empty and relative dot segments
    segments = [s for s in cleaned.split("/") if s and s not in (".", "..")]
    if not segments:
        return None, True

    basename = segments[-1].strip()[:320]
    if not basename:
        return None, True
    if basename != original and not had_traversal:
        had_traversal = any(sep in original for sep in ("/", "\\", ".."))
    return basename, had_traversal


class ParseLimitError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ParsedPart:
    part_id: str
    content_type: str
    disposition: str | None
    filename: str | None
    payload: bytes
    is_attachment: bool
    defects: tuple[str, ...] = ()

    @property
    def digest(self) -> str:
        return sha256(self.payload).hexdigest()


@dataclass
class ParsedMessage:
    headers: list[tuple[str, str]] = field(default_factory=list)
    parts: list[ParsedPart] = field(default_factory=list)
    plain_text: str = ""
    html_text: str = ""
    warnings: list[str] = field(default_factory=list)

    def values(self, name: str) -> list[str]:
        wanted = name.lower()
        return [value for key, value in self.headers if key.lower() == wanted]

    def addresses(self, name: str) -> list[tuple[str, str]]:
        return getaddresses(self.values(name))


def _bounded_decode(
    part: Message,
    payload: bytes,
    limit: int,
    part_id: str = "1",
    warnings: list[str] | None = None,
) -> str:
    if len(payload) > limit:
        raise ParseLimitError("mime_limit_exceeded", "decoded MIME part exceeds configured limit")
    text: str = ""
    if hasattr(part, "get_content"):
        try:
            value = part.get_content()
            if isinstance(value, str):
                text = value
            elif isinstance(value, (bytes, bytearray)):
                text = value.decode("utf-8", "replace")
            else:
                text = str(value)
        except Exception as err:
            if warnings is not None:
                warnings.append(f"{part_id}:malformed_encoding:{type(err).__name__}")
            text = payload.decode("utf-8", "replace")
    else:
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            if warnings is not None:
                warnings.append(f"{part_id}:malformed_encoding:UnicodeDecodeError")
            text = payload.decode("utf-8", "replace")
    if len(text) > limit or len(text.encode("utf-8")) > limit:
        raise ParseLimitError("mime_limit_exceeded", "decoded text exceeds configured limit")
    return text


def parse_message(
    raw: bytes,
    *,
    max_bytes: int,
    max_parts: int,
    max_depth: int,
    max_headers: int,
    max_attachment_bytes: int,
    max_header_value_bytes: int = 10_000,
    max_non_attachment_bytes: int | None = None,
) -> ParsedMessage:
    if not raw or not raw.strip(b"\x00 \t\r\n"):
        raise ParseLimitError("message_invalid", "message is empty")
    if len(raw) > max_bytes:
        raise ParseLimitError("evidence_too_large", "message exceeds configured size limit")

    try:
        message = BytesParser(policy=policy.default).parsebytes(raw)
    except Exception as err:
        raise ParseLimitError("message_invalid", f"failed to parse message: {err}") from err

    result = ParsedMessage()
    for defect in getattr(message, "defects", ()):
        result.warnings.append(f"1:{type(defect).__name__}")

    total_header_bytes = 0
    for index, (name, value) in enumerate(message.raw_items(), start=1):
        if index > max_headers:
            raise ParseLimitError("header_limit_exceeded", "message contains too many headers")
        val_str = str(value)
        if len(val_str) > max_header_value_bytes:
            raise ParseLimitError(
                "header_limit_exceeded",
                f"header value exceeds maximum length of {max_header_value_bytes}",
            )
        total_header_bytes += len(name) + len(val_str)
        if total_header_bytes > max_bytes:
            raise ParseLimitError("header_limit_exceeded", "total headers size exceeds configured limit")
        result.headers.append((name[:80], val_str[:2000]))

    attachment_bytes = 0
    non_attachment_bytes = 0
    plain_text_bytes = 0
    html_text_bytes = 0
    total_parts_inspected = 0
    non_attachment_limit = max_non_attachment_bytes if max_non_attachment_bytes is not None else max_bytes
    pending: list[tuple[str, Message, int]] = [("1", message, 0)]
    while pending:
        total_parts_inspected += 1
        if total_parts_inspected > max_parts:
            raise ParseLimitError("mime_limit_exceeded", "message contains too many MIME parts")
        if len(pending) > max_parts * 2:
            raise ParseLimitError("mime_limit_exceeded", "message contains too many MIME parts")

        part_id, part, depth = pending.pop(0)
        if depth > max_depth:
            raise ParseLimitError("mime_limit_exceeded", "MIME nesting exceeds configured limit")
        if len(result.parts) >= max_parts:
            raise ParseLimitError("mime_limit_exceeded", "message contains too many MIME parts")

        if part.is_multipart():
            payload_parts = part.get_payload()
            children = (
                [child for child in payload_parts if isinstance(child, Message)]
                if isinstance(payload_parts, list)
                else []
            )
            pending[0:0] = [(f"{part_id}.{i}", child, depth + 1) for i, child in enumerate(children, start=1)]
            continue

        raw_payload = part.get_payload(decode=True)
        if raw_payload is None:
            raw_fallback = part.get_payload()
            if isinstance(raw_fallback, str):
                payload = raw_fallback.encode("utf-8", "replace")
            else:
                payload = b""
            if part.get("content-transfer-encoding"):
                result.warnings.append(f"{part_id}:malformed_transfer_encoding")
        elif isinstance(raw_payload, bytes):
            payload = raw_payload
        else:
            payload = b""

        if len(payload) > max_bytes:
            raise ParseLimitError("mime_limit_exceeded", "decoded MIME part exceeds configured limit")

        disposition = part.get_content_disposition()
        raw_filename = part.get_filename()
        filename, had_traversal = sanitize_filename(raw_filename)
        if had_traversal:
            result.warnings.append(f"{part_id}:path_traversal_filename")

        content_type = part.get_content_type()
        is_attachment = disposition == "attachment" or raw_filename is not None

        if is_attachment:
            attachment_bytes += len(payload)
            if attachment_bytes > max_attachment_bytes:
                raise ParseLimitError("attachment_limit_exceeded", "attachments exceed configured size limit")
        else:
            non_attachment_bytes += len(payload)
            if non_attachment_bytes > non_attachment_limit:
                raise ParseLimitError(
                    "mime_limit_exceeded",
                    "decoded non-attachment payload exceeds configured limit",
                )

        if (attachment_bytes + non_attachment_bytes) > (max_bytes + max_attachment_bytes):
            raise ParseLimitError("mime_limit_exceeded", "total decoded payload exceeds configured limit")

        defects = tuple(type(defect).__name__ for defect in getattr(part, "defects", ()))
        for defect_name in defects:
            warning = f"{part_id}:{defect_name}"
            if warning not in result.warnings:
                result.warnings.append(warning)
        observation = ParsedPart(part_id, content_type, disposition, filename, payload, is_attachment, defects)
        result.parts.append(observation)

        if content_type == "text/plain" and not is_attachment:
            text = _bounded_decode(part, payload, non_attachment_limit, part_id, result.warnings)
            encoded_len = len(text.encode("utf-8"))
            if plain_text_bytes + encoded_len > non_attachment_limit:
                raise ParseLimitError("mime_limit_exceeded", "decoded plain text exceeds configured limit")
            result.plain_text += text + "\n"
            plain_text_bytes += encoded_len + 1
        elif content_type == "text/html" and not is_attachment:
            text = _bounded_decode(part, payload, non_attachment_limit, part_id, result.warnings)
            encoded_len = len(text.encode("utf-8"))
            if html_text_bytes + encoded_len > non_attachment_limit:
                raise ParseLimitError("mime_limit_exceeded", "decoded HTML text exceeds configured limit")
            result.html_text += text + "\n"
            html_text_bytes += encoded_len + 1

    return result


def iter_header_values(message: ParsedMessage, names: Iterable[str]) -> Iterable[tuple[str, str]]:
    wanted = {name.lower() for name in names}
    return ((name, value) for name, value in message.headers if name.lower() in wanted)
