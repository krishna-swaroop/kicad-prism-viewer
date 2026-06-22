# KiCad 3D Viz Dev

WebGPU-first, CAD-neutral visualisation prototype inspired by Wavenumber's
public 3D visualisation architecture.

This directory intentionally stands apart from KiCAD-Prism. Prism integration
is a future adapter; the runtime model here is a neutral topological scene
model plus GPU-friendly render buffers.

## Layout

- `references/`: cloned Wavenumber repositories for local code/reference.
- `pipeline/`: Python topology compiler, semantic glTF scene writer, and HTML
  exporter.
- `viewer/`: WebGPU viewer and bundled standards-based glTF loader.
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

Install the JavaScript tooling and rebuild the embedded glTF loader after
dependency changes:

```bash
npm install
npm run build:viewer
```

## Current Scope

Implemented now:

- `topology_model_a0` backed by `kicad_monkey`, including real board stackup.
- semantic copper generation from `KiCadDesign.to_pcb_ir()` with saved-zone
  validation and analytic track, arc, pad, via, and zone contours.
- tiled `prism.semantic_gltf_a0` GLBs using `EXT_mesh_features`,
  `EXT_meshopt_compression`, and `KHR_mesh_quantization`.
- `_FEATURE_ID_0` net ownership and `_FEATURE_ID_1` source-object ownership.
- progressive WebGPU loading of only the active copper layer in Layer View.
- click-to-net picking for tracks, zones, pads, and vias.
- net metadata inspection and GPU net-class highlighting.
- independent outer and inner copper layer views.
- orbit, pan, zoom, net isolation, and exploded-stackup 3D controls.

KiCad GLB is used only for board context and component models. Copper
ownership is assigned from PCB IR before tessellation; no aggregate or per-net
copper GLB is generated. Surface copper is the production render LOD at its
real stackup height. Copper thickness remains metadata for later solid
inspection and FEM meshing. Build inputs are cached under `samples/.cache/`.
