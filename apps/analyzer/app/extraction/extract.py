"""Turn parsed hostile message data into bounded, normalized observations."""

import hashlib
import ipaddress
import re
from datetime import UTC, datetime, timedelta
from email import policy
from email.message import Message
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urlsplit, urlunsplit

from app.contracts.models import (
    MAX_ADDRESSES,
    MAX_AUTHENTICATION,
    MAX_HEADERS,
    MAX_INDICATORS,
    MAX_MIME_PARTS,
    MAX_NESTED_MESSAGES,
    MAX_PARSER_WARNINGS,
    MAX_RECEIVED_HOPS,
    AddressObservation,
    AuthConflictObservation,
    AuthenticationObservation,
    ContentIndicatorObservation,
    DateObservation,
    HeaderObservation,
    IdentityObservation,
    IndicatorObservation,
    LinkMismatchObservation,
    MessageIdObservation,
    MimePartObservation,
    NestedMessageObservation,
    ReceivedHop,
    RoutingAnomalyObservation,
)
from app.parsing.parser import ParsedMessage, sanitize_filename

_URL_RE = re.compile(r"(?i)\b(?:https?|ftp)://[^\s<>\"']{1,2000}")
_ATTR_URL_RE = re.compile(r"""(?i)\b(?:href|src)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))""")
_EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,63}\b")
_IP_RE = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
_HOST_RE = re.compile(r"(?i)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b")
_TAG_RE = re.compile(r"<[^>]{0,500}>")
_DANGEROUS_EXTENSIONS = {".exe", ".scr", ".js", ".vbs", ".bat", ".cmd", ".ps1", ".lnk", ".hta", ".dll"}

_EXECUTIVE_ROLES = re.compile(
    r"(?i)\b(?:ceo|cfo|coo|cto|cio|ciso|president|vice\s+president|director|executive\s+director|human\s+resources|hr\s+department|payroll|it\s+support|helpdesk|help\s+desk|it\s+service\s+desk|system\s+administrator|security\s+team|account\s+security)\b"
)
_PUBLIC_WEBMAIL = {
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "aol.com",
    "icloud.com",
    "protonmail.com",
    "mail.com",
    "zoho.com",
    "yandex.com",
    "gmx.com",
}
_TARGET_BRANDS = [
    "microsoft",
    "office 365",
    "google",
    "apple",
    "paypal",
    "amazon",
    "docusign",
    "netflix",
    "dropbox",
    "bank of america",
    "wells fargo",
    "chase",
]


class _HtmlUrlExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name.lower() in ("href", "src") and value:
                clean = value.strip()
                if clean:
                    self.urls.append(clean)


def _domain(address: str) -> str | None:
    value = address.rsplit("@", 1)[-1].strip().strip("<>[]").lower()
    return value if "." in value and len(value) <= 253 else None


def _safe_ip(value: str) -> tuple[str, bool] | None:
    val = value.strip()
    if val.startswith("[") and val.endswith("]"):
        val = val[1:-1].strip()
    if val.lower().startswith("ipv6:"):
        val = val[5:].strip()
    try:
        parsed = ipaddress.ip_address(val)
    except ValueError:
        return None
    is_private_or_reserved = bool(
        parsed.is_private
        or parsed.is_loopback
        or parsed.is_link_local
        or parsed.is_reserved
        or parsed.is_multicast
        or parsed.is_unspecified
        or not parsed.is_global
    )
    return str(parsed), is_private_or_reserved


def extract_addresses(message: ParsedMessage) -> list[AddressObservation]:
    result: list[AddressObservation] = []
    for header in ("From", "Sender", "Reply-To", "Return-Path", "To", "Cc"):
        for display, address in message.addresses(header):
            if len(result) >= MAX_ADDRESSES:
                return result
            value = address or display
            if not value:
                continue
            result.append(
                AddressObservation(
                    value=value[:320],
                    address=address[:320] if address else None,
                    display_name=display[:320] if display else None,
                    domain=_domain(address) if address else None,
                    source=header.lower(),
                )
            )
    return result


def extract_headers(message: ParsedMessage) -> list[HeaderObservation]:
    counts: dict[str, int] = {}
    result: list[HeaderObservation] = []
    for name, value in message.headers:
        if len(result) >= MAX_HEADERS:
            return result
        key = name.lower()
        counts[key] = counts.get(key, 0) + 1
        malformed = not bool(name.strip()) or "\x00" in value or "\x00" in name
        safe_name = name.replace("\x00", "")[:80]
        safe_value = value.replace("\x00", "")[:2000]
        result.append(HeaderObservation(name=safe_name, value=safe_value, occurrence=counts[key], malformed=malformed))
    return result


def extract_authentication(message: ParsedMessage) -> list[AuthenticationObservation]:
    result: list[AuthenticationObservation] = []

    # 1. Standard Authentication-Results headers
    for value in message.values("Authentication-Results"):
        if len(result) >= MAX_AUTHENTICATION:
            return result
        declaring = value.split(";", 1)[0].strip()[:253] or None
        for method, outcome, reason in re.findall(
            r"(?i)\b(spf|dkim|dmarc)\s*=\s*([a-z][a-z0-9_-]*)(?:\s*\(([^)]{0,400})\))?", value
        ):
            if len(result) >= MAX_AUTHENTICATION:
                return result
            domain: str | None = None
            selector: str | None = None
            identity: str | None = None
            if method.lower() == "dkim":
                header_i = re.search(r"(?i)\bheader\.i=([^\s;]+)", value)
                if header_i:
                    identity = header_i.group(1)[:320]
                header_s = re.search(r"(?i)\bheader\.s=([^\s;]+)", value)
                if header_s:
                    selector = header_s.group(1)[:100]
                header_d = re.search(r"(?i)\bheader\.d=([^\s;]+)", value)
                if header_d:
                    domain = header_d.group(1)[:253]
            elif method.lower() == "spf":
                smtp_mailfrom = re.search(r"(?i)\bsmtp\.mailfrom=([^\s;]+)", value)
                if smtp_mailfrom:
                    identity = smtp_mailfrom.group(1)[:320]
                    domain = _domain(identity) or identity[:253]
            elif method.lower() == "dmarc":
                header_from = re.search(r"(?i)\bheader\.from=([^\s;]+)", value)
                if header_from:
                    domain = header_from.group(1)[:253]

            result.append(
                AuthenticationObservation(
                    method=method.lower(),
                    result=outcome.lower(),
                    declaring_host=declaring,
                    reason=reason or None,
                    source="authentication-results",
                    domain=domain,
                    signing_domain=domain,
                    selector=selector,
                    identity=identity,
                )
            )

    # 2. Received-SPF headers (RFC 7208)
    for value in message.values("Received-SPF"):
        if len(result) >= MAX_AUTHENTICATION:
            return result
        outcome_match = re.match(r"(?i)^\s*([a-z][a-z0-9_-]*)", value)
        outcome = outcome_match.group(1).lower() if outcome_match else "unknown"
        reason_match = re.search(r"\(([^)]{0,400})\)", value)
        reason = reason_match.group(1).strip() if reason_match else None

        receiver_match = re.search(r"(?i)\breceiver=([^\s;]+)", value)
        declaring = receiver_match.group(1)[:253] if receiver_match else None

        id_match = re.search(r"(?i)\b(?:envelope-from|identity)=[\"']?([^\"'\s;]+)", value)
        identity = id_match.group(1)[:320] if id_match else None
        domain = _domain(identity) if identity else None

        result.append(
            AuthenticationObservation(
                method="spf",
                result=outcome,
                declaring_host=declaring,
                reason=reason[:500] if reason else None,
                source="received-spf",
                domain=domain,
                signing_domain=domain,
                identity=identity,
            )
        )

    # 3. ARC-Authentication-Results headers (RFC 8617)
    for value in message.values("ARC-Authentication-Results"):
        if len(result) >= MAX_AUTHENTICATION:
            return result
        declaring_match = re.search(r"(?i)i=\d+;\s*([^;\s]+)", value)
        declaring = declaring_match.group(1)[:253] if declaring_match else None
        for method, outcome, reason in re.findall(
            r"(?i)\b(spf|dkim|dmarc|arc)\s*=\s*([a-z][a-z0-9_-]*)(?:\s*\(([^)]{0,400})\))?", value
        ):
            if len(result) >= MAX_AUTHENTICATION:
                return result
            domain = None
            selector = None
            identity = None
            if method.lower() == "dkim":
                h_i = re.search(r"(?i)\bheader\.i=([^\s;]+)", value)
                if h_i:
                    identity = h_i.group(1)[:320]
                h_s = re.search(r"(?i)\bheader\.s=([^\s;]+)", value)
                if h_s:
                    selector = h_s.group(1)[:100]
                h_d = re.search(r"(?i)\bheader\.d=([^\s;]+)", value)
                if h_d:
                    domain = h_d.group(1)[:253]
            result.append(
                AuthenticationObservation(
                    method=method.lower(),
                    result=outcome.lower(),
                    declaring_host=declaring,
                    reason=reason or None,
                    source="arc-authentication-results",
                    domain=domain,
                    signing_domain=domain,
                    selector=selector,
                    identity=identity,
                )
            )

    # 4. DKIM-Signature tags (RFC 6376)
    for value in message.values("DKIM-Signature"):
        if len(result) >= MAX_AUTHENTICATION:
            return result
        algo_match = re.search(r"(?i)\ba=([a-zA-Z0-9_-]+)", value)
        domain_match = re.search(r"(?i)\bd=([a-zA-Z0-9.-]+)", value)
        sel_match = re.search(r"(?i)\bs=([a-zA-Z0-9._-]+)", value)
        id_match = re.search(r"(?i)\bi=([^\s;]+)", value)
        headers_match = re.search(r"(?i)(?:^|;)\s*h=([^;]+)", value)

        d = domain_match.group(1)[:253].lower() if domain_match else None
        s = sel_match.group(1)[:100] if sel_match else None
        a = algo_match.group(1)[:50].lower() if algo_match else None
        i = id_match.group(1)[:320] if id_match else None
        signed_headers = (
            [header.strip().lower()[:80] for header in headers_match.group(1).split(":") if header.strip()][:100]
            if headers_match
            else []
        )

        result.append(
            AuthenticationObservation(
                method="dkim",
                result="signed",
                declaring_host=d,
                reason=f"DKIM signature tag present (a={a}, s={s}, d={d})" if d else None,
                source="dkim-signature",
                domain=d,
                signing_domain=d,
                selector=s,
                algorithm=a,
                identity=i,
                signed_headers=signed_headers,
            )
        )

    return result


def _received_host(value: str, key: str) -> str | None:
    match = re.search(rf"(?i)\b{key}\s+([^;\s()]+)", value)
    return match.group(1)[:253].lower() if match else None


def extract_received(message: ParsedMessage) -> list[ReceivedHop]:
    result: list[ReceivedHop] = []
    for position, value in enumerate(message.values("Received"), start=1):
        if len(result) >= MAX_RECEIVED_HOPS:
            break
        ip_info: tuple[str, bool] | None = None
        bracketed = re.search(r"\[(?:IPv6:)?([0-9a-fA-F:.]+)\]", value)
        if bracketed:
            ip_info = _safe_ip(bracketed.group(1))
        if not ip_info:
            ip_match = _IP_RE.search(value)
            if ip_match:
                ip_info = _safe_ip(ip_match.group(0))
        if not ip_info:
            for token in re.findall(
                r"(?<![\w.:])(?:[0-9a-fA-F]{0,4}:){2,7}(?:[0-9a-fA-F]{1,4}|(?<=:))(?![\w.:])",
                value,
            ):
                ip_info = _safe_ip(token)
                if ip_info:
                    break

        source_ip = ip_info[0] if ip_info else None
        timestamp: datetime | None = None
        if ";" in value:
            try:
                raw_dt = parsedate_to_datetime(value.rsplit(";", 1)[1].strip())
                if raw_dt.tzinfo is None:
                    timestamp = raw_dt.replace(tzinfo=UTC)
                else:
                    timestamp = raw_dt.astimezone(UTC)
            except (TypeError, ValueError, OverflowError):
                timestamp = None

        warning = None if (" from " in value.lower() and " by " in value.lower()) else "received header is incomplete"
        result.append(
            ReceivedHop(
                position=position,
                from_host=_received_host(value, "from"),
                by_host=_received_host(value, "by"),
                source_ip=source_ip,
                timestamp=timestamp,
                private_source=ip_info[1] if ip_info else None,
                parse_warning=warning,
            )
        )

    # Compute private-to-public and latency jumps across consecutive chronological hops
    for i in range(len(result) - 1):
        hop_downstream = result[i]
        hop_upstream = result[i + 1]
        updates: dict[str, object] = {}
        if hop_upstream.private_source is True and hop_downstream.private_source is False:
            updates["private_to_public"] = True
        if hop_downstream.timestamp and hop_upstream.timestamp:
            delta = int(abs((hop_downstream.timestamp - hop_upstream.timestamp).total_seconds()))
            if delta > 48 * 3600:
                updates["latency_jump_seconds"] = delta
        if updates:
            result[i] = hop_downstream.model_copy(update=updates)

    return result


def _redact_userinfo(raw_url: str, userinfo: str) -> str:
    """Redact passwords and tokens from userinfo in a display URL value."""
    if ":" in userinfo:
        user, _ = userinfo.split(":", 1)
        redacted = f"{user}:***@" if user else ":***@"
    else:
        redacted = "***@"
    prefix, _, suffix = raw_url.partition(f"{userinfo}@")
    if suffix:
        return prefix + redacted + suffix
    return raw_url


def _normalize_url(value: str) -> tuple[str, str, bool] | None:
    clean_val = value.strip().rstrip(".,;:!?)>\"']")
    if clean_val.startswith("<") and clean_val.endswith(">"):
        clean_val = clean_val[1:-1].strip()
    if clean_val.startswith("(") and clean_val.endswith(")"):
        clean_val = clean_val[1:-1].strip()
    if clean_val.startswith('"') and clean_val.endswith('"'):
        clean_val = clean_val[1:-1].strip()
    if clean_val.startswith("'") and clean_val.endswith("'"):
        clean_val = clean_val[1:-1].strip()

    try:
        parsed = urlsplit(clean_val)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https", "ftp"} or not parsed.hostname:
            return None

        has_userinfo = bool(parsed.username or parsed.password or ("@" in (parsed.netloc or "")))

        raw_host = parsed.hostname
        ip_info = _safe_ip(raw_host)
        is_ipv6 = False
        if ip_info:
            try:
                is_ipv6 = isinstance(ipaddress.ip_address(ip_info[0]), ipaddress.IPv6Address)
            except ValueError:
                pass

        if is_ipv6 and ip_info:
            canonical_host = f"[{ip_info[0]}]"
        else:
            canonical_host = raw_host.encode("idna").decode("ascii").lower()

        port = parsed.port
        default_ports = {"http": 80, "https": 443, "ftp": 21}
        if port is not None and port != default_ports.get(scheme):
            netloc = f"{canonical_host}:{port}"
        else:
            netloc = canonical_host

        path = parsed.path or "/"
        normalized = urlunsplit((scheme, netloc, path, parsed.query, ""))

        if has_userinfo:
            authority = clean_val.split("://", 1)[-1].split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
            if "@" in authority:
                userinfo_str = authority.rsplit("@", 1)[0]
                safe_val = _redact_userinfo(clean_val, userinfo_str)
            else:
                safe_val = clean_val
        else:
            safe_val = clean_val

        return safe_val[:500], normalized[:500], has_userinfo
    except (UnicodeError, ValueError):
        return None


def extract_indicators(message: ParsedMessage, max_urls: int) -> list[IndicatorObservation]:
    result: list[IndicatorObservation] = []
    seen: set[tuple[str, str]] = set()
    limit = max(0, min(max_urls, MAX_INDICATORS))

    candidates: list[str] = []
    if message.html_text:
        extractor = _HtmlUrlExtractor()
        try:
            extractor.feed(message.html_text)
            candidates.extend(extractor.urls)
        except Exception:
            for match in _ATTR_URL_RE.finditer(message.html_text):
                val = match.group(1) or match.group(2)
                if val:
                    candidates.append(unescape(val.strip()))

    stripped_html = _TAG_RE.sub(" ", unescape(message.html_text))
    candidates.extend(_URL_RE.findall(message.plain_text))
    candidates.extend(_URL_RE.findall(stripped_html))

    url_count = 0
    for raw in candidates:
        if url_count >= limit or len(result) >= MAX_INDICATORS:
            break
        norm_result = _normalize_url(raw)
        if not norm_result:
            continue
        safe_val, normalized, has_userinfo = norm_result
        if ("url", normalized) in seen:
            continue
        seen.add(("url", normalized))
        url_count += 1

        parsed_norm = urlsplit(normalized)
        host = parsed_norm.hostname or ""
        ip_info = _safe_ip(host)
        source_label = "body;userinfo" if has_userinfo else "body"

        result.append(
            IndicatorObservation(
                kind="url",
                value=safe_val,
                normalized_value=normalized,
                source=source_label,
                private_or_reserved=ip_info[1] if ip_info else None,
            )
        )
        if len(result) >= MAX_INDICATORS:
            break

        if host and ("domain", host) not in seen and not ip_info:
            seen.add(("domain", host))
            result.append(IndicatorObservation(kind="domain", value=host, normalized_value=host, source="url"))
            if len(result) >= MAX_INDICATORS:
                break

    body_text = message.plain_text + "\n" + stripped_html
    ip_count = 0
    ip_candidates: list[str] = []
    for m in re.finditer(r"\[(?:IPv6:)?([0-9a-fA-F:.]+)\]", body_text):
        ip_candidates.append(m.group(1))
    ip_candidates.extend(_IP_RE.findall(body_text))
    for token in re.findall(
        r"(?<![\w.:])(?:[0-9a-fA-F]{0,4}:){2,7}(?:[0-9a-fA-F]{1,4}|(?<=:))(?![\w.:])",
        body_text,
    ):
        if token not in ip_candidates:
            ip_candidates.append(token)

    for raw_ip in ip_candidates:
        if ip_count >= limit or len(result) >= MAX_INDICATORS:
            break
        ip_info = _safe_ip(raw_ip)
        if ip_info and ("ip", ip_info[0]) not in seen:
            seen.add(("ip", ip_info[0]))
            ip_count += 1
            result.append(
                IndicatorObservation(
                    kind="ip",
                    value=raw_ip,
                    normalized_value=ip_info[0],
                    source="body",
                    private_or_reserved=ip_info[1],
                )
            )
            if len(result) >= MAX_INDICATORS:
                break

    for raw_email in _EMAIL_RE.findall(body_text)[:100]:
        if len(result) >= MAX_INDICATORS:
            break
        domain = _domain(raw_email)
        if domain and ("domain", domain) not in seen:
            seen.add(("domain", domain))
            result.append(IndicatorObservation(kind="domain", value=domain, normalized_value=domain, source="email"))
            if len(result) >= MAX_INDICATORS:
                break

    return result


def extract_mime_parts(message: ParsedMessage) -> list[MimePartObservation]:
    result: list[MimePartObservation] = []
    for part in message.parts:
        if len(result) >= MAX_MIME_PARTS:
            return result
        sanitized_filename, _ = sanitize_filename(part.filename)
        filename = sanitized_filename[:320] if sanitized_filename else None
        extension = ""
        if filename and "." in filename:
            extension = "." + filename.rsplit(".", 1)[-1].lower()
        dangerous = extension in _DANGEROUS_EXTENSIONS
        result.append(
            MimePartObservation(
                part_id=part.part_id,
                content_type=part.content_type[:120],
                byte_size=len(part.payload),
                disposition=part.disposition,
                filename=filename,
                is_attachment=part.is_attachment,
                sha256=part.digest if part.is_attachment else None,
                dangerous_extension=dangerous,
                type_extension_mismatch=dangerous and part.content_type.startswith("text/"),
            )
        )
    return result


def extract_identity(message: ParsedMessage, addresses: list[AddressObservation]) -> list[IdentityObservation]:
    result: list[IdentityObservation] = []
    seen: set[tuple[str, str, str, str]] = set()
    sender_sources = {"from", "sender", "reply-to"}

    for a in addresses:
        if len(result) >= MAX_ADDRESSES:
            break
        src = a.source.lower()
        if src not in sender_sources:
            continue
        display = (a.display_name or "").strip()
        addr = (a.address or "").strip()
        dom = (a.domain or "").lower()
        if not display or not addr:
            continue

        # 1. Embedded email mismatch
        email_match = re.search(r"([A-Za-z0-9._%+\-]+@([A-Za-z0-9.\-]+\.[A-Za-z]{2,63}))", display)
        if email_match:
            emb_email = email_match.group(1).lower()
            emb_dom = email_match.group(2).lower()
            if dom and emb_dom != dom and not dom.endswith("." + emb_dom) and not emb_dom.endswith("." + dom):
                key = (src, display, addr, "embedded_email_mismatch")
                if key not in seen:
                    seen.add(key)
                    expl = (
                        f"Display name '{display[:80]}' contains email '{emb_email}' "
                        f"differing from sender domain '{dom}'."
                    )[:500]
                    result.append(
                        IdentityObservation(
                            source=src,
                            display_name=display[:320],
                            address=addr[:320],
                            claimed_identity=emb_email[:320],
                            inconsistency_type="embedded_email_mismatch",
                            explanation=expl,
                        )
                    )
                    if len(result) >= MAX_ADDRESSES:
                        break

        # 2. Embedded domain mismatch (if no email was flagged)
        if not email_match:
            dom_match = re.search(
                r"\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|org|net|edu|gov|io|co|ai|info|biz|me|app|xyz))\b",
                display,
                re.IGNORECASE,
            )
            if dom_match:
                emb_dom = dom_match.group(1).lower()
                if dom and emb_dom != dom and not dom.endswith("." + emb_dom) and not emb_dom.endswith("." + dom):
                    key = (src, display, addr, "embedded_domain_mismatch")
                    if key not in seen:
                        seen.add(key)
                        expl = (
                            f"Display name '{display[:80]}' contains domain '{emb_dom}' "
                            f"differing from sender domain '{dom}'."
                        )[:500]
                        result.append(
                            IdentityObservation(
                                source=src,
                                display_name=display[:320],
                                address=addr[:320],
                                claimed_identity=emb_dom[:320],
                                inconsistency_type="embedded_domain_mismatch",
                                explanation=expl,
                            )
                        )
                        if len(result) >= MAX_ADDRESSES:
                            break

        # 3. Executive role with public webmail
        role_match = _EXECUTIVE_ROLES.search(display)
        if role_match and dom in _PUBLIC_WEBMAIL:
            matched_role = role_match.group(0)
            key = (src, display, addr, "executive_title_webmail")
            if key not in seen:
                seen.add(key)
                expl = (f"Display name claims role '{matched_role}' but sender uses public webmail '{dom}'.")[:500]
                result.append(
                    IdentityObservation(
                        source=src,
                        display_name=display[:320],
                        address=addr[:320],
                        claimed_identity=matched_role[:320],
                        inconsistency_type="executive_title_webmail",
                        explanation=expl,
                    )
                )
                if len(result) >= MAX_ADDRESSES:
                    break

        # 4. Brand impersonation
        for brand in _TARGET_BRANDS:
            if len(result) >= MAX_ADDRESSES:
                break
            if re.search(rf"(?i)\b{re.escape(brand)}\b", display):
                clean_brand = brand.replace(" ", "")
                if dom and clean_brand not in dom.replace("-", ""):
                    key = (src, display, addr, "brand_impersonation")
                    if key not in seen:
                        seen.add(key)
                        expl = (f"Display name references brand '{brand}' but sender domain '{dom}' does not match.")[
                            :500
                        ]
                        result.append(
                            IdentityObservation(
                                source=src,
                                display_name=display[:320],
                                address=addr[:320],
                                claimed_identity=brand[:320],
                                inconsistency_type="brand_impersonation",
                                explanation=expl,
                            )
                        )
                        break

    return result


def extract_date(
    message: ParsedMessage,
    received_hops: list[ReceivedHop],
    now: datetime | None = None,
) -> list[DateObservation]:
    date_headers = message.values("Date")
    if not date_headers:
        return [
            DateObservation(
                raw_value=None,
                parsed_date=None,
                is_valid=False,
                anomalies=["missing_date"],
                details="Message does not contain a Date header.",
            )
        ]

    ref_now = now if now is not None else datetime.now(UTC)
    if ref_now.tzinfo is None:
        ref_now = ref_now.replace(tzinfo=UTC)
    else:
        ref_now = ref_now.astimezone(UTC)

    hop_times = [h.timestamp for h in received_hops if h.timestamp is not None]
    earliest_hop = min(hop_times) if hop_times else None
    latest_hop = max(hop_times) if hop_times else None

    result: list[DateObservation] = []
    for raw_val in date_headers:
        if len(result) >= MAX_HEADERS:
            break
        raw = raw_val.strip()[:200]
        anomalies: list[str] = []
        if len(date_headers) > 1:
            anomalies.append("multiple_date_headers")

        parsed_dt: datetime | None = None
        try:
            dt = parsedate_to_datetime(raw)
            parsed_dt = dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
        except (TypeError, ValueError, OverflowError, IndexError):
            parsed_dt = None

        if parsed_dt is None:
            anomalies.append("invalid_syntax")
            result.append(
                DateObservation(
                    raw_value=raw,
                    parsed_date=None,
                    is_valid=False,
                    anomalies=anomalies,
                    details="Date header cannot be parsed as valid RFC 5322 date.",
                )
            )
            continue

        # Syntax validity and forensic anomalies are separate observations: a
        # perfectly parseable date can still be suspiciously future/stale.
        if parsed_dt > ref_now + timedelta(hours=1):
            anomalies.append("future_date")

        if earliest_hop and (earliest_hop - parsed_dt) > timedelta(days=7):
            anomalies.append("stale_date")

        if earliest_hop and abs((earliest_hop - parsed_dt).total_seconds()) > 24 * 3600:
            anomalies.append("routing_timestamp_mismatch")
        elif latest_hop and abs((latest_hop - parsed_dt).total_seconds()) > 24 * 3600:
            anomalies.append("routing_timestamp_mismatch")

        details = (
            f"Date anomalies detected: {', '.join(anomalies)}."[:500]
            if anomalies
            else "Canonical Date header is valid and consistent with delivery timestamps."
        )
        result.append(
            DateObservation(
                raw_value=raw,
                parsed_date=parsed_dt,
                # ``is_valid`` describes RFC parsing, while ``anomalies`` carries
                # risk signals for a syntactically valid but implausible date.
                is_valid=True,
                anomalies=anomalies,
                details=details,
            )
        )

    return result


def extract_message_ids(
    message: ParsedMessage,
    addresses: list[AddressObservation],
) -> list[MessageIdObservation]:
    msg_id_headers = message.values("Message-ID")
    sender_sources = {"from", "sender", "reply-to", "return-path"}
    sender_domains = sorted(
        list({a.domain.lower() for a in addresses if a.source.lower() in sender_sources and a.domain})
    )

    if not msg_id_headers:
        return [
            MessageIdObservation(
                raw_value=None,
                message_id=None,
                domain=None,
                is_valid_syntax=False,
                aligned_with_sender=False,
                sender_domains=sender_domains[:50],
                anomalies=["missing_message_id"],
                details="Message does not contain a Message-ID header.",
            )
        ]

    result: list[MessageIdObservation] = []
    is_multiple = len(msg_id_headers) > 1

    for raw_val in msg_id_headers:
        if len(result) >= MAX_HEADERS:
            break
        raw = raw_val.strip()[:500]
        anomalies: list[str] = []
        if is_multiple:
            anomalies.append("multiple_message_ids")

        match = re.fullmatch(r"<([^<>@\s]+)@([^<>@\s]+)>", raw)
        if match:
            left = match.group(1)
            right = match.group(2).lower()
            msg_id = f"<{left}@{right}>"[:500]
            id_domain = right[:253]
            is_valid_syntax = True

            aligned = False
            for s_dom in sender_domains:
                if id_domain == s_dom or id_domain.endswith("." + s_dom) or s_dom.endswith("." + id_domain):
                    aligned = True
                    break
            if not aligned and sender_domains:
                anomalies.append("domain_mismatch")

            details = (
                "Message-ID is syntactically valid and aligned with sender."
                if aligned
                else (
                    "Message-ID domain does not align with sender domain(s)."
                    if "domain_mismatch" in anomalies
                    else "Message-ID is syntactically valid."
                )
            )
        else:
            msg_id = None
            id_domain = None
            is_valid_syntax = False
            aligned = False
            anomalies.append("syntax_invalid")
            details = "Message-ID does not conform to RFC 5322 <id-left@id-right> syntax."

        result.append(
            MessageIdObservation(
                raw_value=raw,
                message_id=msg_id,
                domain=id_domain,
                is_valid_syntax=is_valid_syntax,
                aligned_with_sender=aligned,
                sender_domains=sender_domains[:50],
                anomalies=anomalies,
                details=details[:500],
            )
        )

    return result


def extract_auth_conflicts(
    authentication: list[AuthenticationObservation],
) -> list[AuthConflictObservation]:
    grouped: dict[str, list[tuple[str, str]]] = {}
    for obs in authentication:
        if obs.result == "signed":
            continue
        grouped.setdefault(obs.method.lower(), []).append((obs.source, obs.result.lower()))

    conflicts: list[AuthConflictObservation] = []
    for method, entries in grouped.items():
        if len(conflicts) >= MAX_AUTHENTICATION:
            break
        outcomes = {r for _, r in entries}
        has_pass = "pass" in outcomes
        has_fail = bool(outcomes & {"fail", "softfail", "permerror", "temperror"})
        has_none_conflict = has_pass and ("none" in outcomes or "neutral" in outcomes)

        if (has_pass and has_fail) or has_none_conflict or (len(outcomes) > 1 and "fail" in outcomes):
            sources = sorted(list({s for s, _ in entries}))
            unique_outcomes = sorted(list(outcomes))
            entries_summary = ", ".join(f"{s}: {r}" for s, r in entries[:10])
            expl = (
                f"Conflicting reported {method.upper()} outcomes across authentication headers: {entries_summary}."
            )[:500]
            conflicts.append(
                AuthConflictObservation(
                    method=method,
                    outcomes=unique_outcomes[:20],
                    sources=sources[:20],
                    explanation=expl,
                )
            )

    return conflicts


def extract_routing_anomalies(received: list[ReceivedHop]) -> list[RoutingAnomalyObservation]:
    anomalies: list[RoutingAnomalyObservation] = []
    if not received:
        return [
            RoutingAnomalyObservation(
                anomaly_type="missing_upstream_hops",
                hop_positions=[],
                explanation="Message contains no Received hops from which upstream routing can be observed.",
                details="routing_observation_unavailable",
            )
        ]

    # 1. Truncated / malformed hops
    for h in received:
        if len(anomalies) >= MAX_RECEIVED_HOPS:
            return anomalies
        if h.parse_warning:
            anomalies.append(
                RoutingAnomalyObservation(
                    anomaly_type="truncated_hop",
                    hop_positions=[h.position],
                    explanation=f"Hop {h.position} has incomplete or malformed routing structure: {h.parse_warning}."[
                        :500
                    ],
                    details=h.parse_warning[:500],
                )
            )

    # 2. Consecutive hop transitions (ordered by position 1..N)
    sorted_hops = sorted(received, key=lambda h: h.position)
    for i in range(len(sorted_hops) - 1):
        if len(anomalies) >= MAX_RECEIVED_HOPS:
            return anomalies
        hop_downstream = sorted_hops[i]
        hop_upstream = sorted_hops[i + 1]

        # Private-to-public transition
        if hop_upstream.private_source is True and hop_downstream.private_source is False:
            anomalies.append(
                RoutingAnomalyObservation(
                    anomaly_type="private_to_public_transition",
                    hop_positions=[hop_upstream.position, hop_downstream.position],
                    explanation=(
                        f"Private-to-public transition detected: upstream hop {hop_upstream.position} "
                        f"({hop_upstream.source_ip or 'private'}) forwarded to public hop "
                        f"{hop_downstream.position} ({hop_downstream.source_ip or 'public'})."
                    )[:500],
                )
            )

        # >48h latency jump
        if hop_downstream.timestamp and hop_upstream.timestamp:
            delta_s = int(abs((hop_downstream.timestamp - hop_upstream.timestamp).total_seconds()))
            if delta_s > 48 * 3600:
                hours = delta_s // 3600
                anomalies.append(
                    RoutingAnomalyObservation(
                        anomaly_type="latency_jump_48h",
                        hop_positions=[hop_upstream.position, hop_downstream.position],
                        explanation=(
                            f"Implausible transit latency jump of {hours}h ({delta_s}s) "
                            f"between hop {hop_upstream.position} and hop {hop_downstream.position}, "
                            f"exceeding 48h threshold."
                        )[:500],
                    )
                )

        # Relay discontinuity
        if hop_upstream.by_host and hop_downstream.from_host:
            by_h = hop_upstream.by_host.lower()
            from_h = hop_downstream.from_host.lower()
            if by_h != from_h and not by_h.endswith("." + from_h) and not from_h.endswith("." + by_h):
                anomalies.append(
                    RoutingAnomalyObservation(
                        anomaly_type="discontinuous_hops",
                        hop_positions=[hop_upstream.position, hop_downstream.position],
                        explanation=(
                            f"Relay continuity broken: hop {hop_upstream.position} by-host '{by_h}' "
                            f"does not match hop {hop_downstream.position} from-host '{from_h}'."
                        )[:500],
                    )
                )

    # 3. Missing hops check (position gaps)
    positions = [h.position for h in sorted_hops]
    if positions and (positions != list(range(1, len(positions) + 1))):
        missing = [p for p in range(1, max(positions)) if p not in positions]
        if missing and len(anomalies) < MAX_RECEIVED_HOPS:
            missing_expl = (
                f"Hop sequence discontinuity: missing expected intermediate hop position(s) {missing[:10]}."
            )[:500]
            anomalies.append(
                RoutingAnomalyObservation(
                    anomaly_type="missing_hops",
                    hop_positions=missing[:20],
                    explanation=missing_expl,
                )
            )

    return anomalies


def extract_content_indicators(message: ParsedMessage) -> list[ContentIndicatorObservation]:
    result: list[ContentIndicatorObservation] = []
    seen: set[tuple[str, str]] = set()

    sources = [
        ("plain_text", message.plain_text),
        ("html_text", _TAG_RE.sub(" ", unescape(message.html_text))),
    ]

    patterns: list[tuple[str, list[re.Pattern[str]]]] = [
        (
            "credential_harvesting",
            [
                re.compile(
                    r"(?i)\b(?:verify|confirm|reset|update|validate|enter)\s+(?:your\s+)?(?:password|passcode|credentials?|pin|security\s+questions?)\b"
                ),
                re.compile(
                    r"(?i)\b(?:login|sign\s*in|log\s*in)\s+(?:here|now|to\s+(?:verify|confirm|restore|reactivate|unlock|view))\b"
                ),
                re.compile(
                    r"(?i)\b(?:account\s+verification|credential\s+update|password\s+expiration|re-?authenticate)\b"
                ),
                re.compile(
                    r"(?i)\b(?:update|confirm)\s+(?:your\s+)?(?:billing|credit\s*card|banking|payment)\s+(?:information|details)\b"
                ),
            ],
        ),
        (
            "urgent_language",
            [
                re.compile(
                    r"(?i)\b(?:immediate\s+action\s+required|urgent\s+action\s+required|action\s+required\s+immediately)\b"
                ),
                re.compile(
                    r"(?i)\b(?:account\s+(?:suspended|terminated|locked|closed|disabled)|will\s+be\s+(?:suspended|terminated|deleted|locked))\b"
                ),
                re.compile(
                    r"(?i)\b(?:within\s+(?:24|48|12|1)\s*(?:hours?|hrs?)|in\s+the\s+next\s+(?:24|48)\s*hours?)\b"
                ),
                re.compile(r"(?i)\b(?:failure\s+to\s+(?:respond|verify|update)|final\s+notice|last\s+warning)\b"),
                re.compile(r"(?i)\b(?:unauthorized\s+(?:access|login|activity)\s+detected)\b"),
            ],
        ),
        (
            "financial_pressure",
            [
                re.compile(
                    r"(?i)\b(?:wire\s+transfer|urgent\s+wire|gift\s+cards?|cryptocurrency\s+payment|bitcoin\s+transfer)\b"
                ),
                re.compile(r"(?i)\b(?:overdue\s+invoice|unpaid\s+balance|direct\s+deposit\s+change)\b"),
            ],
        ),
    ]

    for src_name, text in sources:
        if not text:
            continue
        for category, regex_list in patterns:
            for regex in regex_list:
                if len(result) >= MAX_INDICATORS:
                    return result
                for match in regex.finditer(text):
                    if len(result) >= MAX_INDICATORS:
                        return result
                    phrase = match.group(0).strip()[:100]
                    key = (category, phrase.lower())
                    if key in seen:
                        continue
                    seen.add(key)

                    start = max(0, match.start() - 30)
                    end = min(len(text), match.end() + 30)
                    raw_snippet = text[start:end]
                    cleaned_snippet = re.sub(r"[\x00-\x1f\x7f\s]+", " ", raw_snippet).strip()
                    bounded_snippet = f"...{cleaned_snippet}..."[:200]

                    result.append(
                        ContentIndicatorObservation(
                            category=category,
                            matched_phrase=phrase,
                            snippet=bounded_snippet,
                            source=src_name,
                        )
                    )

    return result


class _AnchorMismatchExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_anchor = False
        self.current_href: str | None = None
        self.current_text: list[str] = []
        self.links: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            self.in_anchor = True
            self.current_text = []
            self.current_href = None
            for name, value in attrs:
                if name.lower() == "href" and value:
                    self.current_href = value.strip()

    def handle_data(self, data: str) -> None:
        if self.in_anchor:
            self.current_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a":
            if self.current_href:
                text = "".join(self.current_text).strip()
                self.links.append((self.current_href, text))
            self.in_anchor = False
            self.current_href = None
            self.current_text = []


def extract_link_mismatches(message: ParsedMessage) -> list[LinkMismatchObservation]:
    if not message.html_text:
        return []

    extractor = _AnchorMismatchExtractor()
    try:
        extractor.feed(message.html_text)
    except Exception:
        return []

    result: list[LinkMismatchObservation] = []
    seen: set[tuple[str, str]] = set()

    for raw_href, raw_display in extractor.links:
        if len(result) >= MAX_INDICATORS:
            break
        norm_result = _normalize_url(raw_href)
        if not norm_result:
            continue
        _, actual_url, _ = norm_result
        actual_parsed = urlsplit(actual_url)
        actual_domain = (actual_parsed.hostname or "").lower()
        if not actual_domain:
            continue

        display_clean = raw_display.strip()
        display_domain: str | None = None

        url_m = _URL_RE.search(display_clean)
        if url_m:
            url_norm = _normalize_url(url_m.group(0))
            if url_norm:
                display_domain = (urlsplit(url_norm[1]).hostname or "").lower()

        if not display_domain:
            dom_m = re.search(
                r"\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:[a-z]{2,63}))\b",
                display_clean,
                re.IGNORECASE,
            )
            if dom_m:
                try:
                    display_domain = dom_m.group(1).encode("idna").decode("ascii").lower()
                except UnicodeError:
                    display_domain = dom_m.group(1).lower()

        if not display_domain:
            continue

        if (
            display_domain != actual_domain
            and not actual_domain.endswith("." + display_domain)
            and not display_domain.endswith("." + actual_domain)
        ):
            key = (display_domain, actual_domain)
            if key in seen:
                continue
            seen.add(key)
            result.append(
                LinkMismatchObservation(
                    display_text=display_clean[:200],
                    display_domain=display_domain[:253],
                    actual_href=actual_url[:500],
                    actual_domain=actual_domain[:253],
                    explanation=(
                        f"HTML link text displays domain '{display_domain}' "
                        f"but actual href targets domain '{actual_domain}'."
                    )[:500],
                )
            )

    return result


# Descriptive aliases kept for integrations that use pluralized phase names.
extract_dates = extract_date
extract_date_header = extract_date
extract_message_id = extract_message_ids
extract_authentication_conflicts = extract_auth_conflicts
extract_routing_observations = extract_routing_anomalies
extract_content_observations = extract_content_indicators
extract_html_link_mismatches = extract_link_mismatches


def extract_nested_messages(
    raw: bytes,
    *,
    analysis_time: datetime,
    max_urls: int = 25,
    max_nested_depth: int = 3,
    max_nested_messages: int = MAX_NESTED_MESSAGES,
    max_eml_bytes: int = 26_214_400,
    max_mime_parts: int = 50,
    max_mime_depth: int = 10,
    max_headers: int = 100,
    max_attachment_bytes: int = 26_214_400,
) -> list[NestedMessageObservation]:
    """Recursively extract and evaluate message/rfc822 nested parts up to bounded depth."""
    from app.parsing.parser import ParseLimitError, parse_message
    from app.scoring.rules import score_findings, verdict_for

    try:
        root_message = BytesParser(policy=policy.default).parsebytes(raw)
    except Exception:
        return []

    results: list[NestedMessageObservation] = []
    # Queue items: (path, part_message, depth)
    queue: list[tuple[str, Message, int]] = [("1", root_message, 0)]

    while queue and len(results) < max_nested_messages:
        path, current_part, depth = queue.pop(0)

        if current_part.is_multipart():
            payload = current_part.get_payload()
            if isinstance(payload, list):
                for idx, child in enumerate(payload, start=1):
                    if not isinstance(child, Message):
                        continue
                    child_path = f"{path}.{idx}"
                    child_ct = child.get_content_type().lower()
                    if child_ct == "message/rfc822":
                        next_depth = depth + 1
                        if next_depth <= max_nested_depth and len(results) < max_nested_messages:
                            inner_payload = child.get_payload()
                            if isinstance(inner_payload, list) and inner_payload:
                                inner_msg = inner_payload[0] if isinstance(inner_payload[0], Message) else child
                            elif isinstance(inner_payload, Message):
                                inner_msg = inner_payload
                            else:
                                inner_msg = child

                            try:
                                child_bytes = inner_msg.as_bytes()
                            except Exception:
                                child_bytes = bytes(inner_msg)

                            child_sha = hashlib.sha256(child_bytes).hexdigest()
                            child_size = len(child_bytes)

                            try:
                                child_parsed = parse_message(
                                    child_bytes,
                                    max_bytes=max_eml_bytes,
                                    max_parts=max_mime_parts,
                                    max_depth=max_mime_depth,
                                    max_headers=max_headers,
                                    max_attachment_bytes=max_attachment_bytes,
                                )
                            except ParseLimitError as err:
                                child_parsed = ParsedMessage(warnings=[f"{child_path}:{err.code}"])
                            except Exception:
                                child_parsed = ParsedMessage(warnings=[f"{child_path}:parse_error"])

                            n_headers = extract_headers(child_parsed)
                            n_addresses = extract_addresses(child_parsed)
                            n_auth = extract_authentication(child_parsed)
                            n_conflicts = extract_auth_conflicts(n_auth)
                            n_received = extract_received(child_parsed)
                            n_routing = extract_routing_anomalies(n_received)
                            n_mime = extract_mime_parts(child_parsed)
                            n_indicators = extract_indicators(child_parsed, max_urls)
                            n_identity = extract_identity(child_parsed, n_addresses)
                            n_date = extract_date(child_parsed, n_received, analysis_time)
                            n_msg_id = extract_message_ids(child_parsed, n_addresses)
                            n_content = extract_content_indicators(child_parsed)
                            n_links = extract_link_mismatches(child_parsed)

                            n_score = score_findings(
                                addresses=n_addresses,
                                authentication=n_auth,
                                received=n_received,
                                indicators=n_indicators,
                                mime_parts=n_mime,
                                warnings=child_parsed.warnings,
                                enrichment=[],
                                identity_observations=n_identity,
                                date_observations=n_date,
                                message_id_observations=n_msg_id,
                                content_indicators=n_content,
                                link_mismatches=n_links,
                                routing_anomalies=n_routing,
                                auth_conflicts=n_conflicts,
                            )
                            n_verdict = verdict_for(n_score.final_score)

                            results.append(
                                NestedMessageObservation(
                                    path=child_path,
                                    depth=next_depth,
                                    sha256=child_sha,
                                    byte_size=child_size,
                                    headers=n_headers,
                                    addresses=n_addresses,
                                    received_hops=n_received,
                                    authentication=n_auth,
                                    mime_parts=n_mime,
                                    indicators=n_indicators,
                                    parser_warnings=child_parsed.warnings[:MAX_PARSER_WARNINGS],
                                    identity_observations=n_identity,
                                    date_observations=n_date,
                                    message_id_observations=n_msg_id,
                                    content_indicators=n_content,
                                    link_mismatches=n_links,
                                    routing_anomalies=n_routing,
                                    auth_conflicts=n_conflicts,
                                    findings=n_score.contributions,
                                    score=n_score,
                                    verdict=n_verdict,
                                )
                            )

                            if next_depth < max_nested_depth:
                                queue.append((child_path, inner_msg, next_depth))
                    else:
                        queue.append((child_path, child, depth))

    return results
