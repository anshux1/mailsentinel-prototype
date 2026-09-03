"""Forensic extraction APIs."""

from app.extraction.extract import (
    extract_addresses,
    extract_auth_conflicts,
    extract_authentication,
    extract_content_indicators,
    extract_date,
    extract_headers,
    extract_identity,
    extract_indicators,
    extract_link_mismatches,
    extract_message_ids,
    extract_mime_parts,
    extract_received,
    extract_routing_anomalies,
)

# Naming aliases for service integrations.
extract_dates = extract_date
extract_date_header = extract_date
extract_message_id = extract_message_ids
extract_authentication_conflicts = extract_auth_conflicts
extract_routing_observations = extract_routing_anomalies
extract_content_observations = extract_content_indicators
extract_html_link_mismatches = extract_link_mismatches

__all__ = [
    "extract_addresses",
    "extract_auth_conflicts",
    "extract_authentication",
    "extract_authentication_conflicts",
    "extract_content_indicators",
    "extract_content_observations",
    "extract_date",
    "extract_date_header",
    "extract_dates",
    "extract_headers",
    "extract_identity",
    "extract_indicators",
    "extract_link_mismatches",
    "extract_html_link_mismatches",
    "extract_message_id",
    "extract_message_ids",
    "extract_mime_parts",
    "extract_received",
    "extract_routing_anomalies",
    "extract_routing_observations",
]
