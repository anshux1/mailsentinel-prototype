"""Small psycopg adapter for the analyzer worker.

The SQL is intentionally isolated here; application-facing reads remain in the
Node/Drizzle repositories. All worker writes that change lifecycle state append
an audit record in the same PostgreSQL transaction.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row

from app.contracts.models import (
    AnalysisFailure,
    AnalysisFailureCode,
    AnalysisPhase,
    AnalysisResult,
    AnalysisStatus,
    AnalysisStatusValue,
)
from app.core.logging import safe_request_id
from app.persistence.interfaces import AnalysisRepository, AuditRecord, RunInput, safe_failure_message


class PostgresAnalysisRepository(AnalysisRepository):
    def __init__(self, database_url: str, stuck_timeout_seconds: float = 300.0) -> None:
        self.database_url = database_url
        self.stuck_timeout_seconds = stuck_timeout_seconds

    def get_run(self, analysis_run_id: str) -> RunInput | None:
        query = """
            SELECT r.id AS analysis_run_id, r.organization_id, r.case_id, e.object_key, e.sha256, e.byte_size
            FROM analysis_runs r
            JOIN evidence_metadata e ON e.id = r.evidence_id
                AND e.organization_id = r.organization_id AND e.case_id = r.case_id
            WHERE r.id = %s
        """
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            row: dict[str, Any] | None = connection.execute(query, (analysis_run_id,)).fetchone()
        return RunInput(**row) if row else None

    def get_status(self, analysis_run_id: str) -> AnalysisStatusValue | None:
        query = "SELECT status FROM analysis_runs WHERE id = %s"
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            row: dict[str, Any] | None = connection.execute(query, (analysis_run_id,)).fetchone()
        return AnalysisStatusValue(row["status"]) if row else None

    @staticmethod
    def _safe_failure(
        code: str | None, message: str | None, retryable: bool, request_id: str | None
    ) -> AnalysisFailure | None:
        if not code:
            return None
        try:
            failure_code = AnalysisFailureCode(code)
        except ValueError:
            failure_code = AnalysisFailureCode.ANALYSIS_FAILED
        return AnalysisFailure(
            code=failure_code,
            message=safe_failure_message(code, message or "analysis could not be completed"),
            retryable=retryable,
            request_id=safe_request_id(request_id),
        )

    def get_detailed_status(self, analysis_run_id: str) -> AnalysisStatus | None:
        # phase/progress are additive columns. The fallback keeps an analyzer
        # binary compatible while an older database is being migrated.
        query = """
            SELECT id, status, phase, progress, failure_code, failure_message, retryable,
                   (SELECT metadata->>'requestId'
                    FROM audit_records
                    WHERE resource_type = 'analysis_run' AND resource_id = analysis_runs.id
                      AND action = 'analysis.run.failed'
                    ORDER BY created_at DESC, id DESC LIMIT 1) AS failure_request_id
            FROM analysis_runs WHERE id = %s
        """
        try:
            with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
                row: dict[str, Any] | None = connection.execute(query, (analysis_run_id,)).fetchone()
        except Exception:
            fallback = """
                SELECT id, status, failure_code, failure_message, retryable,
                       NULL AS failure_request_id
                FROM analysis_runs WHERE id = %s
            """
            with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
                row = connection.execute(fallback, (analysis_run_id,)).fetchone()
        if not row:
            return None
        status = AnalysisStatusValue(row["status"])
        phase_value = row.get("phase")
        try:
            phase = AnalysisPhase(phase_value) if phase_value else None
        except ValueError:
            phase = None
        progress = row.get("progress")
        if status == AnalysisStatusValue.COMPLETED:
            phase, progress = AnalysisPhase.COMPLETED, 100
        elif status == AnalysisStatusValue.FAILED:
            phase, progress = AnalysisPhase.FAILED, None
        failure = self._safe_failure(
            row.get("failure_code"),
            row.get("failure_message"),
            bool(row.get("retryable")),
            row.get("failure_request_id"),
        )
        return AnalysisStatus(
            analysis_run_id=analysis_run_id, status=status, phase=phase, progress=progress, failure=failure
        )

    def get_result(self, analysis_run_id: str) -> AnalysisResult | None:
        query = "SELECT status, result_snapshot FROM analysis_runs WHERE id = %s"
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            row: dict[str, Any] | None = connection.execute(query, (analysis_run_id,)).fetchone()
        if not row or row["status"] != AnalysisStatusValue.COMPLETED.value or row.get("result_snapshot") is None:
            return None
        try:
            snapshot = row["result_snapshot"]
            return AnalysisResult.model_validate(snapshot)
        except (TypeError, ValueError):
            # A corrupt result is not exposed as an internal database exception.
            raise ValueError("analysis_result_invalid") from None

    def enqueue_once(self, analysis_run_id: str) -> bool:
        query = """
            UPDATE analysis_runs
            SET status = 'queued', queued_at = COALESCE(queued_at, now()), updated_at = now()
            WHERE id = %s AND (
                status = 'accepted'
                OR (status = 'failed' AND retryable = true)
            )
            RETURNING id
        """
        with psycopg.connect(self.database_url) as connection:
            with connection.transaction():
                claimed = connection.execute(query, (analysis_run_id,)).fetchone() is not None
        return claimed

    def claim(self, analysis_run_id: str, stuck_timeout_seconds: float | None = None) -> bool:
        timeout = self.stuck_timeout_seconds if stuck_timeout_seconds is None else stuck_timeout_seconds
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.transaction():
                previous = connection.execute(
                    "SELECT organization_id, status FROM analysis_runs WHERE id = %s FOR UPDATE",
                    (analysis_run_id,),
                ).fetchone()
                if previous is None:
                    return False
                row = connection.execute(
                    """
                    UPDATE analysis_runs
                    SET status = 'processing',
                        started_at = COALESCE(started_at, now()),
                        attempts = attempts + 1,
                        updated_at = now()
                    WHERE id = %s AND (
                        status IN ('accepted', 'queued')
                        OR (status = 'failed' AND retryable = true)
                        OR (status = 'processing' AND updated_at < now() - (%s * INTERVAL '1 second'))
                    )
                    RETURNING id, attempts
                    """,
                    (analysis_run_id, timeout),
                ).fetchone()
                if row is None:
                    return False
                recovered = previous["status"] == AnalysisStatusValue.PROCESSING.value
                self._insert_audit(
                    connection,
                    organization_id=str(previous["organization_id"]),
                    action="analysis.run.recovered" if recovered else "analysis.run.claimed",
                    resource_id=analysis_run_id,
                    metadata={"attempt": str(row["attempts"])},
                )
        return True

    def mark_queued(self, analysis_run_id: str) -> None:
        query = """
            UPDATE analysis_runs
            SET status = 'queued',
                queued_at = COALESCE(queued_at, now()), updated_at = now()
            WHERE id = %s AND (
                status = 'accepted'
                OR (status = 'failed' AND retryable = true)
            )
        """
        try:
            with psycopg.connect(self.database_url) as connection:
                with connection.transaction():
                    connection.execute(query, (analysis_run_id,))
        except Exception:
            # Legacy databases without phase columns can still process work.
            fallback = """
                UPDATE analysis_runs
                SET status = 'queued', queued_at = COALESCE(queued_at, now()), updated_at = now()
                WHERE id = %s AND (status = 'accepted' OR (status = 'failed' AND retryable = true))
            """
            with psycopg.connect(self.database_url) as connection:
                with connection.transaction():
                    connection.execute(fallback, (analysis_run_id,))

    def update_phase(self, analysis_run_id: str, phase: AnalysisPhase | str, progress: int | None = None) -> None:
        value = phase.value if isinstance(phase, AnalysisPhase) else str(phase)
        bounded_progress = max(0, min(100, progress)) if progress is not None else None
        try:
            with psycopg.connect(self.database_url) as connection:
                with connection.transaction():
                    connection.execute(
                        "UPDATE analysis_runs SET phase = %s, progress = %s, updated_at = now() WHERE id = %s",
                        (value[:80], bounded_progress, analysis_run_id),
                    )
        except Exception:
            return

    @staticmethod
    def _insert_audit(
        connection: Any,
        *,
        organization_id: str,
        action: str,
        resource_id: str | None,
        metadata: dict[str, str],
    ) -> None:
        safe_metadata = {
            str(key)[:80]: str(value)[:500]
            for key, value in metadata.items()
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
        connection.execute(
            """
            INSERT INTO audit_records
                (id, organization_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
            VALUES (%s, %s, NULL, %s, 'analysis_run', %s, %s::jsonb, now())
            """,
            (f"audit_{uuid4().hex}", organization_id, action[:120], resource_id, json.dumps(safe_metadata)),
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
        with psycopg.connect(self.database_url) as connection:
            with connection.transaction():
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
                connection.execute(
                    """
                    INSERT INTO audit_records
                        (id, organization_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
                    VALUES (%s, %s, %s, %s, 'analysis_run', %s, %s::jsonb, now())
                    """,
                    (
                        f"audit_{uuid4().hex}",
                        organization_id,
                        actor_user_id,
                        action[:120],
                        resource_id,
                        json.dumps(safe_metadata),
                    ),
                )

    def get_audit_records(self, analysis_run_id: str) -> list[AuditRecord]:
        query = """
            SELECT id, organization_id, action, resource_type, resource_id, metadata, created_at, actor_user_id
            FROM audit_records WHERE resource_type = 'analysis_run' AND resource_id = %s
            ORDER BY created_at ASC, id ASC
        """
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            rows: list[dict[str, Any]] = connection.execute(query, (analysis_run_id,)).fetchall()
        return [AuditRecord(**row) for row in rows]

    def save_completed(self, result: AnalysisResult) -> None:
        payload = json.dumps(result.model_dump(mode="json", by_alias=True))
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.transaction():
                row = connection.execute(
                    """
                    SELECT status, organization_id, analysis_version, ruleset_version, result_schema_version
                    FROM analysis_runs WHERE id = %s FOR UPDATE
                    """,
                    (result.analysis_run_id,),
                ).fetchone()
                if row is None:
                    raise ValueError("analysis run was not found")
                current_status = row["status"]
                if current_status == "completed":
                    if (
                        row.get("analysis_version") == result.analysis_version
                        and row.get("ruleset_version") == result.ruleset_version
                        and row.get("result_schema_version") == result.schema_version
                    ):
                        return
                    raise ValueError(
                        f"conflict: analysis run already completed with version "
                        f"{row.get('analysis_version')}/{row.get('ruleset_version')}/{row.get('result_schema_version')}"
                    )
                if current_status != "processing":
                    raise ValueError(
                        f"invalid transition: analysis run is in state '{current_status}', expected 'processing'"
                    )
                connection.execute(
                    """
                    UPDATE analysis_runs
                    SET status = 'completed',
                        completed_at = now(), score = %s, verdict = %s, confidence = %s,
                        analysis_version = %s, ruleset_version = %s, result_schema_version = %s,
                        result_snapshot = %s::jsonb, failure_code = NULL, failure_message = NULL,
                        failed_at = NULL, retryable = false, updated_at = now()
                    WHERE id = %s
                    """,
                    (
                        result.score.final_score,
                        result.verdict.value,
                        result.confidence,
                        result.analysis_version,
                        result.ruleset_version,
                        result.schema_version,
                        payload,
                        result.analysis_run_id,
                    ),
                )
                self._insert_audit(
                    connection,
                    organization_id=str(row["organization_id"]),
                    action="analysis.run.completed",
                    resource_id=result.analysis_run_id,
                    metadata={"score": str(result.score.final_score), "verdict": result.verdict.value},
                )

    def save_failed(
        self, analysis_run_id: str, code: str, message: str, retryable: bool, request_id: str | None = None
    ) -> None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            with connection.transaction():
                row = connection.execute(
                    "SELECT status, organization_id FROM analysis_runs WHERE id = %s FOR UPDATE",
                    (analysis_run_id,),
                ).fetchone()
                if row is None:
                    raise ValueError("analysis run was not found")
                if row["status"] == "completed":
                    return
                connection.execute(
                    """
                    UPDATE analysis_runs
                    SET status = 'failed',
                        failure_code = %s, failure_message = %s, retryable = %s,
                        failed_at = now(), updated_at = now()
                    WHERE id = %s
                    """,
                    (code[:80], safe_failure_message(code, message), retryable, analysis_run_id),
                )
                self._insert_audit(
                    connection,
                    organization_id=str(row["organization_id"]),
                    action="analysis.run.failed",
                    resource_id=analysis_run_id,
                    metadata={
                        "code": code[:80],
                        "retryable": str(retryable).lower(),
                        **({"requestId": safe_request_id(request_id) or ""} if request_id else {}),
                    },
                )
