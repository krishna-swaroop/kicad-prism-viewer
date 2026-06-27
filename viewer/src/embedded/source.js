export async function resolveSemanticViewerSource(source) {
  if (!source) throw new Error("Semantic viewer source is required");
  if (source.topology && source.semanticGeometry) {
    return {
      title: source.title || source.projectName || "KiCAD-Prism Visualizer",
      topology: source.topology,
      semanticGeometry: absolutizeSemanticGeometry(source.semanticGeometry, source.assetBaseUrl || location.href),
    };
  }

  const [topology, semanticGeometry] = await Promise.all([
    fetchJson(source.topologyUrl, "topology"),
    fetchJson(source.semanticGeometryUrl, "semantic geometry"),
  ]);
  return {
    title: source.title || source.projectName || topology?.design?.name || "KiCAD-Prism Visualizer",
    topology,
    semanticGeometry: absolutizeSemanticGeometry(semanticGeometry, source.assetBaseUrl || source.semanticGeometryUrl),
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
