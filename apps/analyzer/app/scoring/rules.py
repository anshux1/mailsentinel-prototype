"""Deterministic, explainable scoring rules."""

from collections.abc import Sequence
from datetime import UTC, datetime

from app.contracts.models import (
    MAX_FINDINGS,
    AddressObservation,
    AuthConflictObservation,
    AuthenticationObservation,
    ContentIndicatorObservation,
    DateObservation,
    EnrichmentObservation,
    Finding,
    FindingCategory,
    IdentityObservation,
    IndicatorObservation,
    LinkMismatchObservation,
    MessageIdObservation,
    MimePartObservation,
    NestedMessageObservation,
    ReceivedHop,
    RoutingAnomalyObservation,
    ScoreBreakdown,
    SeverityValue,
    VerdictValue,
)

RULESET_VERSION: str = "v1.2.0"
_SENDER_SOURCES = {"from", "sender", "reply-to", "return-path"}
_HIGH_RISK_COUNTRIES = {"BY", "IR", "KP", "NG", "RU", "SY"}
_HIGH_RISK_ASNS = {"AS4134", "AS4837", "AS9009", "AS16276", "AS14061"}


def _to_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    try:
        if dt.tzinfo is None or dt.tzinfo.utcoffset(dt) is None:
            return dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC)
    except (ValueError, OverflowError):
        return None


def _finding(
    rule: str,
    category: FindingCategory,
    severity: SeverityValue,
    points: int,
    explanation: str,
    source: str,
    evidence_refs: list[str] | None = None,
) -> Finding:
    refs = evidence_refs if evidence_refs is not None else ([source] if source else [])
    return Finding(
        rule_id=rule,
        category=category,
        severity=severity,
        score_contribution=points,
        explanation=explanation[:500],
        source=source[:100] or "analyzer",
        evidence_refs=[ref[:200] for ref in refs[:20] if ref][:20],
    )


def _finding_sort_key(item: Finding) -> tuple[str, str, str, tuple[str, ...]]:
    return (
        item.rule_id,
        item.source,
        item.explanation,
        tuple(item.evidence_refs),
    )


def _domains_align(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    a, b = left.lower().strip("."), right.lower().strip(".")
    return a == b or a.endswith(f".{b}") or b.endswith(f".{a}")


def _sender_domains(addresses: Sequence[AddressObservation]) -> set[str]:
    return {
        str(address.domain).lower()
        for address in addresses
        if getattr(address, "source", "").lower() in _SENDER_SOURCES and address.domain
    }


def _is_consistent_routing(received: Sequence[ReceivedHop]) -> bool:
    hops = sorted(received, key=lambda hop: hop.position)
    if not hops or any(not hop.from_host or not hop.by_host or not _to_utc(hop.timestamp) for hop in hops):
        return False
    if any(
        left < right
        for left, right in zip(
            (_to_utc(h.timestamp) for h in hops), (_to_utc(h.timestamp) for h in hops[1:]), strict=False
        )
        if left and right
    ):
        return False
    for downstream, upstream in zip(hops, hops[1:], strict=False):
        if not _domains_align(downstream.from_host, upstream.by_host):
            return False
    return True


def _add_authentication_findings(
    findings: list[Finding],
    authentication: Sequence[AuthenticationObservation],
    sender_domains: set[str],
    auth_conflicts: Sequence[AuthConflictObservation],
) -> None:
    for auth in authentication:
        outcome = auth.result.lower()
        if outcome in {"fail", "softfail", "neutral", "none", "permerror", "temperror"}:
            severity = SeverityValue.HIGH if outcome in {"fail", "permerror", "temperror"} else SeverityValue.MEDIUM
            points = 22 if outcome in {"fail", "permerror", "temperror"} else 8
            src = getattr(auth, "source", "authentication-results") or "authentication-results"
            findings.append(
                _finding(
                    f"auth.{auth.method}.{outcome}",
                    FindingCategory.AUTHENTICATION,
                    severity,
                    points,
                    f"Reported {auth.method.upper()} result is {outcome}; it was not independently verified.",
                    src,
                    evidence_refs=[f"{src}:{auth.method}={outcome}"],
                )
            )

    for conflict in auth_conflicts:
        refs = [f"{source}:{conflict.method}={outcome}" for source in conflict.sources for outcome in conflict.outcomes]
        findings.append(
            _finding(
                "auth.conflict",
                FindingCategory.AUTHENTICATION,
                SeverityValue.MEDIUM,
                16,
                conflict.explanation,
                "authentication",
                evidence_refs=refs or ["authentication"],
            )
        )

    # A reduction is awarded only when all three declared mechanisms pass, each
    # has a declaring host, and every available identity domain aligns with From.
    passed: dict[str, list[AuthenticationObservation]] = {}
    for auth in authentication:
        if auth.result.lower() == "pass" and auth.method.lower() in {"spf", "dkim", "dmarc"} and auth.declaring_host:
            passed.setdefault(auth.method.lower(), []).append(auth)
    aligned = all(
        any(
            (not item.domain or any(_domains_align(item.domain, sender) for sender in sender_domains))
            and any(_domains_align(item.declaring_host, sender) for sender in sender_domains)
            for item in items
        )
        for method, items in passed.items()
    )
    if {"spf", "dkim", "dmarc"}.issubset(passed) and aligned and not auth_conflicts:
        findings.append(
            _finding(
                "auth.aligned.pass",
                FindingCategory.AUTHENTICATION,
                SeverityValue.INFO,
                -15,
                (
                    "SPF, DKIM, and DMARC were all reported as passing with aligned declaring "
                    "domains; reports remain independently unverified."
                ),
                "authentication",
                evidence_refs=["authentication:spf=pass", "authentication:dkim=pass", "authentication:dmarc=pass"],
            )
        )


def score_findings(
    *,
    addresses: Sequence[AddressObservation],
    authentication: Sequence[AuthenticationObservation],
    received: Sequence[ReceivedHop],
    indicators: Sequence[IndicatorObservation],
    mime_parts: Sequence[MimePartObservation],
    warnings: Sequence[str],
    enrichment: Sequence[EnrichmentObservation],
    identity_observations: Sequence[IdentityObservation] = (),
    date_observations: Sequence[DateObservation] = (),
    message_id_observations: Sequence[MessageIdObservation] = (),
    content_indicators: Sequence[ContentIndicatorObservation] = (),
    link_mismatches: Sequence[LinkMismatchObservation] = (),
    routing_anomalies: Sequence[RoutingAnomalyObservation] = (),
    auth_conflicts: Sequence[AuthConflictObservation] = (),
    nested_messages: Sequence[NestedMessageObservation] = (),
) -> ScoreBreakdown:
    findings: list[Finding] = []
    sender_domains = _sender_domains(addresses)

    if len(sender_domains) > 1:
        matching_refs = sorted(
            f"{getattr(a, 'source', 'header')}:{getattr(a, 'domain', '')}"
            for a in addresses
            if getattr(a, "source", "").lower() in _SENDER_SOURCES and getattr(a, "domain", None)
        )[:20]
        findings.append(
            _finding(
                "sender.domain.mismatch",
                FindingCategory.HEADERS,
                SeverityValue.MEDIUM,
                18,
                "Message address fields contain multiple sender domains.",
                "headers",
                evidence_refs=matching_refs or ["headers"],
            )
        )

    _add_authentication_findings(findings, authentication, sender_domains, auth_conflicts)

    for observation in identity_observations:
        findings.append(
            _finding(
                "identity.display_name_spoofing",
                FindingCategory.HEADERS,
                SeverityValue.HIGH,
                25,
                observation.explanation,
                observation.source,
                evidence_refs=[
                    f"{observation.source}:display={observation.display_name[:80]}",
                    f"{observation.source}:address={observation.address[:120]}",
                ],
            )
        )

    for date_observation in date_observations:
        refs = [f"date:{item}" for item in date_observation.anomalies] or ["date"]
        for anomaly, rule, severity, points, text in (
            ("invalid_syntax", "header.date.invalid", SeverityValue.LOW, 8, "Date header syntax is invalid."),
            ("future_date", "date.future", SeverityValue.MEDIUM, 15, "Date header is materially in the future."),
            (
                "stale_date",
                "date.stale",
                SeverityValue.MEDIUM,
                12,
                "Date header is implausibly stale compared with routing timestamps.",
            ),
            (
                "routing_timestamp_mismatch",
                "date.routing_mismatch",
                SeverityValue.LOW,
                8,
                "Date header is inconsistent with routing timestamps.",
            ),
            (
                "missing_date",
                "header.date.missing",
                SeverityValue.INFO,
                0,
                "Message has no Date header; this is a neutral observation.",
            ),
        ):
            if anomaly in date_observation.anomalies and points != 0:
                findings.append(_finding(rule, FindingCategory.HEADERS, severity, points, text, "date", refs))

    for message_id_observation in message_id_observations:
        if "syntax_invalid" in message_id_observation.anomalies:
            findings.append(
                _finding(
                    "header.message_id.invalid",
                    FindingCategory.HEADERS,
                    SeverityValue.LOW,
                    8,
                    "Message-ID does not conform to the expected RFC 5322 syntax.",
                    "message-id",
                    ["message-id:syntax_invalid"],
                )
            )
        if "domain_mismatch" in message_id_observation.anomalies:
            findings.append(
                _finding(
                    "header.message_id.domain_mismatch",
                    FindingCategory.HEADERS,
                    SeverityValue.LOW,
                    8,
                    "Message-ID domain does not align with sender domains.",
                    "message-id",
                    ["message-id:domain_mismatch"],
                )
            )

    if any(h.parse_warning for h in received):
        bad_hops = sorted(f"received[{h.position}]" for h in received if h.parse_warning)[:20]
        findings.append(
            _finding(
                "routing.malformed",
                FindingCategory.ROUTING,
                SeverityValue.LOW,
                6,
                "One or more Received headers are incomplete.",
                "received",
                evidence_refs=bad_hops or ["received"],
            )
        )
    timestamps = [_to_utc(h.timestamp) for h in sorted(received, key=lambda hop: hop.position)]
    if any(left < right for left, right in zip(timestamps, timestamps[1:], strict=False) if left and right):
        findings.append(
            _finding(
                "routing.timestamp.order",
                FindingCategory.ROUTING,
                SeverityValue.MEDIUM,
                10,
                "Received timestamps are not in a consistent delivery order.",
                "received",
                evidence_refs=["received"],
            )
        )
    for routing_anomaly in routing_anomalies:
        if routing_anomaly.anomaly_type == "private_to_public_transition":
            rule, severity, points = "routing.transition.anomaly", SeverityValue.MEDIUM, 14
        elif routing_anomaly.anomaly_type == "latency_jump_48h":
            rule, severity, points = "routing.latency_jump", SeverityValue.LOW, 6
        elif routing_anomaly.anomaly_type == "missing_upstream_hops":
            rule, severity, points = "routing.missing_observation", SeverityValue.INFO, 0
        elif routing_anomaly.anomaly_type in {"truncated_hop", "discontinuous_hops", "missing_hops"}:
            rule, severity, points = "routing.chain.anomaly", SeverityValue.LOW, 6
        else:
            rule, severity, points = "routing.anomaly", SeverityValue.LOW, 4
        if points != 0:
            findings.append(
                _finding(
                    rule,
                    FindingCategory.ROUTING,
                    severity,
                    points,
                    routing_anomaly.explanation,
                    "received",
                    [f"received[{position}]" for position in routing_anomaly.hop_positions] or ["received"],
                )
            )
    if _is_consistent_routing(received) and not routing_anomalies:
        findings.append(
            _finding(
                "routing.verified_hops",
                FindingCategory.ROUTING,
                SeverityValue.INFO,
                -5,
                (
                    "All available routing hops form a complete, chronologically consistent chain; "
                    "no independent transport verification was performed."
                ),
                "received",
                evidence_refs=[f"received[{h.position}]" for h in received[:20]],
            )
        )

    for indicator in indicators:
        if getattr(indicator, "kind", None) == "url":
            val = getattr(indicator, "value", "")
            norm = getattr(indicator, "normalized_value", "")
            source = getattr(indicator, "source", "")
            val_authority = (
                val.split("://", 1)[-1].split("/", 1)[0].split("?", 1)[0].split("#", 1)[0] if "://" in val else ""
            )
            norm_authority = (
                norm.split("://", 1)[-1].split("/", 1)[0].split("?", 1)[0].split("#", 1)[0] if "://" in norm else ""
            )
            if "userinfo" in source or "@" in val_authority or "@" in norm_authority:
                findings.append(
                    _finding(
                        "url.userinfo",
                        FindingCategory.URL,
                        SeverityValue.HIGH,
                        20,
                        "A URL contains user-info before its host.",
                        source or "url",
                        evidence_refs=[norm[:200]] if norm else ["url"],
                    )
                )

    for content in content_indicators:
        if content.category == "credential_harvesting":
            rule, severity, points = "content.credential_harvesting", SeverityValue.HIGH, 22
        elif content.category == "urgent_language":
            rule, severity, points = "content.urgent_language", SeverityValue.MEDIUM, 8
        elif content.category == "financial_pressure":
            rule, severity, points = "content.financial_pressure", SeverityValue.MEDIUM, 10
        else:
            rule, severity, points = "content.indicator", SeverityValue.LOW, 4
        findings.append(
            _finding(
                rule,
                FindingCategory.CONTENT,
                severity,
                points,
                f"Deterministic content indicator detected: {content.category}.",
                content.source,
                [f"content:{content.category}:{content.matched_phrase}"],
            )
        )
    for mismatch in link_mismatches:
        findings.append(
            _finding(
                "content.link_text_mismatch",
                FindingCategory.CONTENT,
                SeverityValue.HIGH,
                28,
                mismatch.explanation,
                "html",
                [f"display:{mismatch.display_domain}", f"href:{mismatch.actual_domain}"],
            )
        )

    for part in mime_parts:
        if part.dangerous_extension:
            findings.append(
                _finding(
                    "attachment.dangerous_extension",
                    FindingCategory.ATTACHMENT,
                    SeverityValue.HIGH,
                    28,
                    "An attachment uses an executable or script-like extension.",
                    part.part_id,
                    [part.filename[:200]] if part.filename else [part.part_id],
                )
            )
        if part.type_extension_mismatch:
            findings.append(
                _finding(
                    "attachment.type_mismatch",
                    FindingCategory.ATTACHMENT,
                    SeverityValue.MEDIUM,
                    12,
                    "Attachment metadata has a suspicious type/extension mismatch.",
                    part.part_id,
                    [part.filename[:200]] if part.filename else [part.part_id],
                )
            )
    if warnings:
        findings.append(
            _finding(
                "parser.defect",
                FindingCategory.PARSER,
                SeverityValue.LOW,
                4,
                "The parser reported malformed message structure.",
                "parser",
                list(warnings[:20]),
            )
        )

    for enrichment_item in enrichment:
        reputation = (getattr(enrichment_item, "reputation", None) or "").lower()
        ind = getattr(enrichment_item, "indicator", "")
        prov = getattr(enrichment_item, "provider", "enrichment")
        details = getattr(enrichment_item, "details", None)
        if reputation == "malicious":
            abuse = str(prov).lower() == "abuseipdb" and (enrichment_item.score or 0) >= 80
            findings.append(
                _finding(
                    "enrichment.abuseipdb.malicious" if abuse else "enrichment.malicious",
                    FindingCategory.ENRICHMENT,
                    SeverityValue.HIGH,
                    30,
                    "An enabled reputation source marked an indicator malicious.",
                    str(prov),
                    [ind[:200]] if ind else [str(prov)],
                )
            )
        if details is not None:
            asn = str(getattr(details, "asn", "") or "").upper()
            category = str(getattr(details, "category", "") or "").lower().replace("-", "_")
            if (
                asn in _HIGH_RISK_ASNS
                or any(token in asn.lower() for token in ("highrisk", "bulletproof"))
                or category in {"high_risk", "bulletproof", "abusive"}
            ):
                findings.append(
                    _finding(
                        "enrichment.asn.high_risk",
                        FindingCategory.ENRICHMENT,
                        SeverityValue.MEDIUM,
                        18,
                        "Offline or live enrichment identifies a high-risk ASN or network category.",
                        str(prov),
                        [f"{ind[:120]}:asn={asn or category}"],
                    )
                )
            country = str(getattr(details, "country", "") or "").upper()
            if country in _HIGH_RISK_COUNTRIES:
                findings.append(
                    _finding(
                        "enrichment.country.high_risk",
                        FindingCategory.ENRICHMENT,
                        SeverityValue.LOW,
                        10,
                        "Enrichment places the indicator in a configured high-risk country set.",
                        str(prov),
                        [f"{ind[:120]}:country={country}"],
                    )
                )

    nested_malicious_count = 0
    nested_suspicious_count = 0
    for nested in nested_messages:
        if nested.verdict == VerdictValue.MALICIOUS:
            nested_malicious_count += 1
            points = 35 if nested_malicious_count == 1 else (5 if nested_malicious_count == 2 else 0)
            findings.append(
                _finding(
                    "nested.malicious_forwarded_message",
                    FindingCategory.CONTENT,
                    SeverityValue.MEDIUM,
                    points,
                    f"Nested message at MIME path '{nested.path}' was evaluated as malicious.",
                    "nested_message",
                    evidence_refs=[nested.path, f"verdict:{nested.verdict.value}"],
                )
            )
        elif nested.verdict == VerdictValue.SUSPICIOUS:
            nested_suspicious_count += 1
            points = 15 if (nested_malicious_count == 0 and nested_suspicious_count <= 2) else 0
            findings.append(
                _finding(
                    "nested.suspicious_forwarded_message",
                    FindingCategory.CONTENT,
                    SeverityValue.LOW,
                    points,
                    f"Nested message at MIME path '{nested.path}' was evaluated as suspicious.",
                    "nested_message",
                    evidence_refs=[nested.path, f"verdict:{nested.verdict.value}"],
                )
            )

    if len(findings) > MAX_FINDINGS:
        by_rule: dict[str, list[Finding]] = {}
        for item in findings:
            by_rule.setdefault(item.rule_id, []).append(item)
        for rule_items in by_rule.values():
            rule_items.sort(key=_finding_sort_key)
        selected: list[Finding] = []
        sorted_rules = sorted(
            by_rule.keys(), key=lambda rule: (-max(item.score_contribution for item in by_rule[rule]), rule)
        )
        round_idx = 0
        while len(selected) < MAX_FINDINGS:
            active_rules = [rule for rule in sorted_rules if round_idx < len(by_rule[rule])]
            if not active_rules:
                break
            for rule in active_rules:
                selected.append(by_rule[rule][round_idx])
                if len(selected) == MAX_FINDINGS:
                    break
            round_idx += 1
        findings = selected

    findings.sort(key=_finding_sort_key)
    final = max(0, min(100, sum(item.score_contribution for item in findings)))
    return ScoreBreakdown(base_score=0, contributions=findings, final_score=final)


def verdict_for(score: int) -> VerdictValue:
    if score >= 70:
        return VerdictValue.MALICIOUS
    if score >= 35:
        return VerdictValue.SUSPICIOUS
    if score <= 10:
        return VerdictValue.BENIGN
    return VerdictValue.UNKNOWN


def confidence_for(*, part_count: int, warnings: list[str], enrichment_count: int, indicator_count: int) -> float:
    coverage = 0.5
    if part_count:
        coverage += 0.2
    if indicator_count:
        coverage += 0.15
    if enrichment_count:
        coverage += 0.1
    if warnings:
        coverage -= min(0.2, len(warnings) * 0.02)
    return round(max(0.0, min(1.0, coverage)), 3)
