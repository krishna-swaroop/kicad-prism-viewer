import {
  createSemanticViewer
} from "../chunks/chunk-AKHGEG64.js";

// viewer/src/react/index.jsx
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
var PrismSemanticVisualizer = forwardRef(function PrismSemanticVisualizer2({
  source,
  workspace = "pcb",
  mode,
  layerMask,
  activeNet,
  selectedFeature,
  paused = false,
  className = "",
  style,
  onReady,
  onError,
  onSelectionChange,
  onTelemetry
}, ref) {
  const rootRef = useRef(null);
  const controllerRef = useRef(null);
  const [error, setError] = useState(null);
  useImperativeHandle(ref, () => controllerRef.current, []);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!rootRef.current || !source) return void 0;
    createSemanticViewer({ root: rootRef.current, source }).then((controller) => {
      if (cancelled) {
        controller.dispose();
        return;
      }
      controllerRef.current = controller;
      controller.on("selection-change", (event) => onSelectionChange?.(event.detail));
      controller.on("telemetry", (event) => onTelemetry?.(event.detail));
      onReady?.(controller);
    }).catch((err) => {
      if (cancelled) return;
      setError(err);
      onError?.(err);
    });
    return () => {
      cancelled = true;
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, [source?.topologyUrl, source?.semanticGeometryUrl, source?.assetBaseUrl, source?.revision]);
  useEffect(() => {
    controllerRef.current?.setWorkspace(workspace);
  }, [workspace]);
  useEffect(() => {
    if (mode) controllerRef.current?.setMode(mode);
  }, [mode]);
  useEffect(() => {
    if (layerMask) controllerRef.current?.setLayerMask(layerMask);
  }, [layerMask]);
  useEffect(() => {
    if (activeNet !== void 0) controllerRef.current?.setActiveNet(activeNet);
  }, [activeNet]);
  useEffect(() => {
    if (selectedFeature !== void 0) controllerRef.current?.setSelectedFeature(selectedFeature);
  }, [selectedFeature]);
  useEffect(() => {
    controllerRef.current?.setPaused(paused);
  }, [paused]);
  return /* @__PURE__ */ React.createElement("div", { className: `prism-semantic-visualizer ${className}`, style }, /* @__PURE__ */ React.createElement("div", { ref: rootRef, className: "prism-semantic-visualizer__mount" }), error ? /* @__PURE__ */ React.createElement("div", { className: "prism-semantic-visualizer__error", role: "alert" }, /* @__PURE__ */ React.createElement("strong", null, "Visualizer failed"), /* @__PURE__ */ React.createElement("span", null, error.message || String(error))) : null);
});
export {
  PrismSemanticVisualizer
};
