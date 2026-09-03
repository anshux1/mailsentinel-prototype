import json
from datetime import UTC, timedelta
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from app.contracts.models import (
    AddressObservation,
    AnalysisFailure,
    AnalysisFailureCode,
    AnalysisIntakeAccepted,
    AnalysisIntakeRequest,
    AnalysisResult,
    AnalysisStatus,
    Artifact,
    AuthConflictObservation,
    AuthenticationObservation,
    ContentIndicatorObservation,
    DateObservation,
    DigestAlgorithm,
    EnrichmentDetails,
    EnrichmentObservation,
    Finding,
    HeaderObservation,
    IdentityObservation,
    IndicatorObservation,
    LinkMismatchObservation,
    MessageIdObservation,
    MimePartObservation,
    ReceivedHop,
    RoutingAnomalyObservation,
    ScoreBreakdown,
    VerdictValue,
)
from app.contracts.openapi import build_analyzer_openapi
from app.main import app

FIXTURES = Path(__file__).parents[3] / "packages" / "fixtures" / "contracts"
GENERATED = Path(__file__).parents[3] / "packages" / "contracts" / "generated"

MODELS: dict[str, type[BaseModel]] = {
    "AnalysisIntakeRequest": AnalysisIntakeRequest,
    "AnalysisIntakeAccepted": AnalysisIntakeAccepted,
    "AnalysisStatus": AnalysisStatus,
    "AnalysisFailure": AnalysisFailure,
    "Artifact": Artifact,
    "AddressObservation": AddressObservation,
    "HeaderObservation": HeaderObservation,
    "ReceivedHop": ReceivedHop,
    "AuthenticationObservation": AuthenticationObservation,
    "MimePartObservation": MimePartObservation,
    "IndicatorObservation": IndicatorObservation,
    "EnrichmentDetails": EnrichmentDetails,
    "EnrichmentObservation": EnrichmentObservation,
    "IdentityObservation": IdentityObservation,
    "DateObservation": DateObservation,
    "MessageIdObservation": MessageIdObservation,
    "ContentIndicatorObservation": ContentIndicatorObservation,
    "LinkMismatchObservation": LinkMismatchObservation,
    "RoutingAnomalyObservation": RoutingAnomalyObservation,
    "AuthConflictObservation": AuthConflictObservation,
    "Finding": Finding,
    "ScoreBreakdown": ScoreBreakdown,
    "AnalysisResult": AnalysisResult,
}


def test_valid_contract_examples() -> None:
    examples = json.loads((FIXTURES / "analyzer.valid.json").read_text())
    for name, model in MODELS.items():
        assert name in examples, f"Missing valid fixture for {name}"
        instance = model.model_validate(examples[name])
        assert instance is not None


def test_invalid_contract_examples() -> None:
    examples = json.loads((FIXTURES / "analyzer.invalid.json").read_text())
    for name, model in MODELS.items():
        assert name in examples, f"Missing invalid fixture for {name}"
        with pytest.raises(ValidationError):
            model.model_validate(examples[name])


def test_round_trip_serialization() -> None:
    examples = json.loads((FIXTURES / "analyzer.valid.json").read_text())
    for name, model in MODELS.items():
        original = model.model_validate(examples[name])
        dumped = original.model_dump(by_alias=True, mode="json")
        restored = model.model_validate(dumped)
        assert restored == original, f"Round-trip mismatch for {name}"


def test_camel_case_alias_and_snake_case_compatibility() -> None:
    examples = json.loads((FIXTURES / "analyzer.valid.json").read_text())
    result_data = examples["AnalysisResult"]
    result = AnalysisResult.model_validate(result_data)

    dumped = result.model_dump(by_alias=True, mode="json")
    assert "schemaVersion" in dumped
    assert "rulesetVersion" in dumped
    assert "analysisVersion" in dumped
    assert "analysisRunId" in dumped
    assert "artifactSha256" in dumped
    assert "artifactByteSize" in dumped
    assert "artifactDigestAlgorithm" in dumped
    assert "receivedHops" in dumped
    assert "mimeParts" in dumped
    assert "parserWarnings" in dumped
    assert "identityObservations" in dumped
    assert "dateObservations" in dumped
    assert "messageIdObservations" in dumped
    assert "contentIndicators" in dumped
    assert "linkMismatches" in dumped
    assert "routingAnomalies" in dumped
    assert "authConflicts" in dumped

    # Accepts snake_case when populate_by_name is enabled
    snake_case_finding = {
        "rule_id": "rule_01",
        "category": "headers",
        "severity": "low",
        "score_contribution": 10,
        "explanation": "Test explanation",
        "evidence_refs": ["test_ref"],
        "source": "test_source",
    }
    validated = Finding.model_validate(snake_case_finding)
    assert validated.rule_id == "rule_01"
    assert validated.score_contribution == 10


def test_artifact_key_must_match_request_scope() -> None:
    with pytest.raises(ValidationError, match="does not match organization and case"):
        AnalysisIntakeRequest.model_validate(
            {
                "caseId": "case_01",
                "organizationId": "org_01",
                "analysisRunId": "run_01",
                "artifact": {
                    "objectKey": "organizations/org_other/cases/case_01/artifacts/artifact_01.eml",
                    "sha256": "a" * 64,
                    "byteSize": 1,
                },
                "requestedAt": "2026-01-01T00:00:00Z",
            }
        )


def test_utc_timestamp_validation() -> None:
    examples = json.loads((FIXTURES / "analyzer.valid.json").read_text())
    intake_base = examples["AnalysisIntakeRequest"]

    # Naive timestamp string is rejected
    with pytest.raises(ValidationError, match="Timestamp must be timezone-aware"):
        bad_naive = dict(intake_base, requestedAt="2026-01-01T00:00:00")
        AnalysisIntakeRequest.model_validate(bad_naive)

    # Non-UTC offset is rejected for intake
    with pytest.raises(ValidationError, match="Timestamp must have UTC offset"):
        bad_offset = dict(intake_base, requestedAt="2026-01-01T05:00:00+05:00")
        AnalysisIntakeRequest.model_validate(bad_offset)

    # Valid UTC ISO 8601 strings pass
    good_z = dict(intake_base, requestedAt="2026-01-01T00:00:00Z")
    assert AnalysisIntakeRequest.model_validate(good_z).requested_at.tzinfo == UTC

    good_zero = dict(intake_base, requestedAt="2026-01-01T00:00:00+00:00")
    assert AnalysisIntakeRequest.model_validate(good_zero).requested_at.tzinfo == UTC

    # ReceivedHop normalizes aware timestamps with offsets to UTC
    hop = ReceivedHop.model_validate({"position": 1, "timestamp": "2026-01-01T05:00:00+05:00"})
    assert hop.timestamp is not None
    assert hop.timestamp.utcoffset() == timedelta(0)
    assert hop.timestamp.hour == 0

    # ReceivedHop rejects naive timestamps
    with pytest.raises(ValidationError, match="Timestamp must be timezone-aware"):
        ReceivedHop.model_validate({"position": 1, "timestamp": "2026-01-01T00:00:00"})


def test_sha256_and_digest_algorithm_semantics() -> None:
    # Valid hex and algorithm
    artifact = Artifact.model_validate(
        {
            "objectKey": "organizations/o/cases/c/artifacts/a.eml",
            "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "byteSize": 100,
            "digestAlgorithm": "sha256",
        }
    )
    assert artifact.digest_algorithm == DigestAlgorithm.SHA256

    # 63 characters (too short)
    with pytest.raises(ValidationError):
        Artifact.model_validate(
            {
                "objectKey": "organizations/o/cases/c/artifacts/a.eml",
                "sha256": "a" * 63,
                "byteSize": 100,
            }
        )

    # 65 characters (too long)
    with pytest.raises(ValidationError):
        Artifact.model_validate(
            {
                "objectKey": "organizations/o/cases/c/artifacts/a.eml",
                "sha256": "a" * 65,
                "byteSize": 100,
            }
        )

    # Non-hex characters
    with pytest.raises(ValidationError):
        Artifact.model_validate(
            {
                "objectKey": "organizations/o/cases/c/artifacts/a.eml",
                "sha256": "g" * 64,
                "byteSize": 100,
            }
        )

    # MimePart auto-populates digestAlgorithm when sha256 is present
    part = MimePartObservation.model_validate(
        {"partId": "p0", "contentType": "application/octet-stream", "byteSize": 50, "sha256": "a" * 64}
    )
    assert part.digest_algorithm == DigestAlgorithm.SHA256

    # MimePart rejects digestAlgorithm when sha256 is absent
    with pytest.raises(ValidationError, match="digest_algorithm provided without sha256"):
        MimePartObservation.model_validate(
            {
                "partId": "p0",
                "contentType": "text/plain",
                "byteSize": 50,
                "sha256": None,
                "digestAlgorithm": "sha256",
            }
        )


def test_numeric_boundaries() -> None:
    valid_finding_neg = {
        "ruleId": "r",
        "category": "headers",
        "severity": "low",
        "scoreContribution": -100,
        "explanation": "e",
        "source": "s",
        "evidenceRefs": ["s"],
    }
    Finding.model_validate(valid_finding_neg)

    valid_finding_pos = {
        "ruleId": "r",
        "category": "headers",
        "severity": "low",
        "scoreContribution": 100,
        "explanation": "e",
        "source": "s",
        "evidenceRefs": ["s"],
    }
    Finding.model_validate(valid_finding_pos)

    with pytest.raises(ValidationError):
        Finding.model_validate(
            {
                "ruleId": "r",
                "category": "headers",
                "severity": "low",
                "scoreContribution": -101,
                "explanation": "e",
                "source": "s",
            }
        )
    with pytest.raises(ValidationError):
        Finding.model_validate(
            {
                "ruleId": "r",
                "category": "headers",
                "severity": "low",
                "scoreContribution": 101,
                "explanation": "e",
                "source": "s",
            }
        )

    # Confidence bounds (0.0 to 1.0)
    examples = json.loads((FIXTURES / "analyzer.valid.json").read_text())
    valid_result = examples["AnalysisResult"]
    assert AnalysisResult.model_validate(dict(valid_result, confidence=0.0)).confidence == 0.0
    assert AnalysisResult.model_validate(dict(valid_result, confidence=1.0)).confidence == 1.0

    with pytest.raises(ValidationError):
        AnalysisResult.model_validate(dict(valid_result, confidence=-0.01))
    with pytest.raises(ValidationError):
        AnalysisResult.model_validate(dict(valid_result, confidence=1.01))

    # Progress bounds (0 to 100)
    assert AnalysisStatus.model_validate({"analysisRunId": "r", "status": "processing", "progress": 0}).progress == 0
    p100 = AnalysisStatus.model_validate({"analysisRunId": "r", "status": "processing", "progress": 100})
    assert p100.progress == 100
    with pytest.raises(ValidationError):
        AnalysisStatus.model_validate({"analysisRunId": "r", "status": "processing", "progress": -1})
    with pytest.raises(ValidationError):
        AnalysisStatus.model_validate({"analysisRunId": "r", "status": "processing", "progress": 101})

    # Occurrence boundary (ge=1)
    assert HeaderObservation.model_validate({"name": "Subject", "value": "v", "occurrence": 1}).occurrence == 1
    with pytest.raises(ValidationError):
        HeaderObservation.model_validate({"name": "Subject", "value": "v", "occurrence": 0})


def test_cross_field_nonzero_finding_requires_evidence() -> None:
    # Explicitly empty evidenceRefs with nonzero score contribution must fail
    with pytest.raises(ValidationError, match="Nonzero findings require at least one evidence reference"):
        Finding.model_validate(
            {
                "ruleId": "r",
                "category": "headers",
                "severity": "low",
                "scoreContribution": 15,
                "explanation": "e",
                "source": "headers",
                "evidenceRefs": [],
            }
        )

    # Nonzero finding omitting evidenceRefs auto-populates from source
    f = Finding.model_validate(
        {
            "ruleId": "r",
            "category": "headers",
            "severity": "low",
            "scoreContribution": 15,
            "explanation": "e",
            "source": "headers",
        }
    )
    assert f.evidence_refs == ["headers"]

    # Zero score contribution with empty evidenceRefs is allowed
    f_zero = Finding.model_validate(
        {
            "ruleId": "r",
            "category": "headers",
            "severity": "info",
            "scoreContribution": 0,
            "explanation": "e",
            "source": "headers",
            "evidenceRefs": [],
        }
    )
    assert f_zero.evidence_refs == []


def test_cross_field_verdict_score_consistency() -> None:
    examples = json.loads((FIXTURES / "analyzer.valid.json").read_text())
    base_result = examples["AnalysisResult"]

    malicious_finding = {
        "ruleId": "r",
        "category": "headers",
        "severity": "high",
        "scoreContribution": 75,
        "explanation": "e",
        "source": "s",
        "evidenceRefs": ["s"],
    }

    # Malicious requires score >= 70
    valid_malicious = dict(
        base_result,
        score={"baseScore": 0, "contributions": [malicious_finding], "finalScore": 75},
        findings=[malicious_finding],
        verdict="malicious",
    )
    assert AnalysisResult.model_validate(valid_malicious).verdict == VerdictValue.MALICIOUS

    with pytest.raises(ValidationError, match="Verdict 'benign' is inconsistent with score 75"):
        AnalysisResult.model_validate(dict(valid_malicious, verdict="benign"))

    with pytest.raises(ValidationError, match="Verdict 'suspicious' is inconsistent with score 75"):
        AnalysisResult.model_validate(dict(valid_malicious, verdict="suspicious"))

    # Benign requires score <= 10
    valid_benign = dict(
        base_result,
        score={"baseScore": 0, "contributions": [], "finalScore": 0},
        findings=[],
        verdict="benign",
    )
    assert AnalysisResult.model_validate(valid_benign).verdict == VerdictValue.BENIGN

    with pytest.raises(ValidationError, match="Verdict 'malicious' is inconsistent with score 0"):
        AnalysisResult.model_validate(dict(valid_benign, verdict="malicious"))

    # Suspicious is 35..69
    suspicious_finding = {
        "ruleId": "r",
        "category": "headers",
        "severity": "medium",
        "scoreContribution": 45,
        "explanation": "e",
        "source": "s",
        "evidenceRefs": ["s"],
    }
    valid_suspicious = dict(
        base_result,
        score={"baseScore": 0, "contributions": [suspicious_finding], "finalScore": 45},
        findings=[suspicious_finding],
        verdict="suspicious",
    )
    assert AnalysisResult.model_validate(valid_suspicious).verdict == VerdictValue.SUSPICIOUS

    # Unknown is 11..34
    unknown_finding = {
        "ruleId": "r",
        "category": "headers",
        "severity": "low",
        "scoreContribution": 20,
        "explanation": "e",
        "source": "s",
        "evidenceRefs": ["s"],
    }
    valid_unknown = dict(
        base_result,
        score={"baseScore": 0, "contributions": [unknown_finding], "finalScore": 20},
        findings=[unknown_finding],
        verdict="unknown",
    )
    assert AnalysisResult.model_validate(valid_unknown).verdict == VerdictValue.UNKNOWN


def test_cross_field_score_breakdown_consistency() -> None:
    # finalScore must match sum of contributions clamped to [0, 100]
    finding = {
        "ruleId": "r",
        "category": "headers",
        "severity": "low",
        "scoreContribution": 25,
        "explanation": "e",
        "source": "s",
        "evidenceRefs": ["s"],
    }
    valid_sb = ScoreBreakdown.model_validate({"baseScore": 0, "contributions": [finding], "finalScore": 25})
    assert valid_sb.final_score == 25

    with pytest.raises(ValidationError, match="final_score \\(50\\) must equal base_score \\+ contributions"):
        ScoreBreakdown.model_validate({"baseScore": 0, "contributions": [finding], "finalScore": 50})


def test_null_vs_empty_collection_convention() -> None:
    examples = json.loads((FIXTURES / "analyzer.valid.json").read_text())
    base_result = examples["AnalysisResult"]

    # Passing null for collection fields is strictly rejected
    with pytest.raises(ValidationError):
        AnalysisResult.model_validate(dict(base_result, headers=None))

    with pytest.raises(ValidationError):
        AnalysisResult.model_validate(dict(base_result, findings=None))

    with pytest.raises(ValidationError):
        AnalysisResult.model_validate(dict(base_result, mimeParts=None))

    with pytest.raises(ValidationError):
        AnalysisResult.model_validate(dict(base_result, parserWarnings=None))

    # Empty list [] is valid
    res = AnalysisResult.model_validate(dict(base_result, parserWarnings=[]))
    assert res.parser_warnings == []


def test_safe_typed_failure_codes() -> None:
    valid_failure = AnalysisFailure.model_validate(
        {"code": "evidence_not_found", "message": "Object missing", "requestId": "req_1"}
    )
    assert valid_failure.code == AnalysisFailureCode.EVIDENCE_NOT_FOUND

    with pytest.raises(ValidationError):
        AnalysisFailure.model_validate({"code": "unsafe_raw_exception", "message": "Crash"})


def test_no_public_dict_any() -> None:
    # EnrichmentDetails is a typed model, rejecting unconstrained dict types
    details = EnrichmentDetails.model_validate({"deterministic": True, "category": "phishing", "rawScore": 100})
    assert details.deterministic is True
    assert details.category == "phishing"

    observation = EnrichmentObservation.model_validate(
        {
            "indicator": "example.com",
            "provider": "fixture",
            "mode": "fixture",
            "details": {"deterministic": True},
        }
    )
    assert isinstance(observation.details, EnrichmentDetails)
    assert observation.details.deterministic is True


def test_openapi_drift() -> None:
    # Generated OpenAPI in packages/contracts/generated must match current export
    exported = build_analyzer_openapi(app)
    generated_file = GENERATED / "analyzer-openapi.json"
    assert generated_file.exists(), "analyzer-openapi.json does not exist"

    on_disk = json.loads(generated_file.read_text())
    assert exported == on_disk, "Drift detected between analyzer contract export and analyzer-openapi.json"
