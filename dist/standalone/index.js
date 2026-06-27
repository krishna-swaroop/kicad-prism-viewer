// viewer/src/standalone/index.js
async function mountStandaloneViewer(options = {}) {
  window.__PRISM_SEMANTIC_VIEWER_MANUAL_BOOT__ = true;
  const runtime = await import("../chunks/main-7NM4CIHE.js");
  return runtime.mountStandaloneViewer(options);
}
export {
  mountStandaloneViewer
};
