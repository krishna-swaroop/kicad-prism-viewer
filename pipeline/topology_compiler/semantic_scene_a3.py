from __future__ import annotations

import hashlib
import json
import math
import shutil
import struct
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .semantic_scene import (
    KIND_IDS,
    Primitive,
    _SemanticSceneBuilder,
    _designator_from_node,
    _fallback_kind,
    _pack_normal,
    _primitive_board_bbox_mm,
    _primitive_centroid,
    _primitive_y_range,
    _read_glb_primitives,
)


SCHEMA = "prism.semantic_scene_a3"
FEATURE_MAGIC = b"P3DFEAT3"
CHUNK_MAGIC = b"P3DCHNK3"
INSTANCE_MAGIC = b"P3DINST3"
FEATURE_HEADER = struct.Struct("<8sIIII")
FEATURE_RECORD = struct.Struct("<IIIIBBHII")
CHUNK_HEADER = struct.Struct("<8sIIII6f")
VERTEX_RECORD = struct.Struct("<4HII")
INDEX_RECORD = struct.Struct("<H")
INSTANCE_HEADER = struct.Struct("<8sIIII")
INSTANCE_RECORD = struct.Struct("<16fI")
MAX_CHUNK_VERTICES = 65_000
TILE_SIZE_MM = 50.0


@dataclass
class _RawChunk:
    key: tuple[Any, ...]
    lod: str
    layer_id: int
    kind_class: str
    tile: tuple[int, int]
    vertices: list[tuple[tuple[float, float, float], int, int]] = field(default_factory=list)
    indices: list[int] = field(default_factory=list)
    vertex_lookup: dict[tuple[Any, ...], int] = field(default_factory=dict)
    net_ids: set[int] = field(default_factory=set)
    feature_ids: set[int] = field(default_factory=set)


@dataclass
class _ComponentMesh:
    digest: str
    primitive: Primitive
    instances: list[tuple[list[float], int]] = field(default_factory=list)


class SemanticSceneA3Builder(_SemanticSceneBuilder):
    def __init__(self, topology: dict[str, Any]) -> None:
        super().__init__(topology)
        self.features: list[dict[str, Any]] = [
            {
                "object_id": 0,
                "net_id": 0,
                "primary_layer_id": 0,
                "layer_mask": 0,
                "kind_id": 0,
                "source_uid": "",
                "component_designator": "",
            }
        ]
        self.feature_by_key: dict[tuple[Any, ...], int] = {}
        self.raw_chunks: dict[tuple[Any, ...], list[_RawChunk]] = {}
        self.component_meshes: dict[str, _ComponentMesh] = {}
        self.object_by_uid = {
            str(item.get("uid") or ""): item
            for item in topology.get("physical_objects", []) or []
            if item.get("uid")
        }
        self.copper_layers = [
            layer
            for layer in self.layers
            if str(layer.get("role") or "") == "copper" or str(layer.get("name") or "").endswith(".Cu")
        ]
        self.copper_layer_ids = [int(layer["id"]) for layer in self.copper_layers]
        self.copper_bit_by_name = {
            str(layer["name"]): 1 << index for index, layer in enumerate(self.copper_layers[:32])
        }
        self.copper_bands: list[tuple[float, float, str]] = []
        self.band_diagnostics: dict[str, Any] = {}
        self.feature_bounds_mm: dict[int, list[float]] = {}

    def add_components(self, path: Path) -> None:
        by_component: dict[str, list[Primitive]] = {}
        for primitive in _read_glb_primitives(path):
            designator = _designator_from_node(primitive.node_name)
            if designator:
                by_component.setdefault(designator, []).append(primitive)
        for designator, primitives in by_component.items():
            feature_id = self._feature_id(
                net_uid="",
                layer="Components",
                kind="component",
                source_uid="",
                component_designator=designator,
            )
            root_matrix = primitives[0].component_matrix or _identity()
            inverse_root = _inverse_matrix(root_matrix)
            combined_positions: list[list[float]] = []
            combined_normals: list[list[float]] = []
            combined_indices: list[int] = []
            for primitive in primitives:
                relative = _matmul(inverse_root, primitive.world_matrix or _identity())
                base = len(combined_positions)
                combined_positions.extend(
                    _transform_point(relative, point)
                    for point in (primitive.local_positions or primitive.positions)
                )
                combined_normals.extend(
                    _transform_normal(relative, normal)
                    for normal in (primitive.local_normals or primitive.normals)
                )
                combined_indices.extend(base + int(index) for index in primitive.indices)
            digest = _component_digest(combined_positions, combined_normals, combined_indices)
            mesh = self.component_meshes.get(digest)
            if mesh is None:
                local_primitive = Primitive(
                    positions=combined_positions,
                    normals=combined_normals,
                    indices=combined_indices,
                    mesh_name=designator,
                    node_name=designator,
                )
                mesh = _ComponentMesh(digest=digest, primitive=local_primitive)
                self.component_meshes[digest] = mesh
            mesh.instances.append((list(root_matrix), feature_id))
            for primitive in primitives:
                for point in primitive.positions:
                    self._update_bbox(point)

    def _set_board_y_range(self, primitives: list[Primitive]) -> None:
        super()._set_board_y_range(primitives)
        expected = len(self.copper_layers)
        counts: Counter[tuple[float, float]] = Counter()
        for primitive in primitives:
            name = primitive.mesh_name.lower()
            if not any(token in name for token in ("_copper", "_pad")):
                continue
            min_y, max_y = _primitive_y_range(primitive)
            thickness = max_y - min_y
            if 0.000001 <= thickness <= 0.000080:
                counts[(round(min_y, 9), round(max_y, 9))] += 1
        candidates = sorted(counts, key=lambda item: (item[0] + item[1]) * 0.5)
        clusters: list[list[tuple[float, float]]] = []
        for candidate in candidates:
            midpoint = (candidate[0] + candidate[1]) * 0.5
            if not clusters:
                clusters.append([candidate])
                continue
            previous_midpoint = sum((item[0] + item[1]) * 0.5 for item in clusters[-1]) / len(clusters[-1])
            if abs(midpoint - previous_midpoint) <= 0.000080:
                clusters[-1].append(candidate)
            else:
                clusters.append([candidate])
        selected = [
            max(cluster, key=lambda item: counts[item])
            for cluster in clusters
        ]
        if expected and len(selected) != expected:
            raise ValueError(
                f"Inner copper classification expected {expected} GLB bands but found {len(selected)}. "
                "Verify kicad-cli export used --include-inner-copper."
            )
        names_bottom_to_top = [str(layer["name"]) for layer in reversed(self.copper_layers)]
        self.copper_bands = [
            (band[0], band[1], names_bottom_to_top[index])
            for index, band in enumerate(selected)
        ]
        self.band_diagnostics = {
            "expected_layers": [str(layer["name"]) for layer in self.copper_layers],
            "detected_bands": [
                {"min_y_m": min_y, "max_y_m": max_y, "layer": name, "samples": counts[(min_y, max_y)]}
                for min_y, max_y, name in self.copper_bands
            ],
        }

    def _geometry_layer(self, primitive: Primitive) -> str:
        min_y, max_y = _primitive_y_range(primitive)
        span = max_y - min_y
        if self.copper_bands and span <= 0.000100:
            midpoint = (min_y + max_y) * 0.5
            best = min(
                self.copper_bands,
                key=lambda band: abs(midpoint - (band[0] + band[1]) * 0.5),
            )
            tolerance = max((best[1] - best[0]) * 1.5, 0.000020)
            if best[0] - tolerance <= midpoint <= best[1] + tolerance:
                return best[2]
        if "via" in primitive.mesh_name.lower() or (
            self.board_y_min is not None
            and self.board_y_max is not None
            and min_y <= self.board_y_min + 0.000010
            and max_y >= self.board_y_max - 0.000010
        ):
            return str(self.copper_layers[0]["name"]) if self.copper_layers else "F.Cu"
        return super()._geometry_layer(primitive)

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
        feature_id = self._feature_id(
            net_uid=net_uid,
            layer=layer,
            kind=kind,
            source_uid=source_uid,
            component_designator=component_designator,
        )
        if kind == "component":
            return
        primitive_bbox = _primitive_board_bbox_mm(primitive)
        existing_bbox = self.feature_bounds_mm.get(feature_id)
        self.feature_bounds_mm[feature_id] = primitive_bbox if existing_bbox is None else [
            min(existing_bbox[0], primitive_bbox[0]),
            min(existing_bbox[1], primitive_bbox[1]),
            max(existing_bbox[2], primitive_bbox[2]),
            max(existing_bbox[3], primitive_bbox[3]),
        ]
        for point in primitive.positions:
            self._update_bbox(point)
        kind_class = _kind_class(kind)
        inner_copper = layer.startswith("In") and layer.endswith(".Cu")
        if not inner_copper:
            self._add_primitive_to_chunk(primitive, feature_id, layer, kind_class, "solid", surface_only=False)
        if kind in {"track", "track_arc", "zone", "pad", "via"}:
            self._add_primitive_to_chunk(primitive, feature_id, layer, kind_class, "surface", surface_only=True)
        counts = self.mapping_by_kind.setdefault(kind, {"mapped": 0, "total": 0})
        counts["total"] += len(primitive.indices)
        if self.features[feature_id]["net_id"]:
            counts["mapped"] += len(primitive.indices)

    def _feature_id(
        self,
        *,
        net_uid: str,
        layer: str,
        kind: str,
        source_uid: str,
        component_designator: str,
    ) -> int:
        net_id = self.net_id_by_uid.get(net_uid, 0)
        layer_id = self._layer_id(layer)
        kind_id = KIND_IDS.get(kind, KIND_IDS["unknown"])
        obj = self.object_by_uid.get(source_uid, {})
        layer_mask = self._layer_mask(obj, layer)
        key = (source_uid, component_designator, net_id, layer_id, layer_mask, kind_id)
        existing = self.feature_by_key.get(key)
        if existing:
            return existing
        feature_id = len(self.features)
        self.features.append(
            {
                "object_id": feature_id,
                "net_id": net_id,
                "primary_layer_id": layer_id,
                "layer_mask": layer_mask,
                "kind_id": kind_id,
                "source_uid": source_uid,
                "component_designator": component_designator,
            }
        )
        self.feature_by_key[key] = feature_id
        return feature_id

    def _layer_mask(self, obj: dict[str, Any], geometry_layer: str) -> int:
        if not self.copper_bit_by_name:
            return 0
        names = [str(item) for item in obj.get("layers", []) if item]
        if not names:
            names = [str(obj.get("layer") or geometry_layer)]
        if any(name in {"*.Cu", "F&B.Cu"} for name in names):
            return (1 << min(32, len(self.copper_layers))) - 1
        copper_names = [name for name in names if name in self.copper_bit_by_name]
        if len(copper_names) >= 2:
            indexes = [list(self.copper_bit_by_name).index(name) for name in copper_names]
            start, end = min(indexes), max(indexes)
            return sum(1 << index for index in range(start, end + 1))
        mask = 0
        for name in copper_names or [geometry_layer]:
            mask |= self.copper_bit_by_name.get(name, 0)
        return mask

    def _add_primitive_to_chunk(
        self,
        primitive: Primitive,
        feature_id: int,
        layer: str,
        kind_class: str,
        lod: str,
        *,
        surface_only: bool,
    ) -> None:
        selected_indices = _surface_indices(primitive) if surface_only else primitive.indices
        if not selected_indices:
            return
        bbox = _primitive_board_bbox_mm(primitive)
        tile = (
            math.floor(((bbox[0] + bbox[2]) * 0.5) / TILE_SIZE_MM),
            math.floor(((bbox[1] + bbox[3]) * 0.5) / TILE_SIZE_MM),
        )
        layer_id = self._layer_id(layer)
        base_key = (lod, layer_id, kind_class, tile[0], tile[1])
        feature = self.features[feature_id]
        chunks = self.raw_chunks.setdefault(base_key, [])
        chunk = chunks[-1] if chunks else None
        for triangle_offset in range(0, len(selected_indices) - 2, 3):
            triangle = selected_indices[triangle_offset : triangle_offset + 3]
            keys = []
            for source_index in triangle:
                position = primitive.positions[source_index]
                normal = primitive.normals[source_index]
                packed_normal = _pack_normal(normal)
                keys.append(
                    (
                        round(position[0], 9),
                        round(position[1], 9),
                        round(position[2], 9),
                        packed_normal,
                        feature_id,
                    )
                )
            needed = len({key for key in keys if chunk is None or key not in chunk.vertex_lookup})
            if chunk is None or len(chunk.vertices) + needed > MAX_CHUNK_VERTICES:
                chunk = _RawChunk(base_key + (len(chunks),), lod, layer_id, kind_class, tile)
                chunks.append(chunk)
            for source_index, vertex_key in zip(triangle, keys):
                target_index = chunk.vertex_lookup.get(vertex_key)
                if target_index is None:
                    position = primitive.positions[source_index]
                    target_index = len(chunk.vertices)
                    chunk.vertex_lookup[vertex_key] = target_index
                    chunk.vertices.append(
                        (
                            (float(position[0]), float(position[1]), float(position[2])),
                            int(vertex_key[3]),
                            feature_id,
                        )
                    )
                chunk.indices.append(target_index)
            chunk.feature_ids.add(feature_id)
            if feature["net_id"]:
                chunk.net_ids.add(int(feature["net_id"]))

    def write(self, output_dir: Path) -> dict[str, Any]:
        self._validate_feature_bounds()
        scene_dir = output_dir / "scene"
        chunks_dir = scene_dir / "chunks"
        shutil.rmtree(chunks_dir, ignore_errors=True)
        chunks_dir.mkdir(parents=True, exist_ok=True)
        feature_info = _write_features(scene_dir / "features.bin", self.features)
        chunk_entries = []
        net_to_chunks: dict[str, list[str]] = {}
        total_raw = 0
        total_compressed = feature_info["bytes"]
        for chunks in self.raw_chunks.values():
            for chunk in chunks:
                entry = _write_chunk(chunks_dir, chunk)
                chunk_entries.append(entry)
                total_raw += entry["raw_bytes"]
                total_compressed += entry["bytes"]
                for net_id in chunk.net_ids:
                    net_to_chunks.setdefault(str(net_id), []).append(entry["id"])

        component_entries = []
        component_entry_index = 0
        for mesh_index, mesh in enumerate(self.component_meshes.values()):
            mesh_feature = mesh.instances[0][1] if mesh.instances else 0
            instances_entry = _write_instances(chunks_dir, mesh_index, mesh.instances)
            total_raw += instances_entry["raw_bytes"]
            total_compressed += instances_entry["bytes"]
            for part_index, primitive in enumerate(_split_primitive(mesh.primitive)):
                mesh_chunk = _RawChunk(
                    key=("component", mesh_index, part_index),
                    lod="solid",
                    layer_id=self._layer_id("Components"),
                    kind_class="component",
                    tile=(0, 0),
                )
                self._add_component_mesh(mesh_chunk, primitive, mesh_feature)
                geometry_entry = _write_chunk(
                    chunks_dir,
                    mesh_chunk,
                    prefix=f"component-{component_entry_index:04d}",
                )
                component_entry_index += 1
                component_entries.append(
                    {
                        "geometry": geometry_entry,
                        "instances": instances_entry,
                        "instance_count": len(mesh.instances),
                    }
                )
                total_raw += geometry_entry["raw_bytes"]
                total_compressed += geometry_entry["bytes"]

        mapping = {}
        for kind, counts in self.mapping_by_kind.items():
            total = counts["total"]
            mapped = counts["mapped"]
            mapping[kind] = {
                "mapped_indices": mapped,
                "total_indices": total,
                "coverage": round(mapped / total, 6) if total else 0.0,
            }
        manifest = {
            "schema": SCHEMA,
            "version": 3,
            "compression": "zstd",
            "features": feature_info,
            "chunks": chunk_entries,
            "component_groups": component_entries,
            "net_to_chunks": net_to_chunks,
            "nets": self.nets,
            "layers": self.layers,
            "kinds": KIND_IDS,
            "copper_layer_ids": self.copper_layer_ids,
            "bbox": {
                "min": self.bbox_min if self.bbox_min[0] != math.inf else [0.0, 0.0, 0.0],
                "max": self.bbox_max if self.bbox_max[0] != -math.inf else [1.0, 1.0, 1.0],
            },
            "mapping": mapping,
            "layer_bands": self.band_diagnostics,
            "raw_bytes": total_raw,
            "compressed_bytes": total_compressed,
            "tile_size_mm": TILE_SIZE_MM,
        }
        manifest_path = scene_dir / "scene.manifest.json"
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
        return {
            "schema": SCHEMA,
            "path": "scene/scene.manifest.json",
            "features": "scene/features.bin",
            "chunks": len(chunk_entries),
            "component_groups": len(component_entries),
            "bytes": total_compressed,
            "raw_bytes": total_raw,
        }

    def _validate_feature_bounds(self) -> None:
        invalid = []
        for feature_id, geometry_bbox in self.feature_bounds_mm.items():
            feature = self.features[feature_id]
            source_uid = str(feature.get("source_uid") or "")
            obj = self.object_by_uid.get(source_uid)
            if not obj:
                continue
            object_bbox = obj.get("bbox_mm") or []
            if len(object_bbox) != 4:
                continue
            geometry_area = max(0.0001, (geometry_bbox[2] - geometry_bbox[0]) * (geometry_bbox[3] - geometry_bbox[1]))
            object_area = max(0.0001, (object_bbox[2] - object_bbox[0]) * (object_bbox[3] - object_bbox[1]))
            overlap_x = max(0.0, min(geometry_bbox[2], object_bbox[2]) - max(geometry_bbox[0], object_bbox[0]))
            overlap_y = max(0.0, min(geometry_bbox[3], object_bbox[3]) - max(geometry_bbox[1], object_bbox[1]))
            geometry_coverage = overlap_x * overlap_y / geometry_area
            if geometry_coverage < 0.25 and geometry_area > object_area * 2.5:
                invalid.append(
                    {
                        "feature_id": feature_id,
                        "source_uid": source_uid,
                        "geometry_bbox": geometry_bbox,
                        "object_bbox": object_bbox,
                        "geometry_coverage": round(geometry_coverage, 4),
                    }
                )
        if invalid:
            preview = json.dumps(invalid[:5], separators=(",", ":"))
            raise ValueError(
                f"Semantic geometry validation rejected {len(invalid)} feature assignments with "
                f"bounds outside their topology objects: {preview}"
            )

    def _add_component_mesh(self, chunk: _RawChunk, primitive: Primitive, feature_id: int) -> None:
        for source_index, (position, normal) in enumerate(zip(primitive.positions, primitive.normals)):
            chunk.vertices.append(
                (
                    (float(position[0]), float(position[1]), float(position[2])),
                    _pack_normal(normal),
                    feature_id,
                )
            )
            chunk.vertex_lookup[(source_index,)] = source_index
        chunk.indices.extend(int(index) for index in primitive.indices)


def build_semantic_scene_a3(
    topology: dict[str, Any],
    semantic_geometry: dict[str, Any],
    output_dir: Path,
) -> dict[str, Any]:
    builder = SemanticSceneA3Builder(topology)
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
    return builder.write(output_dir)


def _surface_indices(primitive: Primitive) -> list[int]:
    selected: list[int] = []
    for offset in range(0, len(primitive.indices) - 2, 3):
        ia, ib, ic = primitive.indices[offset : offset + 3]
        a, b, c = primitive.positions[ia], primitive.positions[ib], primitive.positions[ic]
        ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        normal_y = ab[2] * ac[0] - ab[0] * ac[2]
        normal_length = math.sqrt(
            (ab[1] * ac[2] - ab[2] * ac[1]) ** 2
            + normal_y**2
            + (ab[0] * ac[1] - ab[1] * ac[0]) ** 2
        )
        if normal_length and abs(normal_y / normal_length) >= 0.88:
            selected.extend((ia, ib, ic))
    return selected


def _kind_class(kind: str) -> str:
    if kind in {"track", "track_arc", "zone", "pad", "via"}:
        return "copper"
    if kind == "component":
        return "component"
    if kind == "board":
        return "board"
    return "context"


def _component_digest(
    positions: list[list[float]],
    normals: list[list[float]],
    indices: list[int],
) -> str:
    digest = hashlib.sha256()
    for position in positions:
        digest.update(struct.pack("<3f", *[float(value) for value in position[:3]]))
    for normal in normals:
        digest.update(struct.pack("<I", _pack_normal(normal)))
    for index in indices:
        digest.update(struct.pack("<I", int(index)))
    return digest.hexdigest()


def _split_primitive(primitive: Primitive) -> list[Primitive]:
    if len(primitive.positions) <= MAX_CHUNK_VERTICES:
        return [primitive]
    parts: list[Primitive] = []
    positions: list[list[float]] = []
    normals: list[list[float]] = []
    indices: list[int] = []
    remap: dict[int, int] = {}

    def flush() -> None:
        nonlocal positions, normals, indices, remap
        if not indices:
            return
        parts.append(
            Primitive(
                positions=positions,
                normals=normals,
                indices=indices,
                mesh_name=primitive.mesh_name,
                node_name=primitive.node_name,
            )
        )
        positions, normals, indices, remap = [], [], [], {}

    for offset in range(0, len(primitive.indices) - 2, 3):
        triangle = primitive.indices[offset : offset + 3]
        needed = len({index for index in triangle if index not in remap})
        if len(positions) + needed > MAX_CHUNK_VERTICES:
            flush()
        for source_index in triangle:
            target_index = remap.get(source_index)
            if target_index is None:
                target_index = len(positions)
                remap[source_index] = target_index
                positions.append(primitive.positions[source_index])
                normals.append(primitive.normals[source_index])
            indices.append(target_index)
    flush()
    return parts


def _write_features(path: Path, features: list[dict[str, Any]]) -> dict[str, Any]:
    strings = [""]
    string_ids = {"": 0}

    def string_id(value: str) -> int:
        if value not in string_ids:
            string_ids[value] = len(strings)
            strings.append(value)
        return string_ids[value]

    records = bytearray()
    for feature in features:
        records.extend(
            FEATURE_RECORD.pack(
                int(feature["object_id"]),
                int(feature["net_id"]),
                int(feature["layer_mask"]),
                int(feature["primary_layer_id"]),
                int(feature["kind_id"]),
                0,
                0,
                string_id(str(feature.get("source_uid") or "")),
                string_id(str(feature.get("component_designator") or "")),
            )
        )
    strings_bytes = json.dumps(strings, separators=(",", ":")).encode("utf-8")
    header = FEATURE_HEADER.pack(
        FEATURE_MAGIC,
        3,
        len(features),
        FEATURE_RECORD.size,
        len(strings_bytes),
    )
    path.write_bytes(header + strings_bytes + records)
    return {
        "path": path.relative_to(path.parents[1]).as_posix(),
        "count": len(features),
        "record_stride": FEATURE_RECORD.size,
        "bytes": path.stat().st_size,
    }


def _write_chunk(
    chunks_dir: Path,
    chunk: _RawChunk,
    *,
    prefix: str | None = None,
) -> dict[str, Any]:
    if len(chunk.vertices) > 65_535:
        raise ValueError(f"A3 chunk exceeds uint16 vertex limit: {len(chunk.vertices)}")
    bbox_min = [min(vertex[0][axis] for vertex in chunk.vertices) for axis in range(3)]
    bbox_max = [max(vertex[0][axis] for vertex in chunk.vertices) for axis in range(3)]
    vertices = bytearray()
    for position, normal, feature_id in chunk.vertices:
        quantized = [
            _quantize(position[axis], bbox_min[axis], bbox_max[axis])
            for axis in range(3)
        ]
        vertices.extend(VERTEX_RECORD.pack(quantized[0], quantized[1], quantized[2], 65_535, normal, feature_id))
    indices = bytearray()
    for index in chunk.indices:
        indices.extend(INDEX_RECORD.pack(index))
    header = CHUNK_HEADER.pack(
        CHUNK_MAGIC,
        3,
        len(chunk.vertices),
        len(chunk.indices),
        VERTEX_RECORD.size,
        *bbox_min,
        *bbox_max,
    )
    raw = header + vertices + indices
    chunk_id = prefix or hashlib.sha1(repr(chunk.key).encode("utf-8")).hexdigest()[:16]
    compressed_path = chunks_dir / f"{chunk_id}.bin.zst"
    _compress_zstd(raw, compressed_path)
    return {
        "id": chunk_id,
        "path": compressed_path.relative_to(chunks_dir.parents[1]).as_posix(),
        "compression": "zstd",
        "lod": chunk.lod,
        "layer_id": chunk.layer_id,
        "class": chunk.kind_class,
        "tile": list(chunk.tile),
        "bbox": {"min": bbox_min, "max": bbox_max},
        "vertex_count": len(chunk.vertices),
        "index_count": len(chunk.indices),
        "feature_count": len(chunk.feature_ids),
        "net_ids": sorted(chunk.net_ids),
        "raw_bytes": len(raw),
        "bytes": compressed_path.stat().st_size,
    }


def _write_instances(
    chunks_dir: Path,
    mesh_index: int,
    instances: list[tuple[list[float], int]],
) -> dict[str, Any]:
    records = bytearray()
    for matrix, feature_id in instances:
        records.extend(INSTANCE_RECORD.pack(*[float(value) for value in matrix], int(feature_id)))
    raw = INSTANCE_HEADER.pack(INSTANCE_MAGIC, 3, len(instances), INSTANCE_RECORD.size, 0) + records
    compressed_path = chunks_dir / f"component-{mesh_index:04d}-instances.bin.zst"
    _compress_zstd(raw, compressed_path)
    return {
        "path": compressed_path.relative_to(chunks_dir.parents[1]).as_posix(),
        "compression": "zstd",
        "count": len(instances),
        "record_stride": INSTANCE_RECORD.size,
        "raw_bytes": len(raw),
        "bytes": compressed_path.stat().st_size,
    }


def _compress_zstd(data: bytes, output_path: Path) -> None:
    executable = shutil.which("zstd")
    if not executable:
        raise RuntimeError("zstd is required to build semantic_scene_a3")
    proc = subprocess.run(
        [executable, "-q", "-f", "-5", "-T0", "-o", str(output_path)],
        input=data,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"zstd compression failed: {proc.stderr.decode('utf-8', errors='replace')}")


def _quantize(value: float, minimum: float, maximum: float) -> int:
    span = maximum - minimum
    if span <= 1e-15:
        return 0
    return max(0, min(65_535, int(round((value - minimum) / span * 65_535.0))))


def _identity() -> list[float]:
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def _matmul(a: list[float], b: list[float]) -> list[float]:
    out = [0.0] * 16
    for row in range(4):
        for col in range(4):
            for inner in range(4):
                out[col * 4 + row] += a[inner * 4 + row] * b[col * 4 + inner]
    return out


def _transform_point(matrix: list[float], point: list[float]) -> list[float]:
    x, y, z = [float(value) for value in point[:3]]
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


def _inverse_matrix(matrix: list[float]) -> list[float]:
    # Component roots are affine TRS matrices. Inverting the upper 3x3 and
    # translation avoids introducing a heavyweight matrix dependency.
    a, b, c = matrix[0], matrix[4], matrix[8]
    d, e, f = matrix[1], matrix[5], matrix[9]
    g, h, i = matrix[2], matrix[6], matrix[10]
    determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(determinant) < 1e-15:
        return _identity()
    inverse = 1.0 / determinant
    out = _identity()
    out[0] = (e * i - f * h) * inverse
    out[4] = (c * h - b * i) * inverse
    out[8] = (b * f - c * e) * inverse
    out[1] = (f * g - d * i) * inverse
    out[5] = (a * i - c * g) * inverse
    out[9] = (c * d - a * f) * inverse
    out[2] = (d * h - e * g) * inverse
    out[6] = (b * g - a * h) * inverse
    out[10] = (a * e - b * d) * inverse
    tx, ty, tz = matrix[12], matrix[13], matrix[14]
    out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz)
    out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz)
    out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz)
    return out
