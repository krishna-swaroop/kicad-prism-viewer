from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from .schematic_world import (
    _hierarchy_depth,
    _layout_pages,
    _operation_bounds,
    _page_size,
    _record_bounds,
    _safe_name,
    _source_page_size,
)


SCHEMA = "prism.schematic_scene_a0"
ELECTRICAL_NET_KINDS = {
    "wire",
    "junction",
    "label",
    "global_label",
    "hierarchical_label",
    "no_connect",
    "bus",
    "bus_entry",
    "pin",
}
COORDINATE_KEYS = {
    "x",
    "y",
    "cx",
    "cy",
    "x1",
    "y1",
    "x2",
    "y2",
    "start_x",
    "start_y",
    "mid_x",
    "mid_y",
    "end_x",
    "end_y",
    "radius_nm",
    "diameter_nm",
    "width_nm",
    "pen_width_nm",
    "size_x_nm",
    "size_y_nm",
}
NON_GEOMETRY_OPERATION_KINDS = {"StartBlock", "EndBlock"}


def _mm(value: Any) -> float:
    return float(value or 0) / 1_000_000.0


def _record_source_id(record: Any, index: int) -> str:
    uuid = str(getattr(record, "uuid", "") or "")
    object_id = str(getattr(record, "object_id", "") or "")
    return uuid or object_id or f"record-{index}"


def stable_feature_key(sheet_instance_path: str, source_id: str, sub_feature_index: int) -> str:
    return f"{sheet_instance_path or '/'}::{source_id}::{sub_feature_index}"


def _operation_to_primitive(operation: Any, feature_id: int) -> tuple[dict[str, Any] | None, str | None]:
    data = operation.to_dict() if hasattr(operation, "to_dict") else dict(operation)
    kind = str(data.get("kind") or "unknown")
    if kind in NON_GEOMETRY_OPERATION_KINDS:
        return None, None
    lowered = kind.lower()
    primitive: dict[str, Any] = {"featureId": feature_id, "kind": lowered}

    points = data.get("points") or []
    if points:
        primitive["pointsMm"] = [[_mm(point[0]), _mm(point[1])] for point in points if len(point) >= 2]
    for key in COORDINATE_KEYS:
        if key in data:
            output_key = key[:-3] + "Mm" if key.endswith("_nm") else f"{key}Mm"
            primitive[output_key] = _mm(data[key])
    if "text" in data:
        primitive["text"] = str(data.get("text") or "")
    if "angle" in data:
        primitive["angle"] = float(data.get("angle") or 0)

    has_geometry = (
        "pointsMm" in primitive
        or any(key.endswith("Mm") for key in primitive)
        or lowered == "text"
    )
    if not has_geometry:
        return None, kind

    return primitive, None


def _record_feature(
    page_id: str,
    sheet_instance_path: str,
    record: Any,
    record_index: int,
    feature_id: int,
    svg_to_net: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    kind = str(getattr(record, "kind", "") or "unknown")
    source_id = _record_source_id(record, record_index)
    record_uuid = str(getattr(record, "uuid", "") or "")
    object_id = str(getattr(record, "object_id", "") or "")
    feature = {
        "id": feature_id,
        "stableKey": stable_feature_key(sheet_instance_path, source_id, 0),
        "pageId": page_id,
        "sheetInstancePath": sheet_instance_path,
        "sourceId": source_id,
        "uuid": record_uuid,
        "objectId": object_id,
        "kind": kind,
    }
    bounds = _record_bounds(record)
    if bounds is not None:
        feature["boundsMm"] = bounds
    net = (
        svg_to_net.get(record_uuid) or svg_to_net.get(object_id)
        if kind in ELECTRICAL_NET_KINDS
        else None
    )
    if net:
        feature["netUid"] = str(net.get("uid") or "")
        feature["netName"] = str(net.get("name") or "")
    extras = getattr(record, "extras", None) or {}
    for key in ("reference", "value", "text", "sheet_name", "sheet_file"):
        value = extras.get(key)
        if value not in (None, ""):
            feature[key] = str(value)
    return feature


def _page_chunks(
    page: dict[str, Any],
    records: list[Any],
    features: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, str]]]:
    feature_by_source = {feature["sourceId"]: feature for feature in features}
    unsupported: list[dict[str, str]] = []
    simplified_bounds = []
    primitives = []

    for record_index, record in enumerate(records, start=1):
        source_id = _record_source_id(record, record_index)
        feature = feature_by_source.get(source_id)
        if not feature:
            continue
        bounds = feature.get("boundsMm")
        if bounds:
            simplified_bounds.append(
                {
                    "featureId": feature["id"],
                    "kind": feature["kind"],
                    "boundsMm": bounds,
                    "netUid": feature.get("netUid", ""),
                }
            )
        for op_index, operation in enumerate(getattr(record, "operations", []) or [], start=1):
            primitive, unsupported_kind = _operation_to_primitive(operation, feature["id"])
            if primitive:
                primitive["subFeatureKey"] = stable_feature_key(
                    page["sheetInstancePath"],
                    source_id,
                    op_index,
                )
                bounds_mm = _operation_bounds(operation)
                if bounds_mm:
                    primitive["boundsMm"] = bounds_mm
                primitives.append(primitive)
            elif unsupported_kind:
                unsupported.append(
                    {
                        "sourceId": source_id,
                        "recordKind": str(getattr(record, "kind", "") or "unknown"),
                        "operationKind": unsupported_kind,
                    }
                )

    lod0 = {
        "schema": f"{SCHEMA}.chunk",
        "pageId": page["id"],
        "lod": 0,
        "pageCard": {
            "boundsMm": [0, 0, page["sourceWidthMm"], page["sourceHeightMm"]],
            "title": page["name"],
            "sheetInstancePath": page["sheetInstancePath"],
        },
    }
    lod1 = {
        "schema": f"{SCHEMA}.chunk",
        "pageId": page["id"],
        "lod": 1,
        "featureBounds": simplified_bounds,
    }
    lod2 = {
        "schema": f"{SCHEMA}.chunk",
        "pageId": page["id"],
        "lod": 2,
        "primitives": primitives,
        "unsupported": unsupported,
    }
    return lod0, lod1, lod2, unsupported


def build_schematic_scene(
    design: Any,
    design_payload: dict[str, Any],
    output_dir: Path,
) -> dict[str, Any]:
    from kicad_monkey import KiCadSvgRenderOptions, render_ir_to_svg  # type: ignore
    from kicad_monkey.kicad_schematic_svg_enrichment import (  # type: ignore
        schematic_root_svg_attrs,
        schematic_svg_enrichment_payload,
    )

    schematic_dir = output_dir / "schematic-scene"
    page_dir = schematic_dir / "pages"
    chunk_dir = schematic_dir / "chunks"
    page_dir.mkdir(parents=True, exist_ok=True)
    chunk_dir.mkdir(parents=True, exist_ok=True)

    options = KiCadSvgRenderOptions.enriched_default()
    pages: list[dict[str, Any]] = []
    features: list[dict[str, Any]] = []
    features_by_page: dict[str, list[int]] = defaultdict(list)
    instance_to_page: dict[str, str] = {}
    net_to_pages: dict[str, set[str]] = defaultdict(set)
    component_to_pages: dict[str, set[str]] = defaultdict(set)
    hierarchy_endpoint_index: dict[str, list[dict[str, str]]] = defaultdict(list)
    unsupported_operations: list[dict[str, str]] = []
    next_feature_id = 1
    page_records: dict[str, list[Any]] = {}

    for index, instance in enumerate(design.schematic_instances(), start=1):
        ir = design.to_schematic_instance_ir(instance)
        page_id = f"page-{index:04d}"
        instance_path = str(getattr(instance, "sheet_instance_path", "") or "")
        instance_to_page[instance_path] = page_id
        source_path = str(getattr(instance, "source_path", "") or "")
        sheet_name = str(getattr(instance, "sheet_name", "") or Path(source_path).stem or page_id)
        filename = f"{index:04d}-{_safe_name(sheet_name, page_id)}.svg"
        width_mm, height_mm = _page_size(ir)
        source_width_mm, source_height_mm = _source_page_size(ir)
        root_attrs = schematic_root_svg_attrs(
            source_path=source_path,
            sheet_name=sheet_name,
            sheet_path=getattr(instance, "sheet_path", ""),
            profile="enriched",
        )
        root_attrs["data-sheet-instance-path"] = instance_path
        svg = render_ir_to_svg(ir, options=options, root_extra_attrs=root_attrs)
        (page_dir / filename).write_text(svg, encoding="utf-8")

        enrichment = schematic_svg_enrichment_payload(
            design_payload,
            source_path=source_path,
            sheet_name=sheet_name,
            sheet_path=getattr(instance, "sheet_path", ""),
            sheet_instance_path=instance_path,
            profile="enriched",
        )
        view_indexes = enrichment.get("view_indexes", {})
        svg_to_net = view_indexes.get("svg_to_net", {}) or {}
        net_map = view_indexes.get("net_uid_to_svg", {}) or {}
        for net_uid in net_map:
            net_to_pages[str(net_uid)].add(page_id)
        page_features: list[dict[str, Any]] = []
        for record_index, record in enumerate(getattr(ir, "records", []) or [], start=1):
            feature = _record_feature(
                page_id,
                instance_path,
                record,
                record_index,
                next_feature_id,
                svg_to_net,
            )
            page_features.append(feature)
            features.append(feature)
            features_by_page[page_id].append(next_feature_id)
            if feature.get("netUid"):
                net_to_pages[feature["netUid"]].add(page_id)
            if feature.get("reference"):
                component_to_pages[feature["reference"]].add(page_id)
            if feature.get("kind") in {"global_label", "hierarchical_label", "label", "bus", "bus_entry"}:
                hierarchy_endpoint_index[feature.get("netUid", "")].append(
                    {
                        "pageId": page_id,
                        "featureId": str(next_feature_id),
                        "kind": feature["kind"],
                        "text": feature.get("text") or feature.get("netName") or "",
                    }
                )
            next_feature_id += 1

        page = {
            "id": page_id,
            "name": sheet_name,
            "sheetNumber": int(getattr(instance, "sheet_number", index) or index),
            "sourcePath": source_path,
            "sheetPath": str(getattr(instance, "sheet_path", "") or ""),
            "sheetInstancePath": instance_path,
            "parentSheetInstancePath": str(getattr(instance, "parent_sheet_instance_path", "") or ""),
            "parentId": "",
            "depth": _hierarchy_depth(instance),
            "widthMm": width_mm,
            "heightMm": height_mm,
            "sourceWidthMm": source_width_mm,
            "sourceHeightMm": source_height_mm,
            "thumbnail": {"path": f"pages/{filename}", "kind": "enriched-svg"},
            "svg": f"pages/{filename}",
            "chunks": {
                "lod0": f"chunks/{page_id}/lod0.json",
                "lod1": f"chunks/{page_id}/lod1.json",
                "lod2": f"chunks/{page_id}/lod2.json",
            },
            "featureIds": features_by_page[page_id],
            "featureCount": len(page_features),
            "netUids": sorted(str(uid) for uid in net_map),
        }
        pages.append(page)
        page_records[page_id] = list(getattr(ir, "records", []) or [])

    for page in pages:
        page["parentId"] = instance_to_page.get(page["parentSheetInstancePath"], "")

    world_bounds = _layout_pages(pages)
    page_by_id = {page["id"]: page for page in pages}
    edges = [
        {
            "id": f"edge-{page['parentId']}-{page['id']}",
            "source": page["parentId"],
            "target": page["id"],
            "kind": "hierarchy",
        }
        for page in pages
        if page["parentId"] in page_by_id
    ]

    features_by_id = {feature["id"]: feature for feature in features}
    for page in pages:
        page_chunk_dir = chunk_dir / page["id"]
        page_chunk_dir.mkdir(parents=True, exist_ok=True)
        page_features = [features_by_id[feature_id] for feature_id in page["featureIds"]]
        lod0, lod1, lod2, unsupported = _page_chunks(page, page_records[page["id"]], page_features)
        unsupported_operations.extend(
            {"pageId": page["id"], **item}
            for item in unsupported
        )
        for filename, payload in (("lod0.json", lod0), ("lod1.json", lod1), ("lod2.json", lod2)):
            (page_chunk_dir / filename).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

    strings = sorted(
        {
            str(value)
            for feature in features
            for key in ("stableKey", "sourceId", "uuid", "objectId", "kind", "netUid", "netName", "reference", "value", "text")
            if (value := feature.get(key)) not in (None, "")
        }
        | {
            str(value)
            for page in pages
            for key in ("id", "name", "sourcePath", "sheetPath", "sheetInstancePath")
            if (value := page.get(key)) not in (None, "")
        }
    )
    string_ids = {value: index for index, value in enumerate(strings)}

    (schematic_dir / "features.json").write_text(
        json.dumps(
            {
                "schema": f"{SCHEMA}.features",
                "features": features,
                "pages": {page_id: ids for page_id, ids in sorted(features_by_page.items())},
                "byStableKey": {feature["stableKey"]: feature["id"] for feature in features},
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    (schematic_dir / "strings.json").write_text(
        json.dumps({"schema": f"{SCHEMA}.strings", "strings": strings, "ids": string_ids}, separators=(",", ":")),
        encoding="utf-8",
    )

    revision_source = json.dumps(
        {
            "schema": SCHEMA,
            "pages": [
                {
                    "instance": page["sheetInstancePath"],
                    "source": page["sourcePath"],
                    "features": page["featureCount"],
                    "chunks": page["chunks"],
                }
                for page in pages
            ],
            "edges": edges,
            "unsupported": unsupported_operations,
            "design": design_payload.get("design", {}),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    manifest = {
        "schema": SCHEMA,
        "geometryRevision": hashlib.sha256(revision_source).hexdigest(),
        "coordinateSystem": {
            "units": "mm",
            "pageSpace": "+x right, +y down in KiCad schematic canvas coordinates",
            "worldSpace": "+x right, +y down across hierarchy layout",
            "featureIdentity": "sheetInstancePath + source UUID/object ID + primitive/sub-feature index",
        },
        "worldBoundsMm": world_bounds,
        "pages": pages,
        "edges": edges,
        "featureTable": "features.json",
        "stringTable": "strings.json",
        "netToPages": {key: sorted(value) for key, value in sorted(net_to_pages.items())},
        "componentToPages": {key: sorted(value) for key, value in sorted(component_to_pages.items())},
        "hierarchyEndpointIndex": {
            key: value for key, value in sorted(hierarchy_endpoint_index.items()) if key
        },
        "unsupported": unsupported_operations,
        "lodPolicy": {
            "hysteresis": 0.18,
            "levels": [
                {"lod": 0, "name": "page-card-thumbnail", "maxPagePixels": 420},
                {"lod": 1, "name": "page-structure", "minPagePixels": 300, "maxPagePixels": 1200},
                {"lod": 2, "name": "electrical-review-vectors", "minPagePixels": 900},
                {"lod": 3, "name": "fidelity-vectors-and-text", "future": True},
            ],
        },
    }
    (schematic_dir / "schematic.manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")),
        encoding="utf-8",
    )
    return {
        "schema": SCHEMA,
        "path": "schematic-scene/schematic.manifest.json",
        "geometry_revision": manifest["geometryRevision"],
        "page_count": len(pages),
        "feature_count": len(features),
        "unsupported_count": len(unsupported_operations),
    }
