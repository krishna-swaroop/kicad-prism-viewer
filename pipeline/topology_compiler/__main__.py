from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from .compiler import compile_topology, load_enriched_svg_metadata
from .exporter import export_viewer_html
from .kicad_cli_export import export_project_geometry
from .pcb_extract import extract_pcb_metadata
from .scene import build_scene_bundle
from .semantic_scene_a4 import build_semantic_scene_a4, extract_pad_holes


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_outputs(topology: dict, output_dir: Path, semantic_geometry: dict | None = None) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    topology_path = output_dir / "topology.json"
    scene_path = output_dir / "scene.bin"
    html_path = output_dir / "viewer.html"
    topology_export = dict(topology)
    topology_export["physical_objects"] = [
        {key: value for key, value in item.items() if key != "geometry"}
        for item in topology.get("physical_objects", [])
    ]
    topology_path.write_text(json.dumps(topology_export, indent=2), encoding="utf-8")
    if semantic_geometry:
        (output_dir / "semantic_geometry.json").write_text(json.dumps(semantic_geometry, indent=2), encoding="utf-8")
    scene_bytes = b"" if semantic_geometry else build_scene_bundle(topology)
    scene_path.write_bytes(scene_bytes)
    export_viewer_html(
        topology_export,
        scene_bytes,
        html_path,
        title=topology["design"].get("project", {}).get("filename", "KiCad 3D Viz"),
        semantic_geometry=semantic_geometry,
    )


def _sample_design() -> dict:
    return {
        "schema": "kicad_monkey.design.a0",
        "generator": "sample",
        "project": {"filename": "sample.kicad_pro"},
        "components": [
            {"designator": "U1", "value": "Controller", "footprint": "QFN-32", "parameters": {"MPN": "DEMO-U1"}},
            {"designator": "J1", "value": "USB-C", "footprint": "USB-C-Receptacle", "parameters": {}},
            {"designator": "R1", "value": "5.1k", "footprint": "R_0603", "parameters": {}},
            {"designator": "C1", "value": "100n", "footprint": "C_0603", "parameters": {}},
        ],
        "nets": [
            {
                "uid": "net_vbus",
                "name": "VBUS",
                "aliases": [],
                "terminals": [
                    {"designator": "J1", "pin": "A4"},
                    {"designator": "U1", "pin": "1"},
                ],
                "graphical": {"wires": ["svg_vbus_wire"], "pins": ["svg_j1_a4", "svg_u1_1"]},
            },
            {
                "uid": "net_gnd",
                "name": "GND",
                "aliases": [],
                "terminals": [
                    {"designator": "J1", "pin": "A1"},
                    {"designator": "C1", "pin": "2"},
                ],
                "graphical": {"wires": ["svg_gnd_wire"], "pins": ["svg_j1_a1", "svg_c1_2"]},
            },
        ],
    }


def cmd_sample(args: argparse.Namespace) -> None:
    topology = compile_topology(_sample_design())
    _write_outputs(topology, args.output)


def cmd_from_design(args: argparse.Namespace) -> None:
    schematic_metadata = [
        meta
        for path in args.schematic_svg
        if (meta := load_enriched_svg_metadata(path)) is not None
    ]
    pcb_metadata = load_enriched_svg_metadata(args.pcb_svg) if args.pcb_svg else None
    topology = compile_topology(_load_json(args.design_json), schematic_metadata, pcb_metadata)
    _write_outputs(topology, args.output)


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
    semantic_geometry = None
    if not args.no_kicad_cli_geometry:
        try:
            semantic_geometry = export_project_geometry(
                project_file,
                topology,
                args.output,
                strict_components=args.strict_components,
            )
            semantic_geometry["semantic_scene"] = build_semantic_scene_a4(
                topology,
                semantic_geometry,
                pcb_ir,
                args.output,
                pad_holes=pad_holes,
            )
            semantic_geometry["assets"]["scene_manifest"] = "scene/scene.manifest.json"
            (args.output / "semantic_scene.bin").unlink(missing_ok=True)
            if not args.debug_assets:
                shutil.rmtree(args.output / "geometry", ignore_errors=True)
        except Exception as exc:
            print(f"error: semantic PCB geometry export failed for {project_file}: {exc}", file=sys.stderr)
            raise SystemExit(3)
        topology["design"].setdefault("assets", {})["semantic_geometry"] = "semantic_geometry.json"
        topology["design"]["assets"]["geometry_mode"] = "semantic-pcb-ir-geometer"
    _write_outputs(topology, args.output, semantic_geometry)


def main() -> None:
    parser = argparse.ArgumentParser(prog="topology_compiler")
    sub = parser.add_subparsers(required=True)

    sample = sub.add_parser("sample", help="Generate a synthetic sample bundle")
    sample.add_argument("--output", type=Path, required=True)
    sample.set_defaults(func=cmd_sample)

    from_design = sub.add_parser("from-design", help="Compile from design JSON and enriched SVG metadata")
    from_design.add_argument("--design-json", type=Path, required=True)
    from_design.add_argument("--schematic-svg", type=Path, action="append", default=[])
    from_design.add_argument("--pcb-svg", type=Path)
    from_design.add_argument("--output", type=Path, required=True)
    from_design.set_defaults(func=cmd_from_design)

    from_project = sub.add_parser("from-project", help="Compile directly from a KiCad project")
    from_project.add_argument("project", type=Path)
    from_project.add_argument("--output", type=Path, required=True)
    from_project.add_argument("--no-kicad-cli-geometry", action="store_true", help="Skip semantic PCB geometry and context GLB exports")
    from_project.add_argument("--strict-components", action="store_true", help="Fail if component model export cannot complete")
    from_project.add_argument("--debug-assets", action="store_true", help="Keep raw GLB build intermediates")
    from_project.set_defaults(func=cmd_from_project)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
