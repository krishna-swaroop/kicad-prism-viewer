from __future__ import annotations

from pathlib import Path
from typing import Any

from .models import stable_id


LAYER_COLORS = {
    "Board": "#2f6b4f",
    "F.Cu": "#c98b2b",
    "B.Cu": "#b87024",
    "Edge.Cuts": "#d9d9d9",
    "F.SilkS": "#f2f2f2",
    "B.SilkS": "#dddddd",
    "F.Mask": "#316d4f",
    "B.Mask": "#275840",
    "F.Paste": "#c5cbd3",
    "B.Paste": "#aeb7c2",
}

INNER_LAYER_COLORS = [
    "#269e4d",
    "#93612f",
    "#159eb7",
    "#7047b8",
    "#b58b24",
    "#a34f76",
]


def _bbox_list(bounds: Any) -> list[float] | None:
    if bounds is None or not bounds.is_valid():
        return None
    return [
        round(float(bounds.min_x), 6),
        round(float(bounds.min_y), 6),
        round(float(bounds.max_x), 6),
        round(float(bounds.max_y), 6),
    ]


def _bbox_from_points(points: list[tuple[float, float]]) -> list[float] | None:
    if not points:
        return None
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return [round(min(xs), 6), round(min(ys), 6), round(max(xs), 6), round(max(ys), 6)]


def _merge_bbox(left: list[float] | None, right: list[float] | None) -> list[float] | None:
    if not left:
        return right
    if not right:
        return left
    return [
        min(left[0], right[0]),
        min(left[1], right[1]),
        max(left[2], right[2]),
        max(left[3], right[3]),
    ]


def _clean_contour(points: list[tuple[float, float]]) -> list[list[float]]:
    cleaned: list[list[float]] = []
    for x, y in points:
        point = [round(float(x), 6), round(float(y), 6)]
        if cleaned and cleaned[-1] == point:
            continue
        cleaned.append(point)
    if len(cleaned) > 1 and cleaned[0] == cleaned[-1]:
        cleaned.pop()
    return cleaned if len(cleaned) >= 3 else []


def _geometry_from_contours(contours: list[list[tuple[float, float]]]) -> dict[str, Any]:
    cleaned = [_clean_contour(contour) for contour in contours]
    cleaned = [contour for contour in cleaned if contour]
    if not cleaned:
        return {}
    return {"type": "polygons", "contours": cleaned}


def _geometry_from_polyset(polyset: Any) -> dict[str, Any]:
    if polyset is None or polyset.is_empty():
        return {}
    return _geometry_from_contours(list(getattr(polyset, "outlines", []) or []))


def _transform_contour(
    contour: list[tuple[float, float]],
    x: float,
    y: float,
    angle: float,
) -> list[tuple[float, float]]:
    from kicad_monkey.kicad_geometry import rotate_point  # type: ignore

    transformed: list[tuple[float, float]] = []
    for px, py in contour:
        rx, ry = rotate_point(float(px), float(py), -angle)
        transformed.append((rx + x, ry + y))
    return transformed


def _pad_contours(pad: Any, footprint: Any) -> list[list[tuple[float, float]]]:
    from kicad_monkey.kicad_pcb_polygon_ops import circle_to_polygon, oval_to_polygon  # type: ignore

    shape = _value(getattr(getattr(pad, "shape", ""), "value", getattr(pad, "shape", "")))
    if shape == "circle":
        contours = [circle_to_polygon((pad.at_x, pad.at_y), pad.size_x / 2.0)]
    elif shape == "oval":
        start, end, width = pad._to_oval_segment(pad.at_x, pad.at_y)
        contours = [oval_to_polygon(start, end, width)]
    elif shape == "roundrect":
        contours = [pad._to_roundrect_polygon(pad.at_x, pad.at_y)]
    elif shape == "trapezoid":
        contours = [pad._to_trapezoid_polygon(pad.at_x, pad.at_y)]
    elif shape == "custom" and getattr(pad, "custom_primitives", None):
        contours = [
            list(primitive.points)
            for primitive in pad.custom_primitives
            if getattr(primitive, "primitive_type", "") == "gr_poly" and primitive.points
        ]
    else:
        contours = [pad._to_rect_polygon(pad.at_x, pad.at_y)]

    return [
        _transform_contour(
            contour,
            float(getattr(footprint, "at_x", 0.0) or 0.0),
            float(getattr(footprint, "at_y", 0.0) or 0.0),
            float(getattr(footprint, "at_angle", 0.0) or 0.0),
        )
        for contour in contours
    ]


def _value(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _net_name(net: Any) -> str:
    return _value(getattr(net, "name", ""))


def _net_uid(name: str) -> str:
    return stable_id("net", name) if name else ""


def _component_uid(designator: str) -> str:
    return stable_id("cmp", designator) if designator else ""


def _role_for_layer(name: str, raw_type: str = "") -> str:
    if name == "Board":
        return "dielectric"
    if name == "Edge.Cuts":
        return "outline"
    if name.endswith(".Cu"):
        return "copper"
    if name.endswith(".Mask"):
        return "soldermask"
    if name.endswith(".Paste"):
        return "paste"
    if name.endswith(".SilkS"):
        return "silkscreen"
    if name.endswith(".Fab"):
        return "fabrication"
    if raw_type:
        return raw_type
    return "drawing"


def _layer_material(role: str) -> str:
    if role == "dielectric":
        return "FR4"
    if role == "copper":
        return "copper"
    if role == "soldermask":
        return "soldermask"
    if role == "silkscreen":
        return "ink"
    return role


def _declared_layers(pcb: Any) -> list[dict[str, Any]]:
    board_thickness = float(getattr(pcb, "thickness", 1.6) or 1.6)
    layers = [
        {
            "name": "Board",
            "role": "dielectric",
            "thickness_mm": board_thickness,
            "material": "FR4",
            "color": LAYER_COLORS["Board"],
        }
    ]
    stackup = getattr(pcb, "stackup", None)
    stackup_layers = list(getattr(stackup, "layers", []) or [])
    if stackup_layers:
        inner_index = 0
        for index, raw in enumerate(stackup_layers):
            name = _value(getattr(raw, "name", "")) or f"stackup_{index}"
            get_item_type = getattr(raw, "get_item_type", None)
            item_type = get_item_type() if callable(get_item_type) else ""
            role = _value(getattr(item_type, "value", item_type)).lower() or _role_for_layer(
                name,
                _value(getattr(raw, "type_name", "")),
            )
            thickness = float(getattr(raw, "thickness", 0.0) or 0.0)
            color = _value(getattr(raw, "color", ""))
            if role == "copper":
                if name == "F.Cu":
                    color = "#df342b"
                elif name == "B.Cu":
                    color = "#245fd3"
                else:
                    color = INNER_LAYER_COLORS[inner_index % len(INNER_LAYER_COLORS)]
                    inner_index += 1
            layers.append(
                {
                    "name": name,
                    "role": role,
                    "type": _value(getattr(raw, "type_name", "")),
                    "thickness_mm": thickness,
                    "material": _value(getattr(raw, "material", "")) or _layer_material(role),
                    "color": color or LAYER_COLORS.get(name, "#8a8a8a"),
                    "stack_index": index,
                }
            )
        return layers

    for raw in getattr(pcb, "layers", []) or []:
        name = _value(getattr(raw, "canonical_name", ""))
        if not name:
            continue
        raw_type = _value(getattr(getattr(raw, "layer_type", ""), "value", ""))
        role = _role_for_layer(name, raw_type)
        layers.append(
            {
                "name": name,
                "role": role,
                "thickness_mm": 0.035 if role == "copper" else 0.01,
                "material": _layer_material(role),
                "color": LAYER_COLORS.get(name, "#8a8a8a"),
            }
        )
    return layers


def _board_bbox(pcb: Any) -> list[float]:
    bbox: list[float] | None = None
    for item in pcb.top_level_outline_items(layer_name="Edge.Cuts"):
        bbox = _merge_bbox(bbox, _bbox_list(item.get_bounds()))
    if bbox:
        return bbox
    board_bounds = _bbox_list(pcb.get_bounds())
    return board_bounds or [0.0, 0.0, 80.0, 50.0]


def _physical(
    *,
    uid_seed: str,
    kind: str,
    layer: str,
    layers: list[str] | None = None,
    bbox: list[float] | None,
    source_id: str = "",
    net_name: str = "",
    designator: str = "",
    geometry: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if not bbox:
        return None
    return {
        "uid": stable_id("obj", uid_seed),
        "kind": kind,
        "layer": layer,
        "layers": list(layers or ([layer] if layer else [])),
        "net_uid": _net_uid(net_name),
        "net_name": net_name,
        "component_uid": _component_uid(designator),
        "designator": designator,
        "bbox_mm": bbox,
        "source_ids": [source_id] if source_id else [],
        "geometry": geometry or {},
    }


def _extract_footprints(pcb: Any) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    objects: list[dict[str, Any]] = []
    terminal_pad_links: list[dict[str, str]] = []
    for footprint in getattr(pcb, "footprints", []) or []:
        designator = _value(footprint.get_property_value("Reference", ""))
        footprint_bbox: list[float] | None = None
        source_id = _value(getattr(footprint, "uuid", ""))

        for pad in getattr(footprint, "pads", []) or []:
            pad_bounds = _bbox_list(pad.get_bounds())
            if not pad_bounds:
                continue
            transformed = _transform_local_bbox(
                pad_bounds,
                float(getattr(footprint, "at_x", 0.0) or 0.0),
                float(getattr(footprint, "at_y", 0.0) or 0.0),
                float(getattr(footprint, "at_angle", 0.0) or 0.0),
            )
            pad_geometry = _geometry_from_contours(_pad_contours(pad, footprint))
            footprint_bbox = _merge_bbox(footprint_bbox, transformed)
            layers = list(getattr(pad, "layers", []) or [])
            layer = next((name for name in layers if name.endswith(".Cu")), layers[0] if layers else _value(getattr(footprint, "layer", "")))
            net_name = _net_name(getattr(pad, "net", None))
            pad_uuid = _value(getattr(pad, "uuid", ""))
            pad_uid_seed = f"pad:{source_id}:{pad_uuid or pad.number}"
            pad_item = _physical(
                uid_seed=pad_uid_seed,
                kind="pad",
                layer=layer or "F.Cu",
                layers=layers,
                bbox=transformed,
                source_id=pad_uuid,
                net_name=net_name,
                designator=designator,
                geometry=pad_geometry,
            )
            if pad_item:
                objects.append(pad_item)
                terminal_pad_links.append(
                    {
                        "designator": designator,
                        "pin": _value(getattr(pad, "number", "")),
                        "net_name": net_name,
                        "object_uid": pad_item["uid"],
                    }
                )
        if footprint_bbox:
            footprint_bbox = [
                footprint_bbox[0] - 0.35,
                footprint_bbox[1] - 0.35,
                footprint_bbox[2] + 0.35,
                footprint_bbox[3] + 0.35,
            ]
        else:
            footprint_bbox = _bbox_list(footprint.get_bounds())
        item = _physical(
            uid_seed=f"footprint:{source_id or designator}",
            kind="footprint_body",
            layer=_value(getattr(footprint, "layer", "")) or "F.Cu",
            bbox=footprint_bbox,
            source_id=source_id,
            designator=designator,
        )
        if item:
            objects.append(item)
    return objects, terminal_pad_links


def _transform_local_bbox(bbox: list[float], x: float, y: float, angle: float) -> list[float]:
    from kicad_monkey.kicad_geometry import rotate_point  # type: ignore

    min_x, min_y, max_x, max_y = bbox
    points = [
        (min_x, min_y),
        (max_x, min_y),
        (max_x, max_y),
        (min_x, max_y),
    ]
    transformed = []
    for px, py in points:
        rx, ry = rotate_point(px, py, -angle)
        transformed.append((rx + x, ry + y))
    return _bbox_from_points(transformed) or bbox


def _extract_routing(pcb: Any) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for segment in getattr(pcb, "segments", []) or []:
        net_name = _net_name(getattr(segment, "net", None))
        item = _physical(
            uid_seed=f"segment:{getattr(segment, 'uuid', '')}",
            kind="track",
            layer=_value(getattr(segment, "layer", "")) or "F.Cu",
            bbox=_bbox_list(segment.get_bounds()),
            source_id=_value(getattr(segment, "uuid", "")),
            net_name=net_name,
            geometry=_geometry_from_polyset(segment._to_poly()),
        )
        if item:
            objects.append(item)

    for via in getattr(pcb, "vias", []) or []:
        layers = list(getattr(via, "layers", []) or [])
        net_name = _net_name(getattr(via, "net", None))
        item = _physical(
            uid_seed=f"via:{getattr(via, 'uuid', '')}",
            kind="via",
            layer=layers[0] if layers else "F.Cu",
            layers=layers,
            bbox=_bbox_list(via.get_bounds()),
            source_id=_value(getattr(via, "uuid", "")),
            net_name=net_name,
            geometry=_geometry_from_polyset(via._to_poly()),
        )
        if item:
            objects.append(item)

    for arc in getattr(pcb, "arcs", []) or []:
        net_name = _net_name(getattr(arc, "net", None))
        item = _physical(
            uid_seed=f"arc:{getattr(arc, 'uuid', '')}",
            kind="track_arc",
            layer=_value(getattr(arc, "layer", "")) or "F.Cu",
            bbox=_bbox_list(arc.get_bounds()),
            source_id=_value(getattr(arc, "uuid", "")),
            net_name=net_name,
            geometry=_geometry_from_polyset(arc._to_poly()),
        )
        if item:
            objects.append(item)
    return objects


def _extract_zones(pcb: Any) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for zone in getattr(pcb, "zones", []) or []:
        net_name = _net_name(getattr(zone, "net", None))
        layers = list(getattr(zone, "layers", []) or [])
        if not layers:
            layers = [_value(getattr(zone, "layer", "")) or "F.Cu"]
        for layer in layers:
            contours = [
                list(filled.points)
                for filled in getattr(zone, "filled_polygons", []) or []
                if getattr(filled, "points", None)
                and _value(getattr(filled, "layer", "")) in {"", layer}
            ]
            if not contours:
                contours = [
                    list(poly.points)
                    for poly in getattr(zone, "polygons", []) or []
                    if getattr(poly, "points", None)
                ]
            item = _physical(
                uid_seed=f"zone:{getattr(zone, 'uuid', '')}:{layer}",
                kind="zone",
                layer=layer,
                bbox=_bbox_list(zone.get_bounds()),
                source_id=_value(getattr(zone, "uuid", "")),
                net_name=net_name,
                geometry=_geometry_from_contours(contours),
            )
            if item:
                objects.append(item)
    return objects


def _extract_board_graphics(pcb: Any) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for rect in getattr(pcb, "gr_rects", []) or []:
        bbox = _bbox_from_points(
            [
                (rect.start_x, rect.start_y),
                (rect.end_x, rect.start_y),
                (rect.end_x, rect.end_y),
                (rect.start_x, rect.end_y),
            ]
        )
        item = _physical(
            uid_seed=f"graphic_rect:{getattr(rect, 'uuid', '')}",
            kind="board_outline" if getattr(rect, "layer", "") == "Edge.Cuts" else "graphic_rect",
            layer=_value(getattr(rect, "layer", "")) or "Edge.Cuts",
            bbox=bbox,
            source_id=_value(getattr(rect, "uuid", "")),
            geometry=_geometry_from_polyset(rect._to_poly()),
        )
        if item:
            objects.append(item)
    return objects


def extract_pcb_metadata(project_file: Path) -> dict[str, Any]:
    from kicad_monkey import KiCadPcb  # type: ignore

    pcb_file = project_file.with_suffix(".kicad_pcb")
    pcb = KiCadPcb.from_file(pcb_file)
    footprint_objects, terminal_pad_links = _extract_footprints(pcb)
    physical_objects = []
    physical_objects.extend(_extract_board_graphics(pcb))
    physical_objects.extend(_extract_zones(pcb))
    physical_objects.extend(_extract_routing(pcb))
    physical_objects.extend(footprint_objects)

    layers = _declared_layers(pcb)
    stackup = getattr(pcb, "stackup", None)
    computed_thickness = float(getattr(pcb, "thickness", 1.6) or 1.6)
    get_board_thickness = getattr(stackup, "get_board_thickness", None)
    if callable(get_board_thickness):
        computed_thickness = float(get_board_thickness() or computed_thickness)
    return {
        "source": str(pcb_file),
        "board": {
            "bbox_mm": _board_bbox(pcb),
            "thickness_mm": computed_thickness,
            "aux_axis_origin_mm": [0.0, 0.0],
            "stackup": {
                "present": True,
                "layers": layers,
                "computed_thickness_mm": computed_thickness,
                "copper_finish": _value(getattr(stackup, "copper_finish", "")),
            },
        },
        "physical_objects": physical_objects,
        "terminal_pad_links": terminal_pad_links,
        "stats": {
            "layers": len(layers),
            "footprints": len(getattr(pcb, "footprints", []) or []),
            "pads": sum(len(getattr(fp, "pads", []) or []) for fp in getattr(pcb, "footprints", []) or []),
            "segments": len(getattr(pcb, "segments", []) or []),
            "vias": len(getattr(pcb, "vias", []) or []),
            "zones": len(getattr(pcb, "zones", []) or []),
            "physical_objects": len(physical_objects),
        },
    }
