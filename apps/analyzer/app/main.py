import secrets
from uuid import uuid4

import boto3
import psycopg
import redis
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from app.contracts.models import AnalysisIntakeAccepted, AnalysisIntakeRequest
from app.core.settings import get_settings
from app.tasks.broker import setup_analysis

app = FastAPI(title="MailSentinel Analyzer", version="prototype-1")


def require_internal_token(authorization: str | None = Header(default=None)) -> None:
    settings = get_settings()
    expected = settings.analyzer_service_token.get_secret_value()
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid internal token")


@app.middleware("http")
async def request_id(request: Request, call_next):  # type: ignore[no-untyped-def]
    request.state.request_id = request.headers.get("x-request-id", str(uuid4()))
    response = await call_next(request)
    response.headers["x-request-id"] = request.state.request_id
    return response


@app.exception_handler(Exception)
async def safe_errors(request: Request, exc: Exception) -> JSONResponse:  # noqa: ARG001
    return JSONResponse(
        status_code=500,
        content={"code": "internal_error", "message": "request failed", "request_id": request.state.request_id},
    )


@app.get("/health/live")
def live() -> dict[str, bool]:
    return {"ok": True}


@app.get("/health/ready")
def ready() -> dict[str, str]:
    settings = get_settings()
    try:
        with psycopg.connect(str(settings.database_url), connect_timeout=2) as connection:
            connection.execute("select 1")
        redis.from_url(str(settings.redis_url), socket_connect_timeout=2).ping()  # type: ignore[no-untyped-call]
        storage = boto3.client(
            "s3",
            endpoint_url=str(settings.s3_endpoint),
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id,
            aws_secret_access_key=settings.s3_secret_access_key.get_secret_value(),
        )
        storage.head_bucket(Bucket=settings.s3_bucket)
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dependencies unavailable",
        ) from error
    return {"status": "ready"}


@app.post(
    "/v1/analyses",
    response_model=AnalysisIntakeAccepted,
    status_code=202,
    dependencies=[Depends(require_internal_token)],
)
def intake(payload: AnalysisIntakeRequest) -> AnalysisIntakeAccepted:
    setup_analysis.send(payload.analysis_run_id)
    return AnalysisIntakeAccepted(analysis_run_id=payload.analysis_run_id)
