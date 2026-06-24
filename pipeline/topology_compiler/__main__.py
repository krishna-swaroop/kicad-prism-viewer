from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .compiler import compile_topology
from .exporter import export_viewer_html
from .kicad_cli_export import export_project_geometry
from .pcb_geometry import extract_pad_holes
from .pcb_extract import extract_pcb_metadata
from .schematic_scene import build_schematic_scene
from .schematic_world import build_schematic_world
from .semantic_gltf import build_semantic_gltf_scene


def _write_outputs(topology: dict, output_dir: Path, semantic_geometry: dict | None = None) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    topology_path = output_dir / "topology.json"
    html_path = output_dir / "viewer.html"
    topology_export = dict(topology)
    topology_export["physical_objects"] = [
        {key: value for key, value in item.items() if key != "geometry"}
        for item in topology.get("physical_objects", [])
    ]
    topology_path.write_text(json.dumps(topology_export, indent=2), encoding="utf-8")
    if semantic_geometry:
        (output_dir / "semantic_geometry.json").write_text(json.dumps(semantic_geometry, indent=2), encoding="utf-8")
    export_viewer_html(
        topology_export,
        html_path,
        title=topology["design"].get("project", {}).get("filename", "KiCad 3D Viz"),
        semantic_geometry=semantic_geometry or {},
    )

def _discover_project_assets(project_file: Path) -> dict:
    root = project_file.parent
    design_outputs = root / "Design-Outputs"
    model_dir = design_outputs / "3DModel"
    glb = []
    step = []
    for base in [model_dir, root / "packages3D", root / "RemoteLibrary" / "remote_3d"]:
        if not base.exists():
            continue
        glb.extend(str(path.relative_to(root)) for path in base.rglob("*.glb"))
        step.extend(str(path.relative_to(root)) for path in base.rglob("*.step"))
        step.extend(str(path.relative_to(root)) for path in base.rglob("*.stp"))
    return {
        "project_root": str(root),
        "glb": sorted(set(glb)),
        "step": sorted(set(step)),
    }


def cmd_from_project(args: argparse.Namespace) -> None:
    project_file = args.project
    try:
        from kicad_monkey import KiCadDesign  # type: ignore

        design = KiCadDesign.from_project_file(project_file)
        design_payload = design.to_json(include_indexes=True)
        pcb_ir = design.to_pcb_ir()
        pad_holes = extract_pad_holes(design.pcb)
        pcb_metadata = extract_pcb_metadata(project_file)
    except Exception as exc:
        print(f"error: kicad_monkey failed to compile {project_file}: {exc}", file=sys.stderr)
        raise SystemExit(2)
    topology = compile_topology(design_payload, [], pcb_metadata, _discover_project_assets(project_file))
    try:
        semantic_geometry = export_project_geometry(
            project_file,
            topology,
            args.output,
            strict_components=args.strict_components,
        )
        semantic_geometry["semantic_gltf"] = build_semantic_gltf_scene(
            topology,
            semantic_geometry,
            pcb_ir,
            args.output,
            pad_holes=pad_holes,
        )
        semantic_geometry["assets"]["scene_manifest"] = "scene-gltf/scene.manifest.json"
        semantic_geometry["schematic_world"] = build_schematic_world(
            design,
            design_payload,
            args.output,
        )
        semantic_geometry["assets"]["schematic_manifest"] = semantic_geometry["schematic_world"]["path"]
        semantic_geometry["schematic_vector"] = build_schematic_scene(
            design,
            design_payload,
            args.output,
            topology=topology,
        )
        semantic_geometry["assets"]["schematic_native_manifest"] = semantic_geometry["schematic_vector"]["path"]
    except Exception as exc:
        print(f"error: semantic PCB geometry export failed for {project_file}: {exc}", file=sys.stderr)
        raise SystemExit(3)
    topology["design"].setdefault("assets", {})["semantic_geometry"] = "semantic_geometry.json"
    topology["design"]["assets"]["geometry_mode"] = "semantic-gltf"
    _write_outputs(topology, args.output, semantic_geometry)


def cmd_schematic_world(args: argparse.Namespace) -> None:
    project_file = args.project
    output_dir = args.output
    topology_path = output_dir / "topology.json"
    semantic_geometry_path = output_dir / "semantic_geometry.json"
    if not topology_path.exists() or not semantic_geometry_path.exists():
        print(
            f"error: {output_dir} must contain topology.json and semantic_geometry.json",
            file=sys.stderr,
        )
        raise SystemExit(2)
    topology = json.loads(topology_path.read_text(encoding="utf-8"))
    try:
        from kicad_monkey import KiCadDesign  # type: ignore

        design = KiCadDesign.from_project_file(project_file)
        design_payload = design.to_json(include_indexes=True)
        schematic_world = build_schematic_world(design, design_payload, output_dir)
        schematic_vector = build_schematic_scene(design, design_payload, output_dir, topology=topology)
    except Exception as exc:
        print(f"error: schematic world export failed for {project_file}: {exc}", file=sys.stderr)
        raise SystemExit(3)

    semantic_geometry = json.loads(semantic_geometry_path.read_text(encoding="utf-8"))
    semantic_geometry["schematic_world"] = schematic_world
    semantic_geometry["schematic_vector"] = schematic_vector
    semantic_geometry.setdefault("assets", {})["schematic_manifest"] = schematic_world["path"]
    semantic_geometry.setdefault("assets", {})["schematic_native_manifest"] = schematic_vector["path"]
    semantic_geometry_path.write_text(json.dumps(semantic_geometry, indent=2), encoding="utf-8")
    export_viewer_html(
        topology,
        output_dir / "viewer.html",
        title=topology.get("design", {}).get("project", {}).get("filename", "KiCad 3D Viz"),
        semantic_geometry=semantic_geometry,
    )


def main() -> None:
    parser = argparse.ArgumentParser(prog="topology_compiler")
    sub = parser.add_subparsers(required=True)

    from_project = sub.add_parser("from-project", help="Compile directly from a KiCad project")
    from_project.add_argument("project", type=Path)
    from_project.add_argument("--output", type=Path, required=True)
    from_project.add_argument("--strict-components", action="store_true", help="Fail if component model export cannot complete")
    from_project.set_defaults(func=cmd_from_project)

    schematic_world = sub.add_parser(
        "schematic-world",
        help="Add or refresh schematic-world assets in an existing visualizer bundle",
    )
    schematic_world.add_argument("project", type=Path)
    schematic_world.add_argument("--output", type=Path, required=True)
    schematic_world.set_defaults(func=cmd_schematic_world)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
