# Architecture Notes

## Runtime Shape

The visualiser is intentionally driven by `topology_model_a0`, not by a Prism
viewer API. The compiler converts KiCad-derived design data into a neutral
graph of components, nets, terminals, physical objects, schematic pages, and
lookup indexes. The PCB renderer consumes `prism.semantic_scene_a4`:

- `visual_features.bin` maps fused render copper to exact net/layer ownership.
- `object_index.bin` retains source UUID geometry for click identity.
- compressed chunks contain shared quantized 3D solids.
- `net_to_chunks` supports progressive selected-net loading.

## Why SVG Is Not The Main Runtime

Enriched SVG is useful because it carries source ids, net/component metadata,
view metadata, and high-fidelity drawing primitives. Large interactive designs
should not depend on a large SVG DOM for hit testing or highlighting. The v0
compiler extracts those semantic links into topology indexes; later geometry
passes should convert SVG paths into vector/tile buffers and spatial indexes.

## Semantic Copper Pipeline

`kicad_monkey` is the semantic authority. `KiCadDesign.to_pcb_ir()` supplies
tracks, arcs, pads, vias, layers, nets, UUIDs, and saved zone fills. Copper
records are grouped by `(net, layer)` before geometry processing. Geometer
expands strokes, unions same-net copper, preserves holes, and triangulates the
result. The compiler then extrudes each region at its real stackup position.

Click-to-net reads the immutable net ID carried by the picked visual feature.
Click-to-object reconstructs the hit point and queries `object_index.bin` using
the priority `pad > via > track/arc > zone`. It does not infer ownership from
overlapping aggregate GLB meshes.

Layer View and 3D View render the same solids. Layer View changes only the
orthographic camera and visibility mask.

## USB-PD Trigger Board

`scripts/build_usb_pd_sample.sh` compiles the local USB-PD Trigger Board
through `kicad_monkey`, Geometer, and the A4 scene packer. KiCad GLB contributes
the board body, soldermask, silkscreen, and component models only.
