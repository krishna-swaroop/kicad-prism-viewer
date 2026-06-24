from __future__ import annotations

import hashlib
import json
import math
import sys
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


SCHEMA = "prism.schematic_vector_a0"
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
    "pin_body",
    "pin_name",
    "pin_number",
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
NON_GEOMETRY_OPERATION_KINDS = {
    "EndPlot",
    "EndBlock",
    "SetColor",
    "SetCurrentLineWidth",
    "SetDash",
    "SetPageSettings",
    "SetViewport",
    "StartBlock",
    "StartPlot",
}
SUPPORTED_VECTOR_OPERATION_KINDS = {
    "ArcCenterAngle",
    "ArcThreePoint",
    "BezierCurve",
    "Circle",
    "PenTo",
    "Line",
    "PlotPoly",
    "Rect",
    "ThickArc",
    "ThickSegment",
}

_STROKE_TEXT_THICKNESS_RATIO = 0.15
_STROKE_TEXT_BOLD_THICKNESS_RATIO = 0.20
_H_STROKE_ALIGNMENT = {
    "left": "left",
    "center": "center",
    "right": "right",
    "indeterminate": "left",
}
_V_STROKE_ALIGNMENT = {
    "top": "top",
    "center": "center",
    "bottom": "bottom",
    "indeterminate": "bottom",
}


def _mm(value: Any) -> float:
    return float(value or 0) / 1_000_000.0


def _record_source_id(record: Any, index: int) -> str:
    uuid = str(getattr(record, "uuid", "") or "")
    object_id = str(getattr(record, "object_id", "") or "")
    return uuid or object_id or f"record-{index}"


def stable_feature_key(
    sheet_instance_path: str,
    source_id: str,
    operation_index: int,
    semantic_role: str,
    sub_feature_index: int,
) -> str:
    return (
        f"{sheet_instance_path or '/'} | {source_id or 'unknown'} | "
        f"{int(operation_index)} | {semantic_role or 'unknown'} | {int(sub_feature_index)}"
    )


def deterministic_feature_ids(feature_keys: list[str] | set[str]) -> dict[str, int]:
    return {key: index for index, key in enumerate(sorted(set(feature_keys)), start=1)}


def _text_cache_contours(data: dict[str, Any]) -> list[list[list[float]]] | None:
    polygons = data.get("render_cache_polygons")
    if polygons is None:
        cache = data.get("render_cache")
        if isinstance(cache, dict):
            polygons = cache.get("polygons") or cache.get("contours")
    if not isinstance(polygons, list) or not polygons:
        return None
    contours: list[list[list[float]]] = []
    for polygon in polygons:
        if not isinstance(polygon, list) or len(polygon) < 2:
            continue
        contour = []
        for point in polygon:
            if isinstance(point, dict):
                x = point.get("x", point.get("x_nm"))
                y = point.get("y", point.get("y_nm"))
            elif isinstance(point, (list, tuple)) and len(point) >= 2:
                x, y = point[0], point[1]
            else:
                continue
            if x is None or y is None:
                continue
            contour.append([_mm(x), _mm(y)])
        if len(contour) >= 2:
            contours.append(contour)
    return contours or None


def _polyline_bounds(polylines: list[list[list[float]]]) -> list[float] | None:
    points = [point for polyline in polylines for point in polyline]
    if not points:
        return None
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def _normalize_align(value: Any, mapping: dict[str, str], default: str) -> str:
    raw = str(value or default).split(".")[-1].lower()
    if raw.startswith("gr_text_h_align_"):
        raw = raw.replace("gr_text_h_align_", "", 1)
    if raw.startswith("gr_text_v_align_"):
        raw = raw.replace("gr_text_v_align_", "", 1)
    return mapping.get(raw, default)


def _stroke_renderer():
    try:
        from kicad_monkey.kicad_stroke_font import get_renderer  # type: ignore
    except ModuleNotFoundError:
        repo_root = Path(__file__).resolve().parents[2]
        reference_path = repo_root / "references" / "kicad_monkey" / "src" / "py"
        if reference_path.exists():
            sys.path.insert(0, str(reference_path))
        from kicad_monkey.kicad_stroke_font import get_renderer  # type: ignore
    return get_renderer()


def _newstroke_text_primitive(data: dict[str, Any], feature_id: int) -> tuple[dict[str, Any] | None, str | None]:
    text = str(data.get("text") or "")
    if not text:
        return None, "TextEmpty"

    size_x_nm = int(data.get("size_x_nm") or 1_270_000)
    size_y_nm = int(data.get("size_y_nm") or 1_270_000)
    bold = bool(data.get("bold"))
    italic = bool(data.get("italic"))
    mirror = bool(data.get("mirror"))
    orient_deg = float(data.get("orient_deg", data.get("angle", 0)) or 0)
    h_align = _normalize_align(data.get("h_align"), _H_STROKE_ALIGNMENT, "left")
    v_align = _normalize_align(data.get("v_align"), _V_STROKE_ALIGNMENT, "bottom")
    ratio = _STROKE_TEXT_BOLD_THICKNESS_RATIO if bold else _STROKE_TEXT_THICKNESS_RATIO
    default_pen_nm = int(round(size_y_nm * ratio))
    pen_width_nm = data.get("pen_width_nm")
    effective_pen_nm = default_pen_nm if pen_width_nm is None or int(pen_width_nm or 0) <= 0 else int(pen_width_nm)

    x_mm = _mm(data.get("x", 0))
    y_mm = _mm(data.get("y", 0))
    size_x_mm = size_x_nm / 1_000_000.0
    size_y_mm = size_y_nm / 1_000_000.0
    lines = text.splitlines() or [text]
    line_height = size_y_mm * 1.25
    angle_rad = math.radians(orient_deg)
    advance_x = -line_height * math.sin(angle_rad)
    advance_y = line_height * math.cos(angle_rad)
    if len(lines) > 1:
        if v_align == "center":
            start_offset = -(len(lines) - 1) / 2
        elif v_align == "bottom":
            start_offset = -(len(lines) - 1)
        else:
            start_offset = 0
    else:
        start_offset = 0
    try:
        polylines = []
        for line_index, line in enumerate(lines):
            offset = start_offset + line_index
            polylines.extend(_stroke_renderer().render_text_polylines(
                text=line,
                pos_x=x_mm + advance_x * offset,
                pos_y=y_mm + advance_y * offset,
                size_x=size_x_mm,
                size_y=size_y_mm,
                angle=orient_deg,
                h_align=h_align,
                v_align=v_align,
                mirror=mirror,
                italic=italic,
            ))
    except Exception as exc:  # pragma: no cover - diagnostic path depends on external renderer failures.
        return None, f"TextNewStrokeError:{type(exc).__name__}"

    polylines_mm = [
        [[float(x), float(y)] for x, y in polyline]
        for polyline in polylines
        if len(polyline) >= 2
    ]
    if not polylines_mm:
        return None, "TextNewStrokeEmpty"

    primitive: dict[str, Any] = {
        "featureId": feature_id,
        "kind": "text_strokes",
        "provider": "newstroke",
        "polylinesMm": polylines_mm,
        "widthMm": effective_pen_nm / 1_000_000.0,
        "text": text,
        "style": {
            "provider": "newstroke",
            "sizeXNm": size_x_nm,
            "sizeYNm": size_y_nm,
            "orientDeg": orient_deg,
            "hAlign": h_align,
            "vAlign": v_align,
            "mirror": mirror,
            "italic": italic,
            "bold": bold,
            "fontFace": str(data.get("font_face") or ""),
            "multiline": len(lines) > 1,
            "lineCount": len(lines),
            "effectiveStrokeWidthMm": effective_pen_nm / 1_000_000.0,
        },
    }
    if data.get("color"):
        primitive["color"] = str(data.get("color") or "")
    if bounds := _polyline_bounds(polylines_mm):
        pad = primitive["widthMm"] / 2
        primitive["boundsMm"] = [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad]
    return primitive, None


def _semantic_role(record_kind: str, operation_kind: str) -> str:
    lowered_record = str(record_kind or "").lower()
    if lowered_record in {
        "wire",
        "bus",
        "bus_entry",
        "junction",
        "no_connect",
        "label",
        "global_label",
        "hierarchical_label",
        "pin",
    }:
        return lowered_record
    lowered_op = str(operation_kind or "").lower()
    if lowered_op == "plotpoly":
        return "graphic_polyline"
    if lowered_op == "rect":
        return "graphic_rect"
    if lowered_op == "circle":
        return "graphic_circle"
    if lowered_op.startswith("arc"):
        return "graphic_arc"
    if lowered_op == "text":
        return "text"
    return lowered_op or lowered_record or "unknown"


def _is_symbol_record(record: Any) -> bool:
    return str(getattr(record, "kind", "") or "") in {"symbol_instance", "symbol_overplot"}


def _component_indexes(design_payload: dict[str, Any], topology: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    by_designator: dict[str, dict[str, Any]] = {}
    for component in design_payload.get("components", []) or []:
        designator = str(component.get("designator") or "")
        if not designator:
            continue
        by_designator[designator] = {
            "componentDesignator": designator,
            "componentSvgId": str(component.get("svg_id") or ""),
            "componentValue": str(component.get("value") or ""),
            "componentFootprint": str(component.get("footprint") or ""),
            "libraryRef": str(component.get("library_ref") or ""),
        }
    if topology:
        for component in topology.get("components", []) or []:
            designator = str(component.get("designator") or "")
            if not designator:
                continue
            by_designator.setdefault(designator, {"componentDesignator": designator})
            by_designator[designator].update(
                {
                    "componentUid": str(component.get("uid") or ""),
                    "componentValue": str(component.get("value") or by_designator[designator].get("componentValue") or ""),
                    "componentFootprint": str(component.get("footprint") or by_designator[designator].get("componentFootprint") or ""),
                }
            )
    return by_designator


def _pin_lookup_indexes(
    design_payload: dict[str, Any],
    topology: dict[str, Any] | None,
    component_by_designator: dict[str, dict[str, Any]],
) -> dict[str, dict[Any, dict[str, Any]]]:
    by_svg_id: dict[Any, dict[str, Any]] = {}
    by_designator_pin: dict[Any, dict[str, Any]] = {}
    for net in design_payload.get("nets", []) or []:
        net_payload = {
            "netUid": str(net.get("uid") or ""),
            "netName": str(net.get("name") or ""),
            "netClass": str(net.get("net_class") or ""),
        }
        terminal_meta: dict[tuple[str, str], dict[str, Any]] = {}
        for terminal in net.get("terminals", []) or []:
            designator = str(terminal.get("designator") or "")
            pin = str(terminal.get("pin") or "")
            if not designator or not pin:
                continue
            terminal_meta[(designator, pin)] = {
                **net_payload,
                "designator": designator,
                "pinNumber": pin,
                "pinName": str(terminal.get("pin_name") or ""),
                "pinType": str(terminal.get("pin_type") or ""),
            }
        for pin_item in (net.get("graphical", {}) or {}).get("pins", []) or []:
            designator = str(pin_item.get("designator") or "")
            pin = str(pin_item.get("pin") or "")
            svg_id = str(pin_item.get("svg_id") or "")
            if not designator or not pin:
                continue
            payload = {
                **terminal_meta.get((designator, pin), net_payload),
                **component_by_designator.get(designator, {}),
                "designator": designator,
                "pinNumber": pin,
                "svgId": svg_id,
            }
            by_designator_pin[(designator, pin)] = payload
            if svg_id:
                by_svg_id[svg_id] = payload
        for endpoint in net.get("endpoints", []) or []:
            if endpoint.get("role") != "pin":
                continue
            designator = str(endpoint.get("designator") or "")
            pin = str(endpoint.get("pin") or "")
            object_id = str(endpoint.get("object_id") or endpoint.get("element_id") or "")
            if not designator or not pin:
                continue
            payload = {
                **terminal_meta.get((designator, pin), net_payload),
                **component_by_designator.get(designator, {}),
                "designator": designator,
                "pinNumber": pin,
                "pinName": str(endpoint.get("pin_name") or terminal_meta.get((designator, pin), {}).get("pinName") or ""),
                "pinType": str(endpoint.get("pin_type") or terminal_meta.get((designator, pin), {}).get("pinType") or ""),
                "svgId": object_id,
            }
            by_designator_pin[(designator, pin)] = {**by_designator_pin.get((designator, pin), {}), **payload}
            if object_id:
                by_svg_id[object_id] = {**by_svg_id.get(object_id, {}), **payload}

    if topology:
        for terminal in topology.get("terminals", []) or []:
            component_uid = str(terminal.get("component_uid") or "")
            pin = str(terminal.get("pin") or terminal.get("pad") or "")
            designator = ""
            for component in topology.get("components", []) or []:
                if str(component.get("uid") or "") == component_uid:
                    designator = str(component.get("designator") or "")
                    break
            if not designator or not pin:
                continue
            payload = {
                **component_by_designator.get(designator, {}),
                "designator": designator,
                "pinNumber": pin,
                "terminalUid": str(terminal.get("uid") or ""),
                "pcbPadId": str(terminal.get("pcb_pad_id") or ""),
                "modelContactId": str(terminal.get("model_contact_id") or ""),
                "netUid": str(terminal.get("net_uid") or by_designator_pin.get((designator, pin), {}).get("netUid") or ""),
                "netName": str(terminal.get("net_name") or by_designator_pin.get((designator, pin), {}).get("netName") or ""),
                "componentUid": component_uid,
            }
            by_designator_pin[(designator, pin)] = {**by_designator_pin.get((designator, pin), {}), **payload}
    return {"bySvgId": by_svg_id, "byDesignatorPin": by_designator_pin}


def _symbol_body_key(sheet_instance_path: str, source_id: str) -> str:
    return stable_feature_key(sheet_instance_path, source_id, 0, "symbol_body", 0)


def _pin_feature_key(sheet_instance_path: str, pin_source_id: str) -> str:
    return stable_feature_key(sheet_instance_path, pin_source_id, 0, "pin", 0)


def _pin_block_info(data: dict[str, Any], pin_lookup: dict[str, dict[Any, dict[str, Any]]]) -> dict[str, Any] | None:
    extras = data.get("extra_attrs") or {}
    if str(data.get("data_ref") or "") != "symbol_pin" and extras.get("primitive") != "pin" and extras.get("object-type") != "pin":
        return None
    pin_source_id = str(data.get("data_uuid") or data.get("uuid") or data.get("object_id") or "")
    pin_number = str(extras.get("pin") or data.get("pin") or "")
    designator = str(extras.get("designator") or "")
    symbol_uuid = str(extras.get("symbol-uuid") or "")
    payload: dict[str, Any] = {
        "pinSourceId": pin_source_id,
        "uuid": pin_source_id,
        "sourceId": pin_source_id,
        "pinNumber": pin_number,
        "designator": designator,
        "reference": designator,
        "symbolUuid": symbol_uuid,
    }
    by_svg = pin_lookup.get("bySvgId", {})
    by_designator_pin = pin_lookup.get("byDesignatorPin", {})
    payload.update(by_svg.get(pin_source_id, {}))
    if designator and pin_number:
        payload.update(by_designator_pin.get((designator, pin_number), {}))
    if not payload.get("pinName"):
        payload["pinName"] = ""
    return payload if pin_source_id else None


def _union_bounds(bounds_list: list[list[float]]) -> list[float] | None:
    if not bounds_list:
        return None
    return [
        min(bounds[0] for bounds in bounds_list),
        min(bounds[1] for bounds in bounds_list),
        max(bounds[2] for bounds in bounds_list),
        max(bounds[3] for bounds in bounds_list),
    ]


def _symbol_owner_features(
    page_id: str,
    sheet_instance_path: str,
    record: Any,
    record_index: int,
    parent_feature: dict[str, Any],
    pin_lookup: dict[str, dict[Any, dict[str, Any]]],
    component_by_designator: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    if not _is_symbol_record(record):
        return []
    source_id = _record_source_id(record, record_index)
    extras = getattr(record, "extras", None) or {}
    reference = str(parent_feature.get("reference") or extras.get("reference") or "")
    value = str(parent_feature.get("value") or extras.get("value") or "")
    pins: dict[str, dict[str, Any]] = {}
    pin_bounds: dict[str, list[list[float]]] = defaultdict(list)
    current_pin: dict[str, Any] | None = None
    body_bounds: list[list[float]] = []
    for operation in getattr(record, "operations", []) or []:
        data = operation.to_dict() if hasattr(operation, "to_dict") else dict(operation)
        kind = str(data.get("kind") or "")
        if kind == "StartBlock":
            current_pin = _pin_block_info(data, pin_lookup)
            if current_pin:
                pins[current_pin["pinSourceId"]] = {**current_pin}
                if current_pin.get("designator") and not reference:
                    reference = str(current_pin.get("designator") or "")
            continue
        if kind == "EndBlock":
            current_pin = None
            continue
        bounds = _operation_bounds(operation)
        if not bounds:
            continue
        if current_pin:
            pin_bounds[current_pin["pinSourceId"]].append(bounds)
        elif kind not in NON_GEOMETRY_OPERATION_KINDS:
            body_bounds.append(bounds)

    component_meta = component_by_designator.get(reference, {})
    feature_base = {
        "pageId": page_id,
        "sheetInstancePath": sheet_instance_path,
        "parentStableKey": parent_feature["stableKey"],
        "symbolFeatureStableKey": parent_feature["stableKey"],
        "symbolFeatureId": 0,
        "symbolUuid": parent_feature.get("uuid") or extras.get("source_symbol_uuid") or "",
        "reference": reference,
        "value": value or component_meta.get("componentValue", ""),
        "libraryRef": str(extras.get("lib_id") or component_meta.get("libraryRef") or ""),
        "unit": int(extras.get("unit") or 1),
        "convert": int(extras.get("convert") or 1),
        "rotationDeg": float(extras.get("at_angle_deg") or 0),
        "mirror": str(extras.get("mirror") or ""),
        **component_meta,
    }
    body = {
        **feature_base,
        "id": 0,
        "stableKey": _symbol_body_key(sheet_instance_path, source_id),
        "sourceId": source_id,
        "uuid": parent_feature.get("uuid", ""),
        "objectId": parent_feature.get("objectId", ""),
        "kind": "symbol_body",
        "semanticRole": "symbol_body",
    }
    if bounds := _union_bounds(body_bounds) or parent_feature.get("boundsMm"):
        body["boundsMm"] = bounds
    features = [body]
    for pin_source_id, pin in sorted(pins.items()):
        feature = {
            **feature_base,
            **pin,
            "id": 0,
            "stableKey": _pin_feature_key(sheet_instance_path, pin_source_id),
            "sourceId": pin_source_id,
            "uuid": pin_source_id,
            "objectId": pin_source_id,
            "kind": "pin",
            "semanticRole": "pin",
            "parentStableKey": parent_feature["stableKey"],
            "symbolFeatureStableKey": parent_feature["stableKey"],
        }
        if bounds := _union_bounds(pin_bounds.get(pin_source_id, [])):
            feature["boundsMm"] = bounds
        features.append(feature)
    return features


def _symbol_text_role(
    data: dict[str, Any],
    parent_feature: dict[str, Any],
    outside_text_count: int,
    inferred_reference: str,
) -> str:
    text = str(data.get("text") or "")
    reference = str(parent_feature.get("reference") or inferred_reference or "")
    value = str(parent_feature.get("value") or "")
    if reference and (text == reference or text.startswith(reference)):
        return "symbol_reference"
    if value and text == value:
        return "symbol_value"
    if outside_text_count == 0:
        return "symbol_reference"
    if outside_text_count == 1:
        return "symbol_value"
    return "symbol_text"


def _operation_descriptors(
    page: dict[str, Any],
    record: Any,
    record_index: int,
    parent_feature: dict[str, Any],
    pin_lookup: dict[str, dict[Any, dict[str, Any]]],
    component_by_designator: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    source_id = _record_source_id(record, record_index)
    is_symbol = _is_symbol_record(record)
    current_pin: dict[str, Any] | None = None
    descriptors: list[dict[str, Any]] = []
    outside_text_count = 0
    inferred_reference = ""
    for op_index, operation in enumerate(getattr(record, "operations", []) or [], start=1):
        data = operation.to_dict() if hasattr(operation, "to_dict") else dict(operation)
        operation_kind = str(data.get("kind") or "unknown")
        if operation_kind == "StartBlock":
            current_pin = _pin_block_info(data, pin_lookup)
            if current_pin and current_pin.get("designator"):
                inferred_reference = str(current_pin.get("designator") or "")
            continue
        if operation_kind == "EndBlock":
            current_pin = None
            continue
        if operation_kind in NON_GEOMETRY_OPERATION_KINDS:
            continue
        feature_source_id = source_id
        parent_stable_key = parent_feature["stableKey"]
        semantic_role = _semantic_role(str(getattr(record, "kind", "") or "unknown"), operation_kind)
        metadata: dict[str, Any] = {}
        if current_pin:
            feature_source_id = str(current_pin["pinSourceId"])
            parent_stable_key = _pin_feature_key(page["sheetInstancePath"], feature_source_id)
            if operation_kind == "Text":
                text = str(data.get("text") or "")
                semantic_role = "pin_number" if text == str(current_pin.get("pinNumber") or "") else "pin_name"
            else:
                semantic_role = "pin_body"
            metadata = dict(current_pin)
        elif is_symbol:
            if operation_kind == "Text":
                semantic_role = _symbol_text_role(data, parent_feature, outside_text_count, inferred_reference)
                outside_text_count += 1
            else:
                semantic_role = "symbol_body"
                parent_stable_key = _symbol_body_key(page["sheetInstancePath"], source_id)
            reference = str(parent_feature.get("reference") or inferred_reference or "")
            metadata = {
                "reference": reference,
                "value": str(parent_feature.get("value") or component_by_designator.get(reference, {}).get("componentValue") or ""),
                "symbolUuid": parent_feature.get("uuid", ""),
                **component_by_designator.get(reference, {}),
            }
        feature_key = stable_feature_key(page["sheetInstancePath"], feature_source_id, op_index, semantic_role, 0)
        feature_role = semantic_role
        if semantic_role == "symbol_body":
            feature_key = _symbol_body_key(page["sheetInstancePath"], source_id)
            feature_role = "symbol_body"
        elif semantic_role == "pin_body":
            feature_key = _pin_feature_key(page["sheetInstancePath"], feature_source_id)
            feature_role = "pin"
        descriptors.append(
            {
                "opIndex": op_index,
                "operation": operation,
                "operationKind": operation_kind,
                "sourceId": feature_source_id,
                "semanticRole": semantic_role,
                "featureKey": feature_key,
                "featureRole": feature_role,
                "parentStableKey": parent_stable_key,
                "metadata": metadata,
            }
        )
    return descriptors


def _operation_to_primitive(operation: Any, feature_id: int = 0) -> tuple[dict[str, Any] | None, str | None]:
    data = operation.to_dict() if hasattr(operation, "to_dict") else dict(operation)
    kind = str(data.get("kind") or "unknown")
    if kind in NON_GEOMETRY_OPERATION_KINDS:
        return None, None
    if kind == "Text":
        contours = _text_cache_contours(data)
        if contours:
            primitive = {
                "featureId": feature_id,
                "kind": "text_contours",
                "provider": "render_cache",
                "contoursMm": contours,
                "text": str(data.get("text") or ""),
                "style": {
                    "provider": "render_cache",
                    "sizeXNm": int(data.get("size_x_nm") or 0),
                    "sizeYNm": int(data.get("size_y_nm") or 0),
                    "orientDeg": float(data.get("orient_deg", data.get("angle", 0)) or 0),
                    "hAlign": str(data.get("h_align") or ""),
                    "vAlign": str(data.get("v_align") or ""),
                    "mirror": bool(data.get("mirror")),
                    "italic": bool(data.get("italic")),
                    "bold": bool(data.get("bold")),
                    "fontFace": str(data.get("font_face") or ""),
                },
            }
            if bounds := _polyline_bounds(contours):
                primitive["boundsMm"] = bounds
            if data.get("color"):
                primitive["color"] = str(data.get("color") or "")
            return primitive, None
        return _newstroke_text_primitive(data, feature_id)
    if kind not in SUPPORTED_VECTOR_OPERATION_KINDS:
        return None, kind
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
    if "color" in data:
        primitive["color"] = str(data.get("color") or "")

    has_geometry = (
        "pointsMm" in primitive
        or any(key.endswith("Mm") for key in primitive)
        or lowered == "text_contours"
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
    component_by_designator: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    kind = str(getattr(record, "kind", "") or "unknown")
    source_id = _record_source_id(record, record_index)
    record_uuid = str(getattr(record, "uuid", "") or "")
    object_id = str(getattr(record, "object_id", "") or "")
    feature = {
        "id": feature_id,
        "stableKey": stable_feature_key(sheet_instance_path, source_id, 0, "record", 0),
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
    if component_by_designator and feature.get("reference"):
        component_meta = component_by_designator.get(str(feature["reference"]), {})
        for key, value in component_meta.items():
            if value not in (None, "") and key not in feature:
                feature[key] = value
        if not feature.get("value") and component_meta.get("componentValue"):
            feature["value"] = component_meta["componentValue"]
    return feature


def _page_chunks(
    page: dict[str, Any],
    records: list[Any],
    features: list[dict[str, Any]],
    feature_id_by_key: dict[str, int],
    pin_lookup: dict[str, dict[Any, dict[str, Any]]] | None = None,
    component_by_designator: dict[str, dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, str]], list[dict[str, Any]]]:
    feature_by_source = {feature["sourceId"]: feature for feature in features}
    feature_by_key = {feature["stableKey"]: feature for feature in features}
    pin_lookup = pin_lookup or {"bySvgId": {}, "byDesignatorPin": {}}
    component_by_designator = component_by_designator or {}
    unsupported: list[dict[str, str]] = []
    simplified_bounds = []
    primitives = []
    primitive_features: list[dict[str, Any]] = []

    for record_index, record in enumerate(records, start=1):
        source_id = _record_source_id(record, record_index)
        parent_feature = feature_by_source.get(source_id)
        if not parent_feature:
            continue
        bounds = parent_feature.get("boundsMm")
        if bounds:
            simplified_bounds.append(
                {
                    "featureId": parent_feature["id"],
                    "kind": parent_feature["kind"],
                    "boundsMm": bounds,
                    "netUid": parent_feature.get("netUid", ""),
                }
            )
        for descriptor in _operation_descriptors(
            page,
            record,
            record_index,
            parent_feature,
            pin_lookup,
            component_by_designator,
        ):
            operation = descriptor["operation"]
            op_index = descriptor["opIndex"]
            operation_kind = descriptor["operationKind"]
            semantic_role = descriptor["semanticRole"]
            sub_feature_key = descriptor.get("featureKey") or stable_feature_key(
                page["sheetInstancePath"],
                descriptor["sourceId"],
                op_index,
                semantic_role,
                0,
            )
            primitive_feature_id = feature_id_by_key.get(sub_feature_key, 0)
            primitive, unsupported_kind = _operation_to_primitive(operation, primitive_feature_id)
            if primitive:
                primitive["subFeatureKey"] = sub_feature_key
                primitive["semanticRole"] = semantic_role
                bounds_mm = primitive.get("boundsMm") or _operation_bounds(operation)
                if bounds_mm:
                    primitive["boundsMm"] = bounds_mm
                primitives.append(primitive)
                primitive_feature = {
                    **(feature_by_key.get(descriptor["parentStableKey"]) or parent_feature),
                    **descriptor["metadata"],
                    "id": primitive_feature_id,
                    "stableKey": sub_feature_key,
                    "parentStableKey": descriptor["parentStableKey"],
                    "parentFeatureId": feature_id_by_key.get(descriptor["parentStableKey"], parent_feature["id"]),
                    "primitiveKind": primitive["kind"],
                    "subFeatureIndex": op_index,
                    "semanticRole": semantic_role,
                    "kind": descriptor.get("featureRole") or semantic_role,
                }
                if bounds_mm:
                    primitive_feature["boundsMm"] = bounds_mm
                primitive_features.append(primitive_feature)
            elif unsupported_kind:
                unsupported.append(
                    {
                        "sourceId": source_id,
                        "recordKind": str(getattr(record, "kind", "") or "unknown"),
                        "operationKind": unsupported_kind,
                        "semanticRole": semantic_role,
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
    return lod0, lod1, lod2, unsupported, primitive_features


def build_schematic_scene(
    design: Any,
    design_payload: dict[str, Any],
    output_dir: Path,
    topology: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from kicad_monkey import KiCadSvgRenderOptions, render_ir_to_svg  # type: ignore
    from kicad_monkey.kicad_schematic_svg_enrichment import (  # type: ignore
        schematic_root_svg_attrs,
        schematic_svg_enrichment_payload,
    )

    schematic_dir = output_dir / "schematic-vector"
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
    page_records: dict[str, list[Any]] = {}
    feature_key_payloads: dict[str, dict[str, Any]] = {}
    page_feature_keys: dict[str, list[str]] = defaultdict(list)
    page_text_coverage: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"required": 0, "covered": 0, "renderCache": 0, "newstroke": 0, "unsupported": 0}
    )
    text_cache_coverage = {
        "required": 0,
        "covered": 0,
        "renderCache": 0,
        "newstroke": 0,
        "unsupported": 0,
        "byRecordKind": defaultdict(lambda: {"required": 0, "covered": 0, "renderCache": 0, "newstroke": 0, "unsupported": 0}),
    }
    component_by_designator = _component_indexes(design_payload, topology)
    pin_lookup = _pin_lookup_indexes(design_payload, topology, component_by_designator)

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
        for record_index, record in enumerate(getattr(ir, "records", []) or [], start=1):
            feature = _record_feature(
                page_id,
                instance_path,
                record,
                record_index,
                0,
                svg_to_net,
                component_by_designator,
            )
            feature_key_payloads[feature["stableKey"]] = feature
            page_feature_keys[page_id].append(feature["stableKey"])
            for owner_feature in _symbol_owner_features(
                page_id,
                instance_path,
                record,
                record_index,
                feature,
                pin_lookup,
                component_by_designator,
            ):
                feature_key_payloads[owner_feature["stableKey"]] = owner_feature
                page_feature_keys[page_id].append(owner_feature["stableKey"])
                if owner_feature.get("netUid"):
                    net_to_pages[owner_feature["netUid"]].add(page_id)
            if feature.get("netUid"):
                net_to_pages[feature["netUid"]].add(page_id)
            if feature.get("reference"):
                component_to_pages[feature["reference"]].add(page_id)
            if feature.get("kind") in {"global_label", "hierarchical_label", "label", "bus", "bus_entry"}:
                hierarchy_endpoint_index[feature.get("netUid", "")].append(
                    {
                        "pageId": page_id,
                        "featureKey": feature["stableKey"],
                        "kind": feature["kind"],
                        "text": feature.get("text") or feature.get("netName") or "",
                    }
                )
            for descriptor in _operation_descriptors(
                {
                    "id": page_id,
                    "sheetInstancePath": instance_path,
                    "sourceWidthMm": source_width_mm,
                    "sourceHeightMm": source_height_mm,
                },
                record,
                record_index,
                feature,
                pin_lookup,
                component_by_designator,
            ):
                operation = descriptor["operation"]
                data = operation.to_dict() if hasattr(operation, "to_dict") else dict(operation)
                operation_kind = descriptor["operationKind"]
                if operation_kind in NON_GEOMETRY_OPERATION_KINDS:
                    continue
                record_kind = str(getattr(record, "kind", "") or "unknown")
                semantic_role = descriptor["semanticRole"]
                primitive, unsupported_kind = _operation_to_primitive(operation, 0)
                if operation_kind == "Text":
                    bucket = text_cache_coverage["byRecordKind"][record_kind]
                    text_required = bool(str(data.get("text") or ""))
                    if text_required:
                        page_bucket = page_text_coverage[page_id]
                        text_cache_coverage["required"] += 1
                        bucket["required"] += 1
                        page_bucket["required"] += 1
                        if primitive:
                            provider = str(primitive.get("provider") or "unknown")
                            text_cache_coverage["covered"] += 1
                            bucket["covered"] += 1
                            page_bucket["covered"] += 1
                            if provider == "render_cache":
                                text_cache_coverage["renderCache"] += 1
                                bucket["renderCache"] += 1
                                page_bucket["renderCache"] += 1
                            elif provider == "newstroke":
                                text_cache_coverage["newstroke"] += 1
                                bucket["newstroke"] += 1
                                page_bucket["newstroke"] += 1
                        else:
                            text_cache_coverage["unsupported"] += 1
                            bucket["unsupported"] += 1
                            page_bucket["unsupported"] += 1
                if not primitive:
                    continue
                primitive_key = descriptor.get("featureKey") or stable_feature_key(
                    instance_path,
                    descriptor["sourceId"],
                    descriptor["opIndex"],
                    semantic_role,
                    0,
                )
                parent_key = descriptor["parentStableKey"]
                primitive_feature = {
                    **feature,
                    **descriptor["metadata"],
                    "stableKey": primitive_key,
                    "parentStableKey": parent_key,
                    "primitiveKind": primitive["kind"],
                    "subFeatureIndex": descriptor["opIndex"],
                    "semanticRole": semantic_role,
                    "kind": descriptor.get("featureRole") or semantic_role,
                }
                bounds_mm = _operation_bounds(operation)
                if primitive.get("boundsMm"):
                    bounds_mm = primitive["boundsMm"]
                if bounds_mm:
                    primitive_feature["boundsMm"] = bounds_mm
                if primitive_key not in feature_key_payloads:
                    feature_key_payloads[primitive_key] = primitive_feature
                    page_feature_keys[page_id].append(primitive_key)

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
            "featureIds": [],
            "featureCount": 0,
            "netUids": sorted(str(uid) for uid in net_map),
        }
        pages.append(page)
        page_records[page_id] = list(getattr(ir, "records", []) or [])

    for page in pages:
        page["parentId"] = instance_to_page.get(page["parentSheetInstancePath"], "")

    feature_id_by_key = deterministic_feature_ids(set(feature_key_payloads))
    features = []
    features_by_page.clear()
    for key in sorted(feature_key_payloads):
        feature = dict(feature_key_payloads[key])
        feature["id"] = feature_id_by_key[key]
        if parent_key := feature.get("parentStableKey"):
            feature["parentFeatureId"] = feature_id_by_key.get(parent_key, 0)
        if symbol_key := feature.get("symbolFeatureStableKey"):
            feature["symbolFeatureId"] = feature_id_by_key.get(symbol_key, 0)
        features.append(feature)
    for page in pages:
        ids = sorted(
            {
                feature_id_by_key[key]
                for key in page_feature_keys.get(page["id"], [])
                if key in feature_id_by_key
            }
        )
        page["featureIds"] = ids
        page["featureCount"] = len(ids)
        coverage = dict(page_text_coverage[page["id"]])
        satisfied = coverage["covered"] >= coverage["required"]
        page["nativeDetail"] = {
            "enabled": bool(satisfied),
            "representation": "native-vector" if satisfied else "svg-fallback",
            "textCoverageSatisfied": bool(satisfied),
            "text": coverage,
            "fallbackReason": "" if satisfied else "required text operations were not fully covered",
        }
        features_by_page[page["id"]] = ids
    for endpoints in hierarchy_endpoint_index.values():
        for endpoint in endpoints:
            key = endpoint.pop("featureKey", "")
            endpoint["featureId"] = str(feature_id_by_key.get(key, 0))

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
        lod0, lod1, lod2, unsupported, primitive_features = _page_chunks(
            page,
            page_records[page["id"]],
            page_features,
            feature_id_by_key,
            pin_lookup,
            component_by_designator,
        )
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
    (schematic_dir / "pages.json").write_text(
        json.dumps({"schema": f"{SCHEMA}.pages", "pages": pages}, separators=(",", ":")),
        encoding="utf-8",
    )

    revision_source = json.dumps(
        {
            "schema": SCHEMA,
            "textCacheCoverage": {
                "required": text_cache_coverage["required"],
                "covered": text_cache_coverage["covered"],
                "renderCache": text_cache_coverage["renderCache"],
                "newstroke": text_cache_coverage["newstroke"],
                "unsupported": text_cache_coverage["unsupported"],
                "byRecordKind": dict(sorted(
                    (key, dict(value))
                    for key, value in text_cache_coverage["byRecordKind"].items()
                )),
            },
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
        "pageTable": "pages.json",
        "edges": edges,
        "featureTable": "features.json",
        "stringTable": "strings.json",
        "netToPages": {key: sorted(value) for key, value in sorted(net_to_pages.items())},
        "componentToPages": {key: sorted(value) for key, value in sorted(component_to_pages.items())},
        "hierarchyEndpointIndex": {
            key: value for key, value in sorted(hierarchy_endpoint_index.items()) if key
        },
        "unsupported": unsupported_operations,
        "diagnostics": {
            "unsupportedOperationCount": len(unsupported_operations),
            "textCacheCoverage": {
                "required": text_cache_coverage["required"],
                "covered": text_cache_coverage["covered"],
                "renderCache": text_cache_coverage["renderCache"],
                "newstroke": text_cache_coverage["newstroke"],
                "unsupported": text_cache_coverage["unsupported"],
                "byRecordKind": dict(sorted(
                    (key, dict(value))
                    for key, value in text_cache_coverage["byRecordKind"].items()
                )),
            },
            "nativeDetailCoverage": {
                page["id"]: page["nativeDetail"]
                for page in pages
            },
            "textProvider": {
                "mode": "render-cache-first-newstroke-fallback",
                "defaultProvider": "newstroke",
                "outlineProvider": "Text.render_cache/render_cache_polygons when present and valid",
                "fallback": "page-level-svg-when-required-text-coverage-is-incomplete",
                "licenseProvenance": "NewStroke text geometry is generated by kicad_monkey.kicad_stroke_font from KiCad's stroke-font behavior. No external glyph corpus vendored. Browser fonts and toy client-side strokes are not used in native L2/L3.",
            },
        },
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
    diagnostics = {
        "schema": f"{SCHEMA}.diagnostics",
        "unsupported": unsupported_operations,
        "textCacheCoverage": manifest["diagnostics"]["textCacheCoverage"],
        "nativeDetailCoverage": manifest["diagnostics"]["nativeDetailCoverage"],
        "textProvider": manifest["diagnostics"]["textProvider"],
        "nativeDetailComposition": "SVG thumbnails are L0/fallback only; native L2 hides the full SVG texture.",
    }
    (schematic_dir / "diagnostics.json").write_text(
        json.dumps(diagnostics, separators=(",", ":")),
        encoding="utf-8",
    )
    (schematic_dir / "schematic.vector.manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")),
        encoding="utf-8",
    )
    return {
        "schema": SCHEMA,
        "path": "schematic-vector/schematic.vector.manifest.json",
        "geometry_revision": manifest["geometryRevision"],
        "page_count": len(pages),
        "feature_count": len(features),
        "unsupported_count": len(unsupported_operations),
    }
