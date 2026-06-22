import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("writes tiled GLB with net and object feature IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-gltf-"));
  const inputPath = path.join(root, "input.json");
  const outputDir = path.join(root, "scene");
  await fs.writeFile(
    inputPath,
    JSON.stringify({
      geometryRevision: "fixture",
      tileSizeMm: 20,
      layers: [{ id: 1, name: "F.Cu" }],
      nets: [{ id: 7, name: "VBUS", netClass: "Power" }],
      objectFeatures: [{ id: 11, sourceUid: "track-1", netId: 7 }],
      objects: [
        {
          layerId: 1,
          layerName: "F.Cu",
          zMm: 0.8,
          thicknessMm: 0.035,
          netId: 7,
          objectFeatureId: 11,
          polygons: [{ outer: [[0, 0], [25, 0], [25, 5], [0, 5]], holes: [] }],
        },
      ],
    }),
  );
  await run(process.execPath, [
    path.resolve("tools/semantic-gltf/build.mjs"),
    inputPath,
    outputDir,
  ]);
  const manifest = JSON.parse(
    await fs.readFile(path.join(outputDir, "scene.manifest.json"), "utf8"),
  );
  assert.equal(manifest.schema, "prism.semantic_gltf_a0");
  assert.equal(manifest.tiles.length, 2);
  assert.deepEqual(manifest.netToTiles["7"], ["1:0:0", "1:1:0"]);
  for (const tile of manifest.tiles) {
    const bytes = await fs.readFile(path.join(outputDir, tile.path));
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "glTF");
  }
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}
