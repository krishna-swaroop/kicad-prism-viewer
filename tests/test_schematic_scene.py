from __future__ import annotations

import unittest

from pipeline.topology_compiler.schematic_scene import (
    SCHEMA,
    _operation_to_primitive,
    _operation_descriptors,
    _pin_lookup_indexes,
    _polyline_bounds,
    _page_chunks,
    _symbol_owner_features,
    deterministic_feature_ids,
    stable_feature_key,
)


class FakeOperation:
    def __init__(self, payload):
        self.payload = payload

    def to_dict(self):
        return self.payload


class FakeRecord:
    kind = "wire"
    uuid = "wire-uuid"
    object_id = ""
    extras = {}

    def __init__(self, operations):
        self.operations = operations


class FakeSymbolRecord:
    kind = "symbol_instance"
    uuid = "symbol-uuid"
    object_id = "Device:R"

    def __init__(self, operations, extras=None):
        self.operations = operations
        self.extras = extras or {
            "reference": "R1",
            "value": "10k",
            "lib_id": "Device:R",
            "unit": 1,
            "convert": 1,
            "at_angle_deg": 90,
            "mirror": "x",
        }


class SchematicSceneSchemaTests(unittest.TestCase):
    def test_feature_key_is_instance_scoped(self):
        source_uuid = "6c5c5ef1-1559-49e2-a41a-c02fb7de5678"

        first = stable_feature_key("/root/channel_a", source_uuid, 1, "wire", 0)
        second = stable_feature_key("/root/channel_b", source_uuid, 1, "wire", 0)

        self.assertNotEqual(first, second)
        self.assertEqual(
            first,
            "/root/channel_a | 6c5c5ef1-1559-49e2-a41a-c02fb7de5678 | 1 | wire | 0",
        )

    def test_schema_is_vector_a0(self):
        self.assertEqual(SCHEMA, "prism.schematic_vector_a0")

    def test_feature_ids_are_sorted_and_reserve_zero(self):
        ids = deterministic_feature_ids({"z-key", "a-key", "m-key"})

        self.assertEqual(ids, {"a-key": 1, "m-key": 2, "z-key": 3})
        self.assertNotIn(0, ids.values())

    def test_operation_primitive_converts_nm_to_mm(self):
        primitive, unsupported = _operation_to_primitive(
            FakeOperation(
                {
                    "kind": "Line",
                    "x1": 1_000_000,
                    "y1": 2_000_000,
                    "x2": 4_000_000,
                    "y2": 6_000_000,
                    "width_nm": 150_000,
                }
            ),
            feature_id=42,
        )

        self.assertIsNone(unsupported)
        self.assertEqual(primitive["featureId"], 42)
        self.assertEqual(primitive["kind"], "line")
        self.assertEqual(primitive["x1Mm"], 1.0)
        self.assertEqual(primitive["y2Mm"], 6.0)
        self.assertEqual(primitive["widthMm"], 0.15)

    def test_operation_without_geometry_is_reported(self):
        primitive, unsupported = _operation_to_primitive(FakeOperation({"kind": "Unsupported"}), 7)

        self.assertIsNone(primitive)
        self.assertEqual(unsupported, "Unsupported")

    def test_render_block_markers_are_ignored(self):
        primitive, unsupported = _operation_to_primitive(FakeOperation({"kind": "StartBlock"}), 7)

        self.assertIsNone(primitive)
        self.assertIsNone(unsupported)

    def _text_primitive(self, **overrides):
        payload = {
            "kind": "Text",
            "text": "R1",
            "x": 10_000_000,
            "y": 20_000_000,
            "size_x_nm": 1_270_000,
            "size_y_nm": 1_270_000,
            "h_align": "left",
            "v_align": "bottom",
        }
        payload.update(overrides)
        primitive, unsupported = _operation_to_primitive(FakeOperation(payload), 7)
        self.assertIsNone(unsupported)
        self.assertEqual(primitive["featureId"], 7)
        self.assertEqual(primitive["kind"], "text_strokes")
        self.assertEqual(primitive["provider"], "newstroke")
        self.assertEqual(primitive["style"]["provider"], "newstroke")
        self.assertGreater(len(primitive["polylinesMm"]), 0)
        return primitive

    def test_uncached_text_uses_newstroke_provider(self):
        primitive, unsupported = _operation_to_primitive(
            FakeOperation({"kind": "Text", "text": "R1", "x": 0, "y": 0}),
            7,
        )

        self.assertIsNone(unsupported)
        self.assertEqual(primitive["provider"], "newstroke")
        self.assertGreater(primitive["widthMm"], 0)
        self.assertEqual(primitive["text"], "R1")

    def test_render_cache_text_is_preferred_over_newstroke(self):
        primitive, unsupported = _operation_to_primitive(
            FakeOperation(
                {
                    "kind": "Text",
                    "text": "R1",
                    "render_cache_polygons": [
                        [[0, 0], [1_000_000, 0], [1_000_000, 1_000_000]],
                    ],
                }
            ),
            7,
        )

        self.assertIsNone(unsupported)
        self.assertEqual(primitive["kind"], "text_contours")
        self.assertEqual(primitive["provider"], "render_cache")
        self.assertNotIn("polylinesMm", primitive)

    def test_newstroke_accepts_kicad_alignment_enum_values(self):
        primitive = self._text_primitive(
            h_align="GR_TEXT_H_ALIGN_CENTER",
            v_align="GR_TEXT_V_ALIGN_TOP",
        )

        self.assertEqual(primitive["style"]["hAlign"], "center")
        self.assertEqual(primitive["style"]["vAlign"], "top")

    def test_newstroke_horizontal_alignment_affects_bounds(self):
        left = self._text_primitive(h_align="left")
        center = self._text_primitive(h_align="center")
        right = self._text_primitive(h_align="right")

        left_bounds = _polyline_bounds(left["polylinesMm"])
        center_bounds = _polyline_bounds(center["polylinesMm"])
        right_bounds = _polyline_bounds(right["polylinesMm"])

        self.assertGreater(left_bounds[0], center_bounds[0])
        self.assertGreater(center_bounds[0], right_bounds[0])

    def test_newstroke_vertical_alignment_affects_bounds(self):
        top = self._text_primitive(v_align="top")
        center = self._text_primitive(v_align="center")
        bottom = self._text_primitive(v_align="bottom")

        top_bounds = _polyline_bounds(top["polylinesMm"])
        center_bounds = _polyline_bounds(center["polylinesMm"])
        bottom_bounds = _polyline_bounds(bottom["polylinesMm"])

        self.assertGreater(top_bounds[1], center_bounds[1])
        self.assertGreater(center_bounds[1], bottom_bounds[1])

    def test_newstroke_cardinal_rotations_emit_geometry(self):
        bounds_by_angle = {}
        for angle in (0, 90, 180, 270):
            primitive = self._text_primitive(orient_deg=angle)
            bounds_by_angle[angle] = _polyline_bounds(primitive["polylinesMm"])
            self.assertEqual(primitive["style"]["orientDeg"], angle)

        width_0 = bounds_by_angle[0][2] - bounds_by_angle[0][0]
        height_0 = bounds_by_angle[0][3] - bounds_by_angle[0][1]
        width_90 = bounds_by_angle[90][2] - bounds_by_angle[90][0]
        height_90 = bounds_by_angle[90][3] - bounds_by_angle[90][1]
        self.assertAlmostEqual(width_0, height_90, delta=0.12)
        self.assertAlmostEqual(height_0, width_90, delta=0.12)

    def test_newstroke_mirror_and_italic_are_recorded_and_change_geometry(self):
        normal = self._text_primitive(text="ABC")
        mirrored = self._text_primitive(text="ABC", mirror=True)
        italic = self._text_primitive(text="ABC", italic=True)

        self.assertTrue(mirrored["style"]["mirror"])
        self.assertTrue(italic["style"]["italic"])
        self.assertNotEqual(normal["polylinesMm"][0][0], mirrored["polylinesMm"][0][0])
        self.assertNotEqual(normal["polylinesMm"][0][0], italic["polylinesMm"][0][0])

    def test_newstroke_multiline_emits_multiple_lines(self):
        single = self._text_primitive(text="R1")
        multi = self._text_primitive(text="R1\nC2")

        self.assertGreater(len(multi["polylinesMm"]), len(single["polylinesMm"]))

    def test_text_feature_ids_are_deterministic(self):
        key = stable_feature_key("/root/repeated", "text-source", 3, "text", 0)
        ids = deterministic_feature_ids({key, "z"})

        primitive, unsupported = _operation_to_primitive(
            FakeOperation({"kind": "Text", "text": "CLK", "x": 0, "y": 0}),
            ids[key],
        )

        self.assertIsNone(unsupported)
        self.assertEqual(primitive["featureId"], ids[key])

    def test_newstroke_provider_parity_with_existing_svg_polyline_path(self):
        primitive = self._text_primitive(text="R1", x=0, y=0)

        from kicad_monkey.kicad_sch_svg_renderer import (  # type: ignore
            KiCadSvgRenderContext,
            KiCadSvgRenderOptions,
            svg_text_poly,
        )

        ctx = KiCadSvgRenderContext(
            options=KiCadSvgRenderOptions(text_polyline_per_segment=False)
        )
        svg = svg_text_poly(
            0,
            0,
            "R1",
            ctx=ctx,
            size_x_nm=1_270_000,
            size_y_nm=1_270_000,
            h_align="GR_TEXT_H_ALIGN_LEFT",
            v_align="GR_TEXT_V_ALIGN_BOTTOM",
        )

        self.assertEqual(svg.count("<polyline"), len(primitive["polylinesMm"]))

    def test_page_chunks_create_primitive_sub_features(self):
        page = {
            "id": "page-0001",
            "name": "Root",
            "sheetInstancePath": "/root",
            "sourceWidthMm": 100,
            "sourceHeightMm": 80,
        }
        feature = {
            "id": 12,
            "stableKey": "/root | wire-uuid | 0 | record | 0",
            "pageId": "page-0001",
            "sheetInstancePath": "/root",
            "sourceId": "wire-uuid",
            "uuid": "wire-uuid",
            "objectId": "",
            "kind": "wire",
            "boundsMm": [1, 2, 9, 2],
            "netUid": "net-1",
            "netName": "VCC",
        }
        record = FakeRecord(
            [
                FakeOperation(
                    {
                        "kind": "Line",
                        "x1": 1_000_000,
                        "y1": 2_000_000,
                        "x2": 9_000_000,
                        "y2": 2_000_000,
                        "width_nm": 150_000,
                    }
                )
            ]
        )

        _, _, lod2, unsupported, primitive_features = _page_chunks(
            page,
            [record],
            [feature],
            feature_id_by_key={
                "/root | wire-uuid | 1 | wire | 0": 50,
            },
        )

        self.assertEqual(unsupported, [])
        self.assertEqual(lod2["primitives"][0]["featureId"], 50)
        self.assertEqual(primitive_features[0]["parentFeatureId"], 12)
        self.assertEqual(primitive_features[0]["stableKey"], "/root | wire-uuid | 1 | wire | 0")
        self.assertEqual(primitive_features[0]["netUid"], "net-1")

    def test_symbol_owner_features_create_body_and_pin_records(self):
        page = {"id": "page-0001", "sheetInstancePath": "/root"}
        parent = {
            "id": 10,
            "stableKey": "/root | symbol-uuid | 0 | record | 0",
            "pageId": "page-0001",
            "sheetInstancePath": "/root",
            "sourceId": "symbol-uuid",
            "uuid": "symbol-uuid",
            "objectId": "Device:R",
            "kind": "symbol_instance",
            "reference": "R1",
            "value": "10k",
        }
        design_payload = {
            "components": [{"designator": "R1", "svg_id": "symbol-uuid", "value": "10k"}],
            "nets": [{
                "uid": "net-1",
                "name": "VCC",
                "terminals": [{"designator": "R1", "pin": "1", "pin_name": "A"}],
                "graphical": {"pins": [{"designator": "R1", "pin": "1", "svg_id": "pin-uuid"}]},
            }],
        }
        topology = {
            "components": [{"uid": "cmp-1", "designator": "R1", "value": "10k"}],
            "terminals": [{"uid": "term-1", "component_uid": "cmp-1", "pin": "1", "net_uid": "net-1", "pcb_pad_id": "pad-r1-1"}],
        }
        components = {"R1": {"componentUid": "cmp-1", "componentDesignator": "R1"}}
        pin_lookup = _pin_lookup_indexes(design_payload, topology, components)
        record = FakeSymbolRecord([
            FakeOperation({"kind": "PlotPoly", "points": [[0, 0], [1_000_000, 0], [1_000_000, 1_000_000]]}),
            FakeOperation({
                "kind": "StartBlock",
                "data_ref": "symbol_pin",
                "data_uuid": "pin-uuid",
                "extra_attrs": {"primitive": "pin", "object-type": "pin", "pin": "1", "designator": "R1", "symbol-uuid": "symbol-uuid"},
            }),
            FakeOperation({"kind": "Line", "x1": 0, "y1": 0, "x2": 2_000_000, "y2": 0}),
            FakeOperation({"kind": "Text", "text": "1", "x": 0, "y": 0}),
            FakeOperation({"kind": "Text", "text": "A", "x": 0, "y": 500_000}),
            FakeOperation({"kind": "EndBlock"}),
        ])

        owners = _symbol_owner_features(
            page["id"], page["sheetInstancePath"], record, 1, parent, pin_lookup, components
        )
        by_kind = {feature["kind"]: feature for feature in owners}

        self.assertEqual(by_kind["symbol_body"]["parentStableKey"], parent["stableKey"])
        self.assertEqual(by_kind["pin"]["netUid"], "net-1")
        self.assertEqual(by_kind["pin"]["pcbPadId"], "pad-r1-1")
        self.assertEqual(by_kind["pin"]["componentUid"], "cmp-1")

    def test_symbol_operation_descriptors_assign_pin_subfeatures(self):
        page = {"id": "page-0001", "sheetInstancePath": "/root", "sourceWidthMm": 50, "sourceHeightMm": 30}
        parent = {
            "id": 10,
            "stableKey": "/root | symbol-uuid | 0 | record | 0",
            "pageId": "page-0001",
            "sheetInstancePath": "/root",
            "sourceId": "symbol-uuid",
            "uuid": "symbol-uuid",
            "objectId": "Device:R",
            "kind": "symbol_instance",
            "reference": "R1",
            "value": "10k",
        }
        pin_lookup = {
            "bySvgId": {"pin-uuid": {"netUid": "net-1", "netName": "VCC", "pinName": "A"}},
            "byDesignatorPin": {("R1", "1"): {"netUid": "net-1", "netName": "VCC", "pinName": "A"}},
        }
        record = FakeSymbolRecord([
            FakeOperation({"kind": "Text", "text": "R1", "x": 0, "y": 0}),
            FakeOperation({"kind": "Text", "text": "10k", "x": 0, "y": 1_000_000}),
            FakeOperation({
                "kind": "StartBlock",
                "data_ref": "symbol_pin",
                "data_uuid": "pin-uuid",
                "extra_attrs": {"primitive": "pin", "object-type": "pin", "pin": "1", "designator": "R1", "symbol-uuid": "symbol-uuid"},
            }),
            FakeOperation({"kind": "Line", "x1": 0, "y1": 0, "x2": 2_000_000, "y2": 0}),
            FakeOperation({"kind": "Text", "text": "1", "x": 0, "y": 0}),
            FakeOperation({"kind": "Text", "text": "A", "x": 0, "y": 500_000}),
            FakeOperation({"kind": "EndBlock"}),
        ])

        descriptors = _operation_descriptors(page, record, 1, parent, pin_lookup, {"R1": {"componentUid": "cmp-1"}})
        roles = [descriptor["semanticRole"] for descriptor in descriptors]

        self.assertEqual(roles, ["symbol_reference", "symbol_value", "pin_body", "pin_number", "pin_name"])
        self.assertEqual(descriptors[2]["sourceId"], "pin-uuid")
        self.assertEqual(descriptors[2]["parentStableKey"], "/root | pin-uuid | 0 | pin | 0")
        self.assertEqual(descriptors[2]["metadata"]["netName"], "VCC")

    def test_repeated_hierarchy_symbol_and_pin_keys_are_instance_scoped(self):
        symbol_uuid = "same-symbol"
        pin_uuid = "same-pin"

        first_symbol = stable_feature_key("/root/channel_a", symbol_uuid, 0, "symbol_body", 0)
        second_symbol = stable_feature_key("/root/channel_b", symbol_uuid, 0, "symbol_body", 0)
        first_pin = stable_feature_key("/root/channel_a", pin_uuid, 0, "pin", 0)
        second_pin = stable_feature_key("/root/channel_b", pin_uuid, 0, "pin", 0)

        self.assertNotEqual(first_symbol, second_symbol)
        self.assertNotEqual(first_pin, second_pin)

    def test_page_chunks_preserve_pin_parent_and_net(self):
        page = {"id": "page-0001", "name": "Root", "sheetInstancePath": "/root", "sourceWidthMm": 50, "sourceHeightMm": 30}
        record_feature = {
            "id": 10,
            "stableKey": "/root | symbol-uuid | 0 | record | 0",
            "pageId": "page-0001",
            "sheetInstancePath": "/root",
            "sourceId": "symbol-uuid",
            "uuid": "symbol-uuid",
            "objectId": "Device:R",
            "kind": "symbol_instance",
            "reference": "R1",
            "value": "10k",
            "boundsMm": [0, 0, 8, 4],
        }
        pin_feature = {
            "id": 11,
            "stableKey": "/root | pin-uuid | 0 | pin | 0",
            "pageId": "page-0001",
            "sheetInstancePath": "/root",
            "sourceId": "pin-uuid",
            "uuid": "pin-uuid",
            "objectId": "pin-uuid",
            "kind": "pin",
            "reference": "R1",
            "pinNumber": "1",
            "netUid": "net-1",
            "netName": "VCC",
        }
        record = FakeSymbolRecord([
            FakeOperation({
                "kind": "StartBlock",
                "data_ref": "symbol_pin",
                "data_uuid": "pin-uuid",
                "extra_attrs": {"primitive": "pin", "object-type": "pin", "pin": "1", "designator": "R1", "symbol-uuid": "symbol-uuid"},
            }),
            FakeOperation({"kind": "Line", "x1": 0, "y1": 0, "x2": 2_000_000, "y2": 0, "width_nm": 150_000}),
            FakeOperation({"kind": "EndBlock"}),
        ])

        _, _, lod2, _, primitive_features = _page_chunks(
            page,
            [record],
            [record_feature, pin_feature],
            feature_id_by_key={"/root | pin-uuid | 2 | pin_body | 0": 42, "/root | pin-uuid | 0 | pin | 0": 11},
            pin_lookup={"bySvgId": {"pin-uuid": {"netUid": "net-1", "netName": "VCC"}}, "byDesignatorPin": {}},
        )

        self.assertEqual(lod2["primitives"][0]["featureId"], 11)
        self.assertEqual(primitive_features[0]["kind"], "pin")
        self.assertEqual(primitive_features[0]["parentFeatureId"], 11)
        self.assertEqual(primitive_features[0]["netUid"], "net-1")


if __name__ == "__main__":
    unittest.main()
