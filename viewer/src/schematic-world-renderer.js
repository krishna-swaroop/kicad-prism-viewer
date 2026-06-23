import { clamp } from "./math.js";

const PAGE_SHADER = `
struct Globals {
  camera: vec4f,
  viewport: vec2f,
  activeNet: u32,
  _pad: u32,
};
struct Page {
  originSize: vec4f,
  flags: vec4f,
};
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<uniform> page: Page;
@group(0) @binding(2) var pageSampler: sampler;
@group(0) @binding(3) var pageTexture: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0)
  );
  let uv = positions[index];
  let world = page.originSize.xy + uv * page.originSize.zw;
  let halfViewport = globals.viewport * globals.camera.z * 0.5;
  let clip = vec2f(
    (world.x - globals.camera.x) / halfViewport.x,
    -(world.y - globals.camera.y) / halfViewport.y
  );
  var out: VertexOut;
  out.position = vec4f(clip, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment fn fs(input: VertexOut) -> @location(0) vec4f {
  let sampled = textureSample(pageTexture, pageSampler, input.uv);
  let edge = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
  let selected = page.flags.x > 0.5;
  let containsNet = page.flags.y > 0.5;
  let hasActiveNet = page.flags.z > 0.5;
  if (edge < 0.006) {
    if (containsNet) { return vec4f(0.12, 0.92, 0.35, 1.0); }
    if (selected) { return vec4f(0.12, 0.45, 0.95, 1.0); }
    return vec4f(0.28, 0.32, 0.39, 1.0);
  }
  let dim = select(1.0, select(0.42, 1.0, containsNet), hasActiveNet);
  return vec4f(sampled.rgb * dim, 1.0);
}`;

const EDGE_SHADER = `
struct Globals {
  camera: vec4f,
  viewport: vec2f,
  activeNet: u32,
  _pad: u32,
};
@group(0) @binding(0) var<uniform> globals: Globals;
struct Out { @builtin(position) position: vec4f };
@vertex fn vs(@location(0) world: vec2f) -> Out {
  let halfViewport = globals.viewport * globals.camera.z * 0.5;
  let clip = vec2f(
    (world.x - globals.camera.x) / halfViewport.x,
    -(world.y - globals.camera.y) / halfViewport.y
  );
  var out: Out;
  out.position = vec4f(clip, 0.4, 1.0);
  return out;
}
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(0.22, 0.48, 0.82, 0.82);
}`;

const HIGHLIGHT_SHADER = `
struct Globals {
  camera: vec4f,
  viewport: vec2f,
  activeNet: u32,
  _pad: u32,
};
@group(0) @binding(0) var<uniform> globals: Globals;
struct Out { @builtin(position) position: vec4f };
@vertex fn vs(@location(0) world: vec2f) -> Out {
  let halfViewport = globals.viewport * globals.camera.z * 0.5;
  let clip = vec2f(
    (world.x - globals.camera.x) / halfViewport.x,
    -(world.y - globals.camera.y) / halfViewport.y
  );
  var out: Out;
  out.position = vec4f(clip, 0.2, 1.0);
  return out;
}
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(0.08, 1.0, 0.27, 0.96);
}`;

const VECTOR_SHADER = `
struct Globals {
  camera: vec4f,
  viewport: vec2f,
  activeNet: u32,
  _pad: u32,
};
@group(0) @binding(0) var<uniform> globals: Globals;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};
@vertex fn vs(@location(0) world: vec2f, @location(1) color: vec4f) -> Out {
  let halfViewport = globals.viewport * globals.camera.z * 0.5;
  let clip = vec2f(
    (world.x - globals.camera.x) / halfViewport.x,
    -(world.y - globals.camera.y) / halfViewport.y
  );
  var out: Out;
  out.position = vec4f(clip, 0.1, 1.0);
  out.color = color;
  return out;
}
@fragment fn fs(input: Out) -> @location(0) vec4f {
  return input.color;
}`;

const PICK_SHADER = `
struct Globals {
  camera: vec4f,
  viewport: vec2f,
  activeNet: u32,
  _pad: u32,
};
@group(0) @binding(0) var<uniform> globals: Globals;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) featureId: u32,
};
@vertex fn vs(@location(0) world: vec2f, @location(1) featureId: u32) -> Out {
  let halfViewport = globals.viewport * globals.camera.z * 0.5;
  let clip = vec2f(
    (world.x - globals.camera.x) / halfViewport.x,
    -(world.y - globals.camera.y) / halfViewport.y
  );
  var out: Out;
  out.position = vec4f(clip, 0.0, 1.0);
  out.featureId = featureId;
  return out;
}
@fragment fn fs(input: Out) -> @location(0) u32 {
  return input.featureId;
}`;

const NATIVE_DETAIL_PAGE_PIXELS = 760;
const MAX_VECTOR_FLOATS = 4 * 1024 * 1024;
const MAX_PICK_VERTICES = 512 * 1024;

export class SchematicWorldRenderer {
  static async create(canvas, manifestUrl) {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable in this browser");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice();
    const response = await fetch(manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load schematic manifest: ${response.status}`);
    const manifest = await response.json();
    if (!["prism.schematic_world_a0", "prism.schematic_scene_a0"].includes(manifest.schema)) {
      throw new Error(`Unsupported schematic scene schema: ${manifest.schema}`);
    }
    const featurePath = manifest.featureTable || manifest.features;
    const featureResponse = await fetch(new URL(featurePath, manifestUrl), { cache: "no-store" });
    if (!featureResponse.ok) throw new Error(`Failed to load schematic features: ${featureResponse.status}`);
    const features = normalizeFeatureTable(await featureResponse.json());
    return new SchematicWorldRenderer(canvas, device, manifestUrl, manifest, features);
  }

  constructor(canvas, device, manifestUrl, manifest, featuresByPage) {
    this.canvas = canvas;
    this.device = device;
    this.manifestUrl = manifestUrl;
    this.manifest = manifest;
    this.isNativeScene = manifest.schema === "prism.schematic_scene_a0";
    this.pages = manifest.pages || [];
    this.featuresByPage = featuresByPage;
    this.featuresById = new Map();
    for (const items of Object.values(featuresByPage)) {
      for (const feature of items) this.featuresById.set(Number(feature.id), feature);
    }
    this.context = canvas.getContext("webgpu");
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });
    this.globalBuffer = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    const pageModule = device.createShaderModule({ code: PAGE_SHADER });
    this.pagePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: pageModule, entryPoint: "vs" },
      fragment: { module: pageModule, entryPoint: "fs", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });
    this.edgeLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const edgeModule = device.createShaderModule({ code: EDGE_SHADER });
    this.edgePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.edgeLayout] }),
      vertex: {
        module: edgeModule,
        entryPoint: "vs",
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
      },
      fragment: {
        module: edgeModule,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        }],
      },
      primitive: { topology: "line-list" },
    });
    this.edgeBindGroup = device.createBindGroup({
      layout: this.edgeLayout,
      entries: [{ binding: 0, resource: { buffer: this.globalBuffer } }],
    });
    const highlightModule = device.createShaderModule({ code: HIGHLIGHT_SHADER });
    this.highlightPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.edgeLayout] }),
      vertex: {
        module: highlightModule,
        entryPoint: "vs",
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
      },
      fragment: {
        module: highlightModule,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        }],
      },
      primitive: { topology: "line-list" },
    });
    this.highlightBufferSize = 4 * 1024 * 1024;
    this.highlightBuffer = device.createBuffer({
      size: this.highlightBufferSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const vectorModule = device.createShaderModule({ code: VECTOR_SHADER });
    this.vectorPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.edgeLayout] }),
      vertex: {
        module: vectorModule,
        entryPoint: "vs",
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: vectorModule,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        }],
      },
      primitive: { topology: "line-list" },
    });
    this.vectorBuffer = device.createBuffer({
      size: MAX_VECTOR_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const pickModule = device.createShaderModule({ code: PICK_SHADER });
    this.pickPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.edgeLayout] }),
      vertex: {
        module: pickModule,
        entryPoint: "vs",
        buffers: [{
          arrayStride: 12,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "uint32" },
          ],
        }],
      },
      fragment: { module: pickModule, entryPoint: "fs", targets: [{ format: "r32uint" }] },
      primitive: { topology: "line-list" },
    });
    this.pickVertexBuffer = device.createBuffer({
      size: MAX_PICK_VERTICES * 12,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.pickReadBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.pickTexture = null;
    this.pickTextureSize = [0, 0];
    this.pickPending = false;
    this.vectorChunks = new Map();
    this.residentVectorBytes = 0;
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    this.placeholder = this.createSolidTexture([245, 247, 249, 255]);
    this.pageResources = new Map();
    this.loading = new Map();
    this.selectedPageId = "";
    this.activeNetUid = "";
    this.showHierarchy = true;
    this.downloadedBytes = 0;
    this.world = manifest.worldBoundsMm;
    this.center = [
      (this.world.minX + this.world.maxX) / 2,
      (this.world.minY + this.world.maxY) / 2,
    ];
    this.scale = Math.max(
      (this.world.maxX - this.world.minX) / 900,
      (this.world.maxY - this.world.minY) / 650,
      0.1,
    ) * 1.16;
    this.edgeBuffer = this.createEdgeBuffer();
    for (const page of this.pages) this.createPageResource(page);
  }

  createSolidTexture(rgba) {
    const texture = this.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      new Uint8Array(rgba),
      { bytesPerRow: 4 },
      [1, 1],
    );
    return texture;
  }

  createPageResource(page) {
    const uniform = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const resource = {
      page,
      uniform,
      texture: this.placeholder,
      textureWidth: 0,
      svgBlob: null,
      bindGroup: null,
    };
    this.pageResources.set(page.id, resource);
    this.updateBindGroup(resource);
  }

  updateBindGroup(resource) {
    resource.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.globalBuffer } },
        { binding: 1, resource: { buffer: resource.uniform } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: resource.texture.createView() },
      ],
    });
  }

  createEdgeBuffer() {
    const byId = new Map(this.pages.map((page) => [page.id, page]));
    const vertices = [];
    for (const edge of this.manifest.edges || []) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) continue;
      vertices.push(
        source.worldX + source.widthMm / 2,
        source.worldY + source.heightMm,
        target.worldX + target.widthMm / 2,
        target.worldY,
      );
    }
    const data = new Float32Array(vertices);
    if (!data.length) return null;
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    return { buffer, count: data.length / 2 };
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  writeGlobals() {
    const data = new ArrayBuffer(48);
    const floats = new Float32Array(data);
    floats.set([this.center[0], this.center[1], this.scale, 0], 0);
    floats.set([this.canvas.width, this.canvas.height], 4);
    this.device.queue.writeBuffer(this.globalBuffer, 0, data);
  }

  pagePixelWidth(page) {
    return page.widthMm / this.scale;
  }

  visiblePages() {
    const halfW = this.canvas.width * this.scale / 2;
    const halfH = this.canvas.height * this.scale / 2;
    const left = this.center[0] - halfW;
    const right = this.center[0] + halfW;
    const top = this.center[1] - halfH;
    const bottom = this.center[1] + halfH;
    return this.pages.filter((page) =>
      page.worldX + page.widthMm >= left
      && page.worldX <= right
      && page.worldY + page.heightMm >= top
      && page.worldY <= bottom);
  }

  render() {
    this.resize();
    this.writeGlobals();
    const visible = this.visiblePages();
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.045, g: 0.055, b: 0.073, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    if (this.showHierarchy && this.edgeBuffer) {
      pass.setPipeline(this.edgePipeline);
      pass.setBindGroup(0, this.edgeBindGroup);
      pass.setVertexBuffer(0, this.edgeBuffer.buffer);
      pass.draw(this.edgeBuffer.count);
    }
    pass.setPipeline(this.pagePipeline);
    for (const page of visible) {
      const resource = this.pageResources.get(page.id);
      const containsNet = this.activeNetUid && page.netUids.includes(this.activeNetUid);
      const values = new Float32Array([
        page.worldX, page.worldY, page.widthMm, page.heightMm,
        page.id === this.selectedPageId ? 1 : 0,
        containsNet ? 1 : 0,
        this.activeNetUid ? 1 : 0,
        0,
      ]);
      this.device.queue.writeBuffer(resource.uniform, 0, values);
      pass.setBindGroup(0, resource.bindGroup);
      pass.draw(6);
      const wantedWidth = clamp(
        Math.ceil(this.pagePixelWidth(page) * 1.3 / 512) * 512,
        512,
        6144,
      );
      if (resource.textureWidth < wantedWidth * 0.82) void this.loadPageTexture(page, wantedWidth);
      if (this.isNativeScene && this.pagePixelWidth(page) > NATIVE_DETAIL_PAGE_PIXELS) {
        void this.loadPageVectors(page);
      }
    }
    const vectorCount = this.writeVisibleVectors(visible);
    if (vectorCount) {
      pass.setPipeline(this.vectorPipeline);
      pass.setBindGroup(0, this.edgeBindGroup);
      pass.setVertexBuffer(0, this.vectorBuffer);
      pass.draw(vectorCount);
    }
    const highlightCount = this.writeNetHighlights(visible);
    if (highlightCount) {
      pass.setPipeline(this.highlightPipeline);
      pass.setBindGroup(0, this.edgeBindGroup);
      pass.setVertexBuffer(0, this.highlightBuffer);
      pass.draw(highlightCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return visible;
  }

  writeVisibleVectors(visiblePages) {
    if (!this.isNativeScene) return 0;
    const floats = [];
    const selectedFeatureIds = new Set();
    for (const page of visiblePages) {
      const chunk = this.vectorChunks.get(page.id);
      if (!chunk?.segments?.length) continue;
      const pageIsDetailed = this.pagePixelWidth(page) > NATIVE_DETAIL_PAGE_PIXELS * 0.72;
      if (!pageIsDetailed) continue;
      for (const segment of chunk.segments) {
        const feature = this.featuresById.get(segment.featureId);
        const isSelectedNet = this.activeNetUid && feature?.netUid === this.activeNetUid;
        if (this.activeNetUid && !isSelectedNet && isElectricalFeature(feature)) continue;
        const color = isSelectedNet
          ? [0.06, 1.0, 0.24, 1.0]
          : vectorColor(feature, segment.kind);
        const a = this.sourceToWorld(page, segment.a);
        const b = this.sourceToWorld(page, segment.b);
        floats.push(a[0], a[1], ...color, b[0], b[1], ...color);
        selectedFeatureIds.add(segment.featureId);
        if (floats.length >= MAX_VECTOR_FLOATS - 12) break;
      }
    }
    if (!floats.length) return 0;
    const data = new Float32Array(floats);
    this.device.queue.writeBuffer(this.vectorBuffer, 0, data);
    return data.length / 6;
  }

  writeNetHighlights(visiblePages) {
    if (!this.activeNetUid) return 0;
    const values = [];
    for (const page of visiblePages) {
      for (const feature of this.featuresByPage[page.id] || []) {
        if (feature.netUid !== this.activeNetUid || !feature.boundsMm) continue;
        const bounds = this.featureWorldBounds(page, feature.boundsMm);
        values.push(
          bounds[0], bounds[1], bounds[2], bounds[1],
          bounds[2], bounds[1], bounds[2], bounds[3],
          bounds[2], bounds[3], bounds[0], bounds[3],
          bounds[0], bounds[3], bounds[0], bounds[1],
        );
      }
    }
    if (!values.length) return 0;
    const data = new Float32Array(values.slice(0, this.highlightBufferSize / 4));
    this.device.queue.writeBuffer(this.highlightBuffer, 0, data);
    return data.length / 2;
  }

  featureWorldBounds(page, bounds) {
    return [
      page.worldX + bounds[0] / page.sourceWidthMm * page.widthMm,
      page.worldY + bounds[1] / page.sourceHeightMm * page.heightMm,
      page.worldX + bounds[2] / page.sourceWidthMm * page.widthMm,
      page.worldY + bounds[3] / page.sourceHeightMm * page.heightMm,
    ];
  }

  sourceToWorld(page, point) {
    return [
      page.worldX + point[0] / page.sourceWidthMm * page.widthMm,
      page.worldY + point[1] / page.sourceHeightMm * page.heightMm,
    ];
  }

  async loadPageVectors(page) {
    if (!this.isNativeScene || !page.chunks?.lod2) return null;
    const existing = this.vectorChunks.get(page.id);
    if (existing?.loaded) return existing;
    if (existing?.promise) return existing.promise;
    const promise = (async () => {
      const response = await fetch(new URL(page.chunks.lod2, this.manifestUrl), { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to load schematic vector chunk ${page.id}: ${response.status}`);
      const payload = await response.json();
      const segments = primitiveSegments(payload.primitives || []);
      const bytes = JSON.stringify(payload).length;
      const chunk = { loaded: true, segments, unsupported: payload.unsupported || [], bytes };
      this.vectorChunks.set(page.id, chunk);
      this.residentVectorBytes += bytes;
      return chunk;
    })();
    this.vectorChunks.set(page.id, { loaded: false, promise, segments: [] });
    return promise;
  }

  async loadPageTexture(page, width) {
    const key = `${page.id}:${width}`;
    if (this.loading.has(key)) return this.loading.get(key);
    const resource = this.pageResources.get(page.id);
    if (!resource || resource.textureWidth >= width) return;
    const promise = (async () => {
      if (!resource.svgBlob) {
        const response = await fetch(new URL(thumbnailPath(page), this.manifestUrl));
        if (!response.ok) throw new Error(`Failed to load schematic page ${page.name}: ${response.status}`);
        resource.svgBlob = await response.blob();
        this.downloadedBytes += resource.svgBlob.size;
      }
      const blob = resource.svgBlob;
      const objectUrl = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.decoding = "async";
        image.src = objectUrl;
        await image.decode();
        if (resource.textureWidth >= width) return;
        const height = Math.max(64, Math.round(width * page.heightMm / page.widthMm));
        const bitmapCanvas = new OffscreenCanvas(width, height);
        const context = bitmapCanvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const bitmap = await createImageBitmap(bitmapCanvas);
        const texture = this.device.createTexture({
          size: [width, height],
          format: "rgba8unorm-srgb",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [width, height]);
        bitmap.close();
        if (resource.texture !== this.placeholder) resource.texture.destroy();
        resource.texture = texture;
        resource.textureWidth = width;
        this.updateBindGroup(resource);
      } finally {
        URL.revokeObjectURL(objectUrl);
        this.loading.delete(key);
      }
    })();
    this.loading.set(key, promise);
    return promise;
  }

  preloadOverview() {
    const queue = [...this.pages];
    const worker = async () => {
      while (queue.length) {
        const page = queue.shift();
        await this.loadPageTexture(page, 512);
      }
    };
    return Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  }

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * this.canvas.width / rect.width;
    const y = (clientY - rect.top) * this.canvas.height / rect.height;
    return [
      this.center[0] + (x - this.canvas.width / 2) * this.scale,
      this.center[1] + (y - this.canvas.height / 2) * this.scale,
    ];
  }

  worldToScreen(x, y) {
    const ratioX = this.canvas.clientWidth / this.canvas.width;
    const ratioY = this.canvas.clientHeight / this.canvas.height;
    return [
      ((x - this.center[0]) / this.scale + this.canvas.width / 2) * ratioX,
      ((y - this.center[1]) / this.scale + this.canvas.height / 2) * ratioY,
    ];
  }

  hitPage(clientX, clientY) {
    const [x, y] = this.screenToWorld(clientX, clientY);
    return [...this.pages].reverse().find((page) =>
      x >= page.worldX && x <= page.worldX + page.widthMm
      && y >= page.worldY && y <= page.worldY + page.heightMm) || null;
  }

  async pickFeature(clientX, clientY) {
    if (!this.isNativeScene) return this.hitFeature(clientX, clientY);
    const page = this.hitPage(clientX, clientY);
    if (!page) return null;
    await this.loadPageVectors(page);
    const feature = await this.gpuPickFeature(page, clientX, clientY);
    if (feature) return { page, feature, source: this.clientToSource(page, clientX, clientY), native: true, gpu: true };
    return this.hitFeature(clientX, clientY);
  }

  hitFeature(clientX, clientY) {
    const page = this.hitPage(clientX, clientY);
    if (!page) return null;
    const [sourceX, sourceY] = this.clientToSource(page, clientX, clientY);
    const tolerance = Math.max(
      0.45,
      5 * this.scale * this.canvas.width / Math.max(1, this.canvas.clientWidth)
        * page.sourceWidthMm / page.widthMm,
    );
    const priorities = {
      symbol_instance: 6,
      sheet: 5,
      junction: 4,
      no_connect: 4,
      wire: 3,
      text: 2,
      image: 1,
    };
    const vectorHit = this.hitResidentVectorFeature(page, sourceX, sourceY, tolerance);
    if (vectorHit) return { page, feature: vectorHit, source: [sourceX, sourceY], native: true };
    const candidates = (this.featuresByPage[page.id] || [])
      .filter((feature) => {
        const bounds = feature.boundsMm;
        return bounds
          && sourceX >= bounds[0] - tolerance
          && sourceX <= bounds[2] + tolerance
          && sourceY >= bounds[1] - tolerance
          && sourceY <= bounds[3] + tolerance;
      })
      .map((feature) => ({
        feature,
        priority: priorities[feature.kind] || 0,
        area: Math.max(0.0001, (feature.boundsMm[2] - feature.boundsMm[0]) * (feature.boundsMm[3] - feature.boundsMm[1])),
      }))
      .sort((a, b) => b.priority - a.priority || a.area - b.area);
    return { page, feature: candidates[0]?.feature || null, source: [sourceX, sourceY] };
  }

  clientToSource(page, clientX, clientY) {
    const [worldX, worldY] = this.screenToWorld(clientX, clientY);
    return [
      (worldX - page.worldX) / page.widthMm * page.sourceWidthMm,
      (worldY - page.worldY) / page.heightMm * page.sourceHeightMm,
    ];
  }

  ensurePickTexture() {
    if (
      this.pickTexture
      && this.pickTextureSize[0] === this.canvas.width
      && this.pickTextureSize[1] === this.canvas.height
    ) return;
    if (this.pickTexture) this.pickTexture.destroy();
    this.pickTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: "r32uint",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.pickTextureSize = [this.canvas.width, this.canvas.height];
  }

  writePickVectors(pages) {
    const buffer = new ArrayBuffer(MAX_PICK_VERTICES * 12);
    const view = new DataView(buffer);
    let count = 0;
    for (const page of pages) {
      const chunk = this.vectorChunks.get(page.id);
      if (!chunk?.segments?.length) continue;
      for (const segment of chunk.segments) {
        if (count + 2 > MAX_PICK_VERTICES) break;
        const a = this.sourceToWorld(page, segment.a);
        const b = this.sourceToWorld(page, segment.b);
        writePickVertex(view, count, a, segment.featureId);
        writePickVertex(view, count + 1, b, segment.featureId);
        count += 2;
      }
    }
    if (!count) return 0;
    this.device.queue.writeBuffer(this.pickVertexBuffer, 0, buffer, 0, count * 12);
    return count;
  }

  async gpuPickFeature(page, clientX, clientY) {
    if (this.pickPending) return null;
    const count = this.writePickVectors([page]);
    if (!count) return null;
    this.resize();
    this.writeGlobals();
    this.ensurePickTexture();
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(this.canvas.width - 1, Math.floor((clientX - rect.left) * this.canvas.width / rect.width)));
    const y = Math.max(0, Math.min(this.canvas.height - 1, Math.floor((clientY - rect.top) * this.canvas.height / rect.height)));
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.pickTexture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.pickPipeline);
    pass.setBindGroup(0, this.edgeBindGroup);
    pass.setVertexBuffer(0, this.pickVertexBuffer);
    pass.draw(count);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: this.pickTexture, origin: { x, y } },
      { buffer: this.pickReadBuffer, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    this.pickPending = true;
    this.device.queue.submit([encoder.finish()]);
    try {
      await this.pickReadBuffer.mapAsync(GPUMapMode.READ);
      const id = new Uint32Array(this.pickReadBuffer.getMappedRange().slice(0, 4))[0];
      this.pickReadBuffer.unmap();
      return id ? this.featuresById.get(id) || null : null;
    } finally {
      this.pickPending = false;
    }
  }

  hitResidentVectorFeature(page, sourceX, sourceY, tolerance) {
    if (!this.isNativeScene) return null;
    const chunk = this.vectorChunks.get(page.id);
    if (!chunk?.loaded) return null;
    let best = null;
    for (const segment of chunk.segments) {
      const distance = pointSegmentDistance([sourceX, sourceY], segment.a, segment.b);
      if (distance > tolerance) continue;
      const feature = this.featuresById.get(segment.featureId);
      if (!feature) continue;
      const score = distance + (isElectricalFeature(feature) ? 0 : 100);
      if (!best || score < best.score) best = { feature, score };
    }
    return best?.feature || null;
  }

  pan(dx, dy) {
    const ratio = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    this.center[0] -= dx * this.scale * ratio;
    this.center[1] -= dy * this.scale * ratio;
  }

  zoom(delta, clientX, clientY) {
    const before = this.screenToWorld(clientX, clientY);
    this.scale = clamp(this.scale * Math.exp(delta * 0.0015), 0.015, 16);
    const after = this.screenToWorld(clientX, clientY);
    this.center[0] += before[0] - after[0];
    this.center[1] += before[1] - after[1];
  }

  framePage(page) {
    if (!page) return;
    this.resize();
    this.center = [page.worldX + page.widthMm / 2, page.worldY + page.heightMm / 2];
    this.scale = Math.max(
      page.widthMm / Math.max(1, this.canvas.width * 0.88),
      page.heightMm / Math.max(1, this.canvas.height * 0.84),
    );
  }

  frameWorld() {
    this.resize();
    this.center = [
      (this.world.minX + this.world.maxX) / 2,
      (this.world.minY + this.world.maxY) / 2,
    ];
    this.scale = Math.max(
      (this.world.maxX - this.world.minX) / Math.max(1, this.canvas.width * 0.9),
      (this.world.maxY - this.world.minY) / Math.max(1, this.canvas.height * 0.88),
      0.05,
    );
  }
}

function thumbnailPath(page) {
  return page.thumbnail?.path || page.svg;
}

function normalizeFeatureTable(payload) {
  if (payload.schema === "prism.schematic_scene_a0.features") {
    const byId = new Map((payload.features || []).map((feature) => [Number(feature.id), feature]));
    const pages = {};
    for (const [pageId, ids] of Object.entries(payload.pages || {})) {
      pages[pageId] = ids.map((id) => byId.get(Number(id))).filter(Boolean);
    }
    return pages;
  }
  return payload.pages || {};
}

function primitiveSegments(primitives) {
  const segments = [];
  for (const primitive of primitives) {
    const featureId = Number(primitive.featureId || 0);
    if (!featureId) continue;
    const add = (a, b) => segments.push({ featureId, kind: primitive.kind, a, b });
    const x1 = primitive.x1Mm;
    const y1 = primitive.y1Mm;
    const x2 = primitive.x2Mm;
    const y2 = primitive.y2Mm;
    if (primitive.pointsMm?.length >= 2) {
      for (let index = 1; index < primitive.pointsMm.length; index += 1) {
        add(primitive.pointsMm[index - 1], primitive.pointsMm[index]);
      }
      if (shouldClosePolyline(primitive)) {
        add(primitive.pointsMm[primitive.pointsMm.length - 1], primitive.pointsMm[0]);
      }
    } else if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)) {
      if (primitive.kind === "rect") {
        add([x1, y1], [x2, y1]);
        add([x2, y1], [x2, y2]);
        add([x2, y2], [x1, y2]);
        add([x1, y2], [x1, y1]);
      } else {
        add([x1, y1], [x2, y2]);
      }
    } else if (Number.isFinite(primitive.cxMm) && Number.isFinite(primitive.cyMm)) {
      const radius = primitive.radiusMm || primitive.diameterMm / 2 || 0.4;
      appendCircle(segments, featureId, primitive.kind, [primitive.cxMm, primitive.cyMm], radius);
    } else if (
      Number.isFinite(primitive.start_xMm)
      && Number.isFinite(primitive.start_yMm)
      && Number.isFinite(primitive.mid_xMm)
      && Number.isFinite(primitive.mid_yMm)
      && Number.isFinite(primitive.end_xMm)
      && Number.isFinite(primitive.end_yMm)
    ) {
      add([primitive.start_xMm, primitive.start_yMm], [primitive.mid_xMm, primitive.mid_yMm]);
      add([primitive.mid_xMm, primitive.mid_yMm], [primitive.end_xMm, primitive.end_yMm]);
    } else if (primitive.boundsMm && primitive.kind !== "text") {
      const [left, top, right, bottom] = primitive.boundsMm;
      add([left, top], [right, top]);
      add([right, top], [right, bottom]);
      add([right, bottom], [left, bottom]);
      add([left, bottom], [left, top]);
    }
  }
  return segments;
}

function appendCircle(segments, featureId, kind, center, radius) {
  const steps = 32;
  for (let index = 0; index < steps; index += 1) {
    const a = index / steps * Math.PI * 2;
    const b = (index + 1) / steps * Math.PI * 2;
    segments.push({
      featureId,
      kind,
      a: [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius],
      b: [center[0] + Math.cos(b) * radius, center[1] + Math.sin(b) * radius],
    });
  }
}

function shouldClosePolyline(primitive) {
  return ["plotpoly", "polygon", "polyline", "fill"].includes(String(primitive.kind || ""));
}

function isElectricalFeature(feature) {
  return Boolean(feature?.netUid);
}

function vectorColor(feature, primitiveKind) {
  if (isElectricalFeature(feature)) return [0.12, 0.56, 0.2, 0.96];
  if (feature?.kind === "symbol_instance") return [0.42, 0.18, 0.18, 0.72];
  if (feature?.kind === "text" || primitiveKind === "text") return [0.05, 0.13, 0.16, 0.85];
  return [0.16, 0.17, 0.19, 0.7];
}

function pointSegmentDistance(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared, 0, 1);
  const x = a[0] + dx * t;
  const y = a[1] + dy * t;
  return Math.hypot(point[0] - x, point[1] - y);
}

function writePickVertex(view, index, point, featureId) {
  const offset = index * 12;
  view.setFloat32(offset, point[0], true);
  view.setFloat32(offset + 4, point[1], true);
  view.setUint32(offset + 8, featureId, true);
}
