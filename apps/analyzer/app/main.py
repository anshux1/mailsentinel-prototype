import secrets
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from app.contracts.models import AnalysisIntakeAccepted, AnalysisIntakeRequest
from app.core.settings import get_settings

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
    return {"status": "ready"}


@app.post(
    "/v1/analyses",
    response_model=AnalysisIntakeAccepted,
    status_code=202,
    dependencies=[Depends(require_internal_token)],
)
def intake(payload: AnalysisIntakeRequest) -> AnalysisIntakeAccepted:
    # Queue integration is deliberately deferred; setup never invents a verdict.
    return AnalysisIntakeAccepted(analysis_run_id=payload.analysis_run_id)
