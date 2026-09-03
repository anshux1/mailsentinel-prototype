from __future__ import annotations

import hashlib
import secrets
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol
from uuid import uuid4

from app.contracts.models import (
    AnalysisFailure,
    AnalysisFailureCode,
    AnalysisPhase,
    AnalysisResult,
    AnalysisStatus,
    AnalysisStatusValue,
)
from app.core.logging import safe_request_id

_FORBIDDEN_FAILURE_TERMS = ("raw", "body", "payload", "token", "password", "secret", "credential", "authorization")


def safe_failure_message(code: str, message: str) -> str:
    """Keep hostile values out of status/failure persistence while retaining useful diagnostics."""
    bounded = message[:500]
    if any(term in bounded.lower() for term in _FORBIDDEN_FAILURE_TERMS):
        return code.replace("_", " ")[:500]
    return bounded


@dataclass(frozen=True)
class RunInput:
    analysis_run_id: str
    organization_id: str
    case_id: str
    object_key: str
    sha256: str
    byte_size: int


@dataclass(frozen=True)
class AuditRecord:
    id: str
    organization_id: str
    action: str
    resource_type: str
    resource_id: str | None
    metadata: dict[str, str]
    created_at: datetime
    actor_user_id: str | None = None


class AnalysisRepository(Protocol):
    def get_run(self, analysis_run_id: str) -> RunInput | None: ...

    def get_status(self, analysis_run_id: str) -> AnalysisStatusValue | None: ...

    def claim(self, analysis_run_id: str, stuck_timeout_seconds: float = 300.0) -> bool: ...

    def mark_queued(self, analysis_run_id: str) -> None: ...

    def enqueue_once(self, analysis_run_id: str) -> bool: ...

    def release_enqueue(self, analysis_run_id: str) -> bool: ...

    def update_phase(self, analysis_run_id: str, phase: AnalysisPhase | str, progress: int | None = None) -> None: ...

    def get_detailed_status(self, analysis_run_id: str) -> AnalysisStatus | None: ...

    def get_result(self, analysis_run_id: str) -> AnalysisResult | None: ...

    def save_completed(self, result: AnalysisResult) -> None: ...

    def save_failed(
        self, analysis_run_id: str, code: str, message: str, retryable: bool, request_id: str | None = None
    ) -> None: ...

    def record_audit(
        self,
        *,
        organization_id: str,
        action: str,
        resource_id: str | None,
        metadata: dict[str, str] | None = None,
        actor_user_id: str | None = None,
    ) -> None: ...

    def get_audit_records(self, analysis_run_id: str) -> list[AuditRecord]: ...


class InMemoryAnalysisRepository:
    def __init__(self, runs: list[RunInput] | None = None, stuck_timeout_seconds: float = 300.0) -> None:
        self._lock = threading.RLock()
        self.runs = {run.analysis_run_id: run for run in runs or []}
        self.states: dict[str, AnalysisStatusValue] = {
            run.analysis_run_id: AnalysisStatusValue.ACCEPTED for run in runs or []
        }
        self.results: dict[str, AnalysisResult] = {}
        self.failures: dict[str, tuple[str, str, bool, str | None]] = {}
        self.attempts: dict[str, int] = {run.analysis_run_id: 0 for run in runs or []}
        self.queued_at: dict[str, datetime] = {}
        self.started_at: dict[str, datetime] = {}
        self.completed_at: dict[str, datetime] = {}
        self.failed_at: dict[str, datetime] = {}
        self.updated_at: dict[str, datetime] = {}
        self.retryable: dict[str, bool] = {}
        self.phases: dict[str, str] = {}
        self.progress: dict[str, int | None] = {}
        self.audit_records: list[AuditRecord] = []
        self.stuck_timeout_seconds = stuck_timeout_seconds

    def get_run(self, analysis_run_id: str) -> RunInput | None:
        with self._lock:
            return self.runs.get(analysis_run_id)

    def get_status(self, analysis_run_id: str) -> AnalysisStatusValue | None:
        with self._lock:
            return self.states.get(analysis_run_id)

    def get_result(self, analysis_run_id: str) -> AnalysisResult | None:
        with self._lock:
            return self.results.get(analysis_run_id)

    def _audit(
        self,
        organization_id: str,
        action: str,
        resource_id: str | None,
        metadata: dict[str, str] | None = None,
        actor_user_id: str | None = None,
    ) -> None:
        safe_metadata = {
            str(key)[:80]: str(value)[:500]
            for key, value in (metadata or {}).items()
            if not any(
                forbidden in str(key).lower()
                for forbidden in (
                    "body",
                    "raw",
                    "payload",
                    "token",
                    "password",
                    "secret",
                    "credential",
                    "authorization",
                )
            )
        }
        self.audit_records.append(
            AuditRecord(
                id=f"audit_{uuid4().hex}",
                organization_id=organization_id[:160],
                action=action[:120],
                resource_type="analysis_run",
                resource_id=resource_id[:160] if resource_id else None,
                metadata=safe_metadata,
                created_at=datetime.now(UTC),
                actor_user_id=actor_user_id,
            )
        )

    def record_audit(
        self,
        *,
        organization_id: str,
        action: str,
        resource_id: str | None,
        metadata: dict[str, str] | None = None,
        actor_user_id: str | None = None,
    ) -> None:
        with self._lock:
            self._audit(organization_id, action, resource_id, metadata, actor_user_id)

    def get_audit_records(self, analysis_run_id: str) -> list[AuditRecord]:
        with self._lock:
            return [record for record in self.audit_records if record.resource_id == analysis_run_id]

    def update_phase(self, analysis_run_id: str, phase: AnalysisPhase | str, progress: int | None = None) -> None:
        with self._lock:
            if self.states.get(analysis_run_id) != AnalysisStatusValue.PROCESSING:
                return
            phase_value = phase.value if isinstance(phase, AnalysisPhase) else str(phase)
            self.phases[analysis_run_id] = phase_value[:80]
            self.progress[analysis_run_id] = max(0, min(100, progress)) if progress is not None else None
            self.updated_at[analysis_run_id] = datetime.now(UTC)

    def get_detailed_status(self, analysis_run_id: str) -> AnalysisStatus | None:
        with self._lock:
            state = self.states.get(analysis_run_id)
            if state is None:
                return None
            failure: AnalysisFailure | None = None
            stored = self.failures.get(analysis_run_id)
            if stored:
                code, message, retryable, request_id = stored
                try:
                    safe_code = AnalysisFailureCode(code)
                except ValueError:
                    safe_code = AnalysisFailureCode.ANALYSIS_FAILED
                failure = AnalysisFailure(
                    code=safe_code, message=message[:500], retryable=retryable, request_id=request_id
                )
            phase_value = self.phases.get(analysis_run_id)
            phase = None
            if phase_value is not None:
                try:
                    phase = AnalysisPhase(phase_value)
                except ValueError:
                    phase = None
            return AnalysisStatus(
                analysis_run_id=analysis_run_id,
                status=state,
                phase=phase,
                progress=self.progress.get(analysis_run_id),
                failure=failure,
            )

    def enqueue_once(self, analysis_run_id: str) -> bool:
        with self._lock:
            state = self.states.get(analysis_run_id)
            if state is None or state in {
                AnalysisStatusValue.QUEUED,
                AnalysisStatusValue.PROCESSING,
                AnalysisStatusValue.COMPLETED,
            }:
                return False
            if state == AnalysisStatusValue.FAILED and not self.retryable.get(analysis_run_id, False):
                return False
            self.mark_queued(analysis_run_id)
            return True

    def release_enqueue(self, analysis_run_id: str) -> bool:
        """Return an unpublished queued run to accepted without touching active work."""
        with self._lock:
            if self.states.get(analysis_run_id) != AnalysisStatusValue.QUEUED:
                return False
            now = datetime.now(UTC)
            self.states[analysis_run_id] = AnalysisStatusValue.ACCEPTED
            self.queued_at.pop(analysis_run_id, None)
            self.updated_at[analysis_run_id] = now
            self.phases.pop(analysis_run_id, None)
            self.progress.pop(analysis_run_id, None)
            return True

    def claim(self, analysis_run_id: str, stuck_timeout_seconds: float | None = None) -> bool:
        timeout = self.stuck_timeout_seconds if stuck_timeout_seconds is None else stuck_timeout_seconds
        with self._lock:
            if analysis_run_id not in self.states:
                return False
            state = self.states[analysis_run_id]
            now = datetime.now(UTC)
            recovered = False
            if state in {AnalysisStatusValue.ACCEPTED, AnalysisStatusValue.QUEUED}:
                pass
            elif state == AnalysisStatusValue.FAILED and self.retryable.get(analysis_run_id, False):
                pass
            elif state == AnalysisStatusValue.PROCESSING:
                last_updated = self.updated_at.get(analysis_run_id, self.started_at.get(analysis_run_id, now))
                if (now - last_updated).total_seconds() >= timeout:
                    recovered = True
                else:
                    return False
            else:
                return False

            self.states[analysis_run_id] = AnalysisStatusValue.PROCESSING
            self.attempts[analysis_run_id] = self.attempts.get(analysis_run_id, 0) + 1
            if analysis_run_id not in self.started_at:
                self.started_at[analysis_run_id] = now
            self.updated_at[analysis_run_id] = now
            run = self.runs[analysis_run_id]
            self._audit(
                run.organization_id,
                "analysis.run.recovered" if recovered else "analysis.run.claimed",
                analysis_run_id,
                {"attempt": str(self.attempts[analysis_run_id])},
            )
            self.phases[analysis_run_id] = AnalysisPhase.FETCHING_EVIDENCE.value
            self.progress[analysis_run_id] = 10
            return True

    def mark_queued(self, analysis_run_id: str) -> None:
        with self._lock:
            if analysis_run_id not in self.states:
                return
            state = self.states[analysis_run_id]
            if state == AnalysisStatusValue.ACCEPTED or (
                state == AnalysisStatusValue.FAILED and self.retryable.get(analysis_run_id, False)
            ):
                now = datetime.now(UTC)
                self.states[analysis_run_id] = AnalysisStatusValue.QUEUED
                self.queued_at[analysis_run_id] = now
                self.updated_at[analysis_run_id] = now
                self.phases[analysis_run_id] = AnalysisPhase.QUEUED.value
                self.progress[analysis_run_id] = 0

    def save_completed(self, result: AnalysisResult) -> None:
        with self._lock:
            run_id = result.analysis_run_id
            if run_id not in self.states:
                raise ValueError("analysis run was not found")
            state = self.states[run_id]
            if state == AnalysisStatusValue.COMPLETED:
                existing = self.results.get(run_id)
                if existing:
                    if (
                        existing.analysis_version == result.analysis_version
                        and existing.ruleset_version == result.ruleset_version
                        and existing.schema_version == result.schema_version
                    ):
                        return
                    raise ValueError(
                        f"conflict: analysis run already completed with version "
                        f"{existing.analysis_version}/{existing.ruleset_version}/{existing.schema_version}"
                    )
                return
            if state != AnalysisStatusValue.PROCESSING:
                raise ValueError(f"invalid transition: analysis run is in state '{state.value}', expected 'processing'")
            now = datetime.now(UTC)
            self.results[run_id] = result
            self.states[run_id] = AnalysisStatusValue.COMPLETED
            self.completed_at[run_id] = now
            self.updated_at[run_id] = now
            self.failed_at.pop(run_id, None)
            self.failures.pop(run_id, None)
            self.retryable[run_id] = False
            self.phases[run_id] = AnalysisPhase.COMPLETED.value
            self.progress[run_id] = 100
            run = self.runs[run_id]
            self._audit(
                run.organization_id,
                "analysis.run.completed",
                run_id,
                {
                    "score": str(result.score.final_score),
                    "verdict": result.verdict.value,
                },
            )

    def save_failed(
        self, analysis_run_id: str, code: str, message: str, retryable: bool, request_id: str | None = None
    ) -> None:
        with self._lock:
            if analysis_run_id not in self.states:
                raise ValueError("analysis run was not found")
            if self.states[analysis_run_id] == AnalysisStatusValue.COMPLETED:
                return
            now = datetime.now(UTC)
            self.failures[analysis_run_id] = (
                code[:80],
                safe_failure_message(code, message),
                retryable,
                safe_request_id(request_id),
            )
            self.states[analysis_run_id] = AnalysisStatusValue.FAILED
            self.retryable[analysis_run_id] = retryable
            self.failed_at[analysis_run_id] = now
            self.updated_at[analysis_run_id] = now
            self.phases[analysis_run_id] = AnalysisPhase.FAILED.value
            self.progress[analysis_run_id] = None
            run = self.runs[analysis_run_id]
            self._audit(
                run.organization_id,
                "analysis.run.failed",
                analysis_run_id,
                {
                    "code": code[:80],
                    "retryable": str(retryable).lower(),
                    **({"requestId": safe_request_id(request_id) or ""} if request_id else {}),
                },
            )


class EvidenceStore(Protocol):
    def read_verified(
        self,
        object_key: str,
        expected_sha256: str,
        expected_size: int,
        max_bytes: int,
        expected_scope: tuple[str, str] | None = None,
    ) -> bytes: ...


@dataclass(frozen=True)
class MemoryEvidenceStore:
    objects: dict[str, bytes]

    def read_verified(
        self,
        object_key: str,
        expected_sha256: str,
        expected_size: int,
        max_bytes: int,
        expected_scope: tuple[str, str] | None = None,
    ) -> bytes:
        if expected_scope is not None:
            expected_prefix = f"organizations/{expected_scope[0]}/cases/{expected_scope[1]}/artifacts/"
            if (
                not object_key.startswith(expected_prefix)
                or ".." in object_key
                or "//" in object_key
                or "\\" in object_key
                or "\x00" in object_key
            ):
                raise ValueError("evidence_not_found")

        value = self.objects.get(object_key)
        if value is None:
            raise ValueError("evidence_not_found")
        if len(value) > max_bytes or expected_size > max_bytes:
            raise ValueError("evidence_too_large")
        if len(value) != expected_size:
            raise ValueError("evidence_size_mismatch")
        actual_digest = hashlib.sha256(value).hexdigest().lower()
        if not secrets.compare_digest(actual_digest, expected_sha256.lower()):
            raise ValueError("evidence_digest_mismatch")
        return value
