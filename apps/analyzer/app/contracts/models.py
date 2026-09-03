"""Forensic analyzer public contract models and schemas.

NULL VS. EMPTY-COLLECTION CONVENTION:
1. Collections (lists/arrays):
   - All collection fields are strictly typed as non-null lists (e.g., `list[HeaderObservation]`).
   - When no data is present, collections MUST be represented as empty lists (`[]`), NEVER `null`.
   - Passing `null` / `None` for any collection field is rejected with a validation error.
   - Omitted collection fields default to empty lists (`[]`).
2. Optional scalar fields / sub-objects:
   - Optional scalar fields (e.g., `filename`, `domain`, `phase`, `failure`) use `None` (`null` in JSON) when absent.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel


def validate_utc_iso8601(v: datetime) -> datetime:
    """Validate that a datetime is timezone-aware and has a UTC offset."""
    if v.tzinfo is None:
        raise ValueError("Timestamp must be timezone-aware (expected UTC ISO 8601)")
    offset = v.utcoffset()
    if offset is None or offset.total_seconds() != 0:
        raise ValueError("Timestamp must have UTC offset (Z or +00:00)")
    return v


def validate_hop_timestamp(v: datetime | None) -> datetime | None:
    """Validate that a timestamp is timezone-aware and normalize to UTC."""
    if v is None:
        return None
    if v.tzinfo is None or v.utcoffset() is None:
        raise ValueError("Timestamp must be timezone-aware")
    return v.astimezone(UTC)


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class AnalysisStatusValue(StrEnum):
    ACCEPTED = "accepted"
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    DEFERRED = "deferred"
    FAILED = "failed"


class AnalysisPhase(StrEnum):
    QUEUED = "queued"
    FETCHING_EVIDENCE = "fetching_evidence"
    PARSING = "parsing"
    EXTRACTING = "extracting"
    ENRICHING = "enriching"
    SCORING = "scoring"
    COMPLETED = "completed"
    FAILED = "failed"


class VerdictValue(StrEnum):
    UNKNOWN = "unknown"
    BENIGN = "benign"
    SUSPICIOUS = "suspicious"
    MALICIOUS = "malicious"


class SeverityValue(StrEnum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class FindingCategory(StrEnum):
    HEADERS = "headers"
    AUTHENTICATION = "authentication"
    ROUTING = "routing"
    URL = "url"
    DOMAIN = "domain"
    IP = "ip"
    ATTACHMENT = "attachment"
    CONTENT = "content"
    PARSER = "parser"
    ENRICHMENT = "enrichment"


class DigestAlgorithm(StrEnum):
    SHA256 = "sha256"
    SHA384 = "sha384"
    SHA512 = "sha512"


class AnalysisFailureCode(StrEnum):
    INTAKE_INVALID = "intake_invalid"
    EVIDENCE_NOT_FOUND = "evidence_not_found"
    EVIDENCE_TOO_LARGE = "evidence_too_large"
    EVIDENCE_DIGEST_MISMATCH = "evidence_digest_mismatch"
    EVIDENCE_SIZE_MISMATCH = "evidence_size_mismatch"
    EVIDENCE_STORAGE_UNAVAILABLE = "evidence_storage_unavailable"
    MESSAGE_INVALID = "message_invalid"
    HEADER_LIMIT_EXCEEDED = "header_limit_exceeded"
    MIME_LIMIT_EXCEEDED = "mime_limit_exceeded"
    ATTACHMENT_LIMIT_EXCEEDED = "attachment_limit_exceeded"
    ANALYSIS_RUN_NOT_FOUND = "analysis_run_not_found"
    ANALYSIS_FAILED = "analysis_failed"
    INTERNAL_ERROR = "internal_error"


class Artifact(ContractModel):
    object_key: str = Field(
        min_length=1,
        max_length=500,
        pattern=r"^organizations/[A-Za-z0-9_-]+/cases/[A-Za-z0-9_-]+/artifacts/[A-Za-z0-9_-]+\.eml$",
    )
    sha256: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-fA-F]{64}$",
    )
    byte_size: int = Field(gt=0, le=50_000_000)
    digest_algorithm: DigestAlgorithm = DigestAlgorithm.SHA256


class AnalysisIntakeRequest(ContractModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "caseId": "case_01",
                    "organizationId": "org_01",
                    "analysisRunId": "run_01",
                    "artifact": {
                        "objectKey": "organizations/org_01/cases/case_01/artifacts/artifact_01.eml",
                        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "byteSize": 24831,
                        "digestAlgorithm": "sha256",
                    },
                    "requestedAt": "2026-01-01T00:00:00Z",
                }
            ]
        },
    )
    case_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")
    organization_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")
    analysis_run_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")
    artifact: Artifact
    requested_at: datetime

    @field_validator("requested_at")
    @classmethod
    def validate_intake_timestamp(cls, v: datetime) -> datetime:
        return validate_utc_iso8601(v)

    @model_validator(mode="after")
    def artifact_matches_scope(self) -> AnalysisIntakeRequest:
        expected_prefix = f"organizations/{self.organization_id}/cases/{self.case_id}/artifacts/"
        if not self.artifact.object_key.startswith(expected_prefix):
            raise ValueError("artifact object key does not match organization and case")
        return self


class AnalysisIntakeAccepted(ContractModel):
    analysis_run_id: str = Field(min_length=1, max_length=160)
    status: AnalysisStatusValue = AnalysisStatusValue.ACCEPTED


class AnalysisFailure(ContractModel):
    code: AnalysisFailureCode
    message: str = Field(min_length=1, max_length=500)
    request_id: str | None = Field(default=None, min_length=1, max_length=120)
    retryable: bool = False


class AnalysisStatus(ContractModel):
    analysis_run_id: str = Field(min_length=1, max_length=160)
    status: AnalysisStatusValue
    phase: AnalysisPhase | None = None
    progress: int | None = Field(default=None, ge=0, le=100)
    failure: AnalysisFailure | None = None


class AddressObservation(ContractModel):
    value: str = Field(min_length=1, max_length=320)
    address: str | None = Field(default=None, max_length=320)
    display_name: str | None = Field(default=None, max_length=320)
    domain: str | None = Field(default=None, max_length=253)
    source: str = Field(min_length=1, max_length=80)


class HeaderObservation(ContractModel):
    name: str = Field(min_length=1, max_length=80)
    value: str = Field(max_length=2000)
    occurrence: int = Field(ge=1, le=10000)
    malformed: bool = False


class ReceivedHop(ContractModel):
    position: int = Field(ge=1, le=1000)
    from_host: str | None = Field(default=None, max_length=253)
    by_host: str | None = Field(default=None, max_length=253)
    source_ip: str | None = Field(default=None, max_length=45)
    timestamp: datetime | None = None
    private_source: bool | None = None
    parse_warning: str | None = Field(default=None, max_length=200)
    latency_jump_seconds: int | None = Field(default=None, ge=0, le=2_147_483_647)
    private_to_public: bool | None = None

    @field_validator("timestamp")
    @classmethod
    def validate_hop_ts(cls, v: datetime | None) -> datetime | None:
        return validate_hop_timestamp(v)


class AuthenticationObservation(ContractModel):
    method: str = Field(min_length=1, max_length=30)
    result: str = Field(min_length=1, max_length=40)
    declaring_host: str | None = Field(default=None, max_length=253)
    reason: str | None = Field(default=None, max_length=500)
    source: str = Field(default="authentication-results", min_length=1, max_length=80)
    independently_verified: bool = False
    domain: str | None = Field(default=None, max_length=253)
    signing_domain: str | None = Field(default=None, max_length=253)
    selector: str | None = Field(default=None, max_length=100)
    algorithm: str | None = Field(default=None, max_length=50)
    identity: str | None = Field(default=None, max_length=320)
    signed_headers: list[str] = Field(default_factory=list, max_length=100)


class IdentityObservation(ContractModel):
    source: str = Field(min_length=1, max_length=80)
    display_name: str = Field(max_length=320)
    address: str = Field(max_length=320)
    claimed_identity: str = Field(max_length=320)
    inconsistency_type: str = Field(min_length=1, max_length=80)
    explanation: str = Field(min_length=1, max_length=500)


class DateObservation(ContractModel):
    raw_value: str | None = Field(default=None, max_length=200)
    parsed_date: datetime | None = None
    is_valid: bool = False
    anomalies: list[str] = Field(default_factory=list, max_length=50)
    details: str | None = Field(default=None, max_length=500)

    @property
    def parsed_at(self) -> datetime | None:
        return self.parsed_date

    @property
    def valid(self) -> bool:
        return self.is_valid

    @property
    def future(self) -> bool:
        return "future_date" in self.anomalies

    @property
    def stale(self) -> bool:
        return "stale_date" in self.anomalies

    @property
    def routing_mismatch(self) -> bool:
        return "routing_timestamp_mismatch" in self.anomalies

    @field_validator("parsed_date")
    @classmethod
    def validate_date_ts(cls, v: datetime | None) -> datetime | None:
        return validate_hop_timestamp(v)


class MessageIdObservation(ContractModel):
    raw_value: str | None = Field(default=None, max_length=500)
    message_id: str | None = Field(default=None, max_length=500)
    domain: str | None = Field(default=None, max_length=253)
    is_valid_syntax: bool = False
    aligned_with_sender: bool = False
    sender_domains: list[str] = Field(default_factory=list, max_length=50)
    anomalies: list[str] = Field(default_factory=list, max_length=50)
    details: str | None = Field(default=None, max_length=500)

    @property
    def value(self) -> str:
        return self.raw_value or self.message_id or ""

    @property
    def normalized_value(self) -> str | None:
        return self.message_id

    @property
    def valid(self) -> bool:
        return self.is_valid_syntax

    @property
    def aligned(self) -> bool:
        return self.aligned_with_sender


class ContentIndicatorObservation(ContractModel):
    category: str = Field(min_length=1, max_length=50)
    matched_phrase: str = Field(min_length=1, max_length=100)
    snippet: str = Field(min_length=1, max_length=200)
    source: str = Field(min_length=1, max_length=50)


class LinkMismatchObservation(ContractModel):
    display_text: str = Field(min_length=1, max_length=200)
    display_domain: str = Field(min_length=1, max_length=253)
    actual_href: str = Field(min_length=1, max_length=500)
    actual_domain: str = Field(min_length=1, max_length=253)
    explanation: str = Field(min_length=1, max_length=500)


class RoutingAnomalyObservation(ContractModel):
    anomaly_type: str = Field(min_length=1, max_length=80)
    hop_positions: list[int] = Field(default_factory=list, max_length=20)
    explanation: str = Field(min_length=1, max_length=500)
    details: str | None = Field(default=None, max_length=500)


class AuthConflictObservation(ContractModel):
    method: str = Field(min_length=1, max_length=30)
    outcomes: list[str] = Field(default_factory=list, max_length=20)
    sources: list[str] = Field(default_factory=list, max_length=20)
    explanation: str = Field(min_length=1, max_length=500)


class MimePartObservation(ContractModel):
    part_id: str = Field(min_length=1, max_length=80)
    content_type: str = Field(min_length=1, max_length=120)
    byte_size: int = Field(ge=0, le=100_000_000)
    disposition: str | None = Field(default=None, max_length=80)
    filename: str | None = Field(default=None, max_length=320)
    is_attachment: bool = False
    sha256: str | None = Field(default=None, min_length=64, max_length=64, pattern=r"^[0-9a-fA-F]{64}$")
    digest_algorithm: DigestAlgorithm | None = None
    dangerous_extension: bool = False
    type_extension_mismatch: bool = False

    @model_validator(mode="after")
    def sync_digest_algorithm(self) -> MimePartObservation:
        if self.sha256 is not None and self.digest_algorithm is None:
            self.digest_algorithm = DigestAlgorithm.SHA256
        elif self.sha256 is None and self.digest_algorithm is not None:
            raise ValueError("digest_algorithm provided without sha256 digest")
        return self


class IndicatorObservation(ContractModel):
    kind: str = Field(min_length=1, max_length=30)
    value: str = Field(min_length=1, max_length=2000)
    normalized_value: str = Field(min_length=1, max_length=2000)
    source: str = Field(min_length=1, max_length=100)
    private_or_reserved: bool | None = None


class EnrichmentDetails(ContractModel):
    deterministic: bool | None = None
    category: str | None = Field(default=None, max_length=100)
    dns_records: list[str] = Field(default_factory=list, max_length=50)
    asn: str | None = Field(default=None, max_length=100)
    country: str | None = Field(default=None, max_length=2)
    raw_score: int | None = Field(default=None, ge=0, le=1000)


class EnrichmentObservation(ContractModel):
    indicator: str = Field(min_length=1, max_length=2000)
    provider: str = Field(min_length=1, max_length=80)
    mode: str = Field(min_length=1, max_length=20)
    reputation: str | None = Field(default=None, max_length=40)
    score: int | None = Field(default=None, ge=0, le=100)
    timestamp: datetime | None = None
    details: EnrichmentDetails = Field(default_factory=EnrichmentDetails)

    @field_validator("timestamp")
    @classmethod
    def validate_enrichment_ts(cls, v: datetime | None) -> datetime | None:
        return validate_hop_timestamp(v)


MAX_HEADERS: int = 1000
MAX_ADDRESSES: int = 100
MAX_RECEIVED_HOPS: int = 200
MAX_AUTHENTICATION: int = 100
MAX_MIME_PARTS: int = 200
MAX_INDICATORS: int = 1000
MAX_ENRICHMENT: int = 1000
MAX_PARSER_WARNINGS: int = 200
MAX_FINDINGS: int = 500
MAX_NESTED_MESSAGES: int = 10
MAX_CONTAINER_MESSAGES: int = 500


class Finding(ContractModel):
    rule_id: str = Field(min_length=1, max_length=100)
    category: FindingCategory
    severity: SeverityValue
    score_contribution: int = Field(ge=-100, le=100)
    explanation: str = Field(min_length=1, max_length=500)
    evidence_refs: list[str] = Field(default_factory=list, max_length=20)
    source: str = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_evidence_refs_and_source(self) -> Finding:
        if self.score_contribution != 0:
            if not self.evidence_refs:
                if "evidence_refs" in self.model_fields_set:
                    raise ValueError("Nonzero findings require at least one evidence reference")
                if self.source:
                    self.evidence_refs = [self.source]
                else:
                    raise ValueError("Nonzero findings require at least one evidence reference")
        return self


class ScoreBreakdown(ContractModel):
    base_score: int = Field(ge=0, le=100)
    contributions: list[Finding] = Field(default_factory=list, max_length=MAX_FINDINGS)
    final_score: int = Field(ge=0, le=100)

    @model_validator(mode="after")
    def validate_score_consistency(self) -> ScoreBreakdown:
        expected = max(0, min(100, self.base_score + sum(c.score_contribution for c in self.contributions)))
        if self.final_score != expected:
            raise ValueError(
                f"final_score ({self.final_score}) must equal "
                f"base_score + contributions clamped to [0, 100] ({expected})"
            )
        return self


class NestedMessageObservation(ContractModel):
    path: str = Field(min_length=1, max_length=80)
    depth: int = Field(ge=1, le=10)
    sha256: str | None = Field(default=None, min_length=64, max_length=64, pattern=r"^[0-9a-fA-F]{64}$")
    byte_size: int | None = Field(default=None, ge=0)
    headers: list[HeaderObservation] = Field(default_factory=list, max_length=MAX_HEADERS)
    addresses: list[AddressObservation] = Field(default_factory=list, max_length=MAX_ADDRESSES)
    received_hops: list[ReceivedHop] = Field(default_factory=list, max_length=MAX_RECEIVED_HOPS)
    authentication: list[AuthenticationObservation] = Field(default_factory=list, max_length=MAX_AUTHENTICATION)
    mime_parts: list[MimePartObservation] = Field(default_factory=list, max_length=MAX_MIME_PARTS)
    indicators: list[IndicatorObservation] = Field(default_factory=list, max_length=MAX_INDICATORS)
    parser_warnings: list[str] = Field(default_factory=list, max_length=MAX_PARSER_WARNINGS)
    identity_observations: list[IdentityObservation] = Field(default_factory=list, max_length=MAX_ADDRESSES)
    date_observations: list[DateObservation] = Field(default_factory=list, max_length=MAX_HEADERS)
    message_id_observations: list[MessageIdObservation] = Field(default_factory=list, max_length=MAX_HEADERS)
    content_indicators: list[ContentIndicatorObservation] = Field(default_factory=list, max_length=MAX_INDICATORS)
    link_mismatches: list[LinkMismatchObservation] = Field(default_factory=list, max_length=MAX_INDICATORS)
    routing_anomalies: list[RoutingAnomalyObservation] = Field(default_factory=list, max_length=MAX_RECEIVED_HOPS)
    auth_conflicts: list[AuthConflictObservation] = Field(default_factory=list, max_length=MAX_AUTHENTICATION)
    findings: list[Finding] = Field(default_factory=list, max_length=MAX_FINDINGS)
    score: ScoreBreakdown
    verdict: VerdictValue


class AnalysisResult(ContractModel):
    schema_version: str = Field(default="1.2.0", min_length=1, max_length=20)
    ruleset_version: str = Field(default="v1.2.0", min_length=1, max_length=80)
    analysis_version: str = Field(min_length=1, max_length=80)
    analysis_run_id: str = Field(min_length=1, max_length=160)
    organization_id: str = Field(min_length=1, max_length=160)
    case_id: str = Field(min_length=1, max_length=160)
    artifact_sha256: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-fA-F]{64}$")
    artifact_byte_size: int = Field(gt=0, le=50_000_000)
    artifact_digest_algorithm: DigestAlgorithm = DigestAlgorithm.SHA256
    headers: list[HeaderObservation] = Field(default_factory=list, max_length=MAX_HEADERS)
    addresses: list[AddressObservation] = Field(default_factory=list, max_length=MAX_ADDRESSES)
    received_hops: list[ReceivedHop] = Field(default_factory=list, max_length=MAX_RECEIVED_HOPS)
    authentication: list[AuthenticationObservation] = Field(default_factory=list, max_length=MAX_AUTHENTICATION)
    mime_parts: list[MimePartObservation] = Field(default_factory=list, max_length=MAX_MIME_PARTS)
    indicators: list[IndicatorObservation] = Field(default_factory=list, max_length=MAX_INDICATORS)
    enrichment: list[EnrichmentObservation] = Field(default_factory=list, max_length=MAX_ENRICHMENT)
    parser_warnings: list[str] = Field(default_factory=list, max_length=MAX_PARSER_WARNINGS)
    identity_observations: list[IdentityObservation] = Field(default_factory=list, max_length=MAX_ADDRESSES)
    date_observations: list[DateObservation] = Field(default_factory=list, max_length=MAX_HEADERS)
    message_id_observations: list[MessageIdObservation] = Field(default_factory=list, max_length=MAX_HEADERS)
    content_indicators: list[ContentIndicatorObservation] = Field(default_factory=list, max_length=MAX_INDICATORS)
    link_mismatches: list[LinkMismatchObservation] = Field(default_factory=list, max_length=MAX_INDICATORS)
    routing_anomalies: list[RoutingAnomalyObservation] = Field(default_factory=list, max_length=MAX_RECEIVED_HOPS)
    auth_conflicts: list[AuthConflictObservation] = Field(default_factory=list, max_length=MAX_AUTHENTICATION)
    findings: list[Finding] = Field(default_factory=list, max_length=MAX_FINDINGS)
    score: ScoreBreakdown
    verdict: VerdictValue
    confidence: float = Field(ge=0.0, le=1.0)
    analyzed_at: datetime
    container_suspected: bool = False
    nested_messages: list[NestedMessageObservation] = Field(default_factory=list, max_length=MAX_NESTED_MESSAGES)

    @field_validator("analyzed_at")
    @classmethod
    def validate_result_timestamp(cls, v: datetime) -> datetime:
        return validate_utc_iso8601(v)

    @model_validator(mode="after")
    def validate_result_invariants(self) -> AnalysisResult:
        score = self.score.final_score
        expected_verdict = (
            VerdictValue.MALICIOUS
            if score >= 70
            else VerdictValue.SUSPICIOUS
            if score >= 35
            else VerdictValue.BENIGN
            if score <= 10
            else VerdictValue.UNKNOWN
        )
        if self.verdict != expected_verdict:
            raise ValueError(
                f"Verdict '{self.verdict}' is inconsistent with score {score} (expected '{expected_verdict}')"
            )

        for finding in self.findings:
            if finding.score_contribution != 0 and not finding.evidence_refs:
                raise ValueError(
                    f"Finding '{finding.rule_id}' has nonzero contribution "
                    f"{finding.score_contribution} but no evidence references"
                )

        if len(self.findings) != len(self.score.contributions):
            raise ValueError(
                f"Result findings count ({len(self.findings)}) does not match "
                f"score contributions count ({len(self.score.contributions)})"
            )
        return self


class ContainerFormat(StrEnum):
    MBOX = "mbox"
    BARE_CONCATENATION = "bare_concatenation"
    MULTIPART_DIGEST = "multipart/digest"
    SINGLE = "single"


class ContainerMessageSummary(ContractModel):
    from_address: str | None = Field(default=None, max_length=320)
    from_display_name: str | None = Field(default=None, max_length=320)
    subject: str | None = Field(default=None, max_length=500)
    date: datetime | None = None
    message_id: str | None = Field(default=None, max_length=500)

    @field_validator("date")
    @classmethod
    def validate_summary_date(cls, v: datetime | None) -> datetime | None:
        return validate_hop_timestamp(v)


class ContainerSegment(ContractModel):
    index: int = Field(ge=0, le=100_000)
    byte_offset: int = Field(ge=0)
    byte_length: int = Field(gt=0)
    sha256: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-fA-F]{64}$")
    summary: ContainerMessageSummary = Field(default_factory=ContainerMessageSummary)


class SegmentationResult(ContractModel):
    container_format: ContainerFormat
    message_count: int = Field(ge=0)
    segments: list[ContainerSegment] = Field(default_factory=list)


class SegmentationRequest(ContractModel):
    case_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")
    organization_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")
    evidence_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")
    object_key: str = Field(
        min_length=1,
        max_length=500,
        pattern=r"^organizations/[A-Za-z0-9_-]+/cases/[A-Za-z0-9_-]+/artifacts/[A-Za-z0-9_-]+(?:\.[a-zA-Z0-9]+)?$",
    )
    sha256: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-fA-F]{64}$",
    )
    byte_size: int = Field(gt=0, le=536_870_912)

    @model_validator(mode="after")
    def artifact_matches_scope(self) -> SegmentationRequest:
        expected_prefix = f"organizations/{self.organization_id}/cases/{self.case_id}/artifacts/"
        if not self.object_key.startswith(expected_prefix):
            raise ValueError("artifact object key does not match organization and case")
        return self


AnalysisStatus.model_rebuild()
NestedMessageObservation.model_rebuild()
AnalysisResult.model_rebuild()
ContainerMessageSummary.model_rebuild()
ContainerSegment.model_rebuild()
SegmentationResult.model_rebuild()
SegmentationRequest.model_rebuild()

# Compatibility aliases for integrations that use generic observation names.
ContentObservation = ContentIndicatorObservation
RoutingObservation = RoutingAnomalyObservation
