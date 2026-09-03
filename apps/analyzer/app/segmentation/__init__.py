"""Container segmentation module."""

from app.contracts.models import ContainerFormat
from app.segmentation.segmenter import (
    detect_container,
    extract_safe_summary,
    find_bare_boundaries,
    segment,
)

__all__ = [
    "ContainerFormat",
    "detect_container",
    "extract_safe_summary",
    "find_bare_boundaries",
    "segment",
]
