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

export class SchematicWorldRenderer {
  static async create(canvas, manifestUrl) {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable in this browser");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice();
    const response = await fetch(manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load schematic manifest: ${response.status}`);
    const manifest = await response.json();
    if (manifest.schema !== "prism.schematic_world_a0") {
      throw new Error(`Unsupported schematic scene schema: ${manifest.schema}`);
    }
    const featureResponse = await fetch(new URL(manifest.features, manifestUrl), { cache: "no-store" });
    if (!featureResponse.ok) throw new Error(`Failed to load schematic features: ${featureResponse.status}`);
    const features = await featureResponse.json();
    return new SchematicWorldRenderer(canvas, device, manifestUrl, manifest, features.pages || {});
  }

  constructor(canvas, device, manifestUrl, manifest, featuresByPage) {
    this.canvas = canvas;
    this.device = device;
    this.manifestUrl = manifestUrl;
    this.manifest = manifest;
    this.pages = manifest.pages || [];
    this.featuresByPage = featuresByPage;
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

  async loadPageTexture(page, width) {
    const key = `${page.id}:${width}`;
    if (this.loading.has(key)) return this.loading.get(key);
    const resource = this.pageResources.get(page.id);
    if (!resource || resource.textureWidth >= width) return;
    const promise = (async () => {
      if (!resource.svgBlob) {
        const response = await fetch(new URL(page.svg, this.manifestUrl));
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

  hitFeature(clientX, clientY) {
    const page = this.hitPage(clientX, clientY);
    if (!page) return null;
    const [worldX, worldY] = this.screenToWorld(clientX, clientY);
    const sourceX = (worldX - page.worldX) / page.widthMm * page.sourceWidthMm;
    const sourceY = (worldY - page.worldY) / page.heightMm * page.sourceHeightMm;
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
