from __future__ import annotations

import json
import struct
import tempfile
import unittest
from pathlib import Path

from pipeline.topology_compiler import compile_topology
from pipeline.topology_compiler.kicad_cli_export import _component_nodes, _pad_groups
from pipeline.topology_compiler.scene import build_scene_bundle, read_scene_bundle
from pipeline.topology_compiler.semantic_scene import (
    Primitive,
    _SemanticSceneBuilder,
    build_semantic_scene,
    read_semantic_scene_metadata,
)
from pipeline.topology_compiler.semantic_scene_a3 import (
    CHUNK_HEADER,
    FEATURE_HEADER,
    FEATURE_RECORD,
    SemanticSceneA3Builder,
)
from pipeline.topology_compiler.semantic_scene_a4 import OBJECT_HEADER, SemanticSceneA4Builder
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

    def test_compile_topology_contract(self) -> None:
        topology = compile_topology(self.sample_design())
        self.assertEqual(topology["schema"], "prism.topology_model_a0")
        self.assertEqual(len(topology["components"]), 2)
        self.assertEqual(len(topology["nets"]), 1)
        self.assertEqual(len(topology["terminals"]), 2)
        self.assertIn("net_name_to_net", topology["indexes"])
        self.assertEqual(topology["indexes"]["net_name_to_net"]["VBUS"], "net_vbus")

    def test_scene_bundle_round_trip(self) -> None:
        topology = compile_topology(self.sample_design())
        scene = build_scene_bundle(topology)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "scene.bin"
            path.write_bytes(scene)
            decoded = read_scene_bundle(path)
        self.assertEqual(decoded["metadata"]["schema"], "prism.scene_bundle_a0")
        self.assertGreater(decoded["metadata"]["vertex_count"], 0)
        self.assertEqual(len(decoded["vertices"]), decoded["metadata"]["vertex_count"])

    def test_xao_pad_group_maps_to_terminal(self) -> None:
        topology = compile_topology(self.sample_design())
        xao = """
<XAO>
  <groups count="1">
    <group name="Pad_F_U1_1_VBUS" dimension="face" count="1">
      <element index="42"/>
    </group>
  </groups>
</XAO>
"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pads.xao"
            path.write_text(xao, encoding="utf-8")
            groups = _pad_groups(path, topology)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["designator"], "U1")
        self.assertEqual(groups[0]["pin"], "1")
        self.assertEqual(groups[0]["net_uid"], "net_vbus")
        self.assertEqual(groups[0]["face_indexes"], [42])

    def test_component_nodes_preserve_designator(self) -> None:
        gltf = {
            "asset": {"version": "2.0"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [
                {"children": [1]},
                {"name": "U1", "children": [2]},
                {"mesh": 0},
            ],
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

    def test_semantic_scene_packs_net_geometry_with_topology_layer(self) -> None:
        topology = compile_topology(self.sample_design())
        topology["physical_objects"].append(
            {
                "uid": "obj_track_vbus",
                "kind": "track",
                "layer": "F.Cu",
                "net_uid": "net_vbus",
                "net_name": "VBUS",
                "bbox_mm": [9.0, 19.0, 12.0, 22.0],
                "source_ids": [],
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            chunk = root / "geometry" / "net_chunks" / "net_vbus.glb"
            chunk.parent.mkdir(parents=True)
            chunk.write_bytes(_triangle_glb())
            semantic_geometry = {"assets": {}, "net_chunks": [{"net_uid": "net_vbus", "path": "geometry/net_chunks/net_vbus.glb"}]}
            scene_bytes = build_semantic_scene(topology, semantic_geometry, root)
            path = root / "semantic_scene.bin"
            path.write_bytes(scene_bytes)
            metadata = read_semantic_scene_metadata(path)
        self.assertEqual(metadata["schema"], "prism.semantic_scene_a2")
        self.assertEqual(metadata["vertex_count"], 3)
        self.assertEqual(metadata["index_count"], 3)
        packed_object = metadata["objects"][1]
        self.assertEqual(packed_object[0], metadata["kinds"]["track"])
        self.assertEqual(metadata["nets"][packed_object[1]]["uid"], "net_vbus")
        self.assertEqual(metadata["layers"][packed_object[2]]["name"], "F.Cu")
        self.assertEqual(packed_object[3], "obj_track_vbus")

    def test_semantic_scene_uses_geometry_height_before_overlapping_topology(self) -> None:
        topology = compile_topology(self.sample_design())
        topology["physical_objects"].extend(
            [
                {
                    "uid": "obj_track_top",
                    "kind": "track",
                    "layer": "F.Cu",
                    "net_uid": "net_vbus",
                    "net_name": "VBUS",
                    "bbox_mm": [9.0, 19.0, 12.0, 22.0],
                    "source_ids": [],
                },
                {
                    "uid": "obj_track_bottom",
                    "kind": "track",
                    "layer": "B.Cu",
                    "net_uid": "net_vbus",
                    "net_name": "VBUS",
                    "bbox_mm": [9.0, 19.0, 12.0, 22.0],
                    "source_ids": [],
                },
            ]
        )
        builder = _SemanticSceneBuilder(topology)
        builder.board_y_min = 0.0
        builder.board_y_max = 0.0015

        top = _primitive_at_height(0.00152, "unit_copper")
        bottom = _primitive_at_height(-0.00002, "unit_copper")

        self.assertEqual(builder._classify_net_primitive(top, "net_vbus"), ("F.Cu", "track", "obj_track_top"))
        self.assertEqual(builder._classify_net_primitive(bottom, "net_vbus"), ("B.Cu", "track", "obj_track_bottom"))

    def test_through_pad_caps_remain_on_their_physical_copper_layers(self) -> None:
        topology = compile_topology(self.sample_design())
        topology["physical_objects"].append(
            {
                "uid": "obj_pad_through",
                "kind": "pad",
                "layer": "*.Cu",
                "net_uid": "net_vbus",
                "net_name": "VBUS",
                "bbox_mm": [9.0, 19.0, 12.0, 22.0],
                "source_ids": [],
            }
        )
        builder = _SemanticSceneBuilder(topology)
        builder.board_y_min = 0.0
        builder.board_y_max = 0.0015

        top = _primitive_at_height(0.00154, "unit_pad")
        bottom = _primitive_at_height(-0.00004, "unit_pad")
        barrel = Primitive(
            positions=[[0.010, -0.00004, 0.020], [0.011, 0.00154, 0.020], [0.010, 0.00154, 0.021]],
            normals=[[0.0, 1.0, 0.0]] * 3,
            indices=[0, 1, 2],
            mesh_name="unit_pad",
            node_name="unit_pad",
        )

        self.assertEqual(builder._classify_net_primitive(top, "net_vbus"), ("F.Cu", "pad", "obj_pad_through"))
        self.assertEqual(builder._classify_net_primitive(bottom, "net_vbus"), ("B.Cu", "pad", "obj_pad_through"))
        self.assertEqual(builder._classify_net_primitive(barrel, "net_vbus"), ("Through", "pad", "obj_pad_through"))

    def test_a3_feature_table_preserves_multilayer_pad_mask(self) -> None:
        topology = compile_topology(self.sample_design())
        topology["physical_objects"].append(
            {
                "uid": "obj_pad_through",
                "kind": "pad",
                "layer": "*.Cu",
                "layers": ["*.Cu"],
                "net_uid": "net_vbus",
                "net_name": "VBUS",
                "bbox_mm": [9.0, 19.0, 12.0, 22.0],
                "source_ids": [],
            }
        )
        builder = SemanticSceneA3Builder(topology)
        builder._append_primitive(
            _primitive_at_height(0.00152, "unit_pad"),
            net_uid="net_vbus",
            layer="F.Cu",
            kind="pad",
            label="VBUS",
            source_uid="obj_pad_through",
        )
        with tempfile.TemporaryDirectory() as tmp:
            metadata = builder.write(Path(tmp))
            manifest = json.loads((Path(tmp) / metadata["path"]).read_text(encoding="utf-8"))
            feature_bytes = (Path(tmp) / "scene" / "features.bin").read_bytes()
        self.assertEqual(manifest["schema"], "prism.semantic_scene_a3")
        self.assertEqual(len(manifest["chunks"]), 2)
        self.assertEqual(FEATURE_HEADER.unpack_from(feature_bytes)[0], b"P3DFEAT3")
        strings_length = FEATURE_HEADER.unpack_from(feature_bytes)[4]
        feature_offset = FEATURE_HEADER.size + strings_length + FEATURE_RECORD.size
        feature = FEATURE_RECORD.unpack_from(feature_bytes, feature_offset)
        self.assertEqual(feature[1], 1)
        self.assertEqual(feature[2], 0b11)
        self.assertEqual(feature[4], manifest["kinds"]["pad"])

    def test_a3_chunk_uses_quantized_vertices_and_uint16_indices(self) -> None:
        topology = compile_topology(self.sample_design())
        builder = SemanticSceneA3Builder(topology)
        builder._append_primitive(
            _primitive_at_height(0.00152, "unit_copper"),
            net_uid="net_vbus",
            layer="F.Cu",
            kind="track",
            label="VBUS",
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            metadata = builder.write(root)
            manifest = json.loads((root / metadata["path"]).read_text(encoding="utf-8"))
            compressed = root / manifest["chunks"][0]["path"]
            raw = root / "chunk.bin"
            import subprocess

            subprocess.run(["zstd", "-q", "-d", "-f", str(compressed), "-o", str(raw)], check=True)
            header = CHUNK_HEADER.unpack_from(raw.read_bytes())
        self.assertEqual(header[0], b"P3DCHNK3")
        self.assertEqual(header[2], 3)
        self.assertEqual(header[3], 3)
        self.assertEqual(header[4], 16)

    def test_a4_fuses_ir_copper_with_exact_net_and_source_index(self) -> None:
        topology = compile_topology(self.sample_design())
        builder = SemanticSceneA4Builder(topology)
        builder.add_pcb_ir(
            {
                "records": [
                    {
                        "uuid": "track-vbus",
                        "kind": "segment",
                        "object_id": "segment",
                        "layer": "F.Cu",
                        "net_id": 1,
                        "net_name": "VBUS",
                        "operations": [
                            {
                                "kind": "ThickSegment",
                                "start_x": 10_000_000,
                                "start_y": 20_000_000,
                                "end_x": 20_000_000,
                                "end_y": 20_000_000,
                                "width_nm": 500_000,
                            }
                        ],
                    }
                ]
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            metadata = builder.write(root)
            manifest = json.loads((root / metadata["path"]).read_text(encoding="utf-8"))
            feature_bytes = (root / "scene" / "visual_features.bin").read_bytes()
            object_bytes = (root / "scene" / "object_index.bin").read_bytes()
        self.assertEqual(manifest["schema"], "prism.semantic_scene_a4")
        self.assertEqual(manifest["ownership"], "pcb-ir-before-tessellation")
        self.assertEqual(FEATURE_HEADER.unpack_from(feature_bytes)[0], b"P3DVFEA4")
        self.assertEqual(OBJECT_HEADER.unpack_from(object_bytes)[0], b"P3DOBJX4")
        self.assertEqual(manifest["object_index"]["count"], 1)
        self.assertIn("1", manifest["net_to_chunks"])

    def test_a4_records_authoritative_empty_zone_fill(self) -> None:
        topology = compile_topology(self.sample_design())
        builder = SemanticSceneA4Builder(topology)
        builder.add_pcb_ir(
            {
                "records": [
                    {
                        "uuid": "zone-empty",
                        "kind": "zone_fill",
                        "object_id": "zone",
                        "layers": ["F.Cu"],
                        "fill_layers": [],
                        "net_name": "VBUS",
                        "operations": [],
                    },
                    {
                        "uuid": "track",
                        "kind": "segment",
                        "object_id": "segment",
                        "layer": "F.Cu",
                        "net_name": "VBUS",
                        "operations": [
                            {
                                "kind": "ThickSegment",
                                "start_x": 0,
                                "start_y": 0,
                                "end_x": 1_000_000,
                                "end_y": 0,
                                "width_nm": 100_000,
                            }
                        ],
                    },
                ]
            }
        )
        self.assertEqual(
            builder.empty_zone_fills,
            [{"uuid": "zone-empty", "layers": ["F.Cu"], "net_name": "VBUS"}],
        )

    def test_a4_pairs_each_saved_zone_polygon_with_its_fill_layer(self) -> None:
        topology = compile_topology(self.sample_design())
        builder = SemanticSceneA4Builder(topology)
        builder.add_pcb_ir(
            {
                "records": [
                    {
                        "uuid": "zone-two-layer",
                        "kind": "zone_fill",
                        "object_id": "zone",
                        "layers": ["F.Cu", "B.Cu"],
                        "fill_layers": ["F.Cu", "B.Cu"],
                        "net_name": "VBUS",
                        "operations": [
                            {
                                "kind": "PlotPoly",
                                "points": [[0, 0], [1_000_000, 0], [1_000_000, 1_000_000], [0, 1_000_000]],
                            },
                            {
                                "kind": "PlotPoly",
                                "points": [[2_000_000, 0], [3_000_000, 0], [3_000_000, 1_000_000], [2_000_000, 1_000_000]],
                            },
                        ],
                    }
                ]
            }
        )
        self.assertEqual(len(builder.object_shapes), 2)
        self.assertEqual({item.layer for item in builder.object_shapes}, {"F.Cu", "B.Cu"})

    def test_semantic_gltf_uses_id_indirection_and_net_metrics(self) -> None:
        topology = compile_topology(self.sample_design())
        builder = SemanticGltfBuilder(topology)
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
                                "width_nm": 500_000,
                            }
                        ],
                    }
                ]
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            payload = builder.write_input(Path(tmp) / "input.json")
        self.assertEqual(len(payload["objects"]), 1)
        self.assertEqual(payload["objects"][0]["netId"], 1)
        self.assertEqual(payload["objects"][0]["objectFeatureId"], 1)
        self.assertEqual(payload["nets"][1]["metrics"]["traceLengthMm"], 10.0)
        self.assertEqual(payload["nets"][1]["metrics"]["layers"], ["F.Cu"])


def _triangle_glb() -> bytes:
    positions = [
        0.010,
        0.0012,
        0.020,
        0.011,
        0.0012,
        0.020,
        0.010,
        0.0012,
        0.021,
    ]
    normals = [0.0, 1.0, 0.0] * 3
    indices = [0, 1, 2]
    pos_bytes = struct.pack("<9f", *positions)
    normal_bytes = struct.pack("<9f", *normals)
    index_bytes = struct.pack("<3H", *indices)
    bin_blob = pos_bytes + normal_bytes + index_bytes
    bin_blob += b"\x00" * ((4 - len(bin_blob) % 4) % 4)
    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "Net_VBUS", "mesh": 0}],
        "meshes": [
            {
                "name": "Copper_VBUS",
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "NORMAL": 1},
                        "indices": 2,
                        "mode": 4,
                    }
                ],
            }
        ],
        "buffers": [{"byteLength": len(bin_blob)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_bytes)},
            {"buffer": 0, "byteOffset": len(pos_bytes), "byteLength": len(normal_bytes)},
            {"buffer": 0, "byteOffset": len(pos_bytes) + len(normal_bytes), "byteLength": len(index_bytes)},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
            {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
    }
    json_blob = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_blob += b" " * ((4 - len(json_blob) % 4) % 4)
    total = 12 + 8 + len(json_blob) + 8 + len(bin_blob)
    return (
        b"glTF"
        + (2).to_bytes(4, "little")
        + total.to_bytes(4, "little")
        + len(json_blob).to_bytes(4, "little")
        + b"JSON"
        + json_blob
        + len(bin_blob).to_bytes(4, "little")
        + b"BIN\x00"
        + bin_blob
    )


def _primitive_at_height(height: float, mesh_name: str) -> Primitive:
    return Primitive(
        positions=[[0.010, height, 0.020], [0.011, height, 0.020], [0.010, height, 0.021]],
        normals=[[0.0, 1.0, 0.0]] * 3,
        indices=[0, 1, 2],
        mesh_name=mesh_name,
        node_name=mesh_name,
    )


if __name__ == "__main__":
    unittest.main()
