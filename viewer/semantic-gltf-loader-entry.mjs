import { WebIO } from "@gltf-transform/core";
import {
  EXTMeshFeatures,
  EXTMeshoptCompression,
  KHRMeshQuantization,
} from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new WebIO()
  .registerExtensions([EXTMeshFeatures, EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

async function load(url, defaultFeatureId = 0) {
  await MeshoptDecoder.ready;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const document = await io.readBinary(bytes);
  const primitives = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const positionAccessor = primitive.getAttribute("POSITION");
      const normalAccessor = primitive.getAttribute("NORMAL");
      const netAccessor = primitive.getAttribute("_FEATURE_ID_0");
      const objectAccessor = primitive.getAttribute("_FEATURE_ID_1");
      const indices = primitive.getIndices()?.getArray();
      if (!positionAccessor || !normalAccessor || !indices) continue;
      const count = positionAccessor.getCount();
      const position = new Float32Array(count * 3);
      const normal = new Float32Array(count * 3);
      const netId = new Uint32Array(count);
      const objectFeatureId = new Uint32Array(count);
      const value = [];
      for (let index = 0; index < count; index += 1) {
        positionAccessor.getElement(index, value);
        transformPoint(position, index * 3, value, matrix);
        normalAccessor.getElement(index, value);
        transformNormal(normal, index * 3, value, matrix);
        netId[index] = Number(netAccessor?.getScalar(index) || 0);
        objectFeatureId[index] = objectAccessor
          ? Number(objectAccessor.getScalar(index) || 0)
          : Number(defaultFeatureId || 0);
      }
      primitives.push({ position, normal, netId, objectFeatureId, indices });
    }
  }
  return { byteLength: bytes.byteLength, primitives };
}

function transformPoint(output, offset, point, matrix) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  output[offset] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  output[offset + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  output[offset + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
}

function transformNormal(output, offset, normal, matrix) {
  const x = matrix[0] * normal[0] + matrix[4] * normal[1] + matrix[8] * normal[2];
  const y = matrix[1] * normal[0] + matrix[5] * normal[1] + matrix[9] * normal[2];
  const z = matrix[2] * normal[0] + matrix[6] * normal[1] + matrix[10] * normal[2];
  const length = Math.hypot(x, y, z) || 1;
  output[offset] = x / length;
  output[offset + 1] = y / length;
  output[offset + 2] = z / length;
}

globalThis.PrismSemanticGltfLoader = { load };
