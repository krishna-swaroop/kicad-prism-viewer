from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAGIC_A1 = b"P3DSCNA1"
MAGIC = b"P3DSCNA2"
VERSION = 2
HEADER_STRUCT_A1 = struct.Struct("<8sIIII")
HEADER_STRUCT = struct.Struct("<8sIIIIII")
VERTEX_STRUCT_A1 = struct.Struct("<ffffffIIII")
VERTEX_STRUCT = struct.Struct("<fffIII")
INDEX_STRUCT = struct.Struct("<I")

KIND_IDS = {
    "unknown": 0,
    "board": 1,
    "track": 2,
    "track_arc": 2,
    "zone": 3,
    "pad": 4,
    "via": 5,
    "silkscreen": 6,
    "component": 7,
}

LAYER_COLORS = {
    "Board": [0.12, 0.36, 0.26, 1.0],
    "F.Cu": [0.88, 0.18, 0.14, 1.0],
    "B.Cu": [0.10, 0.32, 0.86, 1.0],
    "In1.Cu": [0.15, 0.62, 0.30, 1.0],
    "In2.Cu": [0.58, 0.36, 0.18, 1.0],
    "In3.Cu": [0.08, 0.62, 0.72, 1.0],
    "In4.Cu": [0.44, 0.28, 0.72, 1.0],
    "F.SilkS": [0.92, 0.94, 0.96, 1.0],
    "B.SilkS": [0.72, 0.78, 0.84, 1.0],
    "Through": [0.96, 0.48, 0.18, 1.0],
    "Components": [0.56, 0.60, 0.66, 1.0],
}


@dataclass
class Primitive:
    positions: list[list[float]]
    normals: list[list[float]]
    indices: list[int]
    mesh_name: str
    node_name: str
    local_positions: list[list[float]] | None = None
    local_normals: list[list[float]] | None = None
    world_matrix: list[float] | None = None
    component_matrix: list[float] | None = None


def build_semantic_scene(
    topology: dict[str, Any],
    semantic_geometry: dict[str, Any],
    output_dir: Path,
) -> bytes:
    builder = _SemanticSceneBuilder(topology)

    base_asset = str(semantic_geometry.get("assets", {}).get("base_board_glb") or "")
    base_path = output_dir / base_asset
    packing_mode = str(semantic_geometry.get("packing_mode") or "per-net")
    if base_asset and base_path.exists() and packing_mode == "aggregate-spatial":
        builder.add_aggregate_geometry(base_path)
    elif base_asset and base_path.exists():
        builder.add_base_context(base_path)

    for chunk in semantic_geometry.get("net_chunks", []) or []:
        net_uid = str(chunk.get("net_uid") or "")
        path = output_dir / str(chunk.get("path") or "")
        if net_uid and path.exists():
            builder.add_net_geometry(path, net_uid)

    components_asset = str(semantic_geometry.get("assets", {}).get("components_glb") or "")
    components_path = output_dir / components_asset
    if components_asset and components_path.exists():
        builder.add_components(components_path)

    return builder.to_bytes()


def write_semantic_scene(
    topology: dict[str, Any],
    semantic_geometry: dict[str, Any],
    output_dir: Path,
) -> dict[str, Any]:
    scene_bytes = build_semantic_scene(topology, semantic_geometry, output_dir)
    path = output_dir / "semantic_scene.bin"
    path.write_bytes(scene_bytes)
    metadata = read_semantic_scene_metadata(path)
    return {
        "path": "semantic_scene.bin",
        "bytes": path.stat().st_size,
        "schema": metadata["schema"],
        "vertex_count": metadata["vertex_count"],
        "objects": len(metadata["objects"]),
        "nets": len(metadata["nets"]),
        "layers": len(metadata["layers"]),
    }


def read_semantic_scene_metadata(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    magic = data[:8]
    if magic == MAGIC_A1:
        _magic, version, metadata_len, _vertex_count, _stride = HEADER_STRUCT_A1.unpack_from(data)
        offset = HEADER_STRUCT_A1.size
    elif magic == MAGIC:
        _magic, version, metadata_len, _vertex_count, _index_count, _vertex_stride, _index_stride = HEADER_STRUCT.unpack_from(data)
        offset = HEADER_STRUCT.size
    else:
        raise ValueError("Invalid semantic scene magic")
    if version not in {1, VERSION}:
        raise ValueError(f"Unsupported semantic scene version: {version}")
    return json.loads(data[offset : offset + metadata_len].decode("utf-8"))


class _SemanticSceneBuilder:
    def __init__(self, topology: dict[str, Any]) -> None:
        self.topology = topology
        self.vertex_bytes = bytearray()
        self.index_bytes = bytearray()
        self.vertex_count = 0
        self.index_count = 0
        self.objects: list[dict[str, Any]] = [{"id": 0, "kind": "none", "label": "None", "net_id": 0, "layer_id": 0}]
        self.bbox_min = [math.inf, math.inf, math.inf]
        self.bbox_max = [-math.inf, -math.inf, -math.inf]
        self.board_y_min: float | None = None
        self.board_y_max: float | None = None

        self.nets = [{"id": 0, "uid": "", "name": "", "color": [0.5, 0.5, 0.5, 1.0]}]
        self.net_id_by_uid: dict[str, int] = {}
        for net in topology.get("nets", []) or []:
            uid = str(net.get("uid") or "")
            if not uid:
                continue
            net_id = len(self.nets)
            self.net_id_by_uid[uid] = net_id
            self.nets.append(
                {
                    "id": net_id,
                    "uid": uid,
                    "name": str(net.get("name") or ""),
                    "color": _stable_net_color(uid or str(net.get("name") or "")),
                }
            )

        self.layers = []
        self.layer_id_by_name: dict[str, int] = {}
        for layer in topology.get("layers", []) or []:
            self._layer_id(str(layer.get("name") or ""))
        self._layer_id("Through")
        self._layer_id("Components")

        self.objects_by_net: dict[str, list[dict[str, Any]]] = {}
        self.spatial_cell_mm = 2.0
        self.spatial_objects: dict[tuple[str, str, int, int], list[dict[str, Any]]] = {}
        self.mapping_by_kind: dict[str, dict[str, int]] = {}
        for obj in topology.get("physical_objects", []) or []:
            net_uid = str(obj.get("net_uid") or "")
            if not net_uid:
                continue
            self.objects_by_net.setdefault(net_uid, []).append(obj)
            self._index_spatial_object(obj)

    def add_base_context(self, path: Path) -> None:
        primitives = _read_glb_primitives(path)
        self._set_board_y_range(primitives)

        for primitive in primitives:
            name = primitive.mesh_name.lower()
            if "_pcb" not in name and "_silkscreen" not in name:
                continue
            layer = "Board"
            kind = "board"
            if "_silkscreen" in name:
                layer = "F.SilkS" if _primitive_y_range(primitive)[1] > 0.001 else "B.SilkS"
                kind = "silkscreen"
            self._append_primitive(primitive, net_uid="", layer=layer, kind=kind, label=primitive.mesh_name)

    def add_aggregate_geometry(self, path: Path) -> None:
        primitives = _read_glb_primitives(path)
        self._set_board_y_range(primitives)
        for primitive in primitives:
            name = primitive.mesh_name.lower()
            if "_pcb" in name:
                self._append_primitive(primitive, net_uid="", layer="Board", kind="board", label=primitive.mesh_name)
                continue
            if "_silkscreen" in name:
                layer = "F.SilkS" if self._geometry_layer(primitive) == "F.Cu" else "B.SilkS"
                self._append_primitive(primitive, net_uid="", layer=layer, kind="silkscreen", label=primitive.mesh_name)
                continue
            if not any(token in name for token in ("_copper", "_pad", "_via")):
                continue

            layer = self._geometry_layer(primitive)
            kind_hint = _fallback_kind(primitive.mesh_name)
            match = self._match_aggregate_object(primitive, layer, kind_hint)
            net_uid = str(match.get("net_uid") or "") if match else ""
            kind = str(match.get("kind") or kind_hint) if match else kind_hint
            source_uid = str(match.get("uid") or "") if match else ""
            label = self._net_name(net_uid) or primitive.mesh_name
            self._append_primitive(
                primitive,
                net_uid=net_uid,
                layer=layer,
                kind=kind,
                label=label,
                source_uid=source_uid,
            )

    def add_net_geometry(self, path: Path, net_uid: str) -> None:
        for primitive in _read_glb_primitives(path):
            layer, kind, source_uid = self._classify_net_primitive(primitive, net_uid)
            label = self._net_name(net_uid) or net_uid
            self._append_primitive(primitive, net_uid=net_uid, layer=layer, kind=kind, label=label, source_uid=source_uid)

    def add_components(self, path: Path) -> None:
        for primitive in _read_glb_primitives(path):
            designator = _designator_from_node(primitive.node_name)
            self._append_primitive(
                primitive,
                net_uid="",
                layer="Components",
                kind="component",
                label=designator or primitive.node_name or primitive.mesh_name,
                component_designator=designator,
            )

    def to_bytes(self) -> bytes:
        bbox_min = self.bbox_min if self.vertex_count else [0.0, 0.0, 0.0]
        bbox_max = self.bbox_max if self.vertex_count else [1.0, 1.0, 1.0]
        mapping = {}
        for kind, counts in self.mapping_by_kind.items():
            total = counts["total"]
            mapped = counts["mapped"]
            mapping[kind] = {
                "mapped_indices": mapped,
                "total_indices": total,
                "coverage": round(mapped / total, 6) if total else 0.0,
            }
        metadata = {
            "schema": "prism.semantic_scene_a2",
            "version": VERSION,
            "vertex_format": "float32x3_position,snorm8x4_normal,uint32_object,uint32_semantic",
            "semantic_format": "net:uint16,layer:uint8,kind:uint8",
            "object_format": "kind_id,net_id,layer_id,source_uid,component_designator",
            "vertex_count": self.vertex_count,
            "index_count": self.index_count,
            "vertex_stride": VERTEX_STRUCT.size,
            "index_stride": INDEX_STRUCT.size,
            "objects": [
                [
                    int(item.get("kind_id") or 0),
                    int(item.get("net_id") or 0),
                    int(item.get("layer_id") or 0),
                    str(item.get("source_uid") or ""),
                    str(item.get("component_designator") or ""),
                ]
                for item in self.objects
            ],
            "nets": self.nets,
            "layers": self.layers,
            "kinds": KIND_IDS,
            "bbox": {"min": bbox_min, "max": bbox_max},
            "mapping": mapping,
        }
        metadata_bytes = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
        header = HEADER_STRUCT.pack(
            MAGIC,
            VERSION,
            len(metadata_bytes),
            self.vertex_count,
            self.index_count,
            VERTEX_STRUCT.size,
            INDEX_STRUCT.size,
        )
        return header + metadata_bytes + self.vertex_bytes + self.index_bytes

    def _append_primitive(
        self,
        primitive: Primitive,
        *,
        net_uid: str,
        layer: str,
        kind: str,
        label: str,
        source_uid: str = "",
        component_designator: str = "",
    ) -> None:
        net_id = self.net_id_by_uid.get(net_uid, 0)
        if net_id > 0xFFFF:
            raise ValueError(f"semantic_scene_a2 supports at most 65535 nets, got net id {net_id}")
        layer_id = self._layer_id(layer)
        if layer_id > 0xFF:
            raise ValueError(f"semantic_scene_a2 supports at most 255 layers, got layer id {layer_id}")
        kind_id = KIND_IDS.get(kind, KIND_IDS["unknown"])
        if kind_id > 0xFF:
            raise ValueError(f"semantic_scene_a2 supports at most 255 kinds, got kind id {kind_id}")
        object_id = len(self.objects)
        self.objects.append(
            {
                "id": object_id,
                "label": label,
                "kind": kind,
                "kind_id": kind_id,
                "net_id": net_id,
                "net_uid": net_uid,
                "net_name": self._net_name(net_uid),
                "layer": layer,
                "layer_id": layer_id,
                "source_uid": source_uid,
                "component_designator": component_designator,
            }
        )
        base_vertex = self.vertex_count
        semantic = net_id | (layer_id << 16) | (kind_id << 24)
        for position, normal in zip(primitive.positions, primitive.normals):
            self._update_bbox(position)
            self.vertex_bytes.extend(
                VERTEX_STRUCT.pack(
                    float(position[0]),
                    float(position[1]),
                    float(position[2]),
                    _pack_normal(normal),
                    object_id,
                    semantic,
                )
            )
        self.vertex_count += len(primitive.positions)
        for index in primitive.indices:
            self.index_bytes.extend(INDEX_STRUCT.pack(base_vertex + int(index)))
        self.index_count += len(primitive.indices)
        counts = self.mapping_by_kind.setdefault(kind, {"mapped": 0, "total": 0})
        counts["total"] += len(primitive.indices)
        if net_id:
            counts["mapped"] += len(primitive.indices)

    def _classify_net_primitive(self, primitive: Primitive, net_uid: str) -> tuple[str, str, str]:
        layer = self._geometry_layer(primitive)
        kind_hint = _fallback_kind(primitive.mesh_name)
        centroid = _primitive_centroid(primitive)
        board_x_mm = centroid[0] * 1000.0
        board_y_mm = centroid[2] * 1000.0
        match = self._match_topology_object(net_uid, board_x_mm, board_y_mm, layer, kind_hint)
        if match:
            kind = str(match.get("kind") or "unknown")
            return layer, kind, str(match.get("uid") or "")
        return layer, kind_hint, ""

    def _geometry_layer(self, primitive: Primitive) -> str:
        name = primitive.mesh_name.lower()
        min_y, max_y = _primitive_y_range(primitive)
        if "via" in name:
            return "Through"
        if self.board_y_min is None or self.board_y_max is None:
            return _fallback_layer(primitive)

        thickness = max(self.board_y_max - self.board_y_min, 0.0001)
        surface_tolerance = max(thickness * 0.02, 0.000002)
        spans_board = (
            min_y < self.board_y_min + surface_tolerance
            and max_y > self.board_y_max - surface_tolerance
        )
        if spans_board:
            return "Through"

        midpoint = (self.board_y_min + self.board_y_max) * 0.5
        return "F.Cu" if (min_y + max_y) * 0.5 >= midpoint else "B.Cu"

    def _set_board_y_range(self, primitives: list[Primitive]) -> None:
        board_primitives = [primitive for primitive in primitives if "_pcb" in primitive.mesh_name.lower()]
        board_y_values = [point[1] for primitive in board_primitives for point in primitive.positions]
        if board_y_values:
            self.board_y_min = min(board_y_values)
            self.board_y_max = max(board_y_values)

    def _index_spatial_object(self, obj: dict[str, Any]) -> None:
        bbox = obj.get("bbox_mm") or []
        if len(bbox) != 4:
            return
        kind_key = _kind_key(str(obj.get("kind") or "unknown"))
        layers = _object_index_layers(obj, self.layers)
        min_x = math.floor(float(bbox[0]) / self.spatial_cell_mm)
        min_y = math.floor(float(bbox[1]) / self.spatial_cell_mm)
        max_x = math.floor(float(bbox[2]) / self.spatial_cell_mm)
        max_y = math.floor(float(bbox[3]) / self.spatial_cell_mm)
        for layer in layers:
            for cell_x in range(min_x, max_x + 1):
                for cell_y in range(min_y, max_y + 1):
                    self.spatial_objects.setdefault((layer, kind_key, cell_x, cell_y), []).append(obj)

    def _match_aggregate_object(
        self,
        primitive: Primitive,
        geometry_layer: str,
        kind_hint: str,
    ) -> dict[str, Any] | None:
        bbox = _primitive_board_bbox_mm(primitive)
        centroid = _primitive_centroid(primitive)
        x_mm = centroid[0] * 1000.0
        y_mm = centroid[2] * 1000.0
        kind_key = _kind_key(kind_hint)
        margin = 0.2
        min_cell_x = math.floor((bbox[0] - margin) / self.spatial_cell_mm)
        min_cell_y = math.floor((bbox[1] - margin) / self.spatial_cell_mm)
        max_cell_x = math.floor((bbox[2] + margin) / self.spatial_cell_mm)
        max_cell_y = math.floor((bbox[3] + margin) / self.spatial_cell_mm)
        candidates = []
        for cell_x in range(min_cell_x, max_cell_x + 1):
            for cell_y in range(min_cell_y, max_cell_y + 1):
                candidates.extend(self.spatial_objects.get((geometry_layer, kind_key, cell_x, cell_y), []))
        if not candidates:
            return None

        primitive_area = max(0.0001, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
        unique: dict[str, dict[str, Any]] = {}
        for obj in candidates:
            unique[str(obj.get("uid") or id(obj))] = obj

        scored = []
        for obj in unique.values():
            obj_bbox = obj.get("bbox_mm") or []
            if len(obj_bbox) != 4:
                continue
            expanded = [obj_bbox[0] - margin, obj_bbox[1] - margin, obj_bbox[2] + margin, obj_bbox[3] + margin]
            overlap_x = max(0.0, min(bbox[2], expanded[2]) - max(bbox[0], expanded[0]))
            overlap_y = max(0.0, min(bbox[3], expanded[3]) - max(bbox[1], expanded[1]))
            if overlap_x <= 0.0 or overlap_y <= 0.0:
                continue
            obj_area = max(0.0001, (obj_bbox[2] - obj_bbox[0]) * (obj_bbox[3] - obj_bbox[1]))
            strict_overlap_x = max(0.0, min(bbox[2], obj_bbox[2]) - max(bbox[0], obj_bbox[0]))
            strict_overlap_y = max(0.0, min(bbox[3], obj_bbox[3]) - max(bbox[1], obj_bbox[1]))
            strict_overlap = strict_overlap_x * strict_overlap_y
            primitive_coverage = strict_overlap / primitive_area
            object_coverage = strict_overlap / obj_area
            area_ratio = max(primitive_area, obj_area) / min(primitive_area, obj_area)
            if primitive_coverage < 0.5 and not (object_coverage >= 0.8 and area_ratio <= 2.5):
                continue
            overlap_score = (overlap_x * overlap_y) / min(primitive_area, obj_area)
            area_score = abs(math.log(primitive_area / obj_area)) * 0.2
            center_x = (obj_bbox[0] + obj_bbox[2]) * 0.5
            center_y = (obj_bbox[1] + obj_bbox[3]) * 0.5
            center_score = math.hypot(x_mm - center_x, y_mm - center_y) / max(math.sqrt(obj_area), 0.1)
            obj_kind = str(obj.get("kind") or "unknown")
            zone_penalty = 0.0
            if kind_key == "conductor":
                primitive_is_large = primitive_area >= 4.0
                zone_penalty = 2.0 if primitive_is_large != (obj_kind == "zone") else 0.0
            scored.append((zone_penalty + (1.0 - min(overlap_score, 1.0)) + area_score + center_score * 0.1, obj_area, obj))
        if not scored:
            return None
        scored.sort(key=lambda item: (item[0], item[1]))
        return scored[0][2]

    def _match_topology_object(
        self,
        net_uid: str,
        x_mm: float,
        y_mm: float,
        geometry_layer: str,
        kind_hint: str,
    ) -> dict[str, Any] | None:
        candidates = []
        for obj in self.objects_by_net.get(net_uid, []):
            bbox = obj.get("bbox_mm") or []
            if len(bbox) != 4:
                continue
            if not _object_matches_geometry(obj, geometry_layer, kind_hint):
                continue
            margin = 0.08 if obj.get("kind") in {"track", "track_arc"} else 0.15
            if bbox[0] - margin <= x_mm <= bbox[2] + margin and bbox[1] - margin <= y_mm <= bbox[3] + margin:
                area = max(0.0001, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
                candidates.append((area, obj))
        if not candidates:
            return None
        candidates.sort(key=lambda item: item[0])
        return candidates[0][1]

    def _layer_id(self, name: str) -> int:
        name = name or "Unknown"
        if name in self.layer_id_by_name:
            return self.layer_id_by_name[name]
        layer_id = len(self.layers)
        role = "copper" if name.endswith(".Cu") else "context"
        if name == "Through":
            role = "through"
        if name == "Components":
            role = "component"
        self.layer_id_by_name[name] = layer_id
        self.layers.append({"id": layer_id, "name": name, "role": role, "color": _layer_color(name)})
        return layer_id

    def _net_name(self, uid: str) -> str:
        net_id = self.net_id_by_uid.get(uid)
        if not net_id:
            return ""
        return str(self.nets[net_id].get("name") or "")

    def _update_bbox(self, position: list[float]) -> None:
        for index in range(3):
            self.bbox_min[index] = min(self.bbox_min[index], float(position[index]))
            self.bbox_max[index] = max(self.bbox_max[index], float(position[index]))


def _read_glb_primitives(path: Path) -> list[Primitive]:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError(f"Invalid GLB: {path}")
    offset = 12
    gltf: dict[str, Any] | None = None
    bin_chunk = b""
    while offset < len(data):
        length, chunk_type = struct.unpack_from("<I4s", data, offset)
        start = offset + 8
        chunk = data[start : start + length]
        if chunk_type == b"JSON":
            gltf = json.loads(chunk.decode("utf-8"))
        elif chunk_type == b"BIN\x00":
            bin_chunk = chunk
        offset = start + length
    if gltf is None:
        raise ValueError(f"GLB missing JSON chunk: {path}")

    nodes = gltf.get("nodes", []) or []
    meshes = gltf.get("meshes", []) or []
    scene = (gltf.get("scenes") or [{}])[gltf.get("scene", 0)]
    roots = scene.get("nodes") or list(range(len(nodes)))
    primitives: list[Primitive] = []

    def visit(
        node_index: int,
        parent: list[float],
        owner_name: str = "",
        component_owner: str = "",
        component_matrix: list[float] | None = None,
    ) -> None:
        node = nodes[node_index]
        node_name = str(node.get("name") or owner_name)
        next_component_owner = node_name if _designator_from_node(node_name) else component_owner
        matrix = _matmul(parent, _node_matrix(node))
        next_component_matrix = matrix if _designator_from_node(node_name) else component_matrix
        mesh_index = node.get("mesh")
        if isinstance(mesh_index, int) and mesh_index < len(meshes):
            mesh = meshes[mesh_index]
            mesh_name = str(mesh.get("name") or node_name)
            for primitive in mesh.get("primitives", []) or []:
                if primitive.get("mode", 4) != 4:
                    continue
                positions = _read_accessor(gltf, bin_chunk, primitive.get("attributes", {}).get("POSITION"))
                if not positions:
                    continue
                normals = _read_accessor(gltf, bin_chunk, primitive.get("attributes", {}).get("NORMAL")) or [[0.0, 1.0, 0.0] for _ in positions]
                raw_indices = _read_accessor(gltf, bin_chunk, primitive.get("indices"))
                indices = [int(item) for item in raw_indices] if raw_indices else list(range(len(positions)))
                out_positions = [_transform_point(matrix, position) for position in positions]
                out_normals = [_transform_normal(matrix, normal) for normal in normals]
                primitives.append(
                    Primitive(
                        positions=out_positions,
                        normals=out_normals,
                        indices=indices,
                        mesh_name=mesh_name,
                        node_name=next_component_owner or node_name or mesh_name,
                        local_positions=positions,
                        local_normals=normals,
                        world_matrix=matrix,
                        component_matrix=next_component_matrix,
                    )
                )
        for child in node.get("children", []) or []:
            visit(int(child), matrix, node_name, next_component_owner, next_component_matrix)

    for root in roots:
        visit(int(root), _identity())
    return primitives


def _read_accessor(gltf: dict[str, Any], bin_chunk: bytes, accessor_index: Any) -> list[Any]:
    if accessor_index is None:
        return []
    accessor = gltf["accessors"][int(accessor_index)]
    view = gltf["bufferViews"][accessor["bufferView"]]
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}.get(accessor["type"], 1)
    component_type = accessor["componentType"]
    fmt, size = {
        5120: ("b", 1),
        5121: ("B", 1),
        5122: ("h", 2),
        5123: ("H", 2),
        5125: ("I", 4),
        5126: ("f", 4),
    }[component_type]
    stride = int(view.get("byteStride") or width * size)
    start = int(view.get("byteOffset") or 0) + int(accessor.get("byteOffset") or 0)
    rows = []
    for row in range(int(accessor["count"])):
        values = []
        for col in range(width):
            values.append(struct.unpack_from("<" + fmt, bin_chunk, start + row * stride + col * size)[0])
        rows.append(values[0] if width == 1 else values)
    return rows


def _identity() -> list[float]:
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def _node_matrix(node: dict[str, Any]) -> list[float]:
    if node.get("matrix"):
        return [float(value) for value in node["matrix"]]
    matrix = _identity()
    if node.get("translation"):
        matrix = _matmul(matrix, _translation(node["translation"]))
    if node.get("rotation"):
        matrix = _matmul(matrix, _rotation(node["rotation"]))
    if node.get("scale"):
        matrix = _matmul(matrix, _scale(node["scale"]))
    return matrix


def _matmul(a: list[float], b: list[float]) -> list[float]:
    out = [0.0] * 16
    for row in range(4):
        for col in range(4):
            for k in range(4):
                out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k]
    return out


def _translation(v: list[float]) -> list[float]:
    matrix = _identity()
    matrix[12], matrix[13], matrix[14] = float(v[0]), float(v[1]), float(v[2])
    return matrix


def _scale(v: list[float]) -> list[float]:
    matrix = _identity()
    matrix[0], matrix[5], matrix[10] = float(v[0]), float(v[1]), float(v[2])
    return matrix


def _rotation(q: list[float]) -> list[float]:
    x, y, z, w = [float(value) for value in q]
    x2, y2, z2 = x + x, y + y, z + z
    xx, xy, xz = x * x2, x * y2, x * z2
    yy, yz, zz = y * y2, y * z2, z * z2
    wx, wy, wz = w * x2, w * y2, w * z2
    return [
        1 - (yy + zz), xy + wz, xz - wy, 0,
        xy - wz, 1 - (xx + zz), yz + wx, 0,
        xz + wy, yz - wx, 1 - (xx + yy), 0,
        0, 0, 0, 1,
    ]


def _transform_point(matrix: list[float], point: list[float]) -> list[float]:
    x, y, z = float(point[0]), float(point[1]), float(point[2])
    return [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ]


def _transform_normal(matrix: list[float], normal: list[float]) -> list[float]:
    x = matrix[0] * normal[0] + matrix[4] * normal[1] + matrix[8] * normal[2]
    y = matrix[1] * normal[0] + matrix[5] * normal[1] + matrix[9] * normal[2]
    z = matrix[2] * normal[0] + matrix[6] * normal[1] + matrix[10] * normal[2]
    length = math.sqrt(x * x + y * y + z * z) or 1.0
    return [x / length, y / length, z / length]


def _pack_normal(normal: list[float]) -> int:
    values = []
    for component in [*normal[:3], 1.0]:
        signed = max(-127, min(127, int(round(float(component) * 127.0))))
        values.append(signed & 0xFF)
    return values[0] | (values[1] << 8) | (values[2] << 16) | (values[3] << 24)


def _primitive_centroid(primitive: Primitive) -> list[float]:
    count = max(1, len(primitive.positions))
    return [
        sum(point[0] for point in primitive.positions) / count,
        sum(point[1] for point in primitive.positions) / count,
        sum(point[2] for point in primitive.positions) / count,
    ]


def _primitive_y_range(primitive: Primitive) -> tuple[float, float]:
    values = [point[1] for point in primitive.positions]
    return (min(values), max(values)) if values else (0.0, 0.0)


def _primitive_board_bbox_mm(primitive: Primitive) -> list[float]:
    xs = [point[0] * 1000.0 for point in primitive.positions]
    ys = [point[2] * 1000.0 for point in primitive.positions]
    if not xs or not ys:
        return [0.0, 0.0, 0.0, 0.0]
    return [min(xs), min(ys), max(xs), max(ys)]


def _kind_key(kind: str) -> str:
    if kind in {"track", "track_arc", "zone"}:
        return "conductor"
    return kind


def _object_index_layers(obj: dict[str, Any], layers: list[dict[str, Any]]) -> list[str]:
    kind = str(obj.get("kind") or "unknown")
    layer = str(obj.get("layer") or "")
    copper_layers = [str(item.get("name")) for item in layers if str(item.get("name") or "").endswith(".Cu")]
    object_layers = [str(item) for item in obj.get("layers", []) if item]
    if kind == "via" and object_layers:
        indexes = [copper_layers.index(name) for name in object_layers if name in copper_layers]
        if indexes:
            return copper_layers[min(indexes) : max(indexes) + 1]
    if kind == "via":
        return copper_layers or ["Through"]
    if layer in {"*.Cu", "F&B.Cu"} or any(name in {"*.Cu", "F&B.Cu"} for name in object_layers):
        return [*copper_layers, "Through"]
    if object_layers:
        return object_layers
    return [layer]


def _fallback_layer(primitive: Primitive) -> str:
    min_y, max_y = _primitive_y_range(primitive)
    name = primitive.mesh_name.lower()
    if "via" in name or (max_y > 0.001 and min_y < 0.00008):
        return "Through"
    return "F.Cu" if max_y > 0.001 else "B.Cu"


def _object_matches_geometry(obj: dict[str, Any], geometry_layer: str, kind_hint: str) -> bool:
    kind = str(obj.get("kind") or "unknown")
    layer = str(obj.get("layer") or "")

    if kind_hint == "via" and kind != "via":
        return False
    if kind_hint == "pad" and kind != "pad":
        return False
    if kind_hint == "track" and kind not in {"track", "track_arc", "zone"}:
        return False

    if geometry_layer == "Through":
        return kind == "via" or (kind == "pad" and layer in {"*.Cu", "F&B.Cu"})
    if kind == "via" and geometry_layer.endswith(".Cu"):
        return geometry_layer in _object_index_layers(obj, [{"name": name} for name in [
            "F.Cu", *[f"In{index}.Cu" for index in range(1, 31)], "B.Cu"
        ]])
    if layer in {"*.Cu", "F&B.Cu"}:
        return kind == "pad" and geometry_layer.endswith(".Cu")
    return layer == geometry_layer


def _fallback_kind(mesh_name: str) -> str:
    name = mesh_name.lower()
    if "via" in name:
        return "via"
    if "pad" in name:
        return "pad"
    if "copper" in name:
        return "track"
    if "silkscreen" in name:
        return "silkscreen"
    return "unknown"


def _designator_from_node(name: str) -> str:
    import re

    match = re.match(r"^([A-Z]+[0-9]+[A-Z]?)$", name or "")
    return match.group(1) if match else ""


def _stable_net_color(value: str) -> list[float]:
    import hashlib
    import colorsys

    digest = int(hashlib.sha1(value.encode("utf-8")).hexdigest()[:8], 16)
    hue = (digest % 360) / 360.0
    red, green, blue = colorsys.hsv_to_rgb(hue, 0.62, 0.92)
    return [round(red, 4), round(green, 4), round(blue, 4), 1.0]


def _layer_color(name: str) -> list[float]:
    if name in LAYER_COLORS:
        return LAYER_COLORS[name]
    if name.startswith("In") and name.endswith(".Cu"):
        inner = ["In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu"]
        return LAYER_COLORS[inner[(len(name) + sum(ord(c) for c in name)) % len(inner)]]
    return [0.55, 0.58, 0.62, 1.0]
