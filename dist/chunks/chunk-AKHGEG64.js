// viewer/src/embedded/dom-shell.js
function renderViewerShell(root, title = "KiCAD-Prism Visualizer") {
  root.innerHTML = `
    <main id="app" class="prism-semantic-viewer-app">
      <nav class="workspace-rail" aria-label="Visualiser views">
        <button class="workspace-tab active" data-workspace="pcb" title="PCB visualiser">PCB</button>
        <button class="workspace-tab" data-workspace="schematic" title="Schematic world">Schematic</button>
      </nav>
      <section class="viewport-shell">
        <canvas id="viewport"></canvas>
        <canvas id="schematic-viewport" hidden></canvas>
        <div id="schematic-dom-layer" hidden></div>
        <canvas id="schematic-flow-overlay" hidden></canvas>
        <div id="panel-labels"></div>
        <div id="schematic-labels" hidden></div>
        <div id="selection-card" hidden></div>
        <canvas id="axis-gizmo" width="112" height="112" title="Click an axis to align the camera"></canvas>
        <div id="fallback" hidden></div>
      </section>
      <aside class="panel">
        <nav class="panel-rail" aria-label="Viewer tools">
          <button class="rail-tab active" data-tab="layers" title="Layers">Layers</button>
          <button class="rail-tab" data-tab="search" title="Search and selection">Find</button>
          <button class="rail-tab" data-tab="view" title="View controls">View</button>
          <button class="rail-tab" data-tab="inspect" title="Selection inspector">Inspect</button>
          <button class="rail-tab" data-tab="stats" title="Diagnostics">Stats</button>
        </nav>
        <div class="panel-drawer">
          <header>
            <p id="viewer-kind" class="eyebrow">Semantic GLTF A0</p>
            <h1>${escapeHtml(title)}</h1>
            <p id="status">Booting renderer</p>
          </header>
          <section class="tab-panel active" data-panel="layers">
            <div class="section-heading"><h2 id="primary-heading">Layers</h2><span id="primary-description">Visibility and compare</span></div>
            <div id="layers"></div>
          </section>
          <section class="tab-panel" data-panel="search">
            <div class="section-heading"><h2>Find</h2><span>Nets, components and pins</span></div>
            <div id="search-controls"></div>
          </section>
          <section class="tab-panel" data-panel="view">
            <div class="section-heading"><h2>View</h2><span>Camera and stackup</span></div>
            <div id="view-controls"></div>
          </section>
          <section class="tab-panel" data-panel="inspect">
            <div class="section-heading"><h2>Inspect</h2><span>Selected object</span></div>
            <pre id="selection">No object selected</pre>
          </section>
          <section class="tab-panel" data-panel="stats">
            <div class="section-heading"><h2>Diagnostics</h2><span>Runtime performance</span></div>
            <dl id="diagnostics"></dl>
          </section>
        </div>
      </aside>
    </main>
  `;
}
function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// viewer/src/embedded/source.js
async function resolveSemanticViewerSource(source) {
  if (!source) throw new Error("Semantic viewer source is required");
  if (source.topology && source.semanticGeometry) {
    return {
      title: source.title || source.projectName || "KiCAD-Prism Visualizer",
      topology: source.topology,
      semanticGeometry: absolutizeSemanticGeometry(source.semanticGeometry, source.assetBaseUrl || location.href)
    };
  }
  const [topology, semanticGeometry] = await Promise.all([
    fetchJson(source.topologyUrl, "topology"),
    fetchJson(source.semanticGeometryUrl, "semantic geometry")
  ]);
  return {
    title: source.title || source.projectName || topology?.design?.name || "KiCAD-Prism Visualizer",
    topology,
    semanticGeometry: absolutizeSemanticGeometry(semanticGeometry, source.assetBaseUrl || source.semanticGeometryUrl)
  };
}
function absolutizeSemanticGeometry(semanticGeometry, assetBaseUrl) {
  const output = structuredCloneSafe(semanticGeometry || {});
  const base = assetBaseUrl || location.href;
  for (const containerKey of ["assets", "semantic_gltf", "schematic_world", "schematic_vector", "schematic_scene"]) {
    const container = output[containerKey];
    if (!container || typeof container !== "object") continue;
    for (const [key, value] of Object.entries(container)) {
      if (typeof value === "string" && looksLikeAssetPath(value)) {
        container[key] = new URL(value, base).toString();
      }
    }
  }
  return output;
}
function looksLikeAssetPath(value) {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return false;
  try {
    new URL(value);
    return false;
  } catch {
    return true;
  }
}
async function fetchJson(url, label) {
  const response = await fetch(url, { cache: "default", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Failed to load ${label}: ${response.status}`);
  return response.json();
}
function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// viewer/src/index.js
var instanceCounter = 0;
async function createSemanticViewer(options) {
  if (!options?.root) throw new Error("createSemanticViewer requires a root element");
  const controller = new SemanticViewerController(options.root, options);
  await controller.mount();
  return controller;
}
var SemanticViewerController = class extends EventTarget {
  constructor(root, options = {}) {
    super();
    this.root = root;
    this.options = options;
    this.id = `prism-semantic-viewer-${++instanceCounter}`;
    this.source = options.source || null;
    this.runtime = null;
    this.paused = false;
    this.disposed = false;
  }
  async mount() {
    const resolved = await resolveSemanticViewerSource(this.source);
    renderViewerShell(this.root, resolved.title);
    window.__PRISM_SEMANTIC_VIEWER_MANUAL_BOOT__ = true;
    window.__TOPOLOGY__ = resolved.topology;
    window.__SEMANTIC_GEOMETRY__ = resolved.semanticGeometry;
    const runtime = await import("./main-7NM4CIHE.js");
    this.runtime = await runtime.mountStandaloneViewer({
      root: this.root,
      topology: resolved.topology,
      semanticGeometry: resolved.semanticGeometry
    });
    this.emit("ready", { source: resolved });
  }
  async setSource(source) {
    this.disposeRuntime();
    this.source = source;
    await this.mount();
  }
  setWorkspace(workspace) {
    this.click(`[data-workspace="${cssEscape(workspace)}"]`);
  }
  setMode(mode) {
    this.click(`[data-mode="${cssEscape(mode)}"]`);
  }
  setLayerMask(layerIds) {
    const wanted = new Set([...layerIds].map(String));
    for (const input of this.root.querySelectorAll("[data-layer]")) {
      const shouldCheck = wanted.has(String(input.dataset.layer));
      if (input.checked !== shouldCheck) {
        input.checked = shouldCheck;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }
  setActiveNet(netId) {
    const select = this.root.querySelector("#net-select");
    if (!select) return;
    select.value = String(netId || "");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  setSelectedFeature(featureId) {
    this.emit("selection-requested", { featureId });
  }
  clearSelection() {
    this.click("#clear-selection");
  }
  frameSelection() {
    this.click("#frame-selection");
  }
  frameBounds(bounds) {
    this.emit("frame-bounds-requested", { bounds });
  }
  setPaused(paused) {
    this.paused = Boolean(paused);
    this.root.classList.toggle("prism-semantic-viewer-paused", this.paused);
  }
  on(type, listener, options) {
    this.addEventListener(type, listener, options);
    return () => this.removeEventListener(type, listener, options);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeRuntime();
    this.root.replaceChildren();
    this.emit("dispose", {});
  }
  disposeRuntime() {
    this.runtime?.dispose?.();
    this.runtime = null;
  }
  click(selector) {
    const element = this.root.querySelector(selector);
    if (element instanceof HTMLElement) element.click();
  }
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
};
function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replaceAll('"', '\\"');
}

export {
  createSemanticViewer,
  SemanticViewerController
};
