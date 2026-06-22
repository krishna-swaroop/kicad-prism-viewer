from __future__ import annotations

import json
import math
import os
import platform
import shutil
import struct
import subprocess
import tempfile
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .semantic_scene import KIND_IDS, Primitive, _SemanticSceneBuilder
from .semantic_scene_a3 import (
    FEATURE_HEADER,
    FEATURE_RECORD,
    SemanticSceneA3Builder,
)


SCHEMA = "prism.semantic_scene_a4"
FEATURE_MAGIC = b"P3DVFEA4"
OBJECT_MAGIC = b"P3DOBJX4"
OBJECT_HEADER = struct.Struct("<8sIIIIII")
OBJECT_RECORD = struct.Struct("<IIIIII4fII")
RING_RECORD = struct.Struct("<II")
POINT_RECORD = struct.Struct("<2f")
NM_TO_MM = 1e-6
MM_TO_M = 1e-3
COPPER_TILE_SIZE_MM = 20.0


@dataclass
class PlanarJob:
    net_name: str
    layer: str
    tile: tuple[int, int] | None = None
    clip_bounds: tuple[float, float, float, float] | None = None
    subjects: list[list[tuple[float, float]]] = field(default_factory=list)
    subtracts: list[list[tuple[float, float]]] = field(default_factory=list)
    strokes: dict[float, list[list[tuple[float, float]]]] = field(default_factory=lambda: defaultdict(list))
    source_uids: set[str] = field(default_factory=set)


@dataclass
class ObjectShape:
    source_uid: str
    net_name: str
    layer: str
    layer_mask: int
    kind: str
    component_designator: str
    rings: list[list[tuple[float, float]]]

    @property
    def bbox(self) -> list[float]:
        points = [point for ring in self.rings for point in ring]
        return [
            min(point[0] for point in points),
            min(point[1] for point in points),
            max(point[0] for point in points),
            max(point[1] for point in points),
        ]


class SemanticSceneA4Builder(SemanticSceneA3Builder):
    def __init__(self, topology: dict[str, Any]) -> None:
        super().__init__(topology)
        self.physical_layer_by_name = {
            str(item.get("name") or ""): item for item in topology.get("layers", [])
        }
        for layer in self.layers:
            physical = self.physical_layer_by_name.get(str(layer.get("name") or ""), {})
            layer["z_mm"] = float(physical.get("z_mm") or 0.0)
            layer["thickness_mm"] = float(physical.get("thickness_mm") or 0.0)
            if physical.get("material"):
                layer["material"] = str(physical["material"])
        self.object_shapes: list[ObjectShape] = []
        self.net_uid_by_name = {
            str(item.get("name") or ""): str(item.get("uid") or "")
            for item in topology.get("nets", [])
        }
        self.layer_by_name = {str(item.get("name") or ""): item for item in self.layers}
        self.layer_index_by_name = {
            str(layer.get("name") or ""): index for index, layer in enumerate(self.copper_layers)
        }
        self.board_thickness_mm = float(topology.get("board", {}).get("thickness_mm") or 0.0)
        self.empty_zone_fills: list[dict[str, Any]] = []
        self.tile_diagnostics: dict[str, Any] = {}

    def _set_board_y_range(self, primitives: list[Primitive]) -> None:
        _SemanticSceneBuilder._set_board_y_range(self, primitives)

    def _stackup_y_mm(self, z_mm: float) -> float:
        if (
            self.board_y_min is None
            or self.board_y_max is None
            or self.board_thickness_mm <= 0
        ):
            return z_mm
        board_min_mm = self.board_y_min * 1000.0
        board_max_mm = self.board_y_max * 1000.0
        normalized = (z_mm + self.board_thickness_mm / 2.0) / self.board_thickness_mm
        return board_min_mm + normalized * (board_max_mm - board_min_mm)

    def _layer_y_interval_mm(self, layer: dict[str, Any]) -> tuple[float, float]:
        z_mm = float(layer.get("z_mm") or 0.0)
        thickness_mm = float(layer.get("thickness_mm") or 0.035) or 0.035
        bottom = self._stackup_y_mm(z_mm - thickness_mm / 2.0)
        top = self._stackup_y_mm(z_mm + thickness_mm / 2.0)
        return min(bottom, top), max(bottom, top)

    def add_pcb_ir(
        self,
        pcb_ir: Any,
        *,
        pad_holes: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        payload = pcb_ir.to_dict() if hasattr(pcb_ir, "to_dict") else pcb_ir
        if not isinstance(payload, dict):
            raise TypeError("PCB IR must be a KiCadPlotterDocument or dictionary")
        jobs: dict[tuple[str, str], PlanarJob] = {}
        pad_holes = pad_holes or {}
        for record in payload.get("records", []) or []:
            kind = str(record.get("kind") or "")
            if kind == "segment":
                self._add_track(record, jobs)
            elif kind in {"track_arc", "arc"}:
                self._add_track_arc(record, jobs)
            elif kind == "zone_fill":
                self._add_zone(record, jobs)
            elif kind == "via":
                self._add_via(record, jobs)
            elif kind == "footprint":
                self._add_footprint_pads(record, jobs, pad_holes)
        if not jobs:
            raise ValueError("PCB IR did not contain semantic copper geometry")

        tiled_jobs = _tile_planar_jobs(
            [jobs[key] for key in sorted(jobs)],
            float(os.environ.get("PRISM_COPPER_TILE_SIZE_MM", COPPER_TILE_SIZE_MM)),
        )
        self.tile_diagnostics = {
            "tile_size_mm": float(os.environ.get("PRISM_COPPER_TILE_SIZE_MM", COPPER_TILE_SIZE_MM)),
            "job_count_before_tiling": len(jobs),
            "job_count_after_tiling": len(tiled_jobs),
            "tile_count": len({job.tile for job in tiled_jobs}),
        }
        jobs_by_tile: dict[tuple[int, int], list[PlanarJob]] = defaultdict(list)
        for job in tiled_jobs:
            if job.tile is None:
                raise ValueError("Tiled planar job is missing its tile identity")
            jobs_by_tile[job.tile].append(job)

        for tile in sorted(jobs_by_tile):
            tile_jobs = jobs_by_tile[tile]
            clip_bounds = tile_jobs[0].clip_bounds
            if clip_bounds is None:
                raise ValueError(f"Tile {tile} is missing clip bounds")
            solved = _solve_planar_jobs(
                tile_jobs,
                final_clip_rings=[_rectangle_ring(clip_bounds)],
                allow_empty=True,
            )
            for job, regions in zip(tile_jobs, solved):
                triangulations = _triangulate_regions(regions)
                self._append_solved_job(job, regions, triangulations)

    def _append_solved_job(
        self,
        job: PlanarJob,
        regions: list[dict[str, Any]],
        triangulations: list[list[int]],
    ) -> None:
        net_uid = self.net_uid_by_name.get(job.net_name, "")
        if job.net_name and not net_uid:
            raise ValueError(f"PCB IR net is absent from topology: {job.net_name!r}")
        layer = self.physical_layer_by_name.get(job.layer)
        if not layer:
            raise ValueError(f"PCB IR copper layer is absent from topology stackup: {job.layer!r}")
        y_bottom_mm, y_top_mm = self._layer_y_interval_mm(layer)
        for region, indices in zip(regions, triangulations):
            primitive = _extrude_region(region, indices, y_bottom_mm, y_top_mm)
            self._append_primitive(
                primitive,
                net_uid=net_uid,
                layer=job.layer,
                kind="track",
                label=job.net_name,
            )

    def _job(
        self,
        jobs: dict[tuple[str, str], PlanarJob],
        net_name: str,
        layer: str,
    ) -> PlanarJob:
        if layer not in self.layer_index_by_name:
            raise ValueError(f"Unsupported/non-copper PCB IR layer: {layer!r}")
        return jobs.setdefault((net_name, layer), PlanarJob(net_name, layer))

    def _add_track(self, record: dict[str, Any], jobs: dict[tuple[str, str], PlanarJob]) -> None:
        layer = str(record.get("layer") or "")
        net_name = str(record.get("net_name") or "")
        source_uid = str(record.get("uuid") or "")
        for op in record.get("operations", []) or []:
            if op.get("kind") != "ThickSegment":
                continue
            path = [
                _point_nm(op.get("start_x"), op.get("start_y")),
                _point_nm(op.get("end_x"), op.get("end_y")),
            ]
            width = float(op.get("width_nm") or 0) * NM_TO_MM
            if width <= 0:
                continue
            job = self._job(jobs, net_name, layer)
            job.strokes[width / 2.0].append(path)
            job.source_uids.add(source_uid)
            self._add_object(source_uid, net_name, [layer], "track", [_capsule(path[0], path[1], width / 2.0)])

    def _add_track_arc(self, record: dict[str, Any], jobs: dict[tuple[str, str], PlanarJob]) -> None:
        layer = str(record.get("layer") or "")
        net_name = str(record.get("net_name") or "")
        source_uid = str(record.get("uuid") or "")
        for op in record.get("operations", []) or []:
            if op.get("kind") not in {"ArcThreePoint", "ThickArc"}:
                continue
            width = float(op.get("width_nm") or 0) * NM_TO_MM
            path = _sample_arc_op(op)
            if width <= 0 or len(path) < 2:
                continue
            job = self._job(jobs, net_name, layer)
            job.strokes[width / 2.0].append(path)
            job.source_uids.add(source_uid)
            self._add_object(
                source_uid,
                net_name,
                [layer],
                "track_arc",
                [_capsule(start, end, width / 2.0) for start, end in zip(path, path[1:])],
            )

    def _add_zone(self, record: dict[str, Any], jobs: dict[tuple[str, str], PlanarJob]) -> None:
        operations = [op for op in record.get("operations", []) or [] if op.get("kind") == "PlotPoly"]
        fill_layers = [str(item) for item in record.get("fill_layers", []) or []]
        declared_layers = [str(item) for item in record.get("layers", []) or []]
        if not operations:
            if fill_layers:
                raise ValueError(
                    f"Zone {record.get('uuid') or '<unknown>'} declares {len(fill_layers)} "
                    "fill-layer assignments but contains no saved polygons"
                )
            self.empty_zone_fills.append(
                {
                    "uuid": str(record.get("uuid") or ""),
                    "layers": declared_layers,
                    "net_name": str(record.get("net_name") or ""),
                }
            )
            return
        if fill_layers and len(fill_layers) != len(operations):
            raise ValueError(
                f"Zone {record.get('uuid') or '<unknown>'} has {len(operations)} saved polygons "
                f"but {len(fill_layers)} fill-layer assignments"
            )
        net_name = str(record.get("net_name") or "")
        source_uid = str(record.get("uuid") or "")
        if not fill_layers:
            if len(declared_layers) != 1:
                raise ValueError(
                    f"Zone {source_uid or '<unknown>'} spans {declared_layers} without per-polygon fill_layers"
                )
            fill_layers = declared_layers * len(operations)
        for layer, op in zip(fill_layers, operations):
            ring = [_point_nm(point[0], point[1]) for point in op.get("points", [])]
            ring = _clean_ring(ring)
            if len(ring) < 3:
                continue
            job = self._job(jobs, net_name, layer)
            job.subjects.append(ring)
            job.source_uids.add(source_uid)
            self._add_object(source_uid, net_name, [layer], "zone", [ring])

    def _add_via(self, record: dict[str, Any], jobs: dict[tuple[str, str], PlanarJob]) -> None:
        net_name = str(record.get("net_name") or "")
        source_uid = str(record.get("uuid") or "")
        layers = self._expand_copper_layers(record.get("layers", []))
        aperture = next(
            (op for op in record.get("operations", []) or [] if op.get("kind") == "FlashPadCircle"),
            None,
        )
        if not aperture or not layers:
            return
        center = _point_nm(aperture.get("x"), aperture.get("y"))
        radius = float(aperture.get("diameter_nm") or 0) * NM_TO_MM / 2.0
        drill = float(record.get("drill") or 0.0)
        outer = _circle(center, radius)
        hole = _circle(center, drill / 2.0) if drill > 0 else []
        for layer in layers:
            job = self._job(jobs, net_name, layer)
            job.subjects.append(outer)
            if hole:
                job.subtracts.append(hole)
            job.source_uids.add(source_uid)
        self._add_object(source_uid, net_name, layers, "via", [outer, hole] if hole else [outer])
        if drill > 0:
            self._add_barrel(source_uid, net_name, layers, center, radius, drill / 2.0, "via")

    def _add_footprint_pads(
        self,
        record: dict[str, Any],
        jobs: dict[tuple[str, str], PlanarJob],
        pad_holes: dict[str, dict[str, Any]],
    ) -> None:
        placement = record.get("placement") or {}
        origin = _point_nm(placement.get("x_nm"), placement.get("y_nm"))
        angle = -float(placement.get("angle_deg") or 0.0)
        operations = record.get("operations", []) or []
        block: dict[str, Any] | None = None
        for op in operations:
            if op.get("kind") == "StartBlock" and op.get("data_ref") == "pad":
                block = op
                continue
            if op.get("kind") == "EndBlock":
                block = None
                continue
            if block is None or not str(op.get("kind") or "").startswith("FlashPad"):
                continue
            attrs = block.get("extra_attrs") or {}
            net_name = str(attrs.get("net") or "")
            source_uid = str(block.get("data_uuid") or block.get("label") or "")
            designator = str(attrs.get("component") or record.get("reference") or "")
            layers = self._expand_copper_layers(op.get("layers") or block.get("layers") or [])
            rings = _pad_rings(op)
            rings = [[_transform(point, origin, angle) for point in ring] for ring in rings]
            hole_info = pad_holes.get(source_uid) or {}
            drill = float(hole_info.get("drill_mm") or 0.0)
            hole = _circle(_transform(_point_nm(op.get("x"), op.get("y")), origin, angle), drill / 2.0) if drill else []
            for layer in layers:
                job = self._job(jobs, net_name, layer)
                job.subjects.extend(rings)
                if hole:
                    job.subtracts.append(hole)
                job.source_uids.add(source_uid)
            self._add_object(
                source_uid,
                net_name,
                layers,
                "pad",
                [*rings, *([hole] if hole else [])],
                designator,
            )
            if drill and layers:
                center = _transform(_point_nm(op.get("x"), op.get("y")), origin, angle)
                outer_radius = max(
                    float(op.get("diameter_nm") or 0) * NM_TO_MM / 2.0,
                    float(op.get("size_x_nm") or 0) * NM_TO_MM / 2.0,
                    float(op.get("size_y_nm") or 0) * NM_TO_MM / 2.0,
                )
                self._add_barrel(source_uid, net_name, layers, center, outer_radius, drill / 2.0, "pad", designator)

    def _expand_copper_layers(self, names: Iterable[Any]) -> list[str]:
        values = [str(item) for item in names]
        if any(item in {"*.Cu", "F&B.Cu"} for item in values):
            return [str(layer["name"]) for layer in self.copper_layers]
        selected = [item for item in values if item in self.layer_index_by_name]
        if len(selected) == 2:
            first = self.layer_index_by_name[selected[0]]
            last = self.layer_index_by_name[selected[1]]
            low, high = sorted((first, last))
            return [str(self.copper_layers[index]["name"]) for index in range(low, high + 1)]
        return selected

    def _add_object(
        self,
        source_uid: str,
        net_name: str,
        layers: list[str],
        kind: str,
        rings: list[list[tuple[float, float]]],
        designator: str = "",
    ) -> None:
        valid = [_clean_ring(ring) for ring in rings if len(_clean_ring(ring)) >= 3]
        if not source_uid or not valid:
            return
        layer_mask = self._mask_for_layers(layers)
        for layer in layers:
            self.object_shapes.append(
                ObjectShape(source_uid, net_name, layer, layer_mask, kind, designator, valid)
            )

    def _mask_for_layers(self, layers: list[str]) -> int:
        mask = 0
        for layer in layers:
            index = self.layer_index_by_name.get(layer)
            if index is not None and index < 32:
                mask |= 1 << index
        return mask

    def _add_barrel(
        self,
        source_uid: str,
        net_name: str,
        layers: list[str],
        center: tuple[float, float],
        outer_radius: float,
        inner_radius: float,
        kind: str,
        designator: str = "",
    ) -> None:
        if outer_radius <= inner_radius or not layers:
            return
        intervals = [self._layer_y_interval_mm(self.physical_layer_by_name[name]) for name in layers]
        y_bottom = min(interval[0] for interval in intervals)
        y_top = max(interval[1] for interval in intervals)
        primitive = _annular_barrel(center, outer_radius, inner_radius, y_bottom, y_top)
        feature_count = len(self.features)
        self._append_primitive(
            primitive,
            net_uid=self.net_uid_by_name.get(net_name, ""),
            layer=layers[0],
            kind=kind,
            label=net_name,
            source_uid=source_uid,
            component_designator=designator,
        )
        if len(self.features) > feature_count:
            self.features[-1]["layer_mask"] = self._mask_for_layers(layers)

    def write(self, output_dir: Path) -> dict[str, Any]:
        result = super().write(output_dir)
        scene_dir = output_dir / "scene"
        old_features = scene_dir / "features.bin"
        visual_features = scene_dir / "visual_features.bin"
        data = bytearray(old_features.read_bytes())
        data[:8] = FEATURE_MAGIC
        struct.pack_into("<I", data, 8, 4)
        visual_features.write_bytes(data)
        old_features.unlink()
        object_info = _write_object_index(
            scene_dir / "object_index.bin",
            self.object_shapes,
            self.net_id_by_uid,
            self.net_uid_by_name,
            self._layer_id,
        )
        manifest_path = scene_dir / "scene.manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.update(
            {
                "schema": SCHEMA,
                "version": 4,
                "features": {
                    **manifest["features"],
                    "path": "scene/visual_features.bin",
                    "bytes": visual_features.stat().st_size,
                },
                "object_index": object_info,
                "ownership": "pcb-ir-before-tessellation",
                "geometer": {"planar_union": True, "triangulation": True},
                "diagnostics": {
                    **manifest.get("diagnostics", {}),
                    "empty_zone_fills": self.empty_zone_fills,
                    "copper_tiling": self.tile_diagnostics,
                },
            }
        )
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
        return {
            **result,
            "schema": SCHEMA,
            "features": "scene/visual_features.bin",
            "object_index": "scene/object_index.bin",
        }


def build_semantic_scene_a4(
    topology: dict[str, Any],
    semantic_geometry: dict[str, Any],
    pcb_ir: Any,
    output_dir: Path,
    *,
    pad_holes: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    builder = SemanticSceneA4Builder(topology)
    base_asset = str(semantic_geometry.get("assets", {}).get("base_board_glb") or "")
    base_path = output_dir / base_asset
    if base_asset and base_path.exists():
        builder.add_base_context(base_path)
    builder.add_pcb_ir(pcb_ir, pad_holes=pad_holes)
    components_asset = str(semantic_geometry.get("assets", {}).get("components_glb") or "")
    components_path = output_dir / components_asset
    if components_asset and components_path.exists():
        builder.add_components(components_path)
    return builder.write(output_dir)


def extract_pad_holes(pcb: Any) -> dict[str, dict[str, Any]]:
    holes: dict[str, dict[str, Any]] = {}
    for footprint in getattr(pcb, "footprints", []) or []:
        for pad in getattr(footprint, "pads", []) or []:
            source_uid = str(getattr(pad, "uuid", "") or "")
            drill = float(getattr(pad, "drill", 0.0) or 0.0)
            if source_uid and drill > 0:
                holes[source_uid] = {
                    "drill_mm": drill,
                    "drill_width_mm": float(getattr(pad, "drill_width", 0.0) or drill),
                    "drill_height_mm": float(getattr(pad, "drill_height", 0.0) or drill),
                    "oval": bool(getattr(pad, "drill_oval", False)),
                }
    return holes


def _tile_planar_jobs(jobs: list[PlanarJob], tile_size_mm: float) -> list[PlanarJob]:
    if tile_size_mm <= 0:
        raise ValueError("Copper tile size must be positive")
    tiled: dict[tuple[str, str, int, int], PlanarJob] = {}

    def target(job: PlanarJob, tile: tuple[int, int]) -> PlanarJob:
        key = (job.net_name, job.layer, tile[0], tile[1])
        existing = tiled.get(key)
        if existing is None:
            existing = PlanarJob(
                job.net_name,
                job.layer,
                tile=tile,
                clip_bounds=(
                    tile[0] * tile_size_mm,
                    tile[1] * tile_size_mm,
                    (tile[0] + 1) * tile_size_mm,
                    (tile[1] + 1) * tile_size_mm,
                ),
            )
            existing.source_uids.update(job.source_uids)
            tiled[key] = existing
        return existing

    for job in jobs:
        for ring in job.subjects:
            for tile in _tiles_for_bounds(_points_bounds(ring), tile_size_mm):
                target(job, tile).subjects.append(ring)
        for ring in job.subtracts:
            for tile in _tiles_for_bounds(_points_bounds(ring), tile_size_mm):
                target(job, tile).subtracts.append(ring)
        for radius, paths in job.strokes.items():
            for path in paths:
                bounds = _expand_bounds(_points_bounds(path), radius)
                for tile in _tiles_for_bounds(bounds, tile_size_mm):
                    target(job, tile).strokes[radius].append(path)

    return sorted(
        (
            job
            for job in tiled.values()
            if job.subjects or any(job.strokes.values())
        ),
        key=lambda job: (
            job.tile or (0, 0),
            job.layer,
            job.net_name,
        ),
    )


def _points_bounds(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    return (
        min(point[0] for point in points),
        min(point[1] for point in points),
        max(point[0] for point in points),
        max(point[1] for point in points),
    )


def _expand_bounds(
    bounds: tuple[float, float, float, float],
    margin: float,
) -> tuple[float, float, float, float]:
    return (
        bounds[0] - margin,
        bounds[1] - margin,
        bounds[2] + margin,
        bounds[3] + margin,
    )


def _tiles_for_bounds(
    bounds: tuple[float, float, float, float],
    tile_size_mm: float,
) -> Iterable[tuple[int, int]]:
    epsilon = 1e-9
    min_x = math.floor(bounds[0] / tile_size_mm)
    min_y = math.floor(bounds[1] / tile_size_mm)
    max_x = math.floor((bounds[2] - epsilon) / tile_size_mm)
    max_y = math.floor((bounds[3] - epsilon) / tile_size_mm)
    for tile_y in range(min_y, max(min_y, max_y) + 1):
        for tile_x in range(min_x, max(min_x, max_x) + 1):
            yield tile_x, tile_y


def _rectangle_ring(
    bounds: tuple[float, float, float, float],
) -> list[tuple[float, float]]:
    min_x, min_y, max_x, max_y = bounds
    return [
        (min_x, min_y),
        (max_x, min_y),
        (max_x, max_y),
        (min_x, max_y),
    ]


def _solve_planar_jobs(
    jobs: list[PlanarJob],
    *,
    final_clip_rings: list[list[tuple[float, float]]] | None = None,
    allow_empty: bool = False,
) -> list[list[dict[str, Any]]]:
    request = _encode_solve_request(jobs, final_clip_rings=final_clip_rings or [])
    executable = _find_geometer()
    with tempfile.TemporaryDirectory() as tmp:
        request_path = Path(tmp) / "solve.request.bin"
        response_path = Path(tmp) / "solve.response.bin"
        request_path.write_bytes(request)
        proc = subprocess.run(
            [str(executable), "planar-batch-solve", str(request_path), str(response_path)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"Geometer planar solve failed: {proc.stderr or proc.stdout}")
        return _decode_solve_response(response_path.read_bytes(), jobs, allow_empty=allow_empty)


def _find_geometer() -> Path:
    configured = os.environ.get("GEOMETER")
    if configured and Path(configured).exists():
        return Path(configured)
    resolved = shutil.which("geometer")
    if resolved:
        return Path(resolved)
    root = Path(__file__).resolve().parents[2] / "references" / "geometer" / "dist" / "native"
    system = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(platform.system(), "")
    machine = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}.get(
        platform.machine(), platform.machine()
    )
    preferred = root / f"{system}-{machine}" / ("geometer.exe" if system == "windows" else "geometer")
    if preferred.exists():
        return preferred
    candidates = sorted(root.glob("*/geometer"))
    if candidates:
        return candidates[0]
    raise FileNotFoundError("Geometer executable not found. Set GEOMETER or build references/geometer.")


def _encode_solve_request(
    jobs: list[PlanarJob],
    *,
    final_clip_rings: list[list[tuple[float, float]]] | None = None,
) -> bytes:
    final_clip_rings = final_clip_rings or []
    output = bytearray(
        struct.pack(
            "<8sIIII3dIIII",
            b"GMPBRQ01",
            2,
            0,
            6,
            len(jobs),
            0.000001,
            2.0,
            0.005,
            0,
            len(final_clip_rings),
            0,
            0,
        )
    )
    for ring in final_clip_rings:
        _write_ring(output, ring)
    for job in jobs:
        flags = 1 << 2 if final_clip_rings else 0
        output.extend(
            struct.pack(
                "<IdIIII",
                flags,
                0.0,
                len(job.subjects),
                len(job.subtracts),
                len(job.strokes),
                0,
            )
        )
        for ring in job.subjects:
            _write_ring(output, ring)
        for ring in job.subtracts:
            _write_ring(output, ring)
        for radius, paths in sorted(job.strokes.items()):
            output.extend(struct.pack("<3dIIII", radius, 2.0, 0.005, 1, 0, len(paths), 0))
            for path in paths:
                _write_ring(output, path)
    return bytes(output)


def _decode_solve_response(
    data: bytes,
    jobs: list[PlanarJob],
    *,
    allow_empty: bool = False,
) -> list[list[dict[str, Any]]]:
    view = memoryview(data)
    magic, version, job_count, *_ = struct.unpack_from("<8sIIIIII", view, 0)
    if magic != b"GMPBRS01" or version != 2 or job_count != len(jobs):
        raise ValueError("Unexpected Geometer planar solve response")
    offset = struct.calcsize("<8sIIIIII")
    result = []
    for job in jobs:
        region_count, _ring_count, _point_count, _subjects, _area, *_rest = struct.unpack_from(
            "<IIIIdIIIIII", view, offset
        )
        offset += struct.calcsize("<IIIIdIIIIII")
        regions = []
        for _ in range(region_count):
            hole_count, _reserved = struct.unpack_from("<II", view, offset)
            offset += 8
            outline, offset = _read_ring(view, offset)
            holes = []
            for _hole in range(hole_count):
                ring, offset = _read_ring(view, offset)
                holes.append(ring)
            regions.append({"outline": outline, "holes": holes})
        if not allow_empty and not regions and job.net_name and (job.subjects or job.strokes):
            raise ValueError(
                f"Geometer produced no copper for net {job.net_name!r} on {job.layer}; "
                f"sources={sorted(job.source_uids)[:8]}"
            )
        result.append(regions)
    return result


def _triangulate_regions(regions: list[dict[str, Any]]) -> list[list[int]]:
    if not regions:
        return []
    batch_size = max(1, int(os.environ.get("PRISM_GEOMETER_TRIANGULATION_BATCH_SIZE", "256")))
    point_budget = max(
        1,
        int(os.environ.get("PRISM_GEOMETER_TRIANGULATION_POINT_BUDGET", "200000")),
    )
    result: list[list[int]] = []
    batch: list[dict[str, Any]] = []
    batch_start = 0
    batch_points = 0
    for index, region in enumerate(regions):
        region_points = len(region["outline"]) + sum(len(hole) for hole in region["holes"])
        if batch and (len(batch) >= batch_size or batch_points + region_points > point_budget):
            result.extend(_triangulate_region_batch(batch, batch_start))
            batch = []
            batch_start = index
            batch_points = 0
        batch.append(region)
        batch_points += region_points
    if batch:
        result.extend(_triangulate_region_batch(batch, batch_start))
    return result


def _triangulate_region_batch(
    regions: list[dict[str, Any]],
    region_offset: int,
) -> list[list[int]]:
    request = bytearray(struct.pack("<8sIIII", b"GMTRRQ01", 1, len(regions), 6, 0))
    for region in regions:
        request.extend(struct.pack("<II", len(region["outline"]), len(region["holes"])))
        for point in region["outline"]:
            request.extend(struct.pack("<2d", *point))
        for hole in region["holes"]:
            request.extend(struct.pack("<I", len(hole)))
            for point in hole:
                request.extend(struct.pack("<2d", *point))
    mode = os.environ.get("PRISM_GEOMETER_TRIANGULATOR", "native").lower()
    if mode not in {"node", "wasm"}:
        executable = _find_geometer()
        with tempfile.TemporaryDirectory() as tmp:
            request_path = Path(tmp) / "triangulate.request.bin"
            response_path = Path(tmp) / "triangulate.response.bin"
            request_path.write_bytes(request)
            timeout_seconds = max(
                1.0,
                float(os.environ.get("PRISM_GEOMETER_TRIANGULATION_TIMEOUT_SECONDS", "30")),
            )
            try:
                proc = subprocess.run(
                    [str(executable), "planar-triangulate", str(request_path), str(response_path)],
                    capture_output=True,
                    text=True,
                    timeout=timeout_seconds,
                )
            except subprocess.TimeoutExpired:
                if len(regions) > 1:
                    midpoint = len(regions) // 2
                    return [
                        *_triangulate_region_batch(regions[:midpoint], region_offset),
                        *_triangulate_region_batch(
                            regions[midpoint:],
                            region_offset + midpoint,
                        ),
                    ]
                point_count = len(regions[0]["outline"]) + sum(
                    len(hole) for hole in regions[0]["holes"]
                )
                raise RuntimeError(
                    "Geometer native triangulation timed out "
                    f"for region {region_offset} ({point_count} points, "
                    f"{len(regions[0]['holes'])} holes) after {timeout_seconds:g}s"
                ) from None
            if proc.returncode != 0:
                detail = (proc.stderr or proc.stdout or "").strip()
                if "Unknown command: planar-triangulate" in detail:
                    return _triangulate_region_batch_node(regions, region_offset, request)
                if len(regions) > 1:
                    midpoint = len(regions) // 2
                    return [
                        *_triangulate_region_batch(regions[:midpoint], region_offset),
                        *_triangulate_region_batch(
                            regions[midpoint:],
                            region_offset + midpoint,
                        ),
                    ]
                end = region_offset + len(regions) - 1
                detail = detail or "no diagnostic output"
                point_count = len(regions[0]["outline"]) + sum(
                    len(hole) for hole in regions[0]["holes"]
                )
                raise RuntimeError(
                    "Geometer native triangulation failed "
                    f"for region batch {region_offset}-{end} ({point_count} points) "
                    f"with exit code {proc.returncode}: {detail}"
                )
            return _decode_triangulation(response_path.read_bytes(), len(regions))
    return _triangulate_region_batch_node(regions, region_offset, request)


def _triangulate_region_batch_node(
    regions: list[dict[str, Any]],
    region_offset: int,
    request: bytes | bytearray,
) -> list[list[int]]:
    repo_root = Path(__file__).resolve().parents[2]
    helper = repo_root / "scripts" / "geometer_planar_triangulate.js"
    geometer_root = repo_root / "references" / "geometer"
    with tempfile.TemporaryDirectory() as tmp:
        request_path = Path(tmp) / "triangulate.request.bin"
        response_path = Path(tmp) / "triangulate.response.bin"
        request_path.write_bytes(request)
        proc = subprocess.run(
            ["node", str(helper), str(request_path), str(response_path), str(geometer_root)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            end = region_offset + len(regions) - 1
            detail = (proc.stderr or proc.stdout or "no diagnostic output").strip()
            raise RuntimeError(
                "Geometer triangulation failed "
                f"for region batch {region_offset}-{end} with exit code {proc.returncode}: {detail}"
            )
        return _decode_triangulation(response_path.read_bytes(), len(regions))


def _decode_triangulation(data: bytes, expected: int) -> list[list[int]]:
    view = memoryview(data)
    magic, version, count, _reserved = struct.unpack_from("<8sIII", view, 0)
    if magic != b"GMTRRS01" or version != 1 or count != expected:
        raise ValueError("Unexpected Geometer triangulation response")
    offset = struct.calcsize("<8sIII")
    result = []
    for _ in range(count):
        status, triangle_count = struct.unpack_from("<II", view, offset)
        offset += 8
        if status != 0:
            raise ValueError(f"Geometer triangulation region failed with status {status}")
        indices = list(struct.unpack_from(f"<{triangle_count * 3}I", view, offset))
        offset += triangle_count * 12
        result.append(indices)
    return result


def _write_ring(output: bytearray, ring: list[tuple[float, float]]) -> None:
    output.extend(struct.pack("<I", len(ring)))
    for point in ring:
        output.extend(struct.pack("<2d", *point))


def _read_ring(view: memoryview, offset: int) -> tuple[list[tuple[float, float]], int]:
    count = struct.unpack_from("<I", view, offset)[0]
    offset += 4
    ring = [struct.unpack_from("<2d", view, offset + index * 16) for index in range(count)]
    return [(float(x), float(y)) for x, y in ring], offset + count * 16


def _extrude_region(
    region: dict[str, Any],
    triangle_indices: list[int],
    y_bottom_mm: float,
    y_top_mm: float,
) -> Primitive:
    rings = [region["outline"], *region["holes"]]
    planar = [point for ring in rings for point in ring]
    top = y_top_mm * MM_TO_M
    bottom = y_bottom_mm * MM_TO_M
    positions: list[list[float]] = []
    normals: list[list[float]] = []
    indices: list[int] = []
    for point in planar:
        positions.append([point[0] * MM_TO_M, top, point[1] * MM_TO_M])
        normals.append([0.0, 1.0, 0.0])
    top_count = len(positions)
    for point in planar:
        positions.append([point[0] * MM_TO_M, bottom, point[1] * MM_TO_M])
        normals.append([0.0, -1.0, 0.0])
    indices.extend(triangle_indices)
    for offset in range(0, len(triangle_indices), 3):
        a, b, c = triangle_indices[offset : offset + 3]
        indices.extend([top_count + c, top_count + b, top_count + a])
    ring_offset = 0
    for ring_index, ring in enumerate(rings):
        for index, point in enumerate(ring):
            next_index = (index + 1) % len(ring)
            a = ring_offset + index
            b = ring_offset + next_index
            pa, pb = point, ring[next_index]
            dx, dy = pb[0] - pa[0], pb[1] - pa[1]
            length = math.hypot(dx, dy) or 1.0
            sign = -1.0 if ring_index == 0 else 1.0
            normal = [sign * dy / length, 0.0, sign * -dx / length]
            base = len(positions)
            positions.extend(
                [
                    [pa[0] * MM_TO_M, top, pa[1] * MM_TO_M],
                    [pb[0] * MM_TO_M, top, pb[1] * MM_TO_M],
                    [pb[0] * MM_TO_M, bottom, pb[1] * MM_TO_M],
                    [pa[0] * MM_TO_M, bottom, pa[1] * MM_TO_M],
                ]
            )
            normals.extend([normal] * 4)
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])
        ring_offset += len(ring)
    return Primitive(
        positions=positions,
        normals=normals,
        indices=indices,
        mesh_name="semantic_copper",
        node_name="semantic_copper",
    )


def _annular_barrel(
    center: tuple[float, float],
    outer_radius: float,
    inner_radius: float,
    z_bottom_mm: float,
    z_top_mm: float,
    segments: int = 24,
) -> Primitive:
    positions: list[list[float]] = []
    normals: list[list[float]] = []
    indices: list[int] = []
    for radius, invert in ((outer_radius, False), (inner_radius, True)):
        base = len(positions)
        for index in range(segments):
            angle = math.tau * index / segments
            x, y = math.cos(angle), math.sin(angle)
            normal = [-x, 0.0, -y] if invert else [x, 0.0, y]
            positions.extend(
                [
                    [(center[0] + x * radius) * MM_TO_M, z_bottom_mm * MM_TO_M, (center[1] + y * radius) * MM_TO_M],
                    [(center[0] + x * radius) * MM_TO_M, z_top_mm * MM_TO_M, (center[1] + y * radius) * MM_TO_M],
                ]
            )
            normals.extend([normal, normal])
        for index in range(segments):
            next_index = (index + 1) % segments
            a, b = base + index * 2, base + next_index * 2
            if invert:
                indices.extend([a, b + 1, b, a, a + 1, b + 1])
            else:
                indices.extend([a, b, b + 1, a, b + 1, a + 1])
    return Primitive(
        positions=positions,
        normals=normals,
        indices=indices,
        mesh_name="semantic_barrel",
        node_name="semantic_barrel",
    )


def _write_object_index(
    path: Path,
    objects: list[ObjectShape],
    net_id_by_uid: dict[str, int],
    net_uid_by_name: dict[str, str],
    layer_id: Any,
) -> dict[str, Any]:
    strings = [""]
    string_ids = {"": 0}

    def string_id(value: str) -> int:
        if value not in string_ids:
            string_ids[value] = len(strings)
            strings.append(value)
        return string_ids[value]

    records = bytearray()
    ring_records = bytearray()
    points = bytearray()
    ring_count = 0
    point_count = 0
    for item in objects:
        first_ring = ring_count
        for ring in item.rings:
            ring_records.extend(RING_RECORD.pack(point_count, len(ring)))
            for point in ring:
                points.extend(POINT_RECORD.pack(*point))
            point_count += len(ring)
            ring_count += 1
        bbox = item.bbox
        records.extend(
            OBJECT_RECORD.pack(
                string_id(item.source_uid),
                net_id_by_uid.get(net_uid_by_name.get(item.net_name, ""), 0),
                int(layer_id(item.layer)),
                int(item.layer_mask),
                KIND_IDS.get(item.kind, 0),
                string_id(item.component_designator),
                *bbox,
                first_ring,
                len(item.rings),
            )
        )
    strings_bytes = json.dumps(strings, separators=(",", ":")).encode("utf-8")
    path.write_bytes(
        OBJECT_HEADER.pack(
            OBJECT_MAGIC,
            4,
            len(objects),
            OBJECT_RECORD.size,
            len(strings_bytes),
            ring_count,
            point_count,
        )
        + strings_bytes
        + records
        + ring_records
        + points
    )
    return {
        "path": path.relative_to(path.parents[1]).as_posix(),
        "count": len(objects),
        "record_stride": OBJECT_RECORD.size,
        "rings": ring_count,
        "points": point_count,
        "bytes": path.stat().st_size,
    }


def _point_nm(x: Any, y: Any) -> tuple[float, float]:
    return float(x or 0) * NM_TO_MM, float(y or 0) * NM_TO_MM


def _transform(
    point: tuple[float, float],
    origin: tuple[float, float],
    angle_deg: float,
) -> tuple[float, float]:
    angle = math.radians(angle_deg)
    cosine, sine = math.cos(angle), math.sin(angle)
    return (
        origin[0] + point[0] * cosine - point[1] * sine,
        origin[1] + point[0] * sine + point[1] * cosine,
    )


def _clean_ring(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    output = []
    for point in ring:
        if not output or math.hypot(point[0] - output[-1][0], point[1] - output[-1][1]) > 1e-9:
            output.append(point)
    if len(output) > 1 and math.hypot(output[0][0] - output[-1][0], output[0][1] - output[-1][1]) <= 1e-9:
        output.pop()
    return output


def _circle(center: tuple[float, float], radius: float, segments: int = 32) -> list[tuple[float, float]]:
    return [
        (center[0] + math.cos(math.tau * index / segments) * radius,
         center[1] + math.sin(math.tau * index / segments) * radius)
        for index in range(segments)
    ]


def _capsule(
    start: tuple[float, float],
    end: tuple[float, float],
    radius: float,
    segments: int = 12,
) -> list[tuple[float, float]]:
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    return [
        (
            end[0] + math.cos(angle - math.pi / 2 + math.pi * index / segments) * radius,
            end[1] + math.sin(angle - math.pi / 2 + math.pi * index / segments) * radius,
        )
        for index in range(segments + 1)
    ] + [
        (
            start[0] + math.cos(angle + math.pi / 2 + math.pi * index / segments) * radius,
            start[1] + math.sin(angle + math.pi / 2 + math.pi * index / segments) * radius,
        )
        for index in range(segments + 1)
    ]


def _sample_arc_op(op: dict[str, Any]) -> list[tuple[float, float]]:
    if all(key in op for key in ("start_x", "start_y", "mid_x", "mid_y", "end_x", "end_y")):
        start = _point_nm(op["start_x"], op["start_y"])
        mid = _point_nm(op["mid_x"], op["mid_y"])
        end = _point_nm(op["end_x"], op["end_y"])
        return _sample_three_point_arc(start, mid, end)
    return []


def _sample_three_point_arc(
    start: tuple[float, float],
    mid: tuple[float, float],
    end: tuple[float, float],
) -> list[tuple[float, float]]:
    ax, ay = start
    bx, by = mid
    cx, cy = end
    denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(denominator) < 1e-12:
        return [start, end]
    ux = (
        (ax * ax + ay * ay) * (by - cy)
        + (bx * bx + by * by) * (cy - ay)
        + (cx * cx + cy * cy) * (ay - by)
    ) / denominator
    uy = (
        (ax * ax + ay * ay) * (cx - bx)
        + (bx * bx + by * by) * (ax - cx)
        + (cx * cx + cy * cy) * (bx - ax)
    ) / denominator
    start_angle = math.atan2(ay - uy, ax - ux)
    mid_angle = math.atan2(by - uy, bx - ux)
    end_angle = math.atan2(cy - uy, cx - ux)
    sweep = (end_angle - start_angle) % math.tau
    if not _angle_on_sweep(start_angle, sweep, mid_angle):
        sweep -= math.tau
    radius = math.hypot(ax - ux, ay - uy)
    count = max(4, min(128, math.ceil(abs(sweep) * radius / 0.05)))
    return [
        (ux + math.cos(start_angle + sweep * index / count) * radius,
         uy + math.sin(start_angle + sweep * index / count) * radius)
        for index in range(count + 1)
    ]


def _angle_on_sweep(start: float, sweep: float, angle: float) -> bool:
    return ((angle - start) % math.tau) <= sweep + 1e-9


def _pad_rings(op: dict[str, Any]) -> list[list[tuple[float, float]]]:
    kind = str(op.get("kind") or "")
    center = _point_nm(op.get("x"), op.get("y"))
    angle = float(op.get("orient_deg") or 0.0)
    sx = float(op.get("size_x_nm") or op.get("diameter_nm") or 0) * NM_TO_MM
    sy = float(op.get("size_y_nm") or op.get("diameter_nm") or 0) * NM_TO_MM
    if kind == "FlashPadCircle":
        return [_circle(center, sx / 2.0)]
    if kind == "FlashPadOval":
        if sx >= sy:
            delta = (sx - sy) / 2.0
            ring = _capsule((-delta, 0.0), (delta, 0.0), sy / 2.0)
        else:
            delta = (sy - sx) / 2.0
            ring = _capsule((0.0, -delta), (0.0, delta), sx / 2.0)
        return [[_transform(point, center, angle) for point in ring]]
    if kind == "FlashPadRoundRect":
        radius = float(op.get("corner_radius_nm") or 0) * NM_TO_MM
        ring = _rounded_rect(sx, sy, radius)
        return [[_transform(point, center, angle) for point in ring]]
    if kind == "FlashPadTrapez" and op.get("corners"):
        ring = [_point_nm(point[0], point[1]) for point in op["corners"]]
        return [[_transform(point, center, angle) for point in ring]]
    if kind in {"FlashPadRect", "FlashPadTrapez"}:
        ring = [(-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2)]
        return [[_transform(point, center, angle) for point in ring]]
    if kind == "FlashPadCustom":
        polygons = op.get("polygons") or op.get("polygon") or []
        if polygons and isinstance(polygons[0], (int, float)):
            polygons = [polygons]
        return [
            [_transform(_point_nm(point[0], point[1]), center, angle) for point in polygon]
            for polygon in polygons
            if polygon
        ]
    raise ValueError(f"Unsupported PCB IR pad operation: {kind}")


def _rounded_rect(width: float, height: float, radius: float, segments: int = 6) -> list[tuple[float, float]]:
    radius = min(max(0.0, radius), width / 2.0, height / 2.0)
    if radius <= 0:
        return [(-width / 2, -height / 2), (width / 2, -height / 2), (width / 2, height / 2), (-width / 2, height / 2)]
    points = []
    for cx, cy, start in (
        (width / 2 - radius, -height / 2 + radius, -math.pi / 2),
        (width / 2 - radius, height / 2 - radius, 0),
        (-width / 2 + radius, height / 2 - radius, math.pi / 2),
        (-width / 2 + radius, -height / 2 + radius, math.pi),
    ):
        points.extend(
            (cx + math.cos(start + math.pi / 2 * index / segments) * radius,
             cy + math.sin(start + math.pi / 2 * index / segments) * radius)
            for index in range(segments + 1)
        )
    return points
