from __future__ import annotations

import hashlib
import json
import math
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

from .semantic_scene import KIND_IDS, _primitive_y_range, _read_glb_primitives
from .semantic_scene_a4 import (
    NM_TO_MM,
    _capsule,
    _circle,
    _clean_ring,
    _pad_rings,
    _point_nm,
    _sample_arc_op,
    _transform,
)


SCHEMA = "prism.semantic_gltf_a0"
TILE_SIZE_MM = 20.0


class SemanticGltfBuilder:
    def __init__(self, topology: dict[str, Any], base_board_glb: Path | None = None) -> None:
        self.topology = topology
        self.layers = []
        self.layer_by_name: dict[str, dict[str, Any]] = {}
        for index, layer in enumerate(topology.get("layers", []) or [], start=1):
            item = {**layer, "id": index}
            self.layers.append(item)
            self.layer_by_name[str(item.get("name") or "")] = item
        self.copper_layers = [
            layer
            for layer in self.layers
            if str(layer.get("role") or "") == "copper"
            or str(layer.get("name") or "").endswith(".Cu")
        ]
        self.copper_index = {
            str(layer.get("name") or ""): index
            for index, layer in enumerate(self.copper_layers)
        }
        self.net_id_by_name: dict[str, int] = {}
        self.nets = [{"id": 0, "uid": "", "name": "", "netClass": "", "metrics": {}}]
        for net in topology.get("nets", []) or []:
            name = str(net.get("name") or "")
            if not name:
                continue
            net_id = len(self.nets)
            self.net_id_by_name[name] = net_id
            self.nets.append(
                {
                    "id": net_id,
                    "uid": str(net.get("uid") or ""),
                    "name": name,
                    "netClass": str(net.get("net_class") or ""),
                    "metrics": {
                        "traceLengthMm": 0.0,
                        "layers": [],
                        "objectCounts": {},
                    },
                    "analysis": {},
                }
            )
        self.objects: list[dict[str, Any]] = []
        self.object_features = [
            {
                "id": 0,
                "sourceUid": "",
                "netId": 0,
                "layerId": 0,
                "kind": "none",
            }
        ]
        self.object_feature_by_key: dict[tuple[str, int, int, str], int] = {}
        self.net_layers: dict[int, set[str]] = defaultdict(set)
        self.net_kind_counts: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self.net_trace_length: dict[int, float] = defaultdict(float)
        self.board_y_min_mm: float | None = None
        self.board_y_max_mm: float | None = None
        self.board_thickness_mm = float(topology.get("board", {}).get("thickness_mm") or 0.0)
        if base_board_glb and base_board_glb.exists():
            self._read_board_y_range(base_board_glb)

    def _read_board_y_range(self, path: Path) -> None:
        ranges = [
            _primitive_y_range(primitive)
            for primitive in _read_glb_primitives(path)
            if "_pcb" in primitive.mesh_name.lower()
            and "_soldermask" not in primitive.mesh_name.lower()
        ]
        if ranges:
            self.board_y_min_mm = min(item[0] for item in ranges) * 1000.0
            self.board_y_max_mm = max(item[1] for item in ranges) * 1000.0

    def _runtime_z_mm(self, centered_z_mm: float) -> float:
        if (
            self.board_y_min_mm is None
            or self.board_y_max_mm is None
            or self.board_thickness_mm <= 0
        ):
            return centered_z_mm
        normalized = (centered_z_mm + self.board_thickness_mm / 2.0) / self.board_thickness_mm
        return self.board_y_min_mm + normalized * (self.board_y_max_mm - self.board_y_min_mm)

    def _layers_for(self, values: list[Any]) -> list[str]:
        names = [str(item) for item in values]
        if any(name in {"*.Cu", "F&B.Cu"} for name in names):
            return [str(layer["name"]) for layer in self.copper_layers]
        selected = [name for name in names if name in self.copper_index]
        if len(selected) == 2:
            low, high = sorted((self.copper_index[selected[0]], self.copper_index[selected[1]]))
            return [str(self.copper_layers[index]["name"]) for index in range(low, high + 1)]
        return selected

    def _feature_id(self, source_uid: str, net_id: int, layer_id: int, kind: str) -> int:
        key = (source_uid, net_id, layer_id, kind)
        existing = self.object_feature_by_key.get(key)
        if existing is not None:
            return existing
        feature_id = len(self.object_features)
        self.object_feature_by_key[key] = feature_id
        self.object_features.append(
            {
                "id": feature_id,
                "sourceUid": source_uid,
                "netId": net_id,
                "layerId": layer_id,
                "kind": kind,
            }
        )
        return feature_id

    def _append_polygon(
        self,
        *,
        source_uid: str,
        net_name: str,
        layer_name: str,
        kind: str,
        outer: list[tuple[float, float]],
        holes: list[list[tuple[float, float]]] | None = None,
    ) -> None:
        outer = _clean_ring(outer)
        holes = [_clean_ring(hole) for hole in holes or []]
        holes = [hole for hole in holes if len(hole) >= 3]
        layer = self.layer_by_name.get(layer_name)
        if len(outer) < 3 or not layer:
            return
        net_id = self.net_id_by_name.get(net_name, 0)
        layer_id = int(layer["id"])
        feature_id = self._feature_id(source_uid, net_id, layer_id, kind)
        z_mm = self._runtime_z_mm(float(layer.get("z_mm") or 0.0))
        self.objects.append(
            {
                "netId": net_id,
                "objectFeatureId": feature_id,
                "layerId": layer_id,
                "layerName": layer_name,
                "zMm": z_mm,
                "thicknessMm": float(layer.get("thickness_mm") or 0.035) or 0.035,
                "kindId": KIND_IDS.get(kind, KIND_IDS["unknown"]),
                "polygons": [
                    {
                        "outer": [[point[0], point[1]] for point in outer],
                        "holes": [
                            [[point[0], point[1]] for point in hole]
                            for hole in holes
                        ],
                    }
                ],
            }
        )
        if net_id:
            self.net_layers[net_id].add(layer_name)
            self.net_kind_counts[net_id][kind] += 1

    def add_pcb_ir(
        self,
        pcb_ir: Any,
        *,
        pad_holes: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        payload = pcb_ir.to_dict() if hasattr(pcb_ir, "to_dict") else pcb_ir
        pad_holes = pad_holes or {}
        for record in payload.get("records", []) or []:
            kind = str(record.get("kind") or "")
            if kind == "segment":
                self._add_track(record)
            elif kind in {"track_arc", "arc"}:
                self._add_arc(record)
            elif kind == "zone_fill":
                self._add_zone(record)
            elif kind == "via":
                self._add_via(record)
            elif kind == "footprint":
                self._add_pads(record, pad_holes)

    def _add_track(self, record: dict[str, Any]) -> None:
        layer = str(record.get("layer") or "")
        net_name = str(record.get("net_name") or "")
        source_uid = str(record.get("uuid") or "")
        for op in record.get("operations", []) or []:
            if op.get("kind") != "ThickSegment":
                continue
            start = _point_nm(op.get("start_x"), op.get("start_y"))
            end = _point_nm(op.get("end_x"), op.get("end_y"))
            width = float(op.get("width_nm") or 0) * NM_TO_MM
            if width <= 0:
                continue
            self._append_polygon(
                source_uid=source_uid,
                net_name=net_name,
                layer_name=layer,
                kind="track",
                outer=_capsule(start, end, width / 2.0),
            )
            self.net_trace_length[self.net_id_by_name.get(net_name, 0)] += math.dist(start, end)

    def _add_arc(self, record: dict[str, Any]) -> None:
        layer = str(record.get("layer") or "")
        net_name = str(record.get("net_name") or "")
        source_uid = str(record.get("uuid") or "")
        for op in record.get("operations", []) or []:
            if op.get("kind") not in {"ArcThreePoint", "ThickArc"}:
                continue
            path = _sample_arc_op(op)
            width = float(op.get("width_nm") or 0) * NM_TO_MM
            if width <= 0:
                continue
            for start, end in zip(path, path[1:]):
                self._append_polygon(
                    source_uid=source_uid,
                    net_name=net_name,
                    layer_name=layer,
                    kind="track_arc",
                    outer=_capsule(start, end, width / 2.0),
                )
                self.net_trace_length[self.net_id_by_name.get(net_name, 0)] += math.dist(start, end)

    def _add_zone(self, record: dict[str, Any]) -> None:
        operations = [op for op in record.get("operations", []) or [] if op.get("kind") == "PlotPoly"]
        fill_layers = [str(item) for item in record.get("fill_layers", []) or []]
        declared = [str(item) for item in record.get("layers", []) or []]
        if not operations:
            return
        if not fill_layers and len(declared) == 1:
            fill_layers = declared * len(operations)
        if len(fill_layers) != len(operations):
            raise ValueError(
                f"Zone {record.get('uuid') or '<unknown>'} has ambiguous fill-layer assignments"
            )
        for layer, op in zip(fill_layers, operations):
            self._append_polygon(
                source_uid=str(record.get("uuid") or ""),
                net_name=str(record.get("net_name") or ""),
                layer_name=layer,
                kind="zone",
                outer=[_point_nm(point[0], point[1]) for point in op.get("points", [])],
            )

    def _add_via(self, record: dict[str, Any]) -> None:
        aperture = next(
            (op for op in record.get("operations", []) or [] if op.get("kind") == "FlashPadCircle"),
            None,
        )
        layers = self._layers_for(record.get("layers", []) or [])
        if not aperture or not layers:
            return
        center = _point_nm(aperture.get("x"), aperture.get("y"))
        radius = float(aperture.get("diameter_nm") or 0) * NM_TO_MM / 2.0
        drill = float(record.get("drill") or 0.0)
        outer = _circle(center, radius)
        holes = [_circle(center, drill / 2.0)] if drill > 0 else []
        for layer in layers:
            self._append_polygon(
                source_uid=str(record.get("uuid") or ""),
                net_name=str(record.get("net_name") or ""),
                layer_name=layer,
                kind="via",
                outer=outer,
                holes=holes,
            )

    def _add_pads(
        self,
        record: dict[str, Any],
        pad_holes: dict[str, dict[str, Any]],
    ) -> None:
        placement = record.get("placement") or {}
        origin = _point_nm(placement.get("x_nm"), placement.get("y_nm"))
        angle = -float(placement.get("angle_deg") or 0.0)
        block: dict[str, Any] | None = None
        for op in record.get("operations", []) or []:
            if op.get("kind") == "StartBlock" and op.get("data_ref") == "pad":
                block = op
                continue
            if op.get("kind") == "EndBlock":
                block = None
                continue
            if block is None or not str(op.get("kind") or "").startswith("FlashPad"):
                continue
            attrs = block.get("extra_attrs") or {}
            source_uid = str(block.get("data_uuid") or block.get("label") or "")
            layers = self._layers_for(op.get("layers") or block.get("layers") or [])
            rings = [
                [_transform(point, origin, angle) for point in ring]
                for ring in _pad_rings(op)
            ]
            hole_info = pad_holes.get(source_uid) or {}
            drill = float(hole_info.get("drill_mm") or 0.0)
            center = _transform(_point_nm(op.get("x"), op.get("y")), origin, angle)
            holes = [_circle(center, drill / 2.0)] if drill > 0 else []
            for layer in layers:
                for ring in rings:
                    self._append_polygon(
                        source_uid=source_uid,
                        net_name=str(attrs.get("net") or ""),
                        layer_name=layer,
                        kind="pad",
                        outer=ring,
                        holes=holes,
                    )

    def write_input(self, path: Path, *, tile_size_mm: float = TILE_SIZE_MM) -> dict[str, Any]:
        for net in self.nets[1:]:
            net_id = int(net["id"])
            net["metrics"] = {
                "traceLengthMm": round(self.net_trace_length[net_id], 6),
                "layers": sorted(self.net_layers[net_id]),
                "objectCounts": dict(sorted(self.net_kind_counts[net_id].items())),
            }
        revision_source = json.dumps(
            {
                "layers": self.layers,
                "nets": self.nets,
                "objects": self.objects,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        payload = {
            "schema": "prism.semantic_gltf_build_a0",
            "tileSizeMm": tile_size_mm,
            "geometryRevision": hashlib.sha256(revision_source).hexdigest(),
            "layers": self.layers,
            "nets": self.nets,
            "objectFeatures": self.object_features,
            "objects": self.objects,
        }
        path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        return payload


def build_semantic_gltf_scene(
    topology: dict[str, Any],
    semantic_geometry: dict[str, Any],
    pcb_ir: Any,
    output_dir: Path,
    *,
    pad_holes: dict[str, dict[str, Any]] | None = None,
    tile_size_mm: float = TILE_SIZE_MM,
) -> dict[str, Any]:
    assets = semantic_geometry.get("assets", {})
    base_asset = str(assets.get("base_board_glb") or "")
    base_path = output_dir / base_asset if base_asset else None
    builder = SemanticGltfBuilder(topology, base_path)
    builder.add_pcb_ir(pcb_ir, pad_holes=pad_holes)
    scene_dir = output_dir / "scene-gltf"
    tool = Path(__file__).resolve().parents[2] / "tools" / "semantic-gltf" / "build.mjs"
    cache_dir = output_dir.parent / ".cache" / "semantic-gltf"
    cache_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        scratch_input = Path(tmp) / "semantic-gltf-input.json"
        payload = builder.write_input(scratch_input, tile_size_mm=tile_size_mm)
        input_path = cache_dir / f"{payload['geometryRevision']}.json"
        if not input_path.exists():
            input_path.write_bytes(scratch_input.read_bytes())
    proc = subprocess.run(
        ["node", str(tool), str(input_path), str(scene_dir)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Semantic GLB build failed: {proc.stderr or proc.stdout}")
    manifest_path = scene_dir / "scene.manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return {
        "schema": SCHEMA,
        "path": "scene-gltf/scene.manifest.json",
        "geometryRevision": payload["geometryRevision"],
        "tiles": len(manifest.get("tiles", [])),
        "bytes": sum(int(tile.get("bytes") or 0) for tile in manifest.get("tiles", [])),
    }
