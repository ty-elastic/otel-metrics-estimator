#!/usr/bin/env python3
"""
OTel Collector Metrics Estimator

Given a local path to an OTel collector repo, finds all metadata.yaml files
under the `receiver` directory, parses metric definitions, builds an exemplary
JSON document for each, and reports the estimated byte size.
"""

import argparse
import base64
import hashlib
import itertools
import json
import random
import sys
from datetime import datetime, timezone
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


# ---------------------------------------------------------------------------
# Metric schema helpers
# ---------------------------------------------------------------------------

_INT_EXAMPLE = 42
_DOUBLE_EXAMPLE = 3.14

_HISTOGRAM_EXAMPLE = {
    "count": 10,
    "sum": 123.45,
    "bucket_counts": [1, 2, 3, 2, 1, 1],
    "explicit_bounds": [0.005, 0.01, 0.025, 0.05, 0.1],
}
_EXPONENTIAL_HISTOGRAM_EXAMPLE = {
    "count": 10,
    "sum": 123.45,
    "scale": 1,
    "zero_count": 0,
    "positive": {"offset": 0, "bucket_counts": [1, 2, 3, 2, 1, 1]},
    "negative": {"offset": 0, "bucket_counts": [0, 0, 0, 0, 0, 0]},
}
_SUMMARY_EXAMPLE = {
    "count": 10,
    "sum": 123.45,
    "quantile_values": [
        {"quantile": 0.5, "value": 10.0},
        {"quantile": 0.9, "value": 20.0},
        {"quantile": 0.99, "value": 30.0},
    ],
}


# Ordered suffix patterns → exemplary value (most specific / longest suffix first).
# Matching uses str.endswith(), so "client.address" matches the attribute name
# "client.address" or "server.client.address", while "address" matches any name
# ending in "address".
_ATTRIBUTE_PATTERNS: list[tuple[str, Any]] = [
    # Network / addressing
    ("network.peer.address", "192.168.1.100"),
    ("network.peer.port",    5432),
    ("peer.address",         "192.168.1.100"),
    ("peer.port",            5432),
    ("client.address",       "192.168.1.1"),
    ("client.port",          54321),
    ("address",              "192.168.1.1"),
    ("port",                 8080),
    ("protocol",             "tcp"),
    ("interface",            "eth"),
    # HTTP
    ("http.url",             "https://example.com/api"),
    ("http.method",          "GET"),
    ("http.status_code",     200),
    ("http.status",          200),
    ("url",                  "https://example.com"),
    ("method",               "GET"),
    # Database
    ("db.query.text",        "SELECT * FROM users WHERE id = ?"),
    ("db.system.name",       "postgresql"),
    ("db.query",             "SELECT * FROM users WHERE id = ?"),
    ("db.namespace",         "mydb"),
    ("db.system",            "postgresql"),
    ("db.name",              "mydb"),
    ("query.text",           "SELECT * FROM users WHERE id = ?"),
    ("table",                "users"),
    ("schema",               "public"),
    ("index",                "my-index"),
    ("namespace",            "default"),
    ("partition",            0),
    ("topic",                "events"),
    ("queue",                "work-queue"),
    # Errors
    ("error.message",        "connection refused"),
    ("error",                "connection refused"),
    # Compute / OS
    ("device",               "sda"),
    ("disk",                 "sda"),
    ("cpu",                  "cpu"),
    ("core",                 "cpu"),
    ("thread",               "worker"),
    ("process",              "my-process"),
    ("container",            "my-container"),
    ("pod",                  "my-pod-abc"),
    ("node",                 "node"),
    ("cluster",              "prod-cluster"),
    ("host",                 "localhost"),
    ("service",              "web-server"),
    # Cloud
    ("region",               "us-east"),
    ("zone",                 "us-east"),
    ("bucket",               "my-bucket"),
    # Paths / files
    ("path",                 "/var/log/app.log"),
    ("file",                 "/var/log/app.log"),
    # Identity
    ("user.name",            "alice"),
    ("user",                 "alice"),
    ("account",              "123456789"),
    ("key",                  "my-key"),
    # Status / state
    ("state",                "active"),
    ("status",               "running"),
    ("mode",                 "0755"),
    ("direction",            "receive"),
    ("operation",            "read"),
    ("type",                 "primary"),
    ("class",                "standard"),
    # Versioning / identity
    ("version",              "1.0"),
    ("id",                   "abc"),
    ("name",                 "example"),
]


def _example_value_for_attribute(attr_def: dict, name: str) -> Any:
    """Return an exemplary Python value for an attribute definition.

    Resolution order:
      1. Enum  → random choice
      2. Suffix pattern match in _ATTRIBUTE_PATTERNS (most specific first)
      3. Type-based fallback
    """
    enum = attr_def.get("enum")
    if enum:
        return random.choice(enum)

    # Suffix pattern match (case-insensitive, most specific pattern wins)
    name_lower = name.lower()
    for pattern, value in _ATTRIBUTE_PATTERNS:
        if name_lower.endswith(pattern):
            return value

    # Type-based fallback
    atype = attr_def.get("type", "string")
    if atype == "int":
        return _INT_EXAMPLE
    if atype == "double":
        return _DOUBLE_EXAMPLE
    if atype == "bool":
        return True
    if atype == "slice":
        return ["example"]
    return "example"


# ---------------------------------------------------------------------------
# Processor resource-attribute scanner
# ---------------------------------------------------------------------------

def scan_processor_resource_attrs(
    repo_root: Path,
    processor_names: list[str],
) -> dict[str, dict[str, Any]]:
    """Scan ``processor/`` directory and extract resource_attributes for each
    requested processor.

    Matching rules (tried in order for each ``processor_names`` entry):
    1. Exact match: metadata ``type`` == config name.
    2. Prefix match: config name is ``<type>/<qualifier>`` and metadata ``type`` == ``<type>``.
       Useful when a single metadata file covers multiple logical sub-components.

    Returns a dict mapping each config processor name to a sub-dict:
    ``{"label": str, "attrs": {attr_name: example_value}}``.
    Only processors for which a matching metadata file with resource_attributes
    is found are included.
    """
    processor_dir = repo_root / "processor"
    if not processor_dir.is_dir():
        return {}

    # Build lookup: metadata type → (label, {attr_name: example_value})
    type_to_data: dict[str, tuple[str, dict[str, Any]]] = {}
    for meta_file in sorted(processor_dir.rglob("metadata.yaml")):
        try:
            doc = yaml.safe_load(meta_file.read_bytes()) or {}
        except Exception:
            continue
        if not isinstance(doc, dict):
            continue
        proc_type = str(doc.get("type") or "").strip()
        if not proc_type:
            continue
        ra_section = doc.get("resource_attributes") or {}
        if not isinstance(ra_section, dict) or not ra_section:
            continue
        attrs: dict[str, Any] = {}
        for attr_key, attr_def in ra_section.items():
            if not isinstance(attr_def, dict):
                continue
            name = str(attr_def.get("name_override") or attr_key)
            attrs[name] = _example_value_for_attribute(attr_def, name)
        if not attrs:
            continue
        label = str(doc.get("display_name") or proc_type)
        type_to_data[proc_type] = (label, attrs)

    result: dict[str, dict[str, Any]] = {}
    for proc_name in processor_names:
        base = proc_name.split("/")[0]
        match = type_to_data.get(proc_name) or type_to_data.get(base)
        if match:
            label, attrs = match
            result[proc_name] = {"label": label, "attrs": attrs}

    return result


def _read_collector_version(repo_root: Path) -> str:
    """Read the collector version from versions.yaml (contrib-base module set)."""
    versions_file = repo_root / "versions.yaml"
    try:
        data = yaml.safe_load(versions_file.read_bytes())
        version = data["module-sets"]["contrib-base"]["version"]
        return str(version).lstrip("v")
    except Exception:
        return ""


def _metered_bytes(value: Any) -> int:
    """Recursively compute the metered cost of a JSON-compatible value.

    Rules:
      - bool   → 1 byte   (must be checked before int, as bool subclasses int)
      - number → 8 bytes  (int or float)
      - str    → UTF-8 encoded byte length
      - bytes  → base64 encoded byte length
      - list   → sum of metered cost of each element
      - dict   → sum of metered cost of each *value* (keys are not counted)
      - None   → 0 bytes
    """
    if isinstance(value, bool):
        return 1
    if isinstance(value, (int, float)):
        return 8
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    if isinstance(value, bytes):
        return len(base64.b64encode(value))
    if isinstance(value, list):
        return sum(_metered_bytes(item) for item in value)
    if isinstance(value, dict):
        return sum(_metered_bytes(v) for v in value.values())
    return 0  # None / unknown


def _example_value_for_metric(metric_def: dict) -> Any:
    """Return an exemplary Python value for a metric definition."""
    for mtype in ("gauge", "sum"):
        if mtype in metric_def:
            vtype = metric_def[mtype].get("value_type", "int")
            return _DOUBLE_EXAMPLE if vtype == "double" else _INT_EXAMPLE

    if "histogram" in metric_def:
        return _HISTOGRAM_EXAMPLE

    if "exponential_histogram" in metric_def:
        return _EXPONENTIAL_HISTOGRAM_EXAMPLE

    if "summary" in metric_def:
        return _SUMMARY_EXAMPLE

    # Unknown / future type — fall back to an integer
    return _INT_EXAMPLE


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

@dataclass
class ReceiverReport:
    receiver: str
    metadata_path: str       # relative to repo root
    scraper: str             # parent folder of the metadata.yaml file
    metric_count: int
    json_bytes: int
    metered_bytes: int = 0
    doc_count: int = 0
    error: str = ""
    description: str = ""
    display_name: str = ""
    metrics: list[str] = field(default_factory=list)
    attributes: list[dict[str, Any]] = field(default_factory=list)
    resource_attributes: list[dict[str, Any]] = field(default_factory=list)
    example_docs: list[dict[str, Any]] = field(default_factory=list)



def process_metadata(
    file_path: Path,
    repo_root: Path,
    collector_version: str = "",
    processor_resource_attrs: dict[str, Any] | None = None,
) -> ReceiverReport:
    """Parse one metadata.yaml and return a ReceiverReport."""
    rel = file_path.relative_to(repo_root)
    rel_str = rel.as_posix()

    # Receiver name is the directory immediately under receiver/
    # e.g. receiver/hostmetricsreceiver/internal/scraper/.../metadata.yaml -> hostmetricsreceiver
    parts = rel.parts
    receiver_name = parts[1] if len(parts) >= 2 else rel_str
    scraper_name = file_path.parent.name

    try:
        raw = file_path.read_bytes()
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        return ReceiverReport(
            receiver=receiver_name,
            metadata_path=rel_str,
            scraper=scraper_name,
            metric_count=0,
            json_bytes=0,
            error=f"YAML parse error: {exc}",
        )
    except OSError as exc:
        return ReceiverReport(
            receiver=receiver_name,
            metadata_path=rel_str,
            scraper=scraper_name,
            metric_count=0,
            json_bytes=0,
            error=f"Read error: {exc}",
        )

    if not isinstance(doc, dict):
        return ReceiverReport(
            receiver=receiver_name,
            metadata_path=rel_str,
            scraper=scraper_name,
            metric_count=0,
            json_bytes=0,
            error="No top-level mapping found",
        )

    metadata_description = (doc.get("description") or "").strip()
    display_name = (doc.get("display_name") or "").strip()

    metrics_section = doc.get("metrics") or {}
    if not metrics_section:
        return ReceiverReport(
            receiver=receiver_name,
            metadata_path=rel_str,
            scraper=scraper_name,
            metric_count=0,
            json_bytes=0,
            description=metadata_description,
            display_name=display_name,
        )

    # Build per-metric attribute key lookup from the scraper's attributes section.
    attributes_section = doc.get("attributes") or {}

    # Build resource attributes block — identical across all docs in this scraper.
    resource_attributes_section = doc.get("resource_attributes") or {}
    example_resource_attributes: dict[str, Any] = {}
    resource_attributes_list: list[dict[str, Any]] = []
    for attr_key, attr_def in resource_attributes_section.items():
        if not isinstance(attr_def, dict):
            continue
        example_resource_attributes[attr_key] = _example_value_for_attribute(attr_def, attr_key)
        name = str(attr_def.get("name_override") or attr_key)
        enum = attr_def.get("enum")
        ra_description = str(attr_def.get("description") or "")
        if enum:
            resource_attributes_list.append({"name": name, "type": "enum", "description": ra_description, "values": list(enum)})
        else:
            attr_type = str(attr_def.get("type") or "string")
            resource_attributes_list.append({"name": name, "type": attr_type, "description": ra_description})

    combined: dict[str, Any] = dict(processor_resource_attrs or {})
    combined.update(example_resource_attributes)
    resource_block = {
        "schema_url": "https://opentelemetry.io/schemas/1.9.0",
        "attributes": combined,
    }

    # Group metrics into documents.
    # Two metrics belong in the same doc only when they share the same unit,
    # the same set of attribute keys, and the same parent path segment
    # (i.e. everything in the metric name except the final component).
    metric_groups: dict[tuple, dict[str, Any]] = defaultdict(dict)
    for metric_name, metric_def in metrics_section.items():
        if not isinstance(metric_def, dict):
            continue
        unit_val = str(metric_def.get("unit") or "")
        attr_keys: frozenset[str] = frozenset(metric_def.get("attributes") or [])
        parent_path = ".".join(metric_name.split(".")[:-1])
        key = (unit_val, attr_keys, parent_path)
        metric_groups[key][metric_name] = _example_value_for_metric(metric_def)

    # Collect all attributes referenced by any metric in this scraper.
    all_attr_keys: set[str] = set()
    attr_key_to_metrics: dict[str, list[str]] = defaultdict(list)
    for (_, attr_keys, _), group_metrics in metric_groups.items():
        all_attr_keys.update(attr_keys)
        for attr_key in attr_keys:
            for metric_name in group_metrics:
                if metric_name not in attr_key_to_metrics[attr_key]:
                    attr_key_to_metrics[attr_key].append(metric_name)
    attributes: list[dict[str, Any]] = []
    seen_attrs: set[str] = set()
    for attr_key in sorted(all_attr_keys):
        attr_def = attributes_section.get(attr_key)
        if not isinstance(attr_def, dict):
            continue
        name = str(attr_def.get("name_override") or attr_key)
        if name in seen_attrs:
            continue
        seen_attrs.add(name)
        enum = attr_def.get("enum")
        description = str(attr_def.get("description") or "")
        metrics_for_attr = sorted(attr_key_to_metrics.get(attr_key, []))
        if enum:
            attributes.append({"name": name, "type": "enum", "description": description, "values": list(enum), "metrics": metrics_for_attr})
        else:
            attr_type = str(attr_def.get("type") or "string")
            attributes.append({"name": name, "type": attr_type, "description": description, "metrics": metrics_for_attr})

    # Shared fields computed once for all docs in this scraper.
    now = datetime.now(timezone.utc)
    ts = int(now.timestamp() * 1000)
    scope_name = (
        "github.com/open-telemetry/opentelemetry-collector-contrib/"
        + file_path.parent.relative_to(repo_root).as_posix()
    )

    example_docs: list[dict[str, Any]] = []
    total_json_bytes = 0
    total_metered_bytes = 0
    all_metrics: list[str] = []

    for (unit_val, attr_keys, _parent), group_metrics in metric_groups.items():
        all_metrics.extend(group_metrics.keys())

        # One doc per group: pick a single random enum value for each enum attribute.
        group_attributes: dict[str, Any] = {}
        for attr_key in sorted(attr_keys):
            attr_def = attributes_section.get(attr_key)
            if not isinstance(attr_def, dict):
                continue
            name = str(attr_def.get("name_override") or attr_key)
            enum = attr_def.get("enum")
            if enum:
                group_attributes[name] = random.choice(enum)
            else:
                group_attributes[name] = _example_value_for_attribute(attr_def, name)

        metric_names_hash = hashlib.md5(
            ",".join(sorted(group_metrics.keys())).encode()
        ).hexdigest()[:16]

        wrapped: dict[str, Any] = {
            "@timestamp": ts,
            "start_timestamp": ts,
            "unit": unit_val,
            "_metric_names_hash": metric_names_hash,
            "scope": {
                "name": scope_name,
                "version": collector_version,
            },
            "data_stream": {
                "dataset": f"{receiver_name}.otel",
                "namespace": "default",
                "type": "metrics",
            },
            "metrics": group_metrics,
        }
        wrapped["resource"] = resource_block
        if group_attributes:
            wrapped["attributes"] = group_attributes

        sized = {k: v for k, v in wrapped.items() if k != "data_stream"}
        json_str = json.dumps(sized, separators=(",", ":"))
        total_json_bytes += len(json_str.encode("utf-8"))
        total_metered_bytes += _metered_bytes(sized)
        example_docs.append(wrapped)

    return ReceiverReport(
        receiver=receiver_name,
        metadata_path=rel_str,
        scraper=scraper_name,
        metric_count=len(all_metrics),
        json_bytes=total_json_bytes,
        metered_bytes=total_metered_bytes,
        doc_count=len(example_docs),
        description=metadata_description,
        display_name=display_name,
        metrics=all_metrics,
        attributes=attributes,
        resource_attributes=resource_attributes_list,
        example_docs=example_docs,
    )


def run(
    repo_path: Path,
    processor_resource_attrs: dict[str, Any] | None = None,
) -> list[ReceiverReport]:
    receiver_dir = repo_path / "receiver"
    if not receiver_dir.is_dir():
        print(f"ERROR: no 'receiver' directory found under {repo_path}", file=sys.stderr)
        sys.exit(1)

    metadata_files = sorted(receiver_dir.rglob("metadata.yaml"))
    collector_version = _read_collector_version(repo_path)

    print(f"Repo  : {repo_path.resolve()}")
    print(f"Loading {len(metadata_files)} metadata.yaml file(s)...", end="", flush=True)
    reports = [
        process_metadata(f, repo_path, collector_version=collector_version,
                         processor_resource_attrs=processor_resource_attrs)
        for f in metadata_files
    ]
    print(" done.")
    return reports


# ---------------------------------------------------------------------------
# Index builder
# ---------------------------------------------------------------------------

def build_index(
    reports: list[ReceiverReport],
    config_defaults: dict | None = None,
) -> list[dict[str, Any]]:
    """Group ReceiverReports by receiver name into a structured index.

    Each entry describes one receiver and lists its scrapers (one per
    metadata.yaml found under that receiver's directory).  The receiver-level
    description is taken from whichever scraper carries one (typically the
    top-level metadata.yaml for the receiver).

    When ``config_defaults`` is provided (the parsed ``defaults.receivers``
    section of the YAML config file), each scraper entry is annotated with
    ``default_cardinality`` values sourced from the config:

    - Each attribute dict in ``attributes`` gains a ``default_cardinality``
      key when a matching entry exists under
      ``defaults.receivers.<receiver>.scrapers.<scraper>.attributes.<name>``.
    - ``resource_attributes`` on each scraper is restructured into an object
      with ``attributes`` (the original list), ``default_cardinality``, and
      ``default_enabled`` sourced from
      ``defaults.receivers.<receiver>.scrapers.<scraper>.resource_attributes``.
    """
    yaml_defaults: dict = config_defaults or {}

    grouped: dict[str, list[ReceiverReport]] = defaultdict(list)
    for r in reports:
        grouped[r.receiver].append(r)

    index = []
    for receiver_name, reps in sorted(grouped.items()):
        # Pick description and display_name exclusively from the receiver-level
        # metadata.yaml (path has exactly 2 slashes: receiver/<name>/metadata.yaml).
        receiver_level = next(
            (r for r in reps if r.metadata_path.count('/') == 2),
            None
        )
        description = receiver_level.description if receiver_level else ""
        display_name = receiver_level.display_name if receiver_level else ""

        all_metrics: list[str] = []
        seen: set[str] = set()
        for r in reps:
            for m in r.metrics:
                if m not in seen:
                    all_metrics.append(m)
                    seen.add(m)

        yaml_recv_cfg: dict = yaml_defaults.get(receiver_name) or {}
        yaml_recv_scrapers: dict = yaml_recv_cfg.get("scrapers") or {}

        scrapers = []
        for r in reps:
            if not r.metrics:
                continue
            yaml_scraper_cfg: dict = yaml_recv_scrapers.get(r.scraper) or {}
            yaml_attrs_cfg: dict = yaml_scraper_cfg.get("attributes") or {}

            # Inject default_cardinality into each attribute dict.
            attributes_with_defaults = []
            for attr in r.attributes:
                a = dict(attr)
                yaml_card = (yaml_attrs_cfg.get(attr["name"]) or {}).get("default_cardinality")
                if yaml_card is not None:
                    a["default_cardinality"] = int(yaml_card)
                attributes_with_defaults.append(a)

            yaml_ra_cfg: dict = yaml_scraper_cfg.get("resource_attributes") or {}
            resource_attributes_obj: dict[str, Any] = {"attributes": r.resource_attributes}
            if "default_cardinality" in yaml_ra_cfg:
                resource_attributes_obj["default_cardinality"] = int(yaml_ra_cfg["default_cardinality"])

            scraper_entry: dict[str, Any] = {
                "name": r.scraper,
                "metadata_path": r.metadata_path,
                "description": r.description,
                "metrics": r.metrics,
                "metric_count": r.metric_count,
                "attributes": attributes_with_defaults,
                "resource_attributes": resource_attributes_obj,
                "default_polling_interval_s": 60,
            }

            if "default_enabled" in yaml_scraper_cfg:
                scraper_entry["default_enabled"] = bool(yaml_scraper_cfg["default_enabled"])

            yaml_scraper_polling = yaml_scraper_cfg.get("default_polling_interval")
            if yaml_scraper_polling is not None:
                scraper_entry["default_polling_interval_s"] = int(yaml_scraper_polling)

            scrapers.append(scraper_entry)

        if not all_metrics:
            continue

        entry: dict[str, Any] = {
            "name": receiver_name,
            "display_name": display_name,
            "description": description,
            "metric_count": len(all_metrics),
            "metrics": all_metrics,
            "scrapers": scrapers,
        }
        index.append(entry)

    return index


# ---------------------------------------------------------------------------
# Flask server
# ---------------------------------------------------------------------------

_SECONDS_PER_DAY = 24 * 60 * 60
_BYTES_PER_GB = 1024 ** 3


def _parse_attributes(raw: dict) -> dict[str, int]:
    """Normalize the request ``attributes`` format to an internal ``{name: count}`` dict.

    Expected input: ``{"cpu": {"cardinality": 12}, "state": {"cardinality": 4}}``
    """
    return {k: int(v["cardinality"]) for k, v in raw.items() if isinstance(v, dict)}


def _gb_per_day(bytes_per_scrape: int, polling_interval_s: int, instances: int) -> float:
    """Total GB/day for `instances` instances scraping every `polling_interval_s` seconds."""
    scrapes_per_day = _SECONDS_PER_DAY / polling_interval_s
    return (bytes_per_scrape * scrapes_per_day * instances) / _BYTES_PER_GB


def _expand_docs(
    report: ReceiverReport,
    attributes: dict[str, int],
    include_resource_attrs: frozenset[str] | None = None,
    resource_attributes_cardinality: int = 1,
) -> list[dict[str, Any]]:
    """Return the full set of attribute-expanded docs for a scraper.

    For each attribute present in a doc's ``attributes`` field:
    - Enum attributes are expanded over every possible enum value.
    - Non-enum attributes that appear in ``attributes`` with count N are
      expanded by appending ``-1`` … ``-N`` to the base value.
    The cartesian product over all slots gives the complete set of docs.

    ``include_resource_attrs`` — when not None, only resource-attribute keys
    present in this set are kept in each returned doc; all others are stripped.
    Pass ``None`` (the default) to include every resource attribute.

    ``resource_attributes_cardinality`` — when > 1, each doc is further
    multiplied by this factor: for every counter ``i`` in ``1..cardinality``,
    a copy of the doc is emitted where every string value in
    ``resource["attributes"]`` has ``-{i}`` appended.
    """
    # Build enum-value lookup from the report's attribute metadata.
    enum_values: dict[str, list[Any]] = {
        a["name"]: a["values"]
        for a in report.attributes
        if a.get("type") == "enum"
    }

    result: list[dict[str, Any]] = []

    for doc in report.example_docs:
        attrs: dict[str, Any] = doc.get("attributes") or {}

        # Build one slot per attribute present in this doc.
        slots: list[list[tuple[str, Any]]] = []
        for attr_name, base_val in attrs.items():
            if attr_name in enum_values:
                # Expand over enum values, capped by the requested count when specified.
                vals = enum_values[attr_name]
                count = attributes.get(attr_name)
                if count is not None:
                    vals = vals[:min(int(count), len(vals))]
                slots.append([(attr_name, v) for v in vals])
            else:
                # Non-enum: expand with counter suffixes if a count was requested.
                count = int(attributes.get(attr_name, 1))
                if count > 1:
                    slots.append([(attr_name, f"{base_val}{i}") for i in range(1, count + 1)])
                else:
                    slots.append([(attr_name, base_val)])

        combos: list[dict[str, Any]] = (
            [dict(combo) for combo in itertools.product(*slots)] if slots else [{}]
        )

        for combo in combos:
            expanded = dict(doc)
            merged_attrs = {**attrs, **combo} if combo else attrs
            if merged_attrs:
                expanded["attributes"] = merged_attrs
            else:
                expanded.pop("attributes", None)
            if include_resource_attrs is not None and "resource" in expanded:
                resource = expanded["resource"]
                expanded["resource"] = {
                    **resource,
                    "attributes": {
                        k: v for k, v in resource.get("attributes", {}).items()
                        if k in include_resource_attrs
                    },
                }
            if resource_attributes_cardinality > 1 and "resource" in expanded:
                base_res_attrs = expanded["resource"].get("attributes", {})
                for i in range(1, resource_attributes_cardinality + 1):
                    copy = dict(expanded)
                    copy["resource"] = {
                        **expanded["resource"],
                        "attributes": {
                            k: f"{v}{i}" if isinstance(v, str) else v
                            for k, v in base_res_attrs.items()
                        },
                    }
                    result.append(copy)
            else:
                result.append(expanded)

    return result


def _expand_dimensions_bytes(
    report: ReceiverReport,
    attributes: dict[str, int],
    include_resource_attrs: frozenset[str] | None = None,
    resource_attributes_cardinality: int = 1,
) -> tuple[int, int, int]:
    """Compute (json_bytes, metered_bytes, doc_count) across all attribute-expanded docs."""
    total_json = 0
    total_metered = 0
    doc_count = 0

    for doc in _expand_docs(report, attributes, include_resource_attrs, resource_attributes_cardinality):
        sized = {k: v for k, v in doc.items() if k != "data_stream"}
        total_json += len(json.dumps(sized, separators=(",", ":")).encode())
        total_metered += _metered_bytes(sized)
        doc_count += 1

    return total_json, total_metered, doc_count


def _load_yaml_config(path: Path) -> dict:
    """Load a YAML config file and return the parsed ``defaults`` mapping.

    Expected structure::

        defaults:
          resource_attributes:
            <processor_name>:
              default_enabled: <bool>
              attributes:
                <attribute_name>:
                  default_enabled: <bool>
          receivers:
            <receiver_name>:
              scrapers:
                <scraper_name>:
                  default_enabled: <bool>
                  default_polling_interval: <int (ms)>
                  attributes:
                    <attribute_name>:
                      default_cardinality: <int>
                  resource_attributes:
                    default_cardinality: <int>

    Returns the full parsed config dict (may be empty).
    """
    with open(path) as fh:
        data = yaml.safe_load(fh) or {}
    return data if isinstance(data, dict) else {}


def create_app(
    reports: list[ReceiverReport],
    config_defaults: dict | None = None,
    processor_attrs: dict[str, dict[str, Any]] | None = None,
) -> Any:
    try:
        from flask import Flask, jsonify, request
    except ImportError:
        print("ERROR: Flask is not installed. Run: pip install flask", file=sys.stderr)
        sys.exit(1)

    dist_dir = Path(__file__).parent / "frontend" / "dist"
    app = Flask(
        __name__,
        static_folder=str(dist_dir) if dist_dir.is_dir() else None,
        static_url_path="",
    )
    cfg_receivers: dict = (config_defaults or {}).get("receivers") or {}
    cfg_resource_attributes: dict = (config_defaults or {}).get("resource_attributes") or {}

    index = build_index(reports, config_defaults=cfg_receivers)

    # Lookup: (receiver_name, scraper_name) -> ReceiverReport
    report_lookup: dict[tuple[str, str], ReceiverReport] = {
        (r.receiver, r.scraper): r for r in reports
    }
    # All scraper names per receiver
    receiver_scrapers: dict[str, list[str]] = defaultdict(list)
    for r in reports:
        receiver_scrapers[r.receiver].append(r.scraper)

    @app.get("/")
    def serve_index():
        if dist_dir.is_dir():
            return app.send_static_file("index.html")
        return "Frontend not built. Run: cd frontend && npm install && npm run build", 200

    def _build_catalog_entry(processor: str, label: str, attr_map: dict[str, Any]) -> dict[str, Any]:
        """Build one catalog entry from scanned resource attrs, annotating with
        default_enabled values from the config.

        ``defaults.resource_attributes.<processor>.attributes`` is a list of
        attribute names that are enabled by default.  Any attribute present in
        the list gets ``default_enabled: true``; any attribute absent from the
        list gets ``default_enabled: false``.  When the list is absent from the
        config no ``default_enabled`` is emitted (frontend falls back to its own
        default).
        """
        proc_cfg: dict = cfg_resource_attributes.get(processor) or {}
        enabled_list = proc_cfg.get("attributes")
        enabled_set: frozenset[str] | None = (
            frozenset(enabled_list) if isinstance(enabled_list, list) else None
        )
        attributes = []
        for name, example in attr_map.items():
            attr_entry: dict[str, Any] = {"name": name, "example": example}
            if enabled_set is not None:
                attr_entry["default_enabled"] = name in enabled_set
            attributes.append(attr_entry)
        entry: dict[str, Any] = {
            "processor": processor,
            "label": label,
            "attributes": attributes,
        }
        if "default_enabled" in proc_cfg:
            entry["default_enabled"] = bool(proc_cfg["default_enabled"])
        return entry

    # Build the resource-attributes catalog from scanned processor metadata.
    _resource_attributes_catalog: list[dict[str, Any]] = [
        _build_catalog_entry(proc_name, data["label"], data["attrs"])
        for proc_name, data in (processor_attrs or {}).items()
    ]

    @app.get("/receivers")
    def get_receivers():
        return jsonify({
            "receivers": index,
            "resource_attributes": _resource_attributes_catalog,
        })

    @app.post("/estimate")
    def post_estimate():
        body = request.get_json(force=True, silent=True) or {}
        _DEFAULT_POLLING_S = 60
        include_docs = request.args.get("docs", "").lower() == "true"

        # "resource_attributes" in the body is an optional flat list of
        # resource-attribute names to include.  Absent → include everything.
        resource_attributes_body = body.get("resource_attributes")
        if resource_attributes_body is None:
            include_resource_attrs: frozenset[str] | None = None
        else:
            include_resource_attrs = frozenset(resource_attributes_body)

        requested_receivers = body.get("receivers") or []

        result_receivers = []
        total_json_gb = 0.0
        total_metered_gb = 0.0
        total_time_series = 0
        total_data_points_per_day = 0.0

        for recv_req in requested_receivers:
            recv_name = recv_req.get("name")
            if not recv_name:
                return jsonify({"error": "each receiver entry must have a 'name'"}), 400

            instances = int(recv_req.get("instances", 1))
            if instances < 1:
                return jsonify({"error": f"'instances' must be >= 1 (receiver: {recv_name})"}), 400

            requested_scrapers = recv_req.get("scrapers") or []
            scraper_names = [m.get("name") for m in requested_scrapers if m.get("name")]

            # Build per-scraper values from request
            scraper_polling: dict[str, int | None] = {}
            scraper_attributes: dict[str, dict[str, int]] = {}
            scraper_ra_cardinality: dict[str, int] = {}
            for m in requested_scrapers:
                scraper_name = m.get("name")
                if scraper_name:
                    scraper_polling[scraper_name] = m.get("polling_interval")
                    if "attributes" in m:
                        scraper_attributes[scraper_name] = _parse_attributes(m["attributes"])
                    ra_cfg = m.get("resource_attributes")
                    if isinstance(ra_cfg, dict) and "cardinality" in ra_cfg:
                        scraper_ra_cardinality[scraper_name] = int(ra_cfg["cardinality"])

            result_scrapers = []
            recv_json_gb = 0.0
            recv_metered_gb = 0.0
            recv_time_series = 0
            recv_data_points_per_day = 0.0

            for scraper_name in scraper_names:
                report = report_lookup.get((recv_name, scraper_name))
                if report is None:
                    result_scrapers.append({"name": scraper_name, "error": "scraper not found"})
                    continue

                # Resolve polling interval: scraper > default (60 s)
                polling = scraper_polling.get(scraper_name) or _DEFAULT_POLLING_S
                if polling <= 0:
                    result_scrapers.append({"name": scraper_name, "error": "polling_interval must be > 0"})
                    continue

                effective_attrs: dict[str, int] = scraper_attributes.get(scraper_name) or {}

                ra_cardinality = scraper_ra_cardinality.get(scraper_name, 1)
                expanded_json_bytes, expanded_metered_bytes, docs_per_scrape = _expand_dimensions_bytes(
                    report, effective_attrs, include_resource_attrs, ra_cardinality
                )

                scraper_json_gb = _gb_per_day(expanded_json_bytes, polling, instances)
                scraper_metered_gb = _gb_per_day(expanded_metered_bytes, polling, instances)
                scraper_data_points_per_day = (_SECONDS_PER_DAY / polling) * docs_per_scrape
                recv_json_gb += scraper_json_gb
                recv_metered_gb += scraper_metered_gb
                recv_time_series += docs_per_scrape
                recv_data_points_per_day += scraper_data_points_per_day

                ra_names = [a["name"] for a in report.resource_attributes if "name" in a]
                scraper_entry: dict[str, Any] = {
                    "name": scraper_name,
                    "polling_interval_s": polling,
                    "time_series": docs_per_scrape,
                    "data_points_per_day": round(scraper_data_points_per_day),
                    "json_gb_per_day": round(scraper_json_gb, 6),
                    "metered_gb_per_day": round(scraper_metered_gb, 6),
                }
                if ra_names:
                    scraper_entry["resource_attributes"] = ra_names
                if include_docs:
                    scraper_entry["docs"] = _expand_docs(report, effective_attrs, include_resource_attrs, ra_cardinality)
                result_scrapers.append(scraper_entry)

            recv_time_series_total = recv_time_series * instances
            recv_data_points_per_day_total = recv_data_points_per_day * instances

            total_json_gb += recv_json_gb
            total_metered_gb += recv_metered_gb
            total_time_series += recv_time_series_total
            total_data_points_per_day += recv_data_points_per_day_total

            result_receivers.append({
                "name": recv_name,
                "instances": instances,
                "time_series": recv_time_series_total,
                "data_points_per_day": round(recv_data_points_per_day_total),
                "json_gb_per_day": round(recv_json_gb, 6),
                "metered_gb_per_day": round(recv_metered_gb, 6),
                "scrapers": result_scrapers,
            })

        return jsonify({
            "receivers": result_receivers,
            "total_time_series": total_time_series,
            "total_data_points_per_day": round(total_data_points_per_day),
            "total_json_gb_per_day": round(total_json_gb, 6),
            "total_metered_gb_per_day": round(total_metered_gb, 6),
        })

    return app


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="OTel Collector Metrics Estimator — REST API server.",
    )
    parser.add_argument(
        "repo_path",
        type=Path,
        help="Local path to the root of the OTel collector repo",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080, help="Port to bind (default: 8080)")
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        metavar="FILE",
        help="Optional YAML config file with default cardinality values",
    )

    args = parser.parse_args()

    if not args.repo_path.is_dir():
        print(f"ERROR: '{args.repo_path}' is not a directory", file=sys.stderr)
        sys.exit(1)

    full_config: dict = {}
    if args.config is not None:
        if not args.config.is_file():
            print(f"ERROR: config file '{args.config}' does not exist", file=sys.stderr)
            sys.exit(1)
        full_config = _load_yaml_config(args.config)

    config_defaults: dict = full_config.get("defaults") or {}
    processor_names: list[str] = (full_config.get("resource_attributes") or {}).get("processors") or []

    processor_attrs = scan_processor_resource_attrs(args.repo_path, processor_names)
    # Flatten all scanned attrs into a single dict for doc generation (later processors win on key conflicts).
    merged_processor_resource_attrs: dict[str, Any] = {}
    for data in processor_attrs.values():
        merged_processor_resource_attrs.update(data["attrs"])

    reports = run(args.repo_path, processor_resource_attrs=merged_processor_resource_attrs)
    app = create_app(reports, config_defaults=config_defaults, processor_attrs=processor_attrs)
    print(f"Starting server on http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
