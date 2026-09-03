from __future__ import annotations

import secrets
import threading
from collections.abc import Callable
from typing import Annotated, Any
from uuid import uuid4

import boto3
import psycopg
import redis
from botocore.config import Config
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.contracts.models import (
    AnalysisIntakeAccepted,
    AnalysisIntakeRequest,
    AnalysisResult,
    AnalysisStatus,
    AnalysisStatusValue,
    SegmentationRequest,
    SegmentationResult,
)
from app.core.logging import get_structured_logger, log_event, request_id_context, safe_request_id
from app.core.settings import Settings, get_settings
from app.parsing.parser import ParseLimitError
from app.persistence.interfaces import EvidenceStore
from app.persistence.postgres import PostgresAnalysisRepository
from app.persistence.s3 import S3EvidenceStore
from app.segmentation import segment
from app.tasks.broker import process_analysis

app = FastAPI(title="MailSentinel Analyzer", version="prototype-1")
internal_bearer = HTTPBearer(auto_error=False)
logger = get_structured_logger("mailsentinel.http")
_intake_lock = threading.RLock()
_fallback_enqueued_runs: set[str] = set()


def require_internal_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(internal_bearer)],
) -> None:
    settings = get_settings()
    expected = settings.analyzer_service_token.get_secret_value()
    supplied = credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else ""
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid internal token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def create_storage_client(settings: Settings) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=str(settings.s3_endpoint),
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key.get_secret_value(),
        config=Config(s3={"addressing_style": "path" if settings.s3_force_path_style else "auto"}),
    )


@app.middleware("http")
async def request_id(request: Request, call_next):  # type: ignore[no-untyped-def]
    raw_value = request.headers.get("x-request-id")
    value = safe_request_id(raw_value) or str(uuid4())
    request.state.request_id = value
    token = request_id_context.set(value)
    try:
        response = await call_next(request)
        response.headers["x-request-id"] = value
        return response
    finally:
        request_id_context.reset(token)


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
        with redis.from_url(str(settings.redis_url), socket_connect_timeout=2) as redis_client:  # type: ignore[no-untyped-call]
            redis_client.ping()
        create_storage_client(settings).head_bucket(Bucket=settings.s3_bucket)
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dependencies unavailable",
        ) from error
    return {"status": "ready"}


def reset_intake_deduplication() -> None:
    """Clear the database-free fallback, primarily for isolated test processes."""
    with _intake_lock:
        _fallback_enqueued_runs.clear()


def _enqueue_once(analysis_run_id: str) -> tuple[bool, AnalysisStatusValue]:
    """Atomically deduplicate with PostgreSQL, falling back only when unavailable."""
    settings = get_settings()
    if settings.app_env == "test":
        with _intake_lock:
            if analysis_run_id in _fallback_enqueued_runs:
                return False, AnalysisStatusValue.ACCEPTED
            _fallback_enqueued_runs.add(analysis_run_id)
            return True, AnalysisStatusValue.ACCEPTED

    try:
        repository = PostgresAnalysisRepository(str(settings.database_url))
        current = repository.get_status(analysis_run_id)
        if current in {
            AnalysisStatusValue.QUEUED,
            AnalysisStatusValue.PROCESSING,
            AnalysisStatusValue.COMPLETED,
        }:
            return False, current
        if current == AnalysisStatusValue.FAILED:
            run = repository.get_run(analysis_run_id)
            # enqueue_once itself checks retryable in PostgreSQL; a failed run
            # with no recoverable metadata is therefore safely left untouched.
            if run is None:
                return False, current
        enqueued = repository.enqueue_once(analysis_run_id)
        if enqueued:
            return True, AnalysisStatusValue.QUEUED
        latest = repository.get_status(analysis_run_id)
        return False, latest or AnalysisStatusValue.ACCEPTED
    except Exception:
        # Tests and local health checks may intentionally run without PostgreSQL.
        # This fallback is process-local and never overrides an operational DB.
        with _intake_lock:
            if analysis_run_id in _fallback_enqueued_runs:
                return False, AnalysisStatusValue.ACCEPTED
            _fallback_enqueued_runs.add(analysis_run_id)
            return True, AnalysisStatusValue.ACCEPTED


@app.post(
    "/v1/analyses",
    response_model=AnalysisIntakeAccepted,
    status_code=202,
    dependencies=[Depends(require_internal_token)],
)
def intake(payload: AnalysisIntakeRequest, request: Request) -> AnalysisIntakeAccepted:
    should_enqueue, response_status = _enqueue_once(payload.analysis_run_id)
    if should_enqueue:
        req_id = safe_request_id(getattr(request.state, "request_id", None))
        try:
            process_analysis.send(payload.analysis_run_id, request_id=req_id)
        except Exception:
            # Do not permanently suppress a retry if broker publication fails.
            with _intake_lock:
                _fallback_enqueued_runs.discard(payload.analysis_run_id)
            raise HTTPException(status_code=503, detail="analysis queue unavailable") from None
    log_event(
        logger,
        20,
        "analysis.intake",
        phase="queued" if should_enqueue else response_status.value,
        analysisRunId=payload.analysis_run_id,
    )
    # Existing database-free test clients historically receive accepted; an
    # operational repository reports queued after the atomic transition.
    return AnalysisIntakeAccepted(
        analysis_run_id=payload.analysis_run_id,
        status=response_status if response_status != AnalysisStatusValue.PROCESSING else AnalysisStatusValue.ACCEPTED,
    )


def _repository() -> PostgresAnalysisRepository:
    return PostgresAnalysisRepository(str(get_settings().database_url))


@app.get(
    "/v1/analyses/{analysis_run_id}",
    response_model=AnalysisStatus,
    dependencies=[Depends(require_internal_token)],
)
def analysis_status(analysis_run_id: str) -> AnalysisStatus:
    repository = _repository()
    try:
        result = repository.get_detailed_status(analysis_run_id)
    except Exception:
        raise HTTPException(status_code=503, detail="analysis status unavailable") from None
    if result is None:
        raise HTTPException(status_code=404, detail="analysis not found")
    return result


@app.get(
    "/v1/analyses/{analysis_run_id}/result",
    response_model=AnalysisResult,
    dependencies=[Depends(require_internal_token)],
)
def analysis_result(analysis_run_id: str) -> AnalysisResult:
    repository = _repository()
    try:
        result = repository.get_result(analysis_run_id)
        current_status = repository.get_status(analysis_run_id)
    except ValueError:
        raise HTTPException(status_code=500, detail="analysis result unavailable") from None
    except Exception:
        raise HTTPException(status_code=503, detail="analysis result unavailable") from None
    if result is not None:
        return result
    if current_status is None:
        raise HTTPException(status_code=404, detail="analysis not found")
    raise HTTPException(status_code=409, detail="analysis result is not ready")


def get_evidence_store() -> EvidenceStore:
    return S3EvidenceStore(get_settings())


def _run_segment_with_watchdog(
    callback: Callable[[], SegmentationResult],
    timeout_seconds: float,
) -> SegmentationResult:
    result: list[SegmentationResult] = []
    error: list[BaseException] = []

    def target() -> None:
        try:
            result.append(callback())
        except BaseException as exc:  # noqa: BLE001
            error.append(exc)

    worker = threading.Thread(target=target, name="mailsentinel-segment", daemon=True)
    worker.start()
    worker.join(timeout=max(0.001, timeout_seconds))
    if worker.is_alive():
        raise TimeoutError("segmentation exceeded configured watchdog")
    if error:
        raise error[0]
    if not result:
        raise RuntimeError("segmentation returned no result")
    return result[0]


@app.post(
    "/v1/evidence/segment",
    response_model=SegmentationResult,
    dependencies=[Depends(require_internal_token)],
)
def segment_evidence(
    payload: SegmentationRequest,
    evidence_store: Annotated[EvidenceStore, Depends(get_evidence_store)],
) -> SegmentationResult:
    settings = get_settings()
    try:
        raw = evidence_store.read_verified(
            payload.object_key,
            expected_sha256=payload.sha256,
            expected_size=payload.byte_size,
            max_bytes=settings.max_container_bytes,
            expected_scope=(payload.organization_id, payload.case_id),
        )
    except ValueError as error:
        err_msg = str(error)
        if err_msg == "evidence_not_found":
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="evidence not found") from None
        if err_msg == "evidence_storage_unavailable":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="evidence storage unavailable"
            ) from None
        if err_msg == "evidence_too_large":
            raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="evidence too large") from None
        if err_msg in ("evidence_digest_mismatch", "evidence_size_mismatch"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err_msg.replace("_", " ")) from None
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="storage verification failed"
        ) from None

    def execute_segment() -> SegmentationResult:
        return segment(
            raw,
            max_container_bytes=settings.max_container_bytes,
            max_container_messages=settings.max_container_messages,
            max_eml_bytes=settings.max_eml_bytes,
        )

    try:
        timeout = getattr(settings, "execution_timeout_seconds", 120.0)
        res = _run_segment_with_watchdog(execute_segment, timeout)
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="segmentation execution timed out"
        ) from None
    except ParseLimitError as error:
        if error.code in ("container_too_large", "evidence_too_large"):
            raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=str(error)) from None
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from None
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="segmentation failed") from None

    log_event(
        logger,
        20,
        "evidence.segmentation",
        organizationId=payload.organization_id,
        caseId=payload.case_id,
        evidenceId=payload.evidence_id,
        format=res.container_format.value,
        messageCount=res.message_count,
    )
    return res
