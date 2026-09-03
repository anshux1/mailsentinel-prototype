"""Private S3 evidence adapter with streaming size and digest checks."""

import hashlib
import re
import secrets
from typing import Any

import boto3
from botocore.config import Config

from app.core.settings import Settings

_EVIDENCE_KEY_RE = re.compile(
    r"^organizations/([A-Za-z0-9_-]+)/cases/([A-Za-z0-9_-]+)/artifacts/([A-Za-z0-9_-]+(?:\.[a-zA-Z0-9]+)?)$"
)


class S3EvidenceStore:
    def __init__(self, settings: Settings) -> None:
        self.client = boto3.client(
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
        self.bucket = settings.s3_bucket

    def read_verified(
        self,
        object_key: str,
        expected_sha256: str,
        expected_size: int,
        max_bytes: int,
        expected_scope: tuple[str, str] | None = None,
    ) -> bytes:
        # Revalidate scope and object key syntax before storage access
        if (
            not object_key
            or ".." in object_key
            or "//" in object_key
            or "\\" in object_key
            or "\x00" in object_key
            or object_key.startswith("/")
        ):
            raise ValueError("evidence_not_found")

        match = _EVIDENCE_KEY_RE.match(object_key)
        if not match:
            raise ValueError("evidence_not_found")

        org_id, case_id, _ = match.groups()
        if expected_scope is not None:
            expected_org, expected_case = expected_scope
            if org_id != expected_org or case_id != expected_case:
                raise ValueError("evidence_not_found")

        # Reject early if expected size exceeds max allowed bytes
        if expected_size > max_bytes or expected_size < 0:
            raise ValueError("evidence_too_large" if expected_size > max_bytes else "evidence_size_mismatch")

        # 1. Metadata Preflight
        try:
            head_response = self.client.head_object(Bucket=self.bucket, Key=object_key)
            if isinstance(head_response, dict):
                content_length = head_response.get("ContentLength")
                if content_length is not None and not isinstance(content_length, Exception):
                    try:
                        cl = int(content_length)
                        if cl > max_bytes:
                            raise ValueError("evidence_too_large")
                        if cl != expected_size or cl < 0:
                            raise ValueError("evidence_size_mismatch")
                    except (TypeError, ValueError) as err:
                        if isinstance(err, ValueError) and str(err) in ("evidence_too_large", "evidence_size_mismatch"):
                            raise
                meta = head_response.get("Metadata")
                if isinstance(meta, dict):
                    meta_sha = meta.get("sha256")
                    if meta_sha and not secrets.compare_digest(str(meta_sha).lower(), expected_sha256.lower()):
                        raise ValueError("evidence_digest_mismatch")
        except ValueError:
            raise
        except Exception as error:
            error_code = ""
            if hasattr(error, "response") and isinstance(error.response, dict):
                error_code = str(error.response.get("Error", {}).get("Code", ""))
            if error_code in ("NoSuchKey", "404", "NoSuchBucket", "NotFound"):
                raise ValueError("evidence_not_found") from None
            raise ValueError("evidence_storage_unavailable") from None

        # 2. Hard Streamed Read with Guaranteed Body Close
        body = None
        try:
            response: dict[str, Any] = self.client.get_object(Bucket=self.bucket, Key=object_key)
            body = response.get("Body") if isinstance(response, dict) else None
            if body is None:
                raise ValueError("evidence_storage_unavailable")

            digest = hashlib.sha256()
            chunks: list[bytes] = []
            total = 0
            while True:
                remaining = max_bytes + 1 - total
                if remaining <= 0:
                    raise ValueError("evidence_too_large")
                chunk = body.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("evidence_too_large")
                if total > expected_size:
                    raise ValueError("evidence_size_mismatch")
                digest.update(chunk)
                chunks.append(chunk)

            if total != expected_size:
                raise ValueError("evidence_size_mismatch")
            if not secrets.compare_digest(digest.hexdigest(), expected_sha256.lower()):
                raise ValueError("evidence_digest_mismatch")
            return b"".join(chunks)
        except ValueError:
            raise
        except Exception as error:
            error_code = ""
            if hasattr(error, "response") and isinstance(error.response, dict):
                error_code = str(error.response.get("Error", {}).get("Code", ""))
            if error_code in ("NoSuchKey", "404", "NoSuchBucket", "NotFound"):
                raise ValueError("evidence_not_found") from None
            raise ValueError("evidence_storage_unavailable") from None
        finally:
            if body is not None and hasattr(body, "close"):
                body.close()
