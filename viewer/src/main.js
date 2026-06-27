import { CameraController } from "./camera.js";
import { loadGltf } from "./gltf-loader.js";
import { clamp } from "./math.js";
import { Renderer } from "./renderer.js";
import { SchematicWorldRenderer } from "./schematic-world-renderer.js";
import { SvgDomSchematicRenderer } from "./svg-dom-schematic-renderer.js";

const COPPER_TILE_GPU_BUDGET_BYTES = 72 * 1024 * 1024;
const COPPER_TILE_PREFETCH_MARGIN = 0.35;
const TILE_SCHEDULER_INTERVAL_MS = 120;
const MAX_TILE_LOADS_PER_TICK = 12;
const INTERACTIVE_TILE_LOADS_PER_TICK = 48;
const COMPARE_REVEAL_DURATION_MS = 230;
const TILE_VERTEX_STRIDE_BYTES = 40;
const TILE_INDEX_BYTES = 4;

const topology = window.__TOPOLOGY__ || {};
const semanticGeometry = window.__SEMANTIC_GEOMETRY__ || {};
const appEl = document.getElementById("app");
const canvas = document.getElementById("viewport");
const schematicCanvas = document.getElementById("schematic-viewport");
const schematicDomLayer = document.getElementById("schematic-dom-layer");
const schematicFlowOverlay = document.getElementById("schematic-flow-overlay");
const statusEl = document.getElementById("status");
const viewerKindEl = document.getElementById("viewer-kind");
const selectionEl = document.getElementById("selection");
const diagnosticsEl = document.getElementById("diagnostics");
const layersEl = document.getElementById("layers");
const searchControlsEl = document.getElementById("search-controls");
const viewControlsEl = document.getElementById("view-controls");
const fallbackEl = document.getElementById("fallback");
const labelsEl = document.getElementById("panel-labels");
const schematicLabelsEl = document.getElementById("schematic-labels");
const gizmo = document.getElementById("axis-gizmo");
const selectionCardEl = document.getElementById("selection-card");
const primaryHeadingEl = document.getElementById("primary-heading");
const primaryDescriptionEl = document.getElementById("primary-description");

const state = {
  workspace: "pcb",
  mode: "3d",
  cameraTool: "orbit",
  compareLayers: new Set(),
  desiredCompareLayers: new Set(),
  visible3dLayers: new Set(),
  activeNetId: 0,
  selectedFeatureId: 0,
  selectionAnchor: null,
  showBoard: true,
  showComponents: true,
  isolateNet: false,
  separation: 0,
  dragging: false,
  dragMode: "orbit",
  lastX: 0,
  lastY: 0,
  pointerStartX: 0,
  pointerStartY: 0,
  loadedBytes: 0,
  triangles: 0,
  residentTileBytes: 0,
  residentTileGpuBytes: 0,
  residentTileTriangles: 0,
  tileLoads: 0,
  tileEvictions: 0,
  tileSchedulerMs: 0,
  lastTileScheduleAt: 0,
  visibleTileIds: new Set(),
  frameCpuMs: 0,
  frameCpuP95Ms: 0,
  frameIntervalMs: 0,
  frameIntervalP95Ms: 0,
  frameSamples: [],
  fps: 0,
  frames: 0,
  fpsAt: performance.now(),
  activeTab: "layers",
  selectedPageId: "",
  selectedSchematicFeature: null,
  schematicDragging: false,
  schematicLastX: 0,
  schematicLastY: 0,
  schematicStartX: 0,
  schematicStartY: 0,
};

const scene = {
  manifest: null,
  manifestUrl: "",
  layers: [],
  copperLayers: [],
  nets: [],
  features: new Map(),
  tiles: new Map(),
  loaded: new Set(),
  loading: new Map(),
  failed: new Map(),
  residentTiles: new Map(),
  componentFeatures: new Map(),
  layerZOffsets: new Float32Array(256),
  layerZOffsetSignature: "",
};

const compareAnimation = {
  key: "",
  started: 0,
  from: new Map(),
  current: new Map(),
};
const compareTransition = {
  phase: "idle",
  previous: new Set(),
  target: new Set(),
  previousOffsets: new Map(),
  started: 0,
};
const schematicScene = {
  manifest: null,
  manifestUrl: "",
  pages: [],
  byId: new Map(),
  activeNetUid: "",
  visiblePages: [],
  fitted: false,
  rendererMode: new URLSearchParams(location.search).get("schematicRenderer") || "svg-dom",
  domFallbackReason: "",
};
let gizmoHits = [];

let renderer;
let schematicRenderer;
let schematicDomRenderer;
let camera;
let panel;
let compareOffsets = new Map();
let lastFrame = performance.now();

boot().catch((error) => {
  console.error(error);
  statusEl.textContent = "Renderer failed";
  fallbackEl.hidden = false;
  fallbackEl.textContent = error.stack || error.message || String(error);
});

async function boot() {
  const manifestPath = semanticGeometry.assets?.scene_manifest || semanticGeometry.semantic_gltf?.path;
  if (!manifestPath) throw new Error("This bundle does not contain prism.semantic_gltf_a0");
  scene.manifestUrl = new URL(manifestPath, location.href).toString();
  scene.manifest = await fetchJson(scene.manifestUrl);
  if (scene.manifest.schema !== "prism.semantic_gltf_a0") {
    throw new Error(`Unsupported scene schema: ${scene.manifest.schema}`);
  }

  scene.layers = scene.manifest.layers || [];
  scene.copperLayers = scene.layers.filter(
    (layer) => layer.role === "copper" || String(layer.name).endsWith(".Cu"),
  );
  scene.nets = scene.manifest.nets || [];
  for (const feature of scene.manifest.objectFeatures || []) {
    scene.features.set(Number(feature.id), { ...feature, bounds: runtimeBounds(feature.boundsMm) });
  }
  for (const component of scene.manifest.components || []) {
    scene.componentFeatures.set(component.designator, component);
    scene.features.set(Number(component.featureId), {
      ...component,
      kind: "component",
      sourceUid: component.uid,
      netId: 0,
      bounds: null,
    });
  }
  for (const tile of scene.manifest.tiles || []) scene.tiles.set(tile.id, tile);

  const first = scene.copperLayers[0];
  if (first) {
    state.compareLayers.add(Number(first.id));
    state.desiredCompareLayers.add(Number(first.id));
    for (const layer of scene.copperLayers) state.visible3dLayers.add(Number(layer.id));
  }

  renderer = await Renderer.create(canvas);
  camera = new CameraController(runtimeBoundsFromGltf(scene.manifest.bbox));
  renderer.setBarrels(scene.manifest.barrels || []);
  await loadBoard();
  await loadSchematicWorld();
  renderControls();
  bindInteractions();
  bindSchematicInteractions();
  bindWorkspaceTabs();
  bindPanelTabs();
  statusEl.textContent = "WebGPU semantic glTF active";
  void loadComponents();
  scheduleTileResidency(performance.now(), { force: true });
  requestAnimationFrame(frame);
}

async function loadSchematicWorld() {
  const nativePath = semanticGeometry.assets?.schematic_native_manifest
    || semanticGeometry.schematic_vector?.path
    || semanticGeometry.schematic_scene?.path;
  const fallbackPath = semanticGeometry.assets?.schematic_manifest
    || semanticGeometry.schematic_world?.path;
  const tab = document.querySelector("[data-workspace=schematic]");
  if (!nativePath && !fallbackPath) {
    tab.disabled = true;
    tab.title = "No schematic world assets are available";
    return;
  }
  const candidates = [nativePath, fallbackPath].filter(Boolean);
  let lastError = null;
  for (const path of candidates) {
    try {
      schematicScene.manifestUrl = new URL(path, location.href).toString();
      schematicRenderer = await SchematicWorldRenderer.create(schematicCanvas, schematicScene.manifestUrl);
      schematicRenderer.setFlowOverlayCanvas(schematicFlowOverlay);
      break;
    } catch (error) {
      lastError = error;
      schematicRenderer = null;
      if (path === fallbackPath) throw error;
    }
  }
  if (!schematicRenderer) throw lastError || new Error("Failed to load schematic viewer assets");
  schematicScene.manifest = schematicRenderer.manifest;
  schematicScene.pages = schematicRenderer.pages;
  schematicScene.byId = new Map(schematicScene.pages.map((page) => [page.id, page]));
  state.selectedPageId = schematicScene.pages[0]?.id || "";
  schematicRenderer.selectedPageId = state.selectedPageId;
  const svgDomEnabled = !["native", "legacy", "webgpu"].includes(String(schematicScene.rendererMode).toLowerCase());
  if (svgDomEnabled) {
    schematicDomRenderer = SvgDomSchematicRenderer.create(
      schematicDomLayer,
      schematicScene.manifestUrl,
      schematicScene.manifest,
      schematicRenderer.featuresByPage,
      {
        onSelect: selectSchematicDomSelection,
        onBlank: clearSchematicSelection,
        onHighlightNet: highlightSchematicNetByUid,
        onOpenPage: openSchematicDomTarget,
        onFallback: (reason) => {
          schematicScene.domFallbackReason = reason;
          console.warn(reason);
        },
      },
    );
    void schematicDomRenderer.preloadPages(schematicScene.pages);
  }
  void schematicRenderer.preloadOverview();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "default" });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return response.json();
}

async function loadLayer(layerId) {
  await Promise.all(tilesForLayer(layerId).map((tile) => loadTile(tile)));
}

async function loadTile(tile) {
  const resident = scene.residentTiles.get(tile.id);
  if (resident) {
    resident.lastUsed = performance.now();
    return;
  }
  if (scene.loading.has(tile.id)) return scene.loading.get(tile.id);
  const promise = (async () => {
    try {
      const loaded = await loadGltf(new URL(tile.path, scene.manifestUrl).toString());
      state.loadedBytes += loaded.byteLength;
      const layer = scene.layers.find((item) => Number(item.id) === Number(tile.layerId));
      const entries = [];
      let triangles = 0;
      let gpuBytes = 0;
      for (const primitive of loaded.primitives) {
        const entry = renderer.addPrimitive(primitive, {
          kind: "copper",
          tileId: tile.id,
          layerId: Number(tile.layerId),
          color: layerColor(layer),
          baseZ: Number(layer?.z_mm || 0) / 1000,
          material: { baseColor: [1, 1, 1, 1], metallic: 0.78, roughness: 0.32 },
        });
        entries.push(entry);
        triangles += primitive.indices.length / 3;
        gpuBytes += estimatePrimitiveGpuBytes(primitive);
      }
      const record = {
        tile,
        entries,
        byteLength: loaded.byteLength,
        gpuBytes,
        triangles,
        lastUsed: performance.now(),
        pinned: false,
      };
      scene.residentTiles.set(tile.id, record);
      scene.loaded.add(tile.id);
      state.tileLoads += 1;
      state.residentTileBytes += loaded.byteLength;
      state.residentTileGpuBytes += gpuBytes;
      state.residentTileTriangles += triangles;
      state.triangles = state.residentTileTriangles;
      scene.failed.delete(tile.id);
    } catch (error) {
      const previous = scene.failed.get(tile.id) || { count: 0, message: "" };
      scene.failed.set(tile.id, { count: previous.count + 1, message: error?.message || String(error) });
      console.warn(`Failed to load tile ${tile.id}`, error);
      throw error;
    } finally {
      scene.loading.delete(tile.id);
    }
  })();
  scene.loading.set(tile.id, promise);
  return promise;
}

function tilesForLayer(layerId) {
  return [...scene.tiles.values()].filter((tile) => Number(tile.layerId) === Number(layerId));
}

function estimatePrimitiveGpuBytes(primitive) {
  return (primitive.position.length / 3) * TILE_VERTEX_STRIDE_BYTES + primitive.indices.length * TILE_INDEX_BYTES;
}

function evictTile(tileId) {
  const record = scene.residentTiles.get(tileId);
  if (!record) return;
  renderer.removeEntries(record.entries);
  scene.residentTiles.delete(tileId);
  scene.loaded.delete(tileId);
  state.residentTileBytes = Math.max(0, state.residentTileBytes - record.byteLength);
  state.residentTileGpuBytes = Math.max(0, state.residentTileGpuBytes - record.gpuBytes);
  state.residentTileTriangles = Math.max(0, state.residentTileTriangles - record.triangles);
  state.triangles = state.residentTileTriangles;
  state.tileEvictions += 1;
}

function scheduleTileResidency(now = performance.now(), options = {}) {
  if (!renderer || !camera || state.workspace !== "pcb") return;
  const interactiveComparePreload = state.mode === "layer" && compareTransition.phase === "preload";
  if (!options.force && !interactiveComparePreload && now - state.lastTileScheduleAt < TILE_SCHEDULER_INTERVAL_MS) return;
  const started = performance.now();
  state.lastTileScheduleAt = now;
  const needed = neededTileIdsForView();
  state.visibleTileIds = needed;
  const activeLoads = scene.loading.size;
  const maxLoads = interactiveComparePreload ? INTERACTIVE_TILE_LOADS_PER_TICK : MAX_TILE_LOADS_PER_TICK;
  const loadBudget = Math.max(0, maxLoads - activeLoads);
  const missing = [...needed]
    .map((tileId) => scene.tiles.get(tileId))
    .filter((tile) => tile && !scene.residentTiles.has(tile.id) && !scene.loading.has(tile.id))
    .sort((a, b) => tileDistanceToFocus(a) - tileDistanceToFocus(b))
    .slice(0, loadBudget);
  for (const tile of missing) void loadTile(tile);
  for (const tileId of needed) {
    const record = scene.residentTiles.get(tileId);
    if (record) record.lastUsed = now;
  }
  evictUnneededTiles(needed);
  state.tileSchedulerMs = performance.now() - started;
}

function neededTileIdsForView() {
  const needed = new Set();
  const visibleLayers = state.mode === "3d" ? state.visible3dLayers : compareResidencyLayers();
  if (!visibleLayers.size || !panel) return needed;

  if (state.mode === "layer") {
    for (const tile of scene.tiles.values()) {
      if (visibleLayers.has(Number(tile.layerId))) needed.add(tile.id);
    }
    return needed;
  }

  const activeNetTiles = new Set();
  if (state.activeNetId) {
    for (const tile of scene.tiles.values()) {
      if (visibleLayers.has(Number(tile.layerId)) && tileHasNet(tile, state.activeNetId)) {
        activeNetTiles.add(tile.id);
      }
    }
  }
  for (const tile of scene.tiles.values()) {
    if (!visibleLayers.has(Number(tile.layerId))) continue;
    const offset = state.mode === "layer" ? compareOffsets.get(Number(tile.layerId)) : null;
    if (tileIntersectsView(tile, panel.matrix, offset, COPPER_TILE_PREFETCH_MARGIN)) needed.add(tile.id);
  }
  for (const tileId of activeNetTiles) needed.add(tileId);
  return needed;
}

function compareResidencyLayers() {
  if (state.mode !== "layer") return state.compareLayers;
  if (compareTransition.phase === "idle") return state.compareLayers;
  return unionSets(compareTransition.previous, compareTransition.target);
}

function compareRenderLayers() {
  if (state.mode !== "layer") return state.visible3dLayers;
  if (compareTransition.phase === "reveal") return unionSets(compareTransition.previous, compareTransition.target);
  return state.compareLayers;
}

function unionSets(...sets) {
  const output = new Set();
  for (const set of sets) {
    for (const value of set || []) output.add(Number(value));
  }
  return output;
}

function evictUnneededTiles(needed) {
  const budget = COPPER_TILE_GPU_BUDGET_BYTES;
  if (state.residentTileGpuBytes <= budget) return;
  const candidates = [...scene.residentTiles.values()]
    .filter((record) => !needed.has(record.tile.id) && !scene.loading.has(record.tile.id))
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const record of candidates) {
    if (state.residentTileGpuBytes <= budget) break;
    evictTile(record.tile.id);
  }
}

function tileIntersectsView(tile, matrix, offset = null, marginScale = 0) {
  const bounds = tileRuntimeBounds(tile);
  if (!bounds) return true;
  const margin = Math.max(bounds[3] - bounds[0], bounds[4] - bounds[1]) * marginScale;
  const expanded = [
    bounds[0] - margin + (offset?.[0] || 0),
    bounds[1] - margin + (offset?.[1] || 0),
    bounds[2] - 0.002,
    bounds[3] + margin + (offset?.[0] || 0),
    bounds[4] + margin + (offset?.[1] || 0),
    bounds[5] + 0.002,
  ];
  return boundsIntersectsClip(expanded, matrix);
}

function tileRuntimeBounds(tile) {
  const bounds = tile.boundsMm;
  if (!bounds || bounds.length !== 4) return null;
  const layer = scene.layers.find((item) => Number(item.id) === Number(tile.layerId));
  const z = Number(layer?.z_mm || 0) / 1000;
  return [
    bounds[0] / 1000,
    -bounds[3] / 1000,
    z - 0.0004,
    bounds[2] / 1000,
    -bounds[1] / 1000,
    z + 0.0004,
  ];
}

function boundsIntersectsClip(bounds, matrix) {
  const corners = [
    [bounds[0], bounds[1], bounds[2]],
    [bounds[3], bounds[1], bounds[2]],
    [bounds[0], bounds[4], bounds[2]],
    [bounds[3], bounds[4], bounds[2]],
    [bounds[0], bounds[1], bounds[5]],
    [bounds[3], bounds[1], bounds[5]],
    [bounds[0], bounds[4], bounds[5]],
    [bounds[3], bounds[4], bounds[5]],
  ].map((point) => clipPoint(matrix, point));
  const planes = [
    (point) => point[0] < -point[3],
    (point) => point[0] > point[3],
    (point) => point[1] < -point[3],
    (point) => point[1] > point[3],
    (point) => point[2] < 0,
    (point) => point[2] > point[3],
  ];
  return !planes.some((outside) => corners.every(outside));
}

function clipPoint(matrix, point) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15],
  ];
}

function tileHasNet(tile, netId) {
  return Array.isArray(tile.netIds) && tile.netIds.some((value) => Number(value) === Number(netId));
}

function tileDistanceToFocus(tile) {
  const bounds = tileRuntimeBounds(tile);
  if (!bounds || !camera) return 0;
  const x = (bounds[0] + bounds[3]) * 0.5 - camera.focus[0];
  const y = (bounds[1] + bounds[4]) * 0.5 - camera.focus[1];
  return x * x + y * y;
}

async function loadBoard() {
  const path = semanticGeometry.assets?.base_board_glb;
  if (!path) return;
  const loaded = await loadGltf(new URL(path, location.href).toString(), { defaultFeatureId: 0 });
  state.loadedBytes += loaded.byteLength;
  const contextPrimitives = loaded.primitives.filter((primitive) => boardRole(primitive) !== "pad");
  for (const primitive of mergePrimitivesByMaterial(contextPrimitives, boardRole)) {
    renderer.addPrimitive(primitive, {
      kind: "board",
      boardRole: primitive.groupKey,
      layerId: 0,
      material: primitive.material,
      color: primitive.material.baseColor,
    });
  }
}

function boardRole(primitive) {
  const name = `${primitive.nodeName || ""} ${primitive.meshName || ""} ${primitive.material?.name || ""}`.toLowerCase();
  if (name.includes("_pad") || name.includes(".pad") || name.endsWith("pad")) return "pad";
  if (name.includes("silkscreen")) return "silkscreen";
  if (name.includes("soldermask")) return "soldermask";
  return "substrate";
}

async function loadComponents() {
  const path = semanticGeometry.assets?.components_glb;
  if (!path) return;
  const loaded = await loadGltf(new URL(path, location.href).toString(), {
    componentFeatures: scene.componentFeatures,
  });
  state.loadedBytes += loaded.byteLength;
  for (const primitive of loaded.primitives) {
    const component = scene.componentFeatures.get(primitive.designator);
    if (component) mergeFeatureBounds(component.featureId, primitive.position);
  }
  for (const primitive of mergePrimitivesByMaterial(loaded.primitives)) {
    renderer.addPrimitive(primitive, {
      kind: "component",
      layerId: 0,
      material: primitive.material,
      color: primitive.material.baseColor,
    });
  }
}

function mergePrimitivesByMaterial(primitives, classifier = () => "") {
  const groups = new Map();
  for (const primitive of primitives) {
    const groupKey = classifier(primitive);
    const key = `${groupKey}:${JSON.stringify(primitive.material)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(primitive);
  }
  return [...groups.values()].map((group) => {
    const vertexCount = group.reduce((sum, item) => sum + item.position.length / 3, 0);
    const indexCount = group.reduce((sum, item) => sum + item.indices.length, 0);
    const position = new Float32Array(vertexCount * 3);
    const normal = new Float32Array(vertexCount * 3);
    const netId = new Uint32Array(vertexCount);
    const objectFeatureId = new Uint32Array(vertexCount);
    const indices = new Uint32Array(indexCount);
    let vertexOffset = 0;
    let indexOffset = 0;
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const item of group) {
      const count = item.position.length / 3;
      position.set(item.position, vertexOffset * 3);
      normal.set(item.normal, vertexOffset * 3);
      netId.set(item.netId, vertexOffset);
      objectFeatureId.set(item.objectFeatureId, vertexOffset);
      for (let index = 0; index < item.indices.length; index += 1) {
        indices[indexOffset + index] = Number(item.indices[index]) + vertexOffset;
      }
      if (item.bounds) {
        bounds[0] = Math.min(bounds[0], item.bounds[0]);
        bounds[1] = Math.min(bounds[1], item.bounds[1]);
        bounds[2] = Math.min(bounds[2], item.bounds[2]);
        bounds[3] = Math.max(bounds[3], item.bounds[3]);
        bounds[4] = Math.max(bounds[4], item.bounds[4]);
        bounds[5] = Math.max(bounds[5], item.bounds[5]);
      }
      vertexOffset += count;
      indexOffset += item.indices.length;
    }
    return {
      position,
      normal,
      netId,
      objectFeatureId,
      indices,
      material: group[0].material,
      groupKey: classifier(group[0]),
      bounds: Number.isFinite(bounds[0]) ? bounds : null,
    };
  });
}

function runtimeBounds(bounds) {
  if (!bounds || bounds.length !== 6) return null;
  return [
    bounds[0] / 1000,
    -bounds[4] / 1000,
    bounds[2] / 1000,
    bounds[3] / 1000,
    -bounds[1] / 1000,
    bounds[5] / 1000,
  ];
}

function runtimeBoundsFromGltf(bounds) {
  const minimum = bounds?.min || [0, 0, 0];
  const maximum = bounds?.max || [0.08, 0.0016, 0.05];
  return [minimum[0], -maximum[2], minimum[1], maximum[0], -minimum[2], maximum[1]];
}

function mergeFeatureBounds(featureId, positions) {
  const feature = scene.features.get(Number(featureId));
  if (!feature || !positions.length) return;
  const incoming = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    incoming[0] = Math.min(incoming[0], positions[index]);
    incoming[1] = Math.min(incoming[1], positions[index + 1]);
    incoming[2] = Math.min(incoming[2], positions[index + 2]);
    incoming[3] = Math.max(incoming[3], positions[index]);
    incoming[4] = Math.max(incoming[4], positions[index + 1]);
    incoming[5] = Math.max(incoming[5], positions[index + 2]);
  }
  feature.bounds = feature.bounds
    ? [
        Math.min(feature.bounds[0], incoming[0]),
        Math.min(feature.bounds[1], incoming[1]),
        Math.min(feature.bounds[2], incoming[2]),
        Math.max(feature.bounds[3], incoming[3]),
        Math.max(feature.bounds[4], incoming[4]),
        Math.max(feature.bounds[5], incoming[5]),
      ]
    : incoming;
}

function layerColor(layer) {
  const colors = {
    "F.Cu": "#a9423c",
    "B.Cu": "#315b9a",
    "In1.Cu": "#477a55",
    "In2.Cu": "#806244",
    "In3.Cu": "#347c86",
    "In4.Cu": "#685889",
    "In5.Cu": "#92793e",
  };
  const inner = ["#477a55", "#806244", "#347c86", "#685889", "#92793e", "#82556e"];
  const name = String(layer?.name || "");
  const index = Math.max(0, scene.copperLayers.findIndex((item) => item.name === name) - 1);
  return [...hex(colors[name] || inner[index % inner.length]), 1];
}

function hex(value) {
  const clean = value.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16) / 255);
}

function frame(now) {
  const frameStarted = performance.now();
  const frameInterval = Math.max(0, now - lastFrame);
  if (state.workspace === "schematic" && schematicRenderer) {
    lastFrame = now;
    const visible = schematicRenderer.visiblePages();
    const domPages = schematicDomRenderer ? schematicDomDetailPages(visible) : [];
    schematicRenderer.setDomDetailPageIds(domPages.map((page) => page.id));
    schematicScene.visiblePages = schematicRenderer.render();
    schematicDomRenderer?.syncWorldPages(domPages, schematicRenderer, { activeNetUid: schematicScene.activeNetUid });
    updateSchematicLabels();
    recordFrameSample(frameInterval, performance.now() - frameStarted);
    updateDiagnostics(now);
    requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  camera.update(dt);
  renderer.resize();
  const layerZOffsets = stackupOffsets();
  for (const entry of renderer.entries) entry.layerOffset = layerZOffsets[entry.layerId] || 0;
  updateCompareTransition(now);
  compareOffsets = updateCompareLayout(now);
  const compareAlphas = compareLayerAlphas(now);
  panel = {
    layerId: 0,
    viewport: { x: 0, y: 0, width: canvas.width, height: canvas.height },
    matrix: camera.matrix(canvas.width, canvas.height, state.mode === "layer"),
  };
  scheduleTileResidency(now);
  const visibleLayers = state.mode === "3d" ? state.visible3dLayers : compareRenderLayers();
  renderer.render({
    panels: [panel],
    activeNetId: state.activeNetId,
    selectedFeatureId: state.selectedFeatureId,
    time: now / 1000,
    layerOffsets: layerZOffsets,
    visibleLayers,
    showBoard: state.showBoard,
    showComponents: state.showComponents,
    componentOpacity: clamp(1 - state.separation / 0.1, 0, 1),
    boardOpacity: state.activeNetId ? 0.34 : 1 - state.separation * 0.72,
    isolateNet: state.isolateNet,
    compareMode: state.mode === "layer",
    compareOffsets,
    layerAlphas: compareAlphas,
    visibleTileIds: state.mode === "3d" ? state.visibleTileIds : null,
  });
  drawGizmo();
  updateLayerLabels();
  recordFrameSample(frameInterval, performance.now() - frameStarted);
  updateDiagnostics(now);
  requestAnimationFrame(frame);
}

function schematicPageScreenMetrics(page) {
  if (!schematicRenderer || !page) return { widthPx: 0, heightPx: 0, sourcePxPerMm: 0, area: 0 };
  const widthPx = schematicRenderer.pagePixelWidth(page);
  const heightPx = page.heightMm / Math.max(1e-6, schematicRenderer.scale);
  const sourcePxPerMm = schematicRenderer.pageSourcePixelsPerMm(page);
  return { widthPx, heightPx, sourcePxPerMm, area: widthPx * heightPx };
}

function schematicDomDetailPages(visiblePages) {
  if (!schematicDomRenderer || !schematicRenderer) return [];
  const visible = visiblePages || [];
  const viewportArea = Math.max(1, schematicCanvas.clientWidth * schematicCanvas.clientHeight);
  const detail = visible
    .map((page) => ({ page, ...schematicPageScreenMetrics(page) }))
    .filter((item) =>
      item.widthPx >= 760
      && item.heightPx >= 520
      && item.area >= viewportArea * 0.36
      && item.sourcePxPerMm >= 1.25)
    .sort((a, b) => b.area - a.area);
  const maxMounted = 1;
  return detail.slice(0, maxMounted).map((item) => item.page);
}

function stackupOffsets() {
  const bbox = scene.manifest.bbox;
  const diagonal = Math.hypot(
    (bbox.max[0] - bbox.min[0]) * 1000,
    (bbox.max[2] - bbox.min[2]) * 1000,
  );
  const gap = state.separation * state.separation * clamp(diagonal * 0.12, 8, 25) / 1000;
  const signature = `${state.separation}:${gap}:${scene.copperLayers.length}`;
  if (scene.layerZOffsetSignature === signature) return scene.layerZOffsets;
  const output = scene.layerZOffsets;
  output.fill(0);
  const middle = (scene.copperLayers.length - 1) / 2;
  scene.copperLayers.forEach((layer, index) => {
    output[Number(layer.id)] = (middle - index) * gap;
  });
  scene.layerZOffsetSignature = signature;
  return output;
}

function updateCompareLayout(now) {
  if (state.mode !== "layer") {
    compareAnimation.key = "3d";
    compareAnimation.current.clear();
    return new Map();
  }
  const selected = scene.copperLayers.filter((layer) => state.compareLayers.has(Number(layer.id)));
  const count = Math.max(1, selected.length);
  const aspect = canvas.width / Math.max(1, canvas.height);
  let columns = 1;
  if (count === 2) columns = aspect >= 1 ? 2 : 1;
  else if (count === 3 || count === 4) columns = 2;
  else if (count > 4) columns = Math.ceil(Math.sqrt(count * aspect));
  const rows = Math.ceil(count / columns);
  const bounds = runtimeBoundsFromGltf(scene.manifest.bbox);
  const boardWidth = bounds[3] - bounds[0];
  const boardHeight = bounds[4] - bounds[1];
  const pitchX = boardWidth * 1.18;
  const pitchY = boardHeight * 1.22;
  const targets = selected.map((layer, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      layer,
      layerId: Number(layer.id),
      column,
      row,
      offset: [
        (column - (columns - 1) / 2) * pitchX,
        ((rows - 1) / 2 - row) * pitchY,
        0,
      ],
    };
  });
  const key = `${columns}x${rows}:${targets.map((item) => item.layerId).join(",")}`;
  if (key !== compareAnimation.key) {
    compareAnimation.key = key;
    compareAnimation.started = now;
    compareAnimation.from = new Map(compareAnimation.current);
    const totalWidth = columns * boardWidth + (columns - 1) * (pitchX - boardWidth);
    const totalHeight = rows * boardHeight + (rows - 1) * (pitchY - boardHeight);
    camera.targetFocus = [
      (bounds[0] + bounds[3]) / 2,
      (bounds[1] + bounds[4]) / 2,
      (bounds[2] + bounds[5]) / 2,
    ];
    camera.targetOrthoScale = Math.max(totalHeight, totalWidth / aspect) * 1.08;
  }
  const progress = clamp((now - compareAnimation.started) / 420, 0, 1);
  const eased = 1 - Math.pow(1 - progress, 3);
  const offsets = new Map();
  for (const target of targets) {
    const start = compareAnimation.from.get(target.layerId) || [0, 0, 0];
    const current = target.offset.map(
      (value, index) => start[index] + (value - start[index]) * eased,
    );
    offsets.set(target.layerId, current);
    compareAnimation.current.set(target.layerId, current);
  }
  if (compareTransition.phase === "reveal") {
    for (const layerId of compareTransition.previous) {
      if (!offsets.has(Number(layerId))) {
        offsets.set(Number(layerId), compareTransition.previousOffsets.get(Number(layerId)) || [0, 0, 0]);
      }
    }
  }
  for (const layerId of [...compareAnimation.current.keys()]) {
    if (!targets.some((item) => item.layerId === layerId)) {
      compareAnimation.current.delete(layerId);
    }
  }
  return offsets;
}

function beginCompareLayerTransition(targetLayers) {
  const target = new Set([...targetLayers].map(Number));
  if (setsEqual(target, state.desiredCompareLayers) && compareTransition.phase !== "idle") return;
  state.desiredCompareLayers = target;
  if (setsEqual(target, state.compareLayers)) {
    compareTransition.phase = "idle";
    compareTransition.previous.clear();
    compareTransition.target.clear();
    return;
  }
  compareTransition.phase = "preload";
  compareTransition.previous = new Set(state.compareLayers);
  compareTransition.target = new Set(target);
  compareTransition.previousOffsets = new Map(compareAnimation.current);
  compareTransition.started = performance.now();
  scheduleTileResidency(compareTransition.started, { force: true });
}

function updateCompareTransition(now) {
  if (state.mode !== "layer" || compareTransition.phase === "idle") return;
  if (compareTransition.phase === "preload") {
    if (!compareTargetTilesReady(compareTransition.target)) {
      scheduleTileResidency(now, { force: true });
      return;
    }
    compareTransition.phase = "reveal";
    compareTransition.started = now;
    compareTransition.previousOffsets = new Map(compareAnimation.current);
    state.compareLayers = new Set(compareTransition.target);
    compareAnimation.key = "";
    return;
  }
  if (compareTransition.phase === "reveal" && now - compareTransition.started >= COMPARE_REVEAL_DURATION_MS) {
    state.compareLayers = new Set(compareTransition.target);
    compareTransition.phase = "idle";
    compareTransition.previous.clear();
    compareTransition.target.clear();
    compareTransition.previousOffsets.clear();
    scheduleTileResidency(now, { force: true });
  }
}

function compareTargetTilesReady(targetLayers) {
  for (const tile of scene.tiles.values()) {
    if (!targetLayers.has(Number(tile.layerId))) continue;
    if (!scene.residentTiles.has(tile.id) && !scene.failed.has(tile.id)) return false;
  }
  return true;
}

function compareLayerAlphas(now) {
  if (state.mode !== "layer" || compareTransition.phase !== "reveal") return null;
  const progress = clamp((now - compareTransition.started) / COMPARE_REVEAL_DURATION_MS, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  const alphas = new Map();
  for (const layerId of compareTransition.previous) {
    alphas.set(Number(layerId), compareTransition.target.has(Number(layerId)) ? 1 : 1 - eased);
  }
  for (const layerId of compareTransition.target) {
    alphas.set(Number(layerId), compareTransition.previous.has(Number(layerId)) ? 1 : eased);
  }
  return alphas;
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function renderControls() {
  if (state.workspace === "schematic") {
    renderSchematicControls();
    return;
  }
  viewerKindEl.textContent = "Semantic GLTF A0";
  primaryHeadingEl.textContent = "Layers";
  primaryDescriptionEl.textContent = "Visibility and compare";
  document.querySelector('[data-panel="search"] .section-heading span').textContent = "Nets, components and pins";
  document.querySelector('[data-panel="view"] .section-heading span').textContent = "Camera and stackup";
  layersEl.innerHTML = `
    <div class="mode-toolbar">
      <button data-mode="layer">Layer Compare</button>
      <button data-mode="3d">3D</button>
    </div>
    <div class="layer-presets">
      <button data-preset="all">All</button><button data-preset="none">None</button>
      <button data-preset="outer">Outer</button><button data-preset="inner">Inner</button>
    </div>
    <div class="layer-list"></div>`;
  searchControlsEl.innerHTML = `
    <label class="control-field"><span>Search</span>
      <input id="entity-search" class="layer-select" type="search" placeholder="Net, component or pin">
      <div id="search-results" class="search-results"></div>
    </label>
    <div class="quick-actions">
      <button id="frame-selection">Frame</button>
      <button id="show-net-layers">Net layers</button>
      <button id="isolate-net">Isolate</button>
      <button id="clear-selection">Clear</button>
    </div>`;
  viewControlsEl.innerHTML = `
    <div class="camera-toolbar mode-toolbar">
      <button data-tool="orbit">Orbit</button><button data-tool="pan">Pan</button>
    </div>
    <div class="toggle-list">
      <label class="toggle-row"><input id="show-board" type="checkbox"><span>Board substrate</span></label>
      <label class="toggle-row"><input id="show-components" type="checkbox"><span>Components</span></label>
    </div>
    <label class="control-field range-field"><span>Stackup separation</span>
      <input id="separation" type="range" min="0" max="1" step="0.002">
    </label>`;
  refreshControls();
  bindControlEvents();
}

function renderSchematicControls() {
  viewerKindEl.textContent = schematicDomRenderer
    ? "Schematic SVG DOM"
    : schematicScene.manifest?.schema === "prism.schematic_vector_a0"
    ? "Schematic Vector A0"
    : "Schematic World A0";
  primaryHeadingEl.textContent = "Pages";
  primaryDescriptionEl.textContent = `${schematicScene.pages.length} hierarchy instances`;
  document.querySelector('[data-panel="search"] .section-heading span').textContent = "Pages, nets and components";
  document.querySelector('[data-panel="view"] .section-heading span').textContent = "World navigation";
  layersEl.innerHTML = `
    <div class="layer-presets">
      <button data-page-action="world">Fit world</button>
      <button data-page-action="parent">Parent</button>
      <button data-page-action="previous">Previous</button>
      <button data-page-action="next">Next</button>
    </div>
    <div class="page-list">${schematicScene.pages.map((page) => `
      <button class="page-row ${page.id === state.selectedPageId ? "active" : ""}" data-page="${page.id}">
        <span>${page.sheetNumber}</span>
        <strong>${escapeHtml(page.name)}</strong>
        <small>L${page.depth}</small>
      </button>`).join("")}</div>`;
  searchControlsEl.innerHTML = `
    <label class="control-field"><span>Search</span>
      <input id="entity-search" class="layer-select" type="search" placeholder="Page, net or component">
      <div id="search-results" class="search-results"></div>
    </label>
    <div class="quick-actions">
      <button id="frame-selection">Frame</button>
      <button id="clear-selection">Clear</button>
    </div>`;
  viewControlsEl.innerHTML = `
    <div class="toggle-list">
      <label class="toggle-row"><input id="show-hierarchy" type="checkbox" checked><span>Hierarchy links</span></label>
    </div>
    <div class="selection-section">
      <span class="selection-section-title">Navigation</span>
      <div class="selection-table">
        <div class="selection-row"><span><strong>Home</strong></span><span>World</span><span>Frame every page</span></div>
        <div class="selection-row"><span><strong>[ / ]</strong></span><span>Pages</span><span>Previous or next instance</span></div>
        <div class="selection-row"><span><strong>Alt+Up</strong></span><span>Parent</span><span>Move up hierarchy</span></div>
      </div>
    </div>`;
  layersEl.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => selectSchematicPage(button.dataset.page, true));
  });
  layersEl.querySelectorAll("[data-page-action]").forEach((button) => {
    button.addEventListener("click", () => navigateSchematic(button.dataset.pageAction));
  });
  searchControlsEl.querySelector("#entity-search").addEventListener("input", (event) => {
    renderSchematicSearch(event.target.value);
  });
  searchControlsEl.querySelector("#frame-selection").addEventListener("click", frameSchematicSelection);
  searchControlsEl.querySelector("#clear-selection").addEventListener("click", clearSchematicSelection);
  viewControlsEl.querySelector("#show-hierarchy").checked = schematicRenderer?.showHierarchy ?? true;
  viewControlsEl.querySelector("#show-hierarchy").addEventListener("change", (event) => {
    schematicRenderer.showHierarchy = event.target.checked;
  });
}

function selectSchematicPage(pageId, shouldFrame) {
  const page = schematicScene.byId.get(pageId);
  if (!page || !schematicRenderer) return;
  state.selectedPageId = page.id;
  state.selectedSchematicFeature = null;
  schematicRenderer.selectedPageId = page.id;
  schematicRenderer.selectedFeatureId = 0;
  selectionEl.textContent = JSON.stringify(page, null, 2);
  if (shouldFrame) schematicRenderer.framePage(page);
  layersEl.querySelectorAll("[data-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page.id);
  });
}

function navigateSchematic(action) {
  if (!schematicRenderer) return;
  if (action === "world") {
    schematicRenderer.frameWorld();
    return;
  }
  const index = Math.max(0, schematicScene.pages.findIndex((page) => page.id === state.selectedPageId));
  let target = null;
  if (action === "previous") target = schematicScene.pages[(index - 1 + schematicScene.pages.length) % schematicScene.pages.length];
  else if (action === "next") target = schematicScene.pages[(index + 1) % schematicScene.pages.length];
  else if (action === "parent") target = schematicScene.byId.get(schematicScene.pages[index]?.parentId);
  if (target) selectSchematicPage(target.id, true);
}

function openSchematicDomTarget(selection) {
  if (!selection || !schematicRenderer) return;
  clearSchematicSelection();
  if (selection.kind === "page" && selection.pageId) {
    selectSchematicPage(selection.pageId, true);
    return;
  }
  if (selection.kind !== "sheet") return;
  const currentPage = schematicScene.pages.find((page) => page.sheetInstancePath === selection.sheetInstancePath)
    || schematicScene.byId.get(state.selectedPageId);
  const sheetFile = String(selection.sheetFile || selection.feature?.sheet_file || "").replace(/\\/g, "/");
  const sheetName = String(selection.sheetName || selection.feature?.sheet_name || selection.feature?.objectId || "");
  const target = schematicScene.pages.find((page) => {
    if (currentPage && page.parentId && page.parentId !== currentPage.id) return false;
    const sourcePath = String(page.sourcePath || "").replace(/\\/g, "/");
    return (sheetFile && sourcePath.endsWith(sheetFile)) || (sheetName && page.name === sheetName);
  }) || schematicScene.pages.find((page) => {
    const sourcePath = String(page.sourcePath || "").replace(/\\/g, "/");
    return (sheetFile && sourcePath.endsWith(sheetFile)) || (sheetName && page.name === sheetName);
  });
  if (target) selectSchematicPage(target.id, true);
}

function renderSchematicSearch(query) {
  const container = searchControlsEl.querySelector("#search-results");
  const value = query.trim().toLowerCase();
  if (!value) {
    container.innerHTML = "";
    return;
  }
  const pages = schematicScene.pages.filter((page) =>
    `${page.name} ${page.sheetPath}`.toLowerCase().includes(value)).slice(0, 8);
  const nets = scene.nets.filter((net) => String(net.name).toLowerCase().includes(value)).slice(0, 8);
  container.innerHTML = [
    ...pages.map((page) => `<button data-page="${page.id}"><b>${escapeHtml(page.name)}</b><span>Page ${page.sheetNumber}</span></button>`),
    ...nets.map((net) => `<button data-schematic-net="${net.id}"><b>${escapeHtml(net.name)}</b><span>${(schematicScene.manifest.netToPages?.[net.uid] || []).length} pages</span></button>`),
  ].join("");
  container.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => selectSchematicPage(button.dataset.page, true));
  });
  container.querySelectorAll("[data-schematic-net]").forEach((button) => {
    button.addEventListener("click", () => selectSchematicNet(Number(button.dataset.schematicNet), true));
  });
}

function selectSchematicNet(netId, shouldFrame) {
  const net = scene.nets.find((item) => Number(item.id) === netId);
  if (!net || !schematicRenderer) return;
  state.activeNetId = netId;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = null;
  schematicRenderer.selectedFeatureId = 0;
  schematicRenderer.selectedFeatureKey = "";
  schematicRenderer.selectedSourceId = "";
  schematicScene.activeNetUid = net.uid;
  schematicRenderer.activeNetUid = net.uid;
  schematicDomRenderer?.setHighlightedNet(net.uid);
  selectionEl.textContent = JSON.stringify(net, null, 2);
  updateSelectionCard();
  const pageIds = schematicScene.manifest.netToPages?.[net.uid] || [];
  if (shouldFrame && pageIds.length) selectSchematicPage(pageIds[0], true);
}

function highlightSchematicNetByUid(netUid, selection = null) {
  const net = scene.nets.find((item) => item.uid === netUid);
  if (!net) return;
  state.activeNetId = Number(net.id);
  schematicScene.activeNetUid = net.uid;
  if (schematicRenderer) {
    schematicRenderer.activeNetUid = net.uid;
    schematicRenderer.selectedFeatureId = Number(selection?.feature?.id || selection?.featureId || 0);
    schematicRenderer.selectedFeatureKey = selection?.feature?.stableKey || selection?.featureKey || "";
    schematicRenderer.selectedSourceId = selection?.feature?.sourceId || selection?.sourceId || "";
  }
  schematicDomRenderer?.setHighlightedNet(net.uid);
  if (selection) state.selectedSchematicFeature = { ...selection, pageId: state.selectedPageId };
  selectionEl.textContent = JSON.stringify(selection ? { ...selection, net } : net, null, 2);
  updateSelectionCard();
}

function clearSchematicSelection() {
  state.activeNetId = 0;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = null;
  schematicScene.activeNetUid = "";
  if (schematicRenderer) {
    schematicRenderer.activeNetUid = "";
    schematicRenderer.selectedFeatureId = 0;
    schematicRenderer.selectedFeatureKey = "";
    schematicRenderer.selectedSourceId = "";
  }
  schematicDomRenderer?.setSelection(null);
  schematicDomRenderer?.setHighlightedNet("");
  selectionEl.textContent = "No object selected";
  updateSelectionCard();
}

function frameSchematicSelection() {
  const page = schematicScene.byId.get(state.selectedPageId);
  if (page) schematicRenderer.framePage(page);
  else schematicRenderer.frameWorld();
}

function selectSchematicDomSelection(selection) {
  state.selectedPageId = selection.sheetInstancePath
    ? (schematicScene.pages.find((page) => page.sheetInstancePath === selection.sheetInstancePath)?.id || state.selectedPageId)
    : state.selectedPageId;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = { ...selection, pageId: state.selectedPageId };
  if (selection.anchor) state.selectionAnchor = selection.anchor;
  if (schematicRenderer) {
    schematicRenderer.selectedPageId = state.selectedPageId;
    schematicRenderer.selectedFeatureId = Number(selection.feature?.id || 0);
  }
  const net = selection.netUid ? scene.nets.find((item) => item.uid === selection.netUid) : null;
  const component = selection.reference ? scene.componentFeatures.get(selection.reference) : null;
  if (component) state.selectedFeatureId = Number(component.featureId || 0);
  selectionEl.textContent = JSON.stringify({ ...selection, net, component }, null, 2);
  updateSelectionCard();
}

function selectSchematicFeature(hit) {
  const { page, feature } = hit;
  if (!feature) {
    state.selectedSchematicFeature = null;
    schematicRenderer.selectedFeatureId = 0;
    selectSchematicPage(page.id, false);
    updateSelectionCard();
    return;
  }
  const featureId = Number(feature.id || 0);
  state.selectedPageId = page.id;
  schematicRenderer.selectedPageId = page.id;
  schematicRenderer.selectedFeatureId = featureId;
  state.selectedSchematicFeature = { ...feature, pageId: page.id };
  state.selectionAnchor = null;

  if (feature.netUid) {
    const net = scene.nets.find((item) => item.uid === feature.netUid);
    if (net) {
      selectSchematicNet(Number(net.id), false);
      state.selectedSchematicFeature = { ...feature, pageId: page.id };
      schematicRenderer.selectedFeatureId = featureId;
      return;
    }
  }
  if (feature.reference) {
    const component = scene.componentFeatures.get(feature.reference);
    if (component) {
      selectFeature(Number(component.featureId), false);
      state.selectedSchematicFeature = { ...feature, pageId: page.id };
      schematicRenderer.selectedFeatureId = featureId;
      return;
    }
  }
  state.activeNetId = 0;
  state.selectedFeatureId = 0;
  schematicRenderer.activeNetUid = "";
  selectionEl.textContent = JSON.stringify({ page: page.name, ...feature }, null, 2);
  updateSelectionCard();
}

function refreshControls() {
  layersEl.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });
  viewControlsEl.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === state.cameraTool);
  });
  viewControlsEl.querySelector("#show-board").checked = state.showBoard;
  viewControlsEl.querySelector("#show-components").checked = state.showComponents;
  viewControlsEl.querySelector("#separation").value = state.separation;
  const list = layersEl.querySelector(".layer-list");
  const selected = state.mode === "3d" ? state.visible3dLayers : state.desiredCompareLayers;
  list.innerHTML = scene.copperLayers.map((layer, index) => `
    <label class="layer-row">
      <input type="checkbox" data-layer="${layer.id}" ${selected.has(Number(layer.id)) ? "checked" : ""}>
      <span class="swatch" style="background:${rgbCss(layerColor(layer))}"></span>
      <span>${layer.name}</span><small>${index + 1}</small>
    </label>`).join("");
  list.querySelectorAll("[data-layer]").forEach((input) => input.addEventListener("change", () => {
    const layerId = Number(input.dataset.layer);
    if (state.mode === "3d") {
      input.checked ? state.visible3dLayers.add(layerId) : state.visible3dLayers.delete(layerId);
      scheduleTileResidency(performance.now(), { force: true });
    } else {
      const target = new Set(state.desiredCompareLayers);
      input.checked ? target.add(layerId) : target.delete(layerId);
      beginCompareLayerTransition(target);
    }
  }));
}

function bindControlEvents() {
  layersEl.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    if (state.mode === "layer") camera.setAxis("z", false);
    else {
      camera.frame(runtimeBoundsFromGltf(scene.manifest.bbox));
      state.visibleTileIds = new Set();
    }
    refreshControls();
    scheduleTileResidency(performance.now(), { force: true });
  }));
  layersEl.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", () => {
    const target = state.mode === "3d" ? state.visible3dLayers : new Set();
    target.clear();
    const preset = button.dataset.preset;
    for (const [index, layer] of scene.copperLayers.entries()) {
      const include = preset === "all"
        || (preset === "outer" && (index === 0 || index === scene.copperLayers.length - 1))
        || (preset === "inner" && index > 0 && index < scene.copperLayers.length - 1);
      if (include) target.add(Number(layer.id));
    }
    if (state.mode === "3d") scheduleTileResidency(performance.now(), { force: true });
    else beginCompareLayerTransition(target);
    refreshControls();
  }));
  viewControlsEl.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => {
    state.cameraTool = button.dataset.tool;
    refreshControls();
  }));
  viewControlsEl.querySelector("#show-board").addEventListener("change", (event) => {
    state.showBoard = event.target.checked;
  });
  viewControlsEl.querySelector("#show-components").addEventListener("change", (event) => {
    state.showComponents = event.target.checked;
  });
  viewControlsEl.querySelector("#separation").addEventListener("input", (event) => {
    state.separation = Number(event.target.value);
  });
  searchControlsEl.querySelector("#clear-selection").addEventListener("click", clearSelection);
  searchControlsEl.querySelector("#isolate-net").addEventListener("click", () => {
    state.isolateNet = !state.isolateNet;
    searchControlsEl.querySelector("#isolate-net").classList.toggle("active", state.isolateNet);
  });
  searchControlsEl.querySelector("#frame-selection").addEventListener("click", frameSelection);
  searchControlsEl.querySelector("#show-net-layers").addEventListener("click", showNetLayers);
  const search = searchControlsEl.querySelector("#entity-search");
  search.addEventListener("input", () => renderSearch(search.value));
}

function bindPanelTabs() {
  document.querySelectorAll(".rail-tab").forEach((button) => button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    const closing = state.activeTab === tab && !appEl.classList.contains("panel-collapsed");
    state.activeTab = tab;
    appEl.classList.toggle("panel-collapsed", closing);
    document.querySelectorAll(".rail-tab").forEach((item) => {
      item.classList.toggle("active", !closing && item.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-panel").forEach((item) => {
      item.classList.toggle("active", !closing && item.dataset.panel === tab);
    });
  }));
}

function showNetLayers() {
  const net = scene.nets.find((item) => Number(item.id) === state.activeNetId);
  if (!net) return;
  const names = new Set(net.metrics?.layers || []);
  const target = state.mode === "3d" ? state.visible3dLayers : new Set();
  target.clear();
  for (const layer of scene.copperLayers) {
    if (names.has(layer.name)) target.add(Number(layer.id));
  }
  if (state.mode === "3d") scheduleTileResidency(performance.now(), { force: true });
  else beginCompareLayerTransition(target);
  refreshControls();
}

function renderSearch(query) {
  const container = searchControlsEl.querySelector("#search-results");
  const value = query.trim().toLowerCase();
  if (!value) {
    container.innerHTML = "";
    return;
  }
  const nets = scene.nets.filter((net) => String(net.name).toLowerCase().includes(value)).slice(0, 8);
  const components = [...scene.componentFeatures.values()].filter((item) =>
    `${item.designator} ${item.value} ${item.footprint}`.toLowerCase().includes(value)).slice(0, 6);
  container.innerHTML = [
    ...nets.map((net) => `<button data-net="${net.id}"><b>${escapeHtml(net.name)}</b><span>${escapeHtml(net.netClass || "")}</span></button>`),
    ...components.map((item) => `<button data-feature="${item.featureId}"><b>${escapeHtml(item.designator)}</b><span>${escapeHtml(item.value)}</span></button>`),
  ].join("");
  container.querySelectorAll("[data-net]").forEach((button) => {
    button.addEventListener("click", () => selectNet(Number(button.dataset.net), true));
  });
  container.querySelectorAll("[data-feature]").forEach((button) => {
    button.addEventListener("click", () => selectFeature(Number(button.dataset.feature), true));
  });
}

function selectNet(netId, shouldFrame) {
  if (shouldFrame) state.selectionAnchor = null;
  state.activeNetId = netId;
  state.selectedFeatureId = 0;
  const net = scene.nets.find((item) => Number(item.id) === netId);
  if (state.workspace === "schematic" && net && schematicRenderer) {
    schematicScene.activeNetUid = net.uid;
    schematicRenderer.activeNetUid = net.uid;
  }
  selectionEl.textContent = JSON.stringify(net || {}, null, 2);
  updateSelectionCard();
  if (shouldFrame && net?.boundsMm) camera.frame(runtimeBounds(net.boundsMm));
  scheduleTileResidency(performance.now(), { force: true });
}

function selectFeature(featureId, shouldFrame = false) {
  const feature = scene.features.get(featureId);
  if (shouldFrame) state.selectionAnchor = null;
  state.selectedFeatureId = featureId;
  state.activeNetId = Number(feature?.netId || 0);
  selectionEl.textContent = feature ? JSON.stringify(feature, null, 2) : "No object selected";
  updateSelectionCard();
  if (shouldFrame && feature?.bounds) camera.frame(feature.bounds);
  scheduleTileResidency(performance.now(), { force: true });
}

function clearSelection() {
  state.activeNetId = 0;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = null;
  state.selectionAnchor = null;
  state.isolateNet = false;
  schematicScene.activeNetUid = "";
  if (schematicRenderer) schematicRenderer.activeNetUid = "";
  schematicDomRenderer?.setSelection(null);
  schematicDomRenderer?.setHighlightedNet("");
  selectionEl.textContent = "No object selected";
  updateSelectionCard();
}

function selectionProperties(items) {
  return `<div class="selection-properties">${items.map(([label, value]) => `
    <div class="selection-property">
      <small>${escapeHtml(label)}</small>
      <strong title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</strong>
    </div>`).join("")}</div>`;
}

function selectionHeader(type, title, accent) {
  return `
    <div class="selection-card-head">
      <span class="selection-card-accent" style="background:${accent}"></span>
      <div class="selection-card-title"><small>${escapeHtml(type)}</small><strong>${escapeHtml(title)}</strong></div>
      <button class="selection-card-close" type="button" aria-label="Clear selection">&times;</button>
    </div>`;
}

function netSelectionContent(net) {
  const details = topology.net_details?.[net.uid] || {};
  const terminals = details.terminals || [];
  const metrics = net.metrics || {};
  const endpointRows = terminals.length
    ? terminals.slice(0, 12).map((terminal) => `
      <div class="selection-row">
        <span><strong>${escapeHtml(terminal.designator || "?")}</strong></span>
        <span>Pin ${escapeHtml(terminal.pin || "?")}</span>
        <span title="${escapeHtml(terminal.value || "")}">${escapeHtml(terminal.value || "Component")}</span>
      </div>`).join("")
    : `<div class="selection-empty">No connected pin metadata is available.</div>`;
  return `
    ${selectionHeader("Net", net.name, "#18ef52")}
    ${selectionProperties([
      ["Class", net.netClass || "Default"],
      ["Length", `${Number(metrics.traceLengthMm || 0).toFixed(2)} mm`],
      ["Layers", (metrics.layers || []).join(", ") || "Unknown"],
    ])}
    <div class="selection-section">
      <span class="selection-section-title">Connected pins</span>
      <div class="selection-table">
        ${endpointRows}
        ${terminals.length > 12 ? `<div class="selection-empty">${terminals.length - 12} additional pins</div>` : ""}
      </div>
    </div>`;
}

function componentSelectionContent(component) {
  const meshes = component.meshNames || [];
  return `
    ${selectionHeader("Component", component.designator || "Unknown", "#3b82f6")}
    ${selectionProperties([
      ["Value", component.value || "Not specified"],
      ["Footprint", component.footprint || "Not specified"],
      ["Models", meshes.length || 0],
    ])}
    <div class="selection-section">
      <span class="selection-section-title">Component details</span>
      <div class="selection-table">
        <div class="selection-row">
          <span><strong>Reference</strong></span>
          <span>${escapeHtml(component.designator || "Unknown")}</span>
          <span title="${escapeHtml(component.uid || "")}">${escapeHtml(component.uid || "No source UID")}</span>
        </div>
        <div class="selection-row">
          <span><strong>Geometry</strong></span>
          <span>${meshes.length} ${meshes.length === 1 ? "mesh" : "meshes"}</span>
          <span title="${escapeHtml(meshes.join(", "))}">${escapeHtml(meshes.join(", ") || "No named model nodes")}</span>
        </div>
      </div>
    </div>`;
}

function schematicFeatureSelectionContent(feature, page) {
  const kind = String(feature.kind || "").toLowerCase();
  const isPin = kind.startsWith("pin");
  const isComponent = kind === "component" || kind.includes("symbol");
  if (isComponent) {
    return `
      ${selectionHeader("Component", feature.reference || feature.componentDesignator || "Unknown", "#3b82f6")}
      ${selectionProperties([
        ["Value", feature.value || feature.componentValue || "Not specified"],
        ["Footprint", feature.componentFootprint || feature.footprint || "Not specified"],
        ["Library", feature.libraryRef || "Not specified"],
        ["UID", feature.componentUid || feature.uuid || feature.sourceId || "Not resolved"],
      ])}
      <div class="selection-section">
        <span class="selection-section-title">Schematic placement</span>
        ${selectionProperties([
          ["Page", page?.name || "Unknown"],
          ["Sheet", feature.sheetInstancePath || "/"],
        ])}
      </div>`;
  }
  const pinRows = isPin
    ? [
        ["Symbol", feature.reference || feature.designator || "Unknown"],
        ["Value", feature.value || feature.componentValue || "Not specified"],
        ["Pin", `${feature.pinNumber || "-"}${feature.pinName ? ` ${feature.pinName}` : ""}`],
        ["Net", feature.netName || "Not connected"],
        ["PCB Pad", feature.pcbPadId || "Not resolved"],
        ["Component UID", feature.componentUid || "Not resolved"],
      ]
    : [
        ["Page", page?.name || "Unknown"],
        ["Kind", feature.kind.replaceAll("_", " ")],
        ["Net", feature.netName || "Not connected"],
      ];
  return `
    ${selectionHeader(
      feature.kind.replaceAll("_", " "),
      feature.pinName || feature.reference || feature.designator || feature.text || feature.netName || "Schematic object",
      "#3b82f6",
    )}
    ${selectionProperties(pinRows)}
    <div class="selection-section">
      <span class="selection-section-title">Source identity</span>
      <div class="selection-table">
        <div class="selection-row">
          <span><strong>${isPin ? "Pin UUID" : "UUID"}</strong></span>
          <span title="${escapeHtml(feature.uuid || feature.sourceId || "")}">${escapeHtml(feature.uuid || feature.sourceId || "-")}</span>
          <span title="${escapeHtml(feature.objectId || "")}">${escapeHtml(feature.objectId || "No object ID")}</span>
        </div>
        <div class="selection-row">
          <span><strong>Sheet</strong></span>
          <span>${escapeHtml(page?.name || "Unknown")}</span>
          <span title="${escapeHtml(feature.sheetInstancePath || "")}">${escapeHtml(feature.sheetInstancePath || "/")}</span>
        </div>
      </div>
    </div>`;
}

function updateSelectionCard() {
  const feature = scene.features.get(state.selectedFeatureId);
  const component = feature?.kind === "component" ? feature : null;
  const schematicFeature = state.workspace === "schematic" ? state.selectedSchematicFeature : null;
  const schematicPage = schematicFeature ? schematicScene.byId.get(schematicFeature.pageId) : null;
  const net = state.activeNetId
    ? scene.nets.find((item) => Number(item.id) === state.activeNetId)
    : null;
  if (!component && !net && !schematicFeature) {
    selectionCardEl.hidden = true;
    selectionCardEl.innerHTML = "";
    return;
  }
  selectionCardEl.innerHTML = `
    ${schematicFeature
      ? schematicFeatureSelectionContent(schematicFeature, schematicPage)
      : component
        ? componentSelectionContent(component)
        : netSelectionContent(net)}
    <div class="selection-card-actions">
      <button type="button" data-action="frame">Frame selection</button>
    </div>`;
  selectionCardEl.hidden = false;
  const activeCanvas = state.workspace === "schematic" ? schematicCanvas : canvas;
  const anchor = state.selectionAnchor;
  if (anchor) {
    const maxLeft = Math.max(16, activeCanvas.clientWidth - 380);
    const maxTop = Math.max(16, activeCanvas.clientHeight - 330);
    selectionCardEl.style.left = `${clamp(anchor.x + 18, 16, maxLeft)}px`;
    selectionCardEl.style.top = `${clamp(anchor.y + 18, 16, maxTop)}px`;
  } else {
    selectionCardEl.style.left = "20px";
    selectionCardEl.style.top = "20px";
  }
  selectionCardEl.querySelector(".selection-card-close").addEventListener("click", clearSelection);
  selectionCardEl.querySelector("[data-action=frame]").addEventListener("click", frameSelection);
}

function frameSelection() {
  if (state.workspace === "schematic") {
    frameSchematicSelection();
    return;
  }
  const feature = scene.features.get(state.selectedFeatureId);
  if (feature?.bounds) camera.frame(feature.bounds);
  else {
    const net = scene.nets.find((item) => Number(item.id) === state.activeNetId);
    if (net?.boundsMm) camera.frame(runtimeBounds(net.boundsMm));
  }
}

function bindInteractions() {
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    state.dragging = true;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.pointerStartX = event.clientX;
    state.pointerStartY = event.clientY;
    state.dragMode =
      state.mode === "layer"
      || state.cameraTool === "pan"
      || event.shiftKey
      || event.button !== 0
        ? "pan"
        : "orbit";
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (state.dragMode === "pan") camera.pan(dx, dy, canvas.clientHeight, state.mode === "layer");
    else camera.orbit(dx, dy);
  });
  canvas.addEventListener("pointerup", async (event) => {
    state.dragging = false;
    canvas.releasePointerCapture(event.pointerId);
    if (Math.hypot(event.clientX - state.pointerStartX, event.clientY - state.pointerStartY) < 3) {
      await pickAt(event);
    }
  });
  canvas.addEventListener("dblclick", async (event) => {
    await pickAt(event);
    frameSelection();
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 0.4) {
      camera.pan(-event.deltaX, 0, canvas.clientHeight, state.mode === "layer");
    } else {
      camera.dolly(event.deltaY, state.mode === "layer");
    }
  }, { passive: false });
  window.addEventListener("keydown", handleKey);
}

function bindWorkspaceTabs() {
  document.querySelectorAll("[data-workspace]").forEach((button) => {
    button.addEventListener("click", () => switchWorkspace(button.dataset.workspace));
  });
}

function switchWorkspace(workspace) {
  if (workspace === "schematic" && !schematicRenderer) return;
  state.workspace = workspace;
  const schematic = workspace === "schematic";
  canvas.hidden = schematic;
  schematicCanvas.hidden = !schematic;
  schematicDomLayer.hidden = !schematic || !schematicDomRenderer;
  schematicFlowOverlay.hidden = !schematic;
  gizmo.hidden = schematic;
  labelsEl.hidden = schematic;
  schematicLabelsEl.hidden = !schematic;
  document.querySelectorAll("[data-workspace]").forEach((button) => {
    button.classList.toggle("active", button.dataset.workspace === workspace);
  });
  statusEl.textContent = schematic
    ? schematicDomRenderer ? "SVG DOM + WebGPU schematic world active" : "WebGPU schematic world active"
    : "WebGPU semantic glTF active";
  if (schematic && !schematicScene.fitted) {
    schematicRenderer.resize();
    schematicRenderer.frameWorld();
    schematicScene.fitted = true;
  }
  renderControls();
}

function bindSchematicInteractions() {
  schematicCanvas.addEventListener("pointerdown", (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    state.schematicDragging = true;
    state.schematicLastX = event.clientX;
    state.schematicLastY = event.clientY;
    state.schematicStartX = event.clientX;
    state.schematicStartY = event.clientY;
    schematicCanvas.setPointerCapture(event.pointerId);
  });
  schematicCanvas.addEventListener("pointermove", (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    if (!state.schematicDragging || !schematicRenderer) return;
    const dx = event.clientX - state.schematicLastX;
    const dy = event.clientY - state.schematicLastY;
    state.schematicLastX = event.clientX;
    state.schematicLastY = event.clientY;
    schematicRenderer.pan(dx, dy);
  });
  schematicCanvas.addEventListener("pointerup", async (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    state.schematicDragging = false;
    schematicCanvas.releasePointerCapture(event.pointerId);
    if (Math.hypot(event.clientX - state.schematicStartX, event.clientY - state.schematicStartY) < 3) {
      const hit = await schematicRenderer.pickFeature(event.clientX, event.clientY);
      if (hit) selectSchematicFeature(hit);
      else clearSchematicSelection();
    }
  });
  schematicCanvas.addEventListener("dblclick", (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    const page = schematicRenderer.hitPage(event.clientX, event.clientY);
    if (page) selectSchematicPage(page.id, true);
  });
  schematicCanvas.addEventListener("wheel", (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    event.preventDefault();
    schematicRenderer.zoom(event.deltaY, event.clientX, event.clientY);
  }, { passive: false });
}

async function pickAt(event) {
  if (!panel) return;
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.width / rect.width;
  const y = (event.clientY - rect.top) * canvas.height / rect.height;
  state.selectionAnchor = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
  const featureId = await renderer.pick(panel, x, y, {
    activeNetId: state.activeNetId,
    selectedFeatureId: state.selectedFeatureId,
    layerOffsets: stackupOffsets(),
    visibleLayers: state.mode === "3d" ? state.visible3dLayers : state.compareLayers,
    showBoard: state.showBoard,
    showComponents: state.showComponents,
    componentOpacity: clamp(1 - state.separation / 0.1, 0, 1),
    boardOpacity: 1 - state.separation * 0.72,
    isolateNet: state.isolateNet,
    compareMode: state.mode === "layer",
    compareOffsets,
    visibleTileIds: state.mode === "3d" ? state.visibleTileIds : null,
  });
  if (featureId) selectFeature(featureId, false);
  else clearSelection();
}

function handleKey(event) {
  if (event.target instanceof HTMLInputElement) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  const key = event.key.toLowerCase();
  if (state.workspace === "schematic") {
    if (key === "/") {
      event.preventDefault();
      openTab("search");
      searchControlsEl.querySelector("#entity-search")?.focus();
    } else if (key === "escape") {
      if (schematicScene.activeNetUid) {
        schematicScene.activeNetUid = "";
        state.activeNetId = 0;
        schematicRenderer.activeNetUid = "";
        schematicDomRenderer?.setHighlightedNet("");
        updateSelectionCard();
      } else clearSchematicSelection();
    }
    else if (key === "~" || event.key === "~") {
      event.preventDefault();
      const netUid = state.selectedSchematicFeature?.netUid;
      if (netUid) {
        if (schematicScene.activeNetUid === netUid) {
          schematicScene.activeNetUid = "";
          state.activeNetId = 0;
          schematicRenderer.activeNetUid = "";
          schematicDomRenderer?.setHighlightedNet("");
        } else highlightSchematicNetByUid(netUid, state.selectedSchematicFeature);
      }
    }
    else if (key === "home") {
      schematicRenderer?.frameWorld();
    }
    else if (key === "[") navigateSchematic("previous");
    else if (key === "]") navigateSchematic("next");
    else if (key === "n") {
      event.preventDefault();
      const result = schematicRenderer?.cycleNetIntrasheetLink(event.shiftKey ? -1 : 1);
      if (result?.pageId) {
        state.selectedPageId = result.pageId;
        schematicRenderer.selectedPageId = result.pageId;
        updateSchematicLabels();
      }
    }
    else if (event.altKey && key === "arrowup") navigateSchematic("parent");
    else if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const dx = event.key === "ArrowRight" ? 32 : event.key === "ArrowLeft" ? -32 : 0;
      const dy = event.key === "ArrowDown" ? 32 : event.key === "ArrowUp" ? -32 : 0;
      schematicRenderer?.pan(dx, dy);
    }
    return;
  }
  if (key === "/") {
    event.preventDefault();
    openTab("search");
    searchControlsEl.querySelector("#entity-search").focus();
  } else if (key === "escape") clearSelection();
  else if (key === "home") camera.frame(runtimeBoundsFromGltf(scene.manifest.bbox));
  else if (["x", "y", "z"].includes(key)) camera.setAxis(key, event.shiftKey);
  else if (key === "f") camera.flip();
  else if (key === "r") camera.rotateZ(event.shiftKey ? -1 : 1);
  else if (key === " ") {
    event.preventDefault();
    const feature = scene.features.get(state.selectedFeatureId);
    if (feature?.bounds) {
      camera.setFocus([
        (feature.bounds[0] + feature.bounds[3]) / 2,
        (feature.bounds[1] + feature.bounds[4]) / 2,
        (feature.bounds[2] + feature.bounds[5]) / 2,
      ]);
    }
  } else if (event.key.startsWith("Arrow")) {
    event.preventDefault();
    const dx = event.key === "ArrowRight" ? 32 : event.key === "ArrowLeft" ? -32 : 0;
    const dy = event.key === "ArrowDown" ? 32 : event.key === "ArrowUp" ? -32 : 0;
    camera.pan(dx, dy, canvas.clientHeight, state.mode === "layer");
  }
}

function openTab(tab) {
  state.activeTab = tab;
  appEl.classList.remove("panel-collapsed");
  document.querySelectorAll(".rail-tab").forEach((item) => {
    item.classList.toggle("active", item.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((item) => {
    item.classList.toggle("active", item.dataset.panel === tab);
  });
}

function drawGizmo() {
  const context = gizmo.getContext("2d");
  context.clearRect(0, 0, gizmo.width, gizmo.height);
  const center = [gizmo.width / 2, gizmo.height / 2];
  const basis = camera.basis();
  const worldAxes = [
    { axis: "x", label: "X", color: "#e23838", vector: [1, 0, 0] },
    { axis: "y", label: "Y", color: "#2dbd50", vector: [0, 1, 0] },
    { axis: "z", label: "Z", color: "#3157d5", vector: [0, 0, 1] },
  ];
  const endpoints = [];
  for (const axis of worldAxes) {
    for (const sign of [-1, 1]) {
      const vector = axis.vector.map((value) => value * sign);
      const projected = [
        dot3(vector, basis.right),
        -dot3(vector, basis.up),
        dot3(vector, basis.back),
      ];
      endpoints.push({
        ...axis,
        sign,
        depth: projected[2],
        point: [center[0] + projected[0] * 34, center[1] + projected[1] * 34],
      });
    }
  }
  for (const axis of worldAxes) {
    const positive = endpoints.find((item) => item.axis === axis.axis && item.sign === 1);
    context.strokeStyle = axis.color;
    context.lineWidth = 2.4;
    context.beginPath();
    context.moveTo(...center);
    context.lineTo(...positive.point);
    context.stroke();
  }
  gizmoHits = [];
  for (const endpoint of endpoints.sort((a, b) => b.depth - a.depth)) {
    const front = endpoint.sign === 1;
    const radius = front ? 13 : 9;
    context.beginPath();
    context.arc(endpoint.point[0], endpoint.point[1], radius, 0, Math.PI * 2);
    context.fillStyle = front ? endpoint.color : `${endpoint.color}66`;
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = darken(endpoint.color, front ? 0.45 : 0.58);
    context.stroke();
    if (front) {
      context.fillStyle = "#07101c";
      context.font = "700 13px system-ui";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(endpoint.label, endpoint.point[0], endpoint.point[1] + 0.5);
    }
    gizmoHits.push({ ...endpoint, radius: radius + 5 });
  }
}

gizmo.addEventListener("click", (event) => {
  const scaleX = gizmo.width / gizmo.clientWidth;
  const scaleY = gizmo.height / gizmo.clientHeight;
  const point = [event.offsetX * scaleX, event.offsetY * scaleY];
  const hit = gizmoHits
    .map((item) => ({ item, distance: Math.hypot(point[0] - item.point[0], point[1] - item.point[1]) }))
    .filter(({ item, distance }) => distance <= item.radius)
    .sort((a, b) => a.distance - b.distance)[0]?.item;
  if (hit) camera.setAxis(hit.axis, hit.sign < 0);
});

function updateLayerLabels() {
  if (state.mode !== "layer" || !panel) {
    labelsEl.innerHTML = "";
    return;
  }
  const bounds = runtimeBoundsFromGltf(scene.manifest.bbox);
  const visibleLayers = compareRenderLayers();
  labelsEl.innerHTML = scene.copperLayers
    .filter((layer) => visibleLayers.has(Number(layer.id)))
    .map((layer) => {
      const offset = compareOffsets.get(Number(layer.id)) || [0, 0, 0];
      const screen = projectPoint(
        [bounds[0] + offset[0], bounds[4] + offset[1], 0],
        panel.matrix,
        canvas.clientWidth,
        canvas.clientHeight,
      );
      if (!screen || screen[0] < -100 || screen[0] > canvas.clientWidth + 100
        || screen[1] < -100 || screen[1] > canvas.clientHeight + 100) return "";
      return `<span style="left:${screen[0]}px;top:${screen[1]}px">${escapeHtml(layer.name)}</span>`;
    }).join("");
}

function updateSchematicLabels() {
  if (state.workspace !== "schematic" || !schematicRenderer) {
    schematicLabelsEl.innerHTML = "";
    return;
  }
  schematicLabelsEl.innerHTML = schematicScene.visiblePages
    .filter((page) => schematicRenderer.pagePixelWidth(page) > 120)
    .map((page) => {
      const [left, top] = schematicRenderer.worldToScreen(
        page.worldX + 8 * schematicRenderer.scale,
        page.worldY - 6 * schematicRenderer.scale,
      );
      const selected = page.id === state.selectedPageId;
      const containsNet = schematicScene.activeNetUid && page.netUids.includes(schematicScene.activeNetUid);
      const accent = containsNet ? "#18ef52" : selected ? "#3b82f6" : "#4b8de8";
      return `<div class="schematic-page-label" style="left:${left}px;top:${top}px;border-left-color:${accent}">
        <strong>${escapeHtml(page.name)}</strong>
        <small>Page ${page.sheetNumber} &middot; ${page.featureCount.toLocaleString()} features</small>
      </div>`;
    }).join("");
}

function projectPoint(point, matrix, width, height) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (Math.abs(clipW) < 1e-8) return null;
  return [
    (clipX / clipW * 0.5 + 0.5) * width,
    (0.5 - clipY / clipW * 0.5) * height,
  ];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function darken(color, factor) {
  const clean = color.replace("#", "");
  return `#${[0, 2, 4].map((offset) =>
    Math.round(parseInt(clean.slice(offset, offset + 2), 16) * factor)
      .toString(16).padStart(2, "0")).join("")}`;
}

function recordFrameSample(intervalMs, cpuMs) {
  state.frameSamples.push({ intervalMs, cpuMs });
  if (state.frameSamples.length > 180) state.frameSamples.shift();
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function updateDiagnostics(now) {
  state.frames += 1;
  if (now - state.fpsAt <= 500) return;
  state.fps = state.frames * 1000 / (now - state.fpsAt);
  const samples = state.frameSamples;
  state.frameIntervalMs = samples.length ? samples.reduce((sum, item) => sum + item.intervalMs, 0) / samples.length : 0;
  state.frameCpuMs = samples.length ? samples.reduce((sum, item) => sum + item.cpuMs, 0) / samples.length : 0;
  state.frameIntervalP95Ms = percentile(samples.map((item) => item.intervalMs), 0.95);
  state.frameCpuP95Ms = percentile(samples.map((item) => item.cpuMs), 0.95);
  state.frames = 0;
  state.fpsAt = now;
  const schematicStats = state.workspace === "schematic" && schematicRenderer ? schematicRenderer.stats() : null;
  const domStats = state.workspace === "schematic" && schematicDomRenderer ? schematicDomRenderer.stats() : null;
  const rows = state.workspace === "schematic" && schematicRenderer
    ? schematicDomRenderer?.active
      ? [
      ["Renderer", "SVG DOM schematic detail"],
      ["Pages", schematicScene.pages.length],
      ["Mounted pages", domStats.mountedPages],
      ["Active page", domStats.activePage],
      ["DOM nodes", domStats.domNodes.toLocaleString()],
      ["Indexed features", domStats.indexedFeatures.toLocaleString()],
      ["Indexed nets", domStats.indexedNets.toLocaleString()],
      ["SVG cache", `${domStats.cachedSvgPages} pages / ${(domStats.cachedSvgBytes / 1048576).toFixed(1)} MB`],
      ["Selection", `${domStats.selectionMs.toFixed(1)} ms`],
      ["Active net", scene.nets.find((net) => net.uid === schematicScene.activeNetUid)?.name || "-"],
      ["Tracking links", `${schematicStats.netFlowSegments} total / ${schematicStats.netFlowIntrasheetSegments} local`],
      ["Tracking verts", schematicStats.netFlowVertices.toLocaleString()],
      ["Mount", `${domStats.mountMs.toFixed(1)} ms`],
      ["Highlight", `${domStats.highlightMs.toFixed(1)} ms`],
      ["Fallback", domStats.fallbackReason || "-"],
      ["Frame interval", `${state.frameIntervalMs.toFixed(2)} ms avg / ${state.frameIntervalP95Ms.toFixed(2)} p95`],
      ["CPU frame", `${state.frameCpuMs.toFixed(2)} ms avg / ${state.frameCpuP95Ms.toFixed(2)} p95`],
      ["FPS", state.fps.toFixed(1)],
    ]
      : [
      ["Renderer", schematicDomRenderer ? "SVG DOM + WebGPU world" : "WebGPU schematic world"],
      ["Pages", schematicScene.pages.length],
      ["Visible pages", schematicScene.visiblePages.length],
      ["DOM pages", domStats ? domStats.mountedPages : 0],
      ["DOM nodes", domStats ? domStats.domNodes.toLocaleString() : "0"],
      ["Indexed SVG features", domStats ? domStats.indexedFeatures.toLocaleString() : "0"],
      ["SVG cache", domStats ? `${domStats.cachedSvgPages} pages / ${(domStats.cachedSvgBytes / 1048576).toFixed(1)} MB` : "0 pages"],
      ["JS heap", domStats?.heapMb ? `${domStats.heapMb.toFixed(1)} MB` : "-"],
      ["Hierarchy links", schematicScene.manifest.edges?.length || 0],
      ["Selected page", schematicScene.byId.get(state.selectedPageId)?.name || "-"],
      ["Active net", scene.nets.find((net) => net.uid === schematicScene.activeNetUid)?.name || "-"],
      ["Tracking links", `${schematicStats.netFlowSegments} total / ${schematicStats.netFlowIntrasheetSegments} local`],
      ["Downloaded", `${(schematicRenderer.downloadedBytes / 1048576).toFixed(1)} MB`],
      ["Resident vectors", `${(schematicStats.residentVectorBytes / 1048576).toFixed(1)} MB`],
      ["Vector pages", `${schematicStats.vectorChunks} loaded / ${schematicStats.vectorLoads} loading`],
      ["Vector draw", `${schematicStats.vectorVertices.toLocaleString()} verts / ${schematicStats.vectorDrawChunks} chunks`],
      ["Native detail", `${schematicStats.nativeDetailPages} pages @ ${schematicStats.nativePxPerMm} / ${schematicStats.nativeThresholdPxPerMm} px/mm`],
      ["Vector failures", schematicStats.failedVectorChunks],
      ["Truncated", schematicStats.truncatedVectors],
      ["Frame interval", `${state.frameIntervalMs.toFixed(2)} ms avg / ${state.frameIntervalP95Ms.toFixed(2)} p95`],
      ["CPU frame", `${state.frameCpuMs.toFixed(2)} ms avg / ${state.frameCpuP95Ms.toFixed(2)} p95`],
      ["FPS", state.fps.toFixed(1)],
    ]
    : [
    ["Renderer", "WebGPU semantic glTF"],
    ["Mode", state.mode === "3d" ? "3D" : "Layer Compare"],
    ["Visible layers", state.mode === "3d" ? state.visible3dLayers.size : state.compareLayers.size],
    ["Resident tiles", scene.loaded.size],
    ["Loading tiles", scene.loading.size],
    ["Failed tiles", scene.failed.size],
    ["Triangles", Math.round(state.triangles).toLocaleString()],
    ["Downloaded", `${(state.loadedBytes / 1048576).toFixed(1)} MB`],
    ["Resident GLB", `${(state.residentTileBytes / 1048576).toFixed(1)} MB`],
    ["Resident GPU", `${(state.residentTileGpuBytes / 1048576).toFixed(1)} MB`],
    ["Tile loads", state.tileLoads.toLocaleString()],
    ["Tile evictions", state.tileEvictions.toLocaleString()],
    ["Tile scheduler", `${state.tileSchedulerMs.toFixed(2)} ms`],
    ["Active net", scene.nets.find((net) => Number(net.id) === state.activeNetId)?.name || "-"],
    ["Frame interval", `${state.frameIntervalMs.toFixed(2)} ms avg / ${state.frameIntervalP95Ms.toFixed(2)} p95`],
    ["CPU frame", `${state.frameCpuMs.toFixed(2)} ms avg / ${state.frameCpuP95Ms.toFixed(2)} p95`],
    ["FPS", state.fps.toFixed(1)],
  ];
  diagnosticsEl.innerHTML = rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
}

function rgbCss(color) {
  return `rgb(${color.slice(0, 3).map((value) => Math.round(value * 255)).join(" ")})`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}
