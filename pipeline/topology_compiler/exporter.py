from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path
from string import Template
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
VIEWER_ROOT = ROOT / "viewer"


def _read_viewer_sources() -> dict[str, str]:
    return {
        "styles": (VIEWER_ROOT / "styles.css").read_text(encoding="utf-8"),
        "gltf_loader": (VIEWER_ROOT / "semantic-gltf-loader.js").read_text(encoding="utf-8"),
        "app": (VIEWER_ROOT / "app.js").read_text(encoding="utf-8"),
    }


def export_viewer_html(
    topology: dict[str, Any],
    scene_bytes: bytes,
    output_path: Path,
    *,
    title: str = "KiCad 3D Viz",
    semantic_geometry: dict[str, Any] | None = None,
) -> None:
    sources = _read_viewer_sources()
    template = Template((VIEWER_ROOT / "viewer.template.html").read_text(encoding="utf-8"))
    embedded_topology = topology
    embedded_geometry = semantic_geometry or {}
    if semantic_geometry:
        embedded_topology = {
            "schema": topology.get("schema"),
            "design": topology.get("design", {}),
            "board": topology.get("board", {}),
        }
        embedded_geometry = {
            "schema": semantic_geometry.get("schema"),
            "packing_mode": semantic_geometry.get("packing_mode"),
            "connected_net_count": semantic_geometry.get("connected_net_count"),
            "assets": semantic_geometry.get("assets", {}),
            "semantic_scene": semantic_geometry.get("semantic_scene", {}),
        }
    html = template.safe_substitute(
        title=title,
        styles=sources["styles"],
        gltf_loader=sources["gltf_loader"],
        app=sources["app"],
        topology_json=json.dumps(embedded_topology, separators=(",", ":")),
        scene_base64=base64.b64encode(scene_bytes).decode("ascii"),
        semantic_geometry_json=json.dumps(embedded_geometry, separators=(",", ":")),
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding="utf-8")
    vendor_source = VIEWER_ROOT / "vendor" / "zstd"
    vendor_target = output_path.parent / "vendor" / "zstd"
    if vendor_source.exists():
        shutil.copytree(vendor_source, vendor_target, dirs_exist_ok=True)
