import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.contracts.models import AnalysisFailure, AnalysisIntakeAccepted, AnalysisIntakeRequest, AnalysisStatus

FIXTURES = Path(__file__).parents[3] / "packages" / "fixtures" / "contracts"
MODELS = {
    "AnalysisIntakeRequest": AnalysisIntakeRequest,
    "AnalysisIntakeAccepted": AnalysisIntakeAccepted,
    "AnalysisStatus": AnalysisStatus,
    "AnalysisFailure": AnalysisFailure,
}


def test_valid_contract_examples() -> None:
    examples = json.loads((FIXTURES / "analyzer.valid.json").read_text())
    for name, model in MODELS.items():
        assert model.model_validate(examples[name])


def test_invalid_contract_examples() -> None:
    examples = json.loads((FIXTURES / "analyzer.invalid.json").read_text())
    for name, model in MODELS.items():
        with pytest.raises(ValidationError):
            model.model_validate(examples[name])


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
