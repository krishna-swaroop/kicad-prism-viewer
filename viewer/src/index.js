import { renderViewerShell } from "./embedded/dom-shell.js";
import { resolveSemanticViewerSource } from "./embedded/source.js";

let instanceCounter = 0;

export async function createSemanticViewer(options) {
  if (!options?.root) throw new Error("createSemanticViewer requires a root element");
  const controller = new SemanticViewerController(options.root, options);
  await controller.mount();
  return controller;
}

export class SemanticViewerController extends EventTarget {
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
    const runtime = await import("./main.js");
    this.runtime = await runtime.mountStandaloneViewer({
      root: this.root,
      topology: resolved.topology,
      semanticGeometry: resolved.semanticGeometry,
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
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replaceAll('"', '\\"');
}
