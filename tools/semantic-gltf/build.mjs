import fs from "node:fs/promises";
import path from "node:path";

import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import {
  EXTMeshFeatures,
  EXTMeshoptCompression,
  KHRMeshQuantization,
} from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import earcut, { flatten as flattenRings } from "earcut";
import { MeshoptEncoder } from "meshoptimizer";
import polygonClipping from "polygon-clipping";

const [inputPath, outputDir] = process.argv.slice(2);
if (!inputPath || !outputDir) {
  throw new Error("usage: node tools/semantic-gltf/build.mjs INPUT.json OUTPUT_DIR");
}

const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
const tileSize = Number(input.tileSizeMm || 20);
const meshoptLevel = normalizeMeshoptLevel(
  input.meshoptLevel || process.env.PRISM_SEMANTIC_GLTF_MESHOPT_LEVEL || "medium",
);
const startedAt = performance.now();
const tiles = new Map();
const objects = input.objects || [];
progress(`input objects=${objects.length} barrels=${(input.barrels || []).length} tileSizeMm=${tileSize} meshopt=${meshoptLevel}`);

let objectIndex = 0;
let polygonCount = 0;
let singleTilePolygonCount = 0;
let clippedTileCount = 0;
for (const object of objects) {
  objectIndex += 1;
  for (const polygon of object.polygons || []) {
    polygonCount += 1;
    const source = [[closeRing(polygon.outer), ...(polygon.holes || []).map(closeRing)]];
    const bounds = polygonBounds(polygon);
    const polygonTiles = tilesForBounds(bounds, tileSize);
    if (polygonTiles.length === 1) {
      singleTilePolygonCount += 1;
      appendTilePolygon(tiles, object, polygonTiles[0], source[0]);
      continue;
    }
    for (const tile of polygonTiles) {
      const clip = [[tileRing(tile, tileSize)]];
      const clipped = polygonClipping.intersection(source, clip);
      if (!clipped?.length) continue;
      clippedTileCount += 1;
      for (const clippedPolygon of clipped) {
        appendTilePolygon(tiles, object, tile, clippedPolygon);
      }
    }
  }
  if (objectIndex === objects.length || objectIndex % 1000 === 0) {
    progress(
      `clipped objects=${objectIndex}/${objects.length} polygons=${polygonCount} ` +
      `singleTile=${singleTilePolygonCount} clippedTiles=${clippedTileCount} tiles=${tiles.size}`,
    );
  }
}

await fs.mkdir(outputDir, { recursive: true });
await MeshoptEncoder.ready;
progress(`meshopt ready tiles=${tiles.size}`);
const io = new NodeIO()
  .registerExtensions([EXTMeshFeatures, EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
const manifest = {
  schema: "prism.semantic_gltf_a0",
  version: 0,
  tileSizeMm: tileSize,
  geometryRevision: input.geometryRevision,
  coordinateSystem: input.coordinateSystem,
  layers: input.layers || [],
  nets: input.nets || [],
  objectFeatures: input.objectFeatures || [],
  components: input.components || [],
  barrels: input.barrels || [],
  copperLayerIds: (input.layers || [])
    .filter((layer) => layer.role === "copper" || String(layer.name || "").endsWith(".Cu"))
    .map((layer) => Number(layer.id)),
  bbox: sceneBounds(input.objects || [], input.barrels || []),
  tiles: [],
  netToTiles: {},
  analysis: {
    featureKey: "objectFeatureId",
    netKey: "netId",
    resultBinding: "geometryRevision + objectFeatureId",
  },
};

const sortedTiles = [...tiles.values()].sort(compareTiles);
let tileIndex = 0;
for (const tile of sortedTiles) {
  tileIndex += 1;
  const geometry = buildTileGeometry(tile);
  if (!geometry.indices.length) continue;
  const document = createDocument(tile, geometry);
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: meshoptLevel }));
  const fileName = `layer-${tile.layerId}-tile-${tile.tile[0]}-${tile.tile[1]}.glb`;
  const filePath = path.join(outputDir, fileName);
  await io.write(filePath, document);
  const netIds = [...new Set(geometry.netIds)].sort((a, b) => a - b);
  const tileId = `${tile.layerId}:${tile.tile[0]}:${tile.tile[1]}`;
  const stat = await fs.stat(filePath);
  manifest.tiles.push({
    id: tileId,
    path: fileName,
    layerId: tile.layerId,
    layerName: tile.layerName,
    tile: tile.tile,
    boundsMm: tileBounds(tile.tile, tileSize),
    netIds,
    bytes: stat.size,
    vertices: geometry.positions.length / 3,
    triangles: geometry.indices.length / 3,
  });
  for (const netId of netIds) {
    if (!netId) continue;
    (manifest.netToTiles[String(netId)] ||= []).push(tileId);
  }
  if (tileIndex === sortedTiles.length || tileIndex % 25 === 0) {
    progress(`wrote tiles=${tileIndex}/${sortedTiles.length} manifestTiles=${manifest.tiles.length}`);
  }
}

await fs.writeFile(
  path.join(outputDir, "scene.manifest.json"),
  JSON.stringify(manifest),
);
progress(`done manifestTiles=${manifest.tiles.length}`);

function progress(message) {
  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.error(`[semantic-gltf +${elapsedSeconds}s] ${message}`);
}

function normalizeMeshoptLevel(value) {
  const level = String(value || "").trim().toLowerCase();
  if (["low", "medium", "high"].includes(level)) return level;
  return "medium";
}

function appendTilePolygon(tiles, object, tile, polygon) {
  const key = `${object.layerId}:${tile[0]}:${tile[1]}`;
  const entry = tiles.get(key) || {
    layerId: object.layerId,
    layerName: object.layerName,
    zMm: object.zMm,
    thicknessMm: object.thicknessMm,
    tile,
    objects: [],
  };
  entry.objects.push({
    netId: object.netId,
    objectFeatureId: object.objectFeatureId,
    polygon,
  });
  tiles.set(key, entry);
}

function createDocument(tile, geometry) {
  const document = new Document();
  const buffer = document.createBuffer("geometry");
  const meshFeatures = document.createExtension(EXTMeshFeatures);
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document
        .createAccessor("POSITION", buffer)
        .setType(Accessor.Type.VEC3)
        .setArray(new Float32Array(geometry.positions)),
    )
    .setAttribute(
      "NORMAL",
      document
        .createAccessor("NORMAL", buffer)
        .setType(Accessor.Type.VEC3)
        .setArray(new Float32Array(geometry.normals)),
    )
    .setAttribute(
      "_FEATURE_ID_0",
      document
        .createAccessor("netId", buffer)
        .setType(Accessor.Type.SCALAR)
        .setArray(new Float32Array(geometry.netIds)),
    )
    .setAttribute(
      "_FEATURE_ID_1",
      document
        .createAccessor("objectFeatureId", buffer)
        .setType(Accessor.Type.SCALAR)
        .setArray(new Float32Array(geometry.objectFeatureIds)),
    )
    .setIndices(
      document
        .createAccessor("indices", buffer)
        .setType(Accessor.Type.SCALAR)
        .setArray(
          geometry.positions.length / 3 <= 65535
            ? new Uint16Array(geometry.indices)
            : new Uint32Array(geometry.indices),
        ),
    );

  const features = meshFeatures
    .createFeatures()
    .addFeatureID(
      meshFeatures
        .createFeatureID()
        .setFeatureCount(maxValue(geometry.netIds, 1) + 1)
        .setAttribute(0)
        .setLabel("net"),
    )
    .addFeatureID(
      meshFeatures
        .createFeatureID()
        .setFeatureCount(maxValue(geometry.objectFeatureIds, 1) + 1)
        .setAttribute(1)
        .setLabel("pcb_object"),
    );
  primitive
    .setExtension("EXT_mesh_features", features)
    .setExtras({
      layerId: tile.layerId,
      layerName: tile.layerName,
      tile: tile.tile,
    });

  const mesh = document.createMesh(`layer-${tile.layerId}`).addPrimitive(primitive);
  const node = document.createNode(`tile-${tile.tile[0]}-${tile.tile[1]}`).setMesh(mesh);
  document.createScene("PCB").addChild(node);
  document.getRoot().setExtras({
    schema: "prism.semantic_gltf_tile_a0",
    layerId: tile.layerId,
    layerName: tile.layerName,
    tile: tile.tile,
  });
  return document;
}

function buildTileGeometry(tile) {
  const geometry = {
    positions: [],
    normals: [],
    netIds: [],
    objectFeatureIds: [],
    indices: [],
  };
  const y1 = Number(tile.zMm) + Number(tile.thicknessMm) / 2;
  for (const object of tile.objects) {
    appendSurfacePolygon(
      geometry,
      object.polygon,
      y1,
      Number(object.netId || 0),
      Number(object.objectFeatureId || 0),
    );
  }
  return geometry;
}

function appendSurfacePolygon(geometry, polygon, y, netId, objectFeatureId) {
  const rings = polygon.map(openRing).filter((ring) => ring.length >= 3);
  if (!rings.length) return;
  const flat = flattenRings(rings);
  const triangles = earcut(flat.vertices, flat.holes, flat.dimensions);
  const base = geometry.positions.length / 3;
  for (let index = 0; index < flat.vertices.length; index += 2) {
    appendVertex(geometry, flat.vertices[index], y, flat.vertices[index + 1], 0, 1, 0, netId, objectFeatureId);
  }
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index];
    const b = triangles[index + 1];
    const c = triangles[index + 2];
    geometry.indices.push(base + a, base + b, base + c);
  }
}

function appendVertex(geometry, x, y, z, nx, ny, nz, netId, objectFeatureId) {
  geometry.positions.push(x / 1000, y / 1000, z / 1000);
  geometry.normals.push(nx, ny, nz);
  geometry.netIds.push(netId);
  geometry.objectFeatureIds.push(objectFeatureId);
}

function polygonBounds(polygon) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of [polygon.outer, ...(polygon.holes || [])]) {
    for (const point of ring) {
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
    }
  }
  return [minX, minY, maxX, maxY];
}

function sceneBounds(objects, barrels) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const object of objects) {
    const half = Number(object.thicknessMm || 0) / 2;
    minY = Math.min(minY, Number(object.zMm || 0) - half);
    maxY = Math.max(maxY, Number(object.zMm || 0) + half);
    for (const polygon of object.polygons || []) {
      for (const ring of [polygon.outer, ...(polygon.holes || [])]) {
        for (const point of ring) {
          minX = Math.min(minX, point[0]);
          minZ = Math.min(minZ, point[1]);
          maxX = Math.max(maxX, point[0]);
          maxZ = Math.max(maxZ, point[1]);
        }
      }
    }
  }
  for (const barrel of barrels) {
    const bounds = barrel.boundsMm || [];
    if (bounds.length !== 6) continue;
    minX = Math.min(minX, bounds[0]);
    minZ = Math.min(minZ, bounds[1]);
    minY = Math.min(minY, bounds[2]);
    maxX = Math.max(maxX, bounds[3]);
    maxZ = Math.max(maxZ, bounds[4]);
    maxY = Math.max(maxY, bounds[5]);
  }
  if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [0.001, 0.001, 0.001] };
  return {
    min: [
      minX / 1000,
      (Number.isFinite(minY) ? minY : 0) / 1000,
      minZ / 1000,
    ],
    max: [
      maxX / 1000,
      (Number.isFinite(maxY) ? maxY : 1) / 1000,
      maxZ / 1000,
    ],
  };
}

function tilesForBounds(bounds, size) {
  const epsilon = 1e-9;
  const result = [];
  for (let y = Math.floor(bounds[1] / size); y <= Math.floor((bounds[3] - epsilon) / size); y++) {
    for (let x = Math.floor(bounds[0] / size); x <= Math.floor((bounds[2] - epsilon) / size); x++) {
      result.push([x, y]);
    }
  }
  return result;
}

function tileBounds(tile, size) {
  return [tile[0] * size, tile[1] * size, (tile[0] + 1) * size, (tile[1] + 1) * size];
}

function tileRing(tile, size) {
  const [minX, minY, maxX, maxY] = tileBounds(tile, size);
  return closeRing([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]);
}

function closeRing(ring) {
  if (!ring.length) return ring;
  const result = ring.map((point) => [Number(point[0]), Number(point[1])]);
  const first = result[0];
  const last = result[result.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) result.push([...first]);
  return result;
}

function openRing(ring) {
  const result = ring.map((point) => [Number(point[0]), Number(point[1])]);
  if (result.length > 1) {
    const first = result[0];
    const last = result[result.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) result.pop();
  }
  return result;
}

function compareTiles(a, b) {
  return a.layerId - b.layerId || a.tile[1] - b.tile[1] || a.tile[0] - b.tile[0];
}

function maxValue(values, fallback = 0) {
  let maximum = fallback;
  for (const value of values) maximum = Math.max(maximum, Number(value || 0));
  return maximum;
}
