"""Deterministic OpenAPI export helper for analyzer contracts."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel
from pydantic.json_schema import models_json_schema

from app.contracts import models as m


def get_analyzer_contract_models() -> list[type[BaseModel]]:
    """Return all public BaseModel contract classes."""
    return [
        m.AnalysisIntakeRequest,
        m.AnalysisIntakeAccepted,
        m.AnalysisStatus,
        m.AnalysisFailure,
        m.Artifact,
        m.AddressObservation,
        m.HeaderObservation,
        m.ReceivedHop,
        m.AuthenticationObservation,
        m.MimePartObservation,
        m.IndicatorObservation,
        m.EnrichmentDetails,
        m.EnrichmentObservation,
        m.IdentityObservation,
        m.DateObservation,
        m.MessageIdObservation,
        m.ContentIndicatorObservation,
        m.LinkMismatchObservation,
        m.RoutingAnomalyObservation,
        m.AuthConflictObservation,
        m.Finding,
        m.ScoreBreakdown,
        m.AnalysisResult,
    ]


def build_analyzer_openapi(app: FastAPI) -> dict[str, Any]:
    """Generate deterministic OpenAPI schema containing the full forensic contract graph."""
    openapi = app.openapi()
    models = get_analyzer_contract_models()
    _, top_defs = models_json_schema(
        [(model, "validation") for model in models],
        by_alias=True,
        ref_template="#/components/schemas/{model}",
    )
    schemas = openapi.setdefault("components", {}).setdefault("schemas", {})
    for name, schema in top_defs.get("$defs", {}).items():
        schemas[name] = schema

    # Deterministically sort schemas
    openapi["components"]["schemas"] = dict(sorted(schemas.items()))
    return openapi
