from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Any


MAGIC = b"P3DVSCN1"
VERSION = 1
HEADER_STRUCT = struct.Struct("<8sIIII")
VERTEX_STRUCT = struct.Struct("<fffIII")

KIND_IDS = {
    "board_body": 1,
    "board_outline": 2,
    "zone": 3,
    "track": 4,
    "track_arc": 4,
    "pad": 5,
    "via": 6,
}


def _rect_vertices(
    bbox: list[float],
    z: float,
    object_index: int,
    layer_index: int,
    kind_index: int,
) -> list[tuple[float, float, float, int, int, int]]:
    min_x, min_y, max_x, max_y = [float(v) for v in bbox]
    return [
        (min_x, min_y, z, object_index, layer_index, kind_index),
        (max_x, min_y, z, object_index, layer_index, kind_index),
        (max_x, max_y, z, object_index, layer_index, kind_index),
        (min_x, min_y, z, object_index, layer_index, kind_index),
        (max_x, max_y, z, object_index, layer_index, kind_index),
        (min_x, max_y, z, object_index, layer_index, kind_index),
    ]


def _area(points: list[list[float]]) -> float:
    total = 0.0
    for index, point in enumerate(points):
        nxt = points[(index + 1) % len(points)]
        total += point[0] * nxt[1] - nxt[0] * point[1]
    return total / 2.0


def _is_inside_triangle(
    point: list[float],
    a: list[float],
    b: list[float],
    c: list[float],
) -> bool:
    def sign(p1: list[float], p2: list[float], p3: list[float]) -> float:
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign(point, a, b)
    d2 = sign(point, b, c)
    d3 = sign(point, c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def _triangulate_contour(points: list[list[float]]) -> list[tuple[list[float], list[float], list[float]]]:
    contour = [point for point in points if len(point) >= 2]
    if len(contour) < 3:
        return []
    if _area(contour) < 0:
        contour = list(reversed(contour))

    triangles: list[tuple[list[float], list[float], list[float]]] = []
    remaining = list(range(len(contour)))
    guard = 0
    while len(remaining) > 3 and guard < len(contour) * len(contour):
        guard += 1
        clipped = False
        for cursor, current in enumerate(remaining):
            prev = remaining[(cursor - 1) % len(remaining)]
            nxt = remaining[(cursor + 1) % len(remaining)]
            a = contour[prev]
            b = contour[current]
            c = contour[nxt]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if cross <= 1e-9:
                continue
            if any(
                candidate not in (prev, current, nxt)
                and _is_inside_triangle(contour[candidate], a, b, c)
                for candidate in remaining
            ):
                continue
            triangles.append((a, b, c))
            del remaining[cursor]
            clipped = True
            break
        if not clipped:
            break
    if len(remaining) == 3:
        triangles.append((contour[remaining[0]], contour[remaining[1]], contour[remaining[2]]))
    return triangles


def _polygon_vertices(
    geometry: dict[str, Any],
    z: float,
    object_index: int,
    layer_index: int,
    kind_index: int,
) -> list[tuple[float, float, float, int, int, int]]:
    vertices: list[tuple[float, float, float, int, int, int]] = []
    if geometry.get("type") != "polygons":
        return vertices
    for contour in geometry.get("contours", []) or []:
        if not isinstance(contour, list):
            continue
        for a, b, c in _triangulate_contour(contour):
            vertices.extend(
                [
                    (float(a[0]), float(a[1]), z, object_index, layer_index, kind_index),
                    (float(b[0]), float(b[1]), z, object_index, layer_index, kind_index),
                    (float(c[0]), float(c[1]), z, object_index, layer_index, kind_index),
                ]
            )
    return vertices


def build_scene_bundle(topology: dict[str, Any]) -> bytes:
    """Build a compact binary render bundle.

    The bundle stores triangle vertices with object/layer ids. Topology objects
    can provide polygon geometry; simple substrate fallback rectangles are kept
    for objects that are semantically useful before richer mesh data exists.
    """

    layers = topology.get("layers", [])
    layer_by_name = {str(layer.get("name")): index for index, layer in enumerate(layers)}
    layer_z = {str(layer.get("name")): float(layer.get("z_mm") or 0.0) for layer in layers}

    objects = topology.get("physical_objects", [])
    vertices: list[tuple[float, float, float, int, int, int]] = []
    object_table: list[dict[str, Any]] = []
    for index, obj in enumerate(objects, start=1):
        bbox = obj.get("bbox_mm") or topology.get("board", {}).get("bbox_mm") or [0, 0, 1, 1]
        layer_name = str(obj.get("layer") or "Board")
        layer_index = layer_by_name.get(layer_name, 0)
        z = layer_z.get(layer_name, 0.0)
        kind = str(obj.get("kind") or "")
        kind_index = KIND_IDS.get(kind, 0)
        geometry_vertices = _polygon_vertices(obj.get("geometry", {}) or {}, z, index, layer_index, kind_index)
        if not geometry_vertices and kind in {"layer_sheet", "footprint_body"}:
            continue
        object_vertices = geometry_vertices or _rect_vertices([float(v) for v in bbox], z, index, layer_index, kind_index)
        object_table.append(
            {
                "object_index": index,
                "uid": obj.get("uid"),
                "kind": obj.get("kind"),
                "layer": layer_name,
                "net_uid": obj.get("net_uid", ""),
                "component_uid": obj.get("component_uid", ""),
                "designator": obj.get("designator", ""),
            }
        )
        vertices.extend(object_vertices)

    metadata = {
        "schema": "prism.scene_bundle_a0",
        "version": VERSION,
        "vertex_format": "float32x3,uint32_object,uint32_layer,uint32_kind",
        "vertex_count": len(vertices),
        "objects": object_table,
        "layers": [
            {
                "index": index,
                "uid": layer.get("uid"),
                "name": layer.get("name"),
                "role": layer.get("role"),
                "color": layer.get("color"),
                "z_mm": layer.get("z_mm"),
            }
            for index, layer in enumerate(layers)
        ],
    }
    metadata_bytes = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    vertex_bytes = b"".join(VERTEX_STRUCT.pack(*vertex) for vertex in vertices)
    header = HEADER_STRUCT.pack(MAGIC, VERSION, len(metadata_bytes), len(vertices), VERTEX_STRUCT.size)
    return header + metadata_bytes + vertex_bytes


def write_scene_bundle(topology: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(build_scene_bundle(topology))


def read_scene_bundle(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    magic, version, metadata_len, vertex_count, vertex_stride = HEADER_STRUCT.unpack_from(data)
    if magic != MAGIC:
        raise ValueError("Invalid scene bundle magic")
    if version != VERSION:
        raise ValueError(f"Unsupported scene bundle version: {version}")
    offset = HEADER_STRUCT.size
    metadata = json.loads(data[offset : offset + metadata_len].decode("utf-8"))
    offset += metadata_len
    vertices = []
    for index in range(vertex_count):
        start = offset + index * vertex_stride
        vertices.append(VERTEX_STRUCT.unpack_from(data, start))
    return {"metadata": metadata, "vertices": vertices}
