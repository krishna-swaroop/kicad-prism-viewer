import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createSemanticViewer } from "../index.js";

export const PrismSemanticVisualizer = forwardRef(function PrismSemanticVisualizer(
  {
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
    onTelemetry,
  },
  ref,
) {
  const rootRef = useRef(null);
  const controllerRef = useRef(null);
  const [error, setError] = useState(null);

  useImperativeHandle(ref, () => controllerRef.current, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!rootRef.current || !source) return undefined;

    createSemanticViewer({ root: rootRef.current, source })
      .then((controller) => {
        if (cancelled) {
          controller.dispose();
          return;
        }
        controllerRef.current = controller;
        controller.on("selection-change", (event) => onSelectionChange?.(event.detail));
        controller.on("telemetry", (event) => onTelemetry?.(event.detail));
        onReady?.(controller);
      })
      .catch((err) => {
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
    if (activeNet !== undefined) controllerRef.current?.setActiveNet(activeNet);
  }, [activeNet]);

  useEffect(() => {
    if (selectedFeature !== undefined) controllerRef.current?.setSelectedFeature(selectedFeature);
  }, [selectedFeature]);

  useEffect(() => {
    controllerRef.current?.setPaused(paused);
  }, [paused]);

  return (
    <div className={`prism-semantic-visualizer ${className}`} style={style}>
      <div ref={rootRef} className="prism-semantic-visualizer__mount" />
      {error ? (
        <div className="prism-semantic-visualizer__error" role="alert">
          <strong>Visualizer failed</strong>
          <span>{error.message || String(error)}</span>
        </div>
      ) : null}
    </div>
  );
});
