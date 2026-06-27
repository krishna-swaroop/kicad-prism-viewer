export function renderViewerShell(root, title = "KiCAD-Prism Visualizer") {
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
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
