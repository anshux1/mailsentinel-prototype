from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ContractModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class AnalysisStatusValue(StrEnum):
    ACCEPTED = "accepted"
    QUEUED = "queued"
    DEFERRED = "deferred"
    FAILED = "failed"


class Artifact(ContractModel):
    object_key: str = Field(pattern=r"^organizations/[^/]+/cases/[^/]+/artifacts/.+")
    sha256: str = Field(min_length=64, max_length=64)
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
