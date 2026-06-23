import { CameraController } from "./camera.js";
import { loadGltf } from "./gltf-loader.js";
import { clamp } from "./math.js";
import { Renderer } from "./renderer.js";

const topology = window.__TOPOLOGY__ || {};
const semanticGeometry = window.__SEMANTIC_GEOMETRY__ || {};
const canvas = document.getElementById("viewport");
const statusEl = document.getElementById("status");
const selectionEl = document.getElementById("selection");
const diagnosticsEl = document.getElementById("diagnostics");
const controlsEl = document.getElementById("layers");
const fallbackEl = document.getElementById("fallback");
const labelsEl = document.getElementById("panel-labels");
const hoverCard = document.getElementById("hover-card");
const gizmo = document.getElementById("axis-gizmo");

const state = {
  mode: "3d",
  cameraTool: "orbit",
  compareLayers: new Set(),
  visible3dLayers: new Set(),
  activeNetId: 0,
  selectedFeatureId: 0,
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
  fps: 0,
  frames: 0,
  fpsAt: performance.now(),
  hoverTimer: 0,
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
  componentFeatures: new Map(),
  boardEntries: [],
  componentEntries: [],
  barrelRecords: [],
};

let renderer;
let camera;
let panels = [];
let lastFrame = performance.now();
const panelAnimation = {
  key: "",
  started: 0,
  from: new Map(),
  current: new Map(),
};

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
  scene.copperLayers = scene.layers.filter((layer) => layer.role === "copper" || String(layer.name).endsWith(".Cu"));
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
    for (const layer of scene.copperLayers) state.visible3dLayers.add(Number(layer.id));
  }
  renderer = await Renderer.create(canvas);
  camera = new CameraController(runtimeBoundsFromGltf(scene.manifest.bbox));
  renderer.setBarrels(scene.manifest.barrels || []);
  await Promise.all([
    first ? loadLayer(Number(first.id)) : Promise.resolve(),
    loadBoard(),
  ]);
  renderControls();
  bindInteractions();
  statusEl.textContent = "WebGPU semantic glTF active";
  void loadComponents();
  void Promise.all(scene.copperLayers.slice(1).map((layer) => loadLayer(Number(layer.id))));
  requestAnimationFrame(frame);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return response.json();
}

async function loadLayer(layerId) {
  const jobs = [...scene.tiles.values()]
    .filter((tile) => Number(tile.layerId) === layerId)
    .map((tile) => loadTile(tile));
  await Promise.all(jobs);
}

async function loadTile(tile) {
  if (scene.loaded.has(tile.id)) return;
  if (scene.loading.has(tile.id)) return scene.loading.get(tile.id);
  const promise = (async () => {
    const url = new URL(tile.path, scene.manifestUrl).toString();
    const loaded = await loadGltf(url);
    state.loadedBytes += loaded.byteLength;
    const layer = scene.layers.find((item) => Number(item.id) === Number(tile.layerId));
    for (const primitive of loaded.primitives) {
      renderer.addPrimitive(primitive, {
        kind: "copper",
        layerId: Number(tile.layerId),
        color: layerColor(layer, state.mode === "layer" ? 0.72 : 0.78),
        material: { baseColor: [1, 1, 1, 1], metallic: 0.78, roughness: 0.32 },
      });
      state.triangles += primitive.indices.length / 3;
    }
    scene.loaded.add(tile.id);
    scene.loading.delete(tile.id);
  })();
  scene.loading.set(tile.id, promise);
  return promise;
}

async function loadBoard() {
  const boardPath = semanticGeometry.assets?.base_board_glb;
  if (boardPath) {
    const loaded = await loadGltf(new URL(boardPath, location.href).toString(), { defaultFeatureId: 0 });
    state.loadedBytes += loaded.byteLength;
    for (const primitive of mergePrimitivesByMaterial(loaded.primitives)) {
      scene.boardEntries.push(renderer.addPrimitive(primitive, {
        kind: "board",
        layerId: 0,
        material: primitive.material,
        color: primitive.material.baseColor,
      }));
    }
  }
}

async function loadComponents() {
  const componentPath = semanticGeometry.assets?.components_glb;
  if (componentPath) {
    const loaded = await loadGltf(new URL(componentPath, location.href).toString(), {
      componentFeatures: scene.componentFeatures,
    });
    state.loadedBytes += loaded.byteLength;
    for (const primitive of loaded.primitives) {
      const component = scene.componentFeatures.get(primitive.designator);
      if (component) mergeFeatureBounds(component.featureId, primitive.position);
    }
    for (const primitive of mergePrimitivesByMaterial(loaded.primitives)) {
      const entry = renderer.addPrimitive(primitive, {
        kind: "component",
        layerId: 0,
        material: primitive.material,
        color: primitive.material.baseColor,
        designator: "",
      });
      scene.componentEntries.push(entry);
    }
  }
}

function mergePrimitivesByMaterial(primitives) {
  const groups = new Map();
  for (const primitive of primitives) {
    const key = JSON.stringify(primitive.material);
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
    for (const item of group) {
      const count = item.position.length / 3;
      position.set(item.position, vertexOffset * 3);
      normal.set(item.normal, vertexOffset * 3);
      netId.set(item.netId, vertexOffset);
      objectFeatureId.set(item.objectFeatureId, vertexOffset);
      for (let index = 0; index < item.indices.length; index += 1) {
        indices[indexOffset + index] = Number(item.indices[index]) + vertexOffset;
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
      designator: "",
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
        Math.min(feature.bounds[0], incoming[0]), Math.min(feature.bounds[1], incoming[1]), Math.min(feature.bounds[2], incoming[2]),
        Math.max(feature.bounds[3], incoming[3]), Math.max(feature.bounds[4], incoming[4]), Math.max(feature.bounds[5], incoming[5]),
      ]
    : incoming;
}

function layerColor(layer, alpha) {
  const colors = {
    "F.Cu": "#b94b43",
    "B.Cu": "#3d67ad",
    "In1.Cu": "#4f8a5b",
    "In2.Cu": "#816447",
    "In3.Cu": "#398b96",
    "In4.Cu": "#735f98",
    "In5.Cu": "#998043",
  };
  const inner = ["#4f8a5b", "#816447", "#398b96", "#735f98", "#998043", "#8a5874"];
  const name = String(layer?.name || "");
  const index = Math.max(0, scene.copperLayers.findIndex((item) => item.name === name) - 1);
  return [...hex(colors[name] || inner[index % inner.length]), alpha];
}

function hex(value) {
  const clean = value.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16) / 255);
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  camera.update(dt);
  const offsets = layerOffsets();
  for (const entry of renderer.entries) entry.layerOffset = offsets[entry.layerId] || 0;
  panels = panelLayout();
  renderer.render({
    panels,
    activeNetId: state.activeNetId,
    time: now / 1000,
    layerOffsets: offsets,
    visibleLayers: state.mode === "3d" ? state.visible3dLayers : state.compareLayers,
    showBoard: state.showBoard,
    showComponents: state.showComponents,
    componentOpacity: clamp(1 - state.separation / 0.1, 0, 1),
    boardOpacity: 1 - state.separation * 0.72,
    isolateNet: state.isolateNet,
  });
  drawGizmo();
  updatePanelLabels();
  updateDiagnostics(now);
  requestAnimationFrame(frame);
}

function layerOffsets() {
  const output = new Float32Array(256);
  const bbox = scene.manifest.bbox;
  const diagonal = Math.hypot((bbox.max[0] - bbox.min[0]) * 1000, (bbox.max[2] - bbox.min[2]) * 1000);
  const maxGapMm = clamp(diagonal * 0.12, 8, 25);
  const gap = state.separation * state.separation * maxGapMm / 1000;
  const middle = (scene.copperLayers.length - 1) / 2;
  scene.copperLayers.forEach((layer, index) => {
    output[Number(layer.id)] = (middle - index) * gap;
  });
  return output;
}

function panelLayout() {
  const width = canvas.width;
  const height = canvas.height;
  if (state.mode === "3d") {
    panelAnimation.key = "3d";
    panelAnimation.current.clear();
    return [{ layerId: 0, viewport: { x: 0, y: 0, width, height }, matrix: camera.matrix(width, height, false) }];
  }
  const layers = scene.copperLayers.filter((layer) => state.compareLayers.has(Number(layer.id)));
  const count = Math.max(1, layers.length);
  let columns = 1;
  if (count === 2) columns = width >= height ? 2 : 1;
  else if (count === 3 || count === 4) columns = 2;
  else if (count > 4) columns = Math.ceil(Math.sqrt(count * width / Math.max(1, height)));
  const rows = Math.ceil(count / columns);
  const cellWidth = Math.floor(width / columns);
  const cellHeight = Math.floor(height / rows);
  const targets = layers.map((layer, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const viewport = {
      x: column * cellWidth,
      y: row * cellHeight,
      width: column === columns - 1 ? width - column * cellWidth : cellWidth,
      height: row === rows - 1 ? height - row * cellHeight : cellHeight,
    };
    return { layerId: Number(layer.id), layer, viewport };
  });
  const key = `${width}x${height}:${targets.map((panel) => panel.layerId).join(",")}`;
  const now = performance.now();
  if (key !== panelAnimation.key) {
    panelAnimation.key = key;
    panelAnimation.started = now;
    panelAnimation.from = new Map(panelAnimation.current);
  }
  const progress = clamp((now - panelAnimation.started) / 220, 0, 1);
  const eased = 1 - Math.pow(1 - progress, 3);
  const result = targets.map((panel) => {
    const target = panel.viewport;
    const start = panelAnimation.from.get(panel.layerId) || {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
      width: 1,
      height: 1,
    };
    const viewport = {
      x: Math.max(0, Math.round(start.x + (target.x - start.x) * eased)),
      y: Math.max(0, Math.round(start.y + (target.y - start.y) * eased)),
      width: Math.max(1, Math.round(start.width + (target.width - start.width) * eased)),
      height: Math.max(1, Math.round(start.height + (target.height - start.height) * eased)),
    };
    panelAnimation.current.set(panel.layerId, viewport);
    return { ...panel, viewport, matrix: camera.matrix(viewport.width, viewport.height, true) };
  });
  for (const layerId of [...panelAnimation.current.keys()]) {
    if (!targets.some((panel) => panel.layerId === layerId)) panelAnimation.current.delete(layerId);
  }
  return result;
}

function renderControls() {
  controlsEl.innerHTML = `
    <div class="mode-toolbar">
      <button data-mode="layer">Layer Compare</button>
      <button data-mode="3d">3D</button>
    </div>
    <div class="layer-presets">
      <button data-preset="all">All</button><button data-preset="none">None</button>
      <button data-preset="outer">Outer</button><button data-preset="inner">Inner</button>
    </div>
    <div class="layer-list"></div>
    <label class="control-field"><span>Search nets, components, pins</span>
      <input id="entity-search" class="layer-select" type="search" placeholder="Press / to search">
      <div id="search-results" class="search-results"></div>
    </label>
    <div class="camera-toolbar mode-toolbar">
      <button data-tool="orbit">Orbit</button><button data-tool="pan">Pan</button>
    </div>
    <div class="toggle-list">
      <label class="toggle-row"><input id="show-board" type="checkbox"><span>Board substrate</span></label>
      <label class="toggle-row"><input id="show-components" type="checkbox"><span>Components</span></label>
    </div>
    <label class="control-field"><span>Stackup separation</span>
      <input id="separation" type="range" min="0" max="1" step="0.002">
    </label>
    <div class="quick-actions">
      <button id="frame-selection">Frame</button>
      <button id="show-net-layers">Net layers</button>
      <button id="isolate-net">Isolate</button>
      <button id="clear-selection">Clear</button>
    </div>`;
  refreshControls();
  bindControlEvents();
}

function refreshControls() {
  controlsEl.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
  controlsEl.querySelectorAll("[data-tool]").forEach((button) => button.classList.toggle("active", button.dataset.tool === state.cameraTool));
  controlsEl.querySelector("#show-board").checked = state.showBoard;
  controlsEl.querySelector("#show-components").checked = state.showComponents;
  controlsEl.querySelector("#separation").value = state.separation;
  const list = controlsEl.querySelector(".layer-list");
  const selected = state.mode === "3d" ? state.visible3dLayers : state.compareLayers;
  list.innerHTML = scene.copperLayers.map((layer, index) => `
    <label class="layer-row">
      <input type="checkbox" data-layer="${layer.id}" ${selected.has(Number(layer.id)) ? "checked" : ""}>
      <span class="swatch" style="background:${rgbCss(layerColor(layer, 1))}"></span>
      <span>${layer.name}</span><small>${index + 1}</small>
    </label>`).join("");
  list.querySelectorAll("[data-layer]").forEach((input) => input.addEventListener("change", async () => {
    const layerId = Number(input.dataset.layer);
    const target = state.mode === "3d" ? state.visible3dLayers : state.compareLayers;
    input.checked ? target.add(layerId) : target.delete(layerId);
    if (input.checked) await loadLayer(layerId);
  }));
}

function bindControlEvents() {
  controlsEl.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    if (state.mode === "layer") camera.setAxis("z", false);
    refreshControls();
  }));
  controlsEl.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => {
    state.cameraTool = button.dataset.tool;
    refreshControls();
  }));
  controlsEl.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", async () => {
    const target = state.mode === "3d" ? state.visible3dLayers : state.compareLayers;
    target.clear();
    const preset = button.dataset.preset;
    for (const [index, layer] of scene.copperLayers.entries()) {
      const include = preset === "all"
        || (preset === "outer" && (index === 0 || index === scene.copperLayers.length - 1))
        || (preset === "inner" && index > 0 && index < scene.copperLayers.length - 1);
      if (include) target.add(Number(layer.id));
    }
    await Promise.all([...target].map(loadLayer));
    refreshControls();
  }));
  controlsEl.querySelector("#show-board").addEventListener("change", (event) => { state.showBoard = event.target.checked; });
  controlsEl.querySelector("#show-components").addEventListener("change", (event) => { state.showComponents = event.target.checked; });
  controlsEl.querySelector("#separation").addEventListener("input", (event) => { state.separation = Number(event.target.value); });
  controlsEl.querySelector("#clear-selection").addEventListener("click", clearSelection);
  controlsEl.querySelector("#isolate-net").addEventListener("click", () => {
    state.isolateNet = !state.isolateNet;
    controlsEl.querySelector("#isolate-net").classList.toggle("active", state.isolateNet);
  });
  controlsEl.querySelector("#frame-selection").addEventListener("click", frameSelection);
  controlsEl.querySelector("#show-net-layers").addEventListener("click", async () => {
    const net = scene.nets.find((item) => Number(item.id) === state.activeNetId);
    if (!net) return;
    const names = new Set(net.metrics?.layers || []);
    const target = state.mode === "3d" ? state.visible3dLayers : state.compareLayers;
    target.clear();
    for (const layer of scene.copperLayers) if (names.has(layer.name)) target.add(Number(layer.id));
    await Promise.all([...target].map(loadLayer));
    refreshControls();
  });
  const search = controlsEl.querySelector("#entity-search");
  search.addEventListener("input", () => renderSearch(search.value));
}

function renderSearch(query) {
  const container = controlsEl.querySelector("#search-results");
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
  container.querySelectorAll("[data-net]").forEach((button) => button.addEventListener("click", () => selectNet(Number(button.dataset.net), true)));
  container.querySelectorAll("[data-feature]").forEach((button) => button.addEventListener("click", () => selectFeature(Number(button.dataset.feature), true)));
}

function selectNet(netId, frameIt) {
  state.activeNetId = netId;
  state.selectedFeatureId = 0;
  const net = scene.nets.find((item) => Number(item.id) === netId);
  selectionEl.textContent = JSON.stringify(net || {}, null, 2);
  if (frameIt && net?.boundsMm) camera.frame(runtimeBounds(net.boundsMm));
}

function selectFeature(featureId, frameIt = false) {
  const feature = scene.features.get(featureId);
  state.selectedFeatureId = featureId;
  state.activeNetId = Number(feature?.netId || 0);
  selectionEl.textContent = feature ? JSON.stringify(feature, null, 2) : "No object selected";
  if (frameIt && feature?.bounds) camera.frame(feature.bounds);
}

function clearSelection() {
  state.activeNetId = 0;
  state.selectedFeatureId = 0;
  state.isolateNet = false;
  selectionEl.textContent = "No object selected";
}

function frameSelection() {
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
    state.dragMode = state.mode === "layer" || state.cameraTool === "pan" || event.shiftKey || event.button !== 0 ? "pan" : "orbit";
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!state.dragging) {
      scheduleHover(event);
      return;
    }
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
    if (Math.hypot(event.clientX - state.pointerStartX, event.clientY - state.pointerStartY) < 3) await pickAt(event);
  });
  canvas.addEventListener("pointerleave", () => {
    hoverCard.hidden = true;
    clearTimeout(state.hoverTimer);
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

async function pickAt(event) {
  const featureId = await featureAt(event);
  if (featureId) selectFeature(featureId, false);
}

async function featureAt(event) {
  const rect = canvas.getBoundingClientRect();
  const ratioX = canvas.width / rect.width;
  const ratioY = canvas.height / rect.height;
  const x = (event.clientX - rect.left) * ratioX;
  const y = (event.clientY - rect.top) * ratioY;
  const panel = panels.find((item) =>
    x >= item.viewport.x && x < item.viewport.x + item.viewport.width
    && y >= item.viewport.y && y < item.viewport.y + item.viewport.height);
  if (!panel) return;
  return renderer.pick(panel, x, y, {
    activeNetId: state.activeNetId,
    layerOffsets: layerOffsets(),
    visibleLayers: state.mode === "3d" ? state.visible3dLayers : state.compareLayers,
    showBoard: state.showBoard,
    showComponents: state.showComponents,
    componentOpacity: clamp(1 - state.separation / 0.1, 0, 1),
    boardOpacity: 1 - state.separation * 0.72,
    isolateNet: state.isolateNet,
  });
}

function scheduleHover(event) {
  clearTimeout(state.hoverTimer);
  const location = { clientX: event.clientX, clientY: event.clientY };
  state.hoverTimer = setTimeout(async () => {
    const featureId = await featureAt(location);
    const feature = scene.features.get(featureId);
    if (!feature) {
      hoverCard.hidden = true;
      return;
    }
    const net = scene.nets.find((item) => Number(item.id) === Number(feature.netId));
    const layer = scene.layers.find((item) => Number(item.id) === Number(feature.layerId));
    hoverCard.innerHTML = `
      <b>${escapeHtml(feature.designator || net?.name || feature.kind || "PCB object")}</b>
      <span>${escapeHtml([feature.kind, layer?.name, net?.name].filter(Boolean).join(" · "))}</span>`;
    const shell = canvas.getBoundingClientRect();
    hoverCard.style.left = `${Math.min(shell.width - 270, location.clientX - shell.left + 14)}px`;
    hoverCard.style.top = `${Math.min(shell.height - 70, location.clientY - shell.top + 14)}px`;
    hoverCard.hidden = false;
  }, 90);
}

function handleKey(event) {
  if (event.target instanceof HTMLInputElement) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "/") {
    event.preventDefault();
    controlsEl.querySelector("#entity-search").focus();
  } else if (key === "escape") clearSelection();
  else if (key === "home") camera.frame(runtimeBoundsFromGltf(scene.manifest.bbox));
  else if (["x", "y", "z"].includes(key)) camera.setAxis(key, event.shiftKey);
  else if (key === "f") camera.flip();
  else if (key === "r") camera.rotateZ(event.shiftKey ? -1 : 1);
  else if (key === " ") {
    event.preventDefault();
    const feature = scene.features.get(state.selectedFeatureId);
    if (feature?.bounds) camera.setFocus([
      (feature.bounds[0] + feature.bounds[3]) / 2,
      (feature.bounds[1] + feature.bounds[4]) / 2,
      (feature.bounds[2] + feature.bounds[5]) / 2,
    ]);
  } else if (event.key.startsWith("Arrow")) {
    event.preventDefault();
    const dx = event.key === "ArrowRight" ? 32 : event.key === "ArrowLeft" ? -32 : 0;
    const dy = event.key === "ArrowDown" ? 32 : event.key === "ArrowUp" ? -32 : 0;
    camera.pan(dx, dy, canvas.clientHeight, state.mode === "layer");
  }
}

function drawGizmo() {
  const context = gizmo.getContext("2d");
  const width = gizmo.width;
  const height = gizmo.height;
  context.clearRect(0, 0, width, height);
  const center = [width / 2, height / 2];
  const basis = camera.basis();
  const axes = [
    { label: "X", color: "#ef5b5b", vector: basis.right },
    { label: "Y", color: "#61c46e", vector: basis.up },
    { label: "Z", color: "#5595ef", vector: basis.back },
  ];
  for (const axis of axes) {
    const end = [center[0] + axis.vector[0] * 28, center[1] - axis.vector[1] * 28];
    context.strokeStyle = axis.color;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(...center);
    context.lineTo(...end);
    context.stroke();
    context.fillStyle = axis.color;
    context.font = "bold 11px system-ui";
    context.fillText(axis.label, end[0] + 3, end[1] - 3);
  }
}

gizmo.addEventListener("click", (event) => {
  const x = event.offsetX / gizmo.clientWidth;
  camera.setAxis(x < 0.34 ? "x" : x < 0.67 ? "y" : "z", false);
});

function updateDiagnostics(now) {
  state.frames += 1;
  if (now - state.fpsAt > 500) {
    state.fps = state.frames * 1000 / (now - state.fpsAt);
    state.frames = 0;
    state.fpsAt = now;
    diagnosticsEl.innerHTML = [
      ["renderer", "WebGPU semantic glTF"],
      ["mode", state.mode],
      ["layers", state.mode === "3d" ? state.visible3dLayers.size : state.compareLayers.size],
      ["tiles", scene.loaded.size],
      ["triangles", Math.round(state.triangles).toLocaleString()],
      ["download", `${(state.loadedBytes / 1048576).toFixed(1)} MB`],
      ["active net", scene.nets.find((net) => Number(net.id) === state.activeNetId)?.name || "—"],
      ["fps", state.fps.toFixed(1)],
    ].map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
  }
}

function updatePanelLabels() {
  const ratio = Math.min(devicePixelRatio || 1, 2);
  labelsEl.innerHTML = state.mode === "layer"
    ? panels.map((panel) => `<span style="left:${panel.viewport.x / ratio + 10}px;top:${panel.viewport.y / ratio + 10}px">${panel.layer?.name || ""}</span>`).join("")
    : "";
}

function rgbCss(color) {
  return `rgb(${color.slice(0, 3).map((value) => Math.round(value * 255)).join(" ")})`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
