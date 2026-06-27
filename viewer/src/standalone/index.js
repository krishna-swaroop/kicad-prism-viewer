export async function mountStandaloneViewer(options = {}) {
  window.__PRISM_SEMANTIC_VIEWER_MANUAL_BOOT__ = true;
  const runtime = await import("../main.js");
  return runtime.mountStandaloneViewer(options);
}
