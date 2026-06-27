from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from pipeline.topology_compiler import compile_topology
from pipeline.topology_compiler.kicad_cli_export import (
    BOARD_CONTEXT_CACHE_VERSION,
    _board_context_export_args,
    _component_nodes,
)
from pipeline.topology_compiler.semantic_gltf import SemanticGltfBuilder


class TopologyCompilerTests(unittest.TestCase):
    def sample_design(self) -> dict:
        return {
            "schema": "kicad_monkey.design.a0",
            "project": {"filename": "unit.kicad_pro"},
            "components": [
                {"designator": "U1", "value": "MCU", "footprint": "QFN"},
                {"designator": "J1", "value": "USB", "footprint": "USB-C"},
            ],
            "nets": [
                {
                    "uid": "net_vbus",
                    "name": "VBUS",
                    "terminals": [
                        {"designator": "U1", "pin": "1", "svg_id": "u1_pin_1"},
                        {"designator": "J1", "pin": "A4", "svg_id": "j1_pin_a4"},
                    ],
                    "graphical": {"wires": ["wire_vbus"], "pins": ["u1_pin_1", "j1_pin_a4"]},
                }
            ],
        }

    def semantic_topology(self) -> dict:
        topology = compile_topology(self.sample_design())
        topology["board"] = {"thickness_mm": 1.6}
        topology["layers"] = [
            {"name": "Board", "role": "dielectric", "z_mm": 0.0, "thickness_mm": 1.6},
            {"name": "F.Cu", "role": "copper", "z_mm": 0.8, "thickness_mm": 0.035},
            {"name": "In1.Cu", "role": "copper", "z_mm": 0.2, "thickness_mm": 0.035},
            {"name": "B.Cu", "role": "copper", "z_mm": -0.8, "thickness_mm": 0.035},
        ]
        return topology

    def test_compile_topology_contract(self) -> None:
        topology = compile_topology(self.sample_design())
        self.assertEqual(topology["schema"], "prism.topology_model_a0")
        self.assertEqual(len(topology["components"]), 2)
        self.assertEqual(len(topology["nets"]), 1)
        self.assertEqual(len(topology["terminals"]), 2)
        self.assertEqual(topology["indexes"]["net_name_to_net"]["VBUS"], "net_vbus")

    def test_component_nodes_preserve_designator(self) -> None:
        gltf = {
            "asset": {"version": "2.0"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"children": [1]}, {"name": "U1", "children": [2]}, {"mesh": 0}],
            "meshes": [{"name": "Body", "primitives": []}],
        }
        payload = json.dumps(gltf).encode("utf-8")
        payload += b" " * ((4 - len(payload) % 4) % 4)
        total = 12 + 8 + len(payload)
        glb = b"glTF" + (2).to_bytes(4, "little") + total.to_bytes(4, "little")
        glb += len(payload).to_bytes(4, "little") + b"JSON" + payload
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "components.glb"
            path.write_bytes(glb)
            components = _component_nodes(path)
        self.assertEqual(components, [{"designator": "U1", "node_index": 1, "mesh_names": ["Body"]}])

    def test_board_context_export_excludes_duplicate_pad_geometry(self) -> None:
        args = _board_context_export_args(Path("geometry"), Path("unit.kicad_pcb"))
        self.assertIn("--include-soldermask", args)
        self.assertIn("--include-silkscreen", args)
        self.assertIn("--no-components", args)
        self.assertNotIn("--include-pads", args)
        self.assertIn("no-pads", BOARD_CONTEXT_CACHE_VERSION)

    def test_via_caps_and_barrel_share_one_source_feature(self) -> None:
        builder = SemanticGltfBuilder(self.semantic_topology())
        builder.add_pcb_ir(
            {
                "records": [
                    {
                        "uuid": "via-1",
                        "kind": "via",
                        "net_name": "VBUS",
                        "layers": ["F.Cu", "B.Cu"],
                        "drill": 0.3,
                        "operations": [
                            {
                                "kind": "FlashPadCircle",
                                "x": 10_000_000,
                                "y": 20_000_000,
                                "diameter_nm": 600_000,
                            }
                        ],
                    }
                ]
            }
        )
        via_objects = [item for item in builder.objects if item["kindId"] == 5]
        self.assertEqual(len(via_objects), 3)
        self.assertEqual(len({item["objectFeatureId"] for item in via_objects}), 1)
        barrel = builder.barrels[0]
        self.assertEqual(barrel["layerIds"], [2, 3, 4])
        self.assertEqual(barrel["startLayerId"], 2)
        self.assertEqual(barrel["endLayerId"], 4)
        self.assertEqual(barrel["netId"], 1)
        self.assertGreater(barrel["startZMm"], barrel["endZMm"])
        self.assertGreater(barrel["outerWidthMm"], barrel["drillWidthMm"])

    def test_plated_pad_barrel_uses_pad_feature_and_layer_mask(self) -> None:
        builder = SemanticGltfBuilder(self.semantic_topology())
        builder.add_pcb_ir(
            {
                "records": [
                    {
                        "kind": "footprint",
                        "placement": {"x_nm": 0, "y_nm": 0, "angle_deg": 0},
                        "operations": [
                            {
                                "kind": "StartBlock",
                                "data_ref": "pad",
                                "data_uuid": "pad-1",
                                "extra_attrs": {"net": "VBUS"},
                            },
                            {
                                "kind": "FlashPadCircle",
                                "x": 5_000_000,
                                "y": 6_000_000,
                                "diameter_nm": 900_000,
                                "layers": ["*.Cu"],
                            },
                            {"kind": "EndBlock"},
                        ],
                    }
                ]
            },
            pad_holes={
                "pad-1": {
                    "drill_mm": 0.4,
                    "drill_width_mm": 0.4,
                    "drill_height_mm": 0.4,
                    "plated": True,
                }
            },
        )
        barrel = builder.barrels[0]
        feature_id = barrel["objectFeatureId"]
        self.assertTrue(all(item["objectFeatureId"] == feature_id for item in builder.objects))
        self.assertEqual(barrel["layerMask"], 0b111)
        self.assertEqual(barrel["kind"], "plated_pad")

    def test_build_input_contains_coordinate_bounds_and_component_features(self) -> None:
        builder = SemanticGltfBuilder(self.semantic_topology())
        builder.add_component_nodes([{"designator": "U1", "node_index": 4, "mesh_names": ["Body"]}])
        builder.add_pcb_ir(
            {
                "records": [
                    {
                        "uuid": "track-1",
                        "kind": "segment",
                        "layer": "F.Cu",
                        "net_name": "VBUS",
                        "operations": [
                            {
                                "kind": "ThickSegment",
                                "start_x": 0,
                                "start_y": 0,
                                "end_x": 10_000_000,
                                "end_y": 0,
                                "width_nm": 250_000,
                            }
                        ],
                    }
                ]
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.json"
            payload = builder.write_input(path)
        self.assertEqual(payload["schema"], "prism.semantic_gltf_build_a0")
        self.assertEqual(payload["coordinateSystem"]["runtime"]["gltfToRuntime"], ["x", "-z", "y"])
        self.assertIsNotNone(payload["nets"][1]["boundsMm"])
        self.assertEqual(payload["components"][0]["nodeIndex"], 4)
        self.assertGreater(payload["components"][0]["featureId"], 0)


if __name__ == "__main__":
    unittest.main()
