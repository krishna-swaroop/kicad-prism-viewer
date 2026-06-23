import { CameraController } from "./camera.js";
import { loadGltf } from "./gltf-loader.js";
import { clamp } from "./math.js";
import { Renderer } from "./renderer.js";
import { SchematicWorldRenderer } from "./schematic-world-renderer.js";

const topology = window.__TOPOLOGY__ || {};
const semanticGeometry = window.__SEMANTIC_GEOMETRY__ || {};
const appEl = document.getElementById("app");
const canvas = document.getElementById("viewport");
const schematicCanvas = document.getElementById("schematic-viewport");
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
  componentFeatures: new Map(),
};

const compareAnimation = {
  key: "",
  started: 0,
  from: new Map(),
  current: new Map(),
};
const schematicScene = {
  manifest: null,
  manifestUrl: "",
  pages: [],
  byId: new Map(),
  activeNetUid: "",
  visiblePages: [],
  fitted: false,
};
let gizmoHits = [];

let renderer;
let schematicRenderer;
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
    for (const layer of scene.copperLayers) state.visible3dLayers.add(Number(layer.id));
  }

  renderer = await Renderer.create(canvas);
  camera = new CameraController(runtimeBoundsFromGltf(scene.manifest.bbox));
  renderer.setBarrels(scene.manifest.barrels || []);
  await Promise.all([first ? loadLayer(Number(first.id)) : Promise.resolve(), loadBoard()]);
  await loadSchematicWorld();
  renderControls();
  bindInteractions();
  bindSchematicInteractions();
  bindWorkspaceTabs();
  bindPanelTabs();
  statusEl.textContent = "WebGPU semantic glTF active";
  void loadComponents();
  void Promise.all(scene.copperLayers.slice(1).map((layer) => loadLayer(Number(layer.id))));
  requestAnimationFrame(frame);
}

async function loadSchematicWorld() {
  const path = semanticGeometry.assets?.schematic_native_manifest
    || semanticGeometry.schematic_scene?.path
    || semanticGeometry.assets?.schematic_manifest
    || semanticGeometry.schematic_world?.path;
  const tab = document.querySelector("[data-workspace=schematic]");
  if (!path) {
    tab.disabled = true;
    tab.title = "No schematic world assets are available";
    return;
  }
  schematicScene.manifestUrl = new URL(path, location.href).toString();
  schematicRenderer = await SchematicWorldRenderer.create(schematicCanvas, schematicScene.manifestUrl);
  schematicScene.manifest = schematicRenderer.manifest;
  schematicScene.pages = schematicRenderer.pages;
  schematicScene.byId = new Map(schematicScene.pages.map((page) => [page.id, page]));
  state.selectedPageId = schematicScene.pages[0]?.id || "";
  schematicRenderer.selectedPageId = state.selectedPageId;
  void schematicRenderer.preloadOverview();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return response.json();
}

async function loadLayer(layerId) {
  await Promise.all(
    [...scene.tiles.values()]
      .filter((tile) => Number(tile.layerId) === layerId)
      .map((tile) => loadTile(tile)),
  );
}

async function loadTile(tile) {
  if (scene.loaded.has(tile.id)) return;
  if (scene.loading.has(tile.id)) return scene.loading.get(tile.id);
  const promise = (async () => {
    const loaded = await loadGltf(new URL(tile.path, scene.manifestUrl).toString());
    state.loadedBytes += loaded.byteLength;
    const layer = scene.layers.find((item) => Number(item.id) === Number(tile.layerId));
    for (const primitive of loaded.primitives) {
      renderer.addPrimitive(primitive, {
        kind: "copper",
        layerId: Number(tile.layerId),
        color: layerColor(layer),
        baseZ: Number(layer?.z_mm || 0) / 1000,
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
  const path = semanticGeometry.assets?.base_board_glb;
  if (!path) return;
  const loaded = await loadGltf(new URL(path, location.href).toString(), { defaultFeatureId: 0 });
  state.loadedBytes += loaded.byteLength;
  for (const primitive of mergePrimitivesByMaterial(loaded.primitives, boardRole)) {
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
  const name = String(primitive.nodeName || "").toLowerCase();
  if (name.includes("_pad")) return "pad";
  if (name.includes("_silkscreen")) return "silkscreen";
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
      groupKey: classifier(group[0]),
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
  if (state.workspace === "schematic" && schematicRenderer) {
    schematicScene.visiblePages = schematicRenderer.render();
    updateSchematicLabels();
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
  compareOffsets = updateCompareLayout(now);
  panel = {
    layerId: 0,
    viewport: { x: 0, y: 0, width: canvas.width, height: canvas.height },
    matrix: camera.matrix(canvas.width, canvas.height, state.mode === "layer"),
  };
  renderer.render({
    panels: [panel],
    activeNetId: state.activeNetId,
    selectedFeatureId: state.selectedFeatureId,
    time: now / 1000,
    layerOffsets: layerZOffsets,
    visibleLayers: state.mode === "3d" ? state.visible3dLayers : state.compareLayers,
    showBoard: state.showBoard,
    showComponents: state.showComponents,
    componentOpacity: clamp(1 - state.separation / 0.1, 0, 1),
    boardOpacity: state.activeNetId ? 0.34 : 1 - state.separation * 0.72,
    isolateNet: state.isolateNet,
    compareMode: state.mode === "layer",
    compareOffsets,
  });
  drawGizmo();
  updateLayerLabels();
  updateDiagnostics(now);
  requestAnimationFrame(frame);
}

function stackupOffsets() {
  const output = new Float32Array(256);
  const bbox = scene.manifest.bbox;
  const diagonal = Math.hypot(
    (bbox.max[0] - bbox.min[0]) * 1000,
    (bbox.max[2] - bbox.min[2]) * 1000,
  );
  const gap = state.separation * state.separation * clamp(diagonal * 0.12, 8, 25) / 1000;
  const middle = (scene.copperLayers.length - 1) / 2;
  scene.copperLayers.forEach((layer, index) => {
    output[Number(layer.id)] = (middle - index) * gap;
  });
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
  for (const layerId of [...compareAnimation.current.keys()]) {
    if (!targets.some((item) => item.layerId === layerId)) {
      compareAnimation.current.delete(layerId);
    }
  }
  return offsets;
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
  viewerKindEl.textContent = schematicScene.manifest?.schema === "prism.schematic_scene_a0"
    ? "Schematic Scene A0"
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
  schematicRenderer.selectedFeatureId = 0;
  schematicScene.activeNetUid = net.uid;
  schematicRenderer.activeNetUid = net.uid;
  selectionEl.textContent = JSON.stringify(net, null, 2);
  updateSelectionCard();
  const pageIds = schematicScene.manifest.netToPages?.[net.uid] || [];
  if (shouldFrame && pageIds.length) selectSchematicPage(pageIds[0], true);
}

function clearSchematicSelection() {
  state.activeNetId = 0;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = null;
  schematicScene.activeNetUid = "";
  if (schematicRenderer) {
    schematicRenderer.activeNetUid = "";
    schematicRenderer.selectedFeatureId = 0;
  }
  selectionEl.textContent = "No object selected";
  updateSelectionCard();
}

function frameSchematicSelection() {
  const page = schematicScene.byId.get(state.selectedPageId);
  if (page) schematicRenderer.framePage(page);
  else schematicRenderer.frameWorld();
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
  const selected = state.mode === "3d" ? state.visible3dLayers : state.compareLayers;
  list.innerHTML = scene.copperLayers.map((layer, index) => `
    <label class="layer-row">
      <input type="checkbox" data-layer="${layer.id}" ${selected.has(Number(layer.id)) ? "checked" : ""}>
      <span class="swatch" style="background:${rgbCss(layerColor(layer))}"></span>
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
  layersEl.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    if (state.mode === "layer") camera.setAxis("z", false);
    refreshControls();
  }));
  layersEl.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", async () => {
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

async function showNetLayers() {
  const net = scene.nets.find((item) => Number(item.id) === state.activeNetId);
  if (!net) return;
  const names = new Set(net.metrics?.layers || []);
  const target = state.mode === "3d" ? state.visible3dLayers : state.compareLayers;
  target.clear();
  for (const layer of scene.copperLayers) {
    if (names.has(layer.name)) target.add(Number(layer.id));
  }
  await Promise.all([...target].map(loadLayer));
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
}

function selectFeature(featureId, shouldFrame = false) {
  const feature = scene.features.get(featureId);
  if (shouldFrame) state.selectionAnchor = null;
  state.selectedFeatureId = featureId;
  state.activeNetId = Number(feature?.netId || 0);
  selectionEl.textContent = feature ? JSON.stringify(feature, null, 2) : "No object selected";
  updateSelectionCard();
  if (shouldFrame && feature?.bounds) camera.frame(feature.bounds);
}

function clearSelection() {
  state.activeNetId = 0;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = null;
  state.selectionAnchor = null;
  state.isolateNet = false;
  schematicScene.activeNetUid = "";
  if (schematicRenderer) schematicRenderer.activeNetUid = "";
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
  return `
    ${selectionHeader(
      feature.kind.replaceAll("_", " "),
      feature.reference || feature.text || feature.netName || "Schematic object",
      "#3b82f6",
    )}
    ${selectionProperties([
      ["Page", page?.name || "Unknown"],
      ["Kind", feature.kind.replaceAll("_", " ")],
      ["Net", feature.netName || "Not connected"],
    ])}
    <div class="selection-section">
      <span class="selection-section-title">Source identity</span>
      <div class="selection-table">
        <div class="selection-row">
          <span><strong>UUID</strong></span>
          <span title="${escapeHtml(feature.uuid || "")}">${escapeHtml(feature.uuid || "-")}</span>
          <span title="${escapeHtml(feature.objectId || "")}">${escapeHtml(feature.objectId || "No object ID")}</span>
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
    ${component
      ? componentSelectionContent(component)
      : net
        ? netSelectionContent(net)
        : schematicFeatureSelectionContent(schematicFeature, schematicPage)}
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
  gizmo.hidden = schematic;
  labelsEl.hidden = schematic;
  schematicLabelsEl.hidden = !schematic;
  document.querySelectorAll("[data-workspace]").forEach((button) => {
    button.classList.toggle("active", button.dataset.workspace === workspace);
  });
  statusEl.textContent = schematic ? "WebGPU schematic world active" : "WebGPU semantic glTF active";
  if (schematic && !schematicScene.fitted) {
    schematicRenderer.resize();
    schematicRenderer.frameWorld();
    schematicScene.fitted = true;
  }
  renderControls();
}

function bindSchematicInteractions() {
  schematicCanvas.addEventListener("pointerdown", (event) => {
    state.schematicDragging = true;
    state.schematicLastX = event.clientX;
    state.schematicLastY = event.clientY;
    state.schematicStartX = event.clientX;
    state.schematicStartY = event.clientY;
    schematicCanvas.setPointerCapture(event.pointerId);
  });
  schematicCanvas.addEventListener("pointermove", (event) => {
    if (!state.schematicDragging || !schematicRenderer) return;
    const dx = event.clientX - state.schematicLastX;
    const dy = event.clientY - state.schematicLastY;
    state.schematicLastX = event.clientX;
    state.schematicLastY = event.clientY;
    schematicRenderer.pan(dx, dy);
  });
  schematicCanvas.addEventListener("pointerup", async (event) => {
    state.schematicDragging = false;
    schematicCanvas.releasePointerCapture(event.pointerId);
    if (Math.hypot(event.clientX - state.schematicStartX, event.clientY - state.schematicStartY) < 3) {
      const hit = await schematicRenderer.pickFeature(event.clientX, event.clientY);
      if (hit) selectSchematicFeature(hit);
      else clearSchematicSelection();
    }
  });
  schematicCanvas.addEventListener("dblclick", (event) => {
    const page = schematicRenderer.hitPage(event.clientX, event.clientY);
    if (page) selectSchematicPage(page.id, true);
  });
  schematicCanvas.addEventListener("wheel", (event) => {
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
    } else if (key === "escape") clearSchematicSelection();
    else if (key === "home") schematicRenderer?.frameWorld();
    else if (key === "[") navigateSchematic("previous");
    else if (key === "]") navigateSchematic("next");
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
  labelsEl.innerHTML = scene.copperLayers
    .filter((layer) => state.compareLayers.has(Number(layer.id)))
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

function updateDiagnostics(now) {
  state.frames += 1;
  if (now - state.fpsAt <= 500) return;
  state.fps = state.frames * 1000 / (now - state.fpsAt);
  state.frames = 0;
  state.fpsAt = now;
  const rows = state.workspace === "schematic" && schematicRenderer
    ? [
      ["Renderer", "WebGPU schematic world"],
      ["Pages", schematicScene.pages.length],
      ["Visible pages", schematicScene.visiblePages.length],
      ["Hierarchy links", schematicScene.manifest.edges?.length || 0],
      ["Selected page", schematicScene.byId.get(state.selectedPageId)?.name || "-"],
      ["Active net", scene.nets.find((net) => net.uid === schematicScene.activeNetUid)?.name || "-"],
      ["Downloaded", `${(schematicRenderer.downloadedBytes / 1048576).toFixed(1)} MB`],
      ["FPS", state.fps.toFixed(1)],
    ]
    : [
    ["Renderer", "WebGPU semantic glTF"],
    ["Mode", state.mode === "3d" ? "3D" : "Layer Compare"],
    ["Visible layers", state.mode === "3d" ? state.visible3dLayers.size : state.compareLayers.size],
    ["Resident tiles", scene.loaded.size],
    ["Triangles", Math.round(state.triangles).toLocaleString()],
    ["Downloaded", `${(state.loadedBytes / 1048576).toFixed(1)} MB`],
    ["Active net", scene.nets.find((net) => Number(net.id) === state.activeNetId)?.name || "-"],
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
