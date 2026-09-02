from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


class ContractModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class AnalysisStatusValue(StrEnum):
    ACCEPTED = "accepted"
    QUEUED = "queued"
    DEFERRED = "deferred"
    FAILED = "failed"


class Artifact(ContractModel):
    object_key: str = Field(
        pattern=r"^organizations/[A-Za-z0-9_-]+/cases/[A-Za-z0-9_-]+/artifacts/[A-Za-z0-9_-]+\.eml$"
    )
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")
    byte_size: int = Field(gt=0)


class AnalysisIntakeRequest(ContractModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        json_schema_extra={
            "examples": [
                {
                    "caseId": "case_01",
                    "organizationId": "org_01",
                    "analysisRunId": "run_01",
                    "artifact": {
                        "objectKey": "organizations/org_01/cases/case_01/artifacts/artifact_01.eml",
                        "sha256": "a" * 64,
                        "byteSize": 24831,
                    },
                    "requestedAt": "2026-01-01T00:00:00Z",
                }
            ]
        },
    )
    case_id: str = Field(min_length=1)
    organization_id: str = Field(min_length=1)
    analysis_run_id: str = Field(min_length=1)
    artifact: Artifact
    requested_at: datetime

    @model_validator(mode="after")
    def artifact_matches_scope(self) -> "AnalysisIntakeRequest":
        expected_prefix = f"organizations/{self.organization_id}/cases/{self.case_id}/artifacts/"
        if not self.artifact.object_key.startswith(expected_prefix):
            raise ValueError("artifact object key does not match organization and case")
        return self


class AnalysisIntakeAccepted(ContractModel):
    analysis_run_id: str
    status: AnalysisStatusValue = AnalysisStatusValue.ACCEPTED


class AnalysisStatus(ContractModel):
    analysis_run_id: str
    status: AnalysisStatusValue


class AnalysisFailure(ContractModel):
    code: str
    message: str
    request_id: str | None = None
