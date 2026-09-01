from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class AnalysisStatusValue(StrEnum):
    ACCEPTED = "accepted"
    QUEUED = "queued"
    DEFERRED = "deferred"
    FAILED = "failed"


class Artifact(BaseModel):
    object_key: str = Field(pattern=r"^organizations/[^/]+/cases/[^/]+/artifacts/.+")
    sha256: str = Field(min_length=64, max_length=64)
    byte_size: int = Field(gt=0)


class AnalysisIntakeRequest(BaseModel):
    case_id: str = Field(min_length=1)
    organization_id: str = Field(min_length=1)
    analysis_run_id: str = Field(min_length=1)
    artifact: Artifact
    requested_at: datetime


class AnalysisIntakeAccepted(BaseModel):
    analysis_run_id: str
    status: AnalysisStatusValue = AnalysisStatusValue.ACCEPTED


class AnalysisStatus(BaseModel):
    analysis_run_id: str
    status: AnalysisStatusValue


class AnalysisFailure(BaseModel):
    code: str
    message: str
    request_id: str | None = None
