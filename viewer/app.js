(() => {
  const topology = window.__TOPOLOGY__ || {};
  const semanticGeometry = window.__SEMANTIC_GEOMETRY__ || {};
  const canvas = document.getElementById("viewport");
  const statusEl = document.getElementById("status");
  const selectionEl = document.getElementById("selection");
  const diagnosticsEl = document.getElementById("diagnostics");
  const layersEl = document.getElementById("layers");
  const fallbackEl = document.getElementById("fallback");

  const KIND = { board: 1, track: 2, zone: 3, pad: 4, via: 5, silkscreen: 6, component: 7 };
  const FEATURE_HEADER_SIZE = 24;
  const FEATURE_RECORD_SIZE = 28;
  const CHUNK_HEADER_SIZE = 48;
  const VERTEX_STRIDE = 16;
  const INSTANCE_HEADER_SIZE = 24;
  const INSTANCE_STRIDE = 68;
  const OBJECT_HEADER_SIZE = 32;
  const OBJECT_RECORD_SIZE = 48;
  const OBJECT_RING_SIZE = 8;
  const MAX_RESIDENT_BYTES = 256 * 1024 * 1024;

  const state = {
    orthoLocked: true,
    cameraTool: "orbit",
    colorMode: "layer",
    visibleLayers: new Set(),
    activeNetId: 0,
    activeNetClassId: 0,
    selectedFeatureId: 0,
    lastPickId: 0,
    showBoard: true,
    showComponents: true,
    showUnmapped: true,
    isolateNet: false,
    explode: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    yaw: -0.65,
    pitch: 0.92,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    startPanX: 0,
    startPanY: 0,
    startYaw: 0,
    startPitch: 0,
    startTime: performance.now(),
    frameCount: 0,
    lastFpsTime: performance.now(),
    fps: 0,
    loadStarted: performance.now(),
    firstShellMs: 0,
    activeLayerMs: 0,
  };

  const scene = {
    manifest: null,
    isSemanticGltf: false,
    features: [],
    featureGpuData: null,
    nets: [],
    netClasses: [{ id: 0, name: "" }],
    netClassIds: null,
    layers: [],
    chunksById: new Map(),
    resident: new Map(),
    componentGroups: [],
    componentResident: [],
    objects: [],
    objectsByLayer: new Map(),
    bboxMin: [0, 0, 0],
    bboxMax: [1, 1, 1],
    residentBytes: 0,
    downloadedBytes: 0,
    triangles: 0,
    drawCalls: 0,
  };

  let device;
  let context;
  let canvasFormat;
  let mainBindGroup;
  let mainPipeline;
  let pickPipeline;
  let componentPipeline;
  let componentPickPipeline;
  let uniformBuffer;
  let featureBuffer;
  let layerColorBuffer;
  let netColorBuffer;
  let netClassBuffer;
  let layerOffsetBuffer;
  let depthTexture;
  let pickTexture;
  let pickPositionTexture;
  let pickDepthTexture;
  let pickReadBuffer;
  let pickPositionReadBuffer;

  function assetUrl(path) {
    return new URL(path, window.location.href).toString();
  }

  async function fetchJson(path) {
    const response = await fetch(assetUrl(path), { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
    return response.json();
  }

  async function fetchBytes(path) {
    const response = await fetch(assetUrl(path), { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
    const buffer = await response.arrayBuffer();
    scene.downloadedBytes += buffer.byteLength;
    return buffer;
  }

  const decoderWorker = (() => {
    const source = `
let wasmModule;
async function decode(buffer, decoderUrl, wasmUrl, expectedSize) {
  try {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("zstd"));
    return await new Response(stream).arrayBuffer();
  } catch (_nativeError) {
    if (!wasmModule) {
      wasmModule = await import(decoderUrl);
      await wasmModule.init(wasmUrl);
    }
    const output = wasmModule.decompress(new Uint8Array(buffer), { defaultHeapSize: expectedSize });
    return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
  }
}
self.onmessage = async (event) => {
  const { id, buffer, decoderUrl, wasmUrl, expectedSize } = event.data;
  try {
    const output = await decode(buffer, decoderUrl, wasmUrl, expectedSize);
    self.postMessage({ id, output }, [output]);
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })), { type: "module" });
    let nextId = 1;
    const pending = new Map();
    worker.onmessage = (event) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if (event.data.error) request.reject(new Error(event.data.error));
      else request.resolve(event.data.output);
    };
    return {
      decode(buffer, expectedSize) {
        return new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          worker.postMessage({
            id,
            buffer,
            decoderUrl: assetUrl("vendor/zstd/index.js"),
            wasmUrl: assetUrl("vendor/zstd/zstd.wasm"),
            expectedSize,
          }, [buffer]);
        });
      },
    };
  })();

  async function loadCompressed(path, expectedSize) {
    return decoderWorker.decode(await fetchBytes(path), expectedSize);
  }

  function parseFeatures(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const magic = new TextDecoder().decode(bytes.slice(0, 8));
    if (!["P3DFEAT3", "P3DVFEA4"].includes(magic)) throw new Error(`Unsupported feature table: ${magic}`);
    const count = view.getUint32(12, true);
    const stride = view.getUint32(16, true);
    const stringsLength = view.getUint32(20, true);
    if (stride !== FEATURE_RECORD_SIZE) throw new Error(`Unsupported feature stride: ${stride}`);
    const strings = JSON.parse(new TextDecoder().decode(bytes.slice(FEATURE_HEADER_SIZE, FEATURE_HEADER_SIZE + stringsLength)));
    const recordsStart = FEATURE_HEADER_SIZE + stringsLength;
    const gpu = new Uint32Array(count * 4);
    scene.features = new Array(count);
    for (let index = 0; index < count; index += 1) {
      const offset = recordsStart + index * stride;
      const feature = {
        objectId: view.getUint32(offset, true),
        netId: view.getUint32(offset + 4, true),
        layerMask: view.getUint32(offset + 8, true),
        primaryLayerId: view.getUint32(offset + 12, true),
        kindId: view.getUint8(offset + 16),
        sourceUid: strings[view.getUint32(offset + 20, true)] || "",
        designator: strings[view.getUint32(offset + 24, true)] || "",
      };
      scene.features[index] = feature;
      gpu.set([feature.netId, feature.layerMask, feature.primaryLayerId, feature.kindId], index * 4);
    }
    scene.featureGpuData = gpu;
  }

  function parseObjectIndex(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const magic = new TextDecoder().decode(bytes.slice(0, 8));
    if (magic !== "P3DOBJX4") throw new Error(`Unsupported object index: ${magic}`);
    const count = view.getUint32(12, true);
    const stride = view.getUint32(16, true);
    const stringsLength = view.getUint32(20, true);
    const ringCount = view.getUint32(24, true);
    if (stride !== OBJECT_RECORD_SIZE) throw new Error(`Unsupported object index stride: ${stride}`);
    const strings = JSON.parse(new TextDecoder().decode(bytes.slice(OBJECT_HEADER_SIZE, OBJECT_HEADER_SIZE + stringsLength)));
    const recordsStart = OBJECT_HEADER_SIZE + stringsLength;
    const ringsStart = recordsStart + count * stride;
    const pointsStart = ringsStart + ringCount * OBJECT_RING_SIZE;
    scene.objects = new Array(count);
    scene.objectsByLayer.clear();
    for (let index = 0; index < count; index += 1) {
      const offset = recordsStart + index * stride;
      const firstRing = view.getUint32(offset + 40, true);
      const objectRingCount = view.getUint32(offset + 44, true);
      const rings = [];
      for (let ringIndex = firstRing; ringIndex < firstRing + objectRingCount; ringIndex += 1) {
        const ringOffset = ringsStart + ringIndex * OBJECT_RING_SIZE;
        const firstPoint = view.getUint32(ringOffset, true);
        const pointCount = view.getUint32(ringOffset + 4, true);
        const ring = [];
        for (let pointIndex = firstPoint; pointIndex < firstPoint + pointCount; pointIndex += 1) {
          const pointOffset = pointsStart + pointIndex * 8;
          ring.push([view.getFloat32(pointOffset, true), view.getFloat32(pointOffset + 4, true)]);
        }
        rings.push(ring);
      }
      const object = {
        sourceUid: strings[view.getUint32(offset, true)] || "",
        netId: view.getUint32(offset + 4, true),
        layerId: view.getUint32(offset + 8, true),
        layerMask: view.getUint32(offset + 12, true),
        kindId: view.getUint32(offset + 16, true),
        designator: strings[view.getUint32(offset + 20, true)] || "",
        bbox: [
          view.getFloat32(offset + 24, true),
          view.getFloat32(offset + 28, true),
          view.getFloat32(offset + 32, true),
          view.getFloat32(offset + 36, true),
        ],
        rings,
      };
      scene.objects[index] = object;
      if (!scene.objectsByLayer.has(object.layerId)) scene.objectsByLayer.set(object.layerId, []);
      scene.objectsByLayer.get(object.layerId).push(object);
    }
  }

  function parseChunk(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const magic = new TextDecoder().decode(bytes.slice(0, 8));
    if (magic !== "P3DCHNK3") throw new Error(`Unsupported geometry chunk: ${magic}`);
    const vertexCount = view.getUint32(12, true);
    const indexCount = view.getUint32(16, true);
    const stride = view.getUint32(20, true);
    if (stride !== VERTEX_STRIDE) throw new Error(`Unsupported vertex stride: ${stride}`);
    const bboxMin = [view.getFloat32(24, true), view.getFloat32(28, true), view.getFloat32(32, true)];
    const bboxMax = [view.getFloat32(36, true), view.getFloat32(40, true), view.getFloat32(44, true)];
    const vertexStart = CHUNK_HEADER_SIZE;
    const indexStart = vertexStart + vertexCount * stride;
    return {
      vertexCount,
      indexCount,
      bboxMin,
      bboxMax,
      vertexBytes: bytes.slice(vertexStart, indexStart),
      indexBytes: bytes.slice(indexStart, indexStart + indexCount * 2),
    };
  }

  function parseInstances(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const magic = new TextDecoder().decode(bytes.slice(0, 8));
    if (magic !== "P3DINST3") throw new Error(`Unsupported instance chunk: ${magic}`);
    const count = view.getUint32(12, true);
    const stride = view.getUint32(16, true);
    if (stride !== INSTANCE_STRIDE) throw new Error(`Unsupported instance stride: ${stride}`);
    return { count, bytes: bytes.slice(INSTANCE_HEADER_SIZE, INSTANCE_HEADER_SIZE + count * stride) };
  }

  async function loadManifest() {
    const path = semanticGeometry.assets?.scene_manifest || semanticGeometry.semantic_scene?.path;
    if (!path) throw new Error("No semantic scene manifest is present");
    statusEl.textContent = "Loading scene manifest";
    scene.manifest = await fetchJson(path);
    if (!["prism.semantic_scene_a3", "prism.semantic_scene_a4", "prism.semantic_gltf_a0"].includes(scene.manifest.schema)) {
      throw new Error(`Unsupported scene schema: ${scene.manifest.schema}`);
    }
    scene.isSemanticGltf = scene.manifest.schema === "prism.semantic_gltf_a0";
    scene.nets = scene.manifest.nets || [];
    const classIdByName = new Map();
    scene.netClasses = [{ id: 0, name: "" }];
    scene.netClassIds = new Uint32Array(Math.max(128, scene.nets.length + 2));
    for (const net of scene.nets) {
      const name = String(net.netClass || net.net_class || "");
      if (!name) continue;
      if (!classIdByName.has(name)) {
        const id = scene.netClasses.length;
        classIdByName.set(name, id);
        scene.netClasses.push({ id, name });
      }
      net.netClassId = classIdByName.get(name);
      scene.netClassIds[Number(net.id || 0)] = net.netClassId;
    }
    scene.layers = scene.manifest.layers || [];
    scene.bboxMin = scene.manifest.bbox?.min || [0, 0, 0];
    scene.bboxMax = scene.manifest.bbox?.max || [1, 1, 1];
    if (scene.isSemanticGltf) {
      const manifestUrl = assetUrl(path);
      const copperIds = scene.manifest.copperLayerIds || [];
      scene.manifest.copper_layer_ids = copperIds;
      scene.manifest.net_to_chunks = scene.manifest.netToTiles || {};
      scene.manifest.kinds = KIND;
      for (const tile of scene.manifest.tiles || []) {
        scene.chunksById.set(tile.id, {
          ...tile,
          class: "copper",
          layer_id: Number(tile.layerId),
          path: new URL(tile.path, manifestUrl).toString(),
          lod: "solid",
          raw_bytes: Number(tile.bytes || 0),
        });
      }
      const features = [...(scene.manifest.objectFeatures || [])];
      let maxFeatureId = features.reduce((maximum, feature) => Math.max(maximum, Number(feature.id || 0)), 0);
      const boardLayer = scene.layers.find((layer) => layer.name === "Board") || { id: 0 };
      const boardFeatureId = ++maxFeatureId;
      const componentFeatureId = ++maxFeatureId;
      features.push(
        {
          id: boardFeatureId,
          sourceUid: "context:board",
          netId: 0,
          layerId: Number(boardLayer.id || 0),
          kind: "board",
        },
        {
          id: componentFeatureId,
          sourceUid: "context:components",
          netId: 0,
          layerId: 0,
          kind: "component",
        },
      );
      const baseBoard = semanticGeometry.assets?.base_board_glb;
      const components = semanticGeometry.assets?.components_glb;
      if (baseBoard) {
        scene.chunksById.set("context:board", {
          id: "context:board",
          class: "board",
          layer_id: Number(boardLayer.id || 0),
          path: assetUrl(baseBoard),
          lod: "solid",
          defaultFeatureId: boardFeatureId,
        });
      }
      if (components) {
        scene.chunksById.set("context:components", {
          id: "context:components",
          class: "component",
          layer_id: 0,
          path: assetUrl(components),
          lod: "solid",
          defaultFeatureId: componentFeatureId,
        });
      }
      scene.features = new Array(maxFeatureId + 1);
      const gpu = new Uint32Array((maxFeatureId + 1) * 4);
      for (const feature of features) {
        const id = Number(feature.id || 0);
        const layerId = Number(feature.layerId || 0);
        const layerIndex = copperIds.indexOf(layerId);
        const kind = feature.kind === "track_arc" ? "track" : String(feature.kind || "unknown");
        const normalized = {
          objectId: id,
          netId: Number(feature.netId || 0),
          layerMask: layerIndex >= 0 && layerIndex < 32 ? (1 << layerIndex) >>> 0 : 0,
          primaryLayerId: layerId,
          kindId: KIND[kind] || 0,
          kind,
          sourceUid: String(feature.sourceUid || ""),
          designator: String(feature.designator || ""),
        };
        scene.features[id] = normalized;
        gpu.set([normalized.netId, normalized.layerMask, normalized.primaryLayerId, normalized.kindId], id * 4);
      }
      scene.featureGpuData = gpu;
      state.visibleLayers.add(defaultLayerId());
      return;
    }
    scene.componentGroups = scene.manifest.component_groups || [];
    for (const chunk of scene.manifest.chunks || []) scene.chunksById.set(chunk.id, chunk);
    parseFeatures(await fetchBytes(scene.manifest.features.path));
    if (scene.manifest.object_index?.path) {
      parseObjectIndex(await fetchBytes(scene.manifest.object_index.path));
    }
    state.visibleLayers.add(defaultLayerId());
  }

  function defaultLayerId() {
    return scene.layers.find((layer) => layer.name === "F.Cu")?.id
      || scene.layers.find((layer) => layer.role === "copper")?.id
      || 0;
  }

  function layerById(id) {
    return scene.layers.find((layer) => Number(layer.id) === Number(id))
      || { id: 0, name: "Unknown", role: "unknown", color: [0.5, 0.5, 0.5, 1] };
  }

  function netById(id) {
    return scene.nets[id] || scene.nets[0] || null;
  }

  function featureById(id) {
    return scene.features[id] || scene.features[0] || null;
  }

  function isCopperLayer(layer) {
    return layer?.role === "copper" || String(layer?.name || "").endsWith(".Cu");
  }

  function boardCenter() {
    return scene.bboxMin.map((value, index) => (value + scene.bboxMax[index]) / 2);
  }

  function boardRadius() {
    return Math.max(...scene.bboxMax.map((value, index) => value - scene.bboxMin[index]), 0.001) * 0.64;
  }

  function normalize(v) {
    const length = Math.hypot(...v) || 1;
    return v.map((value) => value / length);
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        for (let k = 0; k < 4; k += 1) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
      }
    }
    return out;
  }

  function ortho(left, right, bottom, top, near, far) {
    return [
      2 / (right - left), 0, 0, 0,
      0, 2 / (top - bottom), 0, 0,
      0, 0, 1 / (near - far), 0,
      -(right + left) / (right - left), -(top + bottom) / (top - bottom), near / (near - far), 1,
    ];
  }

  function lookAt(eye, center, up) {
    const z = normalize(eye.map((value, index) => value - center[index]));
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ];
  }

  function makeCamera(width, height) {
    const center = boardCenter();
    const aspect = width / Math.max(1, height);
    const radius = boardRadius() / state.zoom;
    const panScale = radius * 0.002;
    const target = [center[0] - state.panX * panScale, center[1], center[2] + state.panY * panScale];
    
    if (state.orthoLocked) {
      const sx = 1 / (radius * aspect);
      const sy = 1 / radius;
      const depth = Math.max(scene.bboxMax[1] - scene.bboxMin[1], radius * 0.1);
      const sz = -1 / depth;
      return [
        sx, 0, 0, 0, 0, 0, sz, 0, 0, sy, 0, 0,
        -target[0] * sx,
        -target[2] * sy,
        -scene.bboxMax[1] * sz,
        1,
      ];
    }
    
    const distance = radius * 4;
    // Damping effect added via smooth pan/orbit, implemented here as smooth rotations in bindPointerControls
    const eye = [
      target[0] + Math.cos(state.yaw) * Math.cos(state.pitch) * distance,
      target[1] + Math.sin(state.pitch) * distance,
      target[2] + Math.sin(state.yaw) * Math.cos(state.pitch) * distance,
    ];
    return multiply(
      ortho(-radius * aspect, radius * aspect, -radius, radius, -radius * 10, radius * 10),
      lookAt(eye, target, [0, 1, 0]),
    );
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    recreateTargets();
    return true;
  }

  function recreateTargets() {
    if (!device || !context) return;
    depthTexture?.destroy();
    depthTexture = device.createTexture({
      size: [Math.max(1, canvas.width), Math.max(1, canvas.height)],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  function createMappedBuffer(bytes, usage) {
    const size = Math.max(4, Math.ceil(bytes.byteLength / 4) * 4);
    const buffer = device.createBuffer({ size, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(bytes);
    buffer.unmap();
    return buffer;
  }

  async function ensureChunk(entry) {
    const existing = scene.resident.get(entry.id);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing;
    }
    const parsed = scene.isSemanticGltf
      ? await loadSemanticGltfChunk(entry)
      : parseChunk(await loadCompressed(entry.path, entry.raw_bytes));
    const resident = {
      entry,
      vertexBuffer: createMappedBuffer(parsed.vertexBytes, GPUBufferUsage.VERTEX),
      indexBuffer: createMappedBuffer(parsed.indexBytes, GPUBufferUsage.INDEX),
      indexCount: parsed.indexCount,
      indexFormat: parsed.indexFormat || "uint16",
      bboxMin: parsed.bboxMin,
      bboxScale: parsed.bboxMax.map((value, index) => value - parsed.bboxMin[index]),
      byteSize: parsed.vertexBytes.byteLength + parsed.indexBytes.byteLength,
      lastUsed: performance.now(),
    };
    const transformData = new Float32Array([
      ...resident.bboxMin, 0,
      ...resident.bboxScale, 0,
    ]);
    resident.transformBuffer = createMappedBuffer(new Uint8Array(transformData.buffer), GPUBufferUsage.UNIFORM);
    resident.bindGroup = device.createBindGroup({
      layout: mainPipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: resident.transformBuffer } }],
    });
    scene.resident.set(entry.id, resident);
    scene.residentBytes += resident.byteSize;
    scene.triangles += parsed.indexCount / 3;
    evictHiddenChunks();
    return resident;
  }

  async function loadSemanticGltfChunk(entry) {
    if (!globalThis.PrismSemanticGltfLoader) throw new Error("Semantic GLB loader is unavailable");
    const loaded = await globalThis.PrismSemanticGltfLoader.load(entry.path, entry.defaultFeatureId || 0);
    scene.downloadedBytes += loaded.byteLength;
    const primitives = loaded.primitives || [];
    const vertexCount = primitives.reduce((total, primitive) => total + primitive.position.length / 3, 0);
    const indexCount = primitives.reduce((total, primitive) => total + primitive.indices.length, 0);
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const featureIds = new Uint32Array(vertexCount);
    const indices = vertexCount <= 65535 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const primitive of primitives) {
      const count = primitive.position.length / 3;
      positions.set(primitive.position, vertexOffset * 3);
      normals.set(primitive.normal, vertexOffset * 3);
      for (let index = 0; index < count; index += 1) {
        featureIds[vertexOffset + index] = Number(primitive.objectFeatureId[index] || 0);
      }
      for (let index = 0; index < primitive.indices.length; index += 1) {
        indices[indexOffset + index] = Number(primitive.indices[index]) + vertexOffset;
      }
      vertexOffset += count;
      indexOffset += primitive.indices.length;
    }
    const bboxMin = [Infinity, Infinity, Infinity];
    const bboxMax = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < vertexCount; index += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[index * 3 + axis];
        bboxMin[axis] = Math.min(bboxMin[axis], value);
        bboxMax[axis] = Math.max(bboxMax[axis], value);
      }
    }
    const scale = bboxMax.map((value, axis) => Math.max(value - bboxMin[axis], 1e-9));
    const vertexBytes = new Uint8Array(vertexCount * VERTEX_STRIDE);
    const view = new DataView(vertexBytes.buffer);
    for (let index = 0; index < vertexCount; index += 1) {
      const offset = index * VERTEX_STRIDE;
      for (let axis = 0; axis < 3; axis += 1) {
        const normalized = (positions[index * 3 + axis] - bboxMin[axis]) / scale[axis];
        view.setUint16(offset + axis * 2, Math.round(Math.max(0, Math.min(1, normalized)) * 65535), true);
        view.setInt8(offset + 8 + axis, Math.round(Math.max(-1, Math.min(1, normals[index * 3 + axis])) * 127));
      }
      view.setUint16(offset + 6, 65535, true);
      view.setInt8(offset + 11, 127);
      view.setUint32(offset + 12, featureIds[index], true);
    }
    return {
      vertexCount,
      indexCount,
      bboxMin,
      bboxMax,
      vertexBytes,
      indexBytes: new Uint8Array(indices.buffer),
      indexFormat: indices instanceof Uint16Array ? "uint16" : "uint32",
    };
  }

  async function ensureComponentGroup(group, index) {
    if (scene.componentResident[index]) return scene.componentResident[index];
    const [geometryBuffer, instanceBuffer] = await Promise.all([
      loadCompressed(group.geometry.path, group.geometry.raw_bytes),
      loadCompressed(group.instances.path, group.instances.raw_bytes),
    ]);
    const geometry = parseChunk(geometryBuffer);
    const instances = parseInstances(instanceBuffer);
    const resident = {
      group,
      vertexBuffer: createMappedBuffer(geometry.vertexBytes, GPUBufferUsage.VERTEX),
      indexBuffer: createMappedBuffer(geometry.indexBytes, GPUBufferUsage.INDEX),
      instanceBuffer: createMappedBuffer(instances.bytes, GPUBufferUsage.VERTEX),
      indexCount: geometry.indexCount,
      instanceCount: instances.count,
      bboxMin: geometry.bboxMin,
      bboxScale: geometry.bboxMax.map((value, axis) => value - geometry.bboxMin[axis]),
    };
    const transformData = new Float32Array([...resident.bboxMin, 0, ...resident.bboxScale, 0]);
    resident.transformBuffer = createMappedBuffer(new Uint8Array(transformData.buffer), GPUBufferUsage.UNIFORM);
    resident.bindGroup = device.createBindGroup({
      layout: componentPipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: resident.transformBuffer } }],
    });
    scene.componentResident[index] = resident;
    scene.residentBytes += geometry.vertexBytes.byteLength + geometry.indexBytes.byteLength + instances.bytes.byteLength;
    scene.triangles += geometry.indexCount / 3 * instances.count;
    return resident;
  }

  function visibleEntries() {
    const all = [...scene.chunksById.values()];
    if (scene.isSemanticGltf) {
      if (state.orthoLocked) {
        return all.filter((entry) => (
          entry.class === "copper"
          && state.visibleLayers.has(Number(entry.layer_id))
        ));
      }
      const context = all.filter((entry) => (
        (entry.class === "board" && state.showBoard)
        || (entry.class === "component" && state.showComponents)
      ));
      if (state.isolateNet && state.activeNetId) {
        const ids = new Set(scene.manifest.net_to_chunks?.[String(state.activeNetId)] || []);
        return [...context, ...all.filter((entry) => entry.class === "copper" && ids.has(entry.id))];
      }
      return [...context, ...all.filter((entry) => entry.class === "copper")];
    }
    if (state.orthoLocked) {
      return all.filter((entry) => {
        const isSelected = state.visibleLayers.has(Number(entry.layer_id));
        const lod = isCopperLayer(layerById(entry.layer_id)) ? "surface" : "solid";
        return entry.lod === lod && isSelected;
      });
    }
    return all.filter((entry) => entry.lod === "solid" || (entry.lod === "surface" && layerById(entry.layer_id).name.startsWith("In")));
  }

  async function loadActiveScene() {
    const started = performance.now();
    statusEl.textContent = "Streaming geometry";
    if (!scene.isSemanticGltf && !state.orthoLocked) {
      const board = [...scene.chunksById.values()].filter((entry) => entry.class === "board" && entry.lod === "solid");
      await Promise.all(board.map(ensureChunk));
    }
    
    const visible = visibleEntries();
    for (const batch of batches(visible, 6)) await Promise.all(batch.map(ensureChunk));
    
    if (state.showComponents && !state.orthoLocked) {
      statusEl.textContent = "Streaming component instances";
      for (let index = 0; index < scene.componentGroups.length; index += 1) {
        await ensureComponentGroup(scene.componentGroups[index], index);
      }
    }
    if (!state.firstShellMs) state.firstShellMs = performance.now() - state.loadStarted;
    state.activeLayerMs = performance.now() - started;
    statusEl.textContent = "WebGPU semantic scene active";
  }

  async function loadNetChunks(netId) {
    const ids = scene.manifest.net_to_chunks?.[String(netId)] || [];
    await Promise.all(ids.map((id) => scene.chunksById.get(id)).filter(Boolean).map(ensureChunk));
  }

  function evictHiddenChunks() {
    if (scene.residentBytes <= MAX_RESIDENT_BYTES) return;
    const visible = new Set(visibleEntries().map((entry) => entry.id));
    const candidates = [...scene.resident.values()]
      .filter((item) => !visible.has(item.entry.id) && item.entry.class !== "board")
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const item of candidates) {
      if (scene.residentBytes <= MAX_RESIDENT_BYTES * 0.8) break;
      item.vertexBuffer.destroy();
      item.indexBuffer.destroy();
      item.transformBuffer.destroy();
      scene.resident.delete(item.entry.id);
      scene.residentBytes -= item.byteSize;
      scene.triangles -= item.indexCount / 3;
    }
  }

  function batches(items, size) {
    const result = [];
    for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
    return result;
  }

  function colorArray(items, fallback) {
    const length = Math.max(128, items.length + 2);
    const data = new Float32Array(length * 4);
    for (let index = 0; index < length; index += 1) data.set(fallback, index * 4);
    for (const item of items) data.set(gpuColor(item, fallback), Number(item.id || 0) * 4);
    return data;
  }

  function gpuColor(item, fallback) {
    const layerColors = {
      "F.Cu": [0.86, 0.16, 0.12, 1],
      "B.Cu": [0.10, 0.32, 0.82, 1],
    };
    if (layerColors[item.name]) return layerColors[item.name];
    if (Array.isArray(item.color)) return item.color;
    if (typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color)) {
      return [
        Number.parseInt(item.color.slice(1, 3), 16) / 255,
        Number.parseInt(item.color.slice(3, 5), 16) / 255,
        Number.parseInt(item.color.slice(5, 7), 16) / 255,
        1,
      ];
    }
    if (item.id && item.uid !== undefined) {
      const hue = (Number(item.id) * 0.61803398875) % 1;
      return [
        0.42 + 0.38 * Math.abs(Math.sin(hue * Math.PI * 2)),
        0.42 + 0.38 * Math.abs(Math.sin((hue + 0.33) * Math.PI * 2)),
        0.42 + 0.38 * Math.abs(Math.sin((hue + 0.66) * Math.PI * 2)),
        1,
      ];
    }
    return fallback;
  }

  function layerOffsets() {
    const data = new Float32Array(Math.max(128, scene.layers.length + 2));
    const copper = scene.manifest.copper_layer_ids || scene.manifest.copperLayerIds || [];
    const center = (copper.length - 1) / 2;
    copper.forEach((layerId, index) => { data[layerId] = (center - index) * 0.0005; });
    return data;
  }

  function selectedLayerMask() {
    const copper = scene.manifest.copper_layer_ids || scene.manifest.copperLayerIds || [];
    let mask = 0;
    for (const id of state.visibleLayers) {
      const index = copper.indexOf(id);
      if (index >= 0 && index < 32) mask |= (1 << index);
    }
    return mask >>> 0;
  }

  function writeUniforms(matrix = makeCamera(canvas.width, canvas.height)) {
    const colorMode = state.colorMode === "net" ? 1 : state.colorMode === "selected" ? 2 : 0;
    const flags = (state.isolateNet ? 1 : 0)
      | (state.showUnmapped ? 2 : 0)
      | (state.showBoard ? 4 : 0)
      | (state.showComponents ? 8 : 0);
    const data = new ArrayBuffer(112);
    new Float32Array(data, 0, 16).set(matrix);
    new Uint32Array(data, 64, 4).set([
      state.activeNetId,
      state.selectedFeatureId,
      colorMode,
      state.orthoLocked ? 0 : 1,
    ]);
    new Uint32Array(data, 80, 4).set([
      state.activeNetClassId,
      selectedLayerMask(),
      flags,
      0,
    ]);
    new Float32Array(data, 96, 4).set([
      (performance.now() - state.startTime) / 1000,
      state.explode,
      0,
      0,
    ]);
    device.queue.writeBuffer(uniformBuffer, 0, data);
  }

  function pointInRing(point, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const a = ring[index];
      const b = ring[previous];
      const crosses = ((a[1] > point[1]) !== (b[1] > point[1]))
        && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / ((b[1] - a[1]) || 1e-12) + a[0];
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function resolveSourceObject(feature, worldPosition) {
    if (!feature || !worldPosition || !scene.objects.length) return null;
    const point = [worldPosition[0] * 1000, worldPosition[2] * 1000];
    const candidates = scene.objectsByLayer.get(feature.primaryLayerId) || [];
    const priorities = { [KIND.pad]: 4, [KIND.via]: 3, [KIND.track]: 2, [KIND.zone]: 1 };
    return candidates
      .filter((object) => object.netId === feature.netId)
      .filter((object) => (
        point[0] >= object.bbox[0] && point[0] <= object.bbox[2]
        && point[1] >= object.bbox[1] && point[1] <= object.bbox[3]
      ))
      .filter((object) => object.rings.some((ring) => pointInRing(point, ring)))
      .sort((a, b) => (priorities[b.kindId] || 0) - (priorities[a.kindId] || 0))[0] || null;
  }

  function selectionPayload(featureId, worldPosition) {
    const feature = featureById(featureId);
    if (!feature || (!feature.objectId && !feature.sourceUid)) return null;
    const sourceObject = resolveSourceObject(feature, worldPosition);
    const net = netById(feature.netId);
    const layer = layerById(sourceObject?.layerId ?? feature.primaryLayerId);
    const kindId = sourceObject?.kindId ?? feature.kindId;
    const kind = feature.kind
      || Object.entries(scene.manifest.kinds || {}).find(([, id]) => Number(id) === kindId)?.[0]
      || "unknown";
    const sourceUid = sourceObject?.sourceUid || feature.sourceUid;
    const payload = {
      objectId: sourceUid || `feature:${featureId}`,
      kind,
      layer: layer.name,
      sourceIds: sourceUid ? [sourceUid] : [],
    };
    if (net?.uid) {
      Object.assign(payload, {
        netUid: net.uid,
        netName: net.name,
        netClass: net.netClass || "",
        traceLengthMm: net.metrics?.traceLengthMm ?? null,
        netLayers: net.metrics?.layers || [],
        objectCounts: net.metrics?.objectCounts || {},
      });
    }
    const designator = sourceObject?.designator || feature.designator;
    if (designator) payload.designator = designator;
    return payload;
  }

  async function setSelection(hit) {
    const featureId = typeof hit === "number" ? hit : Number(hit?.featureId || 0);
    state.selectedFeatureId = featureId || 0;
    const payload = selectionPayload(featureId, hit?.worldPosition);
    if (!payload) {
      state.activeNetId = 0;
      state.activeNetClassId = 0;
      selectionEl.textContent = "No object selected";
      renderControls();
      return;
    }
    const feature = featureById(featureId);
    state.activeNetId = feature.netId || 0;
    state.activeNetClassId = 0;
    if (state.activeNetId && !state.orthoLocked && state.isolateNet) {
      await loadNetChunks(state.activeNetId);
    }
    selectionEl.textContent = JSON.stringify(payload, null, 2);
    renderControls();
    window.dispatchEvent(new CustomEvent("prism-viz:select", { detail: payload }));
  }

  function renderControls() {
    layersEl.innerHTML = "";
    const toolbar = document.createElement("div");
    toolbar.className = "mode-toolbar";
    for (const [locked, label] of [[true, "2D Orthographic"], [false, "3D Orbit"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = state.orthoLocked === locked ? "active" : "";
      button.addEventListener("click", async () => {
        state.orthoLocked = locked;
        renderControls();
        await loadActiveScene();
      });
      toolbar.append(button);
    }
    layersEl.append(toolbar);

    if (state.orthoLocked) {
      const layerList = document.createElement("div");
      layerList.className = "layer-list";
      for (const layer of scene.layers.filter(isCopperLayer)) {
        const row = document.createElement("label");
        const isVisible = state.visibleLayers.has(Number(layer.id));
        row.className = isVisible ? "layer-chip active" : "layer-chip";
        row.innerHTML = `
          <input type="radio" name="active-layer" ${isVisible ? "checked" : ""}>
          <span class="swatch" style="background:${rgbaCss(gpuColor(layer, [0.5, 0.5, 0.5, 1]))}"></span>
          <span class="layer-name">${escapeHtml(layer.name)}</span>
        `;
        row.querySelector("input").addEventListener("change", async () => {
          state.visibleLayers.clear();
          state.visibleLayers.add(Number(layer.id));
          state.selectedFeatureId = 0;
          selectionEl.textContent = "No object selected";
          renderControls();
          await loadActiveScene();
        });
        layerList.append(row);
      }
      layersEl.append(controlField("Active layer", layerList));
    }

    const colorSelect = document.createElement("select");
    colorSelect.className = "layer-select";
    for (const [value, label] of [["layer", "Layer colors"], ["net", "Net colors"], ["selected", "Selected net"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = state.colorMode === value;
      colorSelect.append(option);
    }
    colorSelect.addEventListener("change", () => { state.colorMode = colorSelect.value; });
    layersEl.append(controlField("Color mode", colorSelect));

    const netSelect = document.createElement("select");
    netSelect.className = "net-select";
    netSelect.innerHTML = '<option value="0">Highlight net...</option>';
    for (const net of scene.nets) {
      if (!net.id) continue;
      const option = document.createElement("option");
      option.value = String(net.id);
      option.textContent = net.name || net.uid;
      option.selected = net.id === state.activeNetId;
      netSelect.append(option);
    }
    netSelect.addEventListener("change", async () => {
      state.activeNetId = Number(netSelect.value || 0);
      state.activeNetClassId = 0;
      state.selectedFeatureId = 0;
      if (!state.activeNetId) state.isolateNet = false;
      if (state.activeNetId && !state.orthoLocked && state.isolateNet) {
        await loadNetChunks(state.activeNetId);
      }
      renderControls();
    });
    layersEl.append(controlField("Net highlight", netSelect));

    const classSelect = document.createElement("select");
    classSelect.className = "net-select";
    classSelect.innerHTML = '<option value="0">Highlight net class...</option>';
    for (const netClass of scene.netClasses) {
      if (!netClass.id) continue;
      const option = document.createElement("option");
      option.value = String(netClass.id);
      option.textContent = netClass.name;
      option.selected = netClass.id === state.activeNetClassId;
      classSelect.append(option);
    }
    classSelect.addEventListener("change", () => {
      state.activeNetClassId = Number(classSelect.value || 0);
      state.activeNetId = 0;
      state.selectedFeatureId = 0;
      renderControls();
    });
    layersEl.append(controlField("Net class", classSelect));

    if (!state.orthoLocked) {
      const cameraTools = document.createElement("div");
      cameraTools.className = "mode-toolbar camera-toolbar";
      for (const [tool, label] of [["orbit", "Orbit"], ["pan", "Pan"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.className = state.cameraTool === tool ? "active" : "";
        button.addEventListener("click", () => {
          state.cameraTool = tool;
          renderControls();
        });
        cameraTools.append(button);
      }
      layersEl.append(controlField("Camera tool", cameraTools));

      const toggles = document.createElement("div");
      toggles.className = "toggle-list";
      toggles.append(
        toggleControl("Board substrate", state.showBoard, (value) => { state.showBoard = value; }),
        toggleControl("Components", state.showComponents, async (value) => {
          state.showComponents = value;
          if (value) await loadActiveScene();
        }),
        toggleControl("Unmapped copper", state.showUnmapped, (value) => { state.showUnmapped = value; }),
        toggleControl("Selected net only", state.isolateNet, (value) => { state.isolateNet = value; }, !state.activeNetId),
      );
      layersEl.append(controlField("3D visibility", toggles));
      const explode = document.createElement("input");
      explode.type = "range";
      explode.min = "0";
      explode.max = "10";
      explode.step = "0.1";
      explode.value = String(state.explode);
      explode.addEventListener("input", () => { state.explode = Number(explode.value); });
      layersEl.append(controlField("Stackup separation", explode));
    }
  }

  function controlField(label, control) {
    const wrapper = document.createElement("label");
    wrapper.className = "control-field";
    const text = document.createElement("span");
    text.textContent = label;
    wrapper.append(text, control);
    return wrapper;
  }

  function toggleControl(label, checked, onChange, disabled = false) {
    const row = document.createElement("label");
    row.className = "toggle-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener("change", async () => {
      await onChange(input.checked);
      renderControls();
    });
    const text = document.createElement("span");
    text.textContent = label;
    row.append(input, text);
    return row;
  }

  function rgbaCss(color = [0.5, 0.5, 0.5, 1]) {
    if (typeof color === "string") return color;
    return `rgba(${Math.round((color[0] || 0) * 255)},${Math.round((color[1] || 0) * 255)},${Math.round((color[2] || 0) * 255)},${color[3] ?? 1})`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  function updateDiagnostics() {
    const activeNet = netById(state.activeNetId);
    const rows = {
      renderer: scene.isSemanticGltf
        ? "WebGPU semantic GLB"
        : scene.manifest?.schema === "prism.semantic_scene_a4" ? "WebGPU A4" : "WebGPU A3",
      mode: state.orthoLocked ? "layer" : "orbit",
      layer: state.orthoLocked ? Array.from(state.visibleLayers).map(id => layerById(id).name).join(", ") : "stackup",
      chunks: scene.resident.size,
      drawCalls: scene.drawCalls,
      triangles: Math.round(scene.triangles),
      resident: `${(scene.residentBytes / 1048576).toFixed(1)} MB`,
      downloaded: `${(scene.downloadedBytes / 1048576).toFixed(1)} MB`,
      shell: state.firstShellMs ? `${state.firstShellMs.toFixed(0)} ms` : "-",
      activeLayer: state.activeLayerMs ? `${state.activeLayerMs.toFixed(0)} ms` : "-",
      activeNet: activeNet?.name || "-",
      activeClass: scene.netClasses[state.activeNetClassId]?.name || "-",
      lastPick: state.lastPickId || "-",
      fps: state.fps.toFixed(1),
    };
    diagnosticsEl.innerHTML = Object.entries(rows).map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
  }

  function createPipelines() {
    const shader = device.createShaderModule({ code: `
struct Uniforms {
  matrix: mat4x4<f32>,
  ids: vec4u,
  visibility: vec4u,
  animation: vec4f,
}
struct Feature { netId: u32, layerMask: u32, primaryLayerId: u32, kindId: u32 }
struct ChunkTransform { minimum: vec4f, scale: vec4f }
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> features: array<Feature>;
@group(0) @binding(2) var<storage, read> layerColors: array<vec4f>;
@group(0) @binding(3) var<storage, read> netColors: array<vec4f>;
@group(0) @binding(4) var<storage, read> layerOffsets: array<f32>;
@group(0) @binding(5) var<storage, read> netClassIds: array<u32>;
@group(1) @binding(0) var<uniform> chunk: ChunkTransform;
struct VertexIn {
  @location(0) position: vec4f,
  @location(1) normal: vec4f,
  @location(2) featureId: u32,
}
struct InstanceIn {
  @location(3) c0: vec4f,
  @location(4) c1: vec4f,
  @location(5) c2: vec4f,
  @location(6) c3: vec4f,
  @location(7) featureId: u32,
}
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) @interpolate(flat) featureId: u32,
  @location(2) @interpolate(flat) netId: u32,
  @location(3) @interpolate(flat) layerId: u32,
  @location(4) @interpolate(flat) kindId: u32,
  @location(5) worldPosition: vec3f,
}
fn visible(feature: Feature) -> bool {
  let layerMode = uniforms.ids.w == 0u;
  let selectedMask = uniforms.visibility.y;
  let flags = uniforms.visibility.z;
  if (layerMode && feature.layerMask != 0u && (feature.layerMask & selectedMask) == 0u) { return false; }
  if ((flags & 1u) != 0u && uniforms.ids.x != 0u && feature.netId != uniforms.ids.x) { return false; }
  if ((flags & 2u) == 0u && feature.netId == 0u && feature.kindId >= 2u && feature.kindId <= 5u) { return false; }
  if ((flags & 4u) == 0u && feature.kindId == ${KIND.board}u) { return false; }
  if ((flags & 8u) == 0u && feature.kindId == ${KIND.component}u) { return false; }
  return true;
}
fn finishVertex(position: vec3f, normal: vec3f, featureId: u32) -> VertexOut {
  let feature = features[featureId];
  var out: VertexOut;
  if (!visible(feature)) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    out.worldPosition = vec3f(0.0);
  } else {
    var world = position;
    if (uniforms.ids.w == 1u && feature.layerMask != 0u) {
      world.y += layerOffsets[feature.primaryLayerId] * uniforms.animation.y;
    }
    out.position = uniforms.matrix * vec4f(world, 1.0);
    out.worldPosition = world;
  }
  out.normal = normal;
  out.featureId = featureId;
  out.netId = feature.netId;
  out.layerId = feature.primaryLayerId;
  out.kindId = feature.kindId;
  return out;
}
@vertex fn vs(input: VertexIn) -> VertexOut {
  let position = chunk.minimum.xyz + input.position.xyz * chunk.scale.xyz;
  return finishVertex(position, normalize(input.normal.xyz), input.featureId);
}
@vertex fn instanceVs(input: VertexIn, instance: InstanceIn) -> VertexOut {
  let local = chunk.minimum.xyz + input.position.xyz * chunk.scale.xyz;
  let transform = mat4x4f(instance.c0, instance.c1, instance.c2, instance.c3);
  let position = (transform * vec4f(local, 1.0)).xyz;
  let normal = normalize((transform * vec4f(input.normal.xyz, 0.0)).xyz);
  return finishVertex(position, normal, instance.featureId);
}
@fragment fn fs(input: VertexOut) -> @location(0) vec4f {
  let feature = features[input.featureId];
  let activeNet = uniforms.ids.x;
  let activeClass = uniforms.visibility.x;
  let selectedFeature = uniforms.ids.y;
  let colorMode = uniforms.ids.z;
  let light = normalize(vec3f(-0.35, 0.8, 0.45));
  let shade = 0.62 + max(dot(abs(input.normal), light), 0.0) * 0.38;
  if (
    (activeNet != 0u && input.netId == activeNet)
    || (activeClass != 0u && input.netId != 0u && netClassIds[input.netId] == activeClass)
  ) {
    let pulse = 0.5 + 0.5 * sin(uniforms.animation.x * 3.4);
    return vec4f(vec3f(0.08 + pulse * 0.12, 1.0, 0.16 + pulse * 0.16) * (0.88 + pulse * 0.25), 1.0);
  }
  var color = layerColors[input.layerId];
  if (colorMode == 1u && input.netId != 0u) { color = netColors[input.netId]; }
  if (colorMode == 2u && activeNet != 0u && input.netId != activeNet) { color = vec4f(color.rgb * 0.18, 1.0); }
  if (input.featureId == selectedFeature) { color = vec4f(1.0, 0.78, 0.18, 1.0); }
  return vec4f(color.rgb * shade, 1.0);
}
struct PickOutput {
  @location(0) featureId: u32,
  @location(1) worldPosition: vec4f,
}
@fragment fn pickFs(input: VertexOut) -> PickOutput {
  var out: PickOutput;
  out.featureId = input.featureId;
  out.worldPosition = vec4f(input.worldPosition, 1.0);
  return out;
}
` });
    const mainLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    const chunkLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [mainLayout, chunkLayout] });
    const vertexLayout = {
      arrayStride: VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "unorm16x4" },
        { shaderLocation: 1, offset: 8, format: "snorm8x4" },
        { shaderLocation: 2, offset: 12, format: "uint32" },
      ],
    };
    const instanceLayout = {
      arrayStride: INSTANCE_STRIDE,
      stepMode: "instance",
      attributes: [
        { shaderLocation: 3, offset: 0, format: "float32x4" },
        { shaderLocation: 4, offset: 16, format: "float32x4" },
        { shaderLocation: 5, offset: 32, format: "float32x4" },
        { shaderLocation: 6, offset: 48, format: "float32x4" },
        { shaderLocation: 7, offset: 64, format: "uint32" },
      ],
    };
    const descriptor = {
      layout,
      vertex: { module: shader, entryPoint: "vs", buffers: [vertexLayout] },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format: canvasFormat }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    };
    mainPipeline = device.createRenderPipeline(descriptor);
    pickPipeline = device.createRenderPipeline({
      ...descriptor,
      fragment: { module: shader, entryPoint: "pickFs", targets: [{ format: "r32uint" }, { format: "rgba32float" }] },
    });
    componentPipeline = device.createRenderPipeline({
      ...descriptor,
      vertex: { module: shader, entryPoint: "instanceVs", buffers: [vertexLayout, instanceLayout] },
    });
    componentPickPipeline = device.createRenderPipeline({
      ...descriptor,
      vertex: { module: shader, entryPoint: "instanceVs", buffers: [vertexLayout, instanceLayout] },
      fragment: { module: shader, entryPoint: "pickFs", targets: [{ format: "r32uint" }, { format: "rgba32float" }] },
    });
    return mainLayout;
  }

  function drawPass(encoder, target, depth, picking = false) {
    const colorAttachments = [{
      view: picking ? target.feature : target,
      clearValue: picking ? { r: 0, g: 0, b: 0, a: 0 } : { r: 0.92, g: 0.94, b: 0.95, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }];
    if (picking) {
      colorAttachments.push({
        view: target.position,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      });
    }
    const pass = encoder.beginRenderPass({
      colorAttachments,
      depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    pass.setBindGroup(0, mainBindGroup);
    const entries = visibleEntries();
    let draws = 0;
    for (const entry of entries) {
      const resident = scene.resident.get(entry.id);
      if (!resident) continue;
      pass.setPipeline(picking ? pickPipeline : mainPipeline);
      pass.setBindGroup(1, resident.bindGroup);
      pass.setVertexBuffer(0, resident.vertexBuffer);
      pass.setIndexBuffer(resident.indexBuffer, resident.indexFormat || "uint16");
      pass.drawIndexed(resident.indexCount);
      draws += 1;
    }
    if (!state.orthoLocked && state.showComponents) {
      for (const resident of scene.componentResident) {
        if (!resident) continue;
        pass.setPipeline(picking ? componentPickPipeline : componentPipeline);
        pass.setBindGroup(1, resident.bindGroup);
        pass.setVertexBuffer(0, resident.vertexBuffer);
        pass.setVertexBuffer(1, resident.instanceBuffer);
        pass.setIndexBuffer(resident.indexBuffer, "uint16");
        pass.drawIndexed(resident.indexCount, resident.instanceCount);
        draws += 1;
      }
    }
    pass.end();
    scene.drawCalls = draws;
  }

  function draw() {
    resizeCanvas();
    writeUniforms();
    const encoder = device.createCommandEncoder();
    drawPass(encoder, context.getCurrentTexture().createView(), depthTexture.createView());
    device.queue.submit([encoder.finish()]);
    state.frameCount += 1;
    const now = performance.now();
    if (now - state.lastFpsTime > 500) {
      state.fps = state.frameCount * 1000 / (now - state.lastFpsTime);
      state.frameCount = 0;
      state.lastFpsTime = now;
      updateDiagnostics();
    }
    requestAnimationFrame(draw);
  }

  async function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width * 2 - 1;
    const y = 1 - (clientY - rect.top) / rect.height * 2;
    const scaleX = canvas.width;
    const scaleY = canvas.height;
    const pickTransform = [
      scaleX, 0, 0, 0,
      0, scaleY, 0, 0,
      0, 0, 1, 0,
      -x * scaleX, -y * scaleY, 0, 1,
    ];
    writeUniforms(multiply(pickTransform, makeCamera(canvas.width, canvas.height)));
    const encoder = device.createCommandEncoder();
    drawPass(
      encoder,
      { feature: pickTexture.createView(), position: pickPositionTexture.createView() },
      pickDepthTexture.createView(),
      true,
    );
    encoder.copyTextureToBuffer(
      { texture: pickTexture },
      { buffer: pickReadBuffer, bytesPerRow: 256 },
      { width: 1, height: 1 },
    );
    encoder.copyTextureToBuffer(
      { texture: pickPositionTexture },
      { buffer: pickPositionReadBuffer, bytesPerRow: 256 },
      { width: 1, height: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await Promise.all([
      pickReadBuffer.mapAsync(GPUMapMode.READ),
      pickPositionReadBuffer.mapAsync(GPUMapMode.READ),
    ]);
    const id = new DataView(pickReadBuffer.getMappedRange()).getUint32(0, true);
    state.lastPickId = id;
    const positionView = new DataView(pickPositionReadBuffer.getMappedRange());
    const worldPosition = [
      positionView.getFloat32(0, true),
      positionView.getFloat32(4, true),
      positionView.getFloat32(8, true),
    ];
    pickReadBuffer.unmap();
    pickPositionReadBuffer.unmap();
    return { featureId: id, worldPosition };
  }

  function bindPointerControls() {
    canvas.addEventListener("pointerdown", (event) => {
      state.dragging = true;
      state.dragStartX = event.clientX;
      state.dragStartY = event.clientY;
      state.startPanX = state.panX;
      state.startPanY = state.panY;
      state.startYaw = state.yaw;
      state.startPitch = state.pitch;
      state.dragButton = event.button;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!state.dragging) return;
      const dx = event.clientX - state.dragStartX;
      const dy = event.clientY - state.dragStartY;
      const panGesture = state.orthoLocked
        || state.cameraTool === "pan"
        || event.shiftKey
        || state.dragButton === 1
        || state.dragButton === 2;
      if (panGesture) {
        state.panX = state.startPanX + dx;
        state.panY = state.startPanY + dy;
      } else {
        state.yaw = state.startYaw + dx * 0.008;
        state.pitch = Math.max(-1.2, Math.min(1.35, state.startPitch + dy * 0.006));
      }
    });
    canvas.addEventListener("pointerup", async (event) => {
      const moved = Math.abs(event.clientX - state.dragStartX) + Math.abs(event.clientY - state.dragStartY);
      state.dragging = false;
      if (moved < 5) await setSelection(await pick(event.clientX, event.clientY));
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      state.zoom = Math.max(0.15, Math.min(80, state.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    }, { passive: false });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  async function run() {
    if (!navigator.gpu) throw new Error("WebGPU is not available in this browser");
    await loadManifest();
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter was available");
    device = await adapter.requestDevice();
    context = canvas.getContext("webgpu");
    canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: canvasFormat, alphaMode: "opaque" });

    uniformBuffer = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    featureBuffer = createMappedBuffer(new Uint8Array(scene.featureGpuData.buffer), GPUBufferUsage.STORAGE);
    layerColorBuffer = createMappedBuffer(new Uint8Array(colorArray(scene.layers, [0.6, 0.6, 0.6, 1]).buffer), GPUBufferUsage.STORAGE);
    netColorBuffer = createMappedBuffer(new Uint8Array(colorArray(scene.nets, [0.8, 0.5, 0.2, 1]).buffer), GPUBufferUsage.STORAGE);
    netClassBuffer = createMappedBuffer(new Uint8Array(scene.netClassIds.buffer), GPUBufferUsage.STORAGE);
    layerOffsetBuffer = createMappedBuffer(new Uint8Array(layerOffsets().buffer), GPUBufferUsage.STORAGE);
    const mainLayout = createPipelines();
    mainBindGroup = device.createBindGroup({
      layout: mainLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: featureBuffer } },
        { binding: 2, resource: { buffer: layerColorBuffer } },
        { binding: 3, resource: { buffer: netColorBuffer } },
        { binding: 4, resource: { buffer: layerOffsetBuffer } },
        { binding: 5, resource: { buffer: netClassBuffer } },
      ],
    });
    pickTexture = device.createTexture({ size: [1, 1], format: "r32uint", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    pickPositionTexture = device.createTexture({ size: [1, 1], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    pickDepthTexture = device.createTexture({ size: [1, 1], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    pickReadBuffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    pickPositionReadBuffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    resizeCanvas();
    bindPointerControls();
    renderControls();
    await loadActiveScene();
    requestAnimationFrame(draw);
  }

  run().catch((error) => {
    fallbackEl.hidden = false;
    fallbackEl.textContent = `Packed renderer unavailable: ${error.message}`;
    statusEl.textContent = "Renderer failed";
    console.error(error);
  });
})();
