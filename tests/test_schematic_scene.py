from __future__ import annotations

import unittest

from pipeline.topology_compiler.schematic_scene import (
    _operation_to_primitive,
    stable_feature_key,
)


class FakeOperation:
    def __init__(self, payload):
        self.payload = payload

    def to_dict(self):
        return self.payload


class SchematicSceneSchemaTests(unittest.TestCase):
    def test_feature_key_is_instance_scoped(self):
        source_uuid = "6c5c5ef1-1559-49e2-a41a-c02fb7de5678"

        first = stable_feature_key("/root/channel_a", source_uuid, 0)
        second = stable_feature_key("/root/channel_b", source_uuid, 0)

        self.assertNotEqual(first, second)
        self.assertEqual(first, "/root/channel_a::6c5c5ef1-1559-49e2-a41a-c02fb7de5678::0")

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


if __name__ == "__main__":
    unittest.main()

