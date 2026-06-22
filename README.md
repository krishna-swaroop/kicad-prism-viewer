# KiCad 3D Viz Dev

WebGPU-first, CAD-neutral visualisation prototype inspired by Wavenumber's
public 3D visualisation architecture.

This directory intentionally stands apart from KiCAD-Prism. Prism integration
is a future adapter; the runtime model here is a neutral topological scene
model plus GPU-friendly render buffers.

## Layout

- `references/`: cloned Wavenumber repositories for local code/reference.
- `pipeline/`: Python topology compiler, GPU scene bundle writer, and HTML
  exporter.
- `viewer/`: dependency-free browser viewer source.
- `samples/`: generated sample topology, scene, and standalone HTML.
- `tests/`: Python contract/unit tests.
- `docs/`: implementation notes and reference repository SHAs.

## Quick Start

Generate the sample bundle and standalone viewer:

```bash
/Users/Swaroop/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  -m pipeline.topology_compiler sample --output samples/basic
```

Open `samples/basic/viewer.html` in a browser with WebGPU support. The viewer
falls back to a Canvas 2D diagnostic mode if WebGPU is unavailable.

Run tests:

```bash
/Users/Swaroop/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  -m unittest discover -s tests
```

Build the USB-PD Trigger Board sample:

```bash
bash scripts/build_usb_pd_sample.sh
```

## Current Scope

Implemented now:

- `topology_model_a0` backed by `kicad_monkey`, including real board stackup.
- semantic copper generation from `KiCadDesign.to_pcb_ir()` with saved-zone
  validation and Geometer planar union/triangulation.
- `semantic_scene_a4` with visual net features, authoritative source-object
  indexes, 32-bit layer masks, quantized
  16-byte vertices, 16-bit indices, tiled LOD chunks, and Zstandard compression.
- progressive WebGPU loading with worker-based native/WASM decompression.
- click-to-net picking for tracks, zones, pads, and vias.
- component geometry deduplication and GPU instancing.
- independent outer and inner copper layer views.
- orbit, pan, zoom, net isolation, and exploded-stackup 3D controls.

KiCad GLB is now used only for the board context and component models. Copper
ownership is assigned from PCB IR before tessellation; no aggregate or per-net
copper GLB is generated. Build intermediates are cached under `.cache/geometry`.
