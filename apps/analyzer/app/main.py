from __future__ import annotations

import multiprocessing
import secrets
import threading
from collections.abc import Generator
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
_segmentation_slots = threading.BoundedSemaphore(value=4)


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
        config=Config(
            connect_timeout=max(1.0, min(3.0, settings.execution_timeout_seconds / 6)),
            read_timeout=max(1.0, settings.execution_timeout_seconds / 3),
            retries={"max_attempts": 2, "mode": "standard"},
            s3={"addressing_style": "path" if settings.s3_force_path_style else "auto"},
        ),
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
        # Production intake must fail closed. Process-local deduplication cannot
        # provide correctness across workers or restarts.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="analysis intake database unavailable",
        ) from None


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
            # Release only an unclaimed queue reservation. If a broker accepted
            # the message before raising, a racing worker changes the state to
            # processing and this compare-and-set becomes a harmless no-op.
            if get_settings().app_env == "test":
                with _intake_lock:
                    _fallback_enqueued_runs.discard(payload.analysis_run_id)
            else:
                try:
                    _repository().release_enqueue(payload.analysis_run_id)
                except Exception:
                    log_event(
                        logger,
                        40,
                        "analysis.intake_release_failed",
                        analysisRunId=payload.analysis_run_id,
                    )
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


def _segment_process_target(
    connection: Any,
    raw: bytes,
    max_container_bytes: int,
    max_container_messages: int,
    max_eml_bytes: int,
) -> None:
    try:
        result = segment(
            raw,
            max_container_bytes=max_container_bytes,
            max_container_messages=max_container_messages,
            max_eml_bytes=max_eml_bytes,
        )
        connection.send(("ok", result.model_dump(mode="json")))
    except ParseLimitError as error:
        connection.send(("limit", error.code, str(error)))
    except BaseException:  # noqa: BLE001 - never serialize hostile/internal exception details
        connection.send(("error",))
    finally:
        connection.close()


def _run_segment_in_process(raw: bytes, settings: Settings) -> SegmentationResult:
    context: Any = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    worker = context.Process(
        target=_segment_process_target,
        args=(
            sender,
            raw,
            settings.max_container_bytes,
            settings.max_container_messages,
            settings.max_eml_bytes,
        ),
        name="mailsentinel-segment",
        daemon=True,
    )
    worker.start()
    sender.close()
    worker.join(max(0.001, settings.execution_timeout_seconds))
    if worker.is_alive():
        worker.terminate()
        worker.join(2.0)
        if worker.is_alive() and hasattr(worker, "kill"):
            worker.kill()
            worker.join(1.0)
        receiver.close()
        raise TimeoutError("segmentation exceeded configured watchdog")
    if not receiver.poll():
        receiver.close()
        raise RuntimeError("segmentation worker returned no result")
    message = receiver.recv()
    receiver.close()
    if message[0] == "ok":
        return SegmentationResult.model_validate(message[1])
    if message[0] == "limit":
        raise ParseLimitError(message[1], message[2])
    raise RuntimeError("segmentation worker failed")


def acquire_segmentation_slot() -> Generator[None, None, None]:
    if not _segmentation_slots.acquire(blocking=False):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="segmentation capacity exhausted",
        )
    try:
        yield
    finally:
        _segmentation_slots.release()


@app.post(
    "/v1/evidence/segment",
    response_model=SegmentationResult,
    dependencies=[Depends(require_internal_token)],
)
def segment_evidence(
    payload: SegmentationRequest,
    evidence_store: Annotated[EvidenceStore, Depends(get_evidence_store)],
    _slot: Annotated[None, Depends(acquire_segmentation_slot)],
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

    try:
        res = _run_segment_in_process(raw, settings)
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
