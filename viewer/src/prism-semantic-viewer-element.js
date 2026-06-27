import viewerCss from "../styles.css";
import { mountStandaloneViewer } from "./main.js";

const SUPPORTED_SCHEMA = "prism.visualizer_bundle.a0";

function shellHtml(title) {
  const escapedTitle = escapeHtml(title || "Semantic Visualizer");
  return `
    <style>${viewerCss}</style>
    <main id="app">
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
            <h1>${escapedTitle}</h1>
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
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "default" });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return response.json();
}

function absolutizeAssetPaths(semanticGeometry, bundleUrl, bundle) {
  const assetBase = new URL(bundle.asset_base || "./", bundleUrl);
  const output = structuredClone(semanticGeometry || {});
  const absolutize = (value) => {
    if (!value || typeof value !== "string") return value;
    return new URL(value, assetBase).toString();
  };
  for (const groupName of ["assets", "semantic_gltf", "schematic_world", "schematic_vector", "schematic_scene"]) {
    const group = output[groupName];
    if (!group || typeof group !== "object") continue;
    for (const [key, value] of Object.entries(group)) group[key] = absolutize(value);
  }
  return output;
}

async function loadBundle(bundleUrl) {
  const absoluteBundleUrl = new URL(bundleUrl, document.baseURI).toString();
  const bundle = await fetchJson(absoluteBundleUrl);
  if (bundle.schema !== SUPPORTED_SCHEMA) {
    throw new Error(`Unsupported visualizer bundle schema: ${bundle.schema || "missing"}`);
  }
  const topologyUrl = new URL(bundle.topology || "topology.json", absoluteBundleUrl);
  const semanticGeometryUrl = new URL(bundle.semantic_geometry || "semantic_geometry.json", absoluteBundleUrl);
  const [topology, semanticGeometry] = await Promise.all([
    fetchJson(topologyUrl),
    fetchJson(semanticGeometryUrl),
  ]);
  return {
    bundle,
    topology,
    semanticGeometry: absolutizeAssetPaths(semanticGeometry, absoluteBundleUrl, bundle),
  };
}

export class PrismSemanticViewerElement extends HTMLElement {
  static get observedAttributes() {
    return ["bundle-url"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.controller = null;
    this.abortController = null;
  }

  connectedCallback() {
    void this.reload();
  }

  disconnectedCallback() {
    this.abortController?.abort();
    this.controller?.dispose?.();
    this.controller = null;
  }

  attributeChangedCallback() {
    if (this.isConnected) void this.reload();
  }

  async reload() {
    const bundleUrl = this.getAttribute("bundle-url");
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.controller?.dispose?.();
    this.controller = null;
    if (!bundleUrl) {
      this.shadowRoot.innerHTML = `<style>:host{display:block;height:100%;font:14px system-ui;color:#94a3b8}</style><div>Semantic bundle URL is missing.</div>`;
      return;
    }
    try {
      this.shadowRoot.innerHTML = `<style>:host{display:block;height:100%;background:#020817;color:#e5e7eb;font:14px system-ui}</style><div style="display:grid;place-items:center;height:100%">Loading semantic visualizer...</div>`;
      const { bundle, topology, semanticGeometry } = await loadBundle(bundleUrl);
      if (this.abortController.signal.aborted) return;
      this.shadowRoot.innerHTML = shellHtml(bundle.project_name || topology?.design?.name || "Semantic Visualizer");
      this.controller = await mountStandaloneViewer({
        root: this.shadowRoot,
        topology,
        semanticGeometry,
      });
      this.dispatchEvent(new CustomEvent("prism-semantic-viewer:ready", { bubbles: true }));
    } catch (error) {
      console.error(error);
      this.shadowRoot.innerHTML = `
        <style>
          :host{display:block;height:100%;background:#020817;color:#e5e7eb;font:14px system-ui}
          .error{height:100%;display:grid;place-items:center;padding:24px}
          pre{max-width:100%;white-space:pre-wrap;color:#fecaca;background:#111827;border:1px solid #374151;padding:16px}
        </style>
        <div class="error"><pre>${escapeHtml(error?.stack || error?.message || String(error))}</pre></div>
      `;
      this.dispatchEvent(new CustomEvent("prism-semantic-viewer:error", { bubbles: true, detail: { error } }));
    }
  }

  setSelection(selection) {
    this.controller?.setSelection?.(selection);
  }

  resize() {
    this.controller?.resize?.();
  }
}

export function definePrismSemanticViewer() {
  if (!customElements.get("prism-semantic-viewer")) {
    customElements.define("prism-semantic-viewer", PrismSemanticViewerElement);
  }
}
