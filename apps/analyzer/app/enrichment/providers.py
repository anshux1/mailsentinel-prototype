"""Bounded, offline-first indicator enrichment adapters.

The analyzer never resolves hosts and never sends message content to an enrichment
provider.  Live enrichment is deliberately opt-in and all provider failures are
represented as missing/partial enrichment rather than analysis failures.
"""

from __future__ import annotations

import csv
import ipaddress
import json
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

from app.contracts.models import EnrichmentDetails, EnrichmentObservation, IndicatorObservation


class EnrichmentProvider(Protocol):
    @property
    def name(self) -> str: ...

    def lookup(self, indicator: IndicatorObservation) -> EnrichmentObservation | None: ...


def _private_or_reserved_ip(value: str) -> bool:
    try:
        parsed = ipaddress.ip_address(value.strip())
    except ValueError:
        return False
    return not parsed.is_global


def _cache_key(provider: str, indicator: IndicatorObservation) -> str:
    """Return a stable key without URL credentials, queries, or fragments."""
    kind = indicator.kind.lower().strip()[:30]
    value = indicator.normalized_value.lower().strip()[:2000]
    if kind == "url":
        try:
            parsed = urlsplit(value)
            host = parsed.hostname or ""
            # A cache key is not an evidence store: omit userinfo and query
            # secrets while preserving enough identity for deduplication.
            value = f"{parsed.scheme}://{host}{parsed.path or '/'}"
        except ValueError:
            value = value.split("?", 1)[0].split("#", 1)[0]
    return f"enrichment:{provider.lower()}:{kind}:{value[:500]}"


@dataclass
class InMemoryIndicatorCache:
    """Thread-safe bounded TTL cache.

    Values are copied on the way in and out so a caller cannot mutate a cached
    observation and make later analyses non-deterministic.
    """

    ttl_seconds: float = 86_400.0
    max_entries: int = 10_000
    _entries: OrderedDict[str, tuple[float, EnrichmentObservation | None]] = field(
        default_factory=OrderedDict, init=False
    )
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    @staticmethod
    def key(provider: str, indicator: IndicatorObservation) -> str:
        return _cache_key(provider, indicator)

    def get_with_presence(
        self, provider: str, indicator: IndicatorObservation
    ) -> tuple[bool, EnrichmentObservation | None]:
        key = _cache_key(provider, indicator)
        with self._lock:
            item = self._entries.get(key)
            if item is None:
                return False, None
            expires_at, value = item
            if expires_at <= time.monotonic():
                self._entries.pop(key, None)
                return False, None
            self._entries.move_to_end(key)
            return True, value.model_copy(deep=True) if value is not None else None

    def get(self, provider: str, indicator: IndicatorObservation) -> EnrichmentObservation | None:
        return self.get_with_presence(provider, indicator)[1]

    def set(self, provider: str, indicator: IndicatorObservation, value: EnrichmentObservation | None) -> None:
        key = _cache_key(provider, indicator)
        with self._lock:
            self._entries[key] = (
                time.monotonic() + max(0.0, self.ttl_seconds),
                value.model_copy(deep=True) if value is not None else None,
            )
            self._entries.move_to_end(key)
            while len(self._entries) > max(1, self.max_entries):
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


# Friendly aliases used by integrations/tests.
IndicatorCache = InMemoryIndicatorCache
make_cache_key = _cache_key
_LIVE_LOOKUP_SEMAPHORE = threading.BoundedSemaphore(10)


@dataclass
class RedisIndicatorCache:
    """Small Redis adapter with the same semantics as the in-memory cache.

    The Redis client is injected rather than constructed here, which keeps all
    offline tests network-free and makes connection failures safely ignorable by
    ``enrich``.
    """

    client: Any
    ttl_seconds: int = 86_400
    prefix: str = ""

    def _key(self, provider: str, indicator: IndicatorObservation) -> str:
        return f"{self.prefix}{_cache_key(provider, indicator)}"

    def get_with_presence(
        self, provider: str, indicator: IndicatorObservation
    ) -> tuple[bool, EnrichmentObservation | None]:
        try:
            raw = self.client.get(self._key(provider, indicator))
            if raw is None:
                return False, None
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            parsed = json.loads(str(raw))
            if isinstance(parsed, dict) and parsed.get("_negative") is True:
                return True, None
            return True, EnrichmentObservation.model_validate(parsed)
        except Exception:
            return False, None

    def get(self, provider: str, indicator: IndicatorObservation) -> EnrichmentObservation | None:
        return self.get_with_presence(provider, indicator)[1]

    def set(self, provider: str, indicator: IndicatorObservation, value: EnrichmentObservation | None) -> None:
        try:
            self.client.setex(
                self._key(provider, indicator),
                max(1, int(self.ttl_seconds)),
                json.dumps(value.model_dump(mode="json") if value is not None else {"_negative": True}, sort_keys=True),
            )
        except Exception:
            # Cache availability must never affect an analysis.
            return


@dataclass(frozen=True)
class FixtureProvider:
    """Stable synthetic reputation data used by local and automated runs."""

    name: str = "fixture"

    def lookup(self, indicator: IndicatorObservation) -> EnrichmentObservation | None:
        if indicator.private_or_reserved or (
            indicator.kind == "ip" and _private_or_reserved_ip(indicator.normalized_value)
        ):
            return None
        if indicator.kind not in {"ip", "domain", "url"}:
            return None
        value = indicator.normalized_value.lower()
        if any(token in value for token in ("malware", "phishing", "credential")):
            reputation, score = "malicious", 95
        else:
            reputation, score = "unknown", 0
        return EnrichmentObservation(
            indicator=indicator.normalized_value,
            provider=self.name,
            mode="fixture",
            reputation=reputation,
            score=score,
            details=EnrichmentDetails(deterministic=True),
        )


@dataclass(frozen=True)
class OfflineProvider:
    """File-backed local reputation/GeoIP adapter.

    ``records`` keeps compatibility with the original deterministic adapter and
    accepts ``(reputation, score)`` tuples.  ``database_path`` may point to JSON,
    CSV/TSV, or an optional MaxMind DB.  File records can be either tuples/lists
    or objects containing reputation, score, ASN, country and category fields.
    """

    records: dict[str, Any] = field(default_factory=dict)
    database_path: Path | None = None
    maxmind_path: Path | None = None
    name: str = "offline"
    _maxmind_reader: Any = field(default=None, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        loaded = self._load_records(self.database_path) if self.database_path else {}
        merged = {**loaded, **self.records}
        object.__setattr__(self, "records", merged)
        if self.maxmind_path is not None and self.maxmind_path.suffix.lower() == ".mmdb":
            try:
                import maxminddb

                object.__setattr__(self, "_maxmind_reader", maxminddb.open_database(str(self.maxmind_path)))
            except (ImportError, OSError, ValueError):
                # MaxMind is an optional deployment dependency.
                object.__setattr__(self, "_maxmind_reader", None)

    @staticmethod
    def _load_records(path: Path) -> dict[str, Any]:
        try:
            if not path.is_file() or path.stat().st_size > 25_000_000:
                return {}
            suffix = path.suffix.lower()
            if suffix == ".json":
                data = json.loads(path.read_text(encoding="utf-8"))
                return data if isinstance(data, dict) else {}
            if suffix in {".csv", ".tsv"}:
                delimiter = "\t" if suffix == ".tsv" else ","
                with path.open(newline="", encoding="utf-8") as stream:
                    return {
                        str(row.get("indicator") or row.get("ip") or row.get("domain") or "").lower(): row
                        for row in csv.DictReader(stream, delimiter=delimiter)
                        if row.get("indicator") or row.get("ip") or row.get("domain")
                    }
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError, csv.Error):
            return {}
        # MaxMind support is optional: deployments can install maxminddb without
        # making it a requirement for the offline/fixture analyzer package.
        return {}

    def lookup(self, indicator: IndicatorObservation) -> EnrichmentObservation | None:
        if indicator.private_or_reserved or (
            indicator.kind == "ip" and _private_or_reserved_ip(indicator.normalized_value)
        ):
            return None
        if indicator.kind not in {"ip", "domain"}:
            return None
        key = indicator.normalized_value.lower()
        record = self.records.get(key)
        if record is None and self._maxmind_reader is not None and indicator.kind == "ip":
            try:
                maxmind_record = self._maxmind_reader.get(key)
            except Exception:
                maxmind_record = None
            if isinstance(maxmind_record, dict):
                # GeoIP2 Country/ASN databases use different nested sections.
                country_data = maxmind_record.get("country") or maxmind_record.get("registered_country") or {}
                asn_value = maxmind_record.get("autonomous_system_number")
                org_value = maxmind_record.get("autonomous_system_organization")
                record = {
                    "country": country_data.get("iso_code") if isinstance(country_data, dict) else None,
                    "asn": f"AS{asn_value}" if asn_value is not None else None,
                    "category": str(org_value)[:100] if org_value else None,
                    "reputation": "unknown",
                    "score": 0,
                    "deterministic": True,
                    "raw_score": None,
                }
        if record is None:
            return None

        reputation = "unknown"
        score = 0
        asn: str | None = None
        country: str | None = None
        category: str | None = None
        raw_score: int | None = None
        deterministic = True
        if isinstance(record, (tuple, list)):
            if record:
                reputation = str(record[0]).lower()[:40]
            if len(record) > 1:
                try:
                    score = max(0, min(100, int(record[1])))
                except (TypeError, ValueError):
                    score = 0
        elif isinstance(record, dict):
            reputation = str(record.get("reputation", "unknown")).lower()[:40]
            try:
                score = max(0, min(100, int(record.get("score", 0))))
            except (TypeError, ValueError):
                score = 0
            raw_value = record.get("raw_score") or record.get("rawScore")
            try:
                raw_score = max(0, min(1000, int(raw_value))) if raw_value is not None else None
            except (TypeError, ValueError):
                raw_score = None
            asn = str(record.get("asn"))[:100] if record.get("asn") else None
            country = str(record.get("country") or record.get("country_code") or "").upper()[:2] or None
            category = str(record.get("category"))[:100] if record.get("category") else None
            deterministic = bool(record.get("deterministic", True))
        else:
            return None
        return EnrichmentObservation(
            indicator=indicator.normalized_value,
            provider=self.name,
            mode="offline",
            reputation=reputation,
            score=score,
            details=EnrichmentDetails(
                deterministic=deterministic,
                category=category,
                asn=asn,
                country=country,
                raw_score=raw_score,
            ),
        )


# Explicit name for callers that want to distinguish local DB lookup.
LocalDatabaseProvider = OfflineProvider


@dataclass
class AbuseIPDBProvider:
    """Timeout-bounded, opt-in AbuseIPDB v2 adapter.

    Only a normalized public IP is submitted.  HTTP failures, malformed payloads,
    429s, and timeouts return ``None``; callers therefore remain in degraded mode.
    """

    api_key: str
    endpoint: str = "https://api.abuseipdb.com/api/v2/check"
    connect_timeout_seconds: float = 2.0
    read_timeout_seconds: float = 3.0
    name: str = "abuseipdb"

    def __post_init__(self) -> None:
        if not self.api_key.strip():
            raise ValueError("live enrichment API key is required")
        if urlsplit(self.endpoint).scheme != "https" or not urlsplit(self.endpoint).netloc:
            raise ValueError("live enrichment endpoint must use HTTPS")
        if self.connect_timeout_seconds <= 0 or self.connect_timeout_seconds > 2:
            raise ValueError("live enrichment connect timeout must be between 0 and 2 seconds")
        if self.read_timeout_seconds <= 0 or self.read_timeout_seconds > 3:
            raise ValueError("live enrichment read timeout must be between 0 and 3 seconds")

    def _fetch(self, ip: str) -> dict[str, Any] | None:
        parsed = urlsplit(self.endpoint)
        if parsed.scheme != "https" or not parsed.netloc:
            return None
        url = f"{self.endpoint}?ipAddress={quote(ip, safe=':.')}"
        request = Request(
            url,
            headers={"Accept": "application/json", "Key": self.api_key[:500]},
            method="GET",
        )
        # A two-second upper bound is stricter than the required connect/read
        # bounds for urllib's single timeout.  No unbounded request is possible.
        timeout = max(0.1, min(2.0, self.connect_timeout_seconds, self.read_timeout_seconds))
        try:
            with urlopen(request, timeout=timeout) as response:  # noqa: S310 (endpoint is validated above)
                body = response.read(1_000_001)
            if len(body) > 1_000_000:
                return None
            parsed_body = json.loads(body.decode("utf-8"))
            return parsed_body if isinstance(parsed_body, dict) else None
        except HTTPError:
            # 429 is intentionally treated as a degraded lookup, not a failure.
            return None
        except (URLError, TimeoutError, OSError, UnicodeError, ValueError, json.JSONDecodeError):
            return None

    def lookup(self, indicator: IndicatorObservation) -> EnrichmentObservation | None:
        if (
            indicator.kind != "ip"
            or indicator.private_or_reserved
            or _private_or_reserved_ip(indicator.normalized_value)
        ):
            return None
        payload = self._fetch(indicator.normalized_value)
        if not payload:
            return None
        data = payload.get("data")
        if not isinstance(data, dict):
            return None
        try:
            raw_score_value = data.get("abuseConfidenceScore")
            if raw_score_value is None:
                return None
            raw_score = int(raw_score_value)
        except (TypeError, ValueError):
            return None
        if not 0 <= raw_score <= 100:
            return None
        if raw_score >= 80:
            reputation = "malicious"
        elif raw_score >= 50:
            reputation = "suspicious"
        else:
            reputation = "unknown"
        country = str(data.get("countryCode") or "").upper()[:2] or None
        asn_value = data.get("asn")
        asn = str(asn_value)[:100] if asn_value is not None else None
        category = str(data.get("usageType"))[:100] if data.get("usageType") else None
        return EnrichmentObservation(
            indicator=indicator.normalized_value,
            provider=self.name,
            mode="live",
            reputation=reputation,
            score=raw_score,
            details=EnrichmentDetails(
                deterministic=False,
                category=category,
                asn=asn,
                country=country,
                raw_score=raw_score,
            ),
        )


@dataclass(frozen=True)
class EnrichmentConfig:
    mode: str = "fixture"
    max_requests: int = 10
    cache_ttl_seconds: float = 86_400.0
    live_cache_ttl_seconds: float = 3_600.0
    connect_timeout_seconds: float = 2.0
    read_timeout_seconds: float = 3.0
    offline_database_path: Path | None = None
    maxmind_database_path: Path | None = None
    live_api_key: str | None = None


def enrich(
    indicators: list[IndicatorObservation],
    mode: str,
    *,
    config: EnrichmentConfig | None = None,
    provider: EnrichmentProvider | None = None,
    cache: InMemoryIndicatorCache | RedisIndicatorCache | None = None,
) -> list[EnrichmentObservation]:
    """Enrich bounded unique indicators without allowing provider errors to escape."""
    cfg = config or EnrichmentConfig(mode=mode)
    selected: EnrichmentProvider | None = provider
    if selected is None and mode == "fixture":
        selected = FixtureProvider()
    elif selected is None and mode == "offline":
        selected = OfflineProvider(
            database_path=cfg.offline_database_path,
            maxmind_path=cfg.maxmind_database_path or cfg.offline_database_path,
        )
    elif selected is None and mode == "live" and cfg.live_api_key:
        selected = AbuseIPDBProvider(
            api_key=cfg.live_api_key,
            connect_timeout_seconds=min(2.0, cfg.connect_timeout_seconds),
            read_timeout_seconds=min(3.0, cfg.read_timeout_seconds),
        )
    if selected is None:
        return []

    results: list[EnrichmentObservation] = []
    seen: set[tuple[str, str]] = set()
    requests = 0
    max_requests = max(0, min(int(cfg.max_requests), 1000))
    for indicator in indicators:
        key = (indicator.kind.lower(), indicator.normalized_value.lower())
        if key in seen:
            continue
        seen.add(key)
        if indicator.kind == "ip" and (
            indicator.private_or_reserved or _private_or_reserved_ip(indicator.normalized_value)
        ):
            continue
        # A live provider must never receive a full URL (query strings can carry
        # credentials or per-message secrets). Built-in live providers use IPs.
        if mode == "live" and indicator.kind == "url":
            continue
        cache_hit = False
        cached: EnrichmentObservation | None = None
        if cache is not None:
            get_with_presence = getattr(cache, "get_with_presence", None)
            if callable(get_with_presence):
                cache_hit, cached = get_with_presence(selected.name, indicator)
            else:
                cached = cache.get(selected.name, indicator)
                cache_hit = cached is not None
        if cache_hit:
            if cached is not None:
                results.append(cached)
            continue
        if requests >= max_requests and mode == "live":
            break
        # A live provider can only query public IPs. Skipping unsupported kinds
        # avoids counting a non-request as a request and avoids accidental future
        # URL/domain submission changes.
        if mode == "live" and indicator.kind != "ip":
            continue
        requests += 1
        acquired = True
        if mode == "live":
            acquired = _LIVE_LOOKUP_SEMAPHORE.acquire(timeout=min(3.0, cfg.read_timeout_seconds))
        if not acquired:
            value = None
        else:
            try:
                value = selected.lookup(indicator)
            except Exception:
                value = None
            finally:
                if mode == "live":
                    _LIVE_LOOKUP_SEMAPHORE.release()
        if cache is not None:
            try:
                cache.set(selected.name, indicator, value)
            except Exception:
                pass
        if value is not None:
            results.append(value)
    return results
