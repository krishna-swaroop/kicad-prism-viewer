// viewer/src/math.js
var clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
var mix = (a, b, t) => a + (b - a) * t;
function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a, value) {
  return [a[0] * value, a[1] * value, a[2] * value];
}
function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a) {
  const size = length(a) || 1;
  return scale(a, 1 / size);
}
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function mat4Multiply(a, b) {
  const output = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      output[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
    }
  }
  return output;
}
function lookAt(eye, target, up) {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1
  ]);
}
function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    far / (near - far),
    -1,
    0,
    0,
    near * far / (near - far),
    0
  ]);
}
function orthographic(width, height, near, far) {
  return new Float32Array([
    2 / width,
    0,
    0,
    0,
    0,
    2 / height,
    0,
    0,
    0,
    0,
    1 / (near - far),
    0,
    0,
    0,
    near / (near - far),
    1
  ]);
}
function boundsCenter(bounds) {
  return [
    (bounds[0] + bounds[3]) / 2,
    (bounds[1] + bounds[4]) / 2,
    (bounds[2] + bounds[5]) / 2
  ];
}
function boundsRadius(bounds) {
  return Math.max(
    1e-3,
    Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]) / 2
  );
}

// viewer/src/camera.js
var CameraController = class {
  constructor(bounds) {
    const center = boundsCenter(bounds);
    const radius = boundsRadius(bounds);
    this.focus = [...center];
    this.targetFocus = [...center];
    this.azimuth = -0.62;
    this.targetAzimuth = this.azimuth;
    this.polar = 0.72;
    this.targetPolar = this.polar;
    this.distance = radius * 2.8;
    this.targetDistance = this.distance;
    this.orthoScale = radius * 2.15;
    this.targetOrthoScale = this.orthoScale;
    this.sceneRadius = radius;
    this.fov = Math.PI / 4;
  }
  update(dt) {
    const amount = 1 - Math.exp(-dt * 14);
    this.focus = this.focus.map((value, index) => mix(value, this.targetFocus[index], amount));
    this.azimuth = mixAngle(this.azimuth, this.targetAzimuth, amount);
    this.polar = mix(this.polar, this.targetPolar, amount);
    this.distance = mix(this.distance, this.targetDistance, amount);
    this.orthoScale = mix(this.orthoScale, this.targetOrthoScale, amount);
  }
  basis() {
    const sine = Math.sin(this.polar);
    const cosine = Math.cos(this.polar);
    const back = normalize([
      sine * Math.sin(this.azimuth),
      -sine * Math.cos(this.azimuth),
      cosine
    ]);
    const right = normalize([Math.cos(this.azimuth), Math.sin(this.azimuth), 0]);
    const up = normalize(cross(back, right));
    return { right, up, back };
  }
  matrix(width, height, orthographicMode = false, scaleMultiplier = 1) {
    const aspect = Math.max(0.01, width / Math.max(1, height));
    const { up, back } = this.basis();
    const eye = add(this.focus, scale(back, this.distance));
    const view = lookAt(eye, this.focus, up);
    const projection = orthographicMode ? orthographic(
      this.orthoScale * scaleMultiplier * aspect,
      this.orthoScale * scaleMultiplier,
      -this.sceneRadius * 40,
      this.sceneRadius * 40
    ) : perspective(
      this.fov,
      aspect,
      Math.max(this.sceneRadius * 5e-4, this.distance - this.sceneRadius * 3.5),
      this.distance + this.sceneRadius * 4.5
    );
    return mat4Multiply(projection, view);
  }
  orbit(dx, dy) {
    this.targetAzimuth -= dx * 6e-3;
    this.targetPolar = clamp(this.targetPolar - dy * 6e-3, 0.015, Math.PI - 0.015);
  }
  pan(dx, dy, viewportHeight, orthographicMode = false) {
    const { right, up } = this.basis();
    const worldPerPixel = orthographicMode ? this.targetOrthoScale / Math.max(1, viewportHeight) : 2 * this.targetDistance * Math.tan(this.fov / 2) / Math.max(1, viewportHeight);
    const movement = add(scale(right, -dx * worldPerPixel), scale(up, dy * worldPerPixel));
    this.targetFocus = add(this.targetFocus, movement);
  }
  dolly(delta, orthographicMode = false) {
    const factor = Math.exp(delta * 32e-4);
    if (orthographicMode) {
      this.targetOrthoScale = clamp(
        this.targetOrthoScale * factor,
        this.sceneRadius * 8e-3,
        this.sceneRadius * 24
      );
    } else {
      this.targetDistance = clamp(
        this.targetDistance * factor,
        this.sceneRadius * 0.01,
        this.sceneRadius * 48
      );
    }
  }
  frame(bounds) {
    if (!bounds) return;
    const radius = boundsRadius(bounds);
    this.targetFocus = boundsCenter(bounds);
    this.targetDistance = Math.max(radius * 2.8, this.sceneRadius * 0.02);
    this.targetOrthoScale = Math.max(radius * 2.15, this.sceneRadius * 0.02);
  }
  setFocus(point) {
    this.targetFocus = [...point];
  }
  setAxis(axis, opposite = false) {
    if (axis === "z") {
      this.targetAzimuth = 0;
      this.targetPolar = opposite ? Math.PI - 0.015 : 0.015;
    } else if (axis === "x") {
      this.targetAzimuth = opposite ? -Math.PI / 2 : Math.PI / 2;
      this.targetPolar = Math.PI / 2;
    } else {
      this.targetAzimuth = opposite ? 0 : Math.PI;
      this.targetPolar = Math.PI / 2;
    }
  }
  rotateZ(direction = 1) {
    this.targetAzimuth += direction * Math.PI / 2;
  }
  flip() {
    this.targetPolar = Math.PI - this.targetPolar;
  }
};
function mixAngle(current, target, amount) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * amount;
}

// node_modules/property-graph/dist/index.mjs
var EventDispatcher = class {
  _listeners = {};
  addEventListener(type, listener) {
    const listeners = this._listeners;
    if (listeners[type] === void 0) listeners[type] = [];
    if (listeners[type].indexOf(listener) === -1) listeners[type].push(listener);
    return this;
  }
  removeEventListener(type, listener) {
    const listenerArray = this._listeners[type];
    if (listenerArray !== void 0) {
      const index = listenerArray.indexOf(listener);
      if (index !== -1) listenerArray.splice(index, 1);
    }
    return this;
  }
  dispatchEvent(event) {
    const listenerArray = this._listeners[event.type];
    if (listenerArray !== void 0) {
      const array = listenerArray.slice(0);
      for (let i = 0, l = array.length; i < l; i++) array[i].call(this, event);
    }
    return this;
  }
  dispose() {
    for (const key in this._listeners) delete this._listeners[key];
  }
};
var GraphEdge = class {
  _disposed = false;
  _name;
  _parent;
  _child;
  _attributes;
  constructor(_name, _parent, _child, _attributes = {}) {
    this._name = _name;
    this._parent = _parent;
    this._child = _child;
    this._attributes = _attributes;
    if (!_parent.isOnGraph(_child)) throw new Error("Cannot connect disconnected graphs.");
  }
  /** Name (attribute name from parent {@link GraphNode}). */
  getName() {
    return this._name;
  }
  /** Owner node. */
  getParent() {
    return this._parent;
  }
  /** Resource node. */
  getChild() {
    return this._child;
  }
  /**
  * Sets the child node.
  *
  * @internal Only {@link Graph} implementations may safely call this method directly. Use
  * 	{@link Property.swap} or {@link Graph.swapChild} instead.
  */
  setChild(child) {
    this._child = child;
    return this;
  }
  /** Attributes of the graph node relationship. */
  getAttributes() {
    return this._attributes;
  }
  /** Destroys a (currently intact) edge, updating both the graph and the owner. */
  dispose() {
    if (this._disposed) return;
    this._parent._destroyRef(this);
    this._disposed = true;
  }
  /** Whether this link has been destroyed. */
  isDisposed() {
    return this._disposed;
  }
};
var Graph = class extends EventDispatcher {
  _emptySet = /* @__PURE__ */ new Set();
  _edges = /* @__PURE__ */ new Set();
  _parentEdges = /* @__PURE__ */ new Map();
  _childEdges = /* @__PURE__ */ new Map();
  /** Returns a list of all parent->child edges on this graph. */
  listEdges() {
    return Array.from(this._edges);
  }
  /** Returns a list of all edges on the graph having the given node as their child. */
  listParentEdges(node) {
    return Array.from(this._childEdges.get(node) || this._emptySet);
  }
  /** Returns a list of parent nodes for the given child node. */
  listParents(node) {
    const parentSet = /* @__PURE__ */ new Set();
    for (const edge of this.listParentEdges(node)) parentSet.add(edge.getParent());
    return Array.from(parentSet);
  }
  /** Returns a list of all edges on the graph having the given node as their parent. */
  listChildEdges(node) {
    return Array.from(this._parentEdges.get(node) || this._emptySet);
  }
  /** Returns a list of child nodes for the given parent node. */
  listChildren(node) {
    const childSet = /* @__PURE__ */ new Set();
    for (const edge of this.listChildEdges(node)) childSet.add(edge.getChild());
    return Array.from(childSet);
  }
  disconnectParents(node, filter) {
    for (const edge of this.listParentEdges(node)) if (!filter || filter(edge.getParent())) edge.dispose();
    return this;
  }
  /**********************************************************************************************
  * Internal.
  */
  /**
  * Creates a {@link GraphEdge} connecting two {@link GraphNode} instances. Edge is returned
  * for the caller to store.
  * @param a Owner
  * @param b Resource
  * @hidden
  * @internal
  */
  _createEdge(name, a, b, attributes) {
    const edge = new GraphEdge(name, a, b, attributes);
    this._edges.add(edge);
    const parent = edge.getParent();
    if (!this._parentEdges.has(parent)) this._parentEdges.set(parent, /* @__PURE__ */ new Set());
    this._parentEdges.get(parent).add(edge);
    const child = edge.getChild();
    if (!this._childEdges.has(child)) this._childEdges.set(child, /* @__PURE__ */ new Set());
    this._childEdges.get(child).add(edge);
    return edge;
  }
  /**
  * Detaches a {@link GraphEdge} from the {@link Graph}. Before calling this
  * method, ensure that the GraphEdge has first been detached from any
  * associated {@link GraphNode} attributes.
  * @hidden
  * @internal
  */
  _destroyEdge(edge) {
    this._edges.delete(edge);
    this._parentEdges.get(edge.getParent()).delete(edge);
    this._childEdges.get(edge.getChild()).delete(edge);
    return this;
  }
};
var RefList = class {
  list = [];
  constructor(refs) {
    if (refs) for (const ref of refs) this.list.push(ref);
  }
  add(ref) {
    this.list.push(ref);
  }
  remove(ref) {
    const index = this.list.indexOf(ref);
    if (index >= 0) this.list.splice(index, 1);
  }
  removeChild(child) {
    const refs = [];
    for (const ref of this.list) if (ref.getChild() === child) refs.push(ref);
    for (const ref of refs) this.remove(ref);
    return refs;
  }
  listRefsByChild(child) {
    const refs = [];
    for (const ref of this.list) if (ref.getChild() === child) refs.push(ref);
    return refs;
  }
  values() {
    return this.list;
  }
};
var RefSet = class {
  set = /* @__PURE__ */ new Set();
  map = /* @__PURE__ */ new Map();
  constructor(refs) {
    if (refs) for (const ref of refs) this.add(ref);
  }
  add(ref) {
    const child = ref.getChild();
    this.removeChild(child);
    this.set.add(ref);
    this.map.set(child, ref);
  }
  remove(ref) {
    this.set.delete(ref);
    this.map.delete(ref.getChild());
  }
  removeChild(child) {
    const ref = this.map.get(child) || null;
    if (ref) this.remove(ref);
    return ref;
  }
  getRefByChild(child) {
    return this.map.get(child) || null;
  }
  values() {
    return Array.from(this.set);
  }
};
var RefMap = class {
  map = {};
  constructor(map) {
    if (map) Object.assign(this.map, map);
  }
  set(key, child) {
    this.map[key] = child;
  }
  delete(key) {
    delete this.map[key];
  }
  get(key) {
    return this.map[key] || null;
  }
  keys() {
    return Object.keys(this.map);
  }
  values() {
    return Object.values(this.map);
  }
};
var $attributes = Symbol("attributes");
var $immutableKeys = Symbol("immutableKeys");
var GraphNode = class GraphNode2 extends EventDispatcher {
  _disposed = false;
  /**
  * Internal graph used to search and maintain references.
  * @hidden
  */
  graph;
  /**
  * Attributes (literal values and GraphNode references) associated with this instance. For each
  * GraphNode reference, the attributes stores a {@link GraphEdge}. List and Map references are
  * stored as arrays and dictionaries of edges.
  * @internal
  */
  [$attributes];
  /**
  * Attributes included with `getDefaultAttributes` are considered immutable, and cannot be
  * modifed by `.setRef()`, `.copy()`, or other GraphNode methods. Both the edges and the
  * properties will be disposed with the parent GraphNode.
  *
  * Currently, only single-edge references (getRef/setRef) are supported as immutables.
  *
  * @internal
  */
  [$immutableKeys];
  constructor(graph) {
    super();
    this.graph = graph;
    this[$immutableKeys] = /* @__PURE__ */ new Set();
    this[$attributes] = this._createAttributes();
  }
  /**
  * Returns default attributes for the graph node. Subclasses having any attributes (either
  * literal values or references to other graph nodes) must override this method. Literal
  * attributes should be given their default values, if any. References should generally be
  * initialized as empty (Ref → null, RefList → [], RefMap → {}) and then modified by setters.
  *
  * Any single-edge references (setRef) returned by this method will be considered immutable,
  * to be owned by and disposed with the parent node. Multi-edge references (addRef, removeRef,
  * setRefMap) cannot be returned as default attributes.
  */
  getDefaults() {
    return {};
  }
  /**
  * Constructs and returns an object used to store a graph nodes attributes. Compared to the
  * default Attributes interface, this has two distinctions:
  *
  * 1. Slots for GraphNode<T> objects are replaced with slots for GraphEdge<this, GraphNode<T>>
  * 2. GraphNode<T> objects provided as defaults are considered immutable
  *
  * @internal
  */
  _createAttributes() {
    const defaultAttributes = this.getDefaults();
    const attributes = {};
    for (const key in defaultAttributes) {
      const value = defaultAttributes[key];
      if (value instanceof GraphNode2) {
        const ref = this.graph._createEdge(key, this, value);
        this[$immutableKeys].add(key);
        attributes[key] = ref;
      } else attributes[key] = value;
    }
    return attributes;
  }
  /** @internal Returns true if two nodes are on the same {@link Graph}. */
  isOnGraph(other) {
    return this.graph === other.graph;
  }
  /** Returns true if the node has been permanently removed from the graph. */
  isDisposed() {
    return this._disposed;
  }
  /**
  * Removes both inbound references to and outbound references from this object. At the end
  * of the process the object holds no references, and nothing holds references to it. A
  * disposed object is not reusable.
  */
  dispose() {
    if (this._disposed) return;
    this.graph.listChildEdges(this).forEach((edge) => edge.dispose());
    this.graph.disconnectParents(this);
    this._disposed = true;
    this.dispatchEvent({ type: "dispose" });
  }
  /**
  * Removes all inbound references to this object. At the end of the process the object is
  * considered 'detached': it may hold references to child resources, but nothing holds
  * references to it. A detached object may be re-attached.
  */
  detach() {
    this.graph.disconnectParents(this);
    return this;
  }
  /**
  * Transfers this object's references from the old node to the new one. The old node is fully
  * detached from this parent at the end of the process.
  *
  * @hidden
  */
  swap(prevValue, nextValue) {
    for (const attribute in this[$attributes]) {
      const value = this[$attributes][attribute];
      if (value instanceof GraphEdge) {
        const ref = value;
        if (ref.getChild() === prevValue) this.setRef(attribute, nextValue, ref.getAttributes());
      } else if (value instanceof RefList) for (const ref of value.listRefsByChild(prevValue)) {
        const refAttributes = ref.getAttributes();
        this.removeRef(attribute, prevValue);
        this.addRef(attribute, nextValue, refAttributes);
      }
      else if (value instanceof RefSet) {
        const ref = value.getRefByChild(prevValue);
        if (ref) {
          const refAttributes = ref.getAttributes();
          this.removeRef(attribute, prevValue);
          this.addRef(attribute, nextValue, refAttributes);
        }
      } else if (value instanceof RefMap) for (const key of value.keys()) {
        const ref = value.get(key);
        if (ref.getChild() === prevValue) this.setRefMap(attribute, key, nextValue, ref.getAttributes());
      }
    }
    return this;
  }
  /**********************************************************************************************
  * Literal attributes.
  */
  /** @hidden */
  get(attribute) {
    return this[$attributes][attribute];
  }
  /** @hidden */
  set(attribute, value) {
    this[$attributes][attribute] = value;
    return this.dispatchEvent({
      type: "change",
      attribute
    });
  }
  /**********************************************************************************************
  * Ref: 1:1 graph node references.
  */
  /** @hidden */
  getRef(attribute) {
    const ref = this[$attributes][attribute];
    return ref ? ref.getChild() : null;
  }
  /** @hidden */
  setRef(attribute, value, attributes) {
    if (this[$immutableKeys].has(attribute)) throw new Error(`Cannot overwrite immutable attribute, "${attribute}".`);
    const prevRef = this[$attributes][attribute];
    if (prevRef) prevRef.dispose();
    if (!value) return this;
    const ref = this.graph._createEdge(attribute, this, value, attributes);
    this[$attributes][attribute] = ref;
    return this.dispatchEvent({
      type: "change",
      attribute
    });
  }
  /**********************************************************************************************
  * RefList: 1:many graph node references.
  */
  /** @hidden */
  listRefs(attribute) {
    return this.assertRefList(attribute).values().map((ref) => ref.getChild());
  }
  /** @hidden */
  addRef(attribute, value, attributes) {
    const ref = this.graph._createEdge(attribute, this, value, attributes);
    this.assertRefList(attribute).add(ref);
    return this.dispatchEvent({
      type: "change",
      attribute
    });
  }
  /** @hidden */
  removeRef(attribute, value) {
    const refs = this.assertRefList(attribute);
    if (refs instanceof RefList) for (const ref of refs.listRefsByChild(value)) ref.dispose();
    else {
      const ref = refs.getRefByChild(value);
      if (ref) ref.dispose();
    }
    return this;
  }
  /** @hidden */
  assertRefList(attribute) {
    const refs = this[$attributes][attribute];
    if (refs instanceof RefList || refs instanceof RefSet) return refs;
    throw new Error(`Expected RefList or RefSet for attribute "${attribute}"`);
  }
  /**********************************************************************************************
  * RefMap: Named 1:many (map) graph node references.
  */
  /** @hidden */
  listRefMapKeys(attribute) {
    return this.assertRefMap(attribute).keys();
  }
  /** @hidden */
  listRefMapValues(attribute) {
    return this.assertRefMap(attribute).values().map((ref) => ref.getChild());
  }
  /** @hidden */
  getRefMap(attribute, key) {
    const ref = this.assertRefMap(attribute).get(key);
    return ref ? ref.getChild() : null;
  }
  /** @hidden */
  setRefMap(attribute, key, value, metadata) {
    const refMap = this.assertRefMap(attribute);
    const prevRef = refMap.get(key);
    if (prevRef) prevRef.dispose();
    if (!value) return this;
    metadata = Object.assign(metadata || {}, { key });
    const ref = this.graph._createEdge(attribute, this, value, {
      ...metadata,
      key
    });
    refMap.set(key, ref);
    return this.dispatchEvent({
      type: "change",
      attribute,
      key
    });
  }
  /** @hidden */
  assertRefMap(attribute) {
    const map = this[$attributes][attribute];
    if (map instanceof RefMap) return map;
    throw new Error(`Expected RefMap for attribute "${attribute}"`);
  }
  /**********************************************************************************************
  * Events.
  */
  /**
  * Dispatches an event on the GraphNode, and on the associated
  * Graph. Event types on the graph are prefixed, `"node:[type]"`.
  */
  dispatchEvent(event) {
    super.dispatchEvent({
      ...event,
      target: this
    });
    this.graph.dispatchEvent({
      ...event,
      target: this,
      type: `node:${event.type}`
    });
    return this;
  }
  /**********************************************************************************************
  * Internal.
  */
  /** @hidden */
  _destroyRef(ref) {
    const attribute = ref.getName();
    if (this[$attributes][attribute] === ref) {
      this[$attributes][attribute] = null;
      if (this[$immutableKeys].has(attribute)) ref.getChild().dispose();
    } else if (this[$attributes][attribute] instanceof RefList) this[$attributes][attribute].remove(ref);
    else if (this[$attributes][attribute] instanceof RefSet) this[$attributes][attribute].remove(ref);
    else if (this[$attributes][attribute] instanceof RefMap) {
      const refMap = this[$attributes][attribute];
      for (const key of refMap.keys()) if (refMap.get(key) === ref) refMap.delete(key);
    } else return;
    this.graph._destroyEdge(ref);
    this.dispatchEvent({
      type: "change",
      attribute
    });
  }
};

// node_modules/@gltf-transform/core/dist/index.js
var VERSION = `v4.4.0`;
var GLB_BUFFER = "@glb.bin";
var PropertyType = /* @__PURE__ */ (function(PropertyType2) {
  PropertyType2["ACCESSOR"] = "Accessor";
  PropertyType2["ANIMATION"] = "Animation";
  PropertyType2["ANIMATION_CHANNEL"] = "AnimationChannel";
  PropertyType2["ANIMATION_SAMPLER"] = "AnimationSampler";
  PropertyType2["BUFFER"] = "Buffer";
  PropertyType2["CAMERA"] = "Camera";
  PropertyType2["MATERIAL"] = "Material";
  PropertyType2["MESH"] = "Mesh";
  PropertyType2["PRIMITIVE"] = "Primitive";
  PropertyType2["PRIMITIVE_TARGET"] = "PrimitiveTarget";
  PropertyType2["NODE"] = "Node";
  PropertyType2["ROOT"] = "Root";
  PropertyType2["SCENE"] = "Scene";
  PropertyType2["SKIN"] = "Skin";
  PropertyType2["TEXTURE"] = "Texture";
  PropertyType2["TEXTURE_INFO"] = "TextureInfo";
  return PropertyType2;
})({});
var VertexLayout = /* @__PURE__ */ (function(VertexLayout2) {
  VertexLayout2["INTERLEAVED"] = "interleaved";
  VertexLayout2["SEPARATE"] = "separate";
  return VertexLayout2;
})({});
var BufferViewUsage$1 = /* @__PURE__ */ (function(BufferViewUsage2) {
  BufferViewUsage2["ARRAY_BUFFER"] = "ARRAY_BUFFER";
  BufferViewUsage2["ELEMENT_ARRAY_BUFFER"] = "ELEMENT_ARRAY_BUFFER";
  BufferViewUsage2["INVERSE_BIND_MATRICES"] = "INVERSE_BIND_MATRICES";
  BufferViewUsage2["OTHER"] = "OTHER";
  BufferViewUsage2["SPARSE"] = "SPARSE";
  return BufferViewUsage2;
})({});
var TextureChannel = /* @__PURE__ */ (function(TextureChannel2) {
  TextureChannel2[TextureChannel2["R"] = 4096] = "R";
  TextureChannel2[TextureChannel2["G"] = 256] = "G";
  TextureChannel2[TextureChannel2["B"] = 16] = "B";
  TextureChannel2[TextureChannel2["A"] = 1] = "A";
  return TextureChannel2;
})({});
var Format = /* @__PURE__ */ (function(Format2) {
  Format2["GLTF"] = "GLTF";
  Format2["GLB"] = "GLB";
  return Format2;
})({});
var UnsupportedArray = class extends Float32Array {
  constructor() {
    super();
    throw new Error("Unsupported typed array instantiation.");
  }
};
var ComponentTypeToTypedArray = {
  "5120": Int8Array,
  "5121": Uint8Array,
  "5122": Int16Array,
  "5123": Uint16Array,
  "5125": Uint32Array,
  "5131": typeof Float16Array !== "undefined" ? Float16Array : UnsupportedArray,
  "5126": Float32Array,
  "5130": Float64Array
};
var BufferUtils = class {
  /** Creates a byte array from a Data URI. */
  static createBufferFromDataURI(dataURI) {
    if (typeof Buffer === "undefined") {
      const byteString = atob(dataURI.split(",")[1]);
      const ia = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
      return ia;
    } else {
      const data = dataURI.split(",")[1];
      const isBase64 = dataURI.indexOf("base64") >= 0;
      return Buffer.from(data, isBase64 ? "base64" : "utf8");
    }
  }
  /** Encodes text to a byte array. */
  static encodeText(text) {
    return new TextEncoder().encode(text);
  }
  /** Decodes a byte array to text. */
  static decodeText(array) {
    return new TextDecoder().decode(array);
  }
  /**
  * Concatenates N byte arrays.
  */
  static concat(arrays) {
    let totalByteLength = 0;
    for (const array of arrays) totalByteLength += array.byteLength;
    const result = new Uint8Array(totalByteLength);
    let byteOffset = 0;
    for (const array of arrays) {
      result.set(array, byteOffset);
      byteOffset += array.byteLength;
    }
    return result;
  }
  /**
  * Pads a Uint8Array to the next 4-byte boundary.
  *
  * Reference: [glTF → Data Alignment](https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#data-alignment)
  */
  static pad(srcArray, paddingByte = 0) {
    const paddedLength = this.padNumber(srcArray.byteLength);
    if (paddedLength === srcArray.byteLength) return srcArray;
    const dstArray = new Uint8Array(paddedLength);
    dstArray.set(srcArray);
    if (paddingByte !== 0) for (let i = srcArray.byteLength; i < paddedLength; i++) dstArray[i] = paddingByte;
    return dstArray;
  }
  /** Pads a number to 4-byte boundaries. */
  static padNumber(v) {
    return Math.ceil(v / 4) * 4;
  }
  /** Returns true if given byte array instances are equal. */
  static equals(a, b) {
    if (a === b) return true;
    if (a.byteLength !== b.byteLength) return false;
    let i = a.byteLength;
    while (i--) if (a[i] !== b[i]) return false;
    return true;
  }
  /**
  * Returns a Uint8Array view of a typed array, with the same underlying ArrayBuffer.
  *
  * A shorthand for:
  *
  * ```js
  * const buffer = new Uint8Array(
  * 	array.buffer,
  * 	array.byteOffset + byteOffset,
  * 	Math.min(array.byteLength, byteLength)
  * );
  * ```
  *
  */
  static toView(a, byteOffset = 0, byteLength = Infinity) {
    return new Uint8Array(a.buffer, a.byteOffset + byteOffset, Math.min(a.byteLength, byteLength));
  }
  static assertView(view) {
    if (view && !ArrayBuffer.isView(view)) throw new Error(`Method requires Uint8Array parameter; received "${typeof view}".`);
    return view;
  }
};
var JPEGImageUtils = class {
  match(array) {
    return array.length >= 3 && array[0] === 255 && array[1] === 216 && array[2] === 255;
  }
  getSize(array) {
    let view = new DataView(array.buffer, array.byteOffset + 4);
    let i, next;
    while (view.byteLength) {
      i = view.getUint16(0, false);
      validateJPEGBuffer(view, i);
      next = view.getUint8(i + 1);
      if (next === 192 || next === 193 || next === 194) return [view.getUint16(i + 7, false), view.getUint16(i + 5, false)];
      view = new DataView(array.buffer, view.byteOffset + i + 2);
    }
    throw new TypeError("Invalid JPG, no size found");
  }
  getChannels(_buffer) {
    return 3;
  }
};
var PNGImageUtils = class PNGImageUtils2 {
  static PNG_FRIED_CHUNK_NAME = "CgBI";
  match(array) {
    return array.length >= 8 && array[0] === 137 && array[1] === 80 && array[2] === 78 && array[3] === 71 && array[4] === 13 && array[5] === 10 && array[6] === 26 && array[7] === 10;
  }
  getSize(array) {
    const view = new DataView(array.buffer, array.byteOffset);
    if (BufferUtils.decodeText(array.slice(12, 16)) === PNGImageUtils2.PNG_FRIED_CHUNK_NAME) return [view.getUint32(32, false), view.getUint32(36, false)];
    return [view.getUint32(16, false), view.getUint32(20, false)];
  }
  getChannels(_buffer) {
    return 4;
  }
};
var ImageUtils = class {
  static impls = {
    "image/jpeg": new JPEGImageUtils(),
    "image/png": new PNGImageUtils()
  };
  /** Registers support for a new image format; useful for certain extensions. */
  static registerFormat(mimeType, impl) {
    this.impls[mimeType] = impl;
  }
  /**
  * Returns detected MIME type of the given image buffer. Note that for image
  * formats with support provided by extensions, the extension must be
  * registered with an I/O class before it can be detected by ImageUtils.
  */
  static getMimeType(buffer) {
    for (const mimeType in this.impls) if (this.impls[mimeType].match(buffer)) return mimeType;
    return null;
  }
  /** Returns the dimensions of the image. */
  static getSize(buffer, mimeType) {
    if (!this.impls[mimeType]) return null;
    return this.impls[mimeType].getSize(buffer);
  }
  /**
  * Returns a conservative estimate of the number of channels in the image. For some image
  * formats, the method may return 4 indicating the possibility of an alpha channel, without
  * the ability to guarantee that an alpha channel is present.
  */
  static getChannels(buffer, mimeType) {
    if (!this.impls[mimeType]) return null;
    return this.impls[mimeType].getChannels(buffer);
  }
  /** Returns a conservative estimate of the GPU memory required by this image. */
  static getVRAMByteLength(buffer, mimeType) {
    if (!this.impls[mimeType]) return null;
    if (this.impls[mimeType].getVRAMByteLength) return this.impls[mimeType].getVRAMByteLength(buffer);
    let uncompressedBytes = 0;
    const channels = 4;
    const resolution = this.getSize(buffer, mimeType);
    if (!resolution) return null;
    while (resolution[0] > 1 || resolution[1] > 1) {
      uncompressedBytes += resolution[0] * resolution[1] * channels;
      resolution[0] = Math.max(Math.floor(resolution[0] / 2), 1);
      resolution[1] = Math.max(Math.floor(resolution[1] / 2), 1);
    }
    uncompressedBytes += 1 * channels;
    return uncompressedBytes;
  }
  /** Returns the preferred file extension for the given MIME type. */
  static mimeTypeToExtension(mimeType) {
    if (mimeType === "image/jpeg") return "jpg";
    return mimeType.split("/").pop();
  }
  /** Returns the MIME type for the given file extension. */
  static extensionToMimeType(extension) {
    if (extension === "jpg") return "image/jpeg";
    if (!extension) return "";
    return `image/${extension}`;
  }
};
function validateJPEGBuffer(view, i) {
  if (i > view.byteLength) throw new TypeError("Corrupt JPG, exceeded buffer limits");
  if (view.getUint8(i) !== 255) throw new TypeError("Invalid JPG, marker table corrupted");
  return view;
}
var FileUtils = class {
  /**
  * Extracts the basename from a file path, e.g. "folder/model.glb" -> "model".
  * See: {@link HTTPUtils.basename}
  */
  static basename(uri) {
    const fileName = uri.split(/[\\/]/).pop();
    return fileName.substring(0, fileName.lastIndexOf("."));
  }
  /**
  * Extracts the extension from a file path, e.g. "folder/model.glb" -> "glb".
  * See: {@link HTTPUtils.extension}
  */
  static extension(uri) {
    if (uri.startsWith("data:image/")) {
      const mimeType = uri.match(/data:(image\/\w+)/)[1];
      return ImageUtils.mimeTypeToExtension(mimeType);
    } else if (uri.startsWith("data:model/gltf+json")) return "gltf";
    else if (uri.startsWith("data:model/gltf-binary")) return "glb";
    else if (uri.startsWith("data:application/")) return "bin";
    return uri.split(/[\\/]/).pop().split(/[.]/).pop();
  }
};
var ARRAY_TYPE = typeof Float32Array !== "undefined" ? Float32Array : Array;
Math.PI / 180;
180 / Math.PI;
function create() {
  var out = new ARRAY_TYPE(3);
  if (ARRAY_TYPE != Float32Array) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
  }
  return out;
}
function length2(a) {
  var x = a[0];
  var y = a[1];
  var z = a[2];
  return Math.sqrt(x * x + y * y + z * z);
}
function transformMat4(out, a, m) {
  var x = a[0], y = a[1], z = a[2];
  var w = m[3] * x + m[7] * y + m[11] * z + m[15];
  w = w || 1;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}
(function() {
  var vec = create();
  return function(a, stride, offset, count, fn, arg) {
    var i, l;
    if (!stride) stride = 3;
    if (!offset) offset = 0;
    if (count) l = Math.min(count * stride + offset, a.length);
    else l = a.length;
    for (i = offset; i < l; i += stride) {
      vec[0] = a[i];
      vec[1] = a[i + 1];
      vec[2] = a[i + 2];
      fn(vec, vec, arg);
      a[i] = vec[0];
      a[i + 1] = vec[1];
      a[i + 2] = vec[2];
    }
    return a;
  };
})();
function getBounds(node) {
  const resultBounds = createBounds();
  const parents = node.propertyType === PropertyType.NODE ? [node] : node.listChildren();
  for (const parent of parents) parent.traverse((node2) => {
    const mesh = node2.getMesh();
    if (!mesh) return;
    const meshBounds = getMeshBounds(mesh, node2.getWorldMatrix());
    if (meshBounds.min.every(isFinite) && meshBounds.max.every(isFinite)) {
      expandBounds(meshBounds.min, resultBounds);
      expandBounds(meshBounds.max, resultBounds);
    }
  });
  return resultBounds;
}
function getMeshBounds(mesh, worldMatrix) {
  const meshBounds = createBounds();
  for (const prim of mesh.listPrimitives()) {
    const position = prim.getAttribute("POSITION");
    const indices = prim.getIndices();
    if (!position) continue;
    let localPos = [
      0,
      0,
      0
    ];
    let worldPos = [
      0,
      0,
      0
    ];
    for (let i = 0, il = indices ? indices.getCount() : position.getCount(); i < il; i++) {
      const index = indices ? indices.getScalar(i) : i;
      localPos = position.getElement(index, localPos);
      worldPos = transformMat4(worldPos, localPos, worldMatrix);
      expandBounds(worldPos, meshBounds);
    }
  }
  return meshBounds;
}
function expandBounds(point, target) {
  for (let i = 0; i < 3; i++) {
    target.min[i] = Math.min(point[i], target.min[i]);
    target.max[i] = Math.max(point[i], target.max[i]);
  }
}
function createBounds() {
  return {
    min: [
      Infinity,
      Infinity,
      Infinity
    ],
    max: [
      -Infinity,
      -Infinity,
      -Infinity
    ]
  };
}
var NULL_DOMAIN = "https://null.example";
var HTTPUtils = class {
  static DEFAULT_INIT = {};
  static PROTOCOL_REGEXP = /^[a-zA-Z]+:\/\//;
  static dirname(path) {
    const index = path.lastIndexOf("/");
    if (index === -1) return "./";
    return path.substring(0, index + 1);
  }
  /**
  * Extracts the basename from a URL, e.g. "folder/model.glb" -> "model".
  * See: {@link FileUtils.basename}
  */
  static basename(uri) {
    return FileUtils.basename(new URL(uri, NULL_DOMAIN).pathname);
  }
  /**
  * Extracts the extension from a URL, e.g. "folder/model.glb" -> "glb".
  * See: {@link FileUtils.extension}
  */
  static extension(uri) {
    return FileUtils.extension(new URL(uri, NULL_DOMAIN).pathname);
  }
  static resolve(base, path) {
    if (!this.isRelativePath(path)) return path;
    const stack = base.split("/");
    const parts = path.split("/");
    stack.pop();
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === ".") continue;
      if (parts[i] === "..") stack.pop();
      else stack.push(parts[i]);
    }
    return stack.join("/");
  }
  /**
  * Returns true for URLs containing a protocol, and false for both
  * absolute and relative paths.
  */
  static isAbsoluteURL(path) {
    return this.PROTOCOL_REGEXP.test(path);
  }
  /**
  * Returns true for paths that are declared relative to some unknown base
  * path. For example, "foo/bar/" is relative both "/foo/bar/" is not.
  */
  static isRelativePath(path) {
    return !/^(?:[a-zA-Z]+:)?\//.test(path);
  }
};
function isObject(o) {
  return Object.prototype.toString.call(o) === "[object Object]";
}
function isPlainObject(o) {
  if (isObject(o) === false) return false;
  const ctor = o.constructor;
  if (ctor === void 0) return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false) return false;
  if (Object.hasOwn(prot, "isPrototypeOf") === false) return false;
  return true;
}
var Verbosity = /* @__PURE__ */ (function(Verbosity2) {
  Verbosity2[Verbosity2["SILENT"] = 4] = "SILENT";
  Verbosity2[Verbosity2["ERROR"] = 3] = "ERROR";
  Verbosity2[Verbosity2["WARN"] = 2] = "WARN";
  Verbosity2[Verbosity2["INFO"] = 1] = "INFO";
  Verbosity2[Verbosity2["DEBUG"] = 0] = "DEBUG";
  return Verbosity2;
})({});
var Logger = class Logger2 {
  /** Logger verbosity thresholds. */
  static Verbosity = Verbosity;
  /** Default logger instance. */
  static DEFAULT_INSTANCE = new Logger2(Logger2.Verbosity.INFO);
  /** Constructs a new Logger instance. */
  constructor(verbosity) {
    this.verbosity = verbosity;
  }
  /** Logs an event at level {@link Logger.Verbosity.DEBUG}. */
  debug(text) {
    if (this.verbosity <= Logger2.Verbosity.DEBUG) console.debug(text);
  }
  /** Logs an event at level {@link Logger.Verbosity.INFO}. */
  info(text) {
    if (this.verbosity <= Logger2.Verbosity.INFO) console.info(text);
  }
  /** Logs an event at level {@link Logger.Verbosity.WARN}. */
  warn(text) {
    if (this.verbosity <= Logger2.Verbosity.WARN) console.warn(text);
  }
  /** Logs an event at level {@link Logger.Verbosity.ERROR}. */
  error(text) {
    if (this.verbosity <= Logger2.Verbosity.ERROR) console.error(text);
  }
};
function determinant(a) {
  var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  var b0 = a00 * a11 - a01 * a10;
  var b1 = a00 * a12 - a02 * a10;
  var b2 = a01 * a12 - a02 * a11;
  var b3 = a20 * a31 - a21 * a30;
  var b4 = a20 * a32 - a22 * a30;
  var b5 = a21 * a32 - a22 * a31;
  var b6 = a00 * b5 - a01 * b4 + a02 * b3;
  var b7 = a10 * b5 - a11 * b4 + a12 * b3;
  var b8 = a20 * b2 - a21 * b1 + a22 * b0;
  var b9 = a30 * b2 - a31 * b1 + a32 * b0;
  return a13 * b6 - a03 * b7 + a33 * b8 - a23 * b9;
}
function multiply(out, a, b) {
  var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[4];
  b1 = b[5];
  b2 = b[6];
  b3 = b[7];
  out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[8];
  b1 = b[9];
  b2 = b[10];
  b3 = b[11];
  out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[12];
  b1 = b[13];
  b2 = b[14];
  b3 = b[15];
  out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  return out;
}
function getScaling(out, mat) {
  var m11 = mat[0];
  var m12 = mat[1];
  var m13 = mat[2];
  var m21 = mat[4];
  var m22 = mat[5];
  var m23 = mat[6];
  var m31 = mat[8];
  var m32 = mat[9];
  var m33 = mat[10];
  out[0] = Math.sqrt(m11 * m11 + m12 * m12 + m13 * m13);
  out[1] = Math.sqrt(m21 * m21 + m22 * m22 + m23 * m23);
  out[2] = Math.sqrt(m31 * m31 + m32 * m32 + m33 * m33);
  return out;
}
function getRotation(out, mat) {
  var scaling = new ARRAY_TYPE(3);
  getScaling(scaling, mat);
  var is1 = 1 / scaling[0];
  var is2 = 1 / scaling[1];
  var is3 = 1 / scaling[2];
  var sm11 = mat[0] * is1;
  var sm12 = mat[1] * is2;
  var sm13 = mat[2] * is3;
  var sm21 = mat[4] * is1;
  var sm22 = mat[5] * is2;
  var sm23 = mat[6] * is3;
  var sm31 = mat[8] * is1;
  var sm32 = mat[9] * is2;
  var sm33 = mat[10] * is3;
  var trace = sm11 + sm22 + sm33;
  var S = 0;
  if (trace > 0) {
    S = Math.sqrt(trace + 1) * 2;
    out[3] = 0.25 * S;
    out[0] = (sm23 - sm32) / S;
    out[1] = (sm31 - sm13) / S;
    out[2] = (sm12 - sm21) / S;
  } else if (sm11 > sm22 && sm11 > sm33) {
    S = Math.sqrt(1 + sm11 - sm22 - sm33) * 2;
    out[3] = (sm23 - sm32) / S;
    out[0] = 0.25 * S;
    out[1] = (sm12 + sm21) / S;
    out[2] = (sm31 + sm13) / S;
  } else if (sm22 > sm33) {
    S = Math.sqrt(1 + sm22 - sm11 - sm33) * 2;
    out[3] = (sm31 - sm13) / S;
    out[0] = (sm12 + sm21) / S;
    out[1] = 0.25 * S;
    out[2] = (sm23 + sm32) / S;
  } else {
    S = Math.sqrt(1 + sm33 - sm11 - sm22) * 2;
    out[3] = (sm12 - sm21) / S;
    out[0] = (sm31 + sm13) / S;
    out[1] = (sm23 + sm32) / S;
    out[2] = 0.25 * S;
  }
  return out;
}
var MathUtils = class MathUtils2 {
  static identity(v) {
    return v;
  }
  static eq(a, b, tolerance = 1e-5) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tolerance) return false;
    return true;
  }
  static clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }
  static decodeNormalizedInt(i, componentType) {
    switch (componentType) {
      case 5126:
        return i;
      case 5123:
        return i / 65535;
      case 5121:
        return i / 255;
      case 5122:
        return Math.max(i / 32767, -1);
      case 5120:
        return Math.max(i / 127, -1);
      default:
        throw new Error("Invalid component type.");
    }
  }
  static encodeNormalizedInt(f, componentType) {
    switch (componentType) {
      case 5126:
        return f;
      case 5123:
        return Math.round(MathUtils2.clamp(f, 0, 1) * 65535);
      case 5121:
        return Math.round(MathUtils2.clamp(f, 0, 1) * 255);
      case 5122:
        return Math.round(MathUtils2.clamp(f, -1, 1) * 32767);
      case 5120:
        return Math.round(MathUtils2.clamp(f, -1, 1) * 127);
      default:
        throw new Error("Invalid component type.");
    }
  }
  /**
  * Decompose a mat4 to TRS properties.
  *
  * Equivalent to the Matrix4 decompose() method in three.js, and intentionally not using the
  * gl-matrix version. See: https://github.com/toji/gl-matrix/issues/408
  *
  * @param srcMat Matrix element, to be decomposed to TRS properties.
  * @param dstTranslation Translation element, to be overwritten.
  * @param dstRotation Rotation element, to be overwritten.
  * @param dstScale Scale element, to be overwritten.
  */
  static decompose(srcMat, dstTranslation, dstRotation, dstScale) {
    let sx = length2([
      srcMat[0],
      srcMat[1],
      srcMat[2]
    ]);
    const sy = length2([
      srcMat[4],
      srcMat[5],
      srcMat[6]
    ]);
    const sz = length2([
      srcMat[8],
      srcMat[9],
      srcMat[10]
    ]);
    if (determinant(srcMat) < 0) sx = -sx;
    dstTranslation[0] = srcMat[12];
    dstTranslation[1] = srcMat[13];
    dstTranslation[2] = srcMat[14];
    const _m1 = srcMat.slice();
    const invSX = 1 / sx;
    const invSY = 1 / sy;
    const invSZ = 1 / sz;
    _m1[0] *= invSX;
    _m1[1] *= invSX;
    _m1[2] *= invSX;
    _m1[4] *= invSY;
    _m1[5] *= invSY;
    _m1[6] *= invSY;
    _m1[8] *= invSZ;
    _m1[9] *= invSZ;
    _m1[10] *= invSZ;
    getRotation(dstRotation, _m1);
    dstScale[0] = sx;
    dstScale[1] = sy;
    dstScale[2] = sz;
  }
  /**
  * Compose TRS properties to a mat4.
  *
  * Equivalent to the Matrix4 compose() method in three.js, and intentionally not using the
  * gl-matrix version. See: https://github.com/toji/gl-matrix/issues/408
  *
  * @param srcTranslation Translation element of matrix.
  * @param srcRotation Rotation element of matrix.
  * @param srcScale Scale element of matrix.
  * @param dstMat Matrix element, to be modified and returned.
  * @returns dstMat, overwritten to mat4 equivalent of given TRS properties.
  */
  static compose(srcTranslation, srcRotation, srcScale, dstMat) {
    const te = dstMat;
    const x = srcRotation[0], y = srcRotation[1], z = srcRotation[2], w = srcRotation[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = srcScale[0], sy = srcScale[1], sz = srcScale[2];
    te[0] = (1 - (yy + zz)) * sx;
    te[1] = (xy + wz) * sx;
    te[2] = (xz - wy) * sx;
    te[3] = 0;
    te[4] = (xy - wz) * sy;
    te[5] = (1 - (xx + zz)) * sy;
    te[6] = (yz + wx) * sy;
    te[7] = 0;
    te[8] = (xz + wy) * sz;
    te[9] = (yz - wx) * sz;
    te[10] = (1 - (xx + yy)) * sz;
    te[11] = 0;
    te[12] = srcTranslation[0];
    te[13] = srcTranslation[1];
    te[14] = srcTranslation[2];
    te[15] = 1;
    return te;
  }
};
function equalsRef(refA, refB) {
  if (!!refA !== !!refB) return false;
  const a = refA.getChild();
  const b = refB.getChild();
  return a === b || a.equals(b);
}
function equalsRefSet(refSetA, refSetB) {
  if (!!refSetA !== !!refSetB) return false;
  const refValuesA = refSetA.values();
  const refValuesB = refSetB.values();
  if (refValuesA.length !== refValuesB.length) return false;
  for (let i = 0; i < refValuesA.length; i++) {
    const a = refValuesA[i];
    const b = refValuesB[i];
    if (a.getChild() === b.getChild()) continue;
    if (!a.getChild().equals(b.getChild())) return false;
  }
  return true;
}
function equalsRefMap(refMapA, refMapB) {
  if (!!refMapA !== !!refMapB) return false;
  const keysA = refMapA.keys();
  const keysB = refMapB.keys();
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const refA = refMapA.get(key);
    const refB = refMapB.get(key);
    if (!!refA !== !!refB) return false;
    const a = refA.getChild();
    const b = refB.getChild();
    if (a === b) continue;
    if (!a.equals(b)) return false;
  }
  return true;
}
function equalsArray(a, b) {
  if (a === b) return true;
  if (!!a !== !!b || !a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function equalsObject(_a, _b) {
  if (_a === _b) return true;
  if (!!_a !== !!_b) return false;
  if (!isPlainObject(_a) || !isPlainObject(_b)) return _a === _b;
  const a = _a;
  const b = _b;
  let numKeysA = 0;
  let numKeysB = 0;
  let key;
  for (key in a) numKeysA++;
  for (key in b) numKeysB++;
  if (numKeysA !== numKeysB) return false;
  for (key in a) {
    const valueA = a[key];
    const valueB = b[key];
    if (isArray(valueA) && isArray(valueB)) {
      if (!equalsArray(valueA, valueB)) return false;
    } else if (isPlainObject(valueA) && isPlainObject(valueB)) {
      if (!equalsObject(valueA, valueB)) return false;
    } else if (valueA !== valueB) return false;
  }
  return true;
}
function isArray(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}
var ALPHABET = "23456789abdegjkmnpqrvwxyzABDEGJKMNPQRVWXYZ";
var UNIQUE_RETRIES = 999;
var ID_LENGTH = 6;
var previousIDs = /* @__PURE__ */ new Set();
var generateOne = function() {
  let rtn = "";
  for (let i = 0; i < ID_LENGTH; i++) rtn += ALPHABET.charAt(Math.floor(Math.random() * 42));
  return rtn;
};
var uuid = function() {
  for (let retries = 0; retries < UNIQUE_RETRIES; retries++) {
    const id = generateOne();
    if (!previousIDs.has(id)) {
      previousIDs.add(id);
      return id;
    }
  }
  return "";
};
var COPY_IDENTITY = (t) => t;
var EMPTY_SET = /* @__PURE__ */ new Set();
var Property = class extends GraphNode {
  /** @hidden */
  constructor(graph, name = "") {
    super(graph);
    this[$attributes]["name"] = name;
    this.init();
    this.dispatchEvent({ type: "create" });
  }
  /**
  * Returns the Graph associated with this Property. For internal use.
  * @hidden
  * @experimental
  */
  getGraph() {
    return this.graph;
  }
  /**
  * Returns default attributes for the property. Empty lists and maps should be initialized
  * to empty arrays and objects. Always invoke `super.getDefaults()` and extend the result.
  */
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      name: "",
      extras: {}
    });
  }
  /** @hidden */
  set(attribute, value) {
    if (Array.isArray(value)) value = value.slice();
    return super.set(attribute, value);
  }
  /**********************************************************************************************
  * Name.
  */
  /**
  * Returns the name of this property. While names are not required to be unique, this is
  * encouraged, and non-unique names will be overwritten in some tools. For custom data about
  * a property, prefer to use Extras.
  */
  getName() {
    return this.get("name");
  }
  /**
  * Sets the name of this property. While names are not required to be unique, this is
  * encouraged, and non-unique names will be overwritten in some tools. For custom data about
  * a property, prefer to use Extras.
  */
  setName(name) {
    return this.set("name", name);
  }
  /**********************************************************************************************
  * Extras.
  */
  /**
  * Returns a reference to the Extras object, containing application-specific data for this
  * Property. Extras should be an Object, not a primitive value, for best portability.
  */
  getExtras() {
    return this.get("extras");
  }
  /**
  * Updates the Extras object, containing application-specific data for this Property. Extras
  * should be an Object, not a primitive value, for best portability.
  */
  setExtras(extras) {
    return this.set("extras", extras);
  }
  /**********************************************************************************************
  * Graph state.
  */
  /**
  * Makes a copy of this property, with the same resources (by reference) as the original.
  */
  clone() {
    const PropertyClass = this.constructor;
    return new PropertyClass(this.graph).copy(this, COPY_IDENTITY);
  }
  /**
  * Copies all data from another property to this one. Child properties are copied by reference,
  * unless a 'resolve' function is given to override that.
  * @param other Property to copy references from.
  * @param resolve Function to resolve each Property being transferred. Default is identity.
  */
  copy(other, resolve = COPY_IDENTITY) {
    for (const key in this[$attributes]) {
      const value = this[$attributes][key];
      if (value instanceof GraphEdge) {
        if (!this[$immutableKeys].has(key)) value.dispose();
      } else if (value instanceof RefList || value instanceof RefSet) for (const ref of value.values()) ref.dispose();
      else if (value instanceof RefMap) for (const ref of value.values()) ref.dispose();
    }
    for (const key in other[$attributes]) {
      const thisValue = this[$attributes][key];
      const otherValue = other[$attributes][key];
      if (otherValue instanceof GraphEdge) if (this[$immutableKeys].has(key)) thisValue.getChild().copy(resolve(otherValue.getChild()), resolve);
      else this.setRef(key, resolve(otherValue.getChild()), otherValue.getAttributes());
      else if (otherValue instanceof RefSet || otherValue instanceof RefList) for (const ref of otherValue.values()) this.addRef(key, resolve(ref.getChild()), ref.getAttributes());
      else if (otherValue instanceof RefMap) for (const subkey of otherValue.keys()) {
        const ref = otherValue.get(subkey);
        this.setRefMap(key, subkey, resolve(ref.getChild()), ref.getAttributes());
      }
      else if (isPlainObject(otherValue)) this[$attributes][key] = JSON.parse(JSON.stringify(otherValue));
      else if (Array.isArray(otherValue) || otherValue instanceof ArrayBuffer || ArrayBuffer.isView(otherValue)) this[$attributes][key] = otherValue.slice();
      else this[$attributes][key] = otherValue;
    }
    return this;
  }
  /**
  * Returns true if two properties are deeply equivalent, recursively comparing the attributes
  * of the properties. Optionally, a 'skip' set may be included, specifying attributes whose
  * values should not be considered in the comparison.
  *
  * Example: Two {@link Primitive Primitives} are equivalent if they have accessors and
  * materials with equivalent content — but not necessarily the same specific accessors
  * and materials.
  */
  equals(other, skip = EMPTY_SET) {
    if (this === other) return true;
    if (this.propertyType !== other.propertyType) return false;
    for (const key in this[$attributes]) {
      if (skip.has(key)) continue;
      const a = this[$attributes][key];
      const b = other[$attributes][key];
      if (a instanceof GraphEdge || b instanceof GraphEdge) {
        if (!equalsRef(a, b)) return false;
      } else if (a instanceof RefSet || b instanceof RefSet || a instanceof RefList || b instanceof RefList) {
        if (!equalsRefSet(a, b)) return false;
      } else if (a instanceof RefMap || b instanceof RefMap) {
        if (!equalsRefMap(a, b)) return false;
      } else if (isPlainObject(a) || isPlainObject(b)) {
        if (!equalsObject(a, b)) return false;
      } else if (isArray(a) || isArray(b)) {
        if (!equalsArray(a, b)) return false;
      } else if (a !== b) return false;
    }
    return true;
  }
  detach() {
    this.graph.disconnectParents(this, (n) => n.propertyType !== "Root");
    return this;
  }
  /**
  * Returns a list of all properties that hold a reference to this property. For example, a
  * material may hold references to various textures, but a texture does not hold references
  * to the materials that use it.
  *
  * It is often necessary to filter the results for a particular type: some resources, like
  * {@link Accessor}s, may be referenced by different types of properties. Most properties
  * include the {@link Root} as a parent, which is usually not of interest.
  *
  * Usage:
  *
  * ```ts
  * const materials = texture
  * 	.listParents()
  * 	.filter((p) => p instanceof Material)
  * ```
  */
  listParents() {
    return this.graph.listParents(this);
  }
};
var ExtensibleProperty = class extends Property {
  getDefaults() {
    return Object.assign(super.getDefaults(), { extensions: new RefMap() });
  }
  /** Returns an {@link ExtensionProperty} attached to this Property, if any. */
  getExtension(name) {
    return this.getRefMap("extensions", name);
  }
  /**
  * Attaches the given {@link ExtensionProperty} to this Property. For a given extension, only
  * one ExtensionProperty may be attached to any one Property at a time.
  */
  setExtension(name, extensionProperty) {
    if (extensionProperty) extensionProperty._validateParent(this);
    return this.setRefMap("extensions", name, extensionProperty);
  }
  /** Lists all {@link ExtensionProperty} instances attached to this Property. */
  listExtensions() {
    return this.listRefMapValues("extensions");
  }
};
var Accessor = class Accessor2 extends ExtensibleProperty {
  /**********************************************************************************************
  * Constants.
  */
  /** Element type contained by the accessor (SCALAR, VEC2, ...). */
  static Type = {
    SCALAR: "SCALAR",
    VEC2: "VEC2",
    VEC3: "VEC3",
    VEC4: "VEC4",
    MAT2: "MAT2",
    MAT3: "MAT3",
    MAT4: "MAT4"
  };
  /** Data type of the values composing each element in the accessor. */
  static ComponentType = {
    BYTE: 5120,
    UNSIGNED_BYTE: 5121,
    SHORT: 5122,
    UNSIGNED_SHORT: 5123,
    UNSIGNED_INT: 5125,
    FLOAT: 5126,
    FLOAT16: 5131,
    FLOAT64: 5130
  };
  /**********************************************************************************************
  * Instance.
  */
  init() {
    this.propertyType = PropertyType.ACCESSOR;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      array: null,
      type: Accessor2.Type.SCALAR,
      componentType: Accessor2.ComponentType.FLOAT,
      normalized: false,
      sparse: false,
      buffer: null
    });
  }
  /**********************************************************************************************
  * Static.
  */
  /** Returns size of a given element type, in components. */
  static getElementSize(type) {
    switch (type) {
      case Accessor2.Type.SCALAR:
        return 1;
      case Accessor2.Type.VEC2:
        return 2;
      case Accessor2.Type.VEC3:
        return 3;
      case Accessor2.Type.VEC4:
        return 4;
      case Accessor2.Type.MAT2:
        return 4;
      case Accessor2.Type.MAT3:
        return 9;
      case Accessor2.Type.MAT4:
        return 16;
      default:
        throw new Error("Unexpected type: " + type);
    }
  }
  /** Returns size of a given component type, in bytes. */
  static getComponentSize(componentType) {
    switch (componentType) {
      case Accessor2.ComponentType.BYTE:
      case Accessor2.ComponentType.UNSIGNED_BYTE:
        return 1;
      case Accessor2.ComponentType.SHORT:
      case Accessor2.ComponentType.UNSIGNED_SHORT:
        return 2;
      case Accessor2.ComponentType.UNSIGNED_INT:
      case Accessor2.ComponentType.FLOAT:
        return 4;
      case Accessor2.ComponentType.FLOAT16:
        return 2;
      case Accessor2.ComponentType.FLOAT64:
        return 8;
      default:
        throw new Error("Unexpected component type: " + componentType);
    }
  }
  /**********************************************************************************************
  * Min/max bounds.
  */
  /**
  * Minimum value of each component in this attribute. Unlike in a final glTF file, values
  * returned by this method will reflect the minimum accounting for {@link .normalized}
  * state.
  */
  getMinNormalized(target) {
    const normalized = this.getNormalized();
    const elementSize = this.getElementSize();
    const componentType = this.getComponentType();
    this.getMin(target);
    if (normalized) for (let j = 0; j < elementSize; j++) target[j] = MathUtils.decodeNormalizedInt(target[j], componentType);
    return target;
  }
  /**
  * Minimum value of each component in this attribute. Values returned by this method do not
  * reflect normalization: use {@link .getMinNormalized} in that case.
  */
  getMin(target) {
    const array = this.getArray();
    const count = this.getCount();
    const elementSize = this.getElementSize();
    for (let j = 0; j < elementSize; j++) target[j] = Infinity;
    for (let i = 0; i < count * elementSize; i += elementSize) for (let j = 0; j < elementSize; j++) {
      const value = array[i + j];
      if (Number.isFinite(value)) target[j] = Math.min(target[j], value);
    }
    return target;
  }
  /**
  * Maximum value of each component in this attribute. Unlike in a final glTF file, values
  * returned by this method will reflect the minimum accounting for {@link .normalized}
  * state.
  */
  getMaxNormalized(target) {
    const normalized = this.getNormalized();
    const elementSize = this.getElementSize();
    const componentType = this.getComponentType();
    this.getMax(target);
    if (normalized) for (let j = 0; j < elementSize; j++) target[j] = MathUtils.decodeNormalizedInt(target[j], componentType);
    return target;
  }
  /**
  * Maximum value of each component in this attribute. Values returned by this method do not
  * reflect normalization: use {@link .getMinNormalized} in that case.
  */
  getMax(target) {
    const array = this.get("array");
    const count = this.getCount();
    const elementSize = this.getElementSize();
    for (let j = 0; j < elementSize; j++) target[j] = -Infinity;
    for (let i = 0; i < count * elementSize; i += elementSize) for (let j = 0; j < elementSize; j++) {
      const value = array[i + j];
      if (Number.isFinite(value)) target[j] = Math.max(target[j], value);
    }
    return target;
  }
  /**********************************************************************************************
  * Layout.
  */
  /**
  * Number of elements in the accessor. An array of length 30, containing 10 `VEC3` elements,
  * will have a count of 10.
  */
  getCount() {
    const array = this.get("array");
    return array ? array.length / this.getElementSize() : 0;
  }
  /** Type of element stored in the accessor. `VEC2`, `VEC3`, etc. */
  getType() {
    return this.get("type");
  }
  /**
  * Sets type of element stored in the accessor. `VEC2`, `VEC3`, etc. Array length must be a
  * multiple of the component size (`VEC2` = 2, `VEC3` = 3, ...) for the selected type.
  */
  setType(type) {
    return this.set("type", type);
  }
  /**
  * Number of components in each element of the accessor. For example, the element size of a
  * `VEC2` accessor is 2. This value is determined automatically based on array length and
  * accessor type, specified with {@link Accessor.setType setType()}.
  */
  getElementSize() {
    return Accessor2.getElementSize(this.get("type"));
  }
  /**
  * Size of each component (a value in the raw array), in bytes. For example, the
  * `componentSize` of data backed by a `float32` array is 4 bytes.
  */
  getComponentSize() {
    return this.get("array").BYTES_PER_ELEMENT;
  }
  /**
  * Component type (float32, uint16, etc.). This value is determined automatically, and can only
  * be modified by replacing the underlying array.
  */
  getComponentType() {
    return this.get("componentType");
  }
  /**********************************************************************************************
  * Normalization.
  */
  /**
  * Specifies whether integer data values should be normalized (true) to [0, 1] (for unsigned
  * types) or [-1, 1] (for signed types), or converted directly (false) when they are accessed.
  * This property is defined only for accessors that contain vertex attributes or animation
  * output data.
  */
  getNormalized() {
    return this.get("normalized");
  }
  /**
  * Specifies whether integer data values should be normalized (true) to [0, 1] (for unsigned
  * types) or [-1, 1] (for signed types), or converted directly (false) when they are accessed.
  * This property is defined only for accessors that contain vertex attributes or animation
  * output data.
  */
  setNormalized(normalized) {
    return this.set("normalized", normalized);
  }
  /**********************************************************************************************
  * Data access.
  */
  /**
  * Returns the scalar element value at the given index. For
  * {@link Accessor.getNormalized normalized} integer accessors, values are
  * decoded and returned in floating-point form.
  */
  getScalar(index) {
    const elementSize = this.getElementSize();
    const componentType = this.getComponentType();
    const array = this.getArray();
    if (this.getNormalized()) return MathUtils.decodeNormalizedInt(array[index * elementSize], componentType);
    return array[index * elementSize];
  }
  /**
  * Assigns the scalar element value at the given index. For
  * {@link Accessor.getNormalized normalized} integer accessors, "value" should be
  * given in floating-point form — it will be integer-encoded before writing
  * to the underlying array.
  */
  setScalar(index, x) {
    const elementSize = this.getElementSize();
    const componentType = this.getComponentType();
    const array = this.getArray();
    if (this.getNormalized()) array[index * elementSize] = MathUtils.encodeNormalizedInt(x, componentType);
    else array[index * elementSize] = x;
    return this;
  }
  /**
  * Returns the vector or matrix element value at the given index. For
  * {@link Accessor.getNormalized normalized} integer accessors, values are
  * decoded and returned in floating-point form.
  *
  * Example:
  *
  * ```javascript
  * import { add } from 'gl-matrix/add';
  *
  * const element = [];
  * const offset = [1, 1, 1];
  *
  * for (let i = 0; i < accessor.getCount(); i++) {
  * 	accessor.getElement(i, element);
  * 	add(element, element, offset);
  * 	accessor.setElement(i, element);
  * }
  * ```
  */
  getElement(index, target) {
    const normalized = this.getNormalized();
    const elementSize = this.getElementSize();
    const componentType = this.getComponentType();
    const array = this.getArray();
    for (let i = 0; i < elementSize; i++) if (normalized) target[i] = MathUtils.decodeNormalizedInt(array[index * elementSize + i], componentType);
    else target[i] = array[index * elementSize + i];
    return target;
  }
  /**
  * Assigns the vector or matrix element value at the given index. For
  * {@link Accessor.getNormalized normalized} integer accessors, "value" should be
  * given in floating-point form — it will be integer-encoded before writing
  * to the underlying array.
  *
  * Example:
  *
  * ```javascript
  * import { add } from 'gl-matrix/add';
  *
  * const element = [];
  * const offset = [1, 1, 1];
  *
  * for (let i = 0; i < accessor.getCount(); i++) {
  * 	accessor.getElement(i, element);
  * 	add(element, element, offset);
  * 	accessor.setElement(i, element);
  * }
  * ```
  */
  setElement(index, value) {
    const normalized = this.getNormalized();
    const elementSize = this.getElementSize();
    const componentType = this.getComponentType();
    const array = this.getArray();
    for (let i = 0; i < elementSize; i++) if (normalized) array[index * elementSize + i] = MathUtils.encodeNormalizedInt(value[i], componentType);
    else array[index * elementSize + i] = value[i];
    return this;
  }
  /**********************************************************************************************
  * Raw data storage.
  */
  /**
  * Specifies whether the accessor should be stored sparsely. When written to a glTF file, sparse
  * accessors store only values that differ from base values. When loaded in glTF Transform (or most
  * runtimes) a sparse accessor can be treated like any other accessor. Currently, glTF Transform always
  * uses zeroes for the base values when writing files.
  * @experimental
  */
  getSparse() {
    return this.get("sparse");
  }
  /**
  * Specifies whether the accessor should be stored sparsely. When written to a glTF file, sparse
  * accessors store only values that differ from base values. When loaded in glTF Transform (or most
  * runtimes) a sparse accessor can be treated like any other accessor. Currently, glTF Transform always
  * uses zeroes for the base values when writing files.
  * @experimental
  */
  setSparse(sparse) {
    return this.set("sparse", sparse);
  }
  /** Returns the {@link Buffer} into which this accessor will be organized. */
  getBuffer() {
    return this.getRef("buffer");
  }
  /** Assigns the {@link Buffer} into which this accessor will be organized. */
  setBuffer(buffer) {
    return this.setRef("buffer", buffer);
  }
  /** Returns the raw typed array underlying this accessor. */
  getArray() {
    return this.get("array");
  }
  /** Assigns the raw typed array underlying this accessor. */
  setArray(array) {
    this.set("componentType", array ? arrayToComponentType(array) : Accessor2.ComponentType.FLOAT);
    this.set("array", array);
    return this;
  }
  /** Returns the total bytelength of this accessor, exclusive of padding. */
  getByteLength() {
    const array = this.get("array");
    return array ? array.byteLength : 0;
  }
};
function arrayToComponentType(array) {
  switch (array.constructor) {
    case Float32Array:
      return Accessor.ComponentType.FLOAT;
    case Uint32Array:
      return Accessor.ComponentType.UNSIGNED_INT;
    case Uint16Array:
      return Accessor.ComponentType.UNSIGNED_SHORT;
    case Uint8Array:
      return Accessor.ComponentType.UNSIGNED_BYTE;
    case Int16Array:
      return Accessor.ComponentType.SHORT;
    case Int8Array:
      return Accessor.ComponentType.BYTE;
    case Float64Array:
      return Accessor.ComponentType.FLOAT64;
  }
  if (typeof Float16Array !== "undefined" && array.constructor === Float16Array) return Accessor.ComponentType.FLOAT16;
  throw new Error("Unknown accessor componentType.");
}
var Animation = class extends ExtensibleProperty {
  init() {
    this.propertyType = PropertyType.ANIMATION;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      channels: new RefSet(),
      samplers: new RefSet()
    });
  }
  /** Adds an {@link AnimationChannel} to this Animation. */
  addChannel(channel) {
    return this.addRef("channels", channel);
  }
  /** Removes an {@link AnimationChannel} from this Animation. */
  removeChannel(channel) {
    return this.removeRef("channels", channel);
  }
  /** Lists {@link AnimationChannel}s in this Animation. */
  listChannels() {
    return this.listRefs("channels");
  }
  /** Adds an {@link AnimationSampler} to this Animation. */
  addSampler(sampler) {
    return this.addRef("samplers", sampler);
  }
  /** Removes an {@link AnimationSampler} from this Animation. */
  removeSampler(sampler) {
    return this.removeRef("samplers", sampler);
  }
  /** Lists {@link AnimationSampler}s in this Animation. */
  listSamplers() {
    return this.listRefs("samplers");
  }
};
var AnimationChannel = class extends ExtensibleProperty {
  /**********************************************************************************************
  * Constants.
  */
  /** Name of the property to be modified by an animation channel. */
  static TargetPath = {
    TRANSLATION: "translation",
    ROTATION: "rotation",
    SCALE: "scale",
    WEIGHTS: "weights"
  };
  /**********************************************************************************************
  * Instance.
  */
  init() {
    this.propertyType = PropertyType.ANIMATION_CHANNEL;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      targetPath: null,
      targetNode: null,
      sampler: null
    });
  }
  /**********************************************************************************************
  * Properties.
  */
  /**
  * Path (property) animated on the target {@link Node}. Supported values include:
  * `translation`, `rotation`, `scale`, or `weights`.
  */
  getTargetPath() {
    return this.get("targetPath");
  }
  /**
  * Path (property) animated on the target {@link Node}. Supported values include:
  * `translation`, `rotation`, `scale`, or `weights`.
  */
  setTargetPath(targetPath) {
    return this.set("targetPath", targetPath);
  }
  /** Target {@link Node} animated by the channel. */
  getTargetNode() {
    return this.getRef("targetNode");
  }
  /** Target {@link Node} animated by the channel. */
  setTargetNode(targetNode) {
    return this.setRef("targetNode", targetNode);
  }
  /**
  * Keyframe data input/output values for the channel. Must be attached to the same
  * {@link Animation}.
  */
  getSampler() {
    return this.getRef("sampler");
  }
  /**
  * Keyframe data input/output values for the channel. Must be attached to the same
  * {@link Animation}.
  */
  setSampler(sampler) {
    return this.setRef("sampler", sampler);
  }
};
var AnimationSampler = class AnimationSampler2 extends ExtensibleProperty {
  /**********************************************************************************************
  * Constants.
  */
  /** Interpolation method. */
  static Interpolation = {
    LINEAR: "LINEAR",
    STEP: "STEP",
    CUBICSPLINE: "CUBICSPLINE"
  };
  /**********************************************************************************************
  * Instance.
  */
  init() {
    this.propertyType = PropertyType.ANIMATION_SAMPLER;
  }
  getDefaultAttributes() {
    return Object.assign(super.getDefaults(), {
      interpolation: AnimationSampler2.Interpolation.LINEAR,
      input: null,
      output: null
    });
  }
  /**********************************************************************************************
  * Static.
  */
  /** Interpolation mode: `STEP`, `LINEAR`, or `CUBICSPLINE`. */
  getInterpolation() {
    return this.get("interpolation");
  }
  /** Interpolation mode: `STEP`, `LINEAR`, or `CUBICSPLINE`. */
  setInterpolation(interpolation) {
    return this.set("interpolation", interpolation);
  }
  /** Times for each keyframe, in seconds. */
  getInput() {
    return this.getRef("input");
  }
  /** Times for each keyframe, in seconds. */
  setInput(input) {
    return this.setRef("input", input, { usage: BufferViewUsage$1.OTHER });
  }
  /**
  * Values for each keyframe. For `CUBICSPLINE` interpolation, output also contains in/out
  * tangents.
  */
  getOutput() {
    return this.getRef("output");
  }
  /**
  * Values for each keyframe. For `CUBICSPLINE` interpolation, output also contains in/out
  * tangents.
  */
  setOutput(output) {
    return this.setRef("output", output, { usage: BufferViewUsage$1.OTHER });
  }
};
var Buffer$1 = class extends ExtensibleProperty {
  init() {
    this.propertyType = PropertyType.BUFFER;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { uri: "" });
  }
  /**
  * Returns the URI (or filename) of this buffer (e.g. 'myBuffer.bin'). URIs are strongly
  * encouraged to be relative paths, rather than absolute. Use of a protocol (like `file://`)
  * is possible for custom applications, but will limit the compatibility of the asset with most
  * tools.
  *
  * Buffers commonly use the extension `.bin`, though this is not required.
  */
  getURI() {
    return this.get("uri");
  }
  /**
  * Sets the URI (or filename) of this buffer (e.g. 'myBuffer.bin'). URIs are strongly
  * encouraged to be relative paths, rather than absolute. Use of a protocol (like `file://`)
  * is possible for custom applications, but will limit the compatibility of the asset with most
  * tools.
  *
  * Buffers commonly use the extension `.bin`, though this is not required.
  */
  setURI(uri) {
    return this.set("uri", uri);
  }
};
var Camera = class Camera2 extends ExtensibleProperty {
  /**********************************************************************************************
  * Constants.
  */
  static Type = {
    PERSPECTIVE: "perspective",
    ORTHOGRAPHIC: "orthographic"
  };
  /**********************************************************************************************
  * Instance.
  */
  init() {
    this.propertyType = PropertyType.CAMERA;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      type: Camera2.Type.PERSPECTIVE,
      znear: 0.1,
      zfar: 100,
      aspectRatio: null,
      yfov: Math.PI * 2 * 50 / 360,
      xmag: 1,
      ymag: 1
    });
  }
  /**********************************************************************************************
  * Common.
  */
  /** Specifies if the camera uses a perspective or orthographic projection. */
  getType() {
    return this.get("type");
  }
  /** Specifies if the camera uses a perspective or orthographic projection. */
  setType(type) {
    return this.set("type", type);
  }
  /** Floating-point distance to the near clipping plane. */
  getZNear() {
    return this.get("znear");
  }
  /** Floating-point distance to the near clipping plane. */
  setZNear(znear) {
    return this.set("znear", znear);
  }
  /**
  * Floating-point distance to the far clipping plane. When defined, zfar must be greater than
  * znear. If zfar is undefined, runtime must use infinite projection matrix.
  */
  getZFar() {
    return this.get("zfar");
  }
  /**
  * Floating-point distance to the far clipping plane. When defined, zfar must be greater than
  * znear. If zfar is undefined, runtime must use infinite projection matrix.
  */
  setZFar(zfar) {
    return this.set("zfar", zfar);
  }
  /**********************************************************************************************
  * Perspective.
  */
  /**
  * Floating-point aspect ratio of the field of view. When undefined, the aspect ratio of the
  * canvas is used.
  */
  getAspectRatio() {
    return this.get("aspectRatio");
  }
  /**
  * Floating-point aspect ratio of the field of view. When undefined, the aspect ratio of the
  * canvas is used.
  */
  setAspectRatio(aspectRatio) {
    return this.set("aspectRatio", aspectRatio);
  }
  /** Floating-point vertical field of view in radians. */
  getYFov() {
    return this.get("yfov");
  }
  /** Floating-point vertical field of view in radians. */
  setYFov(yfov) {
    return this.set("yfov", yfov);
  }
  /**********************************************************************************************
  * Orthographic.
  */
  /**
  * Floating-point horizontal magnification of the view, and half the view's width
  * in world units.
  */
  getXMag() {
    return this.get("xmag");
  }
  /**
  * Floating-point horizontal magnification of the view, and half the view's width
  * in world units.
  */
  setXMag(xmag) {
    return this.set("xmag", xmag);
  }
  /**
  * Floating-point vertical magnification of the view, and half the view's height
  * in world units.
  */
  getYMag() {
    return this.get("ymag");
  }
  /**
  * Floating-point vertical magnification of the view, and half the view's height
  * in world units.
  */
  setYMag(ymag) {
    return this.set("ymag", ymag);
  }
};
var ExtensionProperty = class extends Property {
  static EXTENSION_NAME;
  /** @hidden */
  _validateParent(parent) {
    if (!this.parentTypes.includes(parent.propertyType)) throw new Error(`Parent "${parent.propertyType}" invalid for child "${this.propertyType}".`);
  }
};
var TextureInfo = class TextureInfo2 extends ExtensibleProperty {
  /**********************************************************************************************
  * Constants.
  */
  /** UV wrapping mode. Values correspond to WebGL enums. */
  static WrapMode = {
    CLAMP_TO_EDGE: 33071,
    MIRRORED_REPEAT: 33648,
    REPEAT: 10497
  };
  /** Magnification filter. Values correspond to WebGL enums. */
  static MagFilter = {
    NEAREST: 9728,
    LINEAR: 9729
  };
  /** Minification filter. Values correspond to WebGL enums. */
  static MinFilter = {
    NEAREST: 9728,
    LINEAR: 9729,
    NEAREST_MIPMAP_NEAREST: 9984,
    LINEAR_MIPMAP_NEAREST: 9985,
    NEAREST_MIPMAP_LINEAR: 9986,
    LINEAR_MIPMAP_LINEAR: 9987
  };
  /**********************************************************************************************
  * Instance.
  */
  init() {
    this.propertyType = PropertyType.TEXTURE_INFO;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      texCoord: 0,
      magFilter: null,
      minFilter: null,
      wrapS: TextureInfo2.WrapMode.REPEAT,
      wrapT: TextureInfo2.WrapMode.REPEAT
    });
  }
  /**********************************************************************************************
  * Texture coordinates.
  */
  /** Returns the texture coordinate (UV set) index for the texture. */
  getTexCoord() {
    return this.get("texCoord");
  }
  /** Sets the texture coordinate (UV set) index for the texture. */
  setTexCoord(texCoord) {
    return this.set("texCoord", texCoord);
  }
  /**********************************************************************************************
  * Min/mag filter.
  */
  /** Returns the magnification filter applied to the texture. */
  getMagFilter() {
    return this.get("magFilter");
  }
  /** Sets the magnification filter applied to the texture. */
  setMagFilter(magFilter) {
    return this.set("magFilter", magFilter);
  }
  /** Sets the minification filter applied to the texture. */
  getMinFilter() {
    return this.get("minFilter");
  }
  /** Returns the minification filter applied to the texture. */
  setMinFilter(minFilter) {
    return this.set("minFilter", minFilter);
  }
  /**********************************************************************************************
  * UV wrapping.
  */
  /** Returns the S (U) wrapping mode for UVs used by the texture. */
  getWrapS() {
    return this.get("wrapS");
  }
  /** Sets the S (U) wrapping mode for UVs used by the texture. */
  setWrapS(wrapS) {
    return this.set("wrapS", wrapS);
  }
  /** Returns the T (V) wrapping mode for UVs used by the texture. */
  getWrapT() {
    return this.get("wrapT");
  }
  /** Sets the T (V) wrapping mode for UVs used by the texture. */
  setWrapT(wrapT) {
    return this.set("wrapT", wrapT);
  }
};
var { R, G, B, A } = TextureChannel;
var Material = class Material2 extends ExtensibleProperty {
  /**********************************************************************************************
  * Constants.
  */
  static AlphaMode = {
    OPAQUE: "OPAQUE",
    MASK: "MASK",
    BLEND: "BLEND"
  };
  /**********************************************************************************************
  * Instance.
  */
  init() {
    this.propertyType = PropertyType.MATERIAL;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      alphaMode: Material2.AlphaMode.OPAQUE,
      alphaCutoff: 0.5,
      doubleSided: false,
      baseColorFactor: [
        1,
        1,
        1,
        1
      ],
      baseColorTexture: null,
      baseColorTextureInfo: new TextureInfo(this.graph, "baseColorTextureInfo"),
      emissiveFactor: [
        0,
        0,
        0
      ],
      emissiveTexture: null,
      emissiveTextureInfo: new TextureInfo(this.graph, "emissiveTextureInfo"),
      normalScale: 1,
      normalTexture: null,
      normalTextureInfo: new TextureInfo(this.graph, "normalTextureInfo"),
      occlusionStrength: 1,
      occlusionTexture: null,
      occlusionTextureInfo: new TextureInfo(this.graph, "occlusionTextureInfo"),
      roughnessFactor: 1,
      metallicFactor: 1,
      metallicRoughnessTexture: null,
      metallicRoughnessTextureInfo: new TextureInfo(this.graph, "metallicRoughnessTextureInfo")
    });
  }
  /**********************************************************************************************
  * Double-sided / culling.
  */
  /** Returns true when both sides of triangles should be rendered. May impact performance. */
  getDoubleSided() {
    return this.get("doubleSided");
  }
  /** Sets whether to render both sides of triangles. May impact performance. */
  setDoubleSided(doubleSided) {
    return this.set("doubleSided", doubleSided);
  }
  /**********************************************************************************************
  * Alpha.
  */
  /** Returns material alpha, equivalent to baseColorFactor[3]. */
  getAlpha() {
    return this.get("baseColorFactor")[3];
  }
  /** Sets material alpha, equivalent to baseColorFactor[3]. */
  setAlpha(alpha) {
    const baseColorFactor = this.get("baseColorFactor").slice();
    baseColorFactor[3] = alpha;
    return this.set("baseColorFactor", baseColorFactor);
  }
  /**
  * Returns the mode of the material's alpha channels, which are provided by `baseColorFactor`
  * and `baseColorTexture`.
  *
  * - `OPAQUE`: Alpha value is ignored and the rendered output is fully opaque.
  * - `BLEND`: Alpha value is used to determine the transparency each pixel on a surface, and
  * 	the fraction of surface vs. background color in the final result. Alpha blending creates
  *	significant edge cases in realtime renderers, and some care when structuring the model is
  * 	necessary for good results. In particular, transparent geometry should be kept in separate
  * 	meshes or primitives from opaque geometry. The `depthWrite` or `zWrite` settings in engines
  * 	should usually be disabled on transparent materials.
  * - `MASK`: Alpha value is compared against `alphaCutoff` threshold for each pixel on a
  * 	surface, and the pixel is either fully visible or fully discarded based on that cutoff.
  * 	This technique is useful for things like leafs/foliage, grass, fabric meshes, and other
  * 	surfaces where no semitransparency is needed. With a good choice of `alphaCutoff`, surfaces
  * 	that don't require semitransparency can avoid the performance penalties and visual issues
  * 	involved with `BLEND` transparency.
  *
  * Reference:
  * - [glTF → material.alphaMode](https://github.com/KhronosGroup/gltf/blob/main/specification/2.0/README.md#materialalphamode)
  */
  getAlphaMode() {
    return this.get("alphaMode");
  }
  /** Sets the mode of the material's alpha channels. See {@link Material.getAlphaMode getAlphaMode} for details. */
  setAlphaMode(alphaMode) {
    return this.set("alphaMode", alphaMode);
  }
  /** Returns the visibility threshold; applied only when `.alphaMode='MASK'`. */
  getAlphaCutoff() {
    return this.get("alphaCutoff");
  }
  /** Sets the visibility threshold; applied only when `.alphaMode='MASK'`. */
  setAlphaCutoff(alphaCutoff) {
    return this.set("alphaCutoff", alphaCutoff);
  }
  /**********************************************************************************************
  * Base color.
  */
  /**
  * Base color / albedo factor; Linear-sRGB components.
  * See {@link Material.getBaseColorTexture getBaseColorTexture}.
  */
  getBaseColorFactor() {
    return this.get("baseColorFactor");
  }
  /**
  * Base color / albedo factor; Linear-sRGB components.
  * See {@link Material.getBaseColorTexture getBaseColorTexture}.
  */
  setBaseColorFactor(baseColorFactor) {
    return this.set("baseColorFactor", baseColorFactor);
  }
  /**
  * Base color / albedo. The visible color of a non-metallic surface under constant ambient
  * light would be a linear combination (multiplication) of its vertex colors, base color
  * factor, and base color texture. Lighting, and reflections in metallic or smooth surfaces,
  * also effect the final color. The alpha (`.a`) channel of base color factors and textures
  * will have varying effects, based on the setting of {@link Material.getAlphaMode getAlphaMode}.
  *
  * Reference:
  * - [glTF → material.pbrMetallicRoughness.baseColorFactor](https://github.com/KhronosGroup/gltf/blob/main/specification/2.0/README.md#pbrmetallicroughnessbasecolorfactor)
  */
  getBaseColorTexture() {
    return this.getRef("baseColorTexture");
  }
  /**
  * Settings affecting the material's use of its base color texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getBaseColorTextureInfo() {
    return this.getRef("baseColorTexture") ? this.getRef("baseColorTextureInfo") : null;
  }
  /** Sets base color / albedo texture. See {@link Material.getBaseColorTexture getBaseColorTexture}. */
  setBaseColorTexture(texture) {
    return this.setRef("baseColorTexture", texture, {
      channels: R | G | B | A,
      isColor: true
    });
  }
  /**********************************************************************************************
  * Emissive.
  */
  /** Emissive color; Linear-sRGB components. See {@link Material.getEmissiveTexture getEmissiveTexture}. */
  getEmissiveFactor() {
    return this.get("emissiveFactor");
  }
  /** Emissive color; Linear-sRGB components. See {@link Material.getEmissiveTexture getEmissiveTexture}. */
  setEmissiveFactor(emissiveFactor) {
    return this.set("emissiveFactor", emissiveFactor);
  }
  /**
  * Emissive texture. Emissive color is added to any base color of the material, after any
  * lighting/shadowing are applied. An emissive color does not inherently "glow", or affect
  * objects around it at all. To create that effect, most viewers must also enable a
  * post-processing effect called "bloom".
  *
  * Reference:
  * - [glTF → material.emissiveTexture](https://github.com/KhronosGroup/gltf/blob/main/specification/2.0/README.md#materialemissivetexture)
  */
  getEmissiveTexture() {
    return this.getRef("emissiveTexture");
  }
  /**
  * Settings affecting the material's use of its emissive texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getEmissiveTextureInfo() {
    return this.getRef("emissiveTexture") ? this.getRef("emissiveTextureInfo") : null;
  }
  /** Sets emissive texture. See {@link Material.getEmissiveTexture getEmissiveTexture}. */
  setEmissiveTexture(texture) {
    return this.setRef("emissiveTexture", texture, {
      channels: R | G | B,
      isColor: true
    });
  }
  /**********************************************************************************************
  * Normal.
  */
  /** Normal (surface detail) factor; linear multiplier. Affects `.normalTexture`. */
  getNormalScale() {
    return this.get("normalScale");
  }
  /** Normal (surface detail) factor; linear multiplier. Affects `.normalTexture`. */
  setNormalScale(scale2) {
    return this.set("normalScale", scale2);
  }
  /**
  * Normal (surface detail) texture.
  *
  * A tangent space normal map. The texture contains RGB components. Each texel represents the
  * XYZ components of a normal vector in tangent space. Red [0 to 255] maps to X [-1 to 1].
  * Green [0 to 255] maps to Y [-1 to 1]. Blue [128 to 255] maps to Z [1/255 to 1]. The normal
  * vectors use OpenGL conventions where +X is right and +Y is up. +Z points toward the viewer.
  *
  * Reference:
  * - [glTF → material.normalTexture](https://github.com/KhronosGroup/gltf/blob/main/specification/2.0/README.md#materialnormaltexture)
  */
  getNormalTexture() {
    return this.getRef("normalTexture");
  }
  /**
  * Settings affecting the material's use of its normal texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getNormalTextureInfo() {
    return this.getRef("normalTexture") ? this.getRef("normalTextureInfo") : null;
  }
  /** Sets normal (surface detail) texture. See {@link Material.getNormalTexture getNormalTexture}. */
  setNormalTexture(texture) {
    return this.setRef("normalTexture", texture, { channels: R | G | B });
  }
  /**********************************************************************************************
  * Occlusion.
  */
  /** (Ambient) Occlusion factor; linear multiplier. Affects `.occlusionTexture`. */
  getOcclusionStrength() {
    return this.get("occlusionStrength");
  }
  /** Sets (ambient) occlusion factor; linear multiplier. Affects `.occlusionTexture`. */
  setOcclusionStrength(strength) {
    return this.set("occlusionStrength", strength);
  }
  /**
  * (Ambient) Occlusion texture, generally used for subtle 'baked' shadowing effects that are
  * independent of an object's position, such as shading in inset areas and corners. Direct
  * lighting is not affected by occlusion, so at least one indirect light source must be present
  * in the scene for occlusion effects to be visible.
  *
  * The occlusion values are sampled from the R channel. Higher values indicate areas that
  * should receive full indirect lighting and lower values indicate no indirect lighting.
  *
  * Reference:
  * - [glTF → material.occlusionTexture](https://github.com/KhronosGroup/gltf/blob/main/specification/2.0/README.md#materialocclusiontexture)
  */
  getOcclusionTexture() {
    return this.getRef("occlusionTexture");
  }
  /**
  * Settings affecting the material's use of its occlusion texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getOcclusionTextureInfo() {
    return this.getRef("occlusionTexture") ? this.getRef("occlusionTextureInfo") : null;
  }
  /** Sets (ambient) occlusion texture. See {@link Material.getOcclusionTexture getOcclusionTexture}. */
  setOcclusionTexture(texture) {
    return this.setRef("occlusionTexture", texture, { channels: R });
  }
  /**********************************************************************************************
  * Metallic / roughness.
  */
  /**
  * Roughness factor; linear multiplier. Affects roughness channel of
  * `metallicRoughnessTexture`. See {@link Material.getMetallicRoughnessTexture getMetallicRoughnessTexture}.
  */
  getRoughnessFactor() {
    return this.get("roughnessFactor");
  }
  /**
  * Sets roughness factor; linear multiplier. Affects roughness channel of
  * `metallicRoughnessTexture`. See {@link Material.getMetallicRoughnessTexture getMetallicRoughnessTexture}.
  */
  setRoughnessFactor(factor) {
    return this.set("roughnessFactor", factor);
  }
  /**
  * Metallic factor; linear multiplier. Affects roughness channel of
  * `metallicRoughnessTexture`. See {@link Material.getMetallicRoughnessTexture getMetallicRoughnessTexture}.
  */
  getMetallicFactor() {
    return this.get("metallicFactor");
  }
  /**
  * Sets metallic factor; linear multiplier. Affects roughness channel of
  * `metallicRoughnessTexture`. See {@link Material.getMetallicRoughnessTexture getMetallicRoughnessTexture}.
  */
  setMetallicFactor(factor) {
    return this.set("metallicFactor", factor);
  }
  /**
  * Metallic roughness texture. The metalness values are sampled from the B channel. The
  * roughness values are sampled from the G channel. When a material is fully metallic,
  * or nearly so, it may require image-based lighting (i.e. an environment map) or global
  * illumination to appear well-lit.
  *
  * Reference:
  * - [glTF → material.pbrMetallicRoughness.metallicRoughnessTexture](https://github.com/KhronosGroup/gltf/blob/main/specification/2.0/README.md#pbrmetallicroughnessmetallicroughnesstexture)
  */
  getMetallicRoughnessTexture() {
    return this.getRef("metallicRoughnessTexture");
  }
  /**
  * Settings affecting the material's use of its metallic/roughness texture. If no texture is
  * attached, {@link TextureInfo} is `null`.
  */
  getMetallicRoughnessTextureInfo() {
    return this.getRef("metallicRoughnessTexture") ? this.getRef("metallicRoughnessTextureInfo") : null;
  }
  /**
  * Sets metallic/roughness texture.
  * See {@link Material.getMetallicRoughnessTexture getMetallicRoughnessTexture}.
  */
  setMetallicRoughnessTexture(texture) {
    return this.setRef("metallicRoughnessTexture", texture, { channels: G | B });
  }
};
var Mesh = class extends ExtensibleProperty {
  init() {
    this.propertyType = PropertyType.MESH;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      weights: [],
      primitives: new RefSet()
    });
  }
  /** Adds a {@link Primitive} to the mesh's draw call list. */
  addPrimitive(primitive) {
    return this.addRef("primitives", primitive);
  }
  /** Removes a {@link Primitive} from the mesh's draw call list. */
  removePrimitive(primitive) {
    return this.removeRef("primitives", primitive);
  }
  /** Lists {@link Primitive} draw calls of the mesh. */
  listPrimitives() {
    return this.listRefs("primitives");
  }
  /**
  * Initial weights of each {@link PrimitiveTarget} on this mesh. Each {@link Primitive} must
  * have the same number of targets. Most engines only support 4-8 active morph targets at a
  * time.
  */
  getWeights() {
    return this.get("weights");
  }
  /**
  * Initial weights of each {@link PrimitiveTarget} on this mesh. Each {@link Primitive} must
  * have the same number of targets. Most engines only support 4-8 active morph targets at a
  * time.
  */
  setWeights(weights) {
    return this.set("weights", weights);
  }
};
var Node = class extends ExtensibleProperty {
  init() {
    this.propertyType = PropertyType.NODE;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      translation: [
        0,
        0,
        0
      ],
      rotation: [
        0,
        0,
        0,
        1
      ],
      scale: [
        1,
        1,
        1
      ],
      weights: [],
      camera: null,
      mesh: null,
      skin: null,
      children: new RefSet()
    });
  }
  copy(other, resolve = COPY_IDENTITY) {
    if (resolve === COPY_IDENTITY) throw new Error("Node cannot be copied.");
    return super.copy(other, resolve);
  }
  /**********************************************************************************************
  * Local transform.
  */
  /** Returns the translation (position) of this Node in local space. */
  getTranslation() {
    return this.get("translation");
  }
  /** Returns the rotation (quaternion) of this Node in local space. */
  getRotation() {
    return this.get("rotation");
  }
  /** Returns the scale of this Node in local space. */
  getScale() {
    return this.get("scale");
  }
  /** Sets the translation (position) of this Node in local space. */
  setTranslation(translation) {
    return this.set("translation", translation);
  }
  /** Sets the rotation (quaternion) of this Node in local space. */
  setRotation(rotation) {
    return this.set("rotation", rotation);
  }
  /** Sets the scale of this Node in local space. */
  setScale(scale2) {
    return this.set("scale", scale2);
  }
  /** Returns the local matrix of this Node. */
  getMatrix() {
    return MathUtils.compose(this.get("translation"), this.get("rotation"), this.get("scale"), []);
  }
  /** Sets the local matrix of this Node. Matrix will be decomposed to TRS properties. */
  setMatrix(matrix) {
    const translation = this.get("translation").slice();
    const rotation = this.get("rotation").slice();
    const scale2 = this.get("scale").slice();
    MathUtils.decompose(matrix, translation, rotation, scale2);
    return this.set("translation", translation).set("rotation", rotation).set("scale", scale2);
  }
  /**********************************************************************************************
  * World transform.
  */
  /** Returns the translation (position) of this Node in world space. */
  getWorldTranslation() {
    const t = [
      0,
      0,
      0
    ];
    MathUtils.decompose(this.getWorldMatrix(), t, [
      0,
      0,
      0,
      1
    ], [
      1,
      1,
      1
    ]);
    return t;
  }
  /** Returns the rotation (quaternion) of this Node in world space. */
  getWorldRotation() {
    const r = [
      0,
      0,
      0,
      1
    ];
    MathUtils.decompose(this.getWorldMatrix(), [
      0,
      0,
      0
    ], r, [
      1,
      1,
      1
    ]);
    return r;
  }
  /** Returns the scale of this Node in world space. */
  getWorldScale() {
    const s = [
      1,
      1,
      1
    ];
    MathUtils.decompose(this.getWorldMatrix(), [
      0,
      0,
      0
    ], [
      0,
      0,
      0,
      1
    ], s);
    return s;
  }
  /** Returns the world matrix of this Node. */
  getWorldMatrix() {
    const ancestors = [];
    for (let node = this; node != null; node = node.getParentNode()) ancestors.push(node);
    let ancestor;
    const worldMatrix = ancestors.pop().getMatrix();
    while (ancestor = ancestors.pop()) multiply(worldMatrix, worldMatrix, ancestor.getMatrix());
    return worldMatrix;
  }
  /**********************************************************************************************
  * Scene hierarchy.
  */
  /**
  * Adds the given Node as a child of this Node.
  *
  * Requirements:
  *
  * 1. Nodes MAY be root children of multiple {@link Scene Scenes}
  * 2. Nodes MUST NOT be children of >1 Node
  * 3. Nodes MUST NOT be children of both Nodes and {@link Scene Scenes}
  *
  * The `addChild` method enforces these restrictions automatically, and will
  * remove the new child from previous parents where needed. This behavior
  * may change in future major releases of the library.
  */
  addChild(child) {
    const parentNode = child.getParentNode();
    if (parentNode) parentNode.removeChild(child);
    for (const parent of child.listParents()) if (parent.propertyType === PropertyType.SCENE) parent.removeChild(child);
    return this.addRef("children", child);
  }
  /** Removes a Node from this Node's child Node list. */
  removeChild(child) {
    return this.removeRef("children", child);
  }
  /** Lists all child Nodes of this Node. */
  listChildren() {
    return this.listRefs("children");
  }
  /**
  * Returns the Node's unique parent Node within the scene graph. If the
  * Node has no parents, or is a direct child of the {@link Scene}
  * ("root node"), this method returns null.
  *
  * Unrelated to {@link Property.listParents}, which lists all resource
  * references from properties of any type ({@link Skin}, {@link Root}, ...).
  */
  getParentNode() {
    for (const parent of this.listParents()) if (parent.propertyType === PropertyType.NODE) return parent;
    return null;
  }
  /**********************************************************************************************
  * Attachments.
  */
  /** Returns the {@link Mesh}, if any, instantiated at this Node. */
  getMesh() {
    return this.getRef("mesh");
  }
  /**
  * Sets a {@link Mesh} to be instantiated at this Node. A single mesh may be instantiated by
  * multiple Nodes; reuse of this sort is strongly encouraged.
  */
  setMesh(mesh) {
    return this.setRef("mesh", mesh);
  }
  /** Returns the {@link Camera}, if any, instantiated at this Node. */
  getCamera() {
    return this.getRef("camera");
  }
  /** Sets a {@link Camera} to be instantiated at this Node. */
  setCamera(camera2) {
    return this.setRef("camera", camera2);
  }
  /** Returns the {@link Skin}, if any, instantiated at this Node. */
  getSkin() {
    return this.getRef("skin");
  }
  /** Sets a {@link Skin} to be instantiated at this Node. */
  setSkin(skin) {
    return this.setRef("skin", skin);
  }
  /**
  * Initial weights of each {@link PrimitiveTarget} for the mesh instance at this Node.
  * Most engines only support 4-8 active morph targets at a time.
  */
  getWeights() {
    return this.get("weights");
  }
  /**
  * Initial weights of each {@link PrimitiveTarget} for the mesh instance at this Node.
  * Most engines only support 4-8 active morph targets at a time.
  */
  setWeights(weights) {
    return this.set("weights", weights);
  }
  /**********************************************************************************************
  * Helpers.
  */
  /** Visits this {@link Node} and its descendants, top-down. */
  traverse(fn) {
    fn(this);
    for (const child of this.listChildren()) child.traverse(fn);
    return this;
  }
};
var Primitive = class Primitive2 extends ExtensibleProperty {
  /**********************************************************************************************
  * Constants.
  */
  /** Type of primitives to render. All valid values correspond to WebGL enums. */
  static Mode = {
    POINTS: 0,
    LINES: 1,
    LINE_LOOP: 2,
    LINE_STRIP: 3,
    TRIANGLES: 4,
    TRIANGLE_STRIP: 5,
    TRIANGLE_FAN: 6
  };
  /**********************************************************************************************
  * Instance.
  */
  init() {
    this.propertyType = PropertyType.PRIMITIVE;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      mode: Primitive2.Mode.TRIANGLES,
      material: null,
      indices: null,
      attributes: new RefMap(),
      targets: new RefSet()
    });
  }
  /**********************************************************************************************
  * Primitive data.
  */
  /** Returns an {@link Accessor} with indices of vertices to be drawn. */
  getIndices() {
    return this.getRef("indices");
  }
  /**
  * Sets an {@link Accessor} with indices of vertices to be drawn. In `TRIANGLES` draw mode,
  * each set of three indices define a triangle. The front face has a counter-clockwise (CCW)
  * winding order.
  */
  setIndices(indices) {
    return this.setRef("indices", indices, { usage: BufferViewUsage$1.ELEMENT_ARRAY_BUFFER });
  }
  /** Returns a vertex attribute as an {@link Accessor}. */
  getAttribute(semantic) {
    return this.getRefMap("attributes", semantic);
  }
  /**
  * Sets a vertex attribute to an {@link Accessor}. All attributes must have the same vertex
  * count.
  */
  setAttribute(semantic, accessor) {
    return this.setRefMap("attributes", semantic, accessor, { usage: BufferViewUsage$1.ARRAY_BUFFER });
  }
  /**
  * Lists all vertex attribute {@link Accessor}s associated with the primitive, excluding any
  * attributes used for morph targets. For example, `[positionAccessor, normalAccessor,
  * uvAccessor]`. Order will be consistent with the order returned by {@link .listSemantics}().
  */
  listAttributes() {
    return this.listRefMapValues("attributes");
  }
  /**
  * Lists all vertex attribute semantics associated with the primitive, excluding any semantics
  * used for morph targets. For example, `['POSITION', 'NORMAL', 'TEXCOORD_0']`. Order will be
  * consistent with the order returned by {@link .listAttributes}().
  */
  listSemantics() {
    return this.listRefMapKeys("attributes");
  }
  /** Returns the material used to render the primitive. */
  getMaterial() {
    return this.getRef("material");
  }
  /** Sets the material used to render the primitive. */
  setMaterial(material) {
    return this.setRef("material", material);
  }
  /**********************************************************************************************
  * Mode.
  */
  /**
  * Returns the GPU draw mode (`TRIANGLES`, `LINES`, `POINTS`...) as a WebGL enum value.
  *
  * Reference:
  * - [glTF → `primitive.mode`](https://github.com/KhronosGroup/gltf/blob/main/specification/2.0/README.md#primitivemode)
  */
  getMode() {
    return this.get("mode");
  }
  /**
  * Sets the GPU draw mode (`TRIANGLES`, `LINES`, `POINTS`...) as a WebGL enum value.
  *
  * Reference:
  * - [glTF → `primitive.mode`](https://github.com/KhronosGroup/gltf/blob/main/specification/2.0/README.md#primitivemode)
  */
  setMode(mode) {
    return this.set("mode", mode);
  }
  /**********************************************************************************************
  * Morph targets.
  */
  /** Lists all morph targets associated with the primitive. */
  listTargets() {
    return this.listRefs("targets");
  }
  /**
  * Adds a morph target to the primitive. All primitives in the same mesh must have the same
  * number of targets.
  */
  addTarget(target) {
    return this.addRef("targets", target);
  }
  /**
  * Removes a morph target from the primitive. All primitives in the same mesh must have the same
  * number of targets.
  */
  removeTarget(target) {
    return this.removeRef("targets", target);
  }
};
var PrimitiveTarget = class extends Property {
  init() {
    this.propertyType = PropertyType.PRIMITIVE_TARGET;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { attributes: new RefMap() });
  }
  /** Returns a morph target vertex attribute as an {@link Accessor}. */
  getAttribute(semantic) {
    return this.getRefMap("attributes", semantic);
  }
  /**
  * Sets a morph target vertex attribute to an {@link Accessor}.
  */
  setAttribute(semantic, accessor) {
    return this.setRefMap("attributes", semantic, accessor, { usage: BufferViewUsage$1.ARRAY_BUFFER });
  }
  /**
  * Lists all morph target vertex attribute {@link Accessor}s associated. Order will be
  * consistent with the order returned by {@link .listSemantics}().
  */
  listAttributes() {
    return this.listRefMapValues("attributes");
  }
  /**
  * Lists all morph target vertex attribute semantics associated. Order will be
  * consistent with the order returned by {@link .listAttributes}().
  */
  listSemantics() {
    return this.listRefMapKeys("attributes");
  }
};
var Scene = class extends ExtensibleProperty {
  init() {
    this.propertyType = PropertyType.SCENE;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { children: new RefSet() });
  }
  copy(other, resolve = COPY_IDENTITY) {
    if (resolve === COPY_IDENTITY) throw new Error("Scene cannot be copied.");
    return super.copy(other, resolve);
  }
  /**
  * Adds a {@link Node} to the Scene.
  *
  * Requirements:
  *
  * 1. Nodes MAY be root children of multiple {@link Scene Scenes}
  * 2. Nodes MUST NOT be children of >1 Node
  * 3. Nodes MUST NOT be children of both Nodes and {@link Scene Scenes}
  *
  * The `addChild` method enforces these restrictions automatically, and will
  * remove the new child from previous parents where needed. This behavior
  * may change in future major releases of the library.
  */
  addChild(node) {
    const parentNode = node.getParentNode();
    if (parentNode) parentNode.removeChild(node);
    return this.addRef("children", node);
  }
  /** Removes a {@link Node} from the Scene. */
  removeChild(node) {
    return this.removeRef("children", node);
  }
  /**
  * Lists all direct child {@link Node Nodes} in the Scene. Indirect
  * descendants (children of children) are not returned, but may be
  * reached recursively or with {@link Scene.traverse} instead.
  */
  listChildren() {
    return this.listRefs("children");
  }
  /** Visits each {@link Node} in the Scene, including descendants, top-down. */
  traverse(fn) {
    for (const node of this.listChildren()) node.traverse(fn);
    return this;
  }
};
var Skin = class extends ExtensibleProperty {
  init() {
    this.propertyType = PropertyType.SKIN;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      skeleton: null,
      inverseBindMatrices: null,
      joints: new RefSet()
    });
  }
  /**
  * {@link Node} used as a skeleton root. The node must be the closest common root of the joints
  * hierarchy or a direct or indirect parent node of the closest common root.
  */
  getSkeleton() {
    return this.getRef("skeleton");
  }
  /**
  * {@link Node} used as a skeleton root. The node must be the closest common root of the joints
  * hierarchy or a direct or indirect parent node of the closest common root.
  */
  setSkeleton(skeleton) {
    return this.setRef("skeleton", skeleton);
  }
  /**
  * {@link Accessor} containing the floating-point 4x4 inverse-bind matrices. The default is
  * that each matrix is a 4x4 identity matrix, which implies that inverse-bind matrices were
  * pre-applied.
  */
  getInverseBindMatrices() {
    return this.getRef("inverseBindMatrices");
  }
  /**
  * {@link Accessor} containing the floating-point 4x4 inverse-bind matrices. The default is
  * that each matrix is a 4x4 identity matrix, which implies that inverse-bind matrices were
  * pre-applied.
  */
  setInverseBindMatrices(inverseBindMatrices) {
    return this.setRef("inverseBindMatrices", inverseBindMatrices, { usage: BufferViewUsage$1.INVERSE_BIND_MATRICES });
  }
  /** Adds a joint {@link Node} to this {@link Skin}. */
  addJoint(joint) {
    return this.addRef("joints", joint);
  }
  /** Removes a joint {@link Node} from this {@link Skin}. */
  removeJoint(joint) {
    return this.removeRef("joints", joint);
  }
  /** Lists joints ({@link Node}s used as joints or bones) in this {@link Skin}. */
  listJoints() {
    return this.listRefs("joints");
  }
};
var Texture = class extends ExtensibleProperty {
  init() {
    this.propertyType = PropertyType.TEXTURE;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      image: null,
      mimeType: "",
      uri: ""
    });
  }
  /**********************************************************************************************
  * MIME type / format.
  */
  /** Returns the MIME type for this texture ('image/jpeg' or 'image/png'). */
  getMimeType() {
    return this.get("mimeType") || ImageUtils.extensionToMimeType(FileUtils.extension(this.get("uri")));
  }
  /**
  * Sets the MIME type for this texture ('image/jpeg' or 'image/png'). If the texture does not
  * have a URI, a MIME type is required for correct export.
  */
  setMimeType(mimeType) {
    return this.set("mimeType", mimeType);
  }
  /**********************************************************************************************
  * URI / filename.
  */
  /** Returns the URI (e.g. 'path/to/file.png') for this texture. */
  getURI() {
    return this.get("uri");
  }
  /**
  * Sets the URI (e.g. 'path/to/file.png') for this texture. If the texture does not have a MIME
  * type, a URI is required for correct export.
  */
  setURI(uri) {
    this.set("uri", uri);
    const mimeType = ImageUtils.extensionToMimeType(FileUtils.extension(uri));
    if (mimeType) this.set("mimeType", mimeType);
    return this;
  }
  /**********************************************************************************************
  * Image data.
  */
  /** Returns the raw image data for this texture. */
  getImage() {
    return this.get("image");
  }
  /** Sets the raw image data for this texture. */
  setImage(image) {
    return this.set("image", BufferUtils.assertView(image));
  }
  /** Returns the size, in pixels, of this texture. */
  getSize() {
    const image = this.get("image");
    if (!image) return null;
    return ImageUtils.getSize(image, this.getMimeType());
  }
};
var Root = class extends ExtensibleProperty {
  _extensions = /* @__PURE__ */ new Set();
  init() {
    this.propertyType = PropertyType.ROOT;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      asset: {
        generator: `glTF-Transform ${VERSION}`,
        version: "2.0"
      },
      defaultScene: null,
      accessors: new RefSet(),
      animations: new RefSet(),
      buffers: new RefSet(),
      cameras: new RefSet(),
      materials: new RefSet(),
      meshes: new RefSet(),
      nodes: new RefSet(),
      scenes: new RefSet(),
      skins: new RefSet(),
      textures: new RefSet()
    });
  }
  /** @internal */
  constructor(graph) {
    super(graph);
    graph.addEventListener("node:create", (event) => {
      this._addChildOfRoot(event.target);
    });
  }
  clone() {
    throw new Error("Root cannot be cloned.");
  }
  copy(other, resolve = COPY_IDENTITY) {
    if (resolve === COPY_IDENTITY) throw new Error("Root cannot be copied.");
    this.set("asset", { ...other.get("asset") });
    this.setName(other.getName());
    this.setExtras({ ...other.getExtras() });
    this.setDefaultScene(other.getDefaultScene() ? resolve(other.getDefaultScene()) : null);
    for (const extensionName of other.listRefMapKeys("extensions")) {
      const otherExtension = other.getExtension(extensionName);
      this.setExtension(extensionName, resolve(otherExtension));
    }
    return this;
  }
  _addChildOfRoot(child) {
    if (child instanceof Scene) this.addRef("scenes", child);
    else if (child instanceof Node) this.addRef("nodes", child);
    else if (child instanceof Camera) this.addRef("cameras", child);
    else if (child instanceof Skin) this.addRef("skins", child);
    else if (child instanceof Mesh) this.addRef("meshes", child);
    else if (child instanceof Material) this.addRef("materials", child);
    else if (child instanceof Texture) this.addRef("textures", child);
    else if (child instanceof Animation) this.addRef("animations", child);
    else if (child instanceof Accessor) this.addRef("accessors", child);
    else if (child instanceof Buffer$1) this.addRef("buffers", child);
    return this;
  }
  /**
  * Returns the `asset` object, which specifies the target glTF version of the asset. Additional
  * metadata can be stored in optional properties such as `generator` or `copyright`.
  *
  * Reference: [glTF → Asset](https://github.com/KhronosGroup/gltf/blob/main/specification/2.0/README.md#asset)
  */
  getAsset() {
    return this.get("asset");
  }
  /**********************************************************************************************
  * Extensions.
  */
  /** Lists all {@link Extension Extensions} enabled for this root. */
  listExtensionsUsed() {
    return Array.from(this._extensions);
  }
  /** Lists all {@link Extension Extensions} enabled and required for this root. */
  listExtensionsRequired() {
    return this.listExtensionsUsed().filter((extension) => extension.isRequired());
  }
  /** @internal */
  _enableExtension(extension) {
    this._extensions.add(extension);
    return this;
  }
  /** @internal */
  _disableExtension(extension) {
    this._extensions.delete(extension);
    return this;
  }
  /**********************************************************************************************
  * Properties.
  */
  /** Lists all {@link Scene} properties associated with this root. */
  listScenes() {
    return this.listRefs("scenes");
  }
  /** Default {@link Scene} associated with this root. */
  setDefaultScene(defaultScene) {
    return this.setRef("defaultScene", defaultScene);
  }
  /** Default {@link Scene} associated with this root. */
  getDefaultScene() {
    return this.getRef("defaultScene");
  }
  /** Lists all {@link Node} properties associated with this root. */
  listNodes() {
    return this.listRefs("nodes");
  }
  /** Lists all {@link Camera} properties associated with this root. */
  listCameras() {
    return this.listRefs("cameras");
  }
  /** Lists all {@link Skin} properties associated with this root. */
  listSkins() {
    return this.listRefs("skins");
  }
  /** Lists all {@link Mesh} properties associated with this root. */
  listMeshes() {
    return this.listRefs("meshes");
  }
  /** Lists all {@link Material} properties associated with this root. */
  listMaterials() {
    return this.listRefs("materials");
  }
  /** Lists all {@link Texture} properties associated with this root. */
  listTextures() {
    return this.listRefs("textures");
  }
  /** Lists all {@link Animation} properties associated with this root. */
  listAnimations() {
    return this.listRefs("animations");
  }
  /** Lists all {@link Accessor} properties associated with this root. */
  listAccessors() {
    return this.listRefs("accessors");
  }
  /** Lists all {@link Buffer} properties associated with this root. */
  listBuffers() {
    return this.listRefs("buffers");
  }
};
var Document = class Document2 {
  _graph = new Graph();
  _root = new Root(this._graph);
  _logger = Logger.DEFAULT_INSTANCE;
  /**
  * Enables lookup of a Document from its Graph. For internal use, only.
  * @internal
  * @experimental
  */
  static _GRAPH_DOCUMENTS = /* @__PURE__ */ new WeakMap();
  /**
  * Returns the Document associated with a given Graph, if any.
  * @hidden
  * @experimental
  */
  static fromGraph(graph) {
    return Document2._GRAPH_DOCUMENTS.get(graph) || null;
  }
  /** Creates a new Document, representing an empty glTF asset. */
  constructor() {
    Document2._GRAPH_DOCUMENTS.set(this._graph, this);
  }
  /** Returns the glTF {@link Root} property. */
  getRoot() {
    return this._root;
  }
  /**
  * Returns the {@link Graph} representing connectivity of resources within this document.
  * @hidden
  */
  getGraph() {
    return this._graph;
  }
  /** Returns the {@link Logger} instance used for any operations performed on this document. */
  getLogger() {
    return this._logger;
  }
  /**
  * Overrides the {@link Logger} instance used for any operations performed on this document.
  *
  * Usage:
  *
  * ```ts
  * doc
  * 	.setLogger(new Logger(Logger.Verbosity.SILENT))
  * 	.transform(dedup(), weld());
  * ```
  */
  setLogger(logger) {
    this._logger = logger;
    return this;
  }
  /**
  * Clones this Document, copying all resources within it.
  * @deprecated Use 'cloneDocument(document)' from '@gltf-transform/functions'.
  * @hidden
  * @internal
  */
  clone() {
    throw new Error(`Use 'cloneDocument(source)' from '@gltf-transform/functions'.`);
  }
  /**
  * Merges the content of another Document into this one, without affecting the original.
  * @deprecated Use 'mergeDocuments(target, source)' from '@gltf-transform/functions'.
  * @hidden
  * @internal
  */
  merge(_other) {
    throw new Error(`Use 'mergeDocuments(target, source)' from '@gltf-transform/functions'.`);
  }
  /**
  * Applies a series of modifications to this document. Each transformation is asynchronous,
  * takes the {@link Document} as input, and returns nothing. Transforms are applied in the
  * order given, which may affect the final result.
  *
  * Usage:
  *
  * ```ts
  * await doc.transform(
  * 	dedup(),
  * 	prune()
  * );
  * ```
  *
  * @param transforms List of synchronous transformation functions to apply.
  */
  async transform(...transforms) {
    const stack = transforms.map((fn) => fn.name);
    for (const transform of transforms) await transform(this, { stack });
    return this;
  }
  /**********************************************************************************************
  * Extension management methods.
  */
  /**
  * Returns true if an {@link Extension} with the given name exists on the document, otherwise false.
  */
  hasExtension(extensionName) {
    return this.getRoot().listExtensionsUsed().some((ext) => ext.extensionName === extensionName);
  }
  /**
  * Creates a new {@link Extension}, for the extension type of the given constructor. If the
  * extension is already enabled for this Document, the previous Extension reference is reused.
  */
  createExtension(ctor) {
    const extensionName = ctor.EXTENSION_NAME;
    return this.getRoot().listExtensionsUsed().find((ext) => ext.extensionName === extensionName) || new ctor(this);
  }
  /**
  * Disables and removes an {@link Extension} from the Document. If no Extension exists with
  * the given name, this method has no effect.
  */
  disposeExtension(extensionName) {
    const extension = this.getRoot().listExtensionsUsed().find((ext) => ext.extensionName === extensionName);
    if (extension) extension.dispose();
  }
  /**********************************************************************************************
  * Property factory methods.
  */
  /** Creates a new {@link Scene} attached to this document's {@link Root}. */
  createScene(name = "") {
    return new Scene(this._graph, name);
  }
  /** Creates a new {@link Node} attached to this document's {@link Root}. */
  createNode(name = "") {
    return new Node(this._graph, name);
  }
  /** Creates a new {@link Camera} attached to this document's {@link Root}. */
  createCamera(name = "") {
    return new Camera(this._graph, name);
  }
  /** Creates a new {@link Skin} attached to this document's {@link Root}. */
  createSkin(name = "") {
    return new Skin(this._graph, name);
  }
  /** Creates a new {@link Mesh} attached to this document's {@link Root}. */
  createMesh(name = "") {
    return new Mesh(this._graph, name);
  }
  /**
  * Creates a new {@link Primitive}. Primitives must be attached to a {@link Mesh}
  * for use and export; they are not otherwise associated with a {@link Root}.
  */
  createPrimitive() {
    return new Primitive(this._graph);
  }
  /**
  * Creates a new {@link PrimitiveTarget}, or morph target. Targets must be attached to a
  * {@link Primitive} for use and export; they are not otherwise associated with a {@link Root}.
  */
  createPrimitiveTarget(name = "") {
    return new PrimitiveTarget(this._graph, name);
  }
  /** Creates a new {@link Material} attached to this document's {@link Root}. */
  createMaterial(name = "") {
    return new Material(this._graph, name);
  }
  /** Creates a new {@link Texture} attached to this document's {@link Root}. */
  createTexture(name = "") {
    return new Texture(this._graph, name);
  }
  /** Creates a new {@link Animation} attached to this document's {@link Root}. */
  createAnimation(name = "") {
    return new Animation(this._graph, name);
  }
  /**
  * Creates a new {@link AnimationChannel}. Channels must be attached to an {@link Animation}
  * for use and export; they are not otherwise associated with a {@link Root}.
  */
  createAnimationChannel(name = "") {
    return new AnimationChannel(this._graph, name);
  }
  /**
  * Creates a new {@link AnimationSampler}. Samplers must be attached to an {@link Animation}
  * for use and export; they are not otherwise associated with a {@link Root}.
  */
  createAnimationSampler(name = "") {
    return new AnimationSampler(this._graph, name);
  }
  /** Creates a new {@link Accessor} attached to this document's {@link Root}. */
  createAccessor(name = "", buffer = null) {
    if (!buffer) buffer = this.getRoot().listBuffers()[0];
    return new Accessor(this._graph, name).setBuffer(buffer);
  }
  /** Creates a new {@link Buffer} attached to this document's {@link Root}. */
  createBuffer(name = "") {
    return new Buffer$1(this._graph, name);
  }
};
var Extension = class {
  /** Official name of the extension. */
  static EXTENSION_NAME;
  /** Official name of the extension. */
  extensionName = "";
  /**
  * Before reading, extension should be called for these {@link Property} types. *Most
  * extensions don't need to implement this.*
  * @hidden
  */
  prereadTypes = [];
  /**
  * Before writing, extension should be called for these {@link Property} types. *Most
  * extensions don't need to implement this.*
  * @hidden
  */
  prewriteTypes = [];
  /** @hidden Dependency IDs needed to read this extension, to be installed before I/O. */
  readDependencies = [];
  /** @hidden Dependency IDs needed to write this extension, to be installed before I/O. */
  writeDependencies = [];
  /** @hidden */
  document;
  /** @hidden */
  required = false;
  /** @hidden */
  properties = /* @__PURE__ */ new Set();
  /** @hidden */
  _listener;
  /** @hidden */
  constructor(document2) {
    this.document = document2;
    document2.getRoot()._enableExtension(this);
    this._listener = (_event) => {
      const event = _event;
      const target = event.target;
      if (target instanceof ExtensionProperty && target.extensionName === this.extensionName) {
        if (event.type === "node:create") this._addExtensionProperty(target);
        if (event.type === "node:dispose") this._removeExtensionProperty(target);
      }
    };
    const graph = document2.getGraph();
    graph.addEventListener("node:create", this._listener);
    graph.addEventListener("node:dispose", this._listener);
  }
  /** Disables and removes the extension from the Document. */
  dispose() {
    this.document.getRoot()._disableExtension(this);
    const graph = this.document.getGraph();
    graph.removeEventListener("node:create", this._listener);
    graph.removeEventListener("node:dispose", this._listener);
    for (const property of this.properties) property.dispose();
  }
  /** @hidden Performs first-time setup for the extension. Must be idempotent. */
  static register() {
  }
  /**
  * Indicates to the client whether it is OK to load the asset when this extension is not
  * recognized. Optional extensions are generally preferred, if there is not a good reason
  * to require a client to completely fail when an extension isn't known.
  */
  isRequired() {
    return this.required;
  }
  /**
  * Indicates to the client whether it is OK to load the asset when this extension is not
  * recognized. Optional extensions are generally preferred, if there is not a good reason
  * to require a client to completely fail when an extension isn't known.
  */
  setRequired(required) {
    this.required = required;
    return this;
  }
  /**
  * Lists all {@link ExtensionProperty} instances associated with, or created by, this
  * extension. Includes only instances that are attached to the Document's graph; detached
  * instances will be excluded.
  */
  listProperties() {
    return Array.from(this.properties);
  }
  /**********************************************************************************************
  * ExtensionProperty management.
  */
  /** @internal */
  _addExtensionProperty(property) {
    this.properties.add(property);
    return this;
  }
  /** @internal */
  _removeExtensionProperty(property) {
    this.properties.delete(property);
    return this;
  }
  /**********************************************************************************************
  * I/O implementation.
  */
  /** @hidden Installs dependencies required by the extension. */
  install(_key, _dependency) {
    return this;
  }
  /**
  * Used by the {@link PlatformIO} utilities when reading a glTF asset. This method may
  * optionally be implemented by an extension, and should then support any property type
  * declared by the Extension's {@link Extension.prereadTypes} list. The Extension will
  * be given a ReaderContext instance, and is expected to update either the context or its
  * {@link JSONDocument} with resources known to the Extension. *Most extensions don't need to
  * implement this.*
  * @hidden
  */
  preread(_readerContext, _propertyType) {
    return this;
  }
  /**
  * Used by the {@link PlatformIO} utilities when writing a glTF asset. This method may
  * optionally be implemented by an extension, and should then support any property type
  * declared by the Extension's {@link Extension.prewriteTypes} list. The Extension will
  * be given a WriterContext instance, and is expected to update either the context or its
  * {@link JSONDocument} with resources known to the Extension. *Most extensions don't need to
  * implement this.*
  * @hidden
  */
  prewrite(_writerContext, _propertyType) {
    return this;
  }
};
var ReaderContext = class {
  buffers = [];
  bufferViews = [];
  bufferViewBuffers = [];
  accessors = [];
  textures = [];
  textureInfos = /* @__PURE__ */ new Map();
  materials = [];
  meshes = [];
  cameras = [];
  nodes = [];
  skins = [];
  animations = [];
  scenes = [];
  constructor(jsonDoc) {
    this.jsonDoc = jsonDoc;
  }
  setTextureInfo(textureInfo, textureInfoDef) {
    this.textureInfos.set(textureInfo, textureInfoDef);
    if (textureInfoDef.texCoord !== void 0) textureInfo.setTexCoord(textureInfoDef.texCoord);
    if (textureInfoDef.extras !== void 0) textureInfo.setExtras(textureInfoDef.extras);
    const textureDef = this.jsonDoc.json.textures[textureInfoDef.index];
    if (textureDef.sampler === void 0) return;
    const samplerDef = this.jsonDoc.json.samplers[textureDef.sampler];
    if (samplerDef.magFilter !== void 0) textureInfo.setMagFilter(samplerDef.magFilter);
    if (samplerDef.minFilter !== void 0) textureInfo.setMinFilter(samplerDef.minFilter);
    if (samplerDef.wrapS !== void 0) textureInfo.setWrapS(samplerDef.wrapS);
    if (samplerDef.wrapT !== void 0) textureInfo.setWrapT(samplerDef.wrapT);
  }
};
var DEFAULT_OPTIONS = {
  logger: Logger.DEFAULT_INSTANCE,
  extensions: [],
  dependencies: {}
};
var SUPPORTED_PREREAD_TYPES = /* @__PURE__ */ new Set([
  PropertyType.BUFFER,
  PropertyType.TEXTURE,
  PropertyType.MATERIAL,
  PropertyType.MESH,
  PropertyType.PRIMITIVE,
  PropertyType.NODE,
  PropertyType.SCENE
]);
var GLTFReader = class {
  static read(jsonDoc, _options = DEFAULT_OPTIONS) {
    const options = {
      ...DEFAULT_OPTIONS,
      ..._options
    };
    const { json } = jsonDoc;
    const document2 = new Document().setLogger(options.logger);
    this.validate(jsonDoc, options);
    const context = new ReaderContext(jsonDoc);
    const assetDef = json.asset;
    const asset = document2.getRoot().getAsset();
    if (assetDef.copyright) asset.copyright = assetDef.copyright;
    if (assetDef.extras) asset.extras = assetDef.extras;
    if (json.extras !== void 0) document2.getRoot().setExtras({ ...json.extras });
    const extensionsUsed = json.extensionsUsed || [];
    const extensionsRequired = json.extensionsRequired || [];
    options.extensions.sort((a, b) => a.EXTENSION_NAME > b.EXTENSION_NAME ? 1 : -1);
    for (const Extension2 of options.extensions) if (extensionsUsed.includes(Extension2.EXTENSION_NAME)) {
      const extension = document2.createExtension(Extension2).setRequired(extensionsRequired.includes(Extension2.EXTENSION_NAME));
      const unsupportedHooks = extension.prereadTypes.filter((type) => !SUPPORTED_PREREAD_TYPES.has(type));
      if (unsupportedHooks.length) options.logger.warn(`Preread hooks for some types (${unsupportedHooks.join()}), requested by extension ${extension.extensionName}, are unsupported. Please file an issue or a PR.`);
      for (const key of extension.readDependencies) extension.install(key, options.dependencies[key]);
    }
    const bufferDefs = json.buffers || [];
    document2.getRoot().listExtensionsUsed().filter((extension) => extension.prereadTypes.includes(PropertyType.BUFFER)).forEach((extension) => extension.preread(context, PropertyType.BUFFER));
    context.buffers = bufferDefs.map((bufferDef) => {
      const buffer = document2.createBuffer(bufferDef.name);
      if (bufferDef.extras) buffer.setExtras(bufferDef.extras);
      if (bufferDef.uri && bufferDef.uri.indexOf("__") !== 0) buffer.setURI(bufferDef.uri);
      return buffer;
    });
    context.bufferViewBuffers = (json.bufferViews || []).map((bufferViewDef, index) => {
      if (!context.bufferViews[index]) {
        const bufferDef = jsonDoc.json.buffers[bufferViewDef.buffer];
        const bufferData = bufferDef.uri ? jsonDoc.resources[bufferDef.uri] : jsonDoc.resources[GLB_BUFFER];
        const byteOffset = bufferViewDef.byteOffset || 0;
        context.bufferViews[index] = BufferUtils.toView(bufferData, byteOffset, bufferViewDef.byteLength);
      }
      return context.buffers[bufferViewDef.buffer];
    });
    const accessorDefs = json.accessors || [];
    context.accessors = accessorDefs.map((accessorDef) => {
      const buffer = context.bufferViewBuffers[accessorDef.bufferView];
      const accessor = document2.createAccessor(accessorDef.name, buffer).setType(accessorDef.type);
      if (accessorDef.extras) accessor.setExtras(accessorDef.extras);
      if (accessorDef.normalized !== void 0) accessor.setNormalized(accessorDef.normalized);
      if (accessorDef.bufferView === void 0) return accessor;
      accessor.setArray(getAccessorArray(accessorDef, context));
      return accessor;
    });
    const imageDefs = json.images || [];
    const textureDefs = json.textures || [];
    document2.getRoot().listExtensionsUsed().filter((extension) => extension.prereadTypes.includes(PropertyType.TEXTURE)).forEach((extension) => extension.preread(context, PropertyType.TEXTURE));
    context.textures = imageDefs.map((imageDef) => {
      const texture = document2.createTexture(imageDef.name);
      if (imageDef.extras) texture.setExtras(imageDef.extras);
      if (imageDef.bufferView !== void 0) {
        const bufferViewDef = json.bufferViews[imageDef.bufferView];
        const bufferDef = jsonDoc.json.buffers[bufferViewDef.buffer];
        const bufferData = bufferDef.uri ? jsonDoc.resources[bufferDef.uri] : jsonDoc.resources[GLB_BUFFER];
        const byteOffset = bufferViewDef.byteOffset || 0;
        const byteLength = bufferViewDef.byteLength;
        const imageData = bufferData.slice(byteOffset, byteOffset + byteLength);
        texture.setImage(imageData);
      } else if (imageDef.uri !== void 0) {
        texture.setImage(jsonDoc.resources[imageDef.uri]);
        if (imageDef.uri.indexOf("__") !== 0) texture.setURI(imageDef.uri);
      }
      if (imageDef.mimeType !== void 0) texture.setMimeType(imageDef.mimeType);
      else if (imageDef.uri) {
        const extension = FileUtils.extension(imageDef.uri);
        texture.setMimeType(ImageUtils.extensionToMimeType(extension));
      }
      return texture;
    });
    document2.getRoot().listExtensionsUsed().filter((extension) => extension.prereadTypes.includes(PropertyType.MATERIAL)).forEach((extension) => extension.preread(context, PropertyType.MATERIAL));
    context.materials = (json.materials || []).map((materialDef) => {
      const material = document2.createMaterial(materialDef.name);
      if (materialDef.extras) material.setExtras(materialDef.extras);
      if (materialDef.alphaMode !== void 0) material.setAlphaMode(materialDef.alphaMode);
      if (materialDef.alphaCutoff !== void 0) material.setAlphaCutoff(materialDef.alphaCutoff);
      if (materialDef.doubleSided !== void 0) material.setDoubleSided(materialDef.doubleSided);
      const pbrDef = materialDef.pbrMetallicRoughness || {};
      if (pbrDef.baseColorFactor !== void 0) material.setBaseColorFactor(pbrDef.baseColorFactor);
      if (materialDef.emissiveFactor !== void 0) material.setEmissiveFactor(materialDef.emissiveFactor);
      if (pbrDef.metallicFactor !== void 0) material.setMetallicFactor(pbrDef.metallicFactor);
      if (pbrDef.roughnessFactor !== void 0) material.setRoughnessFactor(pbrDef.roughnessFactor);
      if (pbrDef.baseColorTexture !== void 0) {
        const textureInfoDef = pbrDef.baseColorTexture;
        const texture = context.textures[textureDefs[textureInfoDef.index].source];
        material.setBaseColorTexture(texture);
        context.setTextureInfo(material.getBaseColorTextureInfo(), textureInfoDef);
      }
      if (materialDef.emissiveTexture !== void 0) {
        const textureInfoDef = materialDef.emissiveTexture;
        const texture = context.textures[textureDefs[textureInfoDef.index].source];
        material.setEmissiveTexture(texture);
        context.setTextureInfo(material.getEmissiveTextureInfo(), textureInfoDef);
      }
      if (materialDef.normalTexture !== void 0) {
        const textureInfoDef = materialDef.normalTexture;
        const texture = context.textures[textureDefs[textureInfoDef.index].source];
        material.setNormalTexture(texture);
        context.setTextureInfo(material.getNormalTextureInfo(), textureInfoDef);
        if (materialDef.normalTexture.scale !== void 0) material.setNormalScale(materialDef.normalTexture.scale);
      }
      if (materialDef.occlusionTexture !== void 0) {
        const textureInfoDef = materialDef.occlusionTexture;
        const texture = context.textures[textureDefs[textureInfoDef.index].source];
        material.setOcclusionTexture(texture);
        context.setTextureInfo(material.getOcclusionTextureInfo(), textureInfoDef);
        if (materialDef.occlusionTexture.strength !== void 0) material.setOcclusionStrength(materialDef.occlusionTexture.strength);
      }
      if (pbrDef.metallicRoughnessTexture !== void 0) {
        const textureInfoDef = pbrDef.metallicRoughnessTexture;
        const texture = context.textures[textureDefs[textureInfoDef.index].source];
        material.setMetallicRoughnessTexture(texture);
        context.setTextureInfo(material.getMetallicRoughnessTextureInfo(), textureInfoDef);
      }
      return material;
    });
    document2.getRoot().listExtensionsUsed().filter((extension) => extension.prereadTypes.includes(PropertyType.MESH)).forEach((extension) => extension.preread(context, PropertyType.MESH));
    const meshDefs = json.meshes || [];
    document2.getRoot().listExtensionsUsed().filter((extension) => extension.prereadTypes.includes(PropertyType.PRIMITIVE)).forEach((extension) => extension.preread(context, PropertyType.PRIMITIVE));
    context.meshes = meshDefs.map((meshDef) => {
      const mesh = document2.createMesh(meshDef.name);
      if (meshDef.extras) mesh.setExtras(meshDef.extras);
      if (meshDef.weights !== void 0) mesh.setWeights(meshDef.weights);
      (meshDef.primitives || []).forEach((primitiveDef) => {
        const primitive = document2.createPrimitive();
        if (primitiveDef.extras) primitive.setExtras(primitiveDef.extras);
        if (primitiveDef.material !== void 0) primitive.setMaterial(context.materials[primitiveDef.material]);
        if (primitiveDef.mode !== void 0) primitive.setMode(primitiveDef.mode);
        for (const [semantic, index] of Object.entries(primitiveDef.attributes || {})) primitive.setAttribute(semantic, context.accessors[index]);
        if (primitiveDef.indices !== void 0) primitive.setIndices(context.accessors[primitiveDef.indices]);
        const targetNames = meshDef.extras && meshDef.extras.targetNames || [];
        (primitiveDef.targets || []).forEach((targetDef, targetIndex) => {
          const targetName = targetNames[targetIndex] || targetIndex.toString();
          const target = document2.createPrimitiveTarget(targetName);
          for (const [semantic, accessorIndex] of Object.entries(targetDef)) target.setAttribute(semantic, context.accessors[accessorIndex]);
          primitive.addTarget(target);
        });
        mesh.addPrimitive(primitive);
      });
      return mesh;
    });
    context.cameras = (json.cameras || []).map((cameraDef) => {
      const camera2 = document2.createCamera(cameraDef.name).setType(cameraDef.type);
      if (cameraDef.extras) camera2.setExtras(cameraDef.extras);
      if (cameraDef.type === Camera.Type.PERSPECTIVE) {
        const perspectiveDef = cameraDef.perspective;
        camera2.setYFov(perspectiveDef.yfov);
        camera2.setZNear(perspectiveDef.znear);
        if (perspectiveDef.zfar !== void 0) camera2.setZFar(perspectiveDef.zfar);
        if (perspectiveDef.aspectRatio !== void 0) camera2.setAspectRatio(perspectiveDef.aspectRatio);
      } else {
        const orthoDef = cameraDef.orthographic;
        camera2.setZNear(orthoDef.znear).setZFar(orthoDef.zfar).setXMag(orthoDef.xmag).setYMag(orthoDef.ymag);
      }
      return camera2;
    });
    const nodeDefs = json.nodes || [];
    document2.getRoot().listExtensionsUsed().filter((extension) => extension.prereadTypes.includes(PropertyType.NODE)).forEach((extension) => extension.preread(context, PropertyType.NODE));
    context.nodes = nodeDefs.map((nodeDef) => {
      const node = document2.createNode(nodeDef.name);
      if (nodeDef.extras) node.setExtras(nodeDef.extras);
      if (nodeDef.translation !== void 0) node.setTranslation(nodeDef.translation);
      if (nodeDef.rotation !== void 0) node.setRotation(nodeDef.rotation);
      if (nodeDef.scale !== void 0) node.setScale(nodeDef.scale);
      if (nodeDef.matrix !== void 0) {
        const translation = [
          0,
          0,
          0
        ];
        const rotation = [
          0,
          0,
          0,
          1
        ];
        const scale2 = [
          1,
          1,
          1
        ];
        MathUtils.decompose(nodeDef.matrix, translation, rotation, scale2);
        node.setTranslation(translation);
        node.setRotation(rotation);
        node.setScale(scale2);
      }
      if (nodeDef.weights !== void 0) node.setWeights(nodeDef.weights);
      return node;
    });
    context.skins = (json.skins || []).map((skinDef) => {
      const skin = document2.createSkin(skinDef.name);
      if (skinDef.extras) skin.setExtras(skinDef.extras);
      if (skinDef.inverseBindMatrices !== void 0) skin.setInverseBindMatrices(context.accessors[skinDef.inverseBindMatrices]);
      if (skinDef.skeleton !== void 0) skin.setSkeleton(context.nodes[skinDef.skeleton]);
      for (const nodeIndex of skinDef.joints) skin.addJoint(context.nodes[nodeIndex]);
      return skin;
    });
    nodeDefs.map((nodeDef, nodeIndex) => {
      const node = context.nodes[nodeIndex];
      (nodeDef.children || []).forEach((childIndex) => node.addChild(context.nodes[childIndex]));
      if (nodeDef.mesh !== void 0) node.setMesh(context.meshes[nodeDef.mesh]);
      if (nodeDef.camera !== void 0) node.setCamera(context.cameras[nodeDef.camera]);
      if (nodeDef.skin !== void 0) node.setSkin(context.skins[nodeDef.skin]);
    });
    context.animations = (json.animations || []).map((animationDef) => {
      const animation = document2.createAnimation(animationDef.name);
      if (animationDef.extras) animation.setExtras(animationDef.extras);
      const samplers = (animationDef.samplers || []).map((samplerDef) => {
        const sampler = document2.createAnimationSampler().setInput(context.accessors[samplerDef.input]).setOutput(context.accessors[samplerDef.output]).setInterpolation(samplerDef.interpolation || AnimationSampler.Interpolation.LINEAR);
        if (samplerDef.extras) sampler.setExtras(samplerDef.extras);
        animation.addSampler(sampler);
        return sampler;
      });
      (animationDef.channels || []).forEach((channelDef) => {
        const channel = document2.createAnimationChannel().setSampler(samplers[channelDef.sampler]).setTargetPath(channelDef.target.path);
        if (channelDef.target.node !== void 0) channel.setTargetNode(context.nodes[channelDef.target.node]);
        if (channelDef.extras) channel.setExtras(channelDef.extras);
        animation.addChannel(channel);
      });
      return animation;
    });
    const sceneDefs = json.scenes || [];
    document2.getRoot().listExtensionsUsed().filter((extension) => extension.prereadTypes.includes(PropertyType.SCENE)).forEach((extension) => extension.preread(context, PropertyType.SCENE));
    context.scenes = sceneDefs.map((sceneDef) => {
      const scene2 = document2.createScene(sceneDef.name);
      if (sceneDef.extras) scene2.setExtras(sceneDef.extras);
      (sceneDef.nodes || []).map((nodeIndex) => context.nodes[nodeIndex]).forEach((node) => scene2.addChild(node));
      return scene2;
    });
    if (json.scene !== void 0) document2.getRoot().setDefaultScene(context.scenes[json.scene]);
    document2.getRoot().listExtensionsUsed().forEach((extension) => extension.read(context));
    accessorDefs.forEach((accessorDef, index) => {
      const accessor = context.accessors[index];
      const hasSparseValues = !!accessorDef.sparse;
      const isZeroFilled = !accessorDef.bufferView && !accessor.getArray();
      if (hasSparseValues || isZeroFilled) accessor.setSparse(true).setArray(getSparseArray(accessorDef, context));
    });
    return document2;
  }
  static validate(jsonDoc, options) {
    const json = jsonDoc.json;
    if (json.asset.version !== "2.0") throw new Error(`Unsupported glTF version, "${json.asset.version}".`);
    if (json.extensionsRequired) {
      for (const extensionName of json.extensionsRequired) if (!options.extensions.find((extension) => extension.EXTENSION_NAME === extensionName)) throw new Error(`Missing required extension, "${extensionName}".`);
    }
    if (json.extensionsUsed) {
      for (const extensionName of json.extensionsUsed) if (!options.extensions.find((extension) => extension.EXTENSION_NAME === extensionName)) options.logger.warn(`Missing optional extension, "${extensionName}".`);
    }
  }
};
function getInterleavedArray(accessorDef, context) {
  const jsonDoc = context.jsonDoc;
  const bufferView = context.bufferViews[accessorDef.bufferView];
  const bufferViewDef = jsonDoc.json.bufferViews[accessorDef.bufferView];
  const TypedArray = ComponentTypeToTypedArray[accessorDef.componentType];
  const elementSize = Accessor.getElementSize(accessorDef.type);
  const componentSize = TypedArray.BYTES_PER_ELEMENT;
  const accessorByteOffset = accessorDef.byteOffset || 0;
  const array = new TypedArray(accessorDef.count * elementSize);
  const view = new DataView(bufferView.buffer, bufferView.byteOffset, bufferView.byteLength);
  const byteStride = bufferViewDef.byteStride;
  for (let i = 0; i < accessorDef.count; i++) for (let j = 0; j < elementSize; j++) {
    const byteOffset = accessorByteOffset + i * byteStride + j * componentSize;
    let value;
    switch (accessorDef.componentType) {
      case Accessor.ComponentType.FLOAT:
        value = view.getFloat32(byteOffset, true);
        break;
      case Accessor.ComponentType.UNSIGNED_INT:
        value = view.getUint32(byteOffset, true);
        break;
      case Accessor.ComponentType.UNSIGNED_SHORT:
        value = view.getUint16(byteOffset, true);
        break;
      case Accessor.ComponentType.UNSIGNED_BYTE:
        value = view.getUint8(byteOffset);
        break;
      case Accessor.ComponentType.SHORT:
        value = view.getInt16(byteOffset, true);
        break;
      case Accessor.ComponentType.BYTE:
        value = view.getInt8(byteOffset);
        break;
      case Accessor.ComponentType.FLOAT16:
        value = view.getFloat16(byteOffset, true);
        break;
      case Accessor.ComponentType.FLOAT64:
        value = view.getFloat64(byteOffset, true);
        break;
      default:
        throw new Error(`Unexpected componentType "${accessorDef.componentType}".`);
    }
    array[i * elementSize + j] = value;
  }
  return array;
}
function getAccessorArray(accessorDef, context) {
  const jsonDoc = context.jsonDoc;
  const bufferView = context.bufferViews[accessorDef.bufferView];
  const bufferViewDef = jsonDoc.json.bufferViews[accessorDef.bufferView];
  const TypedArray = ComponentTypeToTypedArray[accessorDef.componentType];
  const elementSize = Accessor.getElementSize(accessorDef.type);
  const componentSize = TypedArray.BYTES_PER_ELEMENT;
  const elementStride = elementSize * componentSize;
  if (bufferViewDef.byteStride !== void 0 && bufferViewDef.byteStride !== elementStride) return getInterleavedArray(accessorDef, context);
  const byteOffset = bufferView.byteOffset + (accessorDef.byteOffset || 0);
  const byteLength = accessorDef.count * elementSize * componentSize;
  return new TypedArray(bufferView.buffer.slice(byteOffset, byteOffset + byteLength));
}
function getSparseArray(accessorDef, context) {
  const TypedArray = ComponentTypeToTypedArray[accessorDef.componentType];
  const elementSize = Accessor.getElementSize(accessorDef.type);
  let array;
  if (accessorDef.bufferView !== void 0) array = getAccessorArray(accessorDef, context);
  else array = new TypedArray(accessorDef.count * elementSize);
  const sparseDef = accessorDef.sparse;
  if (!sparseDef) return array;
  const count = sparseDef.count;
  const indicesDef = {
    ...accessorDef,
    ...sparseDef.indices,
    count,
    type: "SCALAR"
  };
  const valuesDef = {
    ...accessorDef,
    ...sparseDef.values,
    count
  };
  const indices = getAccessorArray(indicesDef, context);
  const values = getAccessorArray(valuesDef, context);
  for (let i = 0; i < indicesDef.count; i++) for (let j = 0; j < elementSize; j++) array[indices[i] * elementSize + j] = values[i * elementSize + j];
  return array;
}
var BufferViewTarget = /* @__PURE__ */ (function(BufferViewTarget2) {
  BufferViewTarget2[BufferViewTarget2["ARRAY_BUFFER"] = 34962] = "ARRAY_BUFFER";
  BufferViewTarget2[BufferViewTarget2["ELEMENT_ARRAY_BUFFER"] = 34963] = "ELEMENT_ARRAY_BUFFER";
  return BufferViewTarget2;
})(BufferViewTarget || {});
var WriterContext = class {
  /** Explicit buffer view targets defined by glTF specification. */
  static BufferViewTarget = BufferViewTarget;
  /**
  * Implicit buffer view usage, not required by glTF specification, but nonetheless useful for
  * proper grouping of accessors into buffer views. Additional usages are defined by extensions,
  * like `EXT_mesh_gpu_instancing`.
  */
  static BufferViewUsage = BufferViewUsage$1;
  /** Maps usage type to buffer view target. Usages not mapped have undefined targets. */
  static USAGE_TO_TARGET = {
    [BufferViewUsage$1.ARRAY_BUFFER]: BufferViewTarget.ARRAY_BUFFER,
    [BufferViewUsage$1.ELEMENT_ARRAY_BUFFER]: BufferViewTarget.ELEMENT_ARRAY_BUFFER
  };
  accessorIndexMap = /* @__PURE__ */ new Map();
  animationIndexMap = /* @__PURE__ */ new Map();
  bufferIndexMap = /* @__PURE__ */ new Map();
  cameraIndexMap = /* @__PURE__ */ new Map();
  skinIndexMap = /* @__PURE__ */ new Map();
  materialIndexMap = /* @__PURE__ */ new Map();
  meshIndexMap = /* @__PURE__ */ new Map();
  nodeIndexMap = /* @__PURE__ */ new Map();
  imageIndexMap = /* @__PURE__ */ new Map();
  textureDefIndexMap = /* @__PURE__ */ new Map();
  textureInfoDefMap = /* @__PURE__ */ new Map();
  samplerDefIndexMap = /* @__PURE__ */ new Map();
  sceneIndexMap = /* @__PURE__ */ new Map();
  imageBufferViews = [];
  otherBufferViews = /* @__PURE__ */ new Map();
  otherBufferViewsIndexMap = /* @__PURE__ */ new Map();
  extensionData = {};
  bufferURIGenerator;
  imageURIGenerator;
  logger;
  _accessorUsageMap = /* @__PURE__ */ new Map();
  accessorUsageGroupedByParent = /* @__PURE__ */ new Set(["ARRAY_BUFFER"]);
  accessorParents = /* @__PURE__ */ new Map();
  constructor(_doc, jsonDoc, options) {
    this._doc = _doc;
    this.jsonDoc = jsonDoc;
    this.options = options;
    const root = _doc.getRoot();
    const numBuffers = root.listBuffers().length;
    const numImages = root.listTextures().length;
    this.bufferURIGenerator = new UniqueURIGenerator(numBuffers > 1, () => options.basename || "buffer");
    this.imageURIGenerator = new UniqueURIGenerator(numImages > 1, (texture) => getSlot(_doc, texture) || options.basename || "texture");
    this.logger = _doc.getLogger();
  }
  /**
  * Creates a TextureInfo definition, and any Texture or Sampler definitions it requires. If
  * possible, Texture and Sampler definitions are shared.
  */
  createTextureInfoDef(texture, textureInfo) {
    const samplerDef = {
      magFilter: textureInfo.getMagFilter() || void 0,
      minFilter: textureInfo.getMinFilter() || void 0,
      wrapS: textureInfo.getWrapS(),
      wrapT: textureInfo.getWrapT()
    };
    const samplerKey = JSON.stringify(samplerDef);
    if (!this.samplerDefIndexMap.has(samplerKey)) {
      this.samplerDefIndexMap.set(samplerKey, this.jsonDoc.json.samplers.length);
      this.jsonDoc.json.samplers.push(samplerDef);
    }
    const textureDef = {
      source: this.imageIndexMap.get(texture),
      sampler: this.samplerDefIndexMap.get(samplerKey)
    };
    const textureKey = JSON.stringify(textureDef);
    if (!this.textureDefIndexMap.has(textureKey)) {
      this.textureDefIndexMap.set(textureKey, this.jsonDoc.json.textures.length);
      this.jsonDoc.json.textures.push(textureDef);
    }
    const textureInfoDef = { index: this.textureDefIndexMap.get(textureKey) };
    if (textureInfo.getTexCoord() !== 0) textureInfoDef.texCoord = textureInfo.getTexCoord();
    if (Object.keys(textureInfo.getExtras()).length > 0) textureInfoDef.extras = textureInfo.getExtras();
    this.textureInfoDefMap.set(textureInfo, textureInfoDef);
    return textureInfoDef;
  }
  createPropertyDef(property) {
    const def = {};
    if (property.getName()) def.name = property.getName();
    if (Object.keys(property.getExtras()).length > 0) def.extras = property.getExtras();
    return def;
  }
  createAccessorDef(accessor) {
    const accessorDef = this.createPropertyDef(accessor);
    accessorDef.type = accessor.getType();
    accessorDef.componentType = accessor.getComponentType();
    accessorDef.count = accessor.getCount();
    if (this._doc.getGraph().listParentEdges(accessor).some((edge) => edge.getName() === "attributes" && edge.getAttributes().key === "POSITION" || edge.getName() === "input")) {
      accessorDef.max = accessor.getMax([]).map(Math.fround);
      accessorDef.min = accessor.getMin([]).map(Math.fround);
    }
    if (accessor.getNormalized()) accessorDef.normalized = accessor.getNormalized();
    return accessorDef;
  }
  createImageData(imageDef, data, texture) {
    if (this.options.format === Format.GLB) {
      this.imageBufferViews.push(data);
      imageDef.bufferView = this.jsonDoc.json.bufferViews.length;
      this.jsonDoc.json.bufferViews.push({
        buffer: 0,
        byteOffset: -1,
        byteLength: data.byteLength
      });
    } else {
      const extension = ImageUtils.mimeTypeToExtension(texture.getMimeType());
      imageDef.uri = this.imageURIGenerator.createURI(texture, extension);
      this.assignResourceURI(imageDef.uri, data, false);
    }
  }
  assignResourceURI(uri, data, throwOnConflict) {
    const resources = this.jsonDoc.resources;
    if (!(uri in resources)) {
      resources[uri] = data;
      return;
    }
    if (data === resources[uri]) {
      this.logger.warn(`Duplicate resource URI, "${uri}".`);
      return;
    }
    const conflictMessage = `Resource URI "${uri}" already assigned to different data.`;
    if (!throwOnConflict) {
      this.logger.warn(conflictMessage);
      return;
    }
    throw new Error(conflictMessage);
  }
  /**
  * Returns implicit usage type of the given accessor, related to grouping accessors into
  * buffer views. Usage is a superset of buffer view target, including ARRAY_BUFFER and
  * ELEMENT_ARRAY_BUFFER, but also usages that do not match GPU buffer view targets such as
  * IBMs. Additional usages are defined by extensions, like `EXT_mesh_gpu_instancing`.
  */
  getAccessorUsage(accessor) {
    const cachedUsage = this._accessorUsageMap.get(accessor);
    if (cachedUsage) return cachedUsage;
    if (accessor.getSparse()) return BufferViewUsage$1.SPARSE;
    for (const edge of this._doc.getGraph().listParentEdges(accessor)) {
      const { usage } = edge.getAttributes();
      if (usage) return usage;
      if (edge.getParent().propertyType !== PropertyType.ROOT) this.logger.warn(`Missing attribute ".usage" on edge, "${edge.getName()}".`);
    }
    return BufferViewUsage$1.OTHER;
  }
  /**
  * Sets usage for the given accessor. Some accessor types must be grouped into
  * buffer views with like accessors. This includes the specified buffer view "targets", but
  * also implicit usage like IBMs or instanced mesh attributes. If unspecified, an accessor
  * will be grouped with other accessors of unspecified usage.
  */
  addAccessorToUsageGroup(accessor, usage) {
    const prevUsage = this._accessorUsageMap.get(accessor);
    if (prevUsage && prevUsage !== usage) throw new Error(`Accessor with usage "${prevUsage}" cannot be reused as "${usage}".`);
    this._accessorUsageMap.set(accessor, usage);
    return this;
  }
};
var UniqueURIGenerator = class {
  counter = {};
  constructor(multiple, basename) {
    this.multiple = multiple;
    this.basename = basename;
  }
  createURI(object, extension) {
    if (object.getURI()) return object.getURI();
    else if (!this.multiple) return `${this.basename(object)}.${extension}`;
    else {
      const basename = this.basename(object);
      this.counter[basename] = this.counter[basename] || 1;
      return `${basename}_${this.counter[basename]++}.${extension}`;
    }
  }
};
function getSlot(document2, texture) {
  const edge = document2.getGraph().listParentEdges(texture).find((edge2) => edge2.getParent() !== document2.getRoot());
  return edge ? edge.getName().replace(/texture$/i, "") : "";
}
var { BufferViewUsage } = WriterContext;
var { UNSIGNED_INT, UNSIGNED_SHORT, UNSIGNED_BYTE } = Accessor.ComponentType;
var SUPPORTED_PREWRITE_TYPES = /* @__PURE__ */ new Set([
  PropertyType.ACCESSOR,
  PropertyType.BUFFER,
  PropertyType.MATERIAL,
  PropertyType.MESH
]);
var GLTFWriter = class {
  static write(doc, options) {
    const graph = doc.getGraph();
    const root = doc.getRoot();
    const json = {
      asset: {
        generator: `glTF-Transform ${VERSION}`,
        ...root.getAsset()
      },
      extras: { ...root.getExtras() }
    };
    const jsonDoc = {
      json,
      resources: {}
    };
    const context = new WriterContext(doc, jsonDoc, options);
    const logger = options.logger || Logger.DEFAULT_INSTANCE;
    const extensionsRegistered = new Set(options.extensions.map((ext) => ext.EXTENSION_NAME));
    const extensionsUsed = doc.getRoot().listExtensionsUsed().filter((ext) => extensionsRegistered.has(ext.extensionName)).sort((a, b) => a.extensionName > b.extensionName ? 1 : -1);
    const extensionsRequired = doc.getRoot().listExtensionsRequired().filter((ext) => extensionsRegistered.has(ext.extensionName)).sort((a, b) => a.extensionName > b.extensionName ? 1 : -1);
    if (extensionsUsed.length < doc.getRoot().listExtensionsUsed().length) logger.warn("Some extensions were not registered for I/O, and will not be written.");
    for (const extension of extensionsUsed) {
      const unsupportedHooks = extension.prewriteTypes.filter((type) => !SUPPORTED_PREWRITE_TYPES.has(type));
      if (unsupportedHooks.length) logger.warn(`Prewrite hooks for some types (${unsupportedHooks.join()}), requested by extension ${extension.extensionName}, are unsupported. Please file an issue or a PR.`);
      for (const key of extension.writeDependencies) extension.install(key, options.dependencies[key]);
    }
    function concatAccessors(accessors, bufferIndex, bufferByteOffset, bufferViewTarget) {
      const buffers = [];
      let byteLength = 0;
      for (const accessor of accessors) {
        const accessorDef = context.createAccessorDef(accessor);
        accessorDef.bufferView = json.bufferViews.length;
        const accessorArray = accessor.getArray();
        const data = BufferUtils.pad(BufferUtils.toView(accessorArray));
        accessorDef.byteOffset = byteLength;
        byteLength += data.byteLength;
        buffers.push(data);
        context.accessorIndexMap.set(accessor, json.accessors.length);
        json.accessors.push(accessorDef);
      }
      const bufferViewDef = {
        buffer: bufferIndex,
        byteOffset: bufferByteOffset,
        byteLength: BufferUtils.concat(buffers).byteLength
      };
      if (bufferViewTarget) bufferViewDef.target = bufferViewTarget;
      json.bufferViews.push(bufferViewDef);
      return {
        buffers,
        byteLength
      };
    }
    function interleaveAccessors(accessors, bufferIndex, bufferByteOffset) {
      const vertexCount = accessors[0].getCount();
      let byteStride = 0;
      for (const accessor of accessors) {
        const accessorDef = context.createAccessorDef(accessor);
        accessorDef.bufferView = json.bufferViews.length;
        accessorDef.byteOffset = byteStride;
        const elementSize = accessor.getElementSize();
        const componentSize = accessor.getComponentSize();
        byteStride += BufferUtils.padNumber(elementSize * componentSize);
        context.accessorIndexMap.set(accessor, json.accessors.length);
        json.accessors.push(accessorDef);
      }
      const byteLength = vertexCount * byteStride;
      const buffer = new ArrayBuffer(byteLength);
      const view = new DataView(buffer);
      for (let i = 0; i < vertexCount; i++) {
        let vertexByteOffset = 0;
        for (const accessor of accessors) {
          const elementSize = accessor.getElementSize();
          const componentSize = accessor.getComponentSize();
          const componentType = accessor.getComponentType();
          const array = accessor.getArray();
          for (let j = 0; j < elementSize; j++) {
            const viewByteOffset = i * byteStride + vertexByteOffset + j * componentSize;
            const value = array[i * elementSize + j];
            switch (componentType) {
              case Accessor.ComponentType.FLOAT:
                view.setFloat32(viewByteOffset, value, true);
                break;
              case Accessor.ComponentType.BYTE:
                view.setInt8(viewByteOffset, value);
                break;
              case Accessor.ComponentType.SHORT:
                view.setInt16(viewByteOffset, value, true);
                break;
              case Accessor.ComponentType.UNSIGNED_BYTE:
                view.setUint8(viewByteOffset, value);
                break;
              case Accessor.ComponentType.UNSIGNED_SHORT:
                view.setUint16(viewByteOffset, value, true);
                break;
              case Accessor.ComponentType.UNSIGNED_INT:
                view.setUint32(viewByteOffset, value, true);
                break;
              case Accessor.ComponentType.FLOAT16:
                view.setFloat16(viewByteOffset, value, true);
                break;
              case Accessor.ComponentType.FLOAT64:
                view.setFloat64(viewByteOffset, value, true);
                break;
              default:
                throw new Error("Unexpected component type: " + componentType);
            }
          }
          vertexByteOffset += BufferUtils.padNumber(elementSize * componentSize);
        }
      }
      const bufferViewDef = {
        buffer: bufferIndex,
        byteOffset: bufferByteOffset,
        byteLength,
        byteStride,
        target: WriterContext.BufferViewTarget.ARRAY_BUFFER
      };
      json.bufferViews.push(bufferViewDef);
      return {
        byteLength,
        buffers: [new Uint8Array(buffer)]
      };
    }
    function concatSparseAccessors(accessors, bufferIndex, bufferByteOffset) {
      const buffers = [];
      let byteLength = 0;
      const sparseData = /* @__PURE__ */ new Map();
      let maxIndex = -Infinity;
      let needSparseWarning = false;
      for (const accessor of accessors) {
        const accessorDef = context.createAccessorDef(accessor);
        json.accessors.push(accessorDef);
        context.accessorIndexMap.set(accessor, json.accessors.length - 1);
        const indices = [];
        const values = [];
        const el = [];
        const base = new Array(accessor.getElementSize()).fill(0);
        for (let i = 0, il = accessor.getCount(); i < il; i++) {
          accessor.getElement(i, el);
          if (MathUtils.eq(el, base, 0)) continue;
          maxIndex = Math.max(i, maxIndex);
          indices.push(i);
          for (let j = 0; j < el.length; j++) values.push(el[j]);
        }
        const count = indices.length;
        const data = {
          accessorDef,
          count
        };
        sparseData.set(accessor, data);
        if (count === 0) continue;
        if (count > accessor.getCount() / 2) needSparseWarning = true;
        const ValueArray = ComponentTypeToTypedArray[accessor.getComponentType()];
        data.indices = indices;
        data.values = new ValueArray(values);
      }
      if (!Number.isFinite(maxIndex)) return {
        buffers,
        byteLength
      };
      if (needSparseWarning) logger.warn(`Some sparse accessors have >50% non-zero elements, which may increase file size.`);
      const IndexArray = maxIndex < 255 ? Uint8Array : maxIndex < 65535 ? Uint16Array : Uint32Array;
      const IndexComponentType = maxIndex < 255 ? UNSIGNED_BYTE : maxIndex < 65535 ? UNSIGNED_SHORT : UNSIGNED_INT;
      const indicesBufferViewDef = {
        buffer: bufferIndex,
        byteOffset: bufferByteOffset + byteLength,
        byteLength: 0
      };
      for (const accessor of accessors) {
        const data = sparseData.get(accessor);
        if (data.count === 0) continue;
        data.indicesByteOffset = indicesBufferViewDef.byteLength;
        const buffer = BufferUtils.pad(BufferUtils.toView(new IndexArray(data.indices)));
        buffers.push(buffer);
        byteLength += buffer.byteLength;
        indicesBufferViewDef.byteLength += buffer.byteLength;
      }
      json.bufferViews.push(indicesBufferViewDef);
      const indicesBufferViewIndex = json.bufferViews.length - 1;
      const valuesBufferViewDef = {
        buffer: bufferIndex,
        byteOffset: bufferByteOffset + byteLength,
        byteLength: 0
      };
      for (const accessor of accessors) {
        const data = sparseData.get(accessor);
        if (data.count === 0) continue;
        data.valuesByteOffset = valuesBufferViewDef.byteLength;
        const buffer = BufferUtils.pad(BufferUtils.toView(data.values));
        buffers.push(buffer);
        byteLength += buffer.byteLength;
        valuesBufferViewDef.byteLength += buffer.byteLength;
      }
      json.bufferViews.push(valuesBufferViewDef);
      const valuesBufferViewIndex = json.bufferViews.length - 1;
      for (const accessor of accessors) {
        const data = sparseData.get(accessor);
        if (data.count === 0) continue;
        data.accessorDef.sparse = {
          count: data.count,
          indices: {
            bufferView: indicesBufferViewIndex,
            byteOffset: data.indicesByteOffset,
            componentType: IndexComponentType
          },
          values: {
            bufferView: valuesBufferViewIndex,
            byteOffset: data.valuesByteOffset
          }
        };
      }
      return {
        buffers,
        byteLength
      };
    }
    json.accessors = [];
    json.bufferViews = [];
    json.samplers = [];
    json.textures = [];
    json.images = root.listTextures().map((texture, textureIndex) => {
      const imageDef = context.createPropertyDef(texture);
      if (texture.getMimeType()) imageDef.mimeType = texture.getMimeType();
      const image = texture.getImage();
      if (image) context.createImageData(imageDef, image, texture);
      context.imageIndexMap.set(texture, textureIndex);
      return imageDef;
    });
    extensionsUsed.filter((extension) => extension.prewriteTypes.includes(PropertyType.ACCESSOR)).forEach((extension) => extension.prewrite(context, PropertyType.ACCESSOR));
    root.listAccessors().forEach((accessor) => {
      const groupByParent = context.accessorUsageGroupedByParent;
      const accessorParents = context.accessorParents;
      if (context.accessorIndexMap.has(accessor)) return;
      const usage = context.getAccessorUsage(accessor);
      context.addAccessorToUsageGroup(accessor, usage);
      if (groupByParent.has(usage)) {
        const parent = graph.listParents(accessor).find((parent2) => parent2.propertyType !== PropertyType.ROOT);
        accessorParents.set(accessor, parent);
      }
    });
    extensionsUsed.filter((extension) => extension.prewriteTypes.includes(PropertyType.BUFFER)).forEach((extension) => extension.prewrite(context, PropertyType.BUFFER));
    if ((root.listAccessors().length > 0 || context.otherBufferViews.size > 0 || root.listTextures().length > 0 && options.format === Format.GLB) && root.listBuffers().length === 0) throw new Error("Buffer required for Document resources, but none was found.");
    json.buffers = [];
    root.listBuffers().forEach((buffer, index) => {
      const bufferDef = context.createPropertyDef(buffer);
      const groupByParent = context.accessorUsageGroupedByParent;
      const accessors = buffer.listParents().filter((property) => property instanceof Accessor);
      const uniqueParents = new Set(accessors.map((accessor) => context.accessorParents.get(accessor)));
      const parentToIndex = new Map(Array.from(uniqueParents).map((parent, index2) => [parent, index2]));
      const accessorGroups = {};
      for (const accessor of accessors) {
        if (context.accessorIndexMap.has(accessor)) continue;
        const usage = context.getAccessorUsage(accessor);
        let key = usage;
        if (groupByParent.has(usage)) {
          const parent = context.accessorParents.get(accessor);
          key += `:${parentToIndex.get(parent)}`;
        }
        accessorGroups[key] ||= {
          usage,
          accessors: []
        };
        accessorGroups[key].accessors.push(accessor);
      }
      const buffers = [];
      const bufferIndex = json.buffers.length;
      let bufferByteLength = 0;
      for (const { usage, accessors: groupAccessors } of Object.values(accessorGroups)) if (usage === BufferViewUsage.ARRAY_BUFFER && options.vertexLayout === VertexLayout.INTERLEAVED) {
        const result = interleaveAccessors(groupAccessors, bufferIndex, bufferByteLength);
        bufferByteLength += result.byteLength;
        for (const buffer2 of result.buffers) buffers.push(buffer2);
      } else if (usage === BufferViewUsage.ARRAY_BUFFER) for (const accessor of groupAccessors) {
        const result = interleaveAccessors([accessor], bufferIndex, bufferByteLength);
        bufferByteLength += result.byteLength;
        for (const buffer2 of result.buffers) buffers.push(buffer2);
      }
      else if (usage === BufferViewUsage.SPARSE) {
        const result = concatSparseAccessors(groupAccessors, bufferIndex, bufferByteLength);
        bufferByteLength += result.byteLength;
        for (const buffer2 of result.buffers) buffers.push(buffer2);
      } else if (usage === BufferViewUsage.ELEMENT_ARRAY_BUFFER) {
        const target = WriterContext.BufferViewTarget.ELEMENT_ARRAY_BUFFER;
        const result = concatAccessors(groupAccessors, bufferIndex, bufferByteLength, target);
        bufferByteLength += result.byteLength;
        for (const buffer2 of result.buffers) buffers.push(buffer2);
      } else {
        const result = concatAccessors(groupAccessors, bufferIndex, bufferByteLength);
        bufferByteLength += result.byteLength;
        for (const buffer2 of result.buffers) buffers.push(buffer2);
      }
      if (context.imageBufferViews.length && index === 0) for (let i = 0; i < context.imageBufferViews.length; i++) {
        json.bufferViews[json.images[i].bufferView].byteOffset = bufferByteLength;
        bufferByteLength += context.imageBufferViews[i].byteLength;
        buffers.push(context.imageBufferViews[i]);
        if (bufferByteLength % 8) {
          const imagePadding = 8 - bufferByteLength % 8;
          bufferByteLength += imagePadding;
          buffers.push(new Uint8Array(imagePadding));
        }
      }
      if (context.otherBufferViews.has(buffer)) for (const data of context.otherBufferViews.get(buffer)) {
        json.bufferViews.push({
          buffer: bufferIndex,
          byteOffset: bufferByteLength,
          byteLength: data.byteLength
        });
        context.otherBufferViewsIndexMap.set(data, json.bufferViews.length - 1);
        bufferByteLength += data.byteLength;
        buffers.push(data);
      }
      if (bufferByteLength) {
        let uri;
        if (options.format === Format.GLB) uri = GLB_BUFFER;
        else {
          uri = context.bufferURIGenerator.createURI(buffer, "bin");
          bufferDef.uri = uri;
        }
        bufferDef.byteLength = bufferByteLength;
        context.assignResourceURI(uri, BufferUtils.concat(buffers), true);
      }
      json.buffers.push(bufferDef);
      context.bufferIndexMap.set(buffer, index);
    });
    if (root.listAccessors().find((a) => !a.getBuffer())) logger.warn("Skipped writing one or more Accessors: no Buffer assigned.");
    extensionsUsed.filter((extension) => extension.prewriteTypes.includes(PropertyType.MATERIAL)).forEach((extension) => extension.prewrite(context, PropertyType.MATERIAL));
    json.materials = root.listMaterials().map((material, index) => {
      const materialDef = context.createPropertyDef(material);
      if (material.getAlphaMode() !== Material.AlphaMode.OPAQUE) materialDef.alphaMode = material.getAlphaMode();
      if (material.getAlphaMode() === Material.AlphaMode.MASK) materialDef.alphaCutoff = material.getAlphaCutoff();
      if (material.getDoubleSided()) materialDef.doubleSided = true;
      materialDef.pbrMetallicRoughness = {};
      if (!MathUtils.eq(material.getBaseColorFactor(), [
        1,
        1,
        1,
        1
      ])) materialDef.pbrMetallicRoughness.baseColorFactor = material.getBaseColorFactor();
      if (!MathUtils.eq(material.getEmissiveFactor(), [
        0,
        0,
        0
      ])) materialDef.emissiveFactor = material.getEmissiveFactor();
      if (material.getRoughnessFactor() !== 1) materialDef.pbrMetallicRoughness.roughnessFactor = material.getRoughnessFactor();
      if (material.getMetallicFactor() !== 1) materialDef.pbrMetallicRoughness.metallicFactor = material.getMetallicFactor();
      if (material.getBaseColorTexture()) {
        const texture = material.getBaseColorTexture();
        const textureInfo = material.getBaseColorTextureInfo();
        materialDef.pbrMetallicRoughness.baseColorTexture = context.createTextureInfoDef(texture, textureInfo);
      }
      if (material.getEmissiveTexture()) {
        const texture = material.getEmissiveTexture();
        const textureInfo = material.getEmissiveTextureInfo();
        materialDef.emissiveTexture = context.createTextureInfoDef(texture, textureInfo);
      }
      if (material.getNormalTexture()) {
        const texture = material.getNormalTexture();
        const textureInfo = material.getNormalTextureInfo();
        const textureInfoDef = context.createTextureInfoDef(texture, textureInfo);
        if (material.getNormalScale() !== 1) textureInfoDef.scale = material.getNormalScale();
        materialDef.normalTexture = textureInfoDef;
      }
      if (material.getOcclusionTexture()) {
        const texture = material.getOcclusionTexture();
        const textureInfo = material.getOcclusionTextureInfo();
        const textureInfoDef = context.createTextureInfoDef(texture, textureInfo);
        if (material.getOcclusionStrength() !== 1) textureInfoDef.strength = material.getOcclusionStrength();
        materialDef.occlusionTexture = textureInfoDef;
      }
      if (material.getMetallicRoughnessTexture()) {
        const texture = material.getMetallicRoughnessTexture();
        const textureInfo = material.getMetallicRoughnessTextureInfo();
        materialDef.pbrMetallicRoughness.metallicRoughnessTexture = context.createTextureInfoDef(texture, textureInfo);
      }
      context.materialIndexMap.set(material, index);
      return materialDef;
    });
    extensionsUsed.filter((extension) => extension.prewriteTypes.includes(PropertyType.MESH)).forEach((extension) => extension.prewrite(context, PropertyType.MESH));
    json.meshes = root.listMeshes().map((mesh, index) => {
      const meshDef = context.createPropertyDef(mesh);
      let targetNames = null;
      meshDef.primitives = mesh.listPrimitives().map((primitive) => {
        const primitiveDef = { attributes: {} };
        primitiveDef.mode = primitive.getMode();
        const material = primitive.getMaterial();
        if (material) primitiveDef.material = context.materialIndexMap.get(material);
        if (Object.keys(primitive.getExtras()).length) primitiveDef.extras = primitive.getExtras();
        const indices = primitive.getIndices();
        if (indices) primitiveDef.indices = context.accessorIndexMap.get(indices);
        for (const semantic of primitive.listSemantics()) primitiveDef.attributes[semantic] = context.accessorIndexMap.get(primitive.getAttribute(semantic));
        for (const target of primitive.listTargets()) {
          const targetDef = {};
          for (const semantic of target.listSemantics()) targetDef[semantic] = context.accessorIndexMap.get(target.getAttribute(semantic));
          primitiveDef.targets = primitiveDef.targets || [];
          primitiveDef.targets.push(targetDef);
        }
        if (primitive.listTargets().length && !targetNames) targetNames = primitive.listTargets().map((target) => target.getName());
        return primitiveDef;
      });
      if (mesh.getWeights().length) meshDef.weights = mesh.getWeights();
      if (targetNames) {
        meshDef.extras = meshDef.extras || {};
        meshDef.extras["targetNames"] = targetNames;
      }
      context.meshIndexMap.set(mesh, index);
      return meshDef;
    });
    json.cameras = root.listCameras().map((camera2, index) => {
      const cameraDef = context.createPropertyDef(camera2);
      cameraDef.type = camera2.getType();
      if (cameraDef.type === Camera.Type.PERSPECTIVE) {
        cameraDef.perspective = {
          znear: camera2.getZNear(),
          zfar: camera2.getZFar(),
          yfov: camera2.getYFov()
        };
        const aspectRatio = camera2.getAspectRatio();
        if (aspectRatio !== null) cameraDef.perspective.aspectRatio = aspectRatio;
      } else cameraDef.orthographic = {
        znear: camera2.getZNear(),
        zfar: camera2.getZFar(),
        xmag: camera2.getXMag(),
        ymag: camera2.getYMag()
      };
      context.cameraIndexMap.set(camera2, index);
      return cameraDef;
    });
    json.nodes = root.listNodes().map((node, index) => {
      const nodeDef = context.createPropertyDef(node);
      if (!MathUtils.eq(node.getTranslation(), [
        0,
        0,
        0
      ])) nodeDef.translation = node.getTranslation();
      if (!MathUtils.eq(node.getRotation(), [
        0,
        0,
        0,
        1
      ])) nodeDef.rotation = node.getRotation();
      if (!MathUtils.eq(node.getScale(), [
        1,
        1,
        1
      ])) nodeDef.scale = node.getScale();
      if (node.getWeights().length) nodeDef.weights = node.getWeights();
      context.nodeIndexMap.set(node, index);
      return nodeDef;
    });
    json.skins = root.listSkins().map((skin, index) => {
      const skinDef = context.createPropertyDef(skin);
      const inverseBindMatrices = skin.getInverseBindMatrices();
      if (inverseBindMatrices) skinDef.inverseBindMatrices = context.accessorIndexMap.get(inverseBindMatrices);
      const skeleton = skin.getSkeleton();
      if (skeleton) skinDef.skeleton = context.nodeIndexMap.get(skeleton);
      skinDef.joints = skin.listJoints().map((joint) => context.nodeIndexMap.get(joint));
      context.skinIndexMap.set(skin, index);
      return skinDef;
    });
    root.listNodes().forEach((node, index) => {
      const nodeDef = json.nodes[index];
      const mesh = node.getMesh();
      if (mesh) nodeDef.mesh = context.meshIndexMap.get(mesh);
      const camera2 = node.getCamera();
      if (camera2) nodeDef.camera = context.cameraIndexMap.get(camera2);
      const skin = node.getSkin();
      if (skin) nodeDef.skin = context.skinIndexMap.get(skin);
      if (node.listChildren().length > 0) nodeDef.children = node.listChildren().map((node2) => context.nodeIndexMap.get(node2));
    });
    json.animations = root.listAnimations().map((animation, index) => {
      const animationDef = context.createPropertyDef(animation);
      const samplerIndexMap = /* @__PURE__ */ new Map();
      animationDef.samplers = animation.listSamplers().map((sampler, samplerIndex) => {
        const samplerDef = context.createPropertyDef(sampler);
        samplerDef.input = context.accessorIndexMap.get(sampler.getInput());
        samplerDef.output = context.accessorIndexMap.get(sampler.getOutput());
        samplerDef.interpolation = sampler.getInterpolation();
        samplerIndexMap.set(sampler, samplerIndex);
        return samplerDef;
      });
      animationDef.channels = animation.listChannels().map((channel) => {
        const channelDef = context.createPropertyDef(channel);
        channelDef.sampler = samplerIndexMap.get(channel.getSampler());
        channelDef.target = {
          node: context.nodeIndexMap.get(channel.getTargetNode()),
          path: channel.getTargetPath()
        };
        return channelDef;
      });
      context.animationIndexMap.set(animation, index);
      return animationDef;
    });
    json.scenes = root.listScenes().map((scene2, index) => {
      const sceneDef = context.createPropertyDef(scene2);
      sceneDef.nodes = scene2.listChildren().map((node) => context.nodeIndexMap.get(node));
      context.sceneIndexMap.set(scene2, index);
      return sceneDef;
    });
    const defaultScene = root.getDefaultScene();
    if (defaultScene) json.scene = root.listScenes().indexOf(defaultScene);
    json.extensionsUsed = extensionsUsed.map((ext) => ext.extensionName);
    json.extensionsRequired = extensionsRequired.map((ext) => ext.extensionName);
    extensionsUsed.forEach((extension) => extension.write(context));
    clean(json);
    return jsonDoc;
  }
};
function clean(object) {
  const unused = [];
  for (const key in object) {
    const value = object[key];
    if (Array.isArray(value) && value.length === 0) unused.push(key);
    else if (value === null || value === "") unused.push(key);
    else if (value && typeof value === "object" && Object.keys(value).length === 0) unused.push(key);
  }
  for (const key of unused) delete object[key];
}
var ChunkType = /* @__PURE__ */ (function(ChunkType2) {
  ChunkType2[ChunkType2["JSON"] = 1313821514] = "JSON";
  ChunkType2[ChunkType2["BIN"] = 5130562] = "BIN";
  return ChunkType2;
})(ChunkType || {});
var PlatformIO = class {
  _logger = Logger.DEFAULT_INSTANCE;
  _extensions = /* @__PURE__ */ new Set();
  _dependencies = {};
  _vertexLayout = VertexLayout.INTERLEAVED;
  _strictResources = true;
  /** @hidden */
  lastReadBytes = 0;
  /** @hidden */
  lastWriteBytes = 0;
  /** Sets the {@link Logger} used by this I/O instance. Defaults to Logger.DEFAULT_INSTANCE. */
  setLogger(logger) {
    this._logger = logger;
    return this;
  }
  /** Registers extensions, enabling I/O class to read and write glTF assets requiring them. */
  registerExtensions(extensions) {
    for (const extension of extensions) {
      this._extensions.add(extension);
      extension.register();
    }
    return this;
  }
  /** Registers dependencies used (e.g. by extensions) in the I/O process. */
  registerDependencies(dependencies) {
    Object.assign(this._dependencies, dependencies);
    return this;
  }
  /**
  * Sets the vertex layout method used by this I/O instance. Defaults to
  * VertexLayout.INTERLEAVED.
  */
  setVertexLayout(layout) {
    this._vertexLayout = layout;
    return this;
  }
  /**
  * Sets whether missing external resources should throw errors (strict mode) or
  * be ignored with warnings. Missing images can be ignored, but missing buffers
  * will currently always result in an error. When strict mode is disabled and
  * missing resources are encountered, the resulting {@link Document} will be
  * created in an invalid state. Manual fixes to the Document may be necessary,
  * resolving null images in {@link Texture Textures} or removing the affected
  * Textures, before the Document can be written to output or used in transforms.
  *
  * Defaults to true (strict mode).
  */
  setStrictResources(strict) {
    this._strictResources = strict;
    return this;
  }
  /**********************************************************************************************
  * Public Read API.
  */
  /** Reads a {@link Document} from the given URI. */
  async read(uri) {
    return await this.readJSON(await this.readAsJSON(uri));
  }
  /** Loads a URI and returns a {@link JSONDocument} struct, without parsing. */
  async readAsJSON(uri) {
    const view = await this.readURI(uri, "view");
    this.lastReadBytes = view.byteLength;
    const jsonDoc = isGLB(view) ? this._binaryToJSON(view) : {
      json: JSON.parse(BufferUtils.decodeText(view)),
      resources: {}
    };
    await this._readResourcesExternal(jsonDoc, this.dirname(uri));
    this._readResourcesInternal(jsonDoc);
    return jsonDoc;
  }
  /** Converts glTF-formatted JSON and a resource map to a {@link Document}. */
  async readJSON(jsonDoc) {
    jsonDoc = this._copyJSON(jsonDoc);
    this._readResourcesInternal(jsonDoc);
    return GLTFReader.read(jsonDoc, {
      extensions: Array.from(this._extensions),
      dependencies: this._dependencies,
      logger: this._logger
    });
  }
  /** Converts a GLB-formatted Uint8Array to a {@link JSONDocument}. */
  async binaryToJSON(glb) {
    const jsonDoc = this._binaryToJSON(BufferUtils.assertView(glb));
    this._readResourcesInternal(jsonDoc);
    const json = jsonDoc.json;
    if (json.buffers && json.buffers.some((bufferDef) => isExternalBuffer(jsonDoc, bufferDef))) throw new Error("Cannot resolve external buffers with binaryToJSON().");
    else if (json.images && json.images.some((imageDef) => isExternalImage(jsonDoc, imageDef))) throw new Error("Cannot resolve external images with binaryToJSON().");
    return jsonDoc;
  }
  /** Converts a GLB-formatted Uint8Array to a {@link Document}. */
  async readBinary(glb) {
    return this.readJSON(await this.binaryToJSON(BufferUtils.assertView(glb)));
  }
  /**********************************************************************************************
  * Public Write API.
  */
  /** Converts a {@link Document} to glTF-formatted JSON and a resource map. */
  async writeJSON(doc, _options = {}) {
    if (_options.format === Format.GLB && doc.getRoot().listBuffers().length > 1) throw new Error("GLB must have 0\u20131 buffers.");
    return GLTFWriter.write(doc, {
      format: _options.format || Format.GLTF,
      basename: _options.basename || "",
      logger: this._logger,
      vertexLayout: this._vertexLayout,
      dependencies: { ...this._dependencies },
      extensions: Array.from(this._extensions)
    });
  }
  /** Converts a {@link Document} to a GLB-formatted Uint8Array. */
  async writeBinary(doc) {
    const { json, resources } = await this.writeJSON(doc, { format: Format.GLB });
    const header = new Uint32Array([
      1179937895,
      2,
      12
    ]);
    const jsonText = JSON.stringify(json);
    const jsonChunkData = BufferUtils.pad(BufferUtils.encodeText(jsonText), 32);
    const jsonChunkHeader = BufferUtils.toView(new Uint32Array([jsonChunkData.byteLength, 1313821514]));
    const jsonChunk = BufferUtils.concat([jsonChunkHeader, jsonChunkData]);
    header[header.length - 1] += jsonChunk.byteLength;
    const binBuffer = Object.values(resources)[0];
    if (!binBuffer || !binBuffer.byteLength) return BufferUtils.concat([BufferUtils.toView(header), jsonChunk]);
    const binChunkData = BufferUtils.pad(binBuffer, 0);
    const binChunkHeader = BufferUtils.toView(new Uint32Array([binChunkData.byteLength, 5130562]));
    const binChunk = BufferUtils.concat([binChunkHeader, binChunkData]);
    header[header.length - 1] += binChunk.byteLength;
    return BufferUtils.concat([
      BufferUtils.toView(header),
      jsonChunk,
      binChunk
    ]);
  }
  /**********************************************************************************************
  * Internal.
  */
  async _readResourcesExternal(jsonDoc, base) {
    const images = jsonDoc.json.images || [];
    const buffers = jsonDoc.json.buffers || [];
    const pendingResources = [...images, ...buffers].map(async (resource) => {
      const uri = resource.uri;
      if (!uri || uri.match(/data:/)) return Promise.resolve();
      try {
        jsonDoc.resources[uri] = await this.readURI(this.resolve(base, uri), "view");
        this.lastReadBytes += jsonDoc.resources[uri].byteLength;
      } catch (error) {
        if (!this._strictResources && images.includes(resource)) {
          this._logger.warn(`Failed to load image URI, "${uri}". ${error}`);
          jsonDoc.resources[uri] = null;
        } else throw error;
      }
    });
    await Promise.all(pendingResources);
  }
  _readResourcesInternal(jsonDoc) {
    function resolveResource(resource) {
      if (!resource.uri) return;
      if (resource.uri in jsonDoc.resources) {
        BufferUtils.assertView(jsonDoc.resources[resource.uri]);
        return;
      }
      if (resource.uri.match(/data:/)) {
        const resourceUUID = `__${uuid()}.${FileUtils.extension(resource.uri)}`;
        jsonDoc.resources[resourceUUID] = BufferUtils.createBufferFromDataURI(resource.uri);
        resource.uri = resourceUUID;
      }
    }
    (jsonDoc.json.images || []).forEach((image) => {
      if (image.bufferView === void 0 && image.uri === void 0) throw new Error("Missing resource URI or buffer view.");
      resolveResource(image);
    });
    (jsonDoc.json.buffers || []).forEach(resolveResource);
  }
  /**
  * Creates a shallow copy of glTF-formatted {@link JSONDocument}.
  *
  * Images, Buffers, and Resources objects are deep copies so that PlatformIO can safely
  * modify them during the parsing process. Other properties are shallow copies, and buffers
  * are passed by reference.
  */
  _copyJSON(jsonDoc) {
    const { images, buffers } = jsonDoc.json;
    jsonDoc = {
      json: { ...jsonDoc.json },
      resources: { ...jsonDoc.resources }
    };
    if (images) jsonDoc.json.images = images.map((image) => ({ ...image }));
    if (buffers) jsonDoc.json.buffers = buffers.map((buffer) => ({ ...buffer }));
    return jsonDoc;
  }
  /** Internal version of binaryToJSON; does not warn about external resources. */
  _binaryToJSON(glb) {
    if (!isGLB(glb)) throw new Error("Invalid glTF 2.0 binary.");
    const jsonChunkHeader = new Uint32Array(glb.buffer, glb.byteOffset + 12, 2);
    if (jsonChunkHeader[1] !== ChunkType.JSON) throw new Error("Missing required GLB JSON chunk.");
    const jsonByteOffset = 20;
    const jsonByteLength = jsonChunkHeader[0];
    const jsonText = BufferUtils.decodeText(BufferUtils.toView(glb, jsonByteOffset, jsonByteLength));
    const json = JSON.parse(jsonText);
    const binByteOffset = jsonByteOffset + jsonByteLength;
    if (glb.byteLength <= binByteOffset) return {
      json,
      resources: {}
    };
    const binChunkHeader = new Uint32Array(glb.buffer, glb.byteOffset + binByteOffset, 2);
    if (binChunkHeader[1] !== ChunkType.BIN) return {
      json,
      resources: {}
    };
    const binByteLength = binChunkHeader[0];
    const binBuffer = BufferUtils.toView(glb, binByteOffset + 8, binByteLength);
    return {
      json,
      resources: { [GLB_BUFFER]: binBuffer }
    };
  }
};
function isExternalBuffer(jsonDocument, bufferDef) {
  return bufferDef.uri !== void 0 && !(bufferDef.uri in jsonDocument.resources);
}
function isExternalImage(jsonDocument, imageDef) {
  return imageDef.uri !== void 0 && !(imageDef.uri in jsonDocument.resources) && imageDef.bufferView === void 0;
}
function isGLB(view) {
  if (view.byteLength < 3 * Uint32Array.BYTES_PER_ELEMENT) return false;
  const header = new Uint32Array(view.buffer, view.byteOffset, 3);
  return header[0] === 1179937895 && header[1] === 2;
}
var WebIO = class extends PlatformIO {
  _fetchConfig;
  /**
  * Constructs a new WebIO service. Instances are reusable.
  * @param fetchConfig Configuration object for Fetch API.
  */
  constructor(fetchConfig = HTTPUtils.DEFAULT_INIT) {
    super();
    this._fetchConfig = fetchConfig;
  }
  async readURI(uri, type) {
    const response = await fetch(uri, this._fetchConfig);
    switch (type) {
      case "view":
        return new Uint8Array(await response.arrayBuffer());
      case "text":
        return response.text();
    }
  }
  resolve(base, path) {
    return HTTPUtils.resolve(base, path);
  }
  dirname(uri) {
    return HTTPUtils.dirname(uri);
  }
};

// node_modules/ktx-parse/dist/ktx-parse.modern.js
var KHR_SUPERCOMPRESSION_NONE = 0;
var KHR_DF_KHR_DESCRIPTORTYPE_BASICFORMAT = 0;
var KHR_DF_VENDORID_KHRONOS = 0;
var KHR_DF_VERSION = 2;
var KHR_DF_MODEL_UNSPECIFIED = 0;
var KHR_DF_MODEL_ETC1S = 163;
var KHR_DF_MODEL_UASTC = 166;
var KHR_DF_FLAG_ALPHA_STRAIGHT = 0;
var KHR_DF_TRANSFER_SRGB = 2;
var KHR_DF_PRIMARIES_BT709 = 1;
var KHR_DF_SAMPLE_DATATYPE_SIGNED = 64;
var VK_FORMAT_UNDEFINED = 0;
var VK_FORMAT_E5B9G9R9_UFLOAT_PACK32 = 123;
var VK_FORMAT_ASTC_4x4_SFLOAT_BLOCK_EXT = 1000066e3;
function createDefaultContainer() {
  return {
    vkFormat: VK_FORMAT_UNDEFINED,
    typeSize: 1,
    pixelWidth: 0,
    pixelHeight: 0,
    pixelDepth: 0,
    layerCount: 0,
    faceCount: 1,
    levelCount: 0,
    supercompressionScheme: KHR_SUPERCOMPRESSION_NONE,
    levels: [],
    dataFormatDescriptor: [{
      vendorId: KHR_DF_VENDORID_KHRONOS,
      descriptorType: KHR_DF_KHR_DESCRIPTORTYPE_BASICFORMAT,
      versionNumber: KHR_DF_VERSION,
      colorModel: KHR_DF_MODEL_UNSPECIFIED,
      colorPrimaries: KHR_DF_PRIMARIES_BT709,
      transferFunction: KHR_DF_TRANSFER_SRGB,
      flags: KHR_DF_FLAG_ALPHA_STRAIGHT,
      texelBlockDimension: [0, 0, 0, 0],
      bytesPlane: [0, 0, 0, 0, 0, 0, 0, 0],
      samples: []
    }],
    keyValue: {},
    globalData: null
  };
}
var BufferReader = class {
  constructor(data, byteOffset, byteLength, littleEndian) {
    this._dataView = void 0;
    this._littleEndian = void 0;
    this._offset = void 0;
    this._dataView = new DataView(data.buffer, data.byteOffset + byteOffset, byteLength);
    this._littleEndian = littleEndian;
    this._offset = 0;
  }
  _nextUint8() {
    const value = this._dataView.getUint8(this._offset);
    this._offset += 1;
    return value;
  }
  _nextUint16() {
    const value = this._dataView.getUint16(this._offset, this._littleEndian);
    this._offset += 2;
    return value;
  }
  _nextUint32() {
    const value = this._dataView.getUint32(this._offset, this._littleEndian);
    this._offset += 4;
    return value;
  }
  _nextUint64() {
    const left = this._dataView.getUint32(this._offset, this._littleEndian);
    const right = this._dataView.getUint32(this._offset + 4, this._littleEndian);
    const value = left + 2 ** 32 * right;
    this._offset += 8;
    return value;
  }
  _nextInt32() {
    const value = this._dataView.getInt32(this._offset, this._littleEndian);
    this._offset += 4;
    return value;
  }
  _nextUint8Array(len) {
    const value = new Uint8Array(this._dataView.buffer, this._dataView.byteOffset + this._offset, len);
    this._offset += len;
    return value;
  }
  _skip(bytes) {
    this._offset += bytes;
    return this;
  }
  _scan(maxByteLength, term = 0) {
    const byteOffset = this._offset;
    let byteLength = 0;
    while (this._dataView.getUint8(this._offset) !== term && byteLength < maxByteLength) {
      byteLength++;
      this._offset++;
    }
    if (byteLength < maxByteLength) this._offset++;
    return new Uint8Array(this._dataView.buffer, this._dataView.byteOffset + byteOffset, byteLength);
  }
};
var NUL = new Uint8Array([0]);
var KTX2_ID = [
  // '´', 'K', 'T', 'X', '2', '0', 'ª', '\r', '\n', '\x1A', '\n'
  171,
  75,
  84,
  88,
  32,
  50,
  48,
  187,
  13,
  10,
  26,
  10
];
function decodeText(buffer) {
  return new TextDecoder().decode(buffer);
}
function read(data) {
  const id = new Uint8Array(data.buffer, data.byteOffset, KTX2_ID.length);
  if (id[0] !== KTX2_ID[0] || // '´'
  id[1] !== KTX2_ID[1] || // 'K'
  id[2] !== KTX2_ID[2] || // 'T'
  id[3] !== KTX2_ID[3] || // 'X'
  id[4] !== KTX2_ID[4] || // ' '
  id[5] !== KTX2_ID[5] || // '2'
  id[6] !== KTX2_ID[6] || // '0'
  id[7] !== KTX2_ID[7] || // 'ª'
  id[8] !== KTX2_ID[8] || // '\r'
  id[9] !== KTX2_ID[9] || // '\n'
  id[10] !== KTX2_ID[10] || // '\x1A'
  id[11] !== KTX2_ID[11]) {
    throw new Error("Missing KTX 2.0 identifier.");
  }
  const container = createDefaultContainer();
  const headerByteLength = 17 * Uint32Array.BYTES_PER_ELEMENT;
  const headerReader = new BufferReader(data, KTX2_ID.length, headerByteLength, true);
  container.vkFormat = headerReader._nextUint32();
  container.typeSize = headerReader._nextUint32();
  container.pixelWidth = headerReader._nextUint32();
  container.pixelHeight = headerReader._nextUint32();
  container.pixelDepth = headerReader._nextUint32();
  container.layerCount = headerReader._nextUint32();
  container.faceCount = headerReader._nextUint32();
  container.levelCount = headerReader._nextUint32();
  container.supercompressionScheme = headerReader._nextUint32();
  const dfdByteOffset = headerReader._nextUint32();
  const dfdByteLength = headerReader._nextUint32();
  const kvdByteOffset = headerReader._nextUint32();
  const kvdByteLength = headerReader._nextUint32();
  const sgdByteOffset = headerReader._nextUint64();
  const sgdByteLength = headerReader._nextUint64();
  const levelByteLength = Math.max(container.levelCount, 1) * 3 * 8;
  const levelReader = new BufferReader(data, KTX2_ID.length + headerByteLength, levelByteLength, true);
  for (let i = 0, il = Math.max(container.levelCount, 1); i < il; i++) {
    container.levels.push({
      levelData: new Uint8Array(data.buffer, data.byteOffset + levelReader._nextUint64(), levelReader._nextUint64()),
      uncompressedByteLength: levelReader._nextUint64()
    });
  }
  const dfdReader = new BufferReader(data, dfdByteOffset, dfdByteLength, true);
  dfdReader._skip(4);
  const vendorId = dfdReader._nextUint16();
  const descriptorType = dfdReader._nextUint16();
  const versionNumber = dfdReader._nextUint16();
  const descriptorBlockSize = dfdReader._nextUint16();
  const colorModel = dfdReader._nextUint8();
  const colorPrimaries = dfdReader._nextUint8();
  const transferFunction = dfdReader._nextUint8();
  const flags = dfdReader._nextUint8();
  const texelBlockDimension = [dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8()];
  const bytesPlane = [dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8()];
  const samples = [];
  const dfd = {
    vendorId,
    descriptorType,
    versionNumber,
    colorModel,
    colorPrimaries,
    transferFunction,
    flags,
    texelBlockDimension,
    bytesPlane,
    samples
  };
  const sampleStart = 6;
  const sampleWords = 4;
  const numSamples = (descriptorBlockSize / 4 - sampleStart) / sampleWords;
  for (let i = 0; i < numSamples; i++) {
    const sample = {
      bitOffset: dfdReader._nextUint16(),
      bitLength: dfdReader._nextUint8(),
      channelType: dfdReader._nextUint8(),
      samplePosition: [dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8(), dfdReader._nextUint8()],
      sampleLower: Number.NEGATIVE_INFINITY,
      sampleUpper: Number.POSITIVE_INFINITY
    };
    if (sample.channelType & KHR_DF_SAMPLE_DATATYPE_SIGNED) {
      sample.sampleLower = dfdReader._nextInt32();
      sample.sampleUpper = dfdReader._nextInt32();
    } else {
      sample.sampleLower = dfdReader._nextUint32();
      sample.sampleUpper = dfdReader._nextUint32();
    }
    dfd.samples[i] = sample;
  }
  container.dataFormatDescriptor.length = 0;
  container.dataFormatDescriptor.push(dfd);
  const kvdReader = new BufferReader(data, kvdByteOffset, kvdByteLength, true);
  while (kvdReader._offset < kvdByteLength) {
    const keyValueByteLength = kvdReader._nextUint32();
    const keyData = kvdReader._scan(keyValueByteLength);
    const key = decodeText(keyData);
    container.keyValue[key] = kvdReader._nextUint8Array(keyValueByteLength - keyData.byteLength - 1);
    if (key.match(/^ktx/i)) {
      const text = decodeText(container.keyValue[key]);
      container.keyValue[key] = text.substring(0, text.lastIndexOf("\0"));
    }
    const kvPadding = keyValueByteLength % 4 ? 4 - keyValueByteLength % 4 : 0;
    kvdReader._skip(kvPadding);
  }
  if (sgdByteLength <= 0) return container;
  const sgdReader = new BufferReader(data, sgdByteOffset, sgdByteLength, true);
  const endpointCount = sgdReader._nextUint16();
  const selectorCount = sgdReader._nextUint16();
  const endpointsByteLength = sgdReader._nextUint32();
  const selectorsByteLength = sgdReader._nextUint32();
  const tablesByteLength = sgdReader._nextUint32();
  const extendedByteLength = sgdReader._nextUint32();
  const imageDescs = [];
  for (let i = 0, il = Math.max(container.levelCount, 1); i < il; i++) {
    imageDescs.push({
      imageFlags: sgdReader._nextUint32(),
      rgbSliceByteOffset: sgdReader._nextUint32(),
      rgbSliceByteLength: sgdReader._nextUint32(),
      alphaSliceByteOffset: sgdReader._nextUint32(),
      alphaSliceByteLength: sgdReader._nextUint32()
    });
  }
  const endpointsByteOffset = sgdByteOffset + sgdReader._offset;
  const selectorsByteOffset = endpointsByteOffset + endpointsByteLength;
  const tablesByteOffset = selectorsByteOffset + selectorsByteLength;
  const extendedByteOffset = tablesByteOffset + tablesByteLength;
  const endpointsData = new Uint8Array(data.buffer, data.byteOffset + endpointsByteOffset, endpointsByteLength);
  const selectorsData = new Uint8Array(data.buffer, data.byteOffset + selectorsByteOffset, selectorsByteLength);
  const tablesData = new Uint8Array(data.buffer, data.byteOffset + tablesByteOffset, tablesByteLength);
  const extendedData = new Uint8Array(data.buffer, data.byteOffset + extendedByteOffset, extendedByteLength);
  container.globalData = {
    endpointCount,
    selectorCount,
    imageDescs,
    endpointsData,
    selectorsData,
    tablesData,
    extendedData
  };
  return container;
}

// node_modules/@gltf-transform/extensions/dist/index.js
var EXT_MESH_GPU_INSTANCING = "EXT_mesh_gpu_instancing";
var EXT_MESH_FEATURES = "EXT_mesh_features";
var EXT_MESHOPT_COMPRESSION = "EXT_meshopt_compression";
var EXT_STRUCTURAL_METADATA = "EXT_structural_metadata";
var EXT_TEXTURE_WEBP = "EXT_texture_webp";
var EXT_TEXTURE_AVIF = "EXT_texture_avif";
var KHR_ACCESSOR_FLOAT16 = "KHR_accessor_float16";
var KHR_ACCESSOR_FLOAT64 = "KHR_accessor_float64";
var KHR_DRACO_MESH_COMPRESSION = "KHR_draco_mesh_compression";
var KHR_LIGHTS_PUNCTUAL = "KHR_lights_punctual";
var KHR_MATERIALS_ANISOTROPY = "KHR_materials_anisotropy";
var KHR_MATERIALS_CLEARCOAT = "KHR_materials_clearcoat";
var KHR_MATERIALS_DIFFUSE_TRANSMISSION = "KHR_materials_diffuse_transmission";
var KHR_MATERIALS_DISPERSION = "KHR_materials_dispersion";
var KHR_MATERIALS_EMISSIVE_STRENGTH = "KHR_materials_emissive_strength";
var KHR_MATERIALS_IOR = "KHR_materials_ior";
var KHR_MATERIALS_IRIDESCENCE = "KHR_materials_iridescence";
var KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS = "KHR_materials_pbrSpecularGlossiness";
var KHR_MATERIALS_SHEEN = "KHR_materials_sheen";
var KHR_MATERIALS_SPECULAR = "KHR_materials_specular";
var KHR_MATERIALS_TRANSMISSION = "KHR_materials_transmission";
var KHR_MATERIALS_UNLIT = "KHR_materials_unlit";
var KHR_MATERIALS_VOLUME = "KHR_materials_volume";
var KHR_MATERIALS_VARIANTS = "KHR_materials_variants";
var KHR_MESH_PRIMITIVE_RESTART = "KHR_mesh_primitive_restart";
var KHR_MESH_QUANTIZATION = "KHR_mesh_quantization";
var KHR_NODE_VISIBILITY = "KHR_node_visibility";
var KHR_TEXTURE_BASISU = "KHR_texture_basisu";
var KHR_TEXTURE_TRANSFORM = "KHR_texture_transform";
var KHR_XMP_JSON_LD = "KHR_xmp_json_ld";
var FeatureID = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_MESH_FEATURES;
  init() {
    this.extensionName = EXT_MESH_FEATURES;
    this.propertyType = "FeatureID";
    this.parentTypes = ["Features"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      nullFeatureId: null,
      label: "",
      attribute: null,
      texture: null,
      propertyTable: null
    });
  }
  getFeatureCount() {
    return this.get("featureCount");
  }
  setFeatureCount(featureCount) {
    return this.set("featureCount", featureCount);
  }
  getNullFeatureID() {
    return this.get("nullFeatureId");
  }
  setNullFeatureID(nullFeatureId) {
    return this.set("nullFeatureId", nullFeatureId);
  }
  getLabel() {
    return this.get("label");
  }
  setLabel(label) {
    return this.set("label", label);
  }
  getAttribute() {
    return this.get("attribute");
  }
  setAttribute(attribute) {
    return this.set("attribute", attribute);
  }
  getTexture() {
    return this.getRef("texture");
  }
  setTexture(texture) {
    return this.setRef("texture", texture);
  }
  getPropertyTable() {
    return this.getRef("propertyTable");
  }
  setPropertyTable(propertyTable) {
    return this.setRef("propertyTable", propertyTable);
  }
};
var FeatureIDTexture = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_MESH_FEATURES;
  init() {
    this.extensionName = EXT_MESH_FEATURES;
    this.propertyType = "FeatureIDTexture";
    this.parentTypes = ["FeatureID"];
  }
  getDefaults() {
    const defaultTextureInfo = new TextureInfo(this.graph, "textureInfo");
    defaultTextureInfo.setMinFilter(TextureInfo.MagFilter.NEAREST);
    defaultTextureInfo.setMagFilter(TextureInfo.MagFilter.NEAREST);
    return Object.assign(super.getDefaults(), {
      channels: [0],
      texture: null,
      textureInfo: defaultTextureInfo
    });
  }
  getChannels() {
    return this.get("channels");
  }
  setChannels(channels) {
    return this.set("channels", channels);
  }
  getTexture() {
    return this.getRef("texture");
  }
  setTexture(texture) {
    return this.setRef("texture", texture);
  }
  getTextureInfo() {
    return this.getRef("texture") ? this.getRef("textureInfo") : null;
  }
};
var Features = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_MESH_FEATURES;
  init() {
    this.extensionName = EXT_MESH_FEATURES;
    this.propertyType = "Features";
    this.parentTypes = [PropertyType.PRIMITIVE];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { featureIds: new RefSet([]) });
  }
  listFeatureIDs() {
    return this.listRefs("featureIds");
  }
  addFeatureID(featureId) {
    return this.addRef("featureIds", featureId);
  }
  removeFeatureID(featureId) {
    return this.removeRef("featureIds", featureId);
  }
};
var NAME$2 = EXT_MESH_FEATURES;
var EXTMeshFeatures = class extends Extension {
  extensionName = EXT_MESH_FEATURES;
  static EXTENSION_NAME = EXT_MESH_FEATURES;
  createFeatures() {
    return new Features(this.document.getGraph());
  }
  createFeatureID() {
    return new FeatureID(this.document.getGraph());
  }
  createFeatureIDTexture() {
    return new FeatureIDTexture(this.document.getGraph());
  }
  read(context) {
    (context.jsonDoc.json.meshes || []).forEach((meshDef, meshIndex) => {
      (meshDef.primitives || []).forEach((primDef, primIndex) => {
        this._readPrimitive(context, meshIndex, primDef, primIndex);
      });
    });
    return this;
  }
  /** @hidden */
  _readPrimitive(context, meshIndex, primDef, primIndex) {
    if (!primDef.extensions || !primDef.extensions[NAME$2]) return;
    const features = this.createFeatures();
    const meshFeaturesDef = primDef.extensions[NAME$2];
    for (const featureIDDef of meshFeaturesDef.featureIds) {
      const featureID = _readFeatureID(this.document, this, context, featureIDDef);
      features.addFeatureID(featureID);
    }
    context.meshes[meshIndex].listPrimitives()[primIndex].setExtension(NAME$2, features);
  }
  write(context) {
    const meshDefs = context.jsonDoc.json.meshes;
    if (!meshDefs) return this;
    for (const mesh of this.document.getRoot().listMeshes()) {
      const meshDef = meshDefs[context.meshIndexMap.get(mesh)];
      mesh.listPrimitives().forEach((prim, primIndex) => {
        const primDef = meshDef.primitives[primIndex];
        this._writePrimitive(context, prim, primDef);
      });
    }
    return this;
  }
  /** @hidden */
  _writePrimitive(context, prim, primDef) {
    const meshFeatures = prim.getExtension(NAME$2);
    if (!meshFeatures) return;
    const meshFeaturesDef = { featureIds: [] };
    meshFeatures.listFeatureIDs().forEach((featureID) => {
      meshFeaturesDef.featureIds.push(_writeFeatureIDDef(this.document, context, featureID));
    });
    primDef.extensions = primDef.extensions || {};
    primDef.extensions[NAME$2] = meshFeaturesDef;
  }
};
function _readFeatureID(document2, ext, context, featureIDDef) {
  const featureID = ext.createFeatureID().setFeatureCount(featureIDDef.featureCount);
  if (featureIDDef.nullFeatureId !== void 0) featureID.setNullFeatureID(featureIDDef.nullFeatureId);
  if (featureIDDef.label !== void 0) featureID.setLabel(featureIDDef.label);
  if (featureIDDef.attribute !== void 0) featureID.setAttribute(featureIDDef.attribute);
  const featureIDTextureDef = featureIDDef.texture;
  if (featureIDTextureDef !== void 0) {
    const featureIDTexture = _readFeatureIDTexture(ext, context, featureIDTextureDef);
    featureID.setTexture(featureIDTexture);
  }
  if (featureIDDef.propertyTable !== void 0) {
    const propertyTables = document2.getRoot().getExtension(EXT_STRUCTURAL_METADATA).listPropertyTables();
    featureID.setPropertyTable(propertyTables[featureIDDef.propertyTable]);
  }
  return featureID;
}
function _readFeatureIDTexture(ext, context, featureIDTextureDef) {
  const featureIDTexture = ext.createFeatureIDTexture();
  const { json } = context.jsonDoc;
  if (featureIDTextureDef.channels) featureIDTexture.setChannels(featureIDTextureDef.channels);
  if (featureIDTextureDef.index !== void 0) {
    const textureIndex = json.textures[featureIDTextureDef.index].source;
    featureIDTexture.setTexture(context.textures[textureIndex]);
    context.setTextureInfo(featureIDTexture.getTextureInfo(), featureIDTextureDef);
  }
  return featureIDTexture;
}
function _writeFeatureIDDef(document2, context, featureID) {
  const root = document2.getRoot();
  const featureIDDef = { featureCount: featureID.getFeatureCount() };
  if (featureID.getNullFeatureID() != null) featureIDDef.nullFeatureId = featureID.getNullFeatureID();
  if (featureID.getLabel()) featureIDDef.label = featureID.getLabel();
  if (featureID.getAttribute() != null) featureIDDef.attribute = featureID.getAttribute();
  if (featureID.getTexture()) {
    const featureIDTexture = featureID.getTexture();
    const texture = featureIDTexture.getTexture();
    const textureInfo = featureIDTexture.getTextureInfo();
    featureIDDef.texture = context.createTextureInfoDef(texture, textureInfo);
    const channels = featureIDTexture.getChannels();
    if (!MathUtils.eq(channels, [0])) featureIDDef.texture.channels = channels;
  }
  if (featureID.getPropertyTable()) {
    const structuralMetadata = root.getExtension(EXT_STRUCTURAL_METADATA);
    const propertyTable = featureID.getPropertyTable();
    featureIDDef.propertyTable = structuralMetadata.listPropertyTables().indexOf(propertyTable);
  }
  return featureIDDef;
}
var INSTANCE_ATTRIBUTE = "INSTANCE_ATTRIBUTE";
var InstancedMesh = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_MESH_GPU_INSTANCING;
  init() {
    this.extensionName = EXT_MESH_GPU_INSTANCING;
    this.propertyType = "InstancedMesh";
    this.parentTypes = [PropertyType.NODE];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { attributes: new RefMap() });
  }
  /** Returns an instance attribute as an {@link Accessor}. */
  getAttribute(semantic) {
    return this.getRefMap("attributes", semantic);
  }
  /**
  * Sets an instance attribute to an {@link Accessor}. All attributes must have the same
  * instance count.
  */
  setAttribute(semantic, accessor) {
    return this.setRefMap("attributes", semantic, accessor, { usage: INSTANCE_ATTRIBUTE });
  }
  /**
  * Lists all instance attributes {@link Accessor}s associated with the InstancedMesh. Order
  * will be consistent with the order returned by {@link .listSemantics}().
  */
  listAttributes() {
    return this.listRefMapValues("attributes");
  }
  /**
  * Lists all instance attribute semantics associated with the primitive. Order will be
  * consistent with the order returned by {@link .listAttributes}().
  */
  listSemantics() {
    return this.listRefMapKeys("attributes");
  }
};
var EXTMeshGPUInstancing = class extends Extension {
  static EXTENSION_NAME = EXT_MESH_GPU_INSTANCING;
  extensionName = EXT_MESH_GPU_INSTANCING;
  /** @hidden */
  prewriteTypes = [PropertyType.ACCESSOR];
  /** Creates a new InstancedMesh property for use on a {@link Node}. */
  createInstancedMesh() {
    return new InstancedMesh(this.document.getGraph());
  }
  /** @hidden */
  read(context) {
    (context.jsonDoc.json.nodes || []).forEach((nodeDef, nodeIndex) => {
      if (!nodeDef.extensions || !nodeDef.extensions["EXT_mesh_gpu_instancing"]) return;
      const instancedMeshDef = nodeDef.extensions[EXT_MESH_GPU_INSTANCING];
      const instancedMesh = this.createInstancedMesh();
      for (const semantic in instancedMeshDef.attributes) instancedMesh.setAttribute(semantic, context.accessors[instancedMeshDef.attributes[semantic]]);
      context.nodes[nodeIndex].setExtension(EXT_MESH_GPU_INSTANCING, instancedMesh);
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    context.accessorUsageGroupedByParent.add(INSTANCE_ATTRIBUTE);
    for (const prop of this.properties) for (const attribute of prop.listAttributes()) context.addAccessorToUsageGroup(attribute, INSTANCE_ATTRIBUTE);
    return this;
  }
  /** @hidden */
  write(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listNodes().forEach((node) => {
      const instancedMesh = node.getExtension(EXT_MESH_GPU_INSTANCING);
      if (instancedMesh) {
        const nodeIndex = context.nodeIndexMap.get(node);
        const nodeDef = jsonDoc.json.nodes[nodeIndex];
        const instancedMeshDef = { attributes: {} };
        instancedMesh.listSemantics().forEach((semantic) => {
          const attribute = instancedMesh.getAttribute(semantic);
          instancedMeshDef.attributes[semantic] = context.accessorIndexMap.get(attribute);
        });
        nodeDef.extensions = nodeDef.extensions || {};
        nodeDef.extensions[EXT_MESH_GPU_INSTANCING] = instancedMeshDef;
      }
    });
    return this;
  }
};
var EncoderMethod$1 = /* @__PURE__ */ (function(EncoderMethod2) {
  EncoderMethod2["QUANTIZE"] = "quantize";
  EncoderMethod2["FILTER"] = "filter";
  return EncoderMethod2;
})({});
var MeshoptMode = /* @__PURE__ */ (function(MeshoptMode2) {
  MeshoptMode2["ATTRIBUTES"] = "ATTRIBUTES";
  MeshoptMode2["TRIANGLES"] = "TRIANGLES";
  MeshoptMode2["INDICES"] = "INDICES";
  return MeshoptMode2;
})({});
var MeshoptFilter = /* @__PURE__ */ (function(MeshoptFilter2) {
  MeshoptFilter2["NONE"] = "NONE";
  MeshoptFilter2["OCTAHEDRAL"] = "OCTAHEDRAL";
  MeshoptFilter2["QUATERNION"] = "QUATERNION";
  MeshoptFilter2["EXPONENTIAL"] = "EXPONENTIAL";
  return MeshoptFilter2;
})({});
function isFallbackBuffer(bufferDef) {
  if (!bufferDef.extensions || !bufferDef.extensions["EXT_meshopt_compression"]) return false;
  return !!bufferDef.extensions[EXT_MESHOPT_COMPRESSION].fallback;
}
var { BYTE, SHORT, FLOAT } = Accessor.ComponentType;
var { encodeNormalizedInt, decodeNormalizedInt } = MathUtils;
function prepareAccessor(accessor, encoder, mode, filterOptions) {
  const { filter, bits } = filterOptions;
  const result = {
    array: accessor.getArray(),
    byteStride: accessor.getElementSize() * accessor.getComponentSize(),
    componentType: accessor.getComponentType(),
    normalized: accessor.getNormalized()
  };
  if (mode !== MeshoptMode.ATTRIBUTES) return result;
  if (filter !== MeshoptFilter.NONE) {
    let array = accessor.getNormalized() ? decodeNormalizedIntArray(accessor) : new Float32Array(result.array);
    switch (filter) {
      case MeshoptFilter.EXPONENTIAL:
        result.byteStride = accessor.getElementSize() * 4;
        result.componentType = FLOAT;
        result.normalized = false;
        result.array = encoder.encodeFilterExp(array, accessor.getCount(), result.byteStride, bits);
        break;
      case MeshoptFilter.OCTAHEDRAL:
        result.byteStride = bits > 8 ? 8 : 4;
        result.componentType = bits > 8 ? SHORT : BYTE;
        result.normalized = true;
        array = accessor.getElementSize() === 3 ? padNormals(array) : array;
        result.array = encoder.encodeFilterOct(array, accessor.getCount(), result.byteStride, bits);
        break;
      case MeshoptFilter.QUATERNION:
        result.byteStride = 8;
        result.componentType = SHORT;
        result.normalized = true;
        result.array = encoder.encodeFilterQuat(array, accessor.getCount(), result.byteStride, bits);
        break;
      default:
        throw new Error("Invalid filter.");
    }
    result.min = accessor.getMin([]);
    result.max = accessor.getMax([]);
    if (accessor.getNormalized()) {
      result.min = result.min.map((v) => decodeNormalizedInt(v, accessor.getComponentType()));
      result.max = result.max.map((v) => decodeNormalizedInt(v, accessor.getComponentType()));
    }
    if (result.normalized) {
      result.min = result.min.map((v) => encodeNormalizedInt(v, result.componentType));
      result.max = result.max.map((v) => encodeNormalizedInt(v, result.componentType));
    }
  } else if (result.byteStride % 4) {
    result.array = padArrayElements(result.array, accessor.getElementSize());
    result.byteStride = result.array.byteLength / accessor.getCount();
  }
  return result;
}
function decodeNormalizedIntArray(attribute) {
  const componentType = attribute.getComponentType();
  const srcArray = attribute.getArray();
  const dstArray = new Float32Array(srcArray.length);
  for (let i = 0; i < srcArray.length; i++) dstArray[i] = decodeNormalizedInt(srcArray[i], componentType);
  return dstArray;
}
function padArrayElements(srcArray, elementSize) {
  const elementStride = BufferUtils.padNumber(srcArray.BYTES_PER_ELEMENT * elementSize) / srcArray.BYTES_PER_ELEMENT;
  const elementCount = srcArray.length / elementSize;
  const dstArray = new srcArray.constructor(elementCount * elementStride);
  for (let i = 0; i * elementSize < srcArray.length; i++) for (let j = 0; j < elementSize; j++) dstArray[i * elementStride + j] = srcArray[i * elementSize + j];
  return dstArray;
}
function padNormals(srcArray) {
  const dstArray = new Float32Array(srcArray.length * 4 / 3);
  for (let i = 0, il = srcArray.length / 3; i < il; i++) {
    dstArray[i * 4] = srcArray[i * 3];
    dstArray[i * 4 + 1] = srcArray[i * 3 + 1];
    dstArray[i * 4 + 2] = srcArray[i * 3 + 2];
  }
  return dstArray;
}
function getMeshoptMode(accessor, usage) {
  if (usage === WriterContext.BufferViewUsage.ELEMENT_ARRAY_BUFFER) return accessor.listParents().some((parent) => {
    return parent instanceof Primitive && parent.getMode() === Primitive.Mode.TRIANGLES;
  }) ? MeshoptMode.TRIANGLES : MeshoptMode.INDICES;
  return MeshoptMode.ATTRIBUTES;
}
function getMeshoptFilter(accessor, doc) {
  const refs = doc.getGraph().listParentEdges(accessor).filter((edge) => !(edge.getParent() instanceof Root));
  for (const ref of refs) {
    const refName = ref.getName();
    const refKey = ref.getAttributes().key || "";
    const isDelta = ref.getParent().propertyType === PropertyType.PRIMITIVE_TARGET;
    if (refName === "indices") return { filter: MeshoptFilter.NONE };
    if (refName === "attributes") {
      if (refKey === "POSITION") return { filter: MeshoptFilter.NONE };
      if (refKey === "TEXCOORD_0") return { filter: MeshoptFilter.NONE };
      if (refKey.startsWith("JOINTS_")) return { filter: MeshoptFilter.NONE };
      if (refKey.startsWith("WEIGHTS_")) return { filter: MeshoptFilter.NONE };
      if (refKey === "NORMAL" || refKey === "TANGENT") return isDelta ? { filter: MeshoptFilter.NONE } : {
        filter: MeshoptFilter.OCTAHEDRAL,
        bits: 8
      };
    }
    if (refName === "output") {
      const targetPath = getTargetPath(accessor);
      if (targetPath === "rotation") return {
        filter: MeshoptFilter.QUATERNION,
        bits: 16
      };
      if (targetPath === "translation") return {
        filter: MeshoptFilter.EXPONENTIAL,
        bits: 12
      };
      if (targetPath === "scale") return {
        filter: MeshoptFilter.EXPONENTIAL,
        bits: 12
      };
      return { filter: MeshoptFilter.NONE };
    }
    if (refName === "input") return { filter: MeshoptFilter.NONE };
    if (refName === "inverseBindMatrices") return { filter: MeshoptFilter.NONE };
  }
  return { filter: MeshoptFilter.NONE };
}
function getTargetPath(accessor) {
  for (const sampler of accessor.listParents()) {
    if (!(sampler instanceof AnimationSampler)) continue;
    for (const channel of sampler.listParents()) {
      if (!(channel instanceof AnimationChannel)) continue;
      return channel.getTargetPath();
    }
  }
  return null;
}
var DEFAULT_ENCODER_OPTIONS$1 = { method: EncoderMethod$1.QUANTIZE };
var EXTMeshoptCompression = class extends Extension {
  extensionName = EXT_MESHOPT_COMPRESSION;
  /** @hidden */
  prereadTypes = [PropertyType.BUFFER, PropertyType.PRIMITIVE];
  /** @hidden */
  prewriteTypes = [PropertyType.BUFFER, PropertyType.ACCESSOR];
  /** @hidden */
  readDependencies = ["meshopt.decoder"];
  /** @hidden */
  writeDependencies = ["meshopt.encoder"];
  static EXTENSION_NAME = EXT_MESHOPT_COMPRESSION;
  static EncoderMethod = EncoderMethod$1;
  _decoder = null;
  _decoderFallbackBufferMap = /* @__PURE__ */ new Map();
  _encoder = null;
  _encoderOptions = DEFAULT_ENCODER_OPTIONS$1;
  _encoderFallbackBuffer = null;
  _encoderBufferViews = {};
  _encoderBufferViewData = {};
  _encoderBufferViewAccessors = {};
  /** @hidden */
  install(key, dependency) {
    if (key === "meshopt.decoder") this._decoder = dependency;
    if (key === "meshopt.encoder") this._encoder = dependency;
    return this;
  }
  /**
  * Configures Meshopt options for quality/compression tuning. The two methods rely on different
  * pre-processing before compression, and should be compared on the basis of (a) quality/loss
  * and (b) final asset size after _also_ applying a lossless compression such as gzip or brotli.
  *
  * - QUANTIZE: Default. Pre-process with {@link quantize quantize()} (lossy to specified
  * 	precision) before applying lossless Meshopt compression. Offers a considerable compression
  * 	ratio with or without further supercompression. Equivalent to `gltfpack -c`.
  * - FILTER: Pre-process with lossy filters to improve compression, before applying lossless
  *	Meshopt compression. While output may initially be larger than with the QUANTIZE method,
  *	this method will benefit more from supercompression (e.g. gzip or brotli). Equivalent to
  * 	`gltfpack -cc`.
  *
  * Output with the FILTER method will generally be smaller after supercompression (e.g. gzip or
  * brotli) is applied, but may be larger than QUANTIZE output without it. Decoding is very fast
  * with both methods.
  *
  * Example:
  *
  * ```ts
  * import { EXTMeshoptCompression } from '@gltf-transform/extensions';
  *
  * doc.createExtension(EXTMeshoptCompression)
  * 	.setRequired(true)
  * 	.setEncoderOptions({
  * 		method: EXTMeshoptCompression.EncoderMethod.QUANTIZE
  * 	});
  * ```
  */
  setEncoderOptions(options) {
    this._encoderOptions = {
      ...DEFAULT_ENCODER_OPTIONS$1,
      ...options
    };
    return this;
  }
  /**********************************************************************************************
  * Decoding.
  */
  /** @internal Checks preconditions, decodes buffer views, and creates decoded primitives. */
  preread(context, propertyType) {
    if (!this._decoder) {
      if (!this.isRequired()) return this;
      throw new Error(`[${EXT_MESHOPT_COMPRESSION}] Please install extension dependency, "meshopt.decoder".`);
    }
    if (!this._decoder.supported) {
      if (!this.isRequired()) return this;
      throw new Error(`[${EXT_MESHOPT_COMPRESSION}]: Missing WASM support.`);
    }
    if (propertyType === PropertyType.BUFFER) this._prereadBuffers(context);
    else if (propertyType === PropertyType.PRIMITIVE) this._prereadPrimitives(context);
    return this;
  }
  /** @internal Decode buffer views. */
  _prereadBuffers(context) {
    const jsonDoc = context.jsonDoc;
    (jsonDoc.json.bufferViews || []).forEach((viewDef, index) => {
      if (!viewDef.extensions || !viewDef.extensions["EXT_meshopt_compression"]) return;
      const meshoptDef = viewDef.extensions[EXT_MESHOPT_COMPRESSION];
      const byteOffset = meshoptDef.byteOffset || 0;
      const byteLength = meshoptDef.byteLength || 0;
      const count = meshoptDef.count;
      const stride = meshoptDef.byteStride;
      const result = new Uint8Array(count * stride);
      const bufferDef = jsonDoc.json.buffers[meshoptDef.buffer];
      const resource = bufferDef.uri ? jsonDoc.resources[bufferDef.uri] : jsonDoc.resources[GLB_BUFFER];
      const source = BufferUtils.toView(resource, byteOffset, byteLength);
      this._decoder.decodeGltfBuffer(result, count, stride, source, meshoptDef.mode, meshoptDef.filter);
      context.bufferViews[index] = result;
    });
  }
  /**
  * Mark fallback buffers and replacements.
  *
  * Note: Alignment with primitives is arbitrary; this just needs to happen
  * after Buffers have been parsed.
  * @internal
  */
  _prereadPrimitives(context) {
    const jsonDoc = context.jsonDoc;
    (jsonDoc.json.bufferViews || []).forEach((viewDef) => {
      if (!viewDef.extensions || !viewDef.extensions["EXT_meshopt_compression"]) return;
      const meshoptDef = viewDef.extensions[EXT_MESHOPT_COMPRESSION];
      const buffer = context.buffers[meshoptDef.buffer];
      const fallbackBuffer = context.buffers[viewDef.buffer];
      const fallbackBufferDef = jsonDoc.json.buffers[viewDef.buffer];
      if (isFallbackBuffer(fallbackBufferDef)) this._decoderFallbackBufferMap.set(fallbackBuffer, buffer);
    });
  }
  /** @hidden Removes Fallback buffers, if extension is required. */
  read(_context) {
    if (!this.isRequired()) return this;
    for (const [fallbackBuffer, buffer] of this._decoderFallbackBufferMap) {
      for (const parent of fallbackBuffer.listParents()) if (parent instanceof Accessor) parent.swap(fallbackBuffer, buffer);
      fallbackBuffer.dispose();
    }
    return this;
  }
  /**********************************************************************************************
  * Encoding.
  */
  /** @internal Claims accessors that can be compressed and writes compressed buffer views. */
  prewrite(context, propertyType) {
    if (propertyType === PropertyType.ACCESSOR) this._prewriteAccessors(context);
    else if (propertyType === PropertyType.BUFFER) this._prewriteBuffers(context);
    return this;
  }
  /** @internal Claims accessors that can be compressed. */
  _prewriteAccessors(context) {
    const json = context.jsonDoc.json;
    const encoder = this._encoder;
    const options = this._encoderOptions;
    const graph = this.document.getGraph();
    const fallbackBuffer = this.document.createBuffer();
    const fallbackBufferIndex = this.document.getRoot().listBuffers().indexOf(fallbackBuffer);
    let nextID = 1;
    const parentToID = /* @__PURE__ */ new Map();
    const getParentID = (property) => {
      for (const parent of graph.listParents(property)) {
        if (parent.propertyType === PropertyType.ROOT) continue;
        let id = parentToID.get(property);
        if (id === void 0) parentToID.set(property, id = nextID++);
        return id;
      }
      return -1;
    };
    this._encoderFallbackBuffer = fallbackBuffer;
    this._encoderBufferViews = {};
    this._encoderBufferViewData = {};
    this._encoderBufferViewAccessors = {};
    for (const accessor of this.document.getRoot().listAccessors()) {
      if (getTargetPath(accessor) === "weights") continue;
      if (accessor.getSparse()) continue;
      const usage = context.getAccessorUsage(accessor);
      const parentID = context.accessorUsageGroupedByParent.has(usage) ? getParentID(accessor) : null;
      const mode = getMeshoptMode(accessor, usage);
      const filter = options.method === EncoderMethod$1.FILTER ? getMeshoptFilter(accessor, this.document) : { filter: MeshoptFilter.NONE };
      const preparedAccessor = prepareAccessor(accessor, encoder, mode, filter);
      const { array, byteStride } = preparedAccessor;
      const buffer = accessor.getBuffer();
      if (!buffer) throw new Error(`${EXT_MESHOPT_COMPRESSION}: Missing buffer for accessor.`);
      const bufferIndex = this.document.getRoot().listBuffers().indexOf(buffer);
      const key = [
        usage,
        parentID,
        mode,
        filter.filter,
        byteStride,
        bufferIndex
      ].join(":");
      let bufferView = this._encoderBufferViews[key];
      let bufferViewData = this._encoderBufferViewData[key];
      let bufferViewAccessors = this._encoderBufferViewAccessors[key];
      if (!bufferView || !bufferViewData) {
        bufferViewAccessors = this._encoderBufferViewAccessors[key] = [];
        bufferViewData = this._encoderBufferViewData[key] = [];
        bufferView = this._encoderBufferViews[key] = {
          buffer: fallbackBufferIndex,
          target: WriterContext.USAGE_TO_TARGET[usage],
          byteOffset: 0,
          byteLength: 0,
          byteStride: usage === WriterContext.BufferViewUsage.ARRAY_BUFFER ? byteStride : void 0,
          extensions: { [EXT_MESHOPT_COMPRESSION]: {
            buffer: bufferIndex,
            byteOffset: 0,
            byteLength: 0,
            mode,
            filter: filter.filter !== MeshoptFilter.NONE ? filter.filter : void 0,
            byteStride,
            count: 0
          } }
        };
      }
      const accessorDef = context.createAccessorDef(accessor);
      accessorDef.componentType = preparedAccessor.componentType;
      accessorDef.normalized = preparedAccessor.normalized;
      accessorDef.byteOffset = bufferView.byteLength;
      if (accessorDef.min && preparedAccessor.min) accessorDef.min = preparedAccessor.min;
      if (accessorDef.max && preparedAccessor.max) accessorDef.max = preparedAccessor.max;
      context.accessorIndexMap.set(accessor, json.accessors.length);
      json.accessors.push(accessorDef);
      bufferViewAccessors.push(accessorDef);
      bufferViewData.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
      bufferView.byteLength += array.byteLength;
      bufferView.extensions.EXT_meshopt_compression.count += accessor.getCount();
    }
  }
  /** @internal Writes compressed buffer views. */
  _prewriteBuffers(context) {
    const encoder = this._encoder;
    for (const key in this._encoderBufferViews) {
      const bufferView = this._encoderBufferViews[key];
      const bufferViewData = this._encoderBufferViewData[key];
      const buffer = this.document.getRoot().listBuffers()[bufferView.extensions[EXT_MESHOPT_COMPRESSION].buffer];
      const otherBufferViews = context.otherBufferViews.get(buffer) || [];
      const { count, byteStride, mode } = bufferView.extensions[EXT_MESHOPT_COMPRESSION];
      const srcArray = BufferUtils.concat(bufferViewData);
      const dstArray = encoder.encodeGltfBuffer(srcArray, count, byteStride, mode);
      const compressedData = BufferUtils.pad(dstArray);
      bufferView.extensions[EXT_MESHOPT_COMPRESSION].byteLength = dstArray.byteLength;
      bufferViewData.length = 0;
      bufferViewData.push(compressedData);
      otherBufferViews.push(compressedData);
      context.otherBufferViews.set(buffer, otherBufferViews);
    }
  }
  /** @hidden Puts encoded data into glTF output. */
  write(context) {
    let fallbackBufferByteOffset = 0;
    for (const key in this._encoderBufferViews) {
      const bufferView = this._encoderBufferViews[key];
      const bufferViewData = this._encoderBufferViewData[key][0];
      const bufferViewIndex = context.otherBufferViewsIndexMap.get(bufferViewData);
      const bufferViewAccessors = this._encoderBufferViewAccessors[key];
      for (const accessorDef of bufferViewAccessors) accessorDef.bufferView = bufferViewIndex;
      const finalBufferViewDef = context.jsonDoc.json.bufferViews[bufferViewIndex];
      const compressedByteOffset = finalBufferViewDef.byteOffset || 0;
      Object.assign(finalBufferViewDef, bufferView);
      finalBufferViewDef.byteOffset = fallbackBufferByteOffset;
      const bufferViewExtensionDef = finalBufferViewDef.extensions[EXT_MESHOPT_COMPRESSION];
      bufferViewExtensionDef.byteOffset = compressedByteOffset;
      fallbackBufferByteOffset += BufferUtils.padNumber(bufferView.byteLength);
    }
    const fallbackBuffer = this._encoderFallbackBuffer;
    const fallbackBufferIndex = context.bufferIndexMap.get(fallbackBuffer);
    const fallbackBufferDef = context.jsonDoc.json.buffers[fallbackBufferIndex];
    fallbackBufferDef.byteLength = fallbackBufferByteOffset;
    fallbackBufferDef.extensions = { [EXT_MESHOPT_COMPRESSION]: { fallback: true } };
    fallbackBuffer.dispose();
    return this;
  }
};
var StructuralMetadata = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "StructuralMetadata";
    this.parentTypes = [PropertyType.ROOT];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      schema: null,
      schemaUri: "",
      propertyTables: new RefList(),
      propertyTextures: new RefList(),
      propertyAttributes: new RefList()
    });
  }
  getSchema() {
    return this.getRef("schema");
  }
  setSchema(schema) {
    return this.setRef("schema", schema);
  }
  getSchemaUri() {
    return this.get("schemaUri");
  }
  setSchemaUri(schemaUri) {
    return this.set("schemaUri", schemaUri);
  }
  listPropertyTables() {
    return this.listRefs("propertyTables");
  }
  addPropertyTable(propertyTable) {
    return this.addRef("propertyTables", propertyTable);
  }
  removePropertyTable(propertyTable) {
    return this.removeRef("propertyTables", propertyTable);
  }
  listPropertyTextures() {
    return this.listRefs("propertyTextures");
  }
  addPropertyTexture(propertyTexture) {
    return this.addRef("propertyTextures", propertyTexture);
  }
  removePropertyTexture(propertyTexture) {
    return this.removeRef("propertyTextures", propertyTexture);
  }
  listPropertyAttributes() {
    return this.listRefs("propertyAttributes");
  }
  addPropertyAttribute(propertyAttribute) {
    return this.addRef("propertyAttributes", propertyAttribute);
  }
  removePropertyAttribute(propertyAttribute) {
    return this.removeRef("propertyAttributes", propertyAttribute);
  }
};
var Schema = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "Schema";
    this.parentTypes = ["StructuralMetadata"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      description: "",
      version: "",
      classes: new RefMap(),
      enums: new RefMap()
    });
  }
  getId() {
    return this.get("id");
  }
  setId(name) {
    return this.set("id", name);
  }
  getDescription() {
    return this.get("description");
  }
  setDescription(description) {
    return this.set("description", description);
  }
  getVersion() {
    return this.get("version");
  }
  setVersion(version) {
    return this.set("version", version);
  }
  setClass(key, value) {
    return this.setRefMap("classes", key, value);
  }
  getClass(key) {
    return this.getRefMap("classes", key);
  }
  listClassKeys() {
    return this.listRefMapKeys("classes");
  }
  listClassValues() {
    return this.listRefMapValues("classes");
  }
  setEnum(key, value) {
    return this.setRefMap("enums", key, value);
  }
  getEnum(key) {
    return this.getRefMap("enums", key);
  }
  listEnumKeys() {
    return this.listRefMapKeys("enums");
  }
  listEnumValues() {
    return this.listRefMapValues("enums");
  }
};
var Class = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "Class";
    this.parentTypes = ["Schema"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      description: "",
      properties: new RefMap()
    });
  }
  getDescription() {
    return this.get("description");
  }
  setDescription(description) {
    return this.set("description", description);
  }
  setProperty(key, value) {
    return this.setRefMap("properties", key, value);
  }
  getProperty(key) {
    return this.getRefMap("properties", key);
  }
  listPropertyKeys() {
    return this.listRefMapKeys("properties");
  }
  listPropertyValues() {
    return this.listRefMapValues("properties");
  }
};
var ClassProperty = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "ClassProperty";
    this.parentTypes = ["Class"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      description: "",
      componentType: null,
      enumType: null,
      array: null,
      count: null,
      normalized: null,
      offset: null,
      scale: null,
      max: null,
      min: null,
      required: null,
      noData: null,
      default: null
    });
  }
  getDescription() {
    return this.get("description");
  }
  setDescription(description) {
    return this.set("description", description);
  }
  getType() {
    return this.get("type");
  }
  setType(type) {
    return this.set("type", type);
  }
  getComponentType() {
    return this.get("componentType");
  }
  setComponentType(componentType) {
    return this.set("componentType", componentType);
  }
  getEnumType() {
    return this.get("enumType");
  }
  setEnumType(enumType) {
    return this.set("enumType", enumType);
  }
  getArray() {
    return this.get("array");
  }
  setArray(array) {
    return this.set("array", array);
  }
  getCount() {
    return this.get("count");
  }
  setCount(count) {
    return this.set("count", count);
  }
  getNormalized() {
    return this.get("normalized");
  }
  setNormalized(normalized) {
    return this.set("normalized", normalized);
  }
  getOffset() {
    return this.get("offset");
  }
  setOffset(offset) {
    return this.set("offset", offset);
  }
  getScale() {
    return this.get("scale");
  }
  setScale(scale2) {
    return this.set("scale", scale2);
  }
  getMax() {
    return this.get("max");
  }
  setMax(max) {
    return this.set("max", max);
  }
  getMin() {
    return this.get("min");
  }
  setMin(min) {
    return this.set("min", min);
  }
  getRequired() {
    return this.get("required");
  }
  setRequired(required) {
    return this.set("required", required);
  }
  getNoData() {
    return this.get("noData");
  }
  setNoData(noData) {
    return this.set("noData", noData);
  }
  getDefault() {
    return this.get("default");
  }
  setDefault(defaultValue) {
    return this.set("default", defaultValue);
  }
};
var Enum = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "Enum";
    this.parentTypes = ["Schema"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      description: "",
      valueType: "UINT16",
      values: new RefList()
    });
  }
  getDescription() {
    return this.get("description");
  }
  setDescription(description) {
    return this.set("description", description);
  }
  getValueType() {
    return this.get("valueType");
  }
  setValueType(valueType) {
    return this.set("valueType", valueType);
  }
  listValues() {
    return this.listRefs("values");
  }
  addEnumValue(enumValue) {
    return this.addRef("values", enumValue);
  }
  removeEnumValue(enumValue) {
    return this.removeRef("values", enumValue);
  }
};
var EnumValue = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "EnumValue";
    this.parentTypes = ["Enum"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { description: null });
  }
  getDescription() {
    return this.get("description");
  }
  setDescription(description) {
    return this.set("description", description);
  }
  getValue() {
    return this.get("value");
  }
  setValue(value) {
    return this.set("value", value);
  }
};
var PropertyTable = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "PropertyTable";
    this.parentTypes = ["StructuralMetadata"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { properties: new RefMap() });
  }
  getClass() {
    return this.get("class");
  }
  setClass(className) {
    return this.set("class", className);
  }
  getCount() {
    return this.get("count");
  }
  setCount(count) {
    return this.set("count", count);
  }
  setProperty(key, value) {
    return this.setRefMap("properties", key, value);
  }
  getProperty(key) {
    return this.getRefMap("properties", key);
  }
  listPropertyKeys() {
    return this.listRefMapKeys("properties");
  }
  listPropertyValues() {
    return this.listRefMapValues("properties");
  }
};
var PropertyTableProperty = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "PropertyTableProperty";
    this.parentTypes = ["PropertyTable"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      arrayOffsets: null,
      stringOffsets: null,
      arrayOffsetType: null,
      stringOffsetType: null,
      offset: null,
      scale: null,
      max: null,
      min: null
    });
  }
  getValues() {
    return this.get("values");
  }
  setValues(values) {
    return this.set("values", values);
  }
  getArrayOffsets() {
    return this.get("arrayOffsets");
  }
  setArrayOffsets(arrayOffsets) {
    return this.set("arrayOffsets", arrayOffsets);
  }
  getStringOffsets() {
    return this.get("stringOffsets");
  }
  setStringOffsets(stringOffsets) {
    return this.set("stringOffsets", stringOffsets);
  }
  getArrayOffsetType() {
    return this.get("arrayOffsetType");
  }
  setArrayOffsetType(arrayOffsetType) {
    return this.set("arrayOffsetType", arrayOffsetType);
  }
  getStringOffsetType() {
    return this.get("stringOffsetType");
  }
  setStringOffsetType(stringOffsetType) {
    return this.set("stringOffsetType", stringOffsetType);
  }
  getOffset() {
    return this.get("offset");
  }
  setOffset(offset) {
    return this.set("offset", offset);
  }
  getScale() {
    return this.get("scale");
  }
  setScale(scale2) {
    return this.set("scale", scale2);
  }
  getMax() {
    return this.get("max");
  }
  setMax(max) {
    return this.set("max", max);
  }
  getMin() {
    return this.get("min");
  }
  setMin(min) {
    return this.set("min", min);
  }
};
var PropertyTexture = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "PropertyTexture";
    this.parentTypes = ["StructuralMetadata"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { properties: new RefMap() });
  }
  getClass() {
    return this.get("class");
  }
  setClass(_class) {
    return this.set("class", _class);
  }
  setProperty(key, value) {
    return this.setRefMap("properties", key, value);
  }
  getProperty(key) {
    return this.getRefMap("properties", key);
  }
  listPropertyKeys() {
    return this.listRefMapKeys("properties");
  }
  listPropertyValues() {
    return this.listRefMapValues("properties");
  }
};
var PropertyTextureProperty = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "PropertyTextureProperty";
    this.parentTypes = ["PropertyTexture"];
  }
  getDefaults() {
    const defaultTextureInfo = new TextureInfo(this.graph, "textureInfo");
    defaultTextureInfo.setMinFilter(TextureInfo.MagFilter.NEAREST);
    defaultTextureInfo.setMagFilter(TextureInfo.MagFilter.NEAREST);
    return Object.assign(super.getDefaults(), {
      channels: [0],
      texture: null,
      textureInfo: defaultTextureInfo,
      offset: null,
      scale: null,
      max: null,
      min: null
    });
  }
  getChannels() {
    return this.get("channels");
  }
  setChannels(channels) {
    return this.set("channels", channels);
  }
  getTexture() {
    return this.getRef("texture");
  }
  setTexture(texture) {
    return this.setRef("texture", texture);
  }
  getTextureInfo() {
    return this.getRef("texture") ? this.getRef("textureInfo") : null;
  }
  getOffset() {
    return this.get("offset");
  }
  setOffset(offset) {
    return this.set("offset", offset);
  }
  getScale() {
    return this.get("scale");
  }
  setScale(scale2) {
    return this.set("scale", scale2);
  }
  getMax() {
    return this.get("max");
  }
  setMax(max) {
    return this.set("max", max);
  }
  getMin() {
    return this.get("min");
  }
  setMin(min) {
    return this.set("min", min);
  }
};
var PropertyAttribute = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "PropertyAttribute";
    this.parentTypes = ["StructuralMetadata"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { properties: new RefMap() });
  }
  getClass() {
    return this.get("class");
  }
  setClass(_class) {
    return this.set("class", _class);
  }
  setProperty(key, value) {
    return this.setRefMap("properties", key, value);
  }
  getProperty(key) {
    return this.getRefMap("properties", key);
  }
  listPropertyKeys() {
    return this.listRefMapKeys("properties");
  }
  listPropertyValues() {
    return this.listRefMapValues("properties");
  }
};
var PropertyAttributeProperty = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "PropertyAttributeProperty";
    this.parentTypes = ["PropertyAttribute"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      offset: null,
      scale: null,
      max: null,
      min: null
    });
  }
  getAttribute() {
    return this.get("attribute");
  }
  setAttribute(attribute) {
    return this.set("attribute", attribute);
  }
  getOffset() {
    return this.get("offset");
  }
  setOffset(offset) {
    return this.set("offset", offset);
  }
  getScale() {
    return this.get("scale");
  }
  setScale(scale2) {
    return this.set("scale", scale2);
  }
  getMax() {
    return this.get("max");
  }
  setMax(max) {
    return this.set("max", max);
  }
  getMin() {
    return this.get("min");
  }
  setMin(min) {
    return this.set("min", min);
  }
};
var NodeStructuralMetadata = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "NodeStructuralMetadata";
    this.parentTypes = [PropertyType.NODE];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      class: "",
      properties: {}
    });
  }
  getClass() {
    return this.get("class");
  }
  setClass(className) {
    return this.set("class", className);
  }
  getProperties() {
    return this.get("properties");
  }
  setProperties(properties) {
    return this.set("properties", properties);
  }
};
var MeshPrimitiveStructuralMetadata = class extends ExtensionProperty {
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  init() {
    this.extensionName = EXT_STRUCTURAL_METADATA;
    this.propertyType = "MeshPrimitiveStructuralMetadata";
    this.parentTypes = [PropertyType.PRIMITIVE];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      propertyTextures: new RefList(),
      propertyAttributes: new RefList()
    });
  }
  listPropertyTextures() {
    return this.listRefs("propertyTextures");
  }
  addPropertyTexture(propertyTexture) {
    return this.addRef("propertyTextures", propertyTexture);
  }
  removePropertyTexture(propertyTexture) {
    return this.removeRef("propertyTextures", propertyTexture);
  }
  listPropertyAttributes() {
    return this.listRefs("propertyAttributes");
  }
  addPropertyAttribute(propertyAttribute) {
    return this.addRef("propertyAttributes", propertyAttribute);
  }
  removePropertyAttribute(propertyAttribute) {
    return this.removeRef("propertyAttributes", propertyAttribute);
  }
};
var EXTStructuralMetadata = class extends Extension {
  extensionName = EXT_STRUCTURAL_METADATA;
  static EXTENSION_NAME = EXT_STRUCTURAL_METADATA;
  /**
  * Must preparate buffer data, because property tables directly
  * reference buffer views, not accessors.
  *
  * @hidden
  */
  prewriteTypes = [PropertyType.BUFFER];
  /**
  * Must read EXT_structural_metadata before EXT_mesh_features.
  *
  * @hidden
  */
  prereadTypes = [PropertyType.SCENE];
  createStructuralMetadata() {
    return new StructuralMetadata(this.document.getGraph());
  }
  createSchema() {
    return new Schema(this.document.getGraph());
  }
  createClass() {
    return new Class(this.document.getGraph());
  }
  createClassProperty() {
    return new ClassProperty(this.document.getGraph());
  }
  createEnum() {
    return new Enum(this.document.getGraph());
  }
  createEnumValue() {
    return new EnumValue(this.document.getGraph());
  }
  createPropertyTable() {
    return new PropertyTable(this.document.getGraph());
  }
  createPropertyTableProperty() {
    return new PropertyTableProperty(this.document.getGraph());
  }
  createPropertyTexture() {
    return new PropertyTexture(this.document.getGraph());
  }
  createPropertyTextureProperty() {
    return new PropertyTextureProperty(this.document.getGraph());
  }
  createPropertyAttribute() {
    return new PropertyAttribute(this.document.getGraph());
  }
  createPropertyAttributeProperty() {
    return new PropertyAttributeProperty(this.document.getGraph());
  }
  createNodeStructuralMetadata() {
    return new NodeStructuralMetadata(this.document.getGraph());
  }
  createMeshPrimitiveStructuralMetadata() {
    return new MeshPrimitiveStructuralMetadata(this.document.getGraph());
  }
  read(_context) {
    return this;
  }
  preread(context) {
    const root = this.document.getRoot();
    const { json } = context.jsonDoc;
    const structuralMetadataDef = json.extensions[EXT_STRUCTURAL_METADATA];
    const structuralMetadata = _readStructuralMetadata(this, context, structuralMetadataDef);
    root.setExtension(EXT_STRUCTURAL_METADATA, structuralMetadata);
    (json.meshes || []).forEach((meshDef, meshIndex) => {
      const primitives = context.meshes[meshIndex].listPrimitives();
      (meshDef.primitives || []).forEach((primDef, primIndex) => {
        const prim = primitives[primIndex];
        this._readPrimitive(structuralMetadata, prim, primDef);
      });
    });
    (json.nodes || []).forEach((nodeDef, nodeIndex) => {
      this._readNode(context.nodes[nodeIndex], nodeDef);
    });
    return this;
  }
  /** @hidden */
  _readPrimitive(structuralMetadata, prim, primDef) {
    if (!primDef.extensions || !primDef.extensions["EXT_structural_metadata"]) return;
    const meshPrimitiveStructuralMetadata = this.createMeshPrimitiveStructuralMetadata();
    const meshPrimitiveStructuralMetadataDef = primDef.extensions[EXT_STRUCTURAL_METADATA];
    const propertyTextures = structuralMetadata.listPropertyTextures();
    const propertyTextureIndexDefs = meshPrimitiveStructuralMetadataDef.propertyTextures || [];
    for (const propertyTextureIndexDef of propertyTextureIndexDefs) {
      const propertyTexture = propertyTextures[propertyTextureIndexDef];
      meshPrimitiveStructuralMetadata.addPropertyTexture(propertyTexture);
    }
    const propertyAttributes = structuralMetadata.listPropertyAttributes();
    const propertyAttributeIndexDefs = meshPrimitiveStructuralMetadataDef.propertyAttributes || [];
    for (const propertyAttributeIndexDef of propertyAttributeIndexDefs) {
      const propertyAttribute = propertyAttributes[propertyAttributeIndexDef];
      meshPrimitiveStructuralMetadata.addPropertyAttribute(propertyAttribute);
    }
    prim.setExtension(EXT_STRUCTURAL_METADATA, meshPrimitiveStructuralMetadata);
  }
  /** @hidden */
  _readNode(node, nodeDef) {
    if (!nodeDef.extensions || !nodeDef.extensions["EXT_structural_metadata"]) return;
    const nodeStructuralMetadataDef = nodeDef.extensions[EXT_STRUCTURAL_METADATA];
    const nodeStructuralMetadata = this.createNodeStructuralMetadata().setClass(nodeStructuralMetadataDef.class).setProperties(nodeStructuralMetadataDef.properties);
    node.setExtension(EXT_STRUCTURAL_METADATA, nodeStructuralMetadata);
  }
  write(context) {
    const root = this.document.getRoot();
    const structuralMetadata = root.getExtension(EXT_STRUCTURAL_METADATA);
    if (!structuralMetadata) return this;
    const gltfDef = context.jsonDoc.json;
    const structuralMetadataDef = _writeStructuralMetadataDef(context, structuralMetadata);
    gltfDef.extensions = gltfDef.extensions || {};
    gltfDef.extensions[EXT_STRUCTURAL_METADATA] = structuralMetadataDef;
    const meshes = root.listMeshes();
    const meshDefs = gltfDef.meshes;
    if (meshDefs) for (const mesh of meshes) {
      const meshDef = meshDefs[context.meshIndexMap.get(mesh)];
      mesh.listPrimitives().forEach((prim, primIndex) => {
        const primDef = meshDef.primitives[primIndex];
        this._writePrimitive(structuralMetadata, prim, primDef);
      });
    }
    const nodes = root.listNodes();
    const nodeDefs = gltfDef.nodes;
    if (nodeDefs) for (const node of nodes) {
      const nodeIndex = context.nodeIndexMap.get(node);
      this._writeNode(node, nodeDefs[nodeIndex]);
    }
    return this;
  }
  /** @hidden */
  _writePrimitive(structuralMetadata, prim, primDef) {
    const meshPrimitiveStructuralMetadata = prim.getExtension(EXT_STRUCTURAL_METADATA);
    if (!meshPrimitiveStructuralMetadata) return;
    const globalPropertyTextures = structuralMetadata.listPropertyTextures();
    const globalPropertyAttributes = structuralMetadata.listPropertyAttributes();
    let propertyTextureDefs;
    let propertyAttributeDefs;
    const propertyTextures = meshPrimitiveStructuralMetadata.listPropertyTextures();
    if (propertyTextures.length > 0) {
      propertyTextureDefs = [];
      for (const propertyTexture of propertyTextures) {
        const index = globalPropertyTextures.indexOf(propertyTexture);
        if (index >= 0) propertyTextureDefs.push(index);
        else throw new Error(`${EXT_STRUCTURAL_METADATA}: Invalid property texture in mesh primitive`);
      }
    }
    const propertyAttributes = meshPrimitiveStructuralMetadata.listPropertyAttributes();
    if (propertyAttributes.length > 0) {
      propertyAttributeDefs = [];
      for (const propertyAttribute of propertyAttributes) {
        const index = globalPropertyAttributes.indexOf(propertyAttribute);
        if (index >= 0) propertyAttributeDefs.push(index);
        else throw new Error(`${EXT_STRUCTURAL_METADATA}: Invalid property attribute in mesh primitive`);
      }
    }
    const meshPrimitiveStructuralMetadataDef = {
      propertyTextures: propertyTextureDefs,
      propertyAttributes: propertyAttributeDefs
    };
    primDef.extensions = primDef.extensions || {};
    primDef.extensions[EXT_STRUCTURAL_METADATA] = meshPrimitiveStructuralMetadataDef;
  }
  /** @hidden */
  _writeNode(node, nodeDef) {
    const nodeStructuralMetadata = node.getExtension("EXT_structural_metadata");
    if (!nodeStructuralMetadata) return;
    nodeDef.extensions = nodeDef.extensions || {};
    nodeDef.extensions[EXT_STRUCTURAL_METADATA] = {
      class: nodeStructuralMetadata.getClass(),
      properties: nodeStructuralMetadata.getProperties()
    };
  }
  prewrite(context, propertyType) {
    if (propertyType === PropertyType.BUFFER) this._prewriteBuffers(context);
    return this;
  }
  /**
  * Collects all buffer views that are referred to by the property tables, and
  * store them as "otherBufferViews" of the writer context (for the main
  * buffer), to make sure that they are part of the buffer when it is
  * eventually written in Writer.ts.
  *
  * @hidden
  */
  _prewriteBuffers(context) {
    const document2 = this.document;
    const structuralMetadata = document2.getRoot().getExtension(EXT_STRUCTURAL_METADATA);
    context.jsonDoc.json.bufferViews ||= [];
    for (const propertyTable of structuralMetadata.listPropertyTables()) for (const propertyValue of propertyTable.listPropertyValues()) {
      const otherBufferViews = getOrCreateOtherBufferViews(document2, context);
      otherBufferViews.push(propertyValue.getValues());
      const arrayOffsets = propertyValue.getArrayOffsets();
      if (arrayOffsets) otherBufferViews.push(arrayOffsets);
      const stringOffsets = propertyValue.getStringOffsets();
      if (stringOffsets) otherBufferViews.push(stringOffsets);
    }
  }
};
function _readStructuralMetadata(ext, context, structuralMetadataDef) {
  const structuralMetadata = ext.createStructuralMetadata();
  if (structuralMetadataDef.schema !== void 0) {
    const schema = _readSchema(ext, structuralMetadataDef.schema);
    structuralMetadata.setSchema(schema);
  } else if (structuralMetadataDef.schemaUri) {
    const schemaUri = structuralMetadataDef.schemaUri;
    structuralMetadata.setSchemaUri(schemaUri);
  }
  const propertyTextureDefs = structuralMetadataDef.propertyTextures || [];
  for (const propertyTextureDef of propertyTextureDefs) {
    const propertyTexture = _readPropertyTexture(ext, context, propertyTextureDef);
    structuralMetadata.addPropertyTexture(propertyTexture);
  }
  const propertyTableDefs = structuralMetadataDef.propertyTables || [];
  for (const propertyTableDef of propertyTableDefs) {
    const propertyTable = _readPropertyTable(ext, context, propertyTableDef);
    structuralMetadata.addPropertyTable(propertyTable);
  }
  const propertyAttributeDefs = structuralMetadataDef.propertyAttributes || [];
  for (const propertyAttributeDef of propertyAttributeDefs) {
    const propertyAttribute = _readPropertyAttribute(ext, propertyAttributeDef);
    structuralMetadata.addPropertyAttribute(propertyAttribute);
  }
  return structuralMetadata;
}
function _readSchema(ext, schemaDef) {
  const schema = ext.createSchema().setId(schemaDef.id);
  if (schemaDef.name !== void 0) schema.setName(schemaDef.name);
  if (schemaDef.description !== void 0) schema.setDescription(schemaDef.description);
  if (schemaDef.version !== void 0) schema.setVersion(schemaDef.version);
  const classes = schemaDef.classes || {};
  for (const classKey of Object.keys(classes)) {
    const classDef = classes[classKey];
    schema.setClass(classKey, _readClass(ext, classDef));
  }
  const enums = schemaDef.enums || {};
  for (const enumKey of Object.keys(enums)) schema.setEnum(enumKey, _readEnum(ext, enums[enumKey]));
  return schema;
}
function _readClass(ext, classDef) {
  const classObject = ext.createClass();
  if (classDef.name !== void 0) classObject.setName(classDef.name);
  if (classDef.description !== void 0) classObject.setDescription(classDef.description);
  const properties = classDef.properties || {};
  for (const classPropertyKey of Object.keys(properties)) {
    const classProperty = _readClassProperty(ext, properties[classPropertyKey]);
    classObject.setProperty(classPropertyKey, classProperty);
  }
  return classObject;
}
function _readClassProperty(ext, classPropertyDef) {
  const classProperty = ext.createClassProperty().setType(classPropertyDef.type);
  if (classPropertyDef.name !== void 0) classProperty.setName(classPropertyDef.name);
  if (classPropertyDef.description !== void 0) classProperty.setDescription(classPropertyDef.description);
  if (classPropertyDef.componentType !== void 0) classProperty.setComponentType(classPropertyDef.componentType);
  if (classPropertyDef.enumType !== void 0) classProperty.setEnumType(classPropertyDef.enumType);
  if (classPropertyDef.array !== void 0) classProperty.setArray(classPropertyDef.array);
  if (classPropertyDef.count !== void 0) classProperty.setCount(classPropertyDef.count);
  if (classPropertyDef.normalized !== void 0) classProperty.setNormalized(classPropertyDef.normalized);
  if (classPropertyDef.offset !== void 0) classProperty.setOffset(classPropertyDef.offset);
  if (classPropertyDef.scale !== void 0) classProperty.setScale(classPropertyDef.scale);
  if (classPropertyDef.max !== void 0) classProperty.setMax(classPropertyDef.max);
  if (classPropertyDef.min !== void 0) classProperty.setMin(classPropertyDef.min);
  if (classPropertyDef.required !== void 0) classProperty.setRequired(classPropertyDef.required);
  if (classPropertyDef.noData !== void 0) classProperty.setNoData(classPropertyDef.noData);
  if (classPropertyDef.default !== void 0) classProperty.setDefault(classPropertyDef.default);
  return classProperty;
}
function _readEnum(ext, enumDef) {
  const enumObject = ext.createEnum();
  if (enumDef.name !== void 0) enumObject.setName(enumDef.name);
  if (enumDef.description !== void 0) enumObject.setDescription(enumDef.description);
  if (enumDef.valueType !== void 0) enumObject.setValueType(enumDef.valueType);
  const valueDefs = enumDef.values || {};
  for (const valueDef of valueDefs) enumObject.addEnumValue(_readEnumValue(ext, valueDef));
  return enumObject;
}
function _readEnumValue(ext, enumValueDef) {
  const enumValue = ext.createEnumValue();
  if (enumValueDef.name !== void 0) enumValue.setName(enumValueDef.name);
  if (enumValueDef.description !== void 0) enumValue.setDescription(enumValueDef.description);
  if (enumValueDef.value !== void 0) enumValue.setValue(enumValueDef.value);
  return enumValue;
}
function _readPropertyTexture(ext, context, propertyTextureDef) {
  const propertyTexture = ext.createPropertyTexture();
  propertyTexture.setClass(propertyTextureDef.class);
  if (propertyTextureDef.name !== void 0) propertyTexture.setName(propertyTextureDef.name);
  const properties = propertyTextureDef.properties || {};
  for (const propertyKey of Object.keys(properties)) {
    const propertyTextureProperty = _readPropertyTextureProperty(ext, context, properties[propertyKey]);
    propertyTexture.setProperty(propertyKey, propertyTextureProperty);
  }
  return propertyTexture;
}
function _readPropertyTextureProperty(ext, context, propertyTexturePropertyDef) {
  const propertyTextureProperty = ext.createPropertyTextureProperty();
  const textureDefs = context.jsonDoc.json.textures || [];
  if (propertyTexturePropertyDef.channels) propertyTextureProperty.setChannels(propertyTexturePropertyDef.channels);
  const source = textureDefs[propertyTexturePropertyDef.index].source;
  if (source !== void 0) {
    const texture = context.textures[source];
    propertyTextureProperty.setTexture(texture);
    const textureInfo = propertyTextureProperty.getTextureInfo();
    if (textureInfo) context.setTextureInfo(textureInfo, propertyTexturePropertyDef);
  }
  if (propertyTexturePropertyDef.offset !== void 0) propertyTextureProperty.setOffset(propertyTexturePropertyDef.offset);
  if (propertyTexturePropertyDef.scale !== void 0) propertyTextureProperty.setScale(propertyTexturePropertyDef.scale);
  if (propertyTexturePropertyDef.max !== void 0) propertyTextureProperty.setMax(propertyTexturePropertyDef.max);
  if (propertyTexturePropertyDef.min !== void 0) propertyTextureProperty.setMin(propertyTexturePropertyDef.min);
  return propertyTextureProperty;
}
function _readPropertyTable(ext, context, propertyTableDef) {
  const propertyTable = ext.createPropertyTable().setClass(propertyTableDef.class).setCount(propertyTableDef.count);
  if (propertyTableDef.name !== void 0) propertyTable.setName(propertyTableDef.name);
  const properties = propertyTableDef.properties || {};
  for (const propertyKey of Object.keys(properties)) {
    const propertyTableProperty = _readPropertyTableProperty(ext, context, properties[propertyKey]);
    propertyTable.setProperty(propertyKey, propertyTableProperty);
  }
  return propertyTable;
}
function _readPropertyTableProperty(ext, context, propertyTablePropertyDef) {
  const propertyTableProperty = ext.createPropertyTableProperty();
  const values = getBufferViewData(context, propertyTablePropertyDef.values);
  propertyTableProperty.setValues(values);
  if (propertyTablePropertyDef.arrayOffsets !== void 0) {
    const arrayOffsetsData = getBufferViewData(context, propertyTablePropertyDef.arrayOffsets);
    propertyTableProperty.setArrayOffsets(arrayOffsetsData);
  }
  if (propertyTablePropertyDef.stringOffsets !== void 0) {
    const stringOffsetsData = getBufferViewData(context, propertyTablePropertyDef.stringOffsets);
    propertyTableProperty.setStringOffsets(stringOffsetsData);
  }
  if (propertyTablePropertyDef.arrayOffsetType !== void 0) propertyTableProperty.setArrayOffsetType(propertyTablePropertyDef.arrayOffsetType);
  if (propertyTablePropertyDef.stringOffsetType !== void 0) propertyTableProperty.setStringOffsetType(propertyTablePropertyDef.stringOffsetType);
  if (propertyTablePropertyDef.offset !== void 0) propertyTableProperty.setOffset(propertyTablePropertyDef.offset);
  if (propertyTablePropertyDef.scale !== void 0) propertyTableProperty.setScale(propertyTablePropertyDef.scale);
  if (propertyTablePropertyDef.max !== void 0) propertyTableProperty.setMax(propertyTablePropertyDef.max);
  if (propertyTablePropertyDef.min !== void 0) propertyTableProperty.setMin(propertyTablePropertyDef.min);
  return propertyTableProperty;
}
function _readPropertyAttribute(ext, propertyAttributeDef) {
  const propertyAttribute = ext.createPropertyAttribute();
  propertyAttribute.setClass(propertyAttributeDef.class);
  if (propertyAttributeDef.name !== void 0) propertyAttribute.setName(propertyAttributeDef.name);
  const properties = propertyAttributeDef.properties || {};
  for (const propertyKey of Object.keys(properties)) {
    const propertyAttributeProperty = _readPropertyAttributeProperty(ext, properties[propertyKey]);
    propertyAttribute.setProperty(propertyKey, propertyAttributeProperty);
  }
  return propertyAttribute;
}
function _readPropertyAttributeProperty(ext, propertyAttributePropertyDef) {
  const propertyAttributeProperty = ext.createPropertyAttributeProperty();
  propertyAttributeProperty.setAttribute(propertyAttributePropertyDef.attribute);
  if (propertyAttributePropertyDef.offset !== void 0) propertyAttributeProperty.setOffset(propertyAttributePropertyDef.offset);
  if (propertyAttributePropertyDef.scale !== void 0) propertyAttributeProperty.setScale(propertyAttributePropertyDef.scale);
  if (propertyAttributePropertyDef.max !== void 0) propertyAttributeProperty.setMax(propertyAttributePropertyDef.max);
  if (propertyAttributePropertyDef.min !== void 0) propertyAttributeProperty.setMin(propertyAttributePropertyDef.min);
  return propertyAttributeProperty;
}
function _writeStructuralMetadataDef(context, structuralMetadata) {
  const structuralMetadataDef = {};
  const schema = structuralMetadata.getSchema();
  if (schema) structuralMetadataDef.schema = _writeSchemaDef(schema);
  const schemaUri = structuralMetadata.getSchemaUri();
  if (schemaUri) structuralMetadataDef.schemaUri = schemaUri;
  const propertyTables = structuralMetadata.listPropertyTables();
  if (propertyTables.length > 0) {
    const propertyTableDefs = [];
    for (const propertyTable of propertyTables) {
      const propertyTableDef = _writePropertyTableDef(context, propertyTable);
      propertyTableDefs.push(propertyTableDef);
    }
    structuralMetadataDef.propertyTables = propertyTableDefs;
  }
  const propertyTextures = structuralMetadata.listPropertyTextures();
  if (propertyTextures.length > 0) {
    const propertyTextureDefs = [];
    for (const propertyTexture of propertyTextures) {
      const propertyTextureDef = _writePropertyTextureDef(context, propertyTexture);
      propertyTextureDefs.push(propertyTextureDef);
    }
    structuralMetadataDef.propertyTextures = propertyTextureDefs;
  }
  const propertyAttributes = structuralMetadata.listPropertyAttributes();
  if (propertyAttributes.length > 0) {
    const propertyAttributeDefs = [];
    for (const propertyAttribute of propertyAttributes) {
      const propertyAttributeDef = _writePropertyAttributeDef(propertyAttribute);
      propertyAttributeDefs.push(propertyAttributeDef);
    }
    structuralMetadataDef.propertyAttributes = propertyAttributeDefs;
  }
  return structuralMetadataDef;
}
function _writeSchemaDef(schema) {
  const schemaDef = { id: schema.getId() };
  const classKeys = schema.listClassKeys();
  if (classKeys.length > 0) {
    schemaDef.classes = {};
    for (const classKey of classKeys) {
      const classDef = _writeClassDef(schema.getClass(classKey));
      schemaDef.classes[classKey] = classDef;
    }
  }
  const enumKeys = schema.listEnumKeys();
  if (enumKeys.length > 0) {
    schemaDef.enums = {};
    for (const enumKey of enumKeys) {
      const enumDef = _writeEnumDef(schema.getEnum(enumKey));
      schemaDef.enums[enumKey] = enumDef;
    }
  }
  if (schema.getName()) schemaDef.name = schema.getName();
  if (schema.getDescription()) schemaDef.description = schema.getDescription();
  if (schema.getVersion()) schemaDef.version = schema.getVersion();
  return schemaDef;
}
function _writeClassDef(classObject) {
  const classDef = {};
  const propertyKeys = classObject.listPropertyKeys();
  if (propertyKeys.length > 0) {
    classDef.properties = {};
    for (const propertyKey of propertyKeys) {
      const propertyObject = classObject.getProperty(propertyKey);
      classDef.properties[propertyKey] = _writeClassPropertyDef(propertyObject);
    }
  }
  if (classObject.getName()) classDef.name = classObject.getName();
  if (classObject.getDescription()) classDef.description = classObject.getDescription();
  return classDef;
}
function _writeClassPropertyDef(classProperty) {
  const classPropertyDef = { type: classProperty.getType() };
  if (classProperty.getArray()) classPropertyDef.array = classProperty.getArray();
  if (classProperty.getNormalized()) classPropertyDef.normalized = classProperty.getNormalized();
  if (classProperty.getRequired()) classPropertyDef.required = classProperty.getRequired();
  if (classProperty.getName()) classPropertyDef.name = classProperty.getName();
  if (classProperty.getDescription()) classPropertyDef.description = classProperty.getDescription();
  if (classProperty.getComponentType() != null) classPropertyDef.componentType = classProperty.getComponentType();
  if (classProperty.getEnumType() != null) classPropertyDef.enumType = classProperty.getEnumType();
  if (classProperty.getCount() != null) classPropertyDef.count = classProperty.getCount();
  if (classProperty.getOffset() != null) classPropertyDef.offset = classProperty.getOffset();
  if (classProperty.getScale() != null) classPropertyDef.scale = classProperty.getScale();
  if (classProperty.getMax() != null) classPropertyDef.max = classProperty.getMax();
  if (classProperty.getMin() != null) classPropertyDef.min = classProperty.getMin();
  if (classProperty.getNoData() != null) classPropertyDef.noData = classProperty.getNoData();
  if (classProperty.getDefault() != null) classPropertyDef.default = classProperty.getDefault();
  return classPropertyDef;
}
function _writeEnumDef(enumObject) {
  const enumDef = { values: enumObject.listValues().map(_writeEnumValueDef) };
  if (enumObject.getName()) enumDef.name = enumObject.getName();
  if (enumObject.getDescription()) enumDef.description = enumObject.getDescription();
  if (enumObject.getValueType() !== "UINT16") enumDef.valueType = enumObject.getValueType();
  return enumDef;
}
function _writeEnumValueDef(enumValue) {
  const enumValueDef = {
    name: enumValue.getName(),
    value: enumValue.getValue()
  };
  if (enumValue.getDescription()) enumValueDef.description = enumValue.getDescription();
  return enumValueDef;
}
function _writePropertyTableDef(context, propertyTable) {
  const propertyTableDef = {
    class: propertyTable.getClass(),
    count: propertyTable.getCount()
  };
  if (propertyTable.getName()) propertyTableDef.name = propertyTable.getName();
  const propertyKeys = propertyTable.listPropertyKeys();
  if (propertyKeys.length > 0) {
    propertyTableDef.properties = {};
    for (const propertyKey of propertyKeys) {
      const propertyTablePropertyDef = _writePropertyTablePropertyDef(context, propertyTable.getProperty(propertyKey));
      propertyTableDef.properties[propertyKey] = propertyTablePropertyDef;
    }
  }
  return propertyTableDef;
}
function _writePropertyTablePropertyDef(context, propertyTableProperty) {
  const values = propertyTableProperty.getValues();
  const propertyTablePropertyDef = { values: context.otherBufferViewsIndexMap.get(values) };
  if (propertyTableProperty.getArrayOffsets()) {
    const arrayOffsets = propertyTableProperty.getArrayOffsets();
    propertyTablePropertyDef.arrayOffsets = context.otherBufferViewsIndexMap.get(arrayOffsets);
  }
  if (propertyTableProperty.getStringOffsets()) {
    const stringOffsets = propertyTableProperty.getStringOffsets();
    propertyTablePropertyDef.stringOffsets = context.otherBufferViewsIndexMap.get(stringOffsets);
  }
  if (propertyTableProperty.getArrayOffsetType() != null) propertyTablePropertyDef.arrayOffsetType = propertyTableProperty.getArrayOffsetType();
  if (propertyTableProperty.getStringOffsetType() != null) propertyTablePropertyDef.stringOffsetType = propertyTableProperty.getStringOffsetType();
  if (propertyTableProperty.getOffset() != null) propertyTablePropertyDef.offset = propertyTableProperty.getOffset();
  if (propertyTableProperty.getScale() != null) propertyTablePropertyDef.scale = propertyTableProperty.getScale();
  if (propertyTableProperty.getMax() != null) propertyTablePropertyDef.max = propertyTableProperty.getMax();
  if (propertyTableProperty.getMin() != null) propertyTablePropertyDef.min = propertyTableProperty.getMin();
  return propertyTablePropertyDef;
}
function _writePropertyAttributeDef(propertyAttribute) {
  const propertyAttributeDef = { class: propertyAttribute.getClass() };
  if (propertyAttribute.getName()) propertyAttributeDef.name = propertyAttribute.getName();
  const propertyKeys = propertyAttribute.listPropertyKeys();
  if (propertyKeys.length > 0) {
    propertyAttributeDef.properties = {};
    for (const propertyKey of propertyKeys) {
      const propertyAttributePropertyDef = _writePropertyAttributePropertyDef(propertyAttribute.getProperty(propertyKey));
      propertyAttributeDef.properties[propertyKey] = propertyAttributePropertyDef;
    }
  }
  return propertyAttributeDef;
}
function _writePropertyAttributePropertyDef(propertyAttributeProperty) {
  const propertyAttributePropertyDef = { attribute: propertyAttributeProperty.getAttribute() };
  if (propertyAttributeProperty.getOffset() != null) propertyAttributePropertyDef.offset = propertyAttributeProperty.getOffset();
  if (propertyAttributeProperty.getScale() != null) propertyAttributePropertyDef.scale = propertyAttributeProperty.getScale();
  if (propertyAttributeProperty.getMax() != null) propertyAttributePropertyDef.max = propertyAttributeProperty.getMax();
  if (propertyAttributeProperty.getMin() != null) propertyAttributePropertyDef.min = propertyAttributeProperty.getMin();
  return propertyAttributePropertyDef;
}
function _writePropertyTextureDef(context, propertyTexture) {
  const propertyTextureDef = { class: propertyTexture.getClass() };
  if (propertyTexture.getName()) propertyTextureDef.name = propertyTexture.getName();
  const propertyKeys = propertyTexture.listPropertyKeys();
  if (propertyKeys.length > 0) {
    propertyTextureDef.properties = {};
    for (const propertyKey of propertyKeys) {
      const propertyTexturePropertyDef = _writePropertyTexturePropertyDef(context, propertyTexture.getProperty(propertyKey));
      propertyTextureDef.properties[propertyKey] = propertyTexturePropertyDef;
    }
  }
  return propertyTextureDef;
}
function _writePropertyTexturePropertyDef(context, propertyTextureProperty) {
  const texture = propertyTextureProperty.getTexture();
  const textureInfo = propertyTextureProperty.getTextureInfo();
  const channels = propertyTextureProperty.getChannels();
  const textureInfoDef = context.createTextureInfoDef(texture, textureInfo);
  if (!MathUtils.eq(channels, [0])) textureInfoDef.channels = channels;
  if (propertyTextureProperty.getOffset() != null) textureInfoDef.offset = propertyTextureProperty.getOffset();
  if (propertyTextureProperty.getScale() != null) textureInfoDef.scale = propertyTextureProperty.getScale();
  if (propertyTextureProperty.getMax() != null) textureInfoDef.max = propertyTextureProperty.getMax();
  if (propertyTextureProperty.getMin() != null) textureInfoDef.min = propertyTextureProperty.getMin();
  return textureInfoDef;
}
function getBufferViewData(context, bufferViewIndex) {
  const jsonDoc = context.jsonDoc;
  const bufferDefs = jsonDoc.json.buffers || [];
  const bufferViewDef = (jsonDoc.json.bufferViews || [])[bufferViewIndex];
  const bufferDef = bufferDefs[bufferViewDef.buffer];
  const bufferData = bufferDef.uri ? jsonDoc.resources[bufferDef.uri] : jsonDoc.resources[GLB_BUFFER];
  const byteOffset = bufferViewDef.byteOffset || 0;
  const byteLength = bufferViewDef.byteLength;
  return bufferData.slice(byteOffset, byteOffset + byteLength);
}
function getOrCreateOtherBufferViews(document2, context) {
  const buffer = document2.getRoot().listBuffers()[0];
  let otherBufferViews = context.otherBufferViews.get(buffer);
  if (!otherBufferViews) {
    otherBufferViews = [];
    context.otherBufferViews.set(buffer, otherBufferViews);
  }
  return otherBufferViews;
}
var AVIFImageUtils = class {
  match(array) {
    return array.length >= 12 && BufferUtils.decodeText(array.slice(4, 12)) === "ftypavif";
  }
  /**
  * Probes size of AVIF or HEIC image. Assumes a single static image, without
  * orientation or other metadata that would affect dimensions.
  */
  getSize(array) {
    if (!this.match(array)) return null;
    const view = new DataView(array.buffer, array.byteOffset, array.byteLength);
    let box = unbox(view, 0);
    if (!box) return null;
    let offset = box.end;
    while (box = unbox(view, offset)) if (box.type === "meta") offset = box.start + 4;
    else if (box.type === "iprp" || box.type === "ipco") offset = box.start;
    else if (box.type === "ispe") return [view.getUint32(box.start + 4), view.getUint32(box.start + 8)];
    else if (box.type === "mdat") break;
    else offset = box.end;
    return null;
  }
  getChannels(_buffer) {
    return 4;
  }
};
var EXTTextureAVIF = class extends Extension {
  extensionName = EXT_TEXTURE_AVIF;
  /** @hidden */
  prereadTypes = [PropertyType.TEXTURE];
  static EXTENSION_NAME = EXT_TEXTURE_AVIF;
  /** @hidden */
  static register() {
    ImageUtils.registerFormat("image/avif", new AVIFImageUtils());
  }
  /** @hidden */
  preread(context) {
    (context.jsonDoc.json.textures || []).forEach((textureDef) => {
      if (textureDef.extensions && textureDef.extensions["EXT_texture_avif"]) textureDef.source = textureDef.extensions[EXT_TEXTURE_AVIF].source;
    });
    return this;
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listTextures().forEach((texture) => {
      if (texture.getMimeType() === "image/avif") {
        const imageIndex = context.imageIndexMap.get(texture);
        (jsonDoc.json.textures || []).forEach((textureDef) => {
          if (textureDef.source === imageIndex) {
            textureDef.extensions = textureDef.extensions || {};
            textureDef.extensions[EXT_TEXTURE_AVIF] = { source: textureDef.source };
            delete textureDef.source;
          }
        });
      }
    });
    return this;
  }
};
function unbox(data, offset) {
  if (data.byteLength < 4 + offset) return null;
  const size = data.getUint32(offset);
  if (data.byteLength < size + offset || size < 8) return null;
  return {
    type: BufferUtils.decodeText(new Uint8Array(data.buffer, data.byteOffset + offset + 4, 4)),
    start: offset + 8,
    end: offset + size
  };
}
var WEBPImageUtils = class {
  match(array) {
    return array.length >= 12 && array[8] === 87 && array[9] === 69 && array[10] === 66 && array[11] === 80;
  }
  getSize(array) {
    const RIFF = BufferUtils.decodeText(array.slice(0, 4));
    const WEBP = BufferUtils.decodeText(array.slice(8, 12));
    if (RIFF !== "RIFF" || WEBP !== "WEBP") return null;
    const view = new DataView(array.buffer, array.byteOffset);
    let offset = 12;
    while (offset < view.byteLength) {
      const chunkId = BufferUtils.decodeText(new Uint8Array([
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      ]));
      const chunkByteLength = view.getUint32(offset + 4, true);
      if (chunkId === "VP8 ") return [view.getInt16(offset + 14, true) & 16383, view.getInt16(offset + 16, true) & 16383];
      else if (chunkId === "VP8L") {
        const b0 = view.getUint8(offset + 9);
        const b1 = view.getUint8(offset + 10);
        const b2 = view.getUint8(offset + 11);
        const b3 = view.getUint8(offset + 12);
        return [1 + ((b1 & 63) << 8 | b0), 1 + ((b3 & 15) << 10 | b2 << 2 | (b1 & 192) >> 6)];
      }
      offset += 8 + chunkByteLength + chunkByteLength % 2;
    }
    return null;
  }
  getChannels(_buffer) {
    return 4;
  }
};
var EXTTextureWebP = class extends Extension {
  extensionName = EXT_TEXTURE_WEBP;
  /** @hidden */
  prereadTypes = [PropertyType.TEXTURE];
  static EXTENSION_NAME = EXT_TEXTURE_WEBP;
  /** @hidden */
  static register() {
    ImageUtils.registerFormat("image/webp", new WEBPImageUtils());
  }
  /** @hidden */
  preread(context) {
    (context.jsonDoc.json.textures || []).forEach((textureDef) => {
      if (textureDef.extensions && textureDef.extensions["EXT_texture_webp"]) textureDef.source = textureDef.extensions[EXT_TEXTURE_WEBP].source;
    });
    return this;
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listTextures().forEach((texture) => {
      if (texture.getMimeType() === "image/webp") {
        const imageIndex = context.imageIndexMap.get(texture);
        (jsonDoc.json.textures || []).forEach((textureDef) => {
          if (textureDef.source === imageIndex) {
            textureDef.extensions = textureDef.extensions || {};
            textureDef.extensions[EXT_TEXTURE_WEBP] = { source: textureDef.source };
            delete textureDef.source;
          }
        });
      }
    });
    return this;
  }
};
var NAME$1 = KHR_ACCESSOR_FLOAT16;
var KHRAccessorFloat16 = class extends Extension {
  extensionName = NAME$1;
  static EXTENSION_NAME = NAME$1;
  /** @hidden */
  read(_) {
    return this;
  }
  /** @hidden */
  write(_) {
    return this;
  }
};
var NAME = KHR_ACCESSOR_FLOAT64;
var KHRAccessorFloat64 = class extends Extension {
  extensionName = NAME;
  static EXTENSION_NAME = NAME;
  /** @hidden */
  read(_) {
    return this;
  }
  /** @hidden */
  write(_) {
    return this;
  }
};
var decoderModule;
var COMPONENT_ARRAY;
var DATA_TYPE;
function decodeGeometry(decoder, data) {
  const buffer = new decoderModule.DecoderBuffer();
  try {
    buffer.Init(data, data.length);
    if (decoder.GetEncodedGeometryType(buffer) !== decoderModule.TRIANGULAR_MESH) throw new Error(`[${KHR_DRACO_MESH_COMPRESSION}] Unknown geometry type.`);
    const dracoMesh = new decoderModule.Mesh();
    if (!decoder.DecodeBufferToMesh(buffer, dracoMesh).ok() || dracoMesh.ptr === 0) throw new Error(`[${KHR_DRACO_MESH_COMPRESSION}] Decoding failure.`);
    return dracoMesh;
  } finally {
    decoderModule.destroy(buffer);
  }
}
function decodeIndex(decoder, mesh) {
  const numIndices = mesh.num_faces() * 3;
  let ptr;
  let indices;
  if (mesh.num_points() <= 65534) {
    const byteLength = numIndices * Uint16Array.BYTES_PER_ELEMENT;
    ptr = decoderModule._malloc(byteLength);
    decoder.GetTrianglesUInt16Array(mesh, byteLength, ptr);
    indices = new Uint16Array(decoderModule.HEAPU16.buffer, ptr, numIndices).slice();
  } else {
    const byteLength = numIndices * Uint32Array.BYTES_PER_ELEMENT;
    ptr = decoderModule._malloc(byteLength);
    decoder.GetTrianglesUInt32Array(mesh, byteLength, ptr);
    indices = new Uint32Array(decoderModule.HEAPU32.buffer, ptr, numIndices).slice();
  }
  decoderModule._free(ptr);
  return indices;
}
function decodeAttribute(decoder, mesh, attribute, accessorDef) {
  const dataType = DATA_TYPE[accessorDef.componentType];
  const ArrayCtor = COMPONENT_ARRAY[accessorDef.componentType];
  const numComponents = attribute.num_components();
  const numValues = mesh.num_points() * numComponents;
  const byteLength = numValues * ArrayCtor.BYTES_PER_ELEMENT;
  const ptr = decoderModule._malloc(byteLength);
  decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, dataType, byteLength, ptr);
  const array = new ArrayCtor(decoderModule.HEAPF32.buffer, ptr, numValues).slice();
  decoderModule._free(ptr);
  return array;
}
function initDecoderModule(_decoderModule) {
  decoderModule = _decoderModule;
  COMPONENT_ARRAY = {
    [Accessor.ComponentType.FLOAT]: Float32Array,
    [Accessor.ComponentType.UNSIGNED_INT]: Uint32Array,
    [Accessor.ComponentType.UNSIGNED_SHORT]: Uint16Array,
    [Accessor.ComponentType.UNSIGNED_BYTE]: Uint8Array,
    [Accessor.ComponentType.SHORT]: Int16Array,
    [Accessor.ComponentType.BYTE]: Int8Array
  };
  DATA_TYPE = {
    [Accessor.ComponentType.FLOAT]: decoderModule.DT_FLOAT32,
    [Accessor.ComponentType.UNSIGNED_INT]: decoderModule.DT_UINT32,
    [Accessor.ComponentType.UNSIGNED_SHORT]: decoderModule.DT_UINT16,
    [Accessor.ComponentType.UNSIGNED_BYTE]: decoderModule.DT_UINT8,
    [Accessor.ComponentType.SHORT]: decoderModule.DT_INT16,
    [Accessor.ComponentType.BYTE]: decoderModule.DT_INT8
  };
}
var encoderModule;
var EncoderMethod = /* @__PURE__ */ (function(EncoderMethod2) {
  EncoderMethod2[EncoderMethod2["EDGEBREAKER"] = 1] = "EDGEBREAKER";
  EncoderMethod2[EncoderMethod2["SEQUENTIAL"] = 0] = "SEQUENTIAL";
  return EncoderMethod2;
})({});
var AttributeEnum = /* @__PURE__ */ (function(AttributeEnum2) {
  AttributeEnum2["POSITION"] = "POSITION";
  AttributeEnum2["NORMAL"] = "NORMAL";
  AttributeEnum2["COLOR"] = "COLOR";
  AttributeEnum2["TEX_COORD"] = "TEX_COORD";
  AttributeEnum2["GENERIC"] = "GENERIC";
  return AttributeEnum2;
})(AttributeEnum || {});
var DEFAULT_QUANTIZATION_BITS = {
  [AttributeEnum.POSITION]: 14,
  [AttributeEnum.NORMAL]: 10,
  [AttributeEnum.COLOR]: 8,
  [AttributeEnum.TEX_COORD]: 12,
  [AttributeEnum.GENERIC]: 12
};
var DEFAULT_ENCODER_OPTIONS = {
  decodeSpeed: 5,
  encodeSpeed: 5,
  method: EncoderMethod.EDGEBREAKER,
  quantizationBits: DEFAULT_QUANTIZATION_BITS,
  quantizationVolume: "mesh"
};
function initEncoderModule(_encoderModule) {
  encoderModule = _encoderModule;
}
function encodeGeometry(prim, _options = DEFAULT_ENCODER_OPTIONS) {
  const options = {
    ...DEFAULT_ENCODER_OPTIONS,
    ..._options
  };
  options.quantizationBits = {
    ...DEFAULT_QUANTIZATION_BITS,
    ..._options.quantizationBits
  };
  const builder = new encoderModule.MeshBuilder();
  const mesh = new encoderModule.Mesh();
  const encoder = new encoderModule.ExpertEncoder(mesh);
  const attributeIDs = {};
  const dracoBuffer = new encoderModule.DracoInt8Array();
  const hasMorphTargets = prim.listTargets().length > 0;
  let hasSparseAttributes = false;
  for (const semantic of prim.listSemantics()) {
    const attribute = prim.getAttribute(semantic);
    if (attribute.getSparse()) {
      hasSparseAttributes = true;
      continue;
    }
    const attributeEnum = getAttributeEnum(semantic);
    const attributeID = addAttribute(builder, attribute.getComponentType(), mesh, encoderModule[attributeEnum], attribute.getCount(), attribute.getElementSize(), attribute.getArray());
    if (attributeID === -1) throw new Error(`Error compressing "${semantic}" attribute.`);
    attributeIDs[semantic] = attributeID;
    if (options.quantizationVolume === "mesh" || semantic !== "POSITION") encoder.SetAttributeQuantization(attributeID, options.quantizationBits[attributeEnum]);
    else if (typeof options.quantizationVolume === "object") {
      const { quantizationVolume } = options;
      const range = Math.max(quantizationVolume.max[0] - quantizationVolume.min[0], quantizationVolume.max[1] - quantizationVolume.min[1], quantizationVolume.max[2] - quantizationVolume.min[2]);
      encoder.SetAttributeExplicitQuantization(attributeID, options.quantizationBits[attributeEnum], attribute.getElementSize(), quantizationVolume.min, range);
    } else throw new Error("Invalid quantization volume state.");
  }
  const indices = prim.getIndices();
  if (!indices) throw new EncodingError("Primitive must have indices.");
  builder.AddFacesToMesh(mesh, indices.getCount() / 3, indices.getArray());
  encoder.SetSpeedOptions(options.encodeSpeed, options.decodeSpeed);
  encoder.SetTrackEncodedProperties(true);
  if (options.method === EncoderMethod.SEQUENTIAL || hasMorphTargets || hasSparseAttributes) encoder.SetEncodingMethod(encoderModule.MESH_SEQUENTIAL_ENCODING);
  else encoder.SetEncodingMethod(encoderModule.MESH_EDGEBREAKER_ENCODING);
  const byteLength = encoder.EncodeToDracoBuffer(!(hasMorphTargets || hasSparseAttributes), dracoBuffer);
  if (byteLength <= 0) throw new EncodingError("Error applying Draco compression.");
  const data = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; ++i) data[i] = dracoBuffer.GetValue(i);
  const numVertices = encoder.GetNumberOfEncodedPoints();
  const numIndices = encoder.GetNumberOfEncodedFaces() * 3;
  encoderModule.destroy(dracoBuffer);
  encoderModule.destroy(mesh);
  encoderModule.destroy(builder);
  encoderModule.destroy(encoder);
  return {
    numVertices,
    numIndices,
    data,
    attributeIDs
  };
}
function getAttributeEnum(semantic) {
  if (semantic === "POSITION") return AttributeEnum.POSITION;
  else if (semantic === "NORMAL") return AttributeEnum.NORMAL;
  else if (semantic.startsWith("COLOR_")) return AttributeEnum.COLOR;
  else if (semantic.startsWith("TEXCOORD_")) return AttributeEnum.TEX_COORD;
  return AttributeEnum.GENERIC;
}
function addAttribute(builder, componentType, mesh, attribute, count, itemSize, array) {
  switch (componentType) {
    case Accessor.ComponentType.UNSIGNED_BYTE:
      return builder.AddUInt8Attribute(mesh, attribute, count, itemSize, array);
    case Accessor.ComponentType.BYTE:
      return builder.AddInt8Attribute(mesh, attribute, count, itemSize, array);
    case Accessor.ComponentType.UNSIGNED_SHORT:
      return builder.AddUInt16Attribute(mesh, attribute, count, itemSize, array);
    case Accessor.ComponentType.SHORT:
      return builder.AddInt16Attribute(mesh, attribute, count, itemSize, array);
    case Accessor.ComponentType.UNSIGNED_INT:
      return builder.AddUInt32Attribute(mesh, attribute, count, itemSize, array);
    case Accessor.ComponentType.FLOAT:
      return builder.AddFloatAttribute(mesh, attribute, count, itemSize, array);
    default:
      throw new Error(`Unexpected component type, "${componentType}".`);
  }
}
var EncodingError = class extends Error {
};
var KHRDracoMeshCompression = class extends Extension {
  extensionName = KHR_DRACO_MESH_COMPRESSION;
  /** @hidden */
  prereadTypes = [PropertyType.PRIMITIVE];
  /** @hidden */
  prewriteTypes = [PropertyType.ACCESSOR];
  /** @hidden */
  readDependencies = ["draco3d.decoder"];
  /** @hidden */
  writeDependencies = ["draco3d.encoder"];
  static EXTENSION_NAME = KHR_DRACO_MESH_COMPRESSION;
  /**
  * Compression method. `EncoderMethod.EDGEBREAKER` usually provides a higher compression ratio,
  * while `EncoderMethod.SEQUENTIAL` better preserves original vertex order.
  */
  static EncoderMethod = EncoderMethod;
  _decoderModule = null;
  _encoderModule = null;
  _encoderOptions = {};
  /** @hidden */
  install(key, dependency) {
    if (key === "draco3d.decoder") {
      this._decoderModule = dependency;
      initDecoderModule(this._decoderModule);
    }
    if (key === "draco3d.encoder") {
      this._encoderModule = dependency;
      initEncoderModule(this._encoderModule);
    }
    return this;
  }
  /**
  * Sets Draco compression options. Compression does not take effect until the Document is
  * written with an I/O class.
  *
  * Defaults:
  * ```
  * decodeSpeed?: number = 5;
  * encodeSpeed?: number = 5;
  * method?: EncoderMethod = EncoderMethod.EDGEBREAKER;
  * quantizationBits?: {[ATTRIBUTE_NAME]: bits};
  * quantizationVolume?: 'mesh' | 'scene' | bbox = 'mesh';
  * ```
  */
  setEncoderOptions(options) {
    this._encoderOptions = options;
    return this;
  }
  /** @hidden */
  preread(context) {
    if (!this._decoderModule) throw new Error(`[${KHR_DRACO_MESH_COMPRESSION}] Please install extension dependency, "draco3d.decoder".`);
    const logger = this.document.getLogger();
    const jsonDoc = context.jsonDoc;
    const dracoMeshes = /* @__PURE__ */ new Map();
    try {
      const meshDefs = jsonDoc.json.meshes || [];
      for (const meshDef of meshDefs) for (const primDef of meshDef.primitives) {
        if (!primDef.extensions || !primDef.extensions["KHR_draco_mesh_compression"]) continue;
        const dracoDef = primDef.extensions[KHR_DRACO_MESH_COMPRESSION];
        let [decoder, dracoMesh] = dracoMeshes.get(dracoDef.bufferView) || [];
        if (!dracoMesh || !decoder) {
          const bufferViewDef = jsonDoc.json.bufferViews[dracoDef.bufferView];
          const bufferDef = jsonDoc.json.buffers[bufferViewDef.buffer];
          const resource = bufferDef.uri ? jsonDoc.resources[bufferDef.uri] : jsonDoc.resources[GLB_BUFFER];
          const byteOffset = bufferViewDef.byteOffset || 0;
          const byteLength = bufferViewDef.byteLength;
          const compressedData = BufferUtils.toView(resource, byteOffset, byteLength);
          decoder = new this._decoderModule.Decoder();
          dracoMesh = decodeGeometry(decoder, compressedData);
          dracoMeshes.set(dracoDef.bufferView, [decoder, dracoMesh]);
          logger.debug(`[${KHR_DRACO_MESH_COMPRESSION}] Decompressed ${compressedData.byteLength} bytes.`);
        }
        for (const semantic in dracoDef.attributes) {
          const accessorDef = context.jsonDoc.json.accessors[primDef.attributes[semantic]];
          const dracoAttribute = decoder.GetAttributeByUniqueId(dracoMesh, dracoDef.attributes[semantic]);
          const attributeArray = decodeAttribute(decoder, dracoMesh, dracoAttribute, accessorDef);
          context.accessors[primDef.attributes[semantic]].setArray(attributeArray);
        }
        if (primDef.indices !== void 0) context.accessors[primDef.indices].setArray(decodeIndex(decoder, dracoMesh));
      }
    } finally {
      for (const [decoder, dracoMesh] of Array.from(dracoMeshes.values())) {
        this._decoderModule.destroy(decoder);
        this._decoderModule.destroy(dracoMesh);
      }
    }
    return this;
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  prewrite(context, _propertyType) {
    if (!this._encoderModule) throw new Error(`[${KHR_DRACO_MESH_COMPRESSION}] Please install extension dependency, "draco3d.encoder".`);
    const logger = this.document.getLogger();
    logger.debug(`[${KHR_DRACO_MESH_COMPRESSION}] Compression options: ${JSON.stringify(this._encoderOptions)}`);
    const primitiveHashMap = listDracoPrimitives(this.document);
    const primitiveEncodingMap = /* @__PURE__ */ new Map();
    let quantizationVolume = "mesh";
    if (this._encoderOptions.quantizationVolume === "scene") if (this.document.getRoot().listScenes().length !== 1) logger.warn(`[${KHR_DRACO_MESH_COMPRESSION}]: quantizationVolume=scene requires exactly 1 scene.`);
    else quantizationVolume = getBounds(this.document.getRoot().listScenes().pop());
    for (const prim of Array.from(primitiveHashMap.keys())) {
      const primHash = primitiveHashMap.get(prim);
      if (!primHash) throw new Error("Unexpected primitive.");
      if (primitiveEncodingMap.has(primHash)) {
        primitiveEncodingMap.set(primHash, primitiveEncodingMap.get(primHash));
        continue;
      }
      const indices = prim.getIndices();
      const accessorDefs = context.jsonDoc.json.accessors;
      let encodedPrim;
      try {
        encodedPrim = encodeGeometry(prim, {
          ...this._encoderOptions,
          quantizationVolume
        });
      } catch (e) {
        if (e instanceof EncodingError) {
          logger.warn(`[${KHR_DRACO_MESH_COMPRESSION}]: ${e.message} Skipping primitive compression.`);
          continue;
        }
        throw e;
      }
      primitiveEncodingMap.set(primHash, encodedPrim);
      const indicesDef = context.createAccessorDef(indices);
      indicesDef.count = encodedPrim.numIndices;
      context.accessorIndexMap.set(indices, accessorDefs.length);
      accessorDefs.push(indicesDef);
      if (encodedPrim.numVertices > 65534 && Accessor.getComponentSize(indicesDef.componentType) <= 2) indicesDef.componentType = Accessor.ComponentType.UNSIGNED_INT;
      else if (encodedPrim.numVertices > 254 && Accessor.getComponentSize(indicesDef.componentType) <= 1) indicesDef.componentType = Accessor.ComponentType.UNSIGNED_SHORT;
      for (const semantic of prim.listSemantics()) {
        const attribute = prim.getAttribute(semantic);
        if (encodedPrim.attributeIDs[semantic] === void 0) continue;
        const attributeDef = context.createAccessorDef(attribute);
        attributeDef.count = encodedPrim.numVertices;
        context.accessorIndexMap.set(attribute, accessorDefs.length);
        accessorDefs.push(attributeDef);
      }
      const buffer = prim.getAttribute("POSITION").getBuffer() || this.document.getRoot().listBuffers()[0];
      if (!context.otherBufferViews.has(buffer)) context.otherBufferViews.set(buffer, []);
      context.otherBufferViews.get(buffer).push(encodedPrim.data);
    }
    logger.debug(`[${KHR_DRACO_MESH_COMPRESSION}] Compressed ${primitiveHashMap.size} primitives.`);
    context.extensionData[KHR_DRACO_MESH_COMPRESSION] = {
      primitiveHashMap,
      primitiveEncodingMap
    };
    return this;
  }
  /** @hidden */
  write(context) {
    const dracoContext = context.extensionData[KHR_DRACO_MESH_COMPRESSION];
    for (const mesh of this.document.getRoot().listMeshes()) {
      const meshDef = context.jsonDoc.json.meshes[context.meshIndexMap.get(mesh)];
      for (let i = 0; i < mesh.listPrimitives().length; i++) {
        const prim = mesh.listPrimitives()[i];
        const primDef = meshDef.primitives[i];
        const primHash = dracoContext.primitiveHashMap.get(prim);
        if (!primHash) continue;
        const encodedPrim = dracoContext.primitiveEncodingMap.get(primHash);
        if (!encodedPrim) continue;
        primDef.extensions = primDef.extensions || {};
        primDef.extensions[KHR_DRACO_MESH_COMPRESSION] = {
          bufferView: context.otherBufferViewsIndexMap.get(encodedPrim.data),
          attributes: encodedPrim.attributeIDs
        };
      }
    }
    if (!dracoContext.primitiveHashMap.size) {
      const json = context.jsonDoc.json;
      json.extensionsUsed = (json.extensionsUsed || []).filter((name) => name !== KHR_DRACO_MESH_COMPRESSION);
      json.extensionsRequired = (json.extensionsRequired || []).filter((name) => name !== KHR_DRACO_MESH_COMPRESSION);
    }
    return this;
  }
};
function listDracoPrimitives(doc) {
  const logger = doc.getLogger();
  const included = /* @__PURE__ */ new Set();
  const excluded = /* @__PURE__ */ new Set();
  let nonIndexed = 0;
  let nonTriangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) if (!prim.getIndices()) {
    excluded.add(prim);
    nonIndexed++;
  } else if (prim.getMode() !== Primitive.Mode.TRIANGLES) {
    excluded.add(prim);
    nonTriangles++;
  } else included.add(prim);
  if (nonIndexed > 0) logger.warn(`[${KHR_DRACO_MESH_COMPRESSION}] Skipping Draco compression of ${nonIndexed} non-indexed primitives.`);
  if (nonTriangles > 0) logger.warn(`[${KHR_DRACO_MESH_COMPRESSION}] Skipping Draco compression of ${nonTriangles} non-TRIANGLES primitives.`);
  const accessors = doc.getRoot().listAccessors();
  const accessorIndices = /* @__PURE__ */ new Map();
  for (let i = 0; i < accessors.length; i++) accessorIndices.set(accessors[i], i);
  const includedAccessors = /* @__PURE__ */ new Map();
  const includedHashKeys = /* @__PURE__ */ new Set();
  const primToHashKey = /* @__PURE__ */ new Map();
  for (const prim of Array.from(included)) {
    let hashKey = createHashKey(prim, accessorIndices);
    if (includedHashKeys.has(hashKey)) {
      primToHashKey.set(prim, hashKey);
      continue;
    }
    if (includedAccessors.has(prim.getIndices())) {
      const indices = prim.getIndices();
      const dstIndices = indices.clone();
      accessorIndices.set(dstIndices, doc.getRoot().listAccessors().length - 1);
      prim.swap(indices, dstIndices);
    }
    for (const attribute of prim.listAttributes()) if (includedAccessors.has(attribute)) {
      const dstAttribute = attribute.clone();
      accessorIndices.set(dstAttribute, doc.getRoot().listAccessors().length - 1);
      prim.swap(attribute, dstAttribute);
    }
    hashKey = createHashKey(prim, accessorIndices);
    includedHashKeys.add(hashKey);
    primToHashKey.set(prim, hashKey);
    includedAccessors.set(prim.getIndices(), hashKey);
    for (const attribute of prim.listAttributes()) includedAccessors.set(attribute, hashKey);
  }
  for (const accessor of Array.from(includedAccessors.keys())) {
    const parentTypes = new Set(accessor.listParents().map((prop) => prop.propertyType));
    if (parentTypes.size !== 2 || !parentTypes.has(PropertyType.PRIMITIVE) || !parentTypes.has(PropertyType.ROOT)) throw new Error(`[${KHR_DRACO_MESH_COMPRESSION}] Compressed accessors must only be used as indices or vertex attributes.`);
  }
  for (const prim of Array.from(included)) {
    const hashKey = primToHashKey.get(prim);
    const indices = prim.getIndices();
    if (includedAccessors.get(indices) !== hashKey || prim.listAttributes().some((attr) => includedAccessors.get(attr) !== hashKey)) throw new Error(`[${KHR_DRACO_MESH_COMPRESSION}] Draco primitives must share all, or no, accessors.`);
  }
  for (const prim of Array.from(excluded)) {
    const indices = prim.getIndices();
    if (includedAccessors.has(indices) || prim.listAttributes().some((attr) => includedAccessors.has(attr))) throw new Error(`[${KHR_DRACO_MESH_COMPRESSION}] Accessor cannot be shared by compressed and uncompressed primitives.`);
  }
  return primToHashKey;
}
function createHashKey(prim, indexMap) {
  const hashElements = [];
  const indices = prim.getIndices();
  hashElements.push(indexMap.get(indices));
  for (const attribute of prim.listAttributes()) hashElements.push(indexMap.get(attribute));
  return hashElements.sort().join("|");
}
var Light = class Light2 extends ExtensionProperty {
  static EXTENSION_NAME = KHR_LIGHTS_PUNCTUAL;
  /**********************************************************************************************
  * CONSTANTS.
  */
  static Type = {
    POINT: "point",
    SPOT: "spot",
    DIRECTIONAL: "directional"
  };
  /**********************************************************************************************
  * INSTANCE.
  */
  init() {
    this.extensionName = KHR_LIGHTS_PUNCTUAL;
    this.propertyType = "Light";
    this.parentTypes = [PropertyType.NODE];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      color: [
        1,
        1,
        1
      ],
      intensity: 1,
      type: Light2.Type.POINT,
      range: null,
      innerConeAngle: 0,
      outerConeAngle: Math.PI / 4
    });
  }
  /**********************************************************************************************
  * COLOR.
  */
  /** Light color; Linear-sRGB components. */
  getColor() {
    return this.get("color");
  }
  /** Light color; Linear-sRGB components. */
  setColor(color) {
    return this.set("color", color);
  }
  /**********************************************************************************************
  * INTENSITY.
  */
  /**
  * Brightness of light. Units depend on the type of light: point and spot lights use luminous
  * intensity in candela (lm/sr) while directional lights use illuminance in lux (lm/m2).
  */
  getIntensity() {
    return this.get("intensity");
  }
  /**
  * Brightness of light. Units depend on the type of light: point and spot lights use luminous
  * intensity in candela (lm/sr) while directional lights use illuminance in lux (lm/m2).
  */
  setIntensity(intensity) {
    return this.set("intensity", intensity);
  }
  /**********************************************************************************************
  * TYPE.
  */
  /** Type. */
  getType() {
    return this.get("type");
  }
  /** Type. */
  setType(type) {
    return this.set("type", type);
  }
  /**********************************************************************************************
  * RANGE.
  */
  /**
  * Hint defining a distance cutoff at which the light's intensity may be considered to have
  * reached zero. Supported only for point and spot lights. Must be > 0. When undefined, range
  * is assumed to be infinite.
  */
  getRange() {
    return this.get("range");
  }
  /**
  * Hint defining a distance cutoff at which the light's intensity may be considered to have
  * reached zero. Supported only for point and spot lights. Must be > 0. When undefined, range
  * is assumed to be infinite.
  */
  setRange(range) {
    return this.set("range", range);
  }
  /**********************************************************************************************
  * SPOT LIGHT PROPERTIES
  */
  /**
  * Angle, in radians, from centre of spotlight where falloff begins. Must be >= 0 and
  * < outerConeAngle.
  */
  getInnerConeAngle() {
    return this.get("innerConeAngle");
  }
  /**
  * Angle, in radians, from centre of spotlight where falloff begins. Must be >= 0 and
  * < outerConeAngle.
  */
  setInnerConeAngle(angle) {
    return this.set("innerConeAngle", angle);
  }
  /**
  * Angle, in radians, from centre of spotlight where falloff ends. Must be > innerConeAngle and
  * <= PI / 2.0.
  */
  getOuterConeAngle() {
    return this.get("outerConeAngle");
  }
  /**
  * Angle, in radians, from centre of spotlight where falloff ends. Must be > innerConeAngle and
  * <= PI / 2.0.
  */
  setOuterConeAngle(angle) {
    return this.set("outerConeAngle", angle);
  }
};
var KHRLightsPunctual = class extends Extension {
  extensionName = KHR_LIGHTS_PUNCTUAL;
  static EXTENSION_NAME = KHR_LIGHTS_PUNCTUAL;
  /** Creates a new punctual Light property for use on a {@link Node}. */
  createLight(name = "") {
    return new Light(this.document.getGraph(), name);
  }
  /** @hidden */
  read(context) {
    const jsonDoc = context.jsonDoc;
    if (!jsonDoc.json.extensions || !jsonDoc.json.extensions["KHR_lights_punctual"]) return this;
    const lights = (jsonDoc.json.extensions["KHR_lights_punctual"].lights || []).map((lightDef) => {
      const light = this.createLight().setName(lightDef.name || "").setType(lightDef.type);
      if (lightDef.color !== void 0) light.setColor(lightDef.color);
      if (lightDef.intensity !== void 0) light.setIntensity(lightDef.intensity);
      if (lightDef.range !== void 0) light.setRange(lightDef.range);
      if (lightDef.spot?.innerConeAngle !== void 0) light.setInnerConeAngle(lightDef.spot.innerConeAngle);
      if (lightDef.spot?.outerConeAngle !== void 0) light.setOuterConeAngle(lightDef.spot.outerConeAngle);
      return light;
    });
    jsonDoc.json.nodes.forEach((nodeDef, nodeIndex) => {
      if (!nodeDef.extensions || !nodeDef.extensions["KHR_lights_punctual"]) return;
      const lightNodeDef = nodeDef.extensions[KHR_LIGHTS_PUNCTUAL];
      context.nodes[nodeIndex].setExtension(KHR_LIGHTS_PUNCTUAL, lights[lightNodeDef.light]);
    });
    return this;
  }
  /** @hidden */
  write(context) {
    const jsonDoc = context.jsonDoc;
    if (this.properties.size === 0) return this;
    const lightDefs = [];
    const lightIndexMap = /* @__PURE__ */ new Map();
    for (const property of this.properties) {
      const light = property;
      const lightDef = { type: light.getType() };
      if (!MathUtils.eq(light.getColor(), [
        1,
        1,
        1
      ])) lightDef.color = light.getColor();
      if (light.getIntensity() !== 1) lightDef.intensity = light.getIntensity();
      if (light.getRange() != null) lightDef.range = light.getRange();
      if (light.getName()) lightDef.name = light.getName();
      if (light.getType() === Light.Type.SPOT) lightDef.spot = {
        innerConeAngle: light.getInnerConeAngle(),
        outerConeAngle: light.getOuterConeAngle()
      };
      lightDefs.push(lightDef);
      lightIndexMap.set(light, lightDefs.length - 1);
    }
    this.document.getRoot().listNodes().forEach((node) => {
      const light = node.getExtension(KHR_LIGHTS_PUNCTUAL);
      if (light) {
        const nodeIndex = context.nodeIndexMap.get(node);
        const nodeDef = jsonDoc.json.nodes[nodeIndex];
        nodeDef.extensions = nodeDef.extensions || {};
        nodeDef.extensions[KHR_LIGHTS_PUNCTUAL] = { light: lightIndexMap.get(light) };
      }
    });
    jsonDoc.json.extensions = jsonDoc.json.extensions || {};
    jsonDoc.json.extensions[KHR_LIGHTS_PUNCTUAL] = { lights: lightDefs };
    return this;
  }
};
var { R: R$7, G: G$7, B: B$5 } = TextureChannel;
var Anisotropy = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_ANISOTROPY;
  init() {
    this.extensionName = KHR_MATERIALS_ANISOTROPY;
    this.propertyType = "Anisotropy";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      anisotropyStrength: 0,
      anisotropyRotation: 0,
      anisotropyTexture: null,
      anisotropyTextureInfo: new TextureInfo(this.graph, "anisotropyTextureInfo")
    });
  }
  /**********************************************************************************************
  * Anisotropy strength.
  */
  /** Anisotropy strength. */
  getAnisotropyStrength() {
    return this.get("anisotropyStrength");
  }
  /** Anisotropy strength. */
  setAnisotropyStrength(strength) {
    return this.set("anisotropyStrength", strength);
  }
  /**********************************************************************************************
  * Anisotropy rotation.
  */
  /** Anisotropy rotation; linear multiplier. */
  getAnisotropyRotation() {
    return this.get("anisotropyRotation");
  }
  /** Anisotropy rotation; linear multiplier. */
  setAnisotropyRotation(rotation) {
    return this.set("anisotropyRotation", rotation);
  }
  /**********************************************************************************************
  * Anisotropy texture.
  */
  /**
  * Anisotropy texture. Red and green channels represent the anisotropy
  * direction in [-1, 1] tangent, bitangent space, to be rotated by
  * anisotropyRotation. The blue channel contains strength as [0, 1] to be
  * multiplied by anisotropyStrength.
  */
  getAnisotropyTexture() {
    return this.getRef("anisotropyTexture");
  }
  /**
  * Settings affecting the material's use of its anisotropy texture. If no
  * texture is attached, {@link TextureInfo} is `null`.
  */
  getAnisotropyTextureInfo() {
    return this.getRef("anisotropyTexture") ? this.getRef("anisotropyTextureInfo") : null;
  }
  /** Anisotropy texture. See {@link Anisotropy.getAnisotropyTexture getAnisotropyTexture}. */
  setAnisotropyTexture(texture) {
    return this.setRef("anisotropyTexture", texture, { channels: R$7 | G$7 | B$5 });
  }
};
var KHRMaterialsAnisotropy = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_ANISOTROPY;
  extensionName = KHR_MATERIALS_ANISOTROPY;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new Anisotropy property for use on a {@link Material}. */
  createAnisotropy() {
    return new Anisotropy(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    const jsonDoc = context.jsonDoc;
    const materialDefs = jsonDoc.json.materials || [];
    const textureDefs = jsonDoc.json.textures || [];
    materialDefs.forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_anisotropy"]) {
        const anisotropy = this.createAnisotropy();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_ANISOTROPY, anisotropy);
        const anisotropyDef = materialDef.extensions[KHR_MATERIALS_ANISOTROPY];
        if (anisotropyDef.anisotropyStrength !== void 0) anisotropy.setAnisotropyStrength(anisotropyDef.anisotropyStrength);
        if (anisotropyDef.anisotropyRotation !== void 0) anisotropy.setAnisotropyRotation(anisotropyDef.anisotropyRotation);
        if (anisotropyDef.anisotropyTexture !== void 0) {
          const textureInfoDef = anisotropyDef.anisotropyTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          anisotropy.setAnisotropyTexture(texture);
          context.setTextureInfo(anisotropy.getAnisotropyTextureInfo(), textureInfoDef);
        }
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const anisotropy = material.getExtension(KHR_MATERIALS_ANISOTROPY);
      if (anisotropy) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        const anisotropyDef = materialDef.extensions[KHR_MATERIALS_ANISOTROPY] = {};
        if (anisotropy.getAnisotropyStrength() > 0) anisotropyDef.anisotropyStrength = anisotropy.getAnisotropyStrength();
        if (anisotropy.getAnisotropyRotation() !== 0) anisotropyDef.anisotropyRotation = anisotropy.getAnisotropyRotation();
        if (anisotropy.getAnisotropyTexture()) {
          const texture = anisotropy.getAnisotropyTexture();
          const textureInfo = anisotropy.getAnisotropyTextureInfo();
          anisotropyDef.anisotropyTexture = context.createTextureInfoDef(texture, textureInfo);
        }
      }
    });
    return this;
  }
};
var { R: R$6, G: G$6, B: B$4 } = TextureChannel;
var Clearcoat = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_CLEARCOAT;
  init() {
    this.extensionName = KHR_MATERIALS_CLEARCOAT;
    this.propertyType = "Clearcoat";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      clearcoatFactor: 0,
      clearcoatTexture: null,
      clearcoatTextureInfo: new TextureInfo(this.graph, "clearcoatTextureInfo"),
      clearcoatRoughnessFactor: 0,
      clearcoatRoughnessTexture: null,
      clearcoatRoughnessTextureInfo: new TextureInfo(this.graph, "clearcoatRoughnessTextureInfo"),
      clearcoatNormalScale: 1,
      clearcoatNormalTexture: null,
      clearcoatNormalTextureInfo: new TextureInfo(this.graph, "clearcoatNormalTextureInfo")
    });
  }
  /**********************************************************************************************
  * Clearcoat.
  */
  /** Clearcoat; linear multiplier. See {@link Clearcoat.getClearcoatTexture getClearcoatTexture}. */
  getClearcoatFactor() {
    return this.get("clearcoatFactor");
  }
  /** Clearcoat; linear multiplier. See {@link Clearcoat.getClearcoatTexture getClearcoatTexture}. */
  setClearcoatFactor(factor) {
    return this.set("clearcoatFactor", factor);
  }
  /**
  * Clearcoat texture; linear multiplier. The `r` channel of this texture specifies an amount
  * [0-1] of coating over the surface of the material, which may have its own roughness and
  * normal map properties.
  */
  getClearcoatTexture() {
    return this.getRef("clearcoatTexture");
  }
  /**
  * Settings affecting the material's use of its clearcoat texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getClearcoatTextureInfo() {
    return this.getRef("clearcoatTexture") ? this.getRef("clearcoatTextureInfo") : null;
  }
  /** Sets clearcoat texture. See {@link Clearcoat.getClearcoatTexture getClearcoatTexture}. */
  setClearcoatTexture(texture) {
    return this.setRef("clearcoatTexture", texture, { channels: R$6 });
  }
  /**********************************************************************************************
  * Clearcoat roughness.
  */
  /**
  * Clearcoat roughness; linear multiplier.
  * See {@link Clearcoat.getClearcoatRoughnessTexture getClearcoatRoughnessTexture}.
  */
  getClearcoatRoughnessFactor() {
    return this.get("clearcoatRoughnessFactor");
  }
  /**
  * Clearcoat roughness; linear multiplier.
  * See {@link Clearcoat.getClearcoatRoughnessTexture getClearcoatRoughnessTexture}.
  */
  setClearcoatRoughnessFactor(factor) {
    return this.set("clearcoatRoughnessFactor", factor);
  }
  /**
  * Clearcoat roughness texture; linear multiplier. The `g` channel of this texture specifies
  * roughness, independent of the base layer's roughness.
  */
  getClearcoatRoughnessTexture() {
    return this.getRef("clearcoatRoughnessTexture");
  }
  /**
  * Settings affecting the material's use of its clearcoat roughness texture. If no texture is
  * attached, {@link TextureInfo} is `null`.
  */
  getClearcoatRoughnessTextureInfo() {
    return this.getRef("clearcoatRoughnessTexture") ? this.getRef("clearcoatRoughnessTextureInfo") : null;
  }
  /**
  * Sets clearcoat roughness texture.
  * See {@link Clearcoat.getClearcoatRoughnessTexture getClearcoatRoughnessTexture}.
  */
  setClearcoatRoughnessTexture(texture) {
    return this.setRef("clearcoatRoughnessTexture", texture, { channels: G$6 });
  }
  /**********************************************************************************************
  * Clearcoat normals.
  */
  /** Clearcoat normal scale. See {@link Clearcoat.getClearcoatNormalTexture getClearcoatNormalTexture}. */
  getClearcoatNormalScale() {
    return this.get("clearcoatNormalScale");
  }
  /** Clearcoat normal scale. See {@link Clearcoat.getClearcoatNormalTexture getClearcoatNormalTexture}. */
  setClearcoatNormalScale(scale2) {
    return this.set("clearcoatNormalScale", scale2);
  }
  /**
  * Clearcoat normal map. Independent of the material base layer normal map.
  */
  getClearcoatNormalTexture() {
    return this.getRef("clearcoatNormalTexture");
  }
  /**
  * Settings affecting the material's use of its clearcoat normal texture. If no texture is
  * attached, {@link TextureInfo} is `null`.
  */
  getClearcoatNormalTextureInfo() {
    return this.getRef("clearcoatNormalTexture") ? this.getRef("clearcoatNormalTextureInfo") : null;
  }
  /** Sets clearcoat normal texture. See {@link Clearcoat.getClearcoatNormalTexture getClearcoatNormalTexture}. */
  setClearcoatNormalTexture(texture) {
    return this.setRef("clearcoatNormalTexture", texture, { channels: R$6 | G$6 | B$4 });
  }
};
var KHRMaterialsClearcoat = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_CLEARCOAT;
  extensionName = KHR_MATERIALS_CLEARCOAT;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new Clearcoat property for use on a {@link Material}. */
  createClearcoat() {
    return new Clearcoat(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    const jsonDoc = context.jsonDoc;
    const materialDefs = jsonDoc.json.materials || [];
    const textureDefs = jsonDoc.json.textures || [];
    materialDefs.forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_clearcoat"]) {
        const clearcoat = this.createClearcoat();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_CLEARCOAT, clearcoat);
        const clearcoatDef = materialDef.extensions[KHR_MATERIALS_CLEARCOAT];
        if (clearcoatDef.clearcoatFactor !== void 0) clearcoat.setClearcoatFactor(clearcoatDef.clearcoatFactor);
        if (clearcoatDef.clearcoatRoughnessFactor !== void 0) clearcoat.setClearcoatRoughnessFactor(clearcoatDef.clearcoatRoughnessFactor);
        if (clearcoatDef.clearcoatTexture !== void 0) {
          const textureInfoDef = clearcoatDef.clearcoatTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          clearcoat.setClearcoatTexture(texture);
          context.setTextureInfo(clearcoat.getClearcoatTextureInfo(), textureInfoDef);
        }
        if (clearcoatDef.clearcoatRoughnessTexture !== void 0) {
          const textureInfoDef = clearcoatDef.clearcoatRoughnessTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          clearcoat.setClearcoatRoughnessTexture(texture);
          context.setTextureInfo(clearcoat.getClearcoatRoughnessTextureInfo(), textureInfoDef);
        }
        if (clearcoatDef.clearcoatNormalTexture !== void 0) {
          const textureInfoDef = clearcoatDef.clearcoatNormalTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          clearcoat.setClearcoatNormalTexture(texture);
          context.setTextureInfo(clearcoat.getClearcoatNormalTextureInfo(), textureInfoDef);
          if (textureInfoDef.scale !== void 0) clearcoat.setClearcoatNormalScale(textureInfoDef.scale);
        }
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const clearcoat = material.getExtension(KHR_MATERIALS_CLEARCOAT);
      if (clearcoat) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        const clearcoatDef = materialDef.extensions[KHR_MATERIALS_CLEARCOAT] = {
          clearcoatFactor: clearcoat.getClearcoatFactor(),
          clearcoatRoughnessFactor: clearcoat.getClearcoatRoughnessFactor()
        };
        if (clearcoat.getClearcoatTexture()) {
          const texture = clearcoat.getClearcoatTexture();
          const textureInfo = clearcoat.getClearcoatTextureInfo();
          clearcoatDef.clearcoatTexture = context.createTextureInfoDef(texture, textureInfo);
        }
        if (clearcoat.getClearcoatRoughnessTexture()) {
          const texture = clearcoat.getClearcoatRoughnessTexture();
          const textureInfo = clearcoat.getClearcoatRoughnessTextureInfo();
          clearcoatDef.clearcoatRoughnessTexture = context.createTextureInfoDef(texture, textureInfo);
        }
        if (clearcoat.getClearcoatNormalTexture()) {
          const texture = clearcoat.getClearcoatNormalTexture();
          const textureInfo = clearcoat.getClearcoatNormalTextureInfo();
          clearcoatDef.clearcoatNormalTexture = context.createTextureInfoDef(texture, textureInfo);
          if (clearcoat.getClearcoatNormalScale() !== 1) clearcoatDef.clearcoatNormalTexture.scale = clearcoat.getClearcoatNormalScale();
        }
      }
    });
    return this;
  }
};
var { R: R$5, G: G$5, B: B$3, A: A$3 } = TextureChannel;
var DiffuseTransmission = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_DIFFUSE_TRANSMISSION;
  init() {
    this.extensionName = KHR_MATERIALS_DIFFUSE_TRANSMISSION;
    this.propertyType = "DiffuseTransmission";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      diffuseTransmissionFactor: 0,
      diffuseTransmissionTexture: null,
      diffuseTransmissionTextureInfo: new TextureInfo(this.graph, "diffuseTransmissionTextureInfo"),
      diffuseTransmissionColorFactor: [
        1,
        1,
        1
      ],
      diffuseTransmissionColorTexture: null,
      diffuseTransmissionColorTextureInfo: new TextureInfo(this.graph, "diffuseTransmissionColorTextureInfo")
    });
  }
  /**********************************************************************************************
  * Diffuse transmission.
  */
  /**
  * Percentage of reflected, non-specularly reflected light that is transmitted through the
  * surface via the Lambertian diffuse transmission, i.e., the strength of the diffuse
  * transmission effect.
  */
  getDiffuseTransmissionFactor() {
    return this.get("diffuseTransmissionFactor");
  }
  /**
  * Percentage of reflected, non-specularly reflected light that is transmitted through the
  * surface via the Lambertian diffuse transmission, i.e., the strength of the diffuse
  * transmission effect.
  */
  setDiffuseTransmissionFactor(factor) {
    return this.set("diffuseTransmissionFactor", factor);
  }
  /**
  * Texture that defines the strength of the diffuse transmission effect, stored in the alpha (A)
  * channel. Will be multiplied by the diffuseTransmissionFactor.
  */
  getDiffuseTransmissionTexture() {
    return this.getRef("diffuseTransmissionTexture");
  }
  /**
  * Settings affecting the material's use of its diffuse transmission texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getDiffuseTransmissionTextureInfo() {
    return this.getRef("diffuseTransmissionTexture") ? this.getRef("diffuseTransmissionTextureInfo") : null;
  }
  /**
  * Texture that defines the strength of the diffuse transmission effect, stored in the alpha (A)
  * channel. Will be multiplied by the diffuseTransmissionFactor.
  */
  setDiffuseTransmissionTexture(texture) {
    return this.setRef("diffuseTransmissionTexture", texture, { channels: A$3 });
  }
  /**********************************************************************************************
  * Diffuse transmission color.
  */
  /** Color of the transmitted light; Linear-sRGB components. */
  getDiffuseTransmissionColorFactor() {
    return this.get("diffuseTransmissionColorFactor");
  }
  /** Color of the transmitted light; Linear-sRGB components. */
  setDiffuseTransmissionColorFactor(factor) {
    return this.set("diffuseTransmissionColorFactor", factor);
  }
  /**
  * Texture that defines the color of the transmitted light, stored in the RGB channels and
  * encoded in sRGB. This texture will be multiplied by diffuseTransmissionColorFactor.
  */
  getDiffuseTransmissionColorTexture() {
    return this.getRef("diffuseTransmissionColorTexture");
  }
  /**
  * Settings affecting the material's use of its diffuse transmission color texture. If no
  * texture is attached, {@link TextureInfo} is `null`.
  */
  getDiffuseTransmissionColorTextureInfo() {
    return this.getRef("diffuseTransmissionColorTexture") ? this.getRef("diffuseTransmissionColorTextureInfo") : null;
  }
  /**
  * Texture that defines the color of the transmitted light, stored in the RGB channels and
  * encoded in sRGB. This texture will be multiplied by diffuseTransmissionColorFactor.
  */
  setDiffuseTransmissionColorTexture(texture) {
    return this.setRef("diffuseTransmissionColorTexture", texture, { channels: R$5 | G$5 | B$3 });
  }
};
var KHRMaterialsDiffuseTransmission = class extends Extension {
  extensionName = KHR_MATERIALS_DIFFUSE_TRANSMISSION;
  static EXTENSION_NAME = KHR_MATERIALS_DIFFUSE_TRANSMISSION;
  /** Creates a new DiffuseTransmission property for use on a {@link Material}. */
  createDiffuseTransmission() {
    return new DiffuseTransmission(this.document.getGraph());
  }
  /** @hidden */
  read(context) {
    const jsonDoc = context.jsonDoc;
    const materialDefs = jsonDoc.json.materials || [];
    const textureDefs = jsonDoc.json.textures || [];
    materialDefs.forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_diffuse_transmission"]) {
        const transmission = this.createDiffuseTransmission();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_DIFFUSE_TRANSMISSION, transmission);
        const transmissionDef = materialDef.extensions[KHR_MATERIALS_DIFFUSE_TRANSMISSION];
        if (transmissionDef.diffuseTransmissionFactor !== void 0) transmission.setDiffuseTransmissionFactor(transmissionDef.diffuseTransmissionFactor);
        if (transmissionDef.diffuseTransmissionColorFactor !== void 0) transmission.setDiffuseTransmissionColorFactor(transmissionDef.diffuseTransmissionColorFactor);
        if (transmissionDef.diffuseTransmissionTexture !== void 0) {
          const textureInfoDef = transmissionDef.diffuseTransmissionTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          transmission.setDiffuseTransmissionTexture(texture);
          context.setTextureInfo(transmission.getDiffuseTransmissionTextureInfo(), textureInfoDef);
        }
        if (transmissionDef.diffuseTransmissionColorTexture !== void 0) {
          const textureInfoDef = transmissionDef.diffuseTransmissionColorTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          transmission.setDiffuseTransmissionColorTexture(texture);
          context.setTextureInfo(transmission.getDiffuseTransmissionColorTextureInfo(), textureInfoDef);
        }
      }
    });
    return this;
  }
  /** @hidden */
  write(context) {
    const jsonDoc = context.jsonDoc;
    for (const material of this.document.getRoot().listMaterials()) {
      const transmission = material.getExtension(KHR_MATERIALS_DIFFUSE_TRANSMISSION);
      if (!transmission) continue;
      const materialIndex = context.materialIndexMap.get(material);
      const materialDef = jsonDoc.json.materials[materialIndex];
      materialDef.extensions = materialDef.extensions || {};
      const transmissionDef = materialDef.extensions[KHR_MATERIALS_DIFFUSE_TRANSMISSION] = {
        diffuseTransmissionFactor: transmission.getDiffuseTransmissionFactor(),
        diffuseTransmissionColorFactor: transmission.getDiffuseTransmissionColorFactor()
      };
      if (transmission.getDiffuseTransmissionTexture()) {
        const texture = transmission.getDiffuseTransmissionTexture();
        const textureInfo = transmission.getDiffuseTransmissionTextureInfo();
        transmissionDef.diffuseTransmissionTexture = context.createTextureInfoDef(texture, textureInfo);
      }
      if (transmission.getDiffuseTransmissionColorTexture()) {
        const texture = transmission.getDiffuseTransmissionColorTexture();
        const textureInfo = transmission.getDiffuseTransmissionColorTextureInfo();
        transmissionDef.diffuseTransmissionColorTexture = context.createTextureInfoDef(texture, textureInfo);
      }
    }
    return this;
  }
};
var Dispersion = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_DISPERSION;
  init() {
    this.extensionName = KHR_MATERIALS_DISPERSION;
    this.propertyType = "Dispersion";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { dispersion: 0 });
  }
  /**********************************************************************************************
  * Dispersion.
  */
  /** Dispersion. */
  getDispersion() {
    return this.get("dispersion");
  }
  /** Dispersion. */
  setDispersion(dispersion) {
    return this.set("dispersion", dispersion);
  }
};
var KHRMaterialsDispersion = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_DISPERSION;
  extensionName = KHR_MATERIALS_DISPERSION;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new Dispersion property for use on a {@link Material}. */
  createDispersion() {
    return new Dispersion(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    (context.jsonDoc.json.materials || []).forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_dispersion"]) {
        const dispersion = this.createDispersion();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_DISPERSION, dispersion);
        const dispersionDef = materialDef.extensions[KHR_MATERIALS_DISPERSION];
        if (dispersionDef.dispersion !== void 0) dispersion.setDispersion(dispersionDef.dispersion);
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const dispersion = material.getExtension(KHR_MATERIALS_DISPERSION);
      if (dispersion) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        materialDef.extensions[KHR_MATERIALS_DISPERSION] = { dispersion: dispersion.getDispersion() };
      }
    });
    return this;
  }
};
var EmissiveStrength = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_EMISSIVE_STRENGTH;
  init() {
    this.extensionName = KHR_MATERIALS_EMISSIVE_STRENGTH;
    this.propertyType = "EmissiveStrength";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { emissiveStrength: 1 });
  }
  /**********************************************************************************************
  * EmissiveStrength.
  */
  /** EmissiveStrength. */
  getEmissiveStrength() {
    return this.get("emissiveStrength");
  }
  /** EmissiveStrength. */
  setEmissiveStrength(strength) {
    return this.set("emissiveStrength", strength);
  }
};
var KHRMaterialsEmissiveStrength = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_EMISSIVE_STRENGTH;
  extensionName = KHR_MATERIALS_EMISSIVE_STRENGTH;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new EmissiveStrength property for use on a {@link Material}. */
  createEmissiveStrength() {
    return new EmissiveStrength(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    (context.jsonDoc.json.materials || []).forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_emissive_strength"]) {
        const emissiveStrength = this.createEmissiveStrength();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_EMISSIVE_STRENGTH, emissiveStrength);
        const emissiveStrengthDef = materialDef.extensions[KHR_MATERIALS_EMISSIVE_STRENGTH];
        if (emissiveStrengthDef.emissiveStrength !== void 0) emissiveStrength.setEmissiveStrength(emissiveStrengthDef.emissiveStrength);
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const emissiveStrength = material.getExtension(KHR_MATERIALS_EMISSIVE_STRENGTH);
      if (emissiveStrength) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        materialDef.extensions[KHR_MATERIALS_EMISSIVE_STRENGTH] = { emissiveStrength: emissiveStrength.getEmissiveStrength() };
      }
    });
    return this;
  }
};
var IOR = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_IOR;
  init() {
    this.extensionName = KHR_MATERIALS_IOR;
    this.propertyType = "IOR";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { ior: 1.5 });
  }
  /**********************************************************************************************
  * IOR.
  */
  /** IOR. */
  getIOR() {
    return this.get("ior");
  }
  /** IOR. */
  setIOR(ior) {
    return this.set("ior", ior);
  }
};
var KHRMaterialsIOR = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_IOR;
  extensionName = KHR_MATERIALS_IOR;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new IOR property for use on a {@link Material}. */
  createIOR() {
    return new IOR(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    (context.jsonDoc.json.materials || []).forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_ior"]) {
        const ior = this.createIOR();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_IOR, ior);
        const iorDef = materialDef.extensions[KHR_MATERIALS_IOR];
        if (iorDef.ior !== void 0) ior.setIOR(iorDef.ior);
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const ior = material.getExtension(KHR_MATERIALS_IOR);
      if (ior) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        materialDef.extensions[KHR_MATERIALS_IOR] = { ior: ior.getIOR() };
      }
    });
    return this;
  }
};
var { R: R$4, G: G$4 } = TextureChannel;
var Iridescence = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_IRIDESCENCE;
  init() {
    this.extensionName = KHR_MATERIALS_IRIDESCENCE;
    this.propertyType = "Iridescence";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      iridescenceFactor: 0,
      iridescenceTexture: null,
      iridescenceTextureInfo: new TextureInfo(this.graph, "iridescenceTextureInfo"),
      iridescenceIOR: 1.3,
      iridescenceThicknessMinimum: 100,
      iridescenceThicknessMaximum: 400,
      iridescenceThicknessTexture: null,
      iridescenceThicknessTextureInfo: new TextureInfo(this.graph, "iridescenceThicknessTextureInfo")
    });
  }
  /**********************************************************************************************
  * Iridescence.
  */
  /** Iridescence; linear multiplier. See {@link Iridescence.getIridescenceTexture getIridescenceTexture}. */
  getIridescenceFactor() {
    return this.get("iridescenceFactor");
  }
  /** Iridescence; linear multiplier. See {@link Iridescence.getIridescenceTexture getIridescenceTexture}. */
  setIridescenceFactor(factor) {
    return this.set("iridescenceFactor", factor);
  }
  /**
  * Iridescence intensity.
  *
  * Only the red (R) channel is used for iridescence intensity, but this texture may optionally
  * be packed with additional data in the other channels.
  */
  getIridescenceTexture() {
    return this.getRef("iridescenceTexture");
  }
  /**
  * Settings affecting the material's use of its iridescence texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getIridescenceTextureInfo() {
    return this.getRef("iridescenceTexture") ? this.getRef("iridescenceTextureInfo") : null;
  }
  /** Iridescence intensity. See {@link Iridescence.getIridescenceTexture getIridescenceTexture}. */
  setIridescenceTexture(texture) {
    return this.setRef("iridescenceTexture", texture, { channels: R$4 });
  }
  /**********************************************************************************************
  * Iridescence IOR.
  */
  /** Index of refraction of the dielectric thin-film layer. */
  getIridescenceIOR() {
    return this.get("iridescenceIOR");
  }
  /** Index of refraction of the dielectric thin-film layer. */
  setIridescenceIOR(ior) {
    return this.set("iridescenceIOR", ior);
  }
  /**********************************************************************************************
  * Iridescence thickness.
  */
  /** Minimum thickness of the thin-film layer, in nanometers (nm). */
  getIridescenceThicknessMinimum() {
    return this.get("iridescenceThicknessMinimum");
  }
  /** Minimum thickness of the thin-film layer, in nanometers (nm). */
  setIridescenceThicknessMinimum(thickness) {
    return this.set("iridescenceThicknessMinimum", thickness);
  }
  /** Maximum thickness of the thin-film layer, in nanometers (nm). */
  getIridescenceThicknessMaximum() {
    return this.get("iridescenceThicknessMaximum");
  }
  /** Maximum thickness of the thin-film layer, in nanometers (nm). */
  setIridescenceThicknessMaximum(thickness) {
    return this.set("iridescenceThicknessMaximum", thickness);
  }
  /**
  * The green channel of this texture defines the thickness of the
  * thin-film layer by blending between the minimum and maximum thickness.
  */
  getIridescenceThicknessTexture() {
    return this.getRef("iridescenceThicknessTexture");
  }
  /**
  * Settings affecting the material's use of its iridescence thickness texture.
  * If no texture is attached, {@link TextureInfo} is `null`.
  */
  getIridescenceThicknessTextureInfo() {
    return this.getRef("iridescenceThicknessTexture") ? this.getRef("iridescenceThicknessTextureInfo") : null;
  }
  /**
  * Sets iridescence thickness texture.
  * See {@link Iridescence.getIridescenceThicknessTexture getIridescenceThicknessTexture}.
  */
  setIridescenceThicknessTexture(texture) {
    return this.setRef("iridescenceThicknessTexture", texture, { channels: G$4 });
  }
};
var KHRMaterialsIridescence = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_IRIDESCENCE;
  extensionName = KHR_MATERIALS_IRIDESCENCE;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new Iridescence property for use on a {@link Material}. */
  createIridescence() {
    return new Iridescence(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    const jsonDoc = context.jsonDoc;
    const materialDefs = jsonDoc.json.materials || [];
    const textureDefs = jsonDoc.json.textures || [];
    materialDefs.forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_iridescence"]) {
        const iridescence = this.createIridescence();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_IRIDESCENCE, iridescence);
        const iridescenceDef = materialDef.extensions[KHR_MATERIALS_IRIDESCENCE];
        if (iridescenceDef.iridescenceFactor !== void 0) iridescence.setIridescenceFactor(iridescenceDef.iridescenceFactor);
        if (iridescenceDef.iridescenceIor !== void 0) iridescence.setIridescenceIOR(iridescenceDef.iridescenceIor);
        if (iridescenceDef.iridescenceThicknessMinimum !== void 0) iridescence.setIridescenceThicknessMinimum(iridescenceDef.iridescenceThicknessMinimum);
        if (iridescenceDef.iridescenceThicknessMaximum !== void 0) iridescence.setIridescenceThicknessMaximum(iridescenceDef.iridescenceThicknessMaximum);
        if (iridescenceDef.iridescenceTexture !== void 0) {
          const textureInfoDef = iridescenceDef.iridescenceTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          iridescence.setIridescenceTexture(texture);
          context.setTextureInfo(iridescence.getIridescenceTextureInfo(), textureInfoDef);
        }
        if (iridescenceDef.iridescenceThicknessTexture !== void 0) {
          const textureInfoDef = iridescenceDef.iridescenceThicknessTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          iridescence.setIridescenceThicknessTexture(texture);
          context.setTextureInfo(iridescence.getIridescenceThicknessTextureInfo(), textureInfoDef);
        }
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const iridescence = material.getExtension(KHR_MATERIALS_IRIDESCENCE);
      if (iridescence) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        const iridescenceDef = materialDef.extensions[KHR_MATERIALS_IRIDESCENCE] = {};
        if (iridescence.getIridescenceFactor() > 0) iridescenceDef.iridescenceFactor = iridescence.getIridescenceFactor();
        if (iridescence.getIridescenceIOR() !== 1.3) iridescenceDef.iridescenceIor = iridescence.getIridescenceIOR();
        if (iridescence.getIridescenceThicknessMinimum() !== 100) iridescenceDef.iridescenceThicknessMinimum = iridescence.getIridescenceThicknessMinimum();
        if (iridescence.getIridescenceThicknessMaximum() !== 400) iridescenceDef.iridescenceThicknessMaximum = iridescence.getIridescenceThicknessMaximum();
        if (iridescence.getIridescenceTexture()) {
          const texture = iridescence.getIridescenceTexture();
          const textureInfo = iridescence.getIridescenceTextureInfo();
          iridescenceDef.iridescenceTexture = context.createTextureInfoDef(texture, textureInfo);
        }
        if (iridescence.getIridescenceThicknessTexture()) {
          const texture = iridescence.getIridescenceThicknessTexture();
          const textureInfo = iridescence.getIridescenceThicknessTextureInfo();
          iridescenceDef.iridescenceThicknessTexture = context.createTextureInfoDef(texture, textureInfo);
        }
      }
    });
    return this;
  }
};
var { R: R$3, G: G$3, B: B$2, A: A$2 } = TextureChannel;
var PBRSpecularGlossiness = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS;
  init() {
    this.extensionName = KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS;
    this.propertyType = "PBRSpecularGlossiness";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      diffuseFactor: [
        1,
        1,
        1,
        1
      ],
      diffuseTexture: null,
      diffuseTextureInfo: new TextureInfo(this.graph, "diffuseTextureInfo"),
      specularFactor: [
        1,
        1,
        1
      ],
      glossinessFactor: 1,
      specularGlossinessTexture: null,
      specularGlossinessTextureInfo: new TextureInfo(this.graph, "specularGlossinessTextureInfo")
    });
  }
  /**********************************************************************************************
  * Diffuse.
  */
  /** Diffuse; Linear-sRGB components. See {@link PBRSpecularGlossiness.getDiffuseTexture getDiffuseTexture}. */
  getDiffuseFactor() {
    return this.get("diffuseFactor");
  }
  /** Diffuse; Linear-sRGB components. See {@link PBRSpecularGlossiness.getDiffuseTexture getDiffuseTexture}. */
  setDiffuseFactor(factor) {
    return this.set("diffuseFactor", factor);
  }
  /**
  * Diffuse texture; sRGB. Alternative to baseColorTexture, used within the
  * spec/gloss PBR workflow.
  */
  getDiffuseTexture() {
    return this.getRef("diffuseTexture");
  }
  /**
  * Settings affecting the material's use of its diffuse texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getDiffuseTextureInfo() {
    return this.getRef("diffuseTexture") ? this.getRef("diffuseTextureInfo") : null;
  }
  /** Sets diffuse texture. See {@link PBRSpecularGlossiness.getDiffuseTexture getDiffuseTexture}. */
  setDiffuseTexture(texture) {
    return this.setRef("diffuseTexture", texture, {
      channels: R$3 | G$3 | B$2 | A$2,
      isColor: true
    });
  }
  /**********************************************************************************************
  * Specular.
  */
  /** Specular; linear multiplier. */
  getSpecularFactor() {
    return this.get("specularFactor");
  }
  /** Specular; linear multiplier. */
  setSpecularFactor(factor) {
    return this.set("specularFactor", factor);
  }
  /**********************************************************************************************
  * Glossiness.
  */
  /** Glossiness; linear multiplier. */
  getGlossinessFactor() {
    return this.get("glossinessFactor");
  }
  /** Glossiness; linear multiplier. */
  setGlossinessFactor(factor) {
    return this.set("glossinessFactor", factor);
  }
  /**********************************************************************************************
  * Specular/Glossiness.
  */
  /** Spec/gloss texture; linear multiplier. */
  getSpecularGlossinessTexture() {
    return this.getRef("specularGlossinessTexture");
  }
  /**
  * Settings affecting the material's use of its spec/gloss texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getSpecularGlossinessTextureInfo() {
    return this.getRef("specularGlossinessTexture") ? this.getRef("specularGlossinessTextureInfo") : null;
  }
  /** Spec/gloss texture; linear multiplier. */
  setSpecularGlossinessTexture(texture) {
    return this.setRef("specularGlossinessTexture", texture, { channels: R$3 | G$3 | B$2 | A$2 });
  }
};
var KHRMaterialsPBRSpecularGlossiness = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS;
  extensionName = KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new PBRSpecularGlossiness property for use on a {@link Material}. */
  createPBRSpecularGlossiness() {
    return new PBRSpecularGlossiness(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    const jsonDoc = context.jsonDoc;
    const materialDefs = jsonDoc.json.materials || [];
    const textureDefs = jsonDoc.json.textures || [];
    materialDefs.forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_pbrSpecularGlossiness"]) {
        const specGloss = this.createPBRSpecularGlossiness();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS, specGloss);
        const specGlossDef = materialDef.extensions[KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS];
        if (specGlossDef.diffuseFactor !== void 0) specGloss.setDiffuseFactor(specGlossDef.diffuseFactor);
        if (specGlossDef.specularFactor !== void 0) specGloss.setSpecularFactor(specGlossDef.specularFactor);
        if (specGlossDef.glossinessFactor !== void 0) specGloss.setGlossinessFactor(specGlossDef.glossinessFactor);
        if (specGlossDef.diffuseTexture !== void 0) {
          const textureInfoDef = specGlossDef.diffuseTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          specGloss.setDiffuseTexture(texture);
          context.setTextureInfo(specGloss.getDiffuseTextureInfo(), textureInfoDef);
        }
        if (specGlossDef.specularGlossinessTexture !== void 0) {
          const textureInfoDef = specGlossDef.specularGlossinessTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          specGloss.setSpecularGlossinessTexture(texture);
          context.setTextureInfo(specGloss.getSpecularGlossinessTextureInfo(), textureInfoDef);
        }
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const specGloss = material.getExtension(KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS);
      if (specGloss) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        const specGlossDef = materialDef.extensions[KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS] = {
          diffuseFactor: specGloss.getDiffuseFactor(),
          specularFactor: specGloss.getSpecularFactor(),
          glossinessFactor: specGloss.getGlossinessFactor()
        };
        if (specGloss.getDiffuseTexture()) {
          const texture = specGloss.getDiffuseTexture();
          const textureInfo = specGloss.getDiffuseTextureInfo();
          specGlossDef.diffuseTexture = context.createTextureInfoDef(texture, textureInfo);
        }
        if (specGloss.getSpecularGlossinessTexture()) {
          const texture = specGloss.getSpecularGlossinessTexture();
          const textureInfo = specGloss.getSpecularGlossinessTextureInfo();
          specGlossDef.specularGlossinessTexture = context.createTextureInfoDef(texture, textureInfo);
        }
      }
    });
    return this;
  }
};
var { R: R$2, G: G$2, B: B$1, A: A$1 } = TextureChannel;
var Sheen = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_SHEEN;
  init() {
    this.extensionName = KHR_MATERIALS_SHEEN;
    this.propertyType = "Sheen";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      sheenColorFactor: [
        0,
        0,
        0
      ],
      sheenColorTexture: null,
      sheenColorTextureInfo: new TextureInfo(this.graph, "sheenColorTextureInfo"),
      sheenRoughnessFactor: 0,
      sheenRoughnessTexture: null,
      sheenRoughnessTextureInfo: new TextureInfo(this.graph, "sheenRoughnessTextureInfo")
    });
  }
  /**********************************************************************************************
  * Sheen color.
  */
  /** Sheen; linear multiplier. */
  getSheenColorFactor() {
    return this.get("sheenColorFactor");
  }
  /** Sheen; linear multiplier. */
  setSheenColorFactor(factor) {
    return this.set("sheenColorFactor", factor);
  }
  /**
  * Sheen color texture, in sRGB colorspace.
  */
  getSheenColorTexture() {
    return this.getRef("sheenColorTexture");
  }
  /**
  * Settings affecting the material's use of its sheen color texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getSheenColorTextureInfo() {
    return this.getRef("sheenColorTexture") ? this.getRef("sheenColorTextureInfo") : null;
  }
  /** Sets sheen color texture. See {@link Sheen.getSheenColorTexture getSheenColorTexture}. */
  setSheenColorTexture(texture) {
    return this.setRef("sheenColorTexture", texture, {
      channels: R$2 | G$2 | B$1,
      isColor: true
    });
  }
  /**********************************************************************************************
  * Sheen roughness.
  */
  /** Sheen roughness; linear multiplier. See {@link Sheen.getSheenRoughnessTexture getSheenRoughnessTexture}. */
  getSheenRoughnessFactor() {
    return this.get("sheenRoughnessFactor");
  }
  /** Sheen roughness; linear multiplier. See {@link Sheen.getSheenRoughnessTexture getSheenRoughnessTexture}. */
  setSheenRoughnessFactor(factor) {
    return this.set("sheenRoughnessFactor", factor);
  }
  /**
  * Sheen roughness texture; linear multiplier. The `a` channel of this texture specifies
  * roughness, independent of the base layer's roughness.
  */
  getSheenRoughnessTexture() {
    return this.getRef("sheenRoughnessTexture");
  }
  /**
  * Settings affecting the material's use of its sheen roughness texture. If no texture is
  * attached, {@link TextureInfo} is `null`.
  */
  getSheenRoughnessTextureInfo() {
    return this.getRef("sheenRoughnessTexture") ? this.getRef("sheenRoughnessTextureInfo") : null;
  }
  /**
  * Sets sheen roughness texture.  The `a` channel of this texture specifies
  * roughness, independent of the base layer's roughness.
  */
  setSheenRoughnessTexture(texture) {
    return this.setRef("sheenRoughnessTexture", texture, { channels: A$1 });
  }
};
var KHRMaterialsSheen = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_SHEEN;
  extensionName = KHR_MATERIALS_SHEEN;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new Sheen property for use on a {@link Material}. */
  createSheen() {
    return new Sheen(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    const jsonDoc = context.jsonDoc;
    const materialDefs = jsonDoc.json.materials || [];
    const textureDefs = jsonDoc.json.textures || [];
    materialDefs.forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_sheen"]) {
        const sheen = this.createSheen();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_SHEEN, sheen);
        const sheenDef = materialDef.extensions[KHR_MATERIALS_SHEEN];
        if (sheenDef.sheenColorFactor !== void 0) sheen.setSheenColorFactor(sheenDef.sheenColorFactor);
        if (sheenDef.sheenRoughnessFactor !== void 0) sheen.setSheenRoughnessFactor(sheenDef.sheenRoughnessFactor);
        if (sheenDef.sheenColorTexture !== void 0) {
          const textureInfoDef = sheenDef.sheenColorTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          sheen.setSheenColorTexture(texture);
          context.setTextureInfo(sheen.getSheenColorTextureInfo(), textureInfoDef);
        }
        if (sheenDef.sheenRoughnessTexture !== void 0) {
          const textureInfoDef = sheenDef.sheenRoughnessTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          sheen.setSheenRoughnessTexture(texture);
          context.setTextureInfo(sheen.getSheenRoughnessTextureInfo(), textureInfoDef);
        }
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const sheen = material.getExtension(KHR_MATERIALS_SHEEN);
      if (sheen) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        const sheenDef = materialDef.extensions[KHR_MATERIALS_SHEEN] = {
          sheenColorFactor: sheen.getSheenColorFactor(),
          sheenRoughnessFactor: sheen.getSheenRoughnessFactor()
        };
        if (sheen.getSheenColorTexture()) {
          const texture = sheen.getSheenColorTexture();
          const textureInfo = sheen.getSheenColorTextureInfo();
          sheenDef.sheenColorTexture = context.createTextureInfoDef(texture, textureInfo);
        }
        if (sheen.getSheenRoughnessTexture()) {
          const texture = sheen.getSheenRoughnessTexture();
          const textureInfo = sheen.getSheenRoughnessTextureInfo();
          sheenDef.sheenRoughnessTexture = context.createTextureInfoDef(texture, textureInfo);
        }
      }
    });
    return this;
  }
};
var { R: R$1, G: G$1, B: B2, A: A2 } = TextureChannel;
var Specular = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_SPECULAR;
  init() {
    this.extensionName = KHR_MATERIALS_SPECULAR;
    this.propertyType = "Specular";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      specularFactor: 1,
      specularTexture: null,
      specularTextureInfo: new TextureInfo(this.graph, "specularTextureInfo"),
      specularColorFactor: [
        1,
        1,
        1
      ],
      specularColorTexture: null,
      specularColorTextureInfo: new TextureInfo(this.graph, "specularColorTextureInfo")
    });
  }
  /**********************************************************************************************
  * Specular.
  */
  /** Specular; linear multiplier. See {@link Specular.getSpecularTexture getSpecularTexture}. */
  getSpecularFactor() {
    return this.get("specularFactor");
  }
  /** Specular; linear multiplier. See {@link Specular.getSpecularTexture getSpecularTexture}. */
  setSpecularFactor(factor) {
    return this.set("specularFactor", factor);
  }
  /** Specular color; Linear-sRGB components. See {@link Specular.getSpecularTexture getSpecularTexture}. */
  getSpecularColorFactor() {
    return this.get("specularColorFactor");
  }
  /** Specular color; Linear-sRGB components. See {@link Specular.getSpecularTexture getSpecularTexture}. */
  setSpecularColorFactor(factor) {
    return this.set("specularColorFactor", factor);
  }
  /**
  * Specular texture; linear multiplier. Configures the strength of the specular reflection in
  * the dielectric BRDF. A value of zero disables the specular reflection, resulting in a pure
  * diffuse material.
  *
  * Only the alpha (A) channel is used for specular strength, but this texture may optionally
  * be packed with specular color (RGB) into a single texture.
  */
  getSpecularTexture() {
    return this.getRef("specularTexture");
  }
  /**
  * Settings affecting the material's use of its specular texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getSpecularTextureInfo() {
    return this.getRef("specularTexture") ? this.getRef("specularTextureInfo") : null;
  }
  /** Sets specular texture. See {@link Specular.getSpecularTexture getSpecularTexture}. */
  setSpecularTexture(texture) {
    return this.setRef("specularTexture", texture, { channels: A2 });
  }
  /**
  * Specular color texture; linear multiplier. Defines the F0 color of the specular reflection
  * (RGB channels, encoded in sRGB) in the the dielectric BRDF.
  *
  * Only RGB channels are used here, but this texture may optionally be packed with a specular
  * factor (A) into a single texture.
  */
  getSpecularColorTexture() {
    return this.getRef("specularColorTexture");
  }
  /**
  * Settings affecting the material's use of its specular color texture. If no texture is
  * attached, {@link TextureInfo} is `null`.
  */
  getSpecularColorTextureInfo() {
    return this.getRef("specularColorTexture") ? this.getRef("specularColorTextureInfo") : null;
  }
  /** Sets specular color texture. See {@link Specular.getSpecularColorTexture getSpecularColorTexture}. */
  setSpecularColorTexture(texture) {
    return this.setRef("specularColorTexture", texture, {
      channels: R$1 | G$1 | B2,
      isColor: true
    });
  }
};
var KHRMaterialsSpecular = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_SPECULAR;
  extensionName = KHR_MATERIALS_SPECULAR;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new Specular property for use on a {@link Material}. */
  createSpecular() {
    return new Specular(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    const jsonDoc = context.jsonDoc;
    const materialDefs = jsonDoc.json.materials || [];
    const textureDefs = jsonDoc.json.textures || [];
    materialDefs.forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_specular"]) {
        const specular = this.createSpecular();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_SPECULAR, specular);
        const specularDef = materialDef.extensions[KHR_MATERIALS_SPECULAR];
        if (specularDef.specularFactor !== void 0) specular.setSpecularFactor(specularDef.specularFactor);
        if (specularDef.specularColorFactor !== void 0) specular.setSpecularColorFactor(specularDef.specularColorFactor);
        if (specularDef.specularTexture !== void 0) {
          const textureInfoDef = specularDef.specularTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          specular.setSpecularTexture(texture);
          context.setTextureInfo(specular.getSpecularTextureInfo(), textureInfoDef);
        }
        if (specularDef.specularColorTexture !== void 0) {
          const textureInfoDef = specularDef.specularColorTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          specular.setSpecularColorTexture(texture);
          context.setTextureInfo(specular.getSpecularColorTextureInfo(), textureInfoDef);
        }
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const specular = material.getExtension(KHR_MATERIALS_SPECULAR);
      if (specular) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        const specularDef = materialDef.extensions[KHR_MATERIALS_SPECULAR] = {};
        if (specular.getSpecularFactor() !== 1) specularDef.specularFactor = specular.getSpecularFactor();
        if (!MathUtils.eq(specular.getSpecularColorFactor(), [
          1,
          1,
          1
        ])) specularDef.specularColorFactor = specular.getSpecularColorFactor();
        if (specular.getSpecularTexture()) {
          const texture = specular.getSpecularTexture();
          const textureInfo = specular.getSpecularTextureInfo();
          specularDef.specularTexture = context.createTextureInfoDef(texture, textureInfo);
        }
        if (specular.getSpecularColorTexture()) {
          const texture = specular.getSpecularColorTexture();
          const textureInfo = specular.getSpecularColorTextureInfo();
          specularDef.specularColorTexture = context.createTextureInfoDef(texture, textureInfo);
        }
      }
    });
    return this;
  }
};
var { R: R2 } = TextureChannel;
var Transmission = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_TRANSMISSION;
  init() {
    this.extensionName = KHR_MATERIALS_TRANSMISSION;
    this.propertyType = "Transmission";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      transmissionFactor: 0,
      transmissionTexture: null,
      transmissionTextureInfo: new TextureInfo(this.graph, "transmissionTextureInfo")
    });
  }
  /**********************************************************************************************
  * Transmission.
  */
  /** Transmission; linear multiplier. See {@link Transmission.getTransmissionTexture getTransmissionTexture}. */
  getTransmissionFactor() {
    return this.get("transmissionFactor");
  }
  /** Transmission; linear multiplier. See {@link Transmission.getTransmissionTexture getTransmissionTexture}. */
  setTransmissionFactor(factor) {
    return this.set("transmissionFactor", factor);
  }
  /**
  * Transmission texture; linear multiplier. The `r` channel of this texture specifies
  * transmission [0-1] of the material's surface. By default this is a thin transparency
  * effect, but volume effects (refraction, subsurface scattering) may be introduced with the
  * addition of the `KHR_materials_volume` extension.
  */
  getTransmissionTexture() {
    return this.getRef("transmissionTexture");
  }
  /**
  * Settings affecting the material's use of its transmission texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getTransmissionTextureInfo() {
    return this.getRef("transmissionTexture") ? this.getRef("transmissionTextureInfo") : null;
  }
  /** Sets transmission texture. See {@link Transmission.getTransmissionTexture getTransmissionTexture}. */
  setTransmissionTexture(texture) {
    return this.setRef("transmissionTexture", texture, { channels: R2 });
  }
};
var KHRMaterialsTransmission = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_TRANSMISSION;
  extensionName = KHR_MATERIALS_TRANSMISSION;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new Transmission property for use on a {@link Material}. */
  createTransmission() {
    return new Transmission(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    const jsonDoc = context.jsonDoc;
    const materialDefs = jsonDoc.json.materials || [];
    const textureDefs = jsonDoc.json.textures || [];
    materialDefs.forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_transmission"]) {
        const transmission = this.createTransmission();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_TRANSMISSION, transmission);
        const transmissionDef = materialDef.extensions[KHR_MATERIALS_TRANSMISSION];
        if (transmissionDef.transmissionFactor !== void 0) transmission.setTransmissionFactor(transmissionDef.transmissionFactor);
        if (transmissionDef.transmissionTexture !== void 0) {
          const textureInfoDef = transmissionDef.transmissionTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          transmission.setTransmissionTexture(texture);
          context.setTextureInfo(transmission.getTransmissionTextureInfo(), textureInfoDef);
        }
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const transmission = material.getExtension(KHR_MATERIALS_TRANSMISSION);
      if (transmission) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        const transmissionDef = materialDef.extensions[KHR_MATERIALS_TRANSMISSION] = { transmissionFactor: transmission.getTransmissionFactor() };
        if (transmission.getTransmissionTexture()) {
          const texture = transmission.getTransmissionTexture();
          const textureInfo = transmission.getTransmissionTextureInfo();
          transmissionDef.transmissionTexture = context.createTextureInfoDef(texture, textureInfo);
        }
      }
    });
    return this;
  }
};
var Unlit = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_UNLIT;
  init() {
    this.extensionName = KHR_MATERIALS_UNLIT;
    this.propertyType = "Unlit";
    this.parentTypes = [PropertyType.MATERIAL];
  }
};
var KHRMaterialsUnlit = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_UNLIT;
  extensionName = KHR_MATERIALS_UNLIT;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new Unlit property for use on a {@link Material}. */
  createUnlit() {
    return new Unlit(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    (context.jsonDoc.json.materials || []).forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_unlit"]) context.materials[materialIndex].setExtension(KHR_MATERIALS_UNLIT, this.createUnlit());
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      if (material.getExtension("KHR_materials_unlit")) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        materialDef.extensions[KHR_MATERIALS_UNLIT] = {};
      }
    });
    return this;
  }
};
var Mapping = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_VARIANTS;
  init() {
    this.extensionName = KHR_MATERIALS_VARIANTS;
    this.propertyType = "Mapping";
    this.parentTypes = ["MappingList"];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      material: null,
      variants: new RefSet()
    });
  }
  /** The {@link Material} designated for this {@link Primitive}, under the given variants. */
  getMaterial() {
    return this.getRef("material");
  }
  /** The {@link Material} designated for this {@link Primitive}, under the given variants. */
  setMaterial(material) {
    return this.setRef("material", material);
  }
  /** Adds a {@link Variant} to this mapping. */
  addVariant(variant) {
    return this.addRef("variants", variant);
  }
  /** Removes a {@link Variant} from this mapping. */
  removeVariant(variant) {
    return this.removeRef("variants", variant);
  }
  /** Lists {@link Variant}s in this mapping. */
  listVariants() {
    return this.listRefs("variants");
  }
};
var MappingList = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_VARIANTS;
  init() {
    this.extensionName = KHR_MATERIALS_VARIANTS;
    this.propertyType = "MappingList";
    this.parentTypes = [PropertyType.PRIMITIVE];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { mappings: new RefSet() });
  }
  /** Adds a {@link Mapping} to this mapping. */
  addMapping(mapping) {
    return this.addRef("mappings", mapping);
  }
  /** Removes a {@link Mapping} from the list for this {@link Primitive}. */
  removeMapping(mapping) {
    return this.removeRef("mappings", mapping);
  }
  /** Lists {@link Mapping}s in this {@link Primitive}. */
  listMappings() {
    return this.listRefs("mappings");
  }
};
var Variant = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_VARIANTS;
  init() {
    this.extensionName = KHR_MATERIALS_VARIANTS;
    this.propertyType = "Variant";
    this.parentTypes = ["MappingList"];
  }
};
var KHRMaterialsVariants = class extends Extension {
  extensionName = KHR_MATERIALS_VARIANTS;
  static EXTENSION_NAME = KHR_MATERIALS_VARIANTS;
  /** Creates a new MappingList property. */
  createMappingList() {
    return new MappingList(this.document.getGraph());
  }
  /** Creates a new Variant property. */
  createVariant(name = "") {
    return new Variant(this.document.getGraph(), name);
  }
  /** Creates a new Mapping property. */
  createMapping() {
    return new Mapping(this.document.getGraph());
  }
  /** Lists all Variants on the current Document. */
  listVariants() {
    return Array.from(this.properties).filter((prop) => prop instanceof Variant);
  }
  /** @hidden */
  read(context) {
    const jsonDoc = context.jsonDoc;
    if (!jsonDoc.json.extensions || !jsonDoc.json.extensions["KHR_materials_variants"]) return this;
    const variants = (jsonDoc.json.extensions["KHR_materials_variants"].variants || []).map((variantDef) => this.createVariant().setName(variantDef.name || ""));
    (jsonDoc.json.meshes || []).forEach((meshDef, meshIndex) => {
      const mesh = context.meshes[meshIndex];
      (meshDef.primitives || []).forEach((primDef, primIndex) => {
        if (!primDef.extensions || !primDef.extensions["KHR_materials_variants"]) return;
        const mappingList = this.createMappingList();
        const variantPrimDef = primDef.extensions[KHR_MATERIALS_VARIANTS];
        for (const mappingDef of variantPrimDef.mappings) {
          const mapping = this.createMapping();
          if (mappingDef.material !== void 0) mapping.setMaterial(context.materials[mappingDef.material]);
          for (const variantIndex of mappingDef.variants || []) mapping.addVariant(variants[variantIndex]);
          mappingList.addMapping(mapping);
        }
        mesh.listPrimitives()[primIndex].setExtension(KHR_MATERIALS_VARIANTS, mappingList);
      });
    });
    return this;
  }
  /** @hidden */
  write(context) {
    const jsonDoc = context.jsonDoc;
    const variants = this.listVariants();
    if (!variants.length) return this;
    const variantDefs = [];
    const variantIndexMap = /* @__PURE__ */ new Map();
    for (const variant of variants) {
      variantIndexMap.set(variant, variantDefs.length);
      variantDefs.push(context.createPropertyDef(variant));
    }
    for (const mesh of this.document.getRoot().listMeshes()) {
      const meshIndex = context.meshIndexMap.get(mesh);
      mesh.listPrimitives().forEach((prim, primIndex) => {
        const mappingList = prim.getExtension(KHR_MATERIALS_VARIANTS);
        if (!mappingList) return;
        const primDef = context.jsonDoc.json.meshes[meshIndex].primitives[primIndex];
        const mappingDefs = mappingList.listMappings().map((mapping) => {
          const mappingDef = context.createPropertyDef(mapping);
          const material = mapping.getMaterial();
          if (material) mappingDef.material = context.materialIndexMap.get(material);
          mappingDef.variants = mapping.listVariants().map((variant) => variantIndexMap.get(variant));
          return mappingDef;
        });
        primDef.extensions = primDef.extensions || {};
        primDef.extensions[KHR_MATERIALS_VARIANTS] = { mappings: mappingDefs };
      });
    }
    jsonDoc.json.extensions = jsonDoc.json.extensions || {};
    jsonDoc.json.extensions[KHR_MATERIALS_VARIANTS] = { variants: variantDefs };
    return this;
  }
};
var { G: G2 } = TextureChannel;
var Volume = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_MATERIALS_VOLUME;
  init() {
    this.extensionName = KHR_MATERIALS_VOLUME;
    this.propertyType = "Volume";
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      thicknessFactor: 0,
      thicknessTexture: null,
      thicknessTextureInfo: new TextureInfo(this.graph, "thicknessTexture"),
      attenuationDistance: Infinity,
      attenuationColor: [
        1,
        1,
        1
      ]
    });
  }
  /**********************************************************************************************
  * Thickness.
  */
  /**
  * Thickness of the volume beneath the surface in meters in the local coordinate system of the
  * node. If the value is 0 the material is thin-walled. Otherwise the material is a volume
  * boundary. The doubleSided property has no effect on volume boundaries.
  */
  getThicknessFactor() {
    return this.get("thicknessFactor");
  }
  /**
  * Thickness of the volume beneath the surface in meters in the local coordinate system of the
  * node. If the value is 0 the material is thin-walled. Otherwise the material is a volume
  * boundary. The doubleSided property has no effect on volume boundaries.
  */
  setThicknessFactor(factor) {
    return this.set("thicknessFactor", factor);
  }
  /**
  * Texture that defines the thickness, stored in the G channel. This will be multiplied by
  * thicknessFactor.
  */
  getThicknessTexture() {
    return this.getRef("thicknessTexture");
  }
  /**
  * Settings affecting the material's use of its thickness texture. If no texture is attached,
  * {@link TextureInfo} is `null`.
  */
  getThicknessTextureInfo() {
    return this.getRef("thicknessTexture") ? this.getRef("thicknessTextureInfo") : null;
  }
  /**
  * Texture that defines the thickness, stored in the G channel. This will be multiplied by
  * thicknessFactor.
  */
  setThicknessTexture(texture) {
    return this.setRef("thicknessTexture", texture, { channels: G2 });
  }
  /**********************************************************************************************
  * Attenuation.
  */
  /**
  * Density of the medium given as the average distance in meters that light travels in the
  * medium before interacting with a particle.
  */
  getAttenuationDistance() {
    return this.get("attenuationDistance");
  }
  /**
  * Density of the medium given as the average distance in meters that light travels in the
  * medium before interacting with a particle.
  */
  setAttenuationDistance(distance) {
    return this.set("attenuationDistance", distance);
  }
  /**
  * Color (linear) that white light turns into due to absorption when reaching the attenuation
  * distance.
  */
  getAttenuationColor() {
    return this.get("attenuationColor");
  }
  /**
  * Color (linear) that white light turns into due to absorption when reaching the attenuation
  * distance.
  */
  setAttenuationColor(color) {
    return this.set("attenuationColor", color);
  }
};
var KHRMaterialsVolume = class extends Extension {
  static EXTENSION_NAME = KHR_MATERIALS_VOLUME;
  extensionName = KHR_MATERIALS_VOLUME;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  /** Creates a new Volume property for use on a {@link Material}. */
  createVolume() {
    return new Volume(this.document.getGraph());
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(_context) {
    return this;
  }
  /** @hidden */
  preread(context) {
    const jsonDoc = context.jsonDoc;
    const materialDefs = jsonDoc.json.materials || [];
    const textureDefs = jsonDoc.json.textures || [];
    materialDefs.forEach((materialDef, materialIndex) => {
      if (materialDef.extensions && materialDef.extensions["KHR_materials_volume"]) {
        const volume = this.createVolume();
        context.materials[materialIndex].setExtension(KHR_MATERIALS_VOLUME, volume);
        const volumeDef = materialDef.extensions[KHR_MATERIALS_VOLUME];
        if (volumeDef.thicknessFactor !== void 0) volume.setThicknessFactor(volumeDef.thicknessFactor);
        if (volumeDef.attenuationDistance !== void 0) volume.setAttenuationDistance(volumeDef.attenuationDistance);
        if (volumeDef.attenuationColor !== void 0) volume.setAttenuationColor(volumeDef.attenuationColor);
        if (volumeDef.thicknessTexture !== void 0) {
          const textureInfoDef = volumeDef.thicknessTexture;
          const texture = context.textures[textureDefs[textureInfoDef.index].source];
          volume.setThicknessTexture(texture);
          context.setTextureInfo(volume.getThicknessTextureInfo(), textureInfoDef);
        }
      }
    });
    return this;
  }
  /** @hidden */
  prewrite(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listMaterials().forEach((material) => {
      const volume = material.getExtension(KHR_MATERIALS_VOLUME);
      if (volume) {
        const materialIndex = context.materialIndexMap.get(material);
        const materialDef = jsonDoc.json.materials[materialIndex];
        materialDef.extensions = materialDef.extensions || {};
        const volumeDef = materialDef.extensions[KHR_MATERIALS_VOLUME] = {};
        if (volume.getThicknessFactor() > 0) volumeDef.thicknessFactor = volume.getThicknessFactor();
        if (Number.isFinite(volume.getAttenuationDistance())) volumeDef.attenuationDistance = volume.getAttenuationDistance();
        if (!MathUtils.eq(volume.getAttenuationColor(), [
          1,
          1,
          1
        ])) volumeDef.attenuationColor = volume.getAttenuationColor();
        if (volume.getThicknessTexture()) {
          const texture = volume.getThicknessTexture();
          const textureInfo = volume.getThicknessTextureInfo();
          volumeDef.thicknessTexture = context.createTextureInfoDef(texture, textureInfo);
        }
      }
    });
    return this;
  }
};
var KHRMeshPrimitiveRestart = class extends Extension {
  extensionName = KHR_MESH_PRIMITIVE_RESTART;
  static EXTENSION_NAME = KHR_MESH_PRIMITIVE_RESTART;
  /** @hidden */
  read(_) {
    return this;
  }
  /** @hidden */
  write(_) {
    return this;
  }
};
var KHRMeshQuantization = class extends Extension {
  extensionName = KHR_MESH_QUANTIZATION;
  static EXTENSION_NAME = KHR_MESH_QUANTIZATION;
  /** @hidden */
  read(_) {
    return this;
  }
  /** @hidden */
  write(_) {
    return this;
  }
};
var Visibility = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_NODE_VISIBILITY;
  init() {
    this.extensionName = KHR_NODE_VISIBILITY;
    this.propertyType = "Visibility";
    this.parentTypes = [PropertyType.NODE];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), { visible: true });
  }
  /** Visibility of node and descendants. */
  getVisible() {
    return this.get("visible");
  }
  /** Visibility of node and descendants. */
  setVisible(visible) {
    return this.set("visible", visible);
  }
};
var KHRNodeVisibility = class extends Extension {
  static EXTENSION_NAME = KHR_NODE_VISIBILITY;
  extensionName = KHR_NODE_VISIBILITY;
  /** Creates a new Visibility property for use on a {@link Node}. */
  createVisibility() {
    return new Visibility(this.document.getGraph());
  }
  /** @hidden */
  read(context) {
    (context.jsonDoc.json.nodes || []).forEach((nodeDef, nodeIndex) => {
      if (nodeDef.extensions && nodeDef.extensions["KHR_node_visibility"]) {
        const visibility = this.createVisibility();
        context.nodes[nodeIndex].setExtension(KHR_NODE_VISIBILITY, visibility);
        const visibilityDef = nodeDef.extensions[KHR_NODE_VISIBILITY];
        if (visibilityDef.visible !== void 0) visibility.setVisible(visibilityDef.visible);
      }
    });
    return this;
  }
  /** @hidden */
  write(context) {
    const jsonDoc = context.jsonDoc;
    for (const node of this.document.getRoot().listNodes()) {
      const visibility = node.getExtension(KHR_NODE_VISIBILITY);
      if (!visibility) continue;
      const nodeIndex = context.nodeIndexMap.get(node);
      const nodeDef = jsonDoc.json.nodes[nodeIndex];
      nodeDef.extensions = nodeDef.extensions || {};
      nodeDef.extensions[KHR_NODE_VISIBILITY] = { visible: visibility.getVisible() };
    }
    return this;
  }
};
function isUncompressed(container) {
  return container.vkFormat > VK_FORMAT_UNDEFINED && container.vkFormat <= VK_FORMAT_E5B9G9R9_UFLOAT_PACK32;
}
function isUniversal(container) {
  const isBasisHDR = container.vkFormat === VK_FORMAT_ASTC_4x4_SFLOAT_BLOCK_EXT && container.dataFormatDescriptor[0].colorModel === 167;
  return container.vkFormat === VK_FORMAT_UNDEFINED || isBasisHDR;
}
var KTX2ImageUtils = class {
  match(array) {
    return array[0] === 171 && array[1] === 75 && array[2] === 84 && array[3] === 88 && array[4] === 32 && array[5] === 50 && array[6] === 48 && array[7] === 187 && array[8] === 13 && array[9] === 10 && array[10] === 26 && array[11] === 10;
  }
  getSize(array) {
    const container = read(array);
    return [container.pixelWidth, container.pixelHeight];
  }
  getChannels(array) {
    const container = read(array);
    const dfd = container.dataFormatDescriptor[0];
    if (isUncompressed(container)) return dfd.samples.length;
    if (isUniversal(container)) switch (dfd.colorModel) {
      case KHR_DF_MODEL_ETC1S:
        return dfd.samples.length === 2 && (dfd.samples[1].channelType & 15) === 15 ? 4 : 3;
      case KHR_DF_MODEL_UASTC:
        return (dfd.samples[0].channelType & 15) === 3 ? 4 : 3;
      default:
        throw new Error(`Unexpected KTX2 colorModel, "${dfd.colorModel}".`);
    }
    throw new Error(`Unexpected KTX2 vkFormat, "${container.vkFormat}".`);
  }
  getVRAMByteLength(array) {
    const container = read(array);
    let uncompressedBytes = 0;
    if (isUniversal(container)) {
      const hasAlpha = this.getChannels(array) > 3;
      for (let i = 0; i < container.levels.length; i++) {
        const level = container.levels[i];
        if (level.uncompressedByteLength) uncompressedBytes += level.uncompressedByteLength;
        else {
          const levelWidth = Math.max(1, Math.floor(container.pixelWidth / Math.pow(2, i)));
          const levelHeight = Math.max(1, Math.floor(container.pixelHeight / Math.pow(2, i)));
          const blockSize = hasAlpha ? 16 : 8;
          uncompressedBytes += levelWidth / 4 * (levelHeight / 4) * blockSize;
        }
      }
    } else for (const level of container.levels) if (container.supercompressionScheme === KHR_SUPERCOMPRESSION_NONE) uncompressedBytes += level.levelData.byteLength;
    else uncompressedBytes += level.uncompressedByteLength;
    return uncompressedBytes;
  }
};
var KHRTextureBasisu = class extends Extension {
  static EXTENSION_NAME = KHR_TEXTURE_BASISU;
  extensionName = KHR_TEXTURE_BASISU;
  /** @hidden */
  prereadTypes = [PropertyType.TEXTURE];
  /** @hidden */
  static register() {
    ImageUtils.registerFormat("image/ktx2", new KTX2ImageUtils());
  }
  /** @hidden */
  preread(context) {
    if (context.jsonDoc.json.textures) context.jsonDoc.json.textures.forEach((textureDef) => {
      if (textureDef.extensions && textureDef.extensions["KHR_texture_basisu"]) textureDef.source = textureDef.extensions[KHR_TEXTURE_BASISU].source;
    });
    return this;
  }
  /** @hidden */
  read(_context) {
    return this;
  }
  /** @hidden */
  write(context) {
    const jsonDoc = context.jsonDoc;
    this.document.getRoot().listTextures().forEach((texture) => {
      if (texture.getMimeType() === "image/ktx2") {
        const imageIndex = context.imageIndexMap.get(texture);
        jsonDoc.json.textures.forEach((textureDef) => {
          if (textureDef.source === imageIndex) {
            textureDef.extensions = textureDef.extensions || {};
            textureDef.extensions[KHR_TEXTURE_BASISU] = { source: textureDef.source };
            delete textureDef.source;
          }
        });
      }
    });
    return this;
  }
};
var Transform = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_TEXTURE_TRANSFORM;
  init() {
    this.extensionName = KHR_TEXTURE_TRANSFORM;
    this.propertyType = "Transform";
    this.parentTypes = [PropertyType.TEXTURE_INFO];
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      offset: [0, 0],
      rotation: 0,
      scale: [1, 1],
      texCoord: null
    });
  }
  getOffset() {
    return this.get("offset");
  }
  setOffset(offset) {
    return this.set("offset", offset);
  }
  getRotation() {
    return this.get("rotation");
  }
  setRotation(rotation) {
    return this.set("rotation", rotation);
  }
  getScale() {
    return this.get("scale");
  }
  setScale(scale2) {
    return this.set("scale", scale2);
  }
  getTexCoord() {
    return this.get("texCoord");
  }
  setTexCoord(texCoord) {
    return this.set("texCoord", texCoord);
  }
};
var KHRTextureTransform = class extends Extension {
  extensionName = KHR_TEXTURE_TRANSFORM;
  static EXTENSION_NAME = KHR_TEXTURE_TRANSFORM;
  /** Creates a new Transform property for use on a {@link TextureInfo}. */
  createTransform() {
    return new Transform(this.document.getGraph());
  }
  /** @hidden */
  read(context) {
    for (const [textureInfo, textureInfoDef] of Array.from(context.textureInfos.entries())) {
      if (!textureInfoDef.extensions || !textureInfoDef.extensions["KHR_texture_transform"]) continue;
      const transform = this.createTransform();
      const transformDef = textureInfoDef.extensions[KHR_TEXTURE_TRANSFORM];
      if (transformDef.offset !== void 0) transform.setOffset(transformDef.offset);
      if (transformDef.rotation !== void 0) transform.setRotation(transformDef.rotation);
      if (transformDef.scale !== void 0) transform.setScale(transformDef.scale);
      if (transformDef.texCoord !== void 0) transform.setTexCoord(transformDef.texCoord);
      textureInfo.setExtension(KHR_TEXTURE_TRANSFORM, transform);
    }
    return this;
  }
  /** @hidden */
  write(context) {
    const textureInfoEntries = Array.from(context.textureInfoDefMap.entries());
    for (const [textureInfo, textureInfoDef] of textureInfoEntries) {
      const transform = textureInfo.getExtension(KHR_TEXTURE_TRANSFORM);
      if (!transform) continue;
      textureInfoDef.extensions = textureInfoDef.extensions || {};
      const transformDef = {};
      const eq = MathUtils.eq;
      if (!eq(transform.getOffset(), [0, 0])) transformDef.offset = transform.getOffset();
      if (transform.getRotation() !== 0) transformDef.rotation = transform.getRotation();
      if (!eq(transform.getScale(), [1, 1])) transformDef.scale = transform.getScale();
      if (transform.getTexCoord() != null) transformDef.texCoord = transform.getTexCoord();
      textureInfoDef.extensions[KHR_TEXTURE_TRANSFORM] = transformDef;
    }
    return this;
  }
};
var PARENT_TYPES = [
  PropertyType.ROOT,
  PropertyType.SCENE,
  PropertyType.NODE,
  PropertyType.MESH,
  PropertyType.MATERIAL,
  PropertyType.TEXTURE,
  PropertyType.ANIMATION
];
var Packet = class extends ExtensionProperty {
  static EXTENSION_NAME = KHR_XMP_JSON_LD;
  init() {
    this.extensionName = KHR_XMP_JSON_LD;
    this.propertyType = "Packet";
    this.parentTypes = PARENT_TYPES;
  }
  getDefaults() {
    return Object.assign(super.getDefaults(), {
      context: {},
      properties: {}
    });
  }
  /**********************************************************************************************
  * Context.
  */
  /**
  * Returns the XMP context definition URL for the given term.
  * See: https://json-ld.org/spec/latest/json-ld/#the-context
  * @param term Case-sensitive term. Usually a concise, lowercase, alphanumeric identifier.
  */
  getContext() {
    return this.get("context");
  }
  /**
  * Sets the XMP context definition URL for the given term.
  * See: https://json-ld.org/spec/latest/json-ld/#the-context
  *
  * Example:
  *
  * ```typescript
  * packet.setContext({
  *   dc: 'http://purl.org/dc/elements/1.1/',
  *   model3d: 'https://schema.khronos.org/model3d/xsd/1.0/',
  * });
  * ```
  *
  * @param term Case-sensitive term. Usually a concise, lowercase, alphanumeric identifier.
  * @param definition URI for XMP namespace.
  */
  setContext(context) {
    return this.set("context", { ...context });
  }
  /**********************************************************************************************
  * Properties.
  */
  /**
  * Lists properties defined in this packet.
  *
  * Example:
  *
  * ```typescript
  * packet.listProperties(); // → ['dc:Language', 'dc:Creator', 'xmp:CreateDate']
  * ```
  */
  listProperties() {
    return Object.keys(this.get("properties"));
  }
  /**
  * Returns the value of a property, as a literal or JSONLD object.
  *
  * Example:
  *
  * ```typescript
  * packet.getProperty('dc:Creator'); // → {"@list": ["Acme, Inc."]}
  * packet.getProperty('dc:Title'); // → {"@type": "rdf:Alt", "rdf:_1": {"@language": "en-US", "@value": "Lamp"}}
  * packet.getProperty('xmp:CreateDate'); // → "2022-01-01"
  * ```
  */
  getProperty(name) {
    const properties = this.get("properties");
    return name in properties ? properties[name] : null;
  }
  /**
  * Sets the value of a property, as a literal or JSONLD object.
  *
  * Example:
  *
  * ```typescript
  * packet.setProperty('dc:Creator', {'@list': ['Acme, Inc.']});
  * packet.setProperty('dc:Title', {
  * 	'@type': 'rdf:Alt',
  * 	'rdf:_1': {'@language': 'en-US', '@value': 'Lamp'}
  * });
  * packet.setProperty('model3d:preferredSurfaces', {'@list': ['vertical']});
  * ```
  */
  setProperty(name, value) {
    this._assertContext(name);
    const properties = { ...this.get("properties") };
    if (value) properties[name] = value;
    else delete properties[name];
    return this.set("properties", properties);
  }
  /**********************************************************************************************
  * Serialize / Deserialize.
  */
  /**
  * Serializes the packet context and properties to a JSONLD object.
  */
  toJSONLD() {
    const context = copyJSON(this.get("context"));
    const properties = copyJSON(this.get("properties"));
    return {
      "@context": context,
      ...properties
    };
  }
  /**
  * Deserializes a JSONLD packet, then overwrites existing context and properties with
  * the new values.
  */
  fromJSONLD(jsonld) {
    jsonld = copyJSON(jsonld);
    const context = jsonld["@context"];
    if (context) this.set("context", context);
    delete jsonld["@context"];
    return this.set("properties", jsonld);
  }
  /**********************************************************************************************
  * Validation.
  */
  /** @hidden */
  _assertContext(name) {
    if (!(name.split(":")[0] in this.get("context"))) throw new Error(`${KHR_XMP_JSON_LD}: Missing context for term, "${name}".`);
  }
};
function copyJSON(object) {
  return JSON.parse(JSON.stringify(object));
}
var KHRXMP = class extends Extension {
  extensionName = KHR_XMP_JSON_LD;
  static EXTENSION_NAME = KHR_XMP_JSON_LD;
  /** Creates a new XMP packet, to be linked with a {@link Document} or {@link Property Properties}. */
  createPacket() {
    return new Packet(this.document.getGraph());
  }
  /** Lists XMP packets currently defined in a {@link Document}. */
  listPackets() {
    return Array.from(this.properties);
  }
  /** @hidden */
  read(context) {
    const extensionDef = context.jsonDoc.json.extensions?.[KHR_XMP_JSON_LD];
    if (!extensionDef || !extensionDef.packets) return this;
    const json = context.jsonDoc.json;
    const root = this.document.getRoot();
    const packets = extensionDef.packets.map((packetDef) => this.createPacket().fromJSONLD(packetDef));
    const defLists = [
      [json.asset],
      json.scenes,
      json.nodes,
      json.meshes,
      json.materials,
      json.images,
      json.animations
    ];
    const propertyLists = [
      [root],
      root.listScenes(),
      root.listNodes(),
      root.listMeshes(),
      root.listMaterials(),
      root.listTextures(),
      root.listAnimations()
    ];
    for (let i = 0; i < defLists.length; i++) {
      const defs = defLists[i] || [];
      for (let j = 0; j < defs.length; j++) {
        const def = defs[j];
        if (def.extensions && def.extensions["KHR_xmp_json_ld"]) {
          const xmpDef = def.extensions[KHR_XMP_JSON_LD];
          propertyLists[i][j].setExtension(KHR_XMP_JSON_LD, packets[xmpDef.packet]);
        }
      }
    }
    return this;
  }
  /** @hidden */
  write(context) {
    const { json } = context.jsonDoc;
    const packetDefs = [];
    for (const packet of this.properties) {
      packetDefs.push(packet.toJSONLD());
      for (const parent of packet.listParents()) {
        let parentDef;
        switch (parent.propertyType) {
          case PropertyType.ROOT:
            parentDef = json.asset;
            break;
          case PropertyType.SCENE:
            parentDef = json.scenes[context.sceneIndexMap.get(parent)];
            break;
          case PropertyType.NODE:
            parentDef = json.nodes[context.nodeIndexMap.get(parent)];
            break;
          case PropertyType.MESH:
            parentDef = json.meshes[context.meshIndexMap.get(parent)];
            break;
          case PropertyType.MATERIAL:
            parentDef = json.materials[context.materialIndexMap.get(parent)];
            break;
          case PropertyType.TEXTURE:
            parentDef = json.images[context.imageIndexMap.get(parent)];
            break;
          case PropertyType.ANIMATION:
            parentDef = json.animations[context.animationIndexMap.get(parent)];
            break;
          default:
            parentDef = null;
            this.document.getLogger().warn(`[${KHR_XMP_JSON_LD}]: Unsupported parent property, "${parent.propertyType}"`);
            break;
        }
        if (!parentDef) continue;
        parentDef.extensions = parentDef.extensions || {};
        parentDef.extensions[KHR_XMP_JSON_LD] = { packet: packetDefs.length - 1 };
      }
    }
    if (packetDefs.length > 0) {
      json.extensions = json.extensions || {};
      json.extensions[KHR_XMP_JSON_LD] = { packets: packetDefs };
    }
    return this;
  }
};
var KHRONOS_EXTENSIONS = [
  KHRAccessorFloat16,
  KHRAccessorFloat64,
  KHRDracoMeshCompression,
  KHRLightsPunctual,
  KHRMaterialsAnisotropy,
  KHRMaterialsClearcoat,
  KHRMaterialsDiffuseTransmission,
  KHRMaterialsDispersion,
  KHRMaterialsEmissiveStrength,
  KHRMaterialsIOR,
  KHRMaterialsIridescence,
  KHRMaterialsPBRSpecularGlossiness,
  KHRMaterialsSpecular,
  KHRMaterialsSheen,
  KHRMaterialsTransmission,
  KHRMaterialsUnlit,
  KHRMaterialsVariants,
  KHRMaterialsVolume,
  KHRMeshPrimitiveRestart,
  KHRMeshQuantization,
  KHRNodeVisibility,
  KHRTextureBasisu,
  KHRTextureTransform,
  KHRXMP
];
var ALL_EXTENSIONS = [
  EXTMeshGPUInstancing,
  EXTMeshFeatures,
  EXTMeshoptCompression,
  EXTStructuralMetadata,
  EXTTextureAVIF,
  EXTTextureWebP,
  ...KHRONOS_EXTENSIONS
];

// node_modules/meshoptimizer/meshopt_encoder.module.js
var MeshoptEncoder = (function() {
  var wasm = "b9H79Tebbbe9ok9Geueu9Geub9Gbb9Gruuuuuuueu9Gvuuuuueu9Gduueu9Gluuuueu9Gvuuuuub9Gouuuuuub9Gluuuub9Giuuueui8AYdilveoveovrrwrrDDoDrbqqbelve9Weiiviebeoweuec;G:Qdkr:nlAo9TW9T9VV95dbH9F9F939H79T9F9J9H229F9Jt9VV7bb8F9TW79O9V9Wt9FW9U9J9V9KW9wWVtW949c919M9MWV9mW4W2be8A9TW79O9V9Wt9FW9U9J9V9KW9wWVtW949c919M9MWVbd8F9TW79O9V9Wt9FW9U9J9V9KW9wWVtW949c919M9MWV9c9V919U9KbiE9TW79O9V9Wt9FW9U9J9V9KW9wWVtW949wWV79P9V9UblY9TW79O9V9Wt9FW9U9J9V9KW69U9KW949c919M9MWVbv8E9TW79O9V9Wt9FW9U9J9V9KW69U9KW949c919M9MWV9c9V919U9Kbo8A9TW79O9V9Wt9FW9U9J9V9KW69U9KW949wWV79P9V9UbrE9TW79O9V9Wt9FW9U9J9V9KW69U9KW949tWG91W9U9JWbwa9TW79O9V9Wt9FW9U9J9V9KW69U9KW949tWG91W9U9JW9c9V919U9KbDL9TW79O9V9Wt9FW9U9J9V9KWS9P2tWV9p9JtbqK9TW79O9V9Wt9FW9U9J9V9KWS9P2tWV9r919HtbkL9TW79O9V9Wt9FW9U9J9V9KWS9P2tWVT949WbxE9TW79O9V9Wt9F9V9Wt9P9T9P96W9wWVtW94J9H9J9OWbsa9TW79O9V9Wt9F9V9Wt9P9T9P96W9wWVtW94J9H9J9OW9ttV9P9Wbza9TW79O9V9Wt9F9V9Wt9P9T9P96W9wWVtW94SWt9J9O9sW9T9H9WbHK9TW79O9V9Wt9F79W9Ht9P9H29t9VVt9sW9T9H9WbOl79IV9RbCDwebcekdKLqN9OYdbk:Bhdhud9:8Jjjjjbc;qw9Rgr8KjjjjbcbhwdnaeTmbabcbyd;C:kjjbaoaocb9iEgDc:GeV86bbarc;adfcbcjdz:wjjjb8AdnaiTmbarc;adfadalz:vjjjb8Akarc;abfalfcbcbcjdal9RalcFe0Ez:wjjjb8Aarc;abfarc;adfalz:vjjjb8AarcUf9cb83ibarc8Wf9cb83ibarcyf9cb83ibarcaf9cb83ibarcKf9cb83ibarczf9cb83ibar9cb83iwar9cb83ibcj;abal9Uc;WFbGcjdalca0Ehqdnaicd6mbavcd9imbaDTmbadcefhkaqci2gxal2hmarc;alfclfhParc;qlfceVhsarc;qofclVhzarc;qofcKfhHarc;qofczfhOcbhAincdhCcbhodnavci6mbaH9cb83ibaO9cb83ibar9cb83i;yoar9cb83i;qoadaAfgoybbhXcbhQincbhwcbhLdninaoalfhKaoybbgYaX7aLVhLawcP0meaKhoaYhXawcefgwaQfai6mbkkcbhXarc;qofhwincwh8AcwhEdnaLaX93gocFeGg3cs0mbclhEa3ci0mba3cb9hcethEkdnaocw4cFeGg3cs0mbclh8Aa3ci0mba3cb9hceth8Aka8AaEfh3awydbh5cwh8AcwhEdnaocz4cFeGg8Ecs0mbclhEa8Eci0mba8Ecb9hcethEka3a5fh3dnaocFFFFb0mbclh8AaocFFF8F0mbaocFFFr0ceth8Akawa3aEfa8AfBdbawclfhwaXcefgXcw9hmbkaKhoaYhXaQczfgQai6mbkcbhocehwazhLinawaoaLydbarc;qofaocdtfydb6EhoaLclfhLawcefgwcw9hmbkcihCkcbh3arc;qlfcbcjdz:wjjjb8Aarc;alfcwfcbBdbar9cb83i;alaoclth8Fadhaaqhhakh5inarc;qlfadcba3cufgoaoa30Eal2falz:vjjjb8Aaiahaiah6Ehgdnaqaia39Ra3aqfai6EgYcsfc9WGgoaY9nmbarc;qofaYfcbaoaY9Rz:wjjjb8Akada3al2fh8Jcbh8Kina8Ka8FVcl4hQarc;alfa8Kcdtfh8LaAh8Mcbh8Nina8NaAfhwdndndndndndna8KPldebidkasa8Mc98GgLfhoa5aLfh8Aarc;qlfawc98GgLfRbbhXcwhwinaoRbbawtaXVhXaocefhoawcwfgwca9hmbkaYTmla8Ncith8Ea8JaLfhEcbhKinaERbbhLcwhoa8AhwinawRbbaotaLVhLawcefhwaocwfgoca9hmbkarc;qofaKfaLaX7aQ93a8E486bba8Aalfh8AaEalfhEaLhXaKcefgKaY9hmbxlkkaYTmia8Mc9:Ghoa8NcitcwGhEarc;qlfawceVfRbbcwtarc;qlfawc9:GfRbbVhLarc;qofhwaghXinawa5aofRbbcwtaaaofRbbVg8AaL9RgLcetaLcztcz91cs47cFFiGaE486bbaoalfhoawcefhwa8AhLa3aXcufgX9hmbxikkaYTmda8Jawfhoarc;qlfawfRbbhLarc;qofhwaghXinawaoRbbg8AaL9RgLcetaLcKtcK91cr4786bbawcefhwaoalfhoa8AhLa3aXcufgX9hmbxdkkaYTmeka8LydbhEcbhKarc;qofhoincdhLcbhwinaLaoawfRbbcb9hfhLawcefgwcz9hmbkclhXcbhwinaXaoawfRbbcd0fhXawcefgwcz9hmbkcwh8Acbhwina8AaoawfRbbcP0fh8Aawcefgwcz9hmbkaLaXaLaX6Egwa8Aawa8A6Egwczawcz6EaEfhEaoczfhoaKczfgKaY6mbka8LaEBdbka8Mcefh8Ma8Ncefg8Ncl9hmbka8Kcefg8KaC9hmbkaaamfhaahaxfhha5amfh5a3axfg3ai6mbkcbhocehwaPhLinawaoaLydbarc;alfaocdtfydb6EhoaLclfhLawcefgXhwaCaX9hmbkaraAcd4fa8FcdVaoaocdSE86bbaAclfgAal6mbkkabaefh8Kabcefhoalcd4gecbaDEhkadcefhOarc;abfceVhHcbhmdndninaiam9nmearc;qofcbcjdz:wjjjb8Aa8Kao9Rak6mdadamal2gwfhxcbh8JaOawfhzaocbakz:wjjjbghakfh5aqaiam9Ramaqfai6Egscsfgocl4cifcd4hCaoc9WGg8LThPindndndndndndndndndndnaDTmbara8Jcd4fRbbgLciGPlbedlbkasTmdaxa8Jfhoarc;abfa8JfRbbhLarc;qofhwashXinawaoRbbg8AaL9RgLcetaLcKtcK91cr4786bbawcefhwaoalfhoa8AhLaXcufgXmbxikkasTmia8JcitcwGhEarc;abfa8JceVfRbbcwtarc;abfa8Jc9:GgofRbbVhLaxaofhoarc;qofhwashXinawao8Vbbg8AaL9RgLcetaLcztcz91cs47cFFiGaE486bbawcefhwaoalfhoa8AhLaXcufgXmbxdkkaHa8Jc98GgEfhoazaEfh8Aarc;abfaEfRbbhXcwhwinaoRbbawtaXVhXaocefhoawcwfgwca9hmbkasTmbaLcl4hYa8JcitcKGh3axaEfhEcbhKinaERbbhLcwhoa8AhwinawRbbaotaLVhLawcefhwaocwfgoca9hmbkarc;qofaKfaLaX7aY93a3486bba8Aalfh8AaEalfhEaLhXaKcefgKas9hmbkkaDmbcbhoxlka8LTmbcbhodninarc;qofaofgwcwf8Pibaw8Pib:e9qTmeaoczfgoa8L9pmdxbkkdnavmbcehoxikcbhEaChKaChYinarc;qofaEfgocwf8Pibhyao8Pibh8PcdhLcbhwinaLaoawfRbbcb9hfhLawcefgwcz9hmbkclhXcbhwinaXaoawfRbbcd0fhXawcefgwcz9hmbkcwh8Acbhwina8AaoawfRbbcP0fh8Aawcefgwcz9hmbkaLaXaLaX6Egoa8Aaoa8A6Egoczaocz6EaYfhYaocucbaya8P:e9cb9sEgwaoaw6EaKfhKaEczfgEa8L9pmdxbkkaha8Jcd4fgoaoRbbcda8JcetcoGtV86bbxikdnaKas6mbaYas6mbaha8Jcd4fgoaoRbbcia8JcetcoGtV86bba8Ka59Ras6mra5arc;qofasz:vjjjbasfh5xikaKaY9phokaha8Jcd4fgwawRbbaoa8JcetcoGtV86bbka8Ka59RaC6mla5cbaCz:wjjjbgAaCfhYdndna8LmbaPhoxekdna8KaY9RcK9pmbaPhoxekaocdtc:q1jjbfcj1jjbaDEg5ydxggcetc;:FFFeGh8Fcuh3cuagtcu7cFeGhacbh8Marc;qofhLinarc;qofa8MfhQczhEdndndnagPDbeeeeeeedekcucbaQcwf8PibaQ8Pib:e9cb9sEhExekcbhoa8FhEinaEaaaLaofRbb9nfhEaocefgocz9hmbkkcih8Ecbh8Ainczhwdndndna5a8AcdtfydbgKPDbeeeeeeedekcucbaQcwf8PibaQ8Pib:e9cb9sEhwxekaKcetc;:FFFeGhwcuaKtcu7cFeGhXcbhoinawaXaLaofRbb9nfhwaocefgocz9hmbkkdndnawaE6mbaKa39hmeawaE9hmea5a8EcdtfydbcwSmeka8Ah8EawhEka8Acefg8Aci9hmbkaAa8Mco4fgoaoRbba8Ea8Mci4coGtV86bbdndndna5a8Ecdtfydbg3PDdbbbbbbbebkdncwa39Tg8ETmbcua3tcu7hwdndna3ceSmbcbh8NaLhQinaQhoa8Eh8AcbhXinaoRbbgEawcFeGgKaEaK6EaXa3tVhXaocefhoa8Acufg8AmbkaYaX86bbaQa8EfhQaYcefhYa8Na8Efg8Ncz6mbxdkkcbh8NaLhQinaQhoa8Eh8AcbhXinaoRbbgEawcFeGgKaEaK6EaXcetVhXaocefhoa8Acufg8AmbkaYaX:T9cFe:d9c:c:qj:bw9:9c:q;c1:I1e:d9c:b:c:e1z9:9ca188bbaQa8EfhQaYcefhYa8Na8Efg8Ncz6mbkkcbhoinaYaLaofRbbgX86bbaYaXawcFeG9pfhYaocefgocz9hmbxikkdna3ceSmbinaYcb86bbaYcefhYxbkkinaYcb86bbaYcefhYxbkkaYaQ8Pbb83bbaYcwfaQcwf8Pbb83bbaYczfhYka8Mczfg8Ma8L9pgomeaLczfhLa8KaY9RcK9pmbkkaoTmlaYh5aYTmlka8Jcefg8Jal9hmbkarc;abfaxascufal2falz:vjjjb8Aasamfhma5hoa5mbkcbhwxdkdna8Kao9RakalfgwcKcaaDEgLawaL0EgX9pmbcbhwxdkdnawaL9pmbaocbaXaw9Rgwz:wjjjbawfhokaoarc;adfalz:vjjjbalfhodnaDTmbaoaraez:vjjjbaefhokaoab9Rhwxekcbhwkarc;qwf8Kjjjjbawk5babaeadaialcdcbyd;C:kjjbz:bjjjbk9reduaecd4gdaefgicaaica0Eabcj;abae9Uc;WFbGcjdaeca0Egifcufai9Uae2aiadfaicl4cifcd4f2fcefkmbcbabBd;C:kjjbk:Ese5u8Jjjjjbc;ae9Rgl8Kjjjjbcbhvdnaici9UgocHfae0mbabcbyd;m:kjjbgrc;GeV86bbalc;abfcFecjez:wjjjb8AalcUfgw9cu83ibalc8WfgD9cu83ibalcyfgq9cu83ibalcafgk9cu83ibalcKfgx9cu83ibalczfgm9cu83ibal9cu83iwal9cu83ibabaefc9WfhPabcefgsaofhednaiTmbcmcsarcb9kgzEhHcbhOcbhAcbhCcbhXcbhQindnaeaP9nmbcbhvxikaQcufhvadaCcdtfgLydbhKaLcwfydbhYaLclfydbh8AcbhEdndndninalc;abfavcsGcitfgoydlh3dndndnaoydbgoaK9hmba3a8ASmekdnaoa8A9hmba3aY9hmbaEcefhExekaoaY9hmea3aK9hmeaEcdfhEkaEc870mdaXcufhvaLaEciGcx2goc;i1jjbfydbcdtfydbh3aLaoc;e1jjbfydbcdtfydbh8AaLaoc;a1jjbfydbcdtfydbhKcbhodnindnalavcsGcdtfydba39hmbaohYxdkcuhYavcufhvaocefgocz9hmbkkaOa3aOSgvaYce9iaYaH9oVgoGfhOdndndncbcsavEaYaoEgvcs9hmbarce9imba3a3aAa3cefaASgvEgAcefSmecmcsavEhvkasavaEcdtc;WeGV86bbavcs9hmea3aA9Rgvcetavc8F917hvinaeavcFb0crtavcFbGV86bbaecefheavcje6hoavcr4hvaoTmbka3hAxvkcPhvasaEcdtcPV86bba3hAkavTmiavaH9omicdhocehEaQhYxlkavcufhvaEclfgEc;ab9hmbkkdnaLceaYaOSceta8AaOSEcx2gvc;a1jjbfydbcdtfydbgKTaLavc;e1jjbfydbcdtfydbg8AceSGaLavc;i1jjbfydbcdtfydbg3cdSGaOcb9hGazGg5ce9hmbaw9cu83ibaD9cu83ibaq9cu83ibak9cu83ibax9cu83ibam9cu83ibal9cu83iwal9cu83ibcbhOkcbhEaXcufgvhodnindnalaocsGcdtfydba8A9hmbaEhYxdkcuhYaocufhoaEcefgEcz9hmbkkcbhodnindnalavcsGcdtfydba39hmbaohExdkcuhEavcufhvaocefgocz9hmbkkaOaKaOSg8EfhLdndnaYcm0mbaYcefhYxekcbcsa8AaLSgvEhYaLavfhLkdndnaEcm0mbaEcefhExekcbcsa3aLSgvEhEaLavfhLkc9:cua8EEh8FcbhvaEaYcltVgacFeGhodndndninavc:W1jjbfRbbaoSmeavcefgvcz9hmbxdkka5aKaO9havcm0VVmbasavc;WeV86bbxekasa8F86bbaeaa86bbaecefhekdna8EmbaKaA9Rgvcetavc8F917hvinaeavcFb0gocrtavcFbGV86bbavcr4hvaecefheaombkaKhAkdnaYcs9hmba8AaA9Rgvcetavc8F917hvinaeavcFb0gocrtavcFbGV86bbavcr4hvaecefheaombka8AhAkdnaEcs9hmba3aA9Rgvcetavc8F917hvinaeavcFb0gocrtavcFbGV86bbavcr4hvaecefheaombka3hAkalaXcdtfaKBdbaXcefcsGhvdndnaYPzbeeeeeeeeeeeeeebekalavcdtfa8ABdbaXcdfcsGhvkdndnaEPzbeeeeeeeeeeeeeebekalavcdtfa3BdbavcefcsGhvkcihoalc;abfaQcitfgEaKBdlaEa8ABdbaQcefcsGhYcdhEavhXaLhOxekcdhoalaXcdtfa3BdbcehEaXcefcsGhXaQhYkalc;abfaYcitfgva8ABdlava3Bdbalc;abfaQaEfcsGcitfgva3BdlavaKBdbascefhsaQaofcsGhQaCcifgCai6mbkkdnaeaP9nmbcbhvxekcbhvinaeavfavc:W1jjbfRbb86bbavcefgvcz9hmbkaeab9Ravfhvkalc;aef8KjjjjbavkZeeucbhddninadcefgdc8F0meceadtae6mbkkadcrfcFeGcr9Uci2cdfabci9U2cHfkmbcbabBd;m:kjjbk:Adewu8Jjjjjbcz9Rhlcbhvdnaicvfae0mbcbhvabcbRb;m:kjjbc;qeV86bbal9cb83iwabcefhoabaefc98fhrdnaiTmbcbhwcbhDindnaoar6mbcbskadaDcdtfydbgqalcwfawaqav9Rgvavc8F91gv7av9Rc507gwcdtfgkydb9Rgvc8E91c9:Gavcdt7awVhvinaoavcFb0gecrtavcFbGV86bbavcr4hvaocefhoaembkakaqBdbaqhvaDcefgDai9hmbkkdnaoar9nmbcbskaocbBbbaoab9RclfhvkavkBeeucbhddninadcefgdc8F0meceadtae6mbkkadcwfcFeGcr9Uab2cvfk:bvli99dui99ludnaeTmbcuadcetcuftcu7:Zhvdndncuaicuftcu7:ZgoJbbbZMgr:lJbbb9p9DTmbar:Ohwxekcjjjj94hwkcbhicbhDinalclfIdbgrJbbbbJbbjZalIdbgq:lar:lMalcwfIdbgk:lMgr:varJbbbb9BEgrNhxaqarNhrdndnakJbbbb9GTmbaxhqxekJbbjZar:l:tgqaq:maxJbbbb9GEhqJbbjZax:l:tgxax:marJbbbb9GEhrkdndnalcxfIdbgxJbbj:;axJbbj:;9GEgkJbbjZakJbbjZ9FEavNJbbbZJbbb:;axJbbbb9GEMgx:lJbbb9p9DTmbax:Ohmxekcjjjj94hmkdndnaqJbbj:;aqJbbj:;9GEgxJbbjZaxJbbjZ9FEaoNJbbbZJbbb:;aqJbbbb9GEMgq:lJbbb9p9DTmbaq:OhPxekcjjjj94hPkdndnarJbbj:;arJbbj:;9GEgqJbbjZaqJbbjZ9FEaoNJbbbZJbbb:;arJbbbb9GEMgr:lJbbb9p9DTmbar:Ohsxekcjjjj94hskdndnadcl9hmbabaifgzas86bbazcifam86bbazcdfaw86bbazcefaP86bbxekabaDfgzas87ebazcofam87ebazclfaw87ebazcdfaP87ebkalczfhlaiclfhiaDcwfhDaecufgembkkk;hlld99eud99eudnaeTmbdndncuaicuftcu7:ZgvJbbbZMgo:lJbbb9p9DTmbao:Ohixekcjjjj94hikaic;8FiGhrinabcofcicdalclfIdb:lalIdb:l9EgialcwfIdb:lalaicdtfIdb:l9EEgialcxfIdb:lalaicdtfIdb:l9EEgiarV87ebdndnJbbj:;JbbjZalaicdtfIdbJbbbb9DEgoalaicd7cdtfIdbJ;Zl:1ZNNgwJbbj:;awJbbj:;9GEgDJbbjZaDJbbjZ9FEavNJbbbZJbbb:;awJbbbb9GEMgw:lJbbb9p9DTmbaw:Ohqxekcjjjj94hqkabcdfaq87ebdndnalaicefciGcdtfIdbJ;Zl:1ZNaoNgwJbbj:;awJbbj:;9GEgDJbbjZaDJbbjZ9FEavNJbbbZJbbb:;awJbbbb9GEMgw:lJbbb9p9DTmbaw:Ohqxekcjjjj94hqkabaq87ebdndnaoalaicufciGcdtfIdbJ;Zl:1ZNNgoJbbj:;aoJbbj:;9GEgwJbbjZawJbbjZ9FEavNJbbbZJbbb:;aoJbbbb9GEMgo:lJbbb9p9DTmbao:Ohixekcjjjj94hikabclfai87ebabcwfhbalczfhlaecufgembkkk;3viDue99eu8Jjjjjbcjd9Rgo8Kjjjjbadcd4hrdndndndnavcd9hmbadcl6meaohwarhDinawc:CuBdbawclfhwaDcufgDmbkaeTmiadcl6mdarcdthqalhkcbhxinaohwakhDarhminawawydbgPcbaDIdbgs:8cL4cFeGc:cufasJbbbb9BEgzaPaz9kEBdbaDclfhDawclfhwamcufgmmbkakaqfhkaxcefgxaeSmixbkkaeTmdxekaeTmekarcdthkavce9hhqadcl6hdcbhxindndndnaqmbadmdc:CuhDalhwarhminaDcbawIdbgs:8cL4cFeGc:cufasJbbbb9BEgPaDaP9kEhDawclfhwamcufgmmbxdkkc:CuhDdndnavPleddbdkadmdaohwalhmarhPinawcbamIdbgs:8cL4cFeGgzc;:bazc;:b0Ec:cufasJbbbb9BEBdbamclfhmawclfhwaPcufgPmbxdkkadmecbhwarhminaoawfcbalawfIdbgs:8cL4cFeGgPc8AaPc8A0Ec:cufasJbbbb9BEBdbawclfhwamcufgmmbkkadmbcbhwarhPinaDhmdnavceSmbaoawfydbhmkdndnalawfIdbgscjjj;8iamai9RcefgmcLt9R::NJbbbZJbbb:;asJbbbb9GEMgs:lJbbb9p9DTmbas:Ohzxekcjjjj94hzkabawfazcFFFrGamcKtVBdbawclfhwaPcufgPmbkkabakfhbalakfhlaxcefgxae9hmbkkaocjdf8Kjjjjbk;YqdXui998Jjjjjbc:qd9Rgv8Kjjjjbavc:Sefcbc;Kbz:wjjjb8AcbhodnadTmbcbhoaiTmbdndnabaeSmbaehrxekavcuadcdtgwadcFFFFi0Ecbyd;u:kjjbHjjjjbbgrBd:SeavceBd:mdaraeawz:vjjjb8Akavc:GefcwfcbBdbav9cb83i:Geavc:Gefaradaiavc:Sefz:ojjjbavyd:GehDadci9Ugqcbyd;u:kjjbHjjjjbbheavc:Sefavyd:mdgkcdtfaeBdbavakcefgwBd:mdaecbaqz:wjjjbhxavc:SefawcdtfcuaicdtaicFFFFi0Ecbyd;u:kjjbHjjjjbbgmBdbavakcdfgPBd:mdalc;ebfhsaDheamhwinawalIdbasaeydbgzcwazcw6EcdtfIdbMUdbaeclfheawclfhwaicufgimbkavc:SefaPcdtfcuaqcdtadcFFFF970Ecbyd;u:kjjbHjjjjbbgPBdbdnadci6mbarheaPhwaqhiinawamaeydbcdtfIdbamaeclfydbcdtfIdbMamaecwfydbcdtfIdbMUdbaecxfheawclfhwaicufgimbkkakcifhoalc;ebfhHavc;qbfhOavheavyd:KehAavyd:OehCcbhzcbhwcbhXcehQinaehLcihkarawci2gKcdtfgeydbhsaeclfydbhdabaXcx2fgicwfaecwfydbgYBdbaiclfadBdbaiasBdbaxawfce86bbaOaYBdwaOadBdlaOasBdbaPawcdtfcbBdbdnazTmbcihkaLhiinaOakcdtfaiydbgeBdbakaeaY9haeas9haead9hGGfhkaiclfhiazcufgzmbkkaXcefhXcbhzinaCaAarazaKfcdtfydbcdtgifydbcdtfgYheaDaifgdydbgshidnasTmbdninaeydbawSmeaeclfheaicufgiTmdxbkkaeaYascdtfc98fydbBdbadadydbcufBdbkazcefgzci9hmbkdndnakTmbcuhwJbbbbh8Acbhdavyd:KehYavyd:OehKindndnaDaOadcdtfydbcdtgzfydbgembadcefhdxekadcs0hiamazfgsIdbhEasalcbadcefgdaiEcdtfIdbaHaecwaecw6EcdtfIdbMg3Udba3aE:th3aecdthiaKaYazfydbcdtfheinaPaeydbgzcdtfgsa3asIdbMgEUdbaEa8Aa8AaE9DgsEh8AazawasEhwaeclfheaic98fgimbkkadak9hmbkawcu9hmekaQaq9pmdindnaxaQfRbbmbaQhwxdkaqaQcefgQ9hmbxikkakczakcz6EhzaOheaLhOawcu9hmbkkaocdtavc:Seffc98fhedninaoTmeaeydbcbyd;q:kjjbH:bjjjbbaec98fheaocufhoxbkkavc:qdf8Kjjjjbk;IlevucuaicdtgvaicFFFFi0Egocbyd;u:kjjbHjjjjbbhralalyd9GgwcdtfarBdbalawcefBd9GabarBdbaocbyd;u:kjjbHjjjjbbhralalyd9GgocdtfarBdbalaocefBd9GabarBdlcuadcdtadcFFFFi0Ecbyd;u:kjjbHjjjjbbhralalyd9GgocdtfarBdbalaocefBd9GabarBdwabydbcbavz:wjjjb8Aadci9UhDdnadTmbabydbhoaehladhrinaoalydbcdtfgvavydbcefBdbalclfhlarcufgrmbkkdnaiTmbabydbhlabydlhrcbhvaihoinaravBdbarclfhralydbavfhvalclfhlaocufgombkkdnadci6mbabydlhrabydwhvcbhlinaecwfydbhoaeclfydbhdaraeydbcdtfgwawydbgwcefBdbavawcdtfalBdbaradcdtfgdadydbgdcefBdbavadcdtfalBdbaraocdtfgoaoydbgocefBdbavaocdtfalBdbaecxfheaDalcefgl9hmbkkdnaiTmbabydlheabydbhlinaeaeydbalydb9RBdbalclfhlaeclfheaicufgimbkkkQbabaeadaic;K1jjbz:njjjbkQbabaeadaic;m:jjjbz:njjjbk9DeeuabcFeaicdtz:wjjjbhlcbhbdnadTmbindnalaeydbcdtfgiydbcu9hmbaiabBdbabcefhbkaeclfheadcufgdmbkkabk:Vvioud9:du8Jjjjjbc;Wa9Rgl8Kjjjjbcbhvalcxfcbc;Kbz:wjjjb8AalcuadcitgoadcFFFFe0Ecbyd;u:kjjbHjjjjbbgrBdxalceBd2araeadaicez:tjjjbalcuaoadcjjjjoGEcbyd;u:kjjbHjjjjbbgwBdzadcdthednadTmbabhiinaiavBdbaiclfhiadavcefgv9hmbkkawaefhDalabBdwalawBdl9cbhqindnadTmbaq9cq9:hkarhvaDhiadheinaiav8Pibak1:NcFrG87ebavcwfhvaicdfhiaecufgembkkalclfaq:NceGcdtfydbhxalclfaq9ce98gq:NceGcdtfydbhmalc;Wbfcbcjaz:wjjjb8AaDhvadhidnadTmbinalc;Wbfav8VebcdtfgeaeydbcefBdbavcdfhvaicufgimbkkcbhvcbhiinalc;WbfavfgeydbhoaeaiBdbaoaifhiavclfgvcja9hmbkadhvdndnadTmbinalc;WbfaDamydbgicetf8VebcdtfgeaeydbgecefBdbaxaecdtfaiBdbamclfhmavcufgvmbkaq9cv9smdcbhvinabawydbcdtfavBdbawclfhwadavcefgv9hmbxdkkaq9cv9smekkclhvdninavc98Smealcxfavfydbcbyd;q:kjjbH:bjjjbbavc98fhvxbkkalc;Waf8Kjjjjbk:Jwliuo99iud9:cbhv8Jjjjjbca9Rgoczfcwfcbyd:8:kjjbBdbaocb8Pd:0:kjjb83izaocwfcbyd;i:kjjbBdbaocb8Pd;a:kjjb83ibaicd4hrdndnadmbJFFuFhwJFFuuhDJFFuuhqJFFuFhkJFFuuhxJFFuFhmxekarcdthPaehsincbhiinaoczfaifgzasaifIdbgwazIdbgDaDaw9EEUdbaoaifgzawazIdbgDaDaw9DEUdbaiclfgicx9hmbkasaPfhsavcefgvad9hmbkaoIdKhDaoIdwhwaoIdChqaoIdlhkaoIdzhxaoIdbhmkdnadTmbJbbbbJbFu9hJbbbbamax:tgmamJbbbb9DEgmakaq:tgkakam9DEgkawaD:tgwawak9DEgw:vawJbbbb9BEhwdnalmbarcdthoindndnaeclfIdbaq:tawNJbbbZMgk:lJbbb9p9DTmbak:Ohixekcjjjj94hikai:S9cC:ghHdndnaeIdbax:tawNJbbbZMgk:lJbbb9p9DTmbak:Ohixekcjjjj94hikaHai:S:ehHdndnaecwfIdbaD:tawNJbbbZMgk:lJbbb9p9DTmbak:Ohixekcjjjj94hikabaHai:T9cy:g:e83ibaeaofheabcwfhbadcufgdmbxdkkarcdthoindndnaeIdbax:tawNJbbbZMgk:lJbbb9p9DTmbak:Ohixekcjjjj94hikai:SgH9ca:gaH9cz:g9cjjj;4s:d:eaH9cFe:d:e9cF:bj;4:pj;ar:d9c:bd9:9c:p;G:d;4j:E;ar:d9cH9:9c;d;H:W:y:m:g;d;Hb:d9cv9:9c;j:KM;j:KM;j:Kd:dhOdndnaeclfIdbaq:tawNJbbbZMgk:lJbbb9p9DTmbak:Ohixekcjjjj94hikai:SgH9ca:gaH9cz:g9cjjj;4s:d:eaH9cFe:d:e9cF:bj;4:pj;ar:d9c:bd9:9c:p;G:d;4j:E;ar:d9cH9:9c;d;H:W:y:m:g;d;Hb:d9cq9:9cM;j:KM;j:KM;jl:daO:ehOdndnaecwfIdbaD:tawNJbbbZMgk:lJbbb9p9DTmbak:Ohixekcjjjj94hikabaOai:SgH9ca:gaH9cz:g9cjjj;4s:d:eaH9cFe:d:e9cF:bj;4:pj;ar:d9c:bd9:9c:p;G:d;4j:E;ar:d9cH9:9c;d;H:W:y:m:g;d;Hb:d9cC9:9c:KM;j:KM;j:KMD:d:e83ibaeaofheabcwfhbadcufgdmbkkk9teiucbcbyd;y:kjjbgeabcifc98GfgbBd;y:kjjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik;teeeudndnaeabVciGTmbabhixekdndnadcz9pmbabhixekabhiinaiaeydbBdbaiaeydlBdlaiaeydwBdwaiaeydxBdxaeczfheaiczfhiadc9Wfgdcs0mbkkadcl6mbinaiaeydbBdbaeclfheaiclfhiadc98fgdci0mbkkdnadTmbinaiaeRbb86bbaicefhiaecefheadcufgdmbkkabk:3eedudndnabciGTmbabhixekaecFeGc:b:c:ew2hldndnadcz9pmbabhixekabhiinaialBdxaialBdwaialBdlaialBdbaiczfhiadc9Wfgdcs0mbkkadcl6mbinaialBdbaiclfhiadc98fgdci0mbkkdnadTmbinaiae86bbaicefhiadcufgdmbkkabk9teiucbcbyd;y:kjjbgeabcrfc94GfgbBd;y:kjjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik9:eiuZbhedndncbyd;y:kjjbgdaecztgi9nmbcuheadai9RcFFifcz4nbcuSmekadhekcbabae9Rcifc98Gcbyd;y:kjjbfgdBd;y:kjjbdnadZbcztge9nmbadae9RcFFifcz4nb8Akkk;Qddbcjwk;mdbbbbdbbblbbbwbbbbbbbebbbdbbblbbbwbbbbbbbbbbbbbbbb4:h9w9N94:P:gW:j9O:ye9Pbbbbbbebbbdbbbebbbdbbbbbbbdbbbbbbbebbbbbbb:l29hZ;69:9kZ;N;76Z;rg97Z;z;o9xZ8J;B85Z;:;u9yZ;b;k9HZ:2;Z9DZ9e:l9mZ59A8KZ:r;T3Z:A:zYZ79OHZ;j4::8::Y:D9V8:bbbb9s:49:Z8R:hBZ9M9M;M8:L;z;o8:;8:PG89q;x:J878R:hQ8::M:B;e87bbbbbbjZbbjZbbjZ:E;V;N8::Y:DsZ9i;H;68:xd;R8:;h0838:;W:NoZbbbb:WV9O8:uf888:9i;H;68:9c9G;L89;n;m9m89;D8Ko8:bbbbf:8tZ9m836ZS:2AZL;zPZZ818EZ9e:lxZ;U98F8:819E;68:FFuuFFuuFFuuFFuFFFuFFFuFbc;mqkzebbbebbbdbbb9G:vbb";
  var wasmpack = new Uint8Array([
    32,
    0,
    65,
    2,
    1,
    106,
    34,
    33,
    3,
    128,
    11,
    4,
    13,
    64,
    6,
    253,
    10,
    7,
    15,
    116,
    127,
    5,
    8,
    12,
    40,
    16,
    19,
    54,
    20,
    9,
    27,
    255,
    113,
    17,
    42,
    67,
    24,
    23,
    146,
    148,
    18,
    14,
    22,
    45,
    70,
    69,
    56,
    114,
    101,
    21,
    25,
    63,
    75,
    136,
    108,
    28,
    118,
    29,
    73,
    115
  ]);
  if (typeof WebAssembly !== "object") {
    return {
      supported: false
    };
  }
  var instance;
  var ready = WebAssembly.instantiate(unpack(wasm), {}).then(function(result) {
    instance = result.instance;
    instance.exports.__wasm_call_ctors();
    instance.exports.meshopt_encodeVertexVersion(0);
    instance.exports.meshopt_encodeIndexVersion(1);
  });
  function unpack(data) {
    var result = new Uint8Array(data.length);
    for (var i = 0; i < data.length; ++i) {
      var ch = data.charCodeAt(i);
      result[i] = ch > 96 ? ch - 97 : ch > 64 ? ch - 39 : ch + 4;
    }
    var write = 0;
    for (var i = 0; i < data.length; ++i) {
      result[write++] = result[i] < 60 ? wasmpack[result[i]] : (result[i] - 60) * 64 + result[++i];
    }
    return result.buffer.slice(0, write);
  }
  function assert(cond) {
    if (!cond) {
      throw new Error("Assertion failed");
    }
  }
  function bytes(view) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  function reorder(fun, indices, vertices, optf) {
    var sbrk = instance.exports.sbrk;
    var ip = sbrk(indices.length * 4);
    var rp = sbrk(vertices * 4);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    var indices8 = bytes(indices);
    heap.set(indices8, ip);
    if (optf) {
      optf(ip, ip, indices.length, vertices);
    }
    var unique = fun(rp, ip, indices.length, vertices);
    heap = new Uint8Array(instance.exports.memory.buffer);
    var remap = new Uint32Array(vertices);
    new Uint8Array(remap.buffer).set(heap.subarray(rp, rp + vertices * 4));
    indices8.set(heap.subarray(ip, ip + indices.length * 4));
    sbrk(ip - sbrk(0));
    for (var i = 0; i < indices.length; ++i) indices[i] = remap[indices[i]];
    return [remap, unique];
  }
  function spatialsort(fun, positions, count, stride) {
    var sbrk = instance.exports.sbrk;
    var ip = sbrk(count * 4);
    var sp = sbrk(count * stride);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(positions), sp);
    fun(ip, sp, count, stride);
    heap = new Uint8Array(instance.exports.memory.buffer);
    var remap = new Uint32Array(count);
    new Uint8Array(remap.buffer).set(heap.subarray(ip, ip + count * 4));
    sbrk(ip - sbrk(0));
    return remap;
  }
  function encode(fun, bound, source, count, size) {
    var sbrk = instance.exports.sbrk;
    var tp = sbrk(bound);
    var sp = sbrk(count * size);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(source), sp);
    var res = fun(tp, bound, sp, count, size);
    var target = new Uint8Array(res);
    target.set(heap.subarray(tp, tp + res));
    sbrk(tp - sbrk(0));
    return target;
  }
  function maxindex(source) {
    var result = 0;
    for (var i = 0; i < source.length; ++i) {
      var index = source[i];
      result = result < index ? index : result;
    }
    return result;
  }
  function index32(source, size) {
    assert(size == 2 || size == 4);
    if (size == 4) {
      return new Uint32Array(source.buffer, source.byteOffset, source.byteLength / 4);
    } else {
      var view = new Uint16Array(source.buffer, source.byteOffset, source.byteLength / 2);
      return new Uint32Array(view);
    }
  }
  function filter(fun, source, count, stride, bits, insize, mode) {
    var sbrk = instance.exports.sbrk;
    var tp = sbrk(count * stride);
    var sp = sbrk(count * insize);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(source), sp);
    fun(tp, count, stride, bits, sp, mode);
    var target = new Uint8Array(count * stride);
    target.set(heap.subarray(tp, tp + count * stride));
    sbrk(tp - sbrk(0));
    return target;
  }
  return {
    ready,
    supported: true,
    reorderMesh: function(indices, triangles, optsize) {
      var optf = triangles ? optsize ? instance.exports.meshopt_optimizeVertexCacheStrip : instance.exports.meshopt_optimizeVertexCache : void 0;
      return reorder(instance.exports.meshopt_optimizeVertexFetchRemap, indices, maxindex(indices) + 1, optf);
    },
    reorderPoints: function(positions, positions_stride) {
      assert(positions instanceof Float32Array);
      assert(positions.length % positions_stride == 0);
      assert(positions_stride >= 3);
      return spatialsort(instance.exports.meshopt_spatialSortRemap, positions, positions.length / positions_stride, positions_stride * 4);
    },
    encodeVertexBuffer: function(source, count, size) {
      assert(size > 0 && size <= 256);
      assert(size % 4 == 0);
      var bound = instance.exports.meshopt_encodeVertexBufferBound(count, size);
      return encode(instance.exports.meshopt_encodeVertexBuffer, bound, source, count, size);
    },
    encodeIndexBuffer: function(source, count, size) {
      assert(size == 2 || size == 4);
      assert(count % 3 == 0);
      var indices = index32(source, size);
      var bound = instance.exports.meshopt_encodeIndexBufferBound(count, maxindex(indices) + 1);
      return encode(instance.exports.meshopt_encodeIndexBuffer, bound, indices, count, 4);
    },
    encodeIndexSequence: function(source, count, size) {
      assert(size == 2 || size == 4);
      var indices = index32(source, size);
      var bound = instance.exports.meshopt_encodeIndexSequenceBound(count, maxindex(indices) + 1);
      return encode(instance.exports.meshopt_encodeIndexSequence, bound, indices, count, 4);
    },
    encodeGltfBuffer: function(source, count, size, mode) {
      var table = {
        ATTRIBUTES: this.encodeVertexBuffer,
        TRIANGLES: this.encodeIndexBuffer,
        INDICES: this.encodeIndexSequence
      };
      assert(table[mode]);
      return table[mode](source, count, size);
    },
    encodeFilterOct: function(source, count, stride, bits) {
      assert(stride == 4 || stride == 8);
      assert(bits >= 1 && bits <= 16);
      return filter(instance.exports.meshopt_encodeFilterOct, source, count, stride, bits, 16);
    },
    encodeFilterQuat: function(source, count, stride, bits) {
      assert(stride == 8);
      assert(bits >= 4 && bits <= 16);
      return filter(instance.exports.meshopt_encodeFilterQuat, source, count, stride, bits, 16);
    },
    encodeFilterExp: function(source, count, stride, bits, mode) {
      assert(stride > 0 && stride % 4 == 0);
      assert(bits >= 1 && bits <= 24);
      var table = {
        Separate: 0,
        SharedVector: 1,
        SharedComponent: 2,
        Clamped: 3
      };
      return filter(instance.exports.meshopt_encodeFilterExp, source, count, stride, bits, stride, mode ? table[mode] : 1);
    }
  };
})();

// node_modules/meshoptimizer/meshopt_decoder.module.js
var MeshoptDecoder = (function() {
  var wasm_base = "b9H79Tebbbe8Fv9Gbb9Gvuuuuueu9Giuuub9Geueu9Giuuueuikqbeeedddillviebeoweuec:W:Odkr;leDo9TW9T9VV95dbH9F9F939H79T9F9J9H229F9Jt9VV7bb8A9TW79O9V9Wt9F9KW9J9V9KW9wWVtW949c919M9MWVbeY9TW79O9V9Wt9F9KW9J9V9KW69U9KW949c919M9MWVbdE9TW79O9V9Wt9F9KW9J9V9KW69U9KW949tWG91W9U9JWbiL9TW79O9V9Wt9F9KW9J9V9KWS9P2tWV9p9JtblK9TW79O9V9Wt9F9KW9J9V9KWS9P2tWV9r919HtbvL9TW79O9V9Wt9F9KW9J9V9KWS9P2tWVT949Wbol79IV9Rbrq:S86qdbk;jYi5ud9:du8Jjjjjbcj;kb9Rgv8Kjjjjbc9:hodnalTmbcuhoaiRbbgrc;WeGc:Ge9hmbarcsGgwce0mbc9:hoalcufadcd4cbawEgDadfgrcKcaawEgqaraq0Egk6mbaicefhxcj;abad9Uc;WFbGcjdadca0EhmaialfgPar9Rgoadfhsavaoadz1jjjbgzceVhHcbhOdndninaeaO9nmeaPax9RaD6mdamaeaO9RaOamfgoae6EgAcsfglc9WGhCabaOad2fhXaAcethQaxaDfhiaOaeaoaeao6E9RhLalcl4cifcd4hKazcj;cbfaAfhYcbh8AazcjdfhEaHh3incbhodnawTmbaxa8Acd4fRbbhokaocFeGh5cbh8Eazcj;cbfhqinaih8Fdndndndna5a8Ecet4ciGgoc9:fPdebdkaPa8F9RaA6mrazcj;cbfa8EaA2fa8FaAz1jjjb8Aa8FaAfhixdkazcj;cbfa8EaA2fcbaAz:jjjjb8Aa8FhixekaPa8F9RaK6mva8FaKfhidnaCTmbaPai9RcK6mbaocdtc:q1jjbfcj1jjbawEhaczhrcbhlinargoc9Wfghaqfhrdndndndndndnaaa8Fahco4fRbbalcoG4ciGcdtfydbPDbedvivvvlvkar9cb83bbarcwf9cb83bbxlkarcbaiRbdai8Xbb9c:c:qj:bw9:9c:q;c1:I1e:d9c:b:c:e1z9:gg9cjjjjjz:dg8J9qE86bbaqaofgrcGfag9c8F1:NghcKtc8F91aicdfa8J9c8N1:Nfg8KRbbG86bbarcVfcba8KahcjeGcr4fghRbbag9cjjjjjl:dg8J9qE86bbarc7fcbaha8J9c8L1:NfghRbbag9cjjjjjd:dg8J9qE86bbarctfcbaha8J9c8K1:NfghRbbag9cjjjjje:dg8J9qE86bbarc91fcbaha8J9c8J1:NfghRbbag9cjjjj;ab:dg8J9qE86bbarc4fcbaha8J9cg1:NfghRbbag9cjjjja:dg8J9qE86bbarc93fcbaha8J9ch1:NfghRbbag9cjjjjz:dgg9qE86bbarc94fcbahag9ca1:NfghRbbai8Xbe9c:c:qj:bw9:9c:q;c1:I1e:d9c:b:c:e1z9:gg9cjjjjjz:dg8J9qE86bbarc95fag9c8F1:NgicKtc8F91aha8J9c8N1:NfghRbbG86bbarc96fcbahaicjeGcr4fgiRbbag9cjjjjjl:dg8J9qE86bbarc97fcbaia8J9c8L1:NfgiRbbag9cjjjjjd:dg8J9qE86bbarc98fcbaia8J9c8K1:NfgiRbbag9cjjjjje:dg8J9qE86bbarc99fcbaia8J9c8J1:NfgiRbbag9cjjjj;ab:dg8J9qE86bbarc9:fcbaia8J9cg1:NfgiRbbag9cjjjja:dg8J9qE86bbarcufcbaia8J9ch1:NfgiRbbag9cjjjjz:dgg9qE86bbaiag9ca1:NfhixikaraiRblaiRbbghco4g8Ka8KciSg8KE86bbaqaofgrcGfaiclfa8Kfg8KRbbahcl4ciGg8La8LciSg8LE86bbarcVfa8Ka8Lfg8KRbbahcd4ciGg8La8LciSg8LE86bbarc7fa8Ka8Lfg8KRbbahciGghahciSghE86bbarctfa8Kahfg8KRbbaiRbeghco4g8La8LciSg8LE86bbarc91fa8Ka8Lfg8KRbbahcl4ciGg8La8LciSg8LE86bbarc4fa8Ka8Lfg8KRbbahcd4ciGg8La8LciSg8LE86bbarc93fa8Ka8Lfg8KRbbahciGghahciSghE86bbarc94fa8Kahfg8KRbbaiRbdghco4g8La8LciSg8LE86bbarc95fa8Ka8Lfg8KRbbahcl4ciGg8La8LciSg8LE86bbarc96fa8Ka8Lfg8KRbbahcd4ciGg8La8LciSg8LE86bbarc97fa8Ka8Lfg8KRbbahciGghahciSghE86bbarc98fa8KahfghRbbaiRbigico4g8Ka8KciSg8KE86bbarc99faha8KfghRbbaicl4ciGg8Ka8KciSg8KE86bbarc9:faha8KfghRbbaicd4ciGg8Ka8KciSg8KE86bbarcufaha8KfgrRbbaiciGgiaiciSgiE86bbaraifhixdkaraiRbwaiRbbghcl4g8Ka8KcsSg8KE86bbaqaofgrcGfaicwfa8Kfg8KRbbahcsGghahcsSghE86bbarcVfa8KahfghRbbaiRbeg8Kcl4g8La8LcsSg8LE86bbarc7faha8LfghRbba8KcsGg8Ka8KcsSg8KE86bbarctfaha8KfghRbbaiRbdg8Kcl4g8La8LcsSg8LE86bbarc91faha8LfghRbba8KcsGg8Ka8KcsSg8KE86bbarc4faha8KfghRbbaiRbig8Kcl4g8La8LcsSg8LE86bbarc93faha8LfghRbba8KcsGg8Ka8KcsSg8KE86bbarc94faha8KfghRbbaiRblg8Kcl4g8La8LcsSg8LE86bbarc95faha8LfghRbba8KcsGg8Ka8KcsSg8KE86bbarc96faha8KfghRbbaiRbvg8Kcl4g8La8LcsSg8LE86bbarc97faha8LfghRbba8KcsGg8Ka8KcsSg8KE86bbarc98faha8KfghRbbaiRbog8Kcl4g8La8LcsSg8LE86bbarc99faha8LfghRbba8KcsGg8Ka8KcsSg8KE86bbarc9:faha8KfghRbbaiRbrgicl4g8Ka8KcsSg8KE86bbarcufaha8KfgrRbbaicsGgiaicsSgiE86bbaraifhixekarai8Pbb83bbarcwfaicwf8Pbb83bbaiczfhikdnaoaC9pmbalcdfhlaoczfhraPai9RcL0mekkaoaC6moaimexokaCmva8FTmvkaqaAfhqa8Ecefg8Ecl9hmbkdndndndnawTmbasa8Acd4fRbbgociGPlbedrbkaATmdaza8Afh8Fazcj;cbfhhcbh8EaEhaina8FRbbhraahocbhlinaoahalfRbbgqce4cbaqceG9R7arfgr86bbaoadfhoaAalcefgl9hmbkaacefhaa8Fcefh8FahaAfhha8Ecefg8Ecl9hmbxikkaATmeaza8Afhaazcj;cbfhhcbhoceh8EaYh8FinaEaofhlaa8Vbbhrcbhoinala8FaofRbbcwtahaofRbbgqVc;:FiGce4cbaqceG9R7arfgr87bbaladfhlaLaocefgofmbka8FaQfh8FcdhoaacdfhaahaQfhha8EceGhlcbh8EalmbxdkkaATmbcbaocl49Rh8Eaza8AfRbbhqcwhoa3hlinalRbbaotaqVhqalcefhlaocwfgoca9hmbkcbhhaEh8FaYhainazcj;cbfahfRbbhrcwhoaahlinalRbbaotarVhralaAfhlaocwfgoca9hmbkara8E93aq7hqcbhoa8Fhlinalaqao486bbalcefhlaocwfgoca9hmbka8Fadfh8FaacefhaahcefghaA9hmbkkaEclfhEa3clfh3a8Aclfg8Aad6mbkaXazcjdfaAad2z1jjjb8AazazcjdfaAcufad2fadz1jjjb8AaAaOfhOaihxaimbkc9:hoxdkcbc99aPax9RakSEhoxekc9:hokavcj;kbf8Kjjjjbaok:XseHu8Jjjjjbc;ae9Rgv8Kjjjjbc9:hodnaeci9UgrcHfal0mbcuhoaiRbbgwc;WeGc;Ge9hmbawcsGgDce0mbavc;abfcFecjez:jjjjb8AavcUf9cu83ibavc8Wf9cu83ibavcyf9cu83ibavcaf9cu83ibavcKf9cu83ibavczf9cu83ibav9cu83iwav9cu83ibaialfc9WfhqaicefgwarfhldnaeTmbcmcsaDceSEhkcbhxcbhmcbhrcbhicbhoindnalaq9nmbc9:hoxikdndnawRbbgDc;Ve0mbavc;abfaoaDcu7gPcl4fcsGcitfgsydlhzasydbhHdndnaDcsGgsak9pmbavaiaPfcsGcdtfydbaxasEhDaxasTgOfhxxekdndnascsSmbcehOasc987asamffcefhDxekalcefhDal8SbbgscFeGhPdndnascu9mmbaDhlxekalcvfhlaPcFbGhPcrhsdninaD8SbbgOcFbGastaPVhPaOcu9kmeaDcefhDascrfgsc8J9hmbxdkkaDcefhlkcehOaPce4cbaPceG9R7amfhDkaDhmkavc;abfaocitfgsaDBdbasazBdlavaicdtfaDBdbavc;abfaocefcsGcitfgsaHBdbasaDBdlaocdfhoaOaifhidnadcd9hmbabarcetfgsaH87ebasclfaD87ebascdfaz87ebxdkabarcdtfgsaHBdbascwfaDBdbasclfazBdbxekdnaDcpe0mbaxcefgOavaiaqaDcsGfRbbgscl49RcsGcdtfydbascz6gPEhDavaias9RcsGcdtfydbaOaPfgzascsGgOEhsaOThOdndnadcd9hmbabarcetfgHax87ebaHclfas87ebaHcdfaD87ebxekabarcdtfgHaxBdbaHcwfasBdbaHclfaDBdbkavaicdtfaxBdbavc;abfaocitfgHaDBdbaHaxBdlavaicefgicsGcdtfaDBdbavc;abfaocefcsGcitfgHasBdbaHaDBdlavaiaPfgicsGcdtfasBdbavc;abfaocdfcsGcitfgDaxBdbaDasBdlaocifhoaiaOfhiazaOfhxxekaxcbalRbbgHEgAaDc;:eSgDfhzaHcsGhCaHcl4hXdndnaHcs0mbazcefhOxekazhOavaiaX9RcsGcdtfydbhzkdndnaCmbaOcefhxxekaOhxavaiaH9RcsGcdtfydbhOkdndnaDTmbalcefhDxekalcdfhDal8SbegPcFeGhsdnaPcu9kmbalcofhAascFbGhscrhldninaD8SbbgPcFbGaltasVhsaPcu9kmeaDcefhDalcrfglc8J9hmbkaAhDxekaDcefhDkasce4cbasceG9R7amfgmhAkdndnaXcsSmbaDhsxekaDcefhsaD8SbbglcFeGhPdnalcu9kmbaDcvfhzaPcFbGhPcrhldninas8SbbgDcFbGaltaPVhPaDcu9kmeascefhsalcrfglc8J9hmbkazhsxekascefhskaPce4cbaPceG9R7amfgmhzkdndnaCcsSmbashlxekascefhlas8SbbgDcFeGhPdnaDcu9kmbascvfhOaPcFbGhPcrhDdninal8SbbgscFbGaDtaPVhPascu9kmealcefhlaDcrfgDc8J9hmbkaOhlxekalcefhlkaPce4cbaPceG9R7amfgmhOkdndnadcd9hmbabarcetfgDaA87ebaDclfaO87ebaDcdfaz87ebxekabarcdtfgDaABdbaDcwfaOBdbaDclfazBdbkavc;abfaocitfgDazBdbaDaABdlavaicdtfaABdbavc;abfaocefcsGcitfgDaOBdbaDazBdlavaicefgicsGcdtfazBdbavc;abfaocdfcsGcitfgDaABdbaDaOBdlavaiaHcz6aXcsSVfgicsGcdtfaOBdbaiaCTaCcsSVfhiaocifhokawcefhwaocsGhoaicsGhiarcifgrae6mbkkcbc99alaqSEhokavc;aef8Kjjjjbaok:clevu8Jjjjjbcz9Rhvdnaecvfal9nmbc9:skdnaiRbbc;:eGc;qeSmbcuskav9cb83iwaicefhoaialfc98fhrdnaeTmbdnadcdSmbcbhwindnaoar6mbc9:skaocefhlao8SbbgicFeGhddndnaicu9mmbalhoxekaocvfhoadcFbGhdcrhidninal8SbbgDcFbGaitadVhdaDcu9kmealcefhlaicrfgic8J9hmbxdkkalcefhokabawcdtfadc8Etc8F91adcd47avcwfadceGcdtVglydbfgiBdbalaiBdbawcefgwae9hmbxdkkcbhwindnaoar6mbc9:skaocefhlao8SbbgicFeGhddndnaicu9mmbalhoxekaocvfhoadcFbGhdcrhidninal8SbbgDcFbGaitadVhdaDcu9kmealcefhlaicrfgic8J9hmbxdkkalcefhokabawcetfadc8Etc8F91adcd47avcwfadceGcdtVglydbfgi87ebalaiBdbawcefgwae9hmbkkcbc99aoarSEk:Lvoeue99dud99eud99dndnadcl9hmbaeTmeindndnabcdfgd8Sbb:Yab8Sbbgi:Ygl:l:tabcefgv8Sbbgo:Ygr:l:tgwJbb;:9cawawNJbbbbawawJbbbb9GgDEgq:mgkaqaicb9iEalMgwawNakaqaocb9iEarMgqaqNMM:r:vglNJbbbZJbbb:;aDEMgr:lJbbb9p9DTmbar:Ohixekcjjjj94hikadai86bbdndnaqalNJbbbZJbbb:;aqJbbbb9GEMgq:lJbbb9p9DTmbaq:Ohdxekcjjjj94hdkavad86bbdndnawalNJbbbZJbbb:;awJbbbb9GEMgw:lJbbb9p9DTmbaw:Ohdxekcjjjj94hdkabad86bbabclfhbaecufgembxdkkaeTmbindndnabclfgd8Ueb:Yab8Uebgi:Ygl:l:tabcdfgv8Uebgo:Ygr:l:tgwJb;:FSawawNJbbbbawawJbbbb9GgDEgq:mgkaqaicb9iEalMgwawNakaqaocb9iEarMgqaqNMM:r:vglNJbbbZJbbb:;aDEMgr:lJbbb9p9DTmbar:Ohixekcjjjj94hikadai87ebdndnaqalNJbbbZJbbb:;aqJbbbb9GEMgq:lJbbb9p9DTmbaq:Ohdxekcjjjj94hdkavad87ebdndnawalNJbbbZJbbb:;awJbbbb9GEMgw:lJbbb9p9DTmbaw:Ohdxekcjjjj94hdkabad87ebabcwfhbaecufgembkkk;oiliui99iue99dnaeTmbcbhiabhlindndnJ;Zl81Zalcof8UebgvciV:Y:vgoal8Ueb:YNgrJb;:FSNJbbbZJbbb:;arJbbbb9GEMgw:lJbbb9p9DTmbaw:OhDxekcjjjj94hDkalclf8Uebhqalcdf8UebhkabaiavcefciGfcetfaD87ebdndnaoak:YNgwJb;:FSNJbbbZJbbb:;awJbbbb9GEMgx:lJbbb9p9DTmbax:OhDxekcjjjj94hDkabaiavciGfgkcd7cetfaD87ebdndnaoaq:YNgoJb;:FSNJbbbZJbbb:;aoJbbbb9GEMgx:lJbbb9p9DTmbax:OhDxekcjjjj94hDkabaiavcufciGfcetfaD87ebdndnJbbjZararN:tawawN:taoaoN:tgrJbbbbarJbbbb9GE:rJb;:FSNJbbbZMgr:lJbbb9p9DTmbar:Ohvxekcjjjj94hvkabakcetfav87ebalcwfhlaiclfhiaecufgembkkk9mbdnadcd4ae2gdTmbinababydbgecwtcw91:Yaece91cjjj98Gcjjj;8if::NUdbabclfhbadcufgdmbkkk9teiucbcbyd:K1jjbgeabcifc98GfgbBd:K1jjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik;teeeudndnaeabVciGTmbabhixekdndnadcz9pmbabhixekabhiinaiaeydbBdbaiaeydlBdlaiaeydwBdwaiaeydxBdxaeczfheaiczfhiadc9Wfgdcs0mbkkadcl6mbinaiaeydbBdbaeclfheaiclfhiadc98fgdci0mbkkdnadTmbinaiaeRbb86bbaicefhiaecefheadcufgdmbkkabk:3eedudndnabciGTmbabhixekaecFeGc:b:c:ew2hldndnadcz9pmbabhixekabhiinaialBdxaialBdwaialBdlaialBdbaiczfhiadc9Wfgdcs0mbkkadcl6mbinaialBdbaiclfhiadc98fgdci0mbkkdnadTmbinaiae86bbaicefhiadcufgdmbkkabkk81dbcjwk8Kbbbbdbbblbbbwbbbbbbbebbbdbbblbbbwbbbbc:Kwkl8WNbb";
  var wasm_simd = "b9H79TebbbeKl9Gbb9Gvuuuuueu9Giuuub9Geueuikqbbebeedddilve9Weeeviebeoweuec:q:6dkr;leDo9TW9T9VV95dbH9F9F939H79T9F9J9H229F9Jt9VV7bb8A9TW79O9V9Wt9F9KW9J9V9KW9wWVtW949c919M9MWVbdY9TW79O9V9Wt9F9KW9J9V9KW69U9KW949c919M9MWVblE9TW79O9V9Wt9F9KW9J9V9KW69U9KW949tWG91W9U9JWbvL9TW79O9V9Wt9F9KW9J9V9KWS9P2tWV9p9JtboK9TW79O9V9Wt9F9KW9J9V9KWS9P2tWV9r919HtbrL9TW79O9V9Wt9F9KW9J9V9KWS9P2tWVT949Wbwl79IV9RbDq;G9Mqlbzik9:evu8Jjjjjbcz9Rhbcbheincbhdcbhiinabcwfadfaicjuaead4ceGglE86bbaialfhiadcefgdcw9hmbkaec:q:yjjbfai86bbaecitc:q1jjbfab8Piw83ibaecefgecjd9hmbkk:183lYud97dur978Jjjjjbcj;kb9Rgv8Kjjjjbc9:hodnalTmbcuhoaiRbbgrc;WeGc:Ge9hmbarcsGgwce0mbc9:hoalcufadcd4cbawEgDadfgrcKcaawEgqaraq0Egk6mbaicefhxavaialfgmar9Rgoad;8qbbcj;abad9Uc;WFbGcjdadca0EhPdndndnadTmbaoadfhscbhzinaeaz9nmdamax9RaD6miabazad2fhHaxaDfhOaPaeaz9RazaPfae6EgAcsfgocl4cifcd4hCavcj;cbfaoc9WGgXcetfhQavcj;cbfaXci2fhLavcj;cbfaXfhKcbhYaoc;ab6h8AincbhodnawTmbaxaYcd4fRbbhokaocFeGhEcbh3avcj;cbfh5indndndndnaEa3cet4ciGgoc9:fPdebdkamaO9RaX6mwavcj;cbfa3aX2faOaX;8qbbaOaAfhOxdkavcj;cbfa3aX2fcbaX;8kbxekamaO9RaC6moaoclVcbawEhraOaCfhocbhidna8Ambamao9Rc;Gb6mbcbhlina5alfhidndndndndndnaOalco4fRbbgqciGarfPDbedibledibkaipxbbbbbbbbbbbbbbbbpklbxlkaiaopbblaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLg8Ecdp:mea8EpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9og8Fpxiiiiiiiiiiiiiiiip8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngacitc:q1jjbfpbibaac:q:yjjbfRbbgapsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Nghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spklbaaaoclffahc:q:yjjbfRbbfhoxikaiaopbbwaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9og8Fpxssssssssssssssssp8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngacitc:q1jjbfpbibaac:q:yjjbfRbbgapsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Nghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spklbaaaocwffahc:q:yjjbfRbbfhoxdkaiaopbbbpklbaoczfhoxekaiaopbbdaoRbbgacitc:q1jjbfpbibaac:q:yjjbfRbbgapsaoRbeghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPpklbaaaocdffahc:q:yjjbfRbbfhokdndndndndndnaqcd4ciGarfPDbedibledibkaiczfpxbbbbbbbbbbbbbbbbpklbxlkaiczfaopbblaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLg8Ecdp:mea8EpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9og8Fpxiiiiiiiiiiiiiiiip8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngacitc:q1jjbfpbibaac:q:yjjbfRbbgapsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Nghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spklbaaaoclffahc:q:yjjbfRbbfhoxikaiczfaopbbwaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9og8Fpxssssssssssssssssp8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngacitc:q1jjbfpbibaac:q:yjjbfRbbgapsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Nghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spklbaaaocwffahc:q:yjjbfRbbfhoxdkaiczfaopbbbpklbaoczfhoxekaiczfaopbbdaoRbbgacitc:q1jjbfpbibaac:q:yjjbfRbbgapsaoRbeghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPpklbaaaocdffahc:q:yjjbfRbbfhokdndndndndndnaqcl4ciGarfPDbedibledibkaicafpxbbbbbbbbbbbbbbbbpklbxlkaicafaopbblaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLg8Ecdp:mea8EpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9og8Fpxiiiiiiiiiiiiiiiip8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngacitc:q1jjbfpbibaac:q:yjjbfRbbgapsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Nghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spklbaaaoclffahc:q:yjjbfRbbfhoxikaicafaopbbwaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9og8Fpxssssssssssssssssp8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngacitc:q1jjbfpbibaac:q:yjjbfRbbgapsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Nghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spklbaaaocwffahc:q:yjjbfRbbfhoxdkaicafaopbbbpklbaoczfhoxekaicafaopbbdaoRbbgacitc:q1jjbfpbibaac:q:yjjbfRbbgapsaoRbeghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPpklbaaaocdffahc:q:yjjbfRbbfhokdndndndndndnaqco4arfPDbedibledibkaic8Wfpxbbbbbbbbbbbbbbbbpklbxlkaic8Wfaopbblaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLg8Ecdp:mea8EpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9og8Fpxiiiiiiiiiiiiiiiip8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngicitc:q1jjbfpbibaic:q:yjjbfRbbgipsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Ngqcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spklbaiaoclffaqc:q:yjjbfRbbfhoxikaic8Wfaopbbwaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9og8Fpxssssssssssssssssp8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngicitc:q1jjbfpbibaic:q:yjjbfRbbgipsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Ngqcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spklbaiaocwffaqc:q:yjjbfRbbfhoxdkaic8Wfaopbbbpklbaoczfhoxekaic8WfaopbbdaoRbbgicitc:q1jjbfpbibaic:q:yjjbfRbbgipsaoRbegqcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPpklbaiaocdffaqc:q:yjjbfRbbfhokalc;abfhialcjefaX0meaihlamao9Rc;Fb0mbkkdnaiaX9pmbaici4hlinamao9RcK6mwa5aifhqdndndndndndnaOaico4fRbbalcoG4ciGarfPDbedibledibkaqpxbbbbbbbbbbbbbbbbpkbbxlkaqaopbblaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLg8Ecdp:mea8EpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9og8Fpxiiiiiiiiiiiiiiiip8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngacitc:q1jjbfpbibaac:q:yjjbfRbbgapsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Nghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spkbbaaaoclffahc:q:yjjbfRbbfhoxikaqaopbbwaopbbbg8Eclp:mea8EpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9og8Fpxssssssssssssssssp8Jg8Ep5b9cjF;8;4;W;G;ab9:9cU1:Ngacitc:q1jjbfpbibaac:q:yjjbfRbbgapsa8Ep5e9cjF;8;4;W;G;ab9:9cU1:Nghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPa8Fa8Ep9spkbbaaaocwffahc:q:yjjbfRbbfhoxdkaqaopbbbpkbbaoczfhoxekaqaopbbdaoRbbgacitc:q1jjbfpbibaac:q:yjjbfRbbgapsaoRbeghcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPpkbbaaaocdffahc:q:yjjbfRbbfhokalcdfhlaiczfgiaX6mbkkaohOaoTmoka5aXfh5a3cefg3cl9hmbkdndndndnawTmbasaYcd4fRbbglciGPlbedwbkaXTmdavcjdfaYfhlavaYfpbdbhgcbhoinalavcj;cbfaofpblbg8JaKaofpblbg8KpmbzeHdOiAlCvXoQrLg8LaQaofpblbg8MaLaofpblbg8NpmbzeHdOiAlCvXoQrLgypmbezHdiOAlvCXorQLg8Ecep9Ta8Epxeeeeeeeeeeeeeeeeg8Fp9op9Hp9rg8Eagp9Uggp9Abbbaladfglaga8Ea8Epmlvorlvorlvorlvorp9Uggp9Abbbaladfglaga8Ea8EpmwDqkwDqkwDqkwDqkp9Uggp9Abbbaladfglaga8Ea8EpmxmPsxmPsxmPsxmPsp9Uggp9Abbbaladfglaga8LaypmwDKYqk8AExm35Ps8E8Fg8Ecep9Ta8Ea8Fp9op9Hp9rg8Ep9Uggp9Abbbaladfglaga8Ea8Epmlvorlvorlvorlvorp9Uggp9Abbbaladfglaga8Ea8EpmwDqkwDqkwDqkwDqkp9Uggp9Abbbaladfglaga8Ea8EpmxmPsxmPsxmPsxmPsp9Uggp9Abbbaladfglaga8Ja8KpmwKDYq8AkEx3m5P8Es8Fg8Ja8Ma8NpmwKDYq8AkEx3m5P8Es8Fg8KpmbezHdiOAlvCXorQLg8Ecep9Ta8Ea8Fp9op9Hp9rg8Ep9Uggp9Abbbaladfglaga8Ea8Epmlvorlvorlvorlvorp9Uggp9Abbbaladfglaga8Ea8EpmwDqkwDqkwDqkwDqkp9Uggp9Abbbaladfglaga8Ea8EpmxmPsxmPsxmPsxmPsp9Uggp9Abbbaladfglaga8Ja8KpmwDKYqk8AExm35Ps8E8Fg8Ecep9Ta8Ea8Fp9op9Hp9rg8Ep9Ug8Fp9Abbbaladfgla8Fa8Ea8Epmlvorlvorlvorlvorp9Ug8Fp9Abbbaladfgla8Fa8Ea8EpmwDqkwDqkwDqkwDqkp9Ug8Fp9Abbbaladfgla8Fa8Ea8EpmxmPsxmPsxmPsxmPsp9Uggp9AbbbaladfhlaoczfgoaX6mbxikkaXTmeavcjdfaYfhlavaYfpbdbhgcbhoinalavcj;cbfaofpblbg8JaKaofpblbg8KpmbzeHdOiAlCvXoQrLg8LaQaofpblbg8MaLaofpblbg8NpmbzeHdOiAlCvXoQrLgypmbezHdiOAlvCXorQLg8Ecep:nea8Epxebebebebebebebebg8Fp9op:bep9rg8Eagp:oeggp9Abbbaladfglaga8Ea8Epmlvorlvorlvorlvorp:oeggp9Abbbaladfglaga8Ea8EpmwDqkwDqkwDqkwDqkp:oeggp9Abbbaladfglaga8Ea8EpmxmPsxmPsxmPsxmPsp:oeggp9Abbbaladfglaga8LaypmwDKYqk8AExm35Ps8E8Fg8Ecep:nea8Ea8Fp9op:bep9rg8Ep:oeggp9Abbbaladfglaga8Ea8Epmlvorlvorlvorlvorp:oeggp9Abbbaladfglaga8Ea8EpmwDqkwDqkwDqkwDqkp:oeggp9Abbbaladfglaga8Ea8EpmxmPsxmPsxmPsxmPsp:oeggp9Abbbaladfglaga8Ja8KpmwKDYq8AkEx3m5P8Es8Fg8Ja8Ma8NpmwKDYq8AkEx3m5P8Es8Fg8KpmbezHdiOAlvCXorQLg8Ecep:nea8Ea8Fp9op:bep9rg8Ep:oeggp9Abbbaladfglaga8Ea8Epmlvorlvorlvorlvorp:oeggp9Abbbaladfglaga8Ea8EpmwDqkwDqkwDqkwDqkp:oeggp9Abbbaladfglaga8Ea8EpmxmPsxmPsxmPsxmPsp:oeggp9Abbbaladfglaga8Ja8KpmwDKYqk8AExm35Ps8E8Fg8Ecep:nea8Ea8Fp9op:bep9rg8Ep:oeg8Fp9Abbbaladfgla8Fa8Ea8Epmlvorlvorlvorlvorp:oeg8Fp9Abbbaladfgla8Fa8Ea8EpmwDqkwDqkwDqkwDqkp:oeg8Fp9Abbbaladfgla8Fa8Ea8EpmxmPsxmPsxmPsxmPsp:oeggp9AbbbaladfhlaoczfgoaX6mbxdkkaXTmbcbhocbalcl4gl9Rc8FGhiavcjdfaYfhravaYfpbdbh8Finaravcj;cbfaofpblbggaKaofpblbg8JpmbzeHdOiAlCvXoQrLg8KaQaofpblbg8LaLaofpblbg8MpmbzeHdOiAlCvXoQrLg8NpmbezHdiOAlvCXorQLg8Eaip:Rea8Ealp:Sep9qg8Ea8Fp9rg8Fp9Abbbaradfgra8Fa8Ea8Epmlvorlvorlvorlvorp9rg8Fp9Abbbaradfgra8Fa8Ea8EpmwDqkwDqkwDqkwDqkp9rg8Fp9Abbbaradfgra8Fa8Ea8EpmxmPsxmPsxmPsxmPsp9rg8Fp9Abbbaradfgra8Fa8Ka8NpmwDKYqk8AExm35Ps8E8Fg8Eaip:Rea8Ealp:Sep9qg8Ep9rg8Fp9Abbbaradfgra8Fa8Ea8Epmlvorlvorlvorlvorp9rg8Fp9Abbbaradfgra8Fa8Ea8EpmwDqkwDqkwDqkwDqkp9rg8Fp9Abbbaradfgra8Fa8Ea8EpmxmPsxmPsxmPsxmPsp9rg8Fp9Abbbaradfgra8Faga8JpmwKDYq8AkEx3m5P8Es8Fgga8La8MpmwKDYq8AkEx3m5P8Es8Fg8JpmbezHdiOAlvCXorQLg8Eaip:Rea8Ealp:Sep9qg8Ep9rg8Fp9Abbbaradfgra8Fa8Ea8Epmlvorlvorlvorlvorp9rg8Fp9Abbbaradfgra8Fa8Ea8EpmwDqkwDqkwDqkwDqkp9rg8Fp9Abbbaradfgra8Fa8Ea8EpmxmPsxmPsxmPsxmPsp9rg8Fp9Abbbaradfgra8Faga8JpmwDKYqk8AExm35Ps8E8Fg8Eaip:Rea8Ealp:Sep9qg8Ep9rg8Fp9Abbbaradfgra8Fa8Ea8Epmlvorlvorlvorlvorp9rg8Fp9Abbbaradfgra8Fa8Ea8EpmwDqkwDqkwDqkwDqkp9rg8Fp9Abbbaradfgra8Fa8Ea8EpmxmPsxmPsxmPsxmPsp9rg8Fp9AbbbaradfhraoczfgoaX6mbkkaYclfgYad6mbkaHavcjdfaAad2;8qbbavavcjdfaAcufad2fad;8qbbaAazfhzc9:hoaOhxaOmbxlkkaeTmbaDalfhrcbhocuhlinaralaD9RglfaD6mdaPaeao9RaoaPfae6Eaofgoae6mbkaial9Rhxkcbc99amax9RakSEhoxekc9:hokavcj;kbf8Kjjjjbaokwbz:bjjjbk:TseHu8Jjjjjbc;ae9Rgv8Kjjjjbc9:hodnaeci9UgrcHfal0mbcuhoaiRbbgwc;WeGc;Ge9hmbawcsGgDce0mbavc;abfcFecje;8kbavcUf9cu83ibavc8Wf9cu83ibavcyf9cu83ibavcaf9cu83ibavcKf9cu83ibavczf9cu83ibav9cu83iwav9cu83ibaialfc9WfhqaicefgwarfhldnaeTmbcmcsaDceSEhkcbhxcbhmcbhrcbhicbhoindnalaq9nmbc9:hoxikdndnawRbbgDc;Ve0mbavc;abfaoaDcu7gPcl4fcsGcitfgsydlhzasydbhHdndnaDcsGgsak9pmbavaiaPfcsGcdtfydbaxasEhDaxasTgOfhxxekdndnascsSmbcehOasc987asamffcefhDxekalcefhDal8SbbgscFeGhPdndnascu9mmbaDhlxekalcvfhlaPcFbGhPcrhsdninaD8SbbgOcFbGastaPVhPaOcu9kmeaDcefhDascrfgsc8J9hmbxdkkaDcefhlkcehOaPce4cbaPceG9R7amfhDkaDhmkavc;abfaocitfgsaDBdbasazBdlavaicdtfaDBdbavc;abfaocefcsGcitfgsaHBdbasaDBdlaocdfhoaOaifhidnadcd9hmbabarcetfgsaH87ebasclfaD87ebascdfaz87ebxdkabarcdtfgsaHBdbascwfaDBdbasclfazBdbxekdnaDcpe0mbaxcefgOavaiaqaDcsGfRbbgscl49RcsGcdtfydbascz6gPEhDavaias9RcsGcdtfydbaOaPfgzascsGgOEhsaOThOdndnadcd9hmbabarcetfgHax87ebaHclfas87ebaHcdfaD87ebxekabarcdtfgHaxBdbaHcwfasBdbaHclfaDBdbkavaicdtfaxBdbavc;abfaocitfgHaDBdbaHaxBdlavaicefgicsGcdtfaDBdbavc;abfaocefcsGcitfgHasBdbaHaDBdlavaiaPfgicsGcdtfasBdbavc;abfaocdfcsGcitfgDaxBdbaDasBdlaocifhoaiaOfhiazaOfhxxekaxcbalRbbgHEgAaDc;:eSgDfhzaHcsGhCaHcl4hXdndnaHcs0mbazcefhOxekazhOavaiaX9RcsGcdtfydbhzkdndnaCmbaOcefhxxekaOhxavaiaH9RcsGcdtfydbhOkdndnaDTmbalcefhDxekalcdfhDal8SbegPcFeGhsdnaPcu9kmbalcofhAascFbGhscrhldninaD8SbbgPcFbGaltasVhsaPcu9kmeaDcefhDalcrfglc8J9hmbkaAhDxekaDcefhDkasce4cbasceG9R7amfgmhAkdndnaXcsSmbaDhsxekaDcefhsaD8SbbglcFeGhPdnalcu9kmbaDcvfhzaPcFbGhPcrhldninas8SbbgDcFbGaltaPVhPaDcu9kmeascefhsalcrfglc8J9hmbkazhsxekascefhskaPce4cbaPceG9R7amfgmhzkdndnaCcsSmbashlxekascefhlas8SbbgDcFeGhPdnaDcu9kmbascvfhOaPcFbGhPcrhDdninal8SbbgscFbGaDtaPVhPascu9kmealcefhlaDcrfgDc8J9hmbkaOhlxekalcefhlkaPce4cbaPceG9R7amfgmhOkdndnadcd9hmbabarcetfgDaA87ebaDclfaO87ebaDcdfaz87ebxekabarcdtfgDaABdbaDcwfaOBdbaDclfazBdbkavc;abfaocitfgDazBdbaDaABdlavaicdtfaABdbavc;abfaocefcsGcitfgDaOBdbaDazBdlavaicefgicsGcdtfazBdbavc;abfaocdfcsGcitfgDaABdbaDaOBdlavaiaHcz6aXcsSVfgicsGcdtfaOBdbaiaCTaCcsSVfhiaocifhokawcefhwaocsGhoaicsGhiarcifgrae6mbkkcbc99alaqSEhokavc;aef8Kjjjjbaok:clevu8Jjjjjbcz9Rhvdnaecvfal9nmbc9:skdnaiRbbc;:eGc;qeSmbcuskav9cb83iwaicefhoaialfc98fhrdnaeTmbdnadcdSmbcbhwindnaoar6mbc9:skaocefhlao8SbbgicFeGhddndnaicu9mmbalhoxekaocvfhoadcFbGhdcrhidninal8SbbgDcFbGaitadVhdaDcu9kmealcefhlaicrfgic8J9hmbxdkkalcefhokabawcdtfadc8Etc8F91adcd47avcwfadceGcdtVglydbfgiBdbalaiBdbawcefgwae9hmbxdkkcbhwindnaoar6mbc9:skaocefhlao8SbbgicFeGhddndnaicu9mmbalhoxekaocvfhoadcFbGhdcrhidninal8SbbgDcFbGaitadVhdaDcu9kmealcefhlaicrfgic8J9hmbxdkkalcefhokabawcetfadc8Etc8F91adcd47avcwfadceGcdtVglydbfgi87ebalaiBdbawcefgwae9hmbkkcbc99aoarSEk:SPliuo97eue978Jjjjjbca9Rhiaec98Ghldndnadcl9hmbdnalTmbcbhvabhdinadadpbbbgocKp:RecKp:Sep;6egraocwp:RecKp:Sep;6earp;Geaoczp:RecKp:Sep;6egwp;Gep;Kep;LegDpxbbbbbbbbbbbbbbbbp:2egqarpxbbbjbbbjbbbjbbbjgkp9op9rp;Kegrpxbb;:9cbb;:9cbb;:9cbb;:9cararp;MeaDaDp;Meawaqawakp9op9rp;Kegrarp;Mep;Kep;Kep;Jep;Negwp;Mepxbbn0bbn0bbn0bbn0gqp;KepxFbbbFbbbFbbbFbbbp9oaopxbbbFbbbFbbbFbbbFp9op9qarawp;Meaqp;Kecwp:RepxbFbbbFbbbFbbbFbbp9op9qaDawp;Meaqp;Keczp:RepxbbFbbbFbbbFbbbFbp9op9qpkbbadczfhdavclfgval6mbkkalaeSmeaipxbbbbbbbbbbbbbbbbgqpklbaiabalcdtfgdaeciGglcdtgv;8qbbdnalTmbaiaipblbgocKp:RecKp:Sep;6egraocwp:RecKp:Sep;6earp;Geaoczp:RecKp:Sep;6egwp;Gep;Kep;LegDaqp:2egqarpxbbbjbbbjbbbjbbbjgkp9op9rp;Kegrpxbb;:9cbb;:9cbb;:9cbb;:9cararp;MeaDaDp;Meawaqawakp9op9rp;Kegrarp;Mep;Kep;Kep;Jep;Negwp;Mepxbbn0bbn0bbn0bbn0gqp;KepxFbbbFbbbFbbbFbbbp9oaopxbbbFbbbFbbbFbbbFp9op9qarawp;Meaqp;Kecwp:RepxbFbbbFbbbFbbbFbbp9op9qaDawp;Meaqp;Keczp:RepxbbFbbbFbbbFbbbFbp9op9qpklbkadaiav;8qbbskdnalTmbcbhvabhdinadczfgxaxpbbbgopxbbbbbbFFbbbbbbFFgkp9oadpbbbgDaopmbediwDqkzHOAKY8AEgwczp:Reczp:Sep;6egraDaopmlvorxmPsCXQL358E8FpxFubbFubbFubbFubbp9op;7eawczp:Sep;6egwp;Gearp;Gep;Kep;Legopxbbbbbbbbbbbbbbbbp:2egqarpxbbbjbbbjbbbjbbbjgmp9op9rp;Kegrpxb;:FSb;:FSb;:FSb;:FSararp;Meaoaop;Meawaqawamp9op9rp;Kegrarp;Mep;Kep;Kep;Jep;Negwp;Mepxbbn0bbn0bbn0bbn0gqp;KepxFFbbFFbbFFbbFFbbp9oaoawp;Meaqp;Keczp:Rep9qgoarawp;Meaqp;KepxFFbbFFbbFFbbFFbbp9ogrpmwDKYqk8AExm35Ps8E8Fp9qpkbbadaDakp9oaoarpmbezHdiOAlvCXorQLp9qpkbbadcafhdavclfgval6mbkkalaeSmbaiczfpxbbbbbbbbbbbbbbbbgopklbaiaopklbaiabalcitfgdaeciGglcitgv;8qbbdnalTmbaiaipblzgopxbbbbbbFFbbbbbbFFgkp9oaipblbgDaopmbediwDqkzHOAKY8AEgwczp:Reczp:Sep;6egraDaopmlvorxmPsCXQL358E8FpxFubbFubbFubbFubbp9op;7eawczp:Sep;6egwp;Gearp;Gep;Kep;Legopxbbbbbbbbbbbbbbbbp:2egqarpxbbbjbbbjbbbjbbbjgmp9op9rp;Kegrpxb;:FSb;:FSb;:FSb;:FSararp;Meaoaop;Meawaqawamp9op9rp;Kegrarp;Mep;Kep;Kep;Jep;Negwp;Mepxbbn0bbn0bbn0bbn0gqp;KepxFFbbFFbbFFbbFFbbp9oaoawp;Meaqp;Keczp:Rep9qgoarawp;Meaqp;KepxFFbbFFbbFFbbFFbbp9ogrpmwDKYqk8AExm35Ps8E8Fp9qpklzaiaDakp9oaoarpmbezHdiOAlvCXorQLp9qpklbkadaiav;8qbbkk:oDllue97euv978Jjjjjbc8W9Rhidnaec98GglTmbcbhvabhoinaiaopbbbgraoczfgwpbbbgDpmlvorxmPsCXQL358E8Fgqczp:Segkclp:RepklbaopxbbjZbbjZbbjZbbjZpx;Zl81Z;Zl81Z;Zl81Z;Zl81Zakpxibbbibbbibbbibbbp9qp;6ep;NegkaraDpmbediwDqkzHOAKY8AEgrczp:Reczp:Sep;6ep;MegDaDp;Meakarczp:Sep;6ep;Megxaxp;Meakaqczp:Reczp:Sep;6ep;Megqaqp;Mep;Kep;Kep;Lepxbbbbbbbbbbbbbbbbp:4ep;Jepxb;:FSb;:FSb;:FSb;:FSgkp;Mepxbbn0bbn0bbn0bbn0grp;KepxFFbbFFbbFFbbFFbbgmp9oaxakp;Mearp;Keczp:Rep9qgxaDakp;Mearp;Keamp9oaqakp;Mearp;Keczp:Rep9qgkpmbezHdiOAlvCXorQLgrp5baipblbpEb:T:j83ibaocwfarp5eaipblbpEe:T:j83ibawaxakpmwDKYqk8AExm35Ps8E8Fgkp5baipblbpEd:T:j83ibaocKfakp5eaipblbpEi:T:j83ibaocafhoavclfgval6mbkkdnalaeSmbaiczfpxbbbbbbbbbbbbbbbbgkpklbaiakpklbaiabalcitfgoaeciGgvcitgw;8qbbdnavTmbaiaipblbgraipblzgDpmlvorxmPsCXQL358E8Fgqczp:Segkclp:RepklaaipxbbjZbbjZbbjZbbjZpx;Zl81Z;Zl81Z;Zl81Z;Zl81Zakpxibbbibbbibbbibbbp9qp;6ep;NegkaraDpmbediwDqkzHOAKY8AEgrczp:Reczp:Sep;6ep;MegDaDp;Meakarczp:Sep;6ep;Megxaxp;Meakaqczp:Reczp:Sep;6ep;Megqaqp;Mep;Kep;Kep;Lepxbbbbbbbbbbbbbbbbp:4ep;Jepxb;:FSb;:FSb;:FSb;:FSgkp;Mepxbbn0bbn0bbn0bbn0grp;KepxFFbbFFbbFFbbFFbbgmp9oaxakp;Mearp;Keczp:Rep9qgxaDakp;Mearp;Keamp9oaqakp;Mearp;Keczp:Rep9qgkpmbezHdiOAlvCXorQLgrp5baipblapEb:T:j83ibaiarp5eaipblapEe:T:j83iwaiaxakpmwDKYqk8AExm35Ps8E8Fgkp5baipblapEd:T:j83izaiakp5eaipblapEi:T:j83iKkaoaiaw;8qbbkk;uddiue978Jjjjjbc;ab9Rhidnadcd4ae2glc98GgvTmbcbheabhdinadadpbbbgocwp:Recwp:Sep;6eaocep:SepxbbjFbbjFbbjFbbjFp9opxbbjZbbjZbbjZbbjZp:Uep;Mepkbbadczfhdaeclfgeav6mbkkdnavalSmbaic8WfpxbbbbbbbbbbbbbbbbgopklbaicafaopklbaiczfaopklbaiaopklbaiabavcdtfgdalciGgecdtgv;8qbbdnaeTmbaiaipblbgocwp:Recwp:Sep;6eaocep:SepxbbjFbbjFbbjFbbjFp9opxbbjZbbjZbbjZbbjZp:Uep;Mepklbkadaiav;8qbbkk9teiucbcbydj1jjbgeabcifc98GfgbBdj1jjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaikkkebcjwklz:Dbb";
  var detector = new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    1,
    4,
    1,
    96,
    0,
    0,
    3,
    3,
    2,
    0,
    0,
    5,
    3,
    1,
    0,
    1,
    12,
    1,
    0,
    10,
    22,
    2,
    12,
    0,
    65,
    0,
    65,
    0,
    65,
    0,
    252,
    10,
    0,
    0,
    11,
    7,
    0,
    65,
    0,
    253,
    15,
    26,
    11
  ]);
  var wasmpack = new Uint8Array([
    32,
    0,
    65,
    2,
    1,
    106,
    34,
    33,
    3,
    128,
    11,
    4,
    13,
    64,
    6,
    253,
    10,
    7,
    15,
    116,
    127,
    5,
    8,
    12,
    40,
    16,
    19,
    54,
    20,
    9,
    27,
    255,
    113,
    17,
    42,
    67,
    24,
    23,
    146,
    148,
    18,
    14,
    22,
    45,
    70,
    69,
    56,
    114,
    101,
    21,
    25,
    63,
    75,
    136,
    108,
    28,
    118,
    29,
    73,
    115
  ]);
  if (typeof WebAssembly !== "object") {
    return {
      supported: false
    };
  }
  var wasm = WebAssembly.validate(detector) ? unpack(wasm_simd) : unpack(wasm_base);
  var instance;
  var ready = WebAssembly.instantiate(wasm, {}).then(function(result) {
    instance = result.instance;
    instance.exports.__wasm_call_ctors();
  });
  function unpack(data) {
    var result = new Uint8Array(data.length);
    for (var i = 0; i < data.length; ++i) {
      var ch = data.charCodeAt(i);
      result[i] = ch > 96 ? ch - 97 : ch > 64 ? ch - 39 : ch + 4;
    }
    var write = 0;
    for (var i = 0; i < data.length; ++i) {
      result[write++] = result[i] < 60 ? wasmpack[result[i]] : (result[i] - 60) * 64 + result[++i];
    }
    return result.buffer.slice(0, write);
  }
  function decode(instance2, fun, target, count, size, source, filter) {
    var sbrk = instance2.exports.sbrk;
    var count4 = count + 3 & ~3;
    var tp = sbrk(count4 * size);
    var sp = sbrk(source.length);
    var heap = new Uint8Array(instance2.exports.memory.buffer);
    heap.set(source, sp);
    var res = fun(tp, count, size, sp, source.length);
    if (res == 0 && filter) {
      filter(tp, count4, size);
    }
    target.set(heap.subarray(tp, tp + count * size));
    sbrk(tp - sbrk(0));
    if (res != 0) {
      throw new Error("Malformed buffer data: " + res);
    }
  }
  var filters = {
    NONE: "",
    OCTAHEDRAL: "meshopt_decodeFilterOct",
    QUATERNION: "meshopt_decodeFilterQuat",
    EXPONENTIAL: "meshopt_decodeFilterExp"
  };
  var decoders = {
    ATTRIBUTES: "meshopt_decodeVertexBuffer",
    TRIANGLES: "meshopt_decodeIndexBuffer",
    INDICES: "meshopt_decodeIndexSequence"
  };
  var workers = [];
  var requestId = 0;
  function createWorker(url) {
    var worker = {
      object: new Worker(url),
      pending: 0,
      requests: {}
    };
    worker.object.onmessage = function(event) {
      var data = event.data;
      worker.pending -= data.count;
      worker.requests[data.id][data.action](data.value);
      delete worker.requests[data.id];
    };
    return worker;
  }
  function initWorkers(count) {
    var source = "self.ready = WebAssembly.instantiate(new Uint8Array([" + new Uint8Array(wasm) + "]), {}).then(function(result) { result.instance.exports.__wasm_call_ctors(); return result.instance; });self.onmessage = " + workerProcess.name + ";" + decode.toString() + workerProcess.toString();
    var blob = new Blob([source], { type: "text/javascript" });
    var url = URL.createObjectURL(blob);
    for (var i = workers.length; i < count; ++i) {
      workers[i] = createWorker(url);
    }
    for (var i = count; i < workers.length; ++i) {
      workers[i].object.postMessage({});
    }
    workers.length = count;
    URL.revokeObjectURL(url);
  }
  function decodeWorker(count, size, source, mode, filter) {
    var worker = workers[0];
    for (var i = 1; i < workers.length; ++i) {
      if (workers[i].pending < worker.pending) {
        worker = workers[i];
      }
    }
    return new Promise(function(resolve, reject) {
      var data = new Uint8Array(source);
      var id = ++requestId;
      worker.pending += count;
      worker.requests[id] = { resolve, reject };
      worker.object.postMessage({ id, count, size, source: data, mode, filter }, [data.buffer]);
    });
  }
  function workerProcess(event) {
    var data = event.data;
    if (!data.id) {
      return self.close();
    }
    self.ready.then(function(instance2) {
      try {
        var target = new Uint8Array(data.count * data.size);
        decode(instance2, instance2.exports[data.mode], target, data.count, data.size, data.source, instance2.exports[data.filter]);
        self.postMessage({ id: data.id, count: data.count, action: "resolve", value: target }, [target.buffer]);
      } catch (error) {
        self.postMessage({ id: data.id, count: data.count, action: "reject", value: error });
      }
    });
  }
  return {
    ready,
    supported: true,
    useWorkers: function(count) {
      initWorkers(count);
    },
    decodeVertexBuffer: function(target, count, size, source, filter) {
      decode(instance, instance.exports.meshopt_decodeVertexBuffer, target, count, size, source, instance.exports[filters[filter]]);
    },
    decodeIndexBuffer: function(target, count, size, source) {
      decode(instance, instance.exports.meshopt_decodeIndexBuffer, target, count, size, source);
    },
    decodeIndexSequence: function(target, count, size, source) {
      decode(instance, instance.exports.meshopt_decodeIndexSequence, target, count, size, source);
    },
    decodeGltfBuffer: function(target, count, size, source, mode, filter) {
      decode(instance, instance.exports[decoders[mode]], target, count, size, source, instance.exports[filters[filter]]);
    },
    decodeGltfBufferAsync: function(count, size, source, mode, filter) {
      if (workers.length > 0) {
        return decodeWorker(count, size, source, decoders[mode], filters[filter]);
      }
      return ready.then(function() {
        var target = new Uint8Array(count * size);
        decode(instance, instance.exports[decoders[mode]], target, count, size, source, instance.exports[filters[filter]]);
        return target;
      });
    }
  };
})();

// node_modules/meshoptimizer/meshopt_simplifier.module.js
var MeshoptSimplifier = (function() {
  var wasm = "b9H79Tebbbetm9Geueu9Geub9Gbb9Gsuuuuuuuuuuuu99uueu9Gvuuuuub9Gruuuuuuub9Gvuuuuue999Gvuuuuueu9Gquuuuuuu99uueu9Gwuuuuuu99ueu9Giuuue999Gluuuueu9GiuuueuiOHdilvorlwiDqkbxxbelve9Weiiviebeoweuec:G:Pdkr:Tewo9TW9T9VV95dbH9F9F939H79T9F9J9H229F9Jt9VV7bbz9TW79O9V9Wt9F79P9T9W29P9M95br8E9TW79O9V9Wt9F79P9T9W29P9M959x9Pt9OcttV9P9I91tW7bwQ9TW79O9V9Wt9F79P9T9W29P9M959q9V9P9Ut7bDX9TW79O9V9Wt9F79P9T9W29P9M959t9J9H2Wbqa9TW79O9V9Wt9F9V9Wt9P9T9P96W9wWVtW94SWt9J9O9sW9T9H9Wbkl79IV9RbxDwebcekdzsq;B:xeHdbkM9Hi8Au8A99Au8Jjjjjbc;W;qb9Rgs8Kjjjjbcbhzascxfcbc;Kbz:ojjjb8AdnabaeSmbabaeadcdtz:njjjb8AkdndnamcdGmbascxfhHcbhOxekasalcrfci4gecbyd:m:jjjbHjjjjbbgABdxasceBd2aAcbaez:ojjjbhCcbhlcbhednadTmbcbhlabheadhAinaCaeydbgXci4fgQaQRbbgQceaXcrGgXtV86bbaQcu7aX4ceGalfhlaeclfheaAcufgAmbkcualcdtalcFFFFi0EhekascCfhHasaecbyd:m:jjjbHjjjjbbgOBdzascdBd2alcd4alfhXcehAinaAgecethAaeaX6mbkcdhzcbhLascuaecdtgAaecFFFFi0Ecbyd:m:jjjbHjjjjbbgXBdCasciBd2aXcFeaAz:ojjjbhKdnadTmbaecufhYcbh8AindndnaKabaLcdtfgEydbgQc:v;t;h;Ev2aYGgXcdtfgCydbgAcuSmbceheinaOaAcdtfydbaQSmdaXaefhAaecefheaKaAaYGgXcdtfgCydbgAcu9hmbkkaOa8AcdtfaQBdbaCa8ABdba8AhAa8Acefh8AkaEaABdbaLcefgLad9hmbkkaKcbyd1:jjjbH:bjjjbbascdBd2kcbh3aHcualcefgecdtaecFFFFi0Ecbyd:m:jjjbHjjjjbbg5Bdbasa5BdlasazceVgeBd2ascxfaecdtfcuadcitadcFFFFe0Ecbyd:m:jjjbHjjjjbbg8EBdbasa8EBdwasazcdfgeBd2asclfabadalcbz:cjjjbascxfaecdtfcualcdtgealcFFFFi0Eg8Fcbyd:m:jjjbHjjjjbbgABdbasazcifgXBd2ascxfaXcdtfa8Fcbyd:m:jjjbHjjjjbbgaBdbasazclVBd2aAaaaialavaOascxfz:djjjbalcbyd:m:jjjbHjjjjbbhCascxfasyd2ghcdtfaCBdbasahcefgXBd2ascxfaXcdtfa8Fcbyd:m:jjjbHjjjjbbgXBdbasahcdfgQBd2ascxfaQcdtfa8Fcbyd:m:jjjbHjjjjbbgQBdbasahcifggBd2aXcFeaez:ojjjbh8JaQcFeaez:ojjjbh8KdnalTmba8Ecwfh8Lindna5a3gQcefg3cdtfydbgKa5aQcdtgefydbgXSmbaKaX9Rhza8EaXcitfhHa8Kaefh8Ma8JaefhEcbhYindndnaHaYcitfydbg8AaQ9hmbaEaQBdba8MaQBdbxekdna5a8Acdtg8NfgeclfydbgXaeydbgeSmba8EaecitgKfydbaQSmeaXae9Rhyaecu7aXfhLa8LaKfhXcbheinaLaeSmeaecefheaXydbhKaXcwfhXaKaQ9hmbkaeay6meka8Ka8NfgeaQa8AaeydbcuSEBdbaEa8AaQaEydbcuSEBdbkaYcefgYaz9hmbkka3al9hmbkaAhXaahQa8KhKa8JhYcbheindndnaeaXydbg8A9hmbdnaeaQydbg8A9hmbaYydbh8AdnaKydbgLcu9hmba8Acu9hmbaCaefcb86bbxikaCaefhEdnaeaLSmbaea8ASmbaEce86bbxikaEcl86bbxdkdnaeaaa8AcdtgLfydb9hmbdnaKydbgEcuSmbaeaESmbaYydbgzcuSmbaeazSmba8KaLfydbgHcuSmbaHa8ASmba8JaLfydbgLcuSmbaLa8ASmbdnaAaEcdtfydbg8AaAaLcdtfydb9hmba8AaAazcdtfydbgLSmbaLaAaHcdtfydb9hmbaCaefcd86bbxlkaCaefcl86bbxikaCaefcl86bbxdkaCaefcl86bbxekaCaefaCa8AfRbb86bbkaXclfhXaQclfhQaKclfhKaYclfhYalaecefge9hmbkdnaqTmbdndnaOTmbaOheaAhXalhQindnaqaeydbfRbbTmbaCaXydbfcl86bbkaeclfheaXclfhXaQcufgQmbxdkkaAhealhXindnaqRbbTmbaCaeydbfcl86bbkaqcefhqaeclfheaXcufgXmbkkaAhealhQaChXindnaCaeydbfRbbcl9hmbaXcl86bbkaeclfheaXcefhXaQcufgQmbkkamceGTmbaChealhXindnaeRbbce9hmbaecl86bbkaecefheaXcufgXmbkkascxfagcdtfcualcx2alc;v:Q;v:Qe0Ecbyd:m:jjjbHjjjjbbg3BdbasahclfgHBd2a3aialavaOz:ejjjbh8PdndnaDmbcbhgcbh8Lxekcbh8LawhecbhXindnaeIdbJbbbb9ETmbasc;Wbfa8LcdtfaXBdba8Lcefh8LkaeclfheaDaXcefgX9hmbkascxfaHcdtfcua8Lal2gecdtaecFFFFi0Ecbyd:m:jjjbHjjjjbbggBdbasahcvfgHBd2alTmba8LTmbarcd4hEdnaOTmba8Lcdthzcbh8AaghLinaoaOa8AcdtfydbaE2cdtfhYasc;WbfheaLhXa8LhQinaXaYaeydbcdtgKfIdbawaKfIdbNUdbaeclfheaXclfhXaQcufgQmbkaLazfhLa8Acefg8Aal9hmbxdkka8Lcdthzcbh8AaghLinaoa8AaE2cdtfhYasc;WbfheaLhXa8LhQinaXaYaeydbcdtgKfIdbawaKfIdbNUdbaeclfheaXclfhXaQcufgQmbkaLazfhLa8Acefg8Aal9hmbkkascxfaHcdtfcualc8S2gealc;D;O;f8U0EgQcbyd:m:jjjbHjjjjbbgXBdbasaHcefgKBd2aXcbaez:ojjjbhqdndndna8LTmbascxfaKcdtfaQcbyd:m:jjjbHjjjjbbgvBdbasaHcdfgXBd2avcbaez:ojjjb8AascxfaXcdtfcua8Lal2gecltgXaecFFFFb0Ecbyd:m:jjjbHjjjjbbgiBdbasaHcifBd2aicbaXz:ojjjb8AadmexdkcbhvcbhiadTmekcbhYabhXindna3aXclfydbg8Acx2fgeIdba3aXydbgLcx2fgQIdbgI:tg8Ra3aXcwfydbgEcx2fgKIdlaQIdlg8S:tgRNaKIdbaI:tg8UaeIdla8S:tg8VN:tg8Wa8WNa8VaKIdwaQIdwg8X:tg8YNaRaeIdwa8X:tg8VN:tgRaRNa8Va8UNa8Ya8RN:tg8Ra8RNMM:rg8UJbbbb9ETmba8Wa8U:vh8Wa8Ra8U:vh8RaRa8U:vhRkaqaAaLcdtfydbc8S2fgeaRa8U:rg8UaRNNg8VaeIdbMUdbaea8Ra8Ua8RNg8ZNg8YaeIdlMUdlaea8Wa8Ua8WNg80Ng81aeIdwMUdwaea8ZaRNg8ZaeIdxMUdxaea80aRNgBaeIdzMUdzaea80a8RNg80aeIdCMUdCaeaRa8Ua8Wa8XNaRaINa8Sa8RNMM:mg8SNgINgRaeIdKMUdKaea8RaINg8RaeId3MUd3aea8WaINg8WaeIdaMUdaaeaIa8SNgIaeId8KMUd8Kaea8UaeIdyMUdyaqaAa8Acdtfydbc8S2fgea8VaeIdbMUdbaea8YaeIdlMUdlaea81aeIdwMUdwaea8ZaeIdxMUdxaeaBaeIdzMUdzaea80aeIdCMUdCaeaRaeIdKMUdKaea8RaeId3MUd3aea8WaeIdaMUdaaeaIaeId8KMUd8Kaea8UaeIdyMUdyaqaAaEcdtfydbc8S2fgea8VaeIdbMUdbaea8YaeIdlMUdlaea81aeIdwMUdwaea8ZaeIdxMUdxaeaBaeIdzMUdzaea80aeIdCMUdCaeaRaeIdKMUdKaea8RaeId3MUd3aea8WaeIdaMUdaaeaIaeId8KMUd8Kaea8UaeIdyMUdyaXcxfhXaYcifgYad6mbkcbhzabhLinabazcdtfh8AcbhXinaCa8AaXc;a1jjbfydbcdtfydbgQfRbbhedndnaCaLaXfydbgKfRbbgYc99fcFeGcpe0mbaec99fcFeGc;:e6mekdnaYcufcFeGce0mba8JaKcdtfydbaQ9hmekdnaecufcFeGce0mba8KaQcdtfydbaK9hmekdnaYcv2aefc:G1jjbfRbbTmbaAaQcdtfydbaAaKcdtfydb0mekJbbacJbbacJbbjZaecFeGceSEaYceSEh80dna3a8AaXc;e1jjbfydbcdtfydbcx2fgeIdwa3aKcx2fgYIdwg8S:tg8Wa3aQcx2fgEIdwa8S:tgRaRNaEIdbaYIdbg8X:tg8Ra8RNaEIdlaYIdlg8V:tg8Ua8UNMMgINa8WaRNaeIdba8X:tg81a8RNa8UaeIdla8V:tg8ZNMMg8YaRN:tg8Wa8WNa81aINa8Ya8RN:tgRaRNa8ZaINa8Ya8UN:tg8Ra8RNMM:rg8UJbbbb9ETmba8Wa8U:vh8Wa8Ra8U:vh8RaRa8U:vhRkaqaAaKcdtfydbc8S2fgeaRa80aI:rNg8UaRNNg8YaeIdbMUdbaea8Ra8Ua8RNg80Ng81aeIdlMUdlaea8Wa8Ua8WNgINg8ZaeIdwMUdwaea80aRNg80aeIdxMUdxaeaIaRNgBaeIdzMUdzaeaIa8RNg83aeIdCMUdCaeaRa8Ua8Wa8SNaRa8XNa8Va8RNMM:mg8SNgINgRaeIdKMUdKaea8RaINg8RaeId3MUd3aea8WaINg8WaeIdaMUdaaeaIa8SNgIaeId8KMUd8Kaea8UaeIdyMUdyaqaAaQcdtfydbc8S2fgea8YaeIdbMUdbaea81aeIdlMUdlaea8ZaeIdwMUdwaea80aeIdxMUdxaeaBaeIdzMUdzaea83aeIdCMUdCaeaRaeIdKMUdKaea8RaeId3MUd3aea8WaeIdaMUdaaeaIaeId8KMUd8Kaea8UaeIdyMUdykaXclfgXcx9hmbkaLcxfhLazcifgzad6mbka8LTmbcbhLinJbbbbh8Xa3abaLcdtfgeclfydbgEcx2fgXIdwa3aeydbgzcx2fgQIdwg8Z:tg8Ra8RNaXIdbaQIdbgB:tg8Wa8WNaXIdlaQIdlg83:tg8Ua8UNMMg80a3aecwfydbgHcx2fgeIdwa8Z:tgINa8Ra8RaINa8WaeIdbaB:tg8SNa8UaeIdla83:tg8VNMMgRN:tJbbbbJbbjZa80aIaINa8Sa8SNa8Va8VNMMg81NaRaRN:tg8Y:va8YJbbbb9BEg8YNhUa81a8RNaIaRN:ta8YNh85a80a8VNa8UaRN:ta8YNh86a81a8UNa8VaRN:ta8YNh87a80a8SNa8WaRN:ta8YNh88a81a8WNa8SaRN:ta8YNh89a8Wa8VNa8Sa8UN:tgRaRNa8UaINa8Va8RN:tgRaRNa8Ra8SNaIa8WN:tgRaRNMM:rJbbbZNhRagaza8L2gwcdtfhXagaHa8L2g8NcdtfhQagaEa8L2g5cdtfhKa8Z:mh8:a83:mhZaB:mhncbhYa8Lh8AJbbbbh8VJbbbbh8YJbbbbh80Jbbbbh81Jbbbbh8ZJbbbbhBJbbbbh83JbbbbhcJbbbbh9cinasc;WbfaYfgecwfaRa85aKIdbaXIdbgI:tg8UNaUaQIdbaI:tg8SNMg8RNUdbaeclfaRa87a8UNa86a8SNMg8WNUdbaeaRa89a8UNa88a8SNMg8UNUdbaecxfaRa8:a8RNaZa8WNaIana8UNMMMgINUdbaRa8Ra8WNNa81Mh81aRa8Ra8UNNa8ZMh8ZaRa8Wa8UNNaBMhBaRaIaINNa8XMh8XaRa8RaINNa8VMh8VaRa8WaINNa8YMh8YaRa8UaINNa80Mh80aRa8Ra8RNNa83Mh83aRa8Wa8WNNacMhcaRa8Ua8UNNa9cMh9caXclfhXaKclfhKaQclfhQaYczfhYa8Acufg8Ambkavazc8S2fgea9caeIdbMUdbaeacaeIdlMUdlaea83aeIdwMUdwaeaBaeIdxMUdxaea8ZaeIdzMUdzaea81aeIdCMUdCaea80aeIdKMUdKaea8YaeId3MUd3aea8VaeIdaMUdaaea8XaeId8KMUd8KaeaRaeIdyMUdyavaEc8S2fgea9caeIdbMUdbaeacaeIdlMUdlaea83aeIdwMUdwaeaBaeIdxMUdxaea8ZaeIdzMUdzaea81aeIdCMUdCaea80aeIdKMUdKaea8YaeId3MUd3aea8VaeIdaMUdaaea8XaeId8KMUd8KaeaRaeIdyMUdyavaHc8S2fgea9caeIdbMUdbaeacaeIdlMUdlaea83aeIdwMUdwaeaBaeIdxMUdxaea8ZaeIdzMUdzaea81aeIdCMUdCaea80aeIdKMUdKaea8YaeId3MUd3aea8VaeIdaMUdaaea8XaeId8KMUd8KaeaRaeIdyMUdyaiawcltfh8AcbhXa8LhKina8AaXfgeasc;WbfaXfgQIdbaeIdbMUdbaeclfgYaQclfIdbaYIdbMUdbaecwfgYaQcwfIdbaYIdbMUdbaecxfgeaQcxfIdbaeIdbMUdbaXczfhXaKcufgKmbkaia5cltfh8AcbhXa8LhKina8AaXfgeasc;WbfaXfgQIdbaeIdbMUdbaeclfgYaQclfIdbaYIdbMUdbaecwfgYaQcwfIdbaYIdbMUdbaecxfgeaQcxfIdbaeIdbMUdbaXczfhXaKcufgKmbkaia8Ncltfh8AcbhXa8LhKina8AaXfgeasc;WbfaXfgQIdbaeIdbMUdbaeclfgYaQclfIdbaYIdbMUdbaecwfgYaQcwfIdbaYIdbMUdbaecxfgeaQcxfIdbaeIdbMUdbaXczfhXaKcufgKmbkaLcifgLad6mbkkcbhQdndnamcwGgJmbJbbbbh8Vcbh9ecbhocbhhxekcbh9ea8Fcbyd:m:jjjbHjjjjbbhhascxfasyd2gecdtfahBdbasaecefgXBd2ascxfaXcdtfcuahalabadaAz:fjjjbgKcltaKcjjjjiGEcbyd:m:jjjbHjjjjbbgoBdbasaecdfBd2aoaKaha3alz:gjjjbJFFuuh8VaKTmbaoheaKhXinaeIdbgRa8Va8VaR9EEh8VaeclfheaXcufgXmbkaKh9ekasydlhTdnalTmbaTclfheaTydbhKaChXalhYcbhQincbaeydbg8AaK9RaXRbbcpeGEaQfhQaXcefhXaeclfhea8AhKaYcufgYmbkaQce4hQkcuadaQ9RcifgScx2aSc;v:Q;v:Qe0Ecbyd:m:jjjbHjjjjbbhDascxfasyd2g9hcdtfaDBdbasa9hcefgeBd2ascxfaecdtfcuaScdtaScFFFFi0Ecbyd:m:jjjbHjjjjbbgrBdbasa9hcdfgeBd2ascxfaecdtfa8Fcbyd:m:jjjbHjjjjbbgyBdbasa9hcifgeBd2ascxfaecdtfalcbyd:m:jjjbHjjjjbbg9iBdbasa9hclfg6Bd2axaxNa8PJbbjZamclGEgUaUN:vh9cJbbbbhcdnadak9nmbdnaSci6mba8Lclth9kaDcwfh0Jbbbbh83JbbbbhcinasclfabadalaAz:cjjjbabhzcbh8Ecbh8Finaba8FcdtfhHcbheindnaAazaefydbgQcdtgEfydbgYaAaHaec;q1jjbfydbcdtfydbgXcdtgwfydbg8ASmbaCaXfRbbgLcv2aCaQfRbbgKfc;G1jjbfRbbg5aKcv2aLfg8Nc;G1jjbfRbbg8MVcFeGTmbdna8AaY9nmba8Nc:G1jjbfRbbcFeGmekaKcufhYdnaKaL9hmbaYcFeGce0mba8JaEfydbaX9hmekdndnaKclSmbaLcl9hmekdnaYcFeGce0mba8JaEfydbaX9hmdkaLcufcFeGce0mba8KawfydbaQ9hmekaDa8Ecx2fgKaXaQa8McFeGgYEBdlaKaQaXaYEBdbaKaYa5Gcb9hBdwa8Ecefh8Ekaeclfgecx9hmbkdna8Fcifg8Fad9pmbazcxfhza8EcifaS9nmekka8ETmdcbhLinaqaAaDaLcx2fgKydbgYcdtgzfydbc8S2fgeIdwa3aKydlg8Acx2fgXIdwg8WNaeIdzaXIdbg8UNaeIdaMgRaRMMa8WNaeIdlaXIdlgINaeIdCa8WNaeId3MgRaRMMaINaeIdba8UNaeIdxaINaeIdKMgRaRMMa8UNaeId8KMMM:lhRJbbbbJbbjZaeIdyg8R:va8RJbbbb9BEh8RdndnaKydwgEmbJFFuuh8YxekJbbbbJbbjZaqaAa8Acdtfydbc8S2fgeIdyg8S:va8SJbbbb9BEaeIdwa3aYcx2fgXIdwg8SNaeIdzaXIdbg8XNaeIdaMg8Ya8YMMa8SNaeIdlaXIdlg8YNaeIdCa8SNaeId3Mg8Sa8SMMa8YNaeIdba8XNaeIdxa8YNaeIdKMg8Sa8SMMa8XNaeId8KMMM:lNh8Yka8RaRNh80dna8LTmbavaYc8S2fgQIdwa8WNaQIdza8UNaQIdaMgRaRMMa8WNaQIdlaINaQIdCa8WNaQId3MgRaRMMaINaQIdba8UNaQIdxaINaQIdKMgRaRMMa8UNaQId8KMMMhRaga8Aa8L2gHcdtfhXaiaYa8L2gwcltfheaQIdyh8Sa8LhQinaXIdbg8Ra8Ra8SNaecxfIdba8WaecwfIdbNa8UaeIdbNaIaeclfIdbNMMMg8Ra8RM:tNaRMhRaXclfhXaeczfheaQcufgQmbkdndnaEmbJbbbbh8Rxekava8Ac8S2fgQIdwa3aYcx2fgeIdwg8UNaQIdzaeIdbgINaQIdaMg8Ra8RMMa8UNaQIdlaeIdlg8SNaQIdCa8UNaQId3Mg8Ra8RMMa8SNaQIdbaINaQIdxa8SNaQIdKMg8Ra8RMMaINaQId8KMMMh8RagawcdtfhXaiaHcltfheaQIdyh8Xa8LhQinaXIdbg8Wa8Wa8XNaecxfIdba8UaecwfIdbNaIaeIdbNa8SaeclfIdbNMMMg8Wa8WM:tNa8RMh8RaXclfhXaeczfheaQcufgQmbka8R:lh8Rka80aR:lMh80a8Ya8RMh8YaCaYfRbbcd9hmbdna8Ka8Ja8Jazfydba8ASEaaazfydbgHcdtfydbgzcu9hmbaaa8AcdtfydbhzkavaHc8S2fgQIdwa3azcx2fgeIdwg8WNaQIdzaeIdbg8UNaQIdaMgRaRMMa8WNaQIdlaeIdlgINaQIdCa8WNaQId3MgRaRMMaINaQIdba8UNaQIdxaINaQIdKMgRaRMMa8UNaQId8KMMMhRagaza8L2gwcdtfhXaiaHa8L2g8NcltfheaQIdyh8Sa8LhQinaXIdbg8Ra8Ra8SNaecxfIdba8WaecwfIdbNa8UaeIdbNaIaeclfIdbNMMMg8Ra8RM:tNaRMhRaXclfhXaeczfheaQcufgQmbkdndnaEmbJbbbbh8Rxekavazc8S2fgQIdwa3aHcx2fgeIdwg8UNaQIdzaeIdbgINaQIdaMg8Ra8RMMa8UNaQIdlaeIdlg8SNaQIdCa8UNaQId3Mg8Ra8RMMa8SNaQIdbaINaQIdxa8SNaQIdKMg8Ra8RMMaINaQId8KMMMh8Raga8NcdtfhXaiawcltfheaQIdyh8Xa8LhQinaXIdbg8Wa8Wa8XNaecxfIdba8UaecwfIdbNaIaeIdbNa8SaeclfIdbNMMMg8Wa8WM:tNa8RMh8RaXclfhXaeczfheaQcufgQmbka8R:lh8Rka80aR:lMh80a8Ya8RMh8YkaKa80a8Ya80a8Y9FgeEUdwaKa8AaYaeaETVgeEBdlaKaYa8AaeEBdbaLcefgLa8E9hmbkasc;Wbfcbcj;qbz:ojjjb8Aa0hea8EhXinasc;WbfaeydbcA4cF8FGgQcFAaQcFA6EcdtfgQaQydbcefBdbaecxfheaXcufgXmbkcbhecbhXinasc;WbfaefgQydbhKaQaXBdbaKaXfhXaeclfgecj;qb9hmbkcbhea0hXinasc;WbfaXydbcA4cF8FGgQcFAaQcFA6EcdtfgQaQydbgQcefBdbaraQcdtfaeBdbaXcxfhXa8Eaecefge9hmbkadak9RgQci9Uh9mdnalTmbcbheayhXinaXaeBdbaXclfhXalaecefge9hmbkkcbh9na9icbalz:ojjjbh8FaQcO9Uh9oa9mce4h9pasydwh9qcbh8Mcbh5dninaDara5cdtfydbcx2fg8NIdwgRa9c9Emea8Ma9m9pmeJFFuuh8Rdna9pa8E9pmbaDara9pcdtfydbcx2fIdwJbb;aZNh8RkdnaRa8R9ETmbaRac9ETmba8Ma9o0mdkdna8FaAa8NydlgHcdtg9rfydbgKfg9sRbba8FaAa8Nydbgzcdtg9tfydbgefg9uRbbVmbaCazfRbbh9vdnaTaecdtfgXclfydbgQaXydbgXSmbaQaX9RhYa3aKcx2fhLa3aecx2fhEa9qaXcitfhecbhXcehwdnindnayaeydbcdtfydbgQaKSmbayaeclfydbcdtfydbg8AaKSmbaQa8ASmba3a8Acx2fg8AIdba3aQcx2fgQIdbg8W:tgRaEIdlaQIdlg8U:tg8XNaEIdba8W:tg8Ya8AIdla8U:tg8RN:tgIaRaLIdla8U:tg80NaLIdba8W:tg81a8RN:tg8UNa8RaEIdwaQIdwg8S:tg8ZNa8Xa8AIdwa8S:tg8WN:tg8Xa8RaLIdwa8S:tgBNa80a8WN:tg8RNa8Wa8YNa8ZaRN:tg8Sa8Wa81NaBaRN:tgRNMMaIaINa8Xa8XNa8Sa8SNMMa8Ua8UNa8Ra8RNaRaRNMMN:rJbbj8:N9FmdkaecwfheaXcefgXaY6hwaYaX9hmbkkawceGTmba9pcefh9pxekdndndndna9vc9:fPdebdkazheinayaecdtgefaHBdbaaaefydbgeaz9hmbxikkdna8Ka8Ja8Ja9tfydbaHSEaaa9tfydbgzcdtfydbgecu9hmbaaa9rfydbhekaya9tfaHBdbaehHkayazcdtfaHBdbka9uce86bba9sce86bba8NIdwgRacacaR9DEhca9ncefh9ncecda9vceSEa8Mfh8Mka5cefg5a8E9hmbkka9nTmddnalTmbcbh8AcbhEindnayaEcdtgefydbgQaESmbaAaQcdtfydbhzdnaEaAaefydb9hgHmbaqazc8S2fgeaqaEc8S2fgXIdbaeIdbMUdbaeaXIdlaeIdlMUdlaeaXIdwaeIdwMUdwaeaXIdxaeIdxMUdxaeaXIdzaeIdzMUdzaeaXIdCaeIdCMUdCaeaXIdKaeIdKMUdKaeaXId3aeId3MUd3aeaXIdaaeIdaMUdaaeaXId8KaeId8KMUd8KaeaXIdyaeIdyMUdyka8LTmbavaQc8S2fgeavaEc8S2gwfgXIdbaeIdbMUdbaeaXIdlaeIdlMUdlaeaXIdwaeIdwMUdwaeaXIdxaeIdxMUdxaeaXIdzaeIdzMUdzaeaXIdCaeIdCMUdCaeaXIdKaeIdKMUdKaeaXId3aeId3MUd3aeaXIdaaeIdaMUdaaeaXId8KaeId8KMUd8KaeaXIdyaeIdyMUdya9kaQ2hLaihXa8LhKinaXaLfgeaXa8AfgQIdbaeIdbMUdbaeclfgYaQclfIdbaYIdbMUdbaecwfgYaQcwfIdbaYIdbMUdbaecxfgeaQcxfIdbaeIdbMUdbaXczfhXaKcufgKmbkaHmbJbbbbJbbjZaqawfgeIdygR:vaRJbbbb9BEaeIdwa3azcx2fgXIdwgRNaeIdzaXIdbg8RNaeIdaMg8Wa8WMMaRNaeIdlaXIdlg8WNaeIdCaRNaeId3MgRaRMMa8WNaeIdba8RNaeIdxa8WNaeIdKMgRaRMMa8RNaeId8KMMM:lNgRa83a83aR9DEh83ka8Aa9kfh8AaEcefgEal9hmbkcbhXa8JheindnaeydbgQcuSmbdnaXayaQcdtgKfydbgQ9hmbcuhQa8JaKfydbgKcuSmbayaKcdtfydbhQkaeaQBdbkaeclfhealaXcefgX9hmbkcbhXa8KheindnaeydbgQcuSmbdnaXayaQcdtgKfydbgQ9hmbcuhQa8KaKfydbgKcuSmbayaKcdtfydbhQkaeaQBdbkaeclfhealaXcefgX9hmbkka83aca8LEh83cbhKabhecbhYindnayaeydbcdtfydbgXayaeclfydbcdtfydbgQSmbaXayaecwfydbcdtfydbg8ASmbaQa8ASmbabaKcdtfgLaXBdbaLcwfa8ABdbaLclfaQBdbaKcifhKkaecxfheaYcifgYad6mbkdndnaJTmbaKak9nmba8Va839FTmbcbhdabhecbhXindnaoahaeydbgQcdtfydbcdtfIdba839ETmbabadcdtfgYaQBdbaYclfaeclfydbBdbaYcwfaecwfydbBdbadcifhdkaecxfheaXcifgXaK6mbkJFFuuh8Va9eTmeaohea9ehXJFFuuhRinaeIdbg8RaRaRa8R9EEg8WaRa8Ra839EgQEhRa8Wa8VaQEh8VaeclfheaXcufgXmbxdkkaKhdkadak0mbxdkkasclfabadalaAz:cjjjbkdndnadak0mbadhXxekdnaJmbadhXxekdna8Va9c9FmbadhXxekina8VJbb;aZNgRa9caRa9c9DEh8WJbbbbhRdna9eTmbaohea9ehAinaeIdbg8RaRa8Ra8W9FEaRa8RaR9EEhRaeclfheaAcufgAmbkkcbhXabhecbhAindnaoahaeydbgQcdtfydbcdtfIdba8W9ETmbabaXcdtfgKaQBdbaKclfaeclfydbBdbaKcwfaecwfydbBdbaXcifhXkaecxfheaAcifgAad6mbkJFFuuh8Vdna9eTmbaohea9ehAJFFuuh8RinaeIdbg8Ua8Ra8Ra8U9EEgIa8Ra8Ua8W9EgQEh8RaIa8VaQEh8VaeclfheaAcufgAmbkkdnaXad9hmbadhXxdkaRacacaR9DEhcaXak9nmeaXhda8Va9c9FmbkkdnamcjjjjlGTmbaOmbaXTmbcbh8AabheinaCaeydbgKfRbbc3thLaecwfgEydbhAdndna8JaKcdtgHfydbaeclfgzydbgQSmbcbhYa8KaQcdtfydbaK9hmekcjjjj94hYkaeaLaYVaKVBdbaCaQfRbbc3thLdndna8JaQcdtfydbaASmbcbhYa8KaAcdtfydbaQ9hmekcjjjj94hYkazaLaYVaQVBdbaCaAfRbbc3thYdndna8JaAcdtfydbaKSmbcbhQa8KaHfydbaA9hmekcjjjj94hQkaEaYaQVaAVBdbaecxfhea8Acifg8AaX6mbkkdnaOTmbaXTmbaXheinabaOabydbcdtfydbBdbabclfhbaecufgembkkdnaPTmbaPaUac:rNUdbka9hcdtascxffcxfhednina6Tmeaeydbcbyd1:jjjbH:bjjjbbaec98fhea6cufh6xbkkasc;W;qbf8KjjjjbaXk;Yieouabydlhvabydbclfcbaicdtz:ojjjbhoadci9UhrdnadTmbdnalTmbaehwadhDinaoalawydbcdtfydbcdtfgqaqydbcefBdbawclfhwaDcufgDmbxdkkaehwadhDinaoawydbcdtfgqaqydbcefBdbawclfhwaDcufgDmbkkdnaiTmbcbhDaohwinawydbhqawaDBdbawclfhwaqaDfhDaicufgimbkkdnadci6mbinaecwfydbhwaeclfydbhDaeydbhidnalTmbalawcdtfydbhwalaDcdtfydbhDalaicdtfydbhikavaoaicdtfgqydbcitfaDBdbavaqydbcitfawBdlaqaqydbcefBdbavaoaDcdtfgqydbcitfawBdbavaqydbcitfaiBdlaqaqydbcefBdbavaoawcdtfgwydbcitfaiBdbavawydbcitfaDBdlawawydbcefBdbaecxfhearcufgrmbkkabydbcbBdbk:todDue99aicd4aifhrcehwinawgDcethwaDar6mbkcuaDcdtgraDcFFFFi0Ecbyd:m:jjjbHjjjjbbhwaoaoyd9GgqcefBd9GaoaqcdtfawBdbawcFearz:ojjjbhkdnaiTmbalcd4hlaDcufhxcbhminamhDdnavTmbavamcdtfydbhDkcbadaDal2cdtfgDydlgwawcjjjj94SEgwcH4aw7c:F:b:DD2cbaDydbgwawcjjjj94SEgwcH4aw7c;D;O:B8J27cbaDydwgDaDcjjjj94SEgDcH4aD7c:3F;N8N27axGhwamcdthPdndndnavTmbakawcdtfgrydbgDcuSmeadavaPfydbal2cdtfgsIdbhzcehqinaqhrdnadavaDcdtfydbal2cdtfgqIdbaz9CmbaqIdlasIdl9CmbaqIdwasIdw9BmlkarcefhqakawarfaxGgwcdtfgrydbgDcu9hmbxdkkakawcdtfgrydbgDcuSmbadamal2cdtfgsIdbhzcehqinaqhrdnadaDal2cdtfgqIdbaz9CmbaqIdlasIdl9CmbaqIdwasIdw9BmikarcefhqakawarfaxGgwcdtfgrydbgDcu9hmbkkaramBdbamhDkabaPfaDBdbamcefgmai9hmbkkakcbyd1:jjjbH:bjjjbbaoaoyd9GcufBd9GdnaeTmbaiTmbcbhDaehwinawaDBdbawclfhwaiaDcefgD9hmbkcbhDaehwindnaDabydbgrSmbawaearcdtfgrydbBdbaraDBdbkawclfhwabclfhbaiaDcefgD9hmbkkk;Qodvuv998Jjjjjbca9Rgvczfcwfcbyd11jjbBdbavcb8Pdj1jjb83izavcwfcbydN1jjbBdbavcb8Pd:m1jjb83ibdnadTmbaicd4hodnabmbdnalTmbcbhrinaealarcdtfydbao2cdtfhwcbhiinavczfaifgDawaifIdbgqaDIdbgkakaq9EEUdbavaifgDaqaDIdbgkakaq9DEUdbaiclfgicx9hmbkarcefgrad9hmbxikkaocdthrcbhwincbhiinavczfaifgDaeaifIdbgqaDIdbgkakaq9EEUdbavaifgDaqaDIdbgkakaq9DEUdbaiclfgicx9hmbkaearfheawcefgwad9hmbxdkkdnalTmbcbhrinabarcx2fgiaealarcdtfydbao2cdtfgwIdbUdbaiawIdlUdlaiawIdwUdwcbhiinavczfaifgDawaifIdbgqaDIdbgkakaq9EEUdbavaifgDaqaDIdbgkakaq9DEUdbaiclfgicx9hmbkarcefgrad9hmbxdkkaocdthlcbhraehwinabarcx2fgiaearao2cdtfgDIdbUdbaiaDIdlUdlaiaDIdwUdwcbhiinavczfaifgDawaifIdbgqaDIdbgkakaq9EEUdbavaifgDaqaDIdbgkakaq9DEUdbaiclfgicx9hmbkawalfhwarcefgrad9hmbkkJbbbbavIdbavIdzgk:tgqaqJbbbb9DEgqavIdlavIdCgx:tgmamaq9DEgqavIdwavIdKgm:tgPaPaq9DEhPdnabTmbadTmbJbbbbJbbjZaP:vaPJbbbb9BEhqinabaqabIdbak:tNUdbabclfgvaqavIdbax:tNUdbabcwfgvaqavIdbam:tNUdbabcxfhbadcufgdmbkkaPk:ZlewudnaeTmbcbhvabhoinaoavBdbaoclfhoaeavcefgv9hmbkkdnaiTmbcbhrinadarcdtfhwcbhDinalawaDcdtgvc;a1jjbfydbcdtfydbcdtfydbhodnabalawavfydbcdtfydbgqcdtfgkydbgvaqSmbinakabavgqcdtfgxydbgvBdbaxhkaqav9hmbkkdnabaocdtfgkydbgvaoSmbinakabavgocdtfgxydbgvBdbaxhkaoav9hmbkkdnaqaoSmbabaqaoaqao0Ecdtfaqaoaqao6EBdbkaDcefgDci9hmbkarcifgrai6mbkkdnaembcbskcbhxindnalaxcdtgvfydbax9hmbaxhodnabavfgDydbgvaxSmbaDhqinaqabavgocdtfgkydbgvBdbakhqaoav9hmbkkaDaoBdbkaxcefgxae9hmbkcbhvabhocbhkindndnavalydbgq9hmbdnavaoydbgq9hmbaoakBdbakcefhkxdkaoabaqcdtfydbBdbxekaoabaqcdtfydbBdbkaoclfhoalclfhlaeavcefgv9hmbkakk;Jiilud99duabcbaecltz:ojjjbhvdnalTmbadhoaihralhwinarcwfIdbhDarclfIdbhqavaoydbcltfgkarIdbakIdbMUdbakclfgxaqaxIdbMUdbakcwfgxaDaxIdbMUdbakcxfgkakIdbJbbjZMUdbaoclfhoarcxfhrawcufgwmbkkdnaeTmbavhraehkinarcxfgoIdbhDaocbBdbararIdbJbbbbJbbjZaD:vaDJbbbb9BEgDNUdbarclfgoaDaoIdbNUdbarcwfgoaDaoIdbNUdbarczfhrakcufgkmbkkdnalTmbinavadydbcltfgrcxfgkaicwfIdbarcwfIdb:tgDaDNaiIdbarIdb:tgDaDNaiclfIdbarclfIdb:tgDaDNMMgDakIdbgqaqaD9DEUdbadclfhdaicxfhialcufglmbkkdnaeTmbavcxfhrinabarIdbUdbarczfhrabclfhbaecufgembkkk8MbabaeadaialavcbcbcbcbcbaoarawaDz:bjjjbk8MbabaeadaialavaoarawaDaqakaxamaPz:bjjjbk:DCoDud99rue99iul998Jjjjjbc;Wb9Rgw8KjjjjbdndnarmbcbhDxekawcxfcbc;Kbz:ojjjb8Aawcuadcx2adc;v:Q;v:Qe0Ecbyd:m:jjjbHjjjjbbgqBdxawceBd2aqaeadaicbz:ejjjb8AawcuadcdtadcFFFFi0Egkcbyd:m:jjjbHjjjjbbgxBdzawcdBd2adcd4adfhmceheinaegicetheaiam6mbkcbhPawcuaicdtgsaicFFFFi0Ecbyd:m:jjjbHjjjjbbgzBdCawciBd2dndnar:ZgH:rJbbbZMgO:lJbbb9p9DTmbaO:Ohexekcjjjj94hekaicufhAc:bwhmcbhCadhXcbhQinaChLaeamgKcufaeaK9iEaPgDcefaeaD9kEhYdndnadTmbaYcuf:YhOaqhiaxheadhmindndnaiIdbaONJbbbZMg8A:lJbbb9p9DTmba8A:OhCxekcjjjj94hCkaCcCthCdndnaiclfIdbaONJbbbZMg8A:lJbbb9p9DTmba8A:OhExekcjjjj94hEkaEcqtaCVhCdndnaicwfIdbaONJbbbZMg8A:lJbbb9p9DTmba8A:OhExekcjjjj94hEkaeaCaEVBdbaicxfhiaeclfheamcufgmmbkazcFeasz:ojjjbh3cbh5cbhPindna3axaPcdtfydbgCcm4aC7c:v;t;h;Ev2gics4ai7aAGgmcdtfgEydbgecuSmbaeaCSmbcehiina3amaifaAGgmcdtfgEydbgecuSmeaicefhiaeaC9hmbkkaEaCBdba5aecuSfh5aPcefgPad9hmbxdkkazcFeasz:ojjjb8Acbh5kaDaYa5ar0giEhPaLa5aiEhCdna5arSmbaYaKaiEgmaP9Rcd9imbdndnaQcl0mbdnaX:ZgOaL:Zg8A:taY:Yg8EaD:Y:tg8Fa8EaK:Y:tgaa5:ZghaH:tNNNaOaH:taaNa8Aah:tNa8AaH:ta8FNahaO:tNM:va8EMJbbbZMgO:lJbbb9p9DTmbaO:Ohexdkcjjjj94hexekaPamfcd9Theka5aXaiEhXaQcefgQcs9hmekkdndnaCmbcihicbhDxekcbhiawakcbyd:m:jjjbHjjjjbbg5BdKawclBd2aPcuf:Yh8AdndnadTmbaqhiaxheadhmindndnaiIdba8ANJbbbZMgO:lJbbb9p9DTmbaO:OhCxekcjjjj94hCkaCcCthCdndnaiclfIdba8ANJbbbZMgO:lJbbb9p9DTmbaO:OhExekcjjjj94hEkaEcqtaCVhCdndnaicwfIdba8ANJbbbZMgO:lJbbb9p9DTmbaO:OhExekcjjjj94hEkaeaCaEVBdbaicxfhiaeclfheamcufgmmbkazcFeasz:ojjjbh3cbhDcbhYindndndna3axaYcdtgKfydbgCcm4aC7c:v;t;h;Ev2gics4ai7aAGgmcdtfgEydbgecuSmbcehiinaxaecdtgefydbaCSmdamaifheaicefhia3aeaAGgmcdtfgEydbgecu9hmbkkaEaYBdbaDhiaDcefhDxeka5aefydbhika5aKfaiBdbaYcefgYad9hmbkcuaDc32giaDc;j:KM;jb0EhexekazcFeasz:ojjjb8AcbhDcbhekawaecbyd:m:jjjbHjjjjbbgeBd3awcvBd2aecbaiz:ojjjbhEavcd4hKdnadTmbdnalTmbaKcdth3a5hCaqhealhmadhAinaEaCydbc32fgiaeIdbaiIdbMUdbaiaeclfIdbaiIdlMUdlaiaecwfIdbaiIdwMUdwaiamIdbaiIdxMUdxaiamclfIdbaiIdzMUdzaiamcwfIdbaiIdCMUdCaiaiIdKJbbjZMUdKaCclfhCaecxfheama3fhmaAcufgAmbxdkka5hmaqheadhCinaEamydbc32fgiaeIdbaiIdbMUdbaiaeclfIdbaiIdlMUdlaiaecwfIdbaiIdwMUdwaiaiIdxJbbbbMUdxaiaiIdzJbbbbMUdzaiaiIdCJbbbbMUdCaiaiIdKJbbjZMUdKamclfhmaecxfheaCcufgCmbkkdnaDTmbaEhiaDheinaiaiIdbJbbbbJbbjZaicKfIdbgO:vaOJbbbb9BEgONUdbaiclfgmaOamIdbNUdbaicwfgmaOamIdbNUdbaicxfgmaOamIdbNUdbaiczfgmaOamIdbNUdbaicCfgmaOamIdbNUdbaic3fhiaecufgembkkcbhCawcuaDcdtgYaDcFFFFi0Egicbyd:m:jjjbHjjjjbbgeBdaawcoBd2awaicbyd:m:jjjbHjjjjbbg3Bd8KaecFeaYz:ojjjbhxdnadTmbJbbjZJbbjZa8A:vaPceSEaoNgOaONh8AaKcdthPalheina8Aaec;81jjbalEgmIdwaEa5ydbgAc32fgiIdC:tgOaONamIdbaiIdx:tgOaONamIdlaiIdz:tgOaONMMNaqcwfIdbaiIdw:tgOaONaqIdbaiIdb:tgOaONaqclfIdbaiIdl:tgOaONMMMhOdndnaxaAcdtgifgmydbcuSmba3aifIdbaO9ETmekamaCBdba3aifaOUdbka5clfh5aqcxfhqaeaPfheadaCcefgC9hmbkkabaxaYz:njjjb8AcrhikaicdthiinaiTmeaic98fgiawcxffydbcbyd1:jjjbH:bjjjbbxbkkawc;Wbf8KjjjjbaDk:Ydidui99ducbhi8Jjjjjbca9Rglczfcwfcbyd11jjbBdbalcb8Pdj1jjb83izalcwfcbydN1jjbBdbalcb8Pd:m1jjb83ibdndnaembJbbjFhvJbbjFhoJbbjFhrxekadcd4cdthwincbhdinalczfadfgDabadfIdbgvaDIdbgoaoav9EEUdbaladfgDavaDIdbgoaoav9DEUdbadclfgdcx9hmbkabawfhbaicefgiae9hmbkalIdwalIdK:thralIdlalIdC:thoalIdbalIdz:thvkJbbbbavavJbbbb9DEgvaoaoav9DEgvararav9DEk9DeeuabcFeaicdtz:ojjjbhlcbhbdnadTmbindnalaeydbcdtfgiydbcu9hmbaiabBdbabcefhbkaeclfheadcufgdmbkkabk9teiucbcbyd:q:jjjbgeabcifc98GfgbBd:q:jjjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik;teeeudndnaeabVciGTmbabhixekdndnadcz9pmbabhixekabhiinaiaeydbBdbaiaeydlBdlaiaeydwBdwaiaeydxBdxaeczfheaiczfhiadc9Wfgdcs0mbkkadcl6mbinaiaeydbBdbaeclfheaiclfhiadc98fgdci0mbkkdnadTmbinaiaeRbb86bbaicefhiaecefheadcufgdmbkkabk:3eedudndnabciGTmbabhixekaecFeGc:b:c:ew2hldndnadcz9pmbabhixekabhiinaialBdxaialBdwaialBdlaialBdbaiczfhiadc9Wfgdcs0mbkkadcl6mbinaialBdbaiclfhiadc98fgdci0mbkkdnadTmbinaiae86bbaicefhiadcufgdmbkkabk9teiucbcbyd:q:jjjbgeabcrfc94GfgbBd:q:jjjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik9:eiuZbhedndncbyd:q:jjjbgdaecztgi9nmbcuheadai9RcFFifcz4nbcuSmekadhekcbabae9Rcifc98Gcbyd:q:jjjbfgdBd:q:jjjbdnadZbcztge9nmbadae9RcFFifcz4nb8Akkk:Iedbcjwk1eFFuuFFuuFFuuFFuFFFuFFFuFbbbbbbbbeeebeebebbeeebebbbbbebebbbbbbbbbebbbdbbbbbbbebbbebbbdbbbbbbbbbbbeeeeebebbebbebebbbeebbbbbbbbbbbbbbbbbbbbbc1Dkxebbbdbbb:GNbb";
  var wasmpack = new Uint8Array([
    32,
    0,
    65,
    2,
    1,
    106,
    34,
    33,
    3,
    128,
    11,
    4,
    13,
    64,
    6,
    253,
    10,
    7,
    15,
    116,
    127,
    5,
    8,
    12,
    40,
    16,
    19,
    54,
    20,
    9,
    27,
    255,
    113,
    17,
    42,
    67,
    24,
    23,
    146,
    148,
    18,
    14,
    22,
    45,
    70,
    69,
    56,
    114,
    101,
    21,
    25,
    63,
    75,
    136,
    108,
    28,
    118,
    29,
    73,
    115
  ]);
  if (typeof WebAssembly !== "object") {
    return {
      supported: false
    };
  }
  var instance;
  var ready = WebAssembly.instantiate(unpack(wasm), {}).then(function(result) {
    instance = result.instance;
    instance.exports.__wasm_call_ctors();
  });
  function unpack(data) {
    var result = new Uint8Array(data.length);
    for (var i = 0; i < data.length; ++i) {
      var ch = data.charCodeAt(i);
      result[i] = ch > 96 ? ch - 97 : ch > 64 ? ch - 39 : ch + 4;
    }
    var write = 0;
    for (var i = 0; i < data.length; ++i) {
      result[write++] = result[i] < 60 ? wasmpack[result[i]] : (result[i] - 60) * 64 + result[++i];
    }
    return result.buffer.slice(0, write);
  }
  function assert(cond) {
    if (!cond) {
      throw new Error("Assertion failed");
    }
  }
  function bytes(view) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  function reorder(fun, indices, vertices) {
    var sbrk = instance.exports.sbrk;
    var ip = sbrk(indices.length * 4);
    var rp = sbrk(vertices * 4);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    var indices8 = bytes(indices);
    heap.set(indices8, ip);
    var unique = fun(rp, ip, indices.length, vertices);
    heap = new Uint8Array(instance.exports.memory.buffer);
    var remap = new Uint32Array(vertices);
    new Uint8Array(remap.buffer).set(heap.subarray(rp, rp + vertices * 4));
    indices8.set(heap.subarray(ip, ip + indices.length * 4));
    sbrk(ip - sbrk(0));
    for (var i = 0; i < indices.length; ++i) indices[i] = remap[indices[i]];
    return [remap, unique];
  }
  function maxindex(source) {
    var result = 0;
    for (var i = 0; i < source.length; ++i) {
      var index = source[i];
      result = result < index ? index : result;
    }
    return result;
  }
  function simplify(fun, indices, index_count, vertex_positions, vertex_count, vertex_positions_stride, target_index_count, target_error, options) {
    var sbrk = instance.exports.sbrk;
    var te = sbrk(4);
    var ti = sbrk(index_count * 4);
    var sp = sbrk(vertex_count * vertex_positions_stride);
    var si = sbrk(index_count * 4);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(vertex_positions), sp);
    heap.set(bytes(indices), si);
    var result = fun(ti, si, index_count, sp, vertex_count, vertex_positions_stride, target_index_count, target_error, options, te);
    heap = new Uint8Array(instance.exports.memory.buffer);
    var target = new Uint32Array(result);
    bytes(target).set(heap.subarray(ti, ti + result * 4));
    var error = new Float32Array(1);
    bytes(error).set(heap.subarray(te, te + 4));
    sbrk(te - sbrk(0));
    return [target, error[0]];
  }
  function simplifyAttr(fun, indices, index_count, vertex_positions, vertex_count, vertex_positions_stride, vertex_attributes, vertex_attributes_stride, attribute_weights, vertex_lock, target_index_count, target_error, options) {
    var sbrk = instance.exports.sbrk;
    var te = sbrk(4);
    var ti = sbrk(index_count * 4);
    var sp = sbrk(vertex_count * vertex_positions_stride);
    var sa = sbrk(vertex_count * vertex_attributes_stride);
    var sw = sbrk(attribute_weights.length * 4);
    var si = sbrk(index_count * 4);
    var vl = vertex_lock ? sbrk(vertex_count) : 0;
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(vertex_positions), sp);
    heap.set(bytes(vertex_attributes), sa);
    heap.set(bytes(attribute_weights), sw);
    heap.set(bytes(indices), si);
    if (vertex_lock) {
      heap.set(bytes(vertex_lock), vl);
    }
    var result = fun(
      ti,
      si,
      index_count,
      sp,
      vertex_count,
      vertex_positions_stride,
      sa,
      vertex_attributes_stride,
      sw,
      attribute_weights.length,
      vl,
      target_index_count,
      target_error,
      options,
      te
    );
    heap = new Uint8Array(instance.exports.memory.buffer);
    var target = new Uint32Array(result);
    bytes(target).set(heap.subarray(ti, ti + result * 4));
    var error = new Float32Array(1);
    bytes(error).set(heap.subarray(te, te + 4));
    sbrk(te - sbrk(0));
    return [target, error[0]];
  }
  function simplifyScale(fun, vertex_positions, vertex_count, vertex_positions_stride) {
    var sbrk = instance.exports.sbrk;
    var sp = sbrk(vertex_count * vertex_positions_stride);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(vertex_positions), sp);
    var result = fun(sp, vertex_count, vertex_positions_stride);
    sbrk(sp - sbrk(0));
    return result;
  }
  function simplifyPoints(fun, vertex_positions, vertex_count, vertex_positions_stride, vertex_colors, vertex_colors_stride, color_weight, target_vertex_count) {
    var sbrk = instance.exports.sbrk;
    var ti = sbrk(target_vertex_count * 4);
    var sp = sbrk(vertex_count * vertex_positions_stride);
    var sc = sbrk(vertex_count * vertex_colors_stride);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(vertex_positions), sp);
    if (vertex_colors) {
      heap.set(bytes(vertex_colors), sc);
    }
    var result = fun(ti, sp, vertex_count, vertex_positions_stride, sc, vertex_colors_stride, color_weight, target_vertex_count);
    heap = new Uint8Array(instance.exports.memory.buffer);
    var target = new Uint32Array(result);
    bytes(target).set(heap.subarray(ti, ti + result * 4));
    sbrk(ti - sbrk(0));
    return target;
  }
  var simplifyOptions = {
    LockBorder: 1,
    Sparse: 2,
    ErrorAbsolute: 4,
    Prune: 8,
    _InternalDebug: 1 << 30
    // internal, don't use!
  };
  return {
    ready,
    supported: true,
    compactMesh: function(indices) {
      assert(
        indices instanceof Uint32Array || indices instanceof Int32Array || indices instanceof Uint16Array || indices instanceof Int16Array
      );
      assert(indices.length % 3 == 0);
      var indices32 = indices.BYTES_PER_ELEMENT == 4 ? indices : new Uint32Array(indices);
      return reorder(instance.exports.meshopt_optimizeVertexFetchRemap, indices32, maxindex(indices) + 1);
    },
    simplify: function(indices, vertex_positions, vertex_positions_stride, target_index_count, target_error, flags) {
      assert(
        indices instanceof Uint32Array || indices instanceof Int32Array || indices instanceof Uint16Array || indices instanceof Int16Array
      );
      assert(indices.length % 3 == 0);
      assert(vertex_positions instanceof Float32Array);
      assert(vertex_positions.length % vertex_positions_stride == 0);
      assert(vertex_positions_stride >= 3);
      assert(target_index_count >= 0 && target_index_count <= indices.length);
      assert(target_index_count % 3 == 0);
      assert(target_error >= 0);
      var options = 0;
      for (var i = 0; i < (flags ? flags.length : 0); ++i) {
        assert(flags[i] in simplifyOptions);
        options |= simplifyOptions[flags[i]];
      }
      var indices32 = indices.BYTES_PER_ELEMENT == 4 ? indices : new Uint32Array(indices);
      var result = simplify(
        instance.exports.meshopt_simplify,
        indices32,
        indices.length,
        vertex_positions,
        vertex_positions.length / vertex_positions_stride,
        vertex_positions_stride * 4,
        target_index_count,
        target_error,
        options
      );
      result[0] = indices instanceof Uint32Array ? result[0] : new indices.constructor(result[0]);
      return result;
    },
    simplifyWithAttributes: function(indices, vertex_positions, vertex_positions_stride, vertex_attributes, vertex_attributes_stride, attribute_weights, vertex_lock, target_index_count, target_error, flags) {
      assert(
        indices instanceof Uint32Array || indices instanceof Int32Array || indices instanceof Uint16Array || indices instanceof Int16Array
      );
      assert(indices.length % 3 == 0);
      assert(vertex_positions instanceof Float32Array);
      assert(vertex_positions.length % vertex_positions_stride == 0);
      assert(vertex_positions_stride >= 3);
      assert(vertex_attributes instanceof Float32Array);
      assert(vertex_attributes.length % vertex_attributes_stride == 0);
      assert(vertex_attributes_stride >= 0);
      assert(vertex_lock == null || vertex_lock instanceof Uint8Array);
      assert(vertex_lock == null || vertex_lock.length == vertex_positions.length / vertex_positions_stride);
      assert(target_index_count >= 0 && target_index_count <= indices.length);
      assert(target_index_count % 3 == 0);
      assert(target_error >= 0);
      assert(Array.isArray(attribute_weights));
      assert(vertex_attributes_stride >= attribute_weights.length);
      assert(attribute_weights.length <= 32);
      for (var i = 0; i < attribute_weights.length; ++i) {
        assert(attribute_weights[i] >= 0);
      }
      var options = 0;
      for (var i = 0; i < (flags ? flags.length : 0); ++i) {
        assert(flags[i] in simplifyOptions);
        options |= simplifyOptions[flags[i]];
      }
      var indices32 = indices.BYTES_PER_ELEMENT == 4 ? indices : new Uint32Array(indices);
      var result = simplifyAttr(
        instance.exports.meshopt_simplifyWithAttributes,
        indices32,
        indices.length,
        vertex_positions,
        vertex_positions.length / vertex_positions_stride,
        vertex_positions_stride * 4,
        vertex_attributes,
        vertex_attributes_stride * 4,
        new Float32Array(attribute_weights),
        vertex_lock ? new Uint8Array(vertex_lock) : null,
        target_index_count,
        target_error,
        options
      );
      result[0] = indices instanceof Uint32Array ? result[0] : new indices.constructor(result[0]);
      return result;
    },
    getScale: function(vertex_positions, vertex_positions_stride) {
      assert(vertex_positions instanceof Float32Array);
      assert(vertex_positions.length % vertex_positions_stride == 0);
      assert(vertex_positions_stride >= 3);
      return simplifyScale(
        instance.exports.meshopt_simplifyScale,
        vertex_positions,
        vertex_positions.length / vertex_positions_stride,
        vertex_positions_stride * 4
      );
    },
    simplifyPoints: function(vertex_positions, vertex_positions_stride, target_vertex_count, vertex_colors, vertex_colors_stride, color_weight) {
      assert(vertex_positions instanceof Float32Array);
      assert(vertex_positions.length % vertex_positions_stride == 0);
      assert(vertex_positions_stride >= 3);
      assert(target_vertex_count >= 0 && target_vertex_count <= vertex_positions.length / vertex_positions_stride);
      if (vertex_colors) {
        assert(vertex_colors instanceof Float32Array);
        assert(vertex_colors.length % vertex_colors_stride == 0);
        assert(vertex_colors_stride >= 3);
        assert(vertex_positions.length / vertex_positions_stride == vertex_colors.length / vertex_colors_stride);
        return simplifyPoints(
          instance.exports.meshopt_simplifyPoints,
          vertex_positions,
          vertex_positions.length / vertex_positions_stride,
          vertex_positions_stride * 4,
          vertex_colors,
          vertex_colors_stride * 4,
          color_weight,
          target_vertex_count
        );
      } else {
        return simplifyPoints(
          instance.exports.meshopt_simplifyPoints,
          vertex_positions,
          vertex_positions.length / vertex_positions_stride,
          vertex_positions_stride * 4,
          void 0,
          0,
          0,
          target_vertex_count
        );
      }
    }
  };
})();

// node_modules/meshoptimizer/meshopt_clusterizer.module.js
var MeshoptClusterizer = (function() {
  var wasm = "b9H79TebbbeVx9Geueu9Geub9Gbb9Giuuueu9Gmuuuuuuuuuuu9999eu9Gvuuuuueu9Gwuuuuuuuub9Gxuuuuuuuuuuuueu9Gkuuuuuuuuuu99eu9Gouuuuuub9Gruuuuuuub9GluuuubiOHdilvorwDqqkbiibeilve9Weiiviebeoweuec;G:Odkr:Yewo9TW9T9VV95dbH9F9F939H79T9F9J9H229F9Jt9VV7bb8A9TW79O9V9Wt9F9I919P29K9nW79O2Wt79c9V919U9KbeX9TW79O9V9Wt9F9I919P29K9nW79O2Wt7bo39TW79O9V9Wt9F9J9V9T9W91tWJ2917tWV9c9V919U9K7br39TW79O9V9Wt9F9J9V9T9W91tW9nW79O2Wt9c9V919U9K7bDL9TW79O9V9Wt9F9V9Wt9P9T9P96W9nW79O2Wtbql79IV9RbkDwebcekdsPq;Q9BHdbkIbabaec9:fgefcufae9Ugeabci9Uadfcufad9Ugbaeab0Ek:w8KDPue99eux99dui99euo99iu8Jjjjjbc:WD9Rgm8KjjjjbdndnalmbcbhPxekamc:Cwfcbc;Kbz:njjjb8Adndnalcb9imbaoal9nmbamcuaocdtaocFFFFi0Egscbyd;y1jjbHjjjjbbgzBd:CwamceBd;8wamascbyd;y1jjbHjjjjbbgHBd:GwamcdBd;8wamcualcdtalcFFFFi0Ecbyd;y1jjbHjjjjbbgOBd:KwamciBd;8waihsalhAinazasydbcdtfcbBdbasclfhsaAcufgAmbkaihsalhAinazasydbcdtfgCaCydbcefBdbasclfhsaAcufgAmbkaihsalhCcbhXindnazasydbcdtgQfgAydbcb9imbaHaQfaXBdbaAaAydbgQcjjjj94VBdbaQaXfhXkasclfhsaCcufgCmbkalci9UhLdnalci6mbcbhsaihAinaAcwfydbhCaAclfydbhXaHaAydbcdtfgQaQydbgQcefBdbaOaQcdtfasBdbaHaXcdtfgXaXydbgXcefBdbaOaXcdtfasBdbaHaCcdtfgCaCydbgCcefBdbaOaCcdtfasBdbaAcxfhAaLascefgs9hmbkkaihsalhAindnazasydbcdtgCfgXydbgQcu9kmbaXaQcFFFFrGgQBdbaHaCfgCaCydbaQ9RBdbkasclfhsaAcufgAmbxdkkamcuaocdtgsaocFFFFi0EgAcbyd;y1jjbHjjjjbbgzBd:CwamceBd;8wamaAcbyd;y1jjbHjjjjbbgHBd:GwamcdBd;8wamcualcdtalcFFFFi0Ecbyd;y1jjbHjjjjbbgOBd:KwamciBd;8wazcbasz:njjjbhXalci9UhLaihsalhAinaXasydbcdtfgCaCydbcefBdbasclfhsaAcufgAmbkdnaoTmbcbhsaHhAaXhCaohQinaAasBdbaAclfhAaCydbasfhsaCclfhCaQcufgQmbkkdnalci6mbcbhsaihAinaAcwfydbhCaAclfydbhQaHaAydbcdtfgKaKydbgKcefBdbaOaKcdtfasBdbaHaQcdtfgQaQydbgQcefBdbaOaQcdtfasBdbaHaCcdtfgCaCydbgCcefBdbaOaCcdtfasBdbaAcxfhAaLascefgs9hmbkkaoTmbcbhsaohAinaHasfgCaCydbaXasfydb9RBdbasclfhsaAcufgAmbkkamaLcbyd;y1jjbHjjjjbbgsBd:OwamclBd;8wascbaLz:njjjbhYamcuaLcK2alcjjjjd0Ecbyd;y1jjbHjjjjbbg8ABd:SwamcvBd;8wJbbbbhEdnalci6g3mbarcd4hKaihAa8AhsaLhrJbbbbh5inavaAclfydbaK2cdtfgCIdlh8EavaAydbaK2cdtfgXIdlhEavaAcwfydbaK2cdtfgQIdlh8FaCIdwhaaXIdwhhaQIdwhgasaCIdbg8JaXIdbg8KMaQIdbg8LMJbbnn:vUdbasclfaXIdlaCIdlMaQIdlMJbbnn:vUdbaQIdwh8MaCIdwh8NaXIdwhyascxfa8EaE:tg8Eagah:tggNa8FaE:tg8Faaah:tgaN:tgEJbbbbJbbjZa8Ja8K:tg8Ja8FNa8La8K:tg8Ka8EN:tghahNaEaENaaa8KNaga8JN:tgEaENMM:rg8K:va8KJbbbb9BEg8ENUdbasczfaEa8ENUdbascCfaha8ENUdbascwfa8Maya8NMMJbbnn:vUdba5a8KMh5aAcxfhAascKfhsarcufgrmbka5aL:Z:vJbbbZNhEkamcuaLcdtalcFFFF970Ecbyd;y1jjbHjjjjbbgCBd:WwamcoBd;8waEaq:ZNhEdna3mbcbhsaChAinaAasBdbaAclfhAaLascefgs9hmbkkaE:rhhcuh8PamcuaLcltalcFFFFd0Ecbyd;y1jjbHjjjjbbgIBd:0wamcrBd;8wcbaIa8AaCaLz:djjjb8AJFFuuhyJFFuuh8RJFFuuh8Sdnalci6gXmbJFFuuh8Sa8AhsaLhAJFFuuh8RJFFuuhyinascwfIdbgEayayaE9EEhyasclfIdbgEa8Ra8RaE9EEh8RasIdbgEa8Sa8SaE9EEh8SascKfhsaAcufgAmbkkahJbbbZNhgamaocetgscuaocu9kEcbyd;y1jjbHjjjjbbgABd:4waAcFeasz:njjjbhCdnaXmbcbhAJFFuuhEa8Ahscuh8PinascwfIdbay:tghahNasIdba8S:tghahNasclfIdba8R:tghahNMM:rghaEa8PcuSahaE9DVgXEhEaAa8PaXEh8PascKfhsaLaAcefgA9hmbkkamczfcbcjwz:njjjb8Aamcwf9cb83ibam9cb83ibagaxNhRJbbjZak:th8Ncbh8UJbbbbh8VJbbbbh8WJbbbbh8XJbbbbh8YJbbbbh8ZJbbbbh80cbh81cbhPinJbbbbhEdna8UTmbJbbjZa8U:Z:vhEkJbbbbhhdna80a80Na8Ya8YNa8Za8ZNMMg8KJbbbb9BmbJbbjZa8K:r:vhhka8XaENh5a8WaENh8Fa8VaENhaa8PhQdndndndndna8UaPVTmbamydwgBTmea80ahNh8Ja8ZahNh8La8YahNh8Maeamydbcdtfh83cbh3JFFuuhEcvhXcuhQindnaza83a3cdtfydbcdtgsfydbgvTmbaOaHasfydbcdtfhAindndnaCaiaAydbgKcx2fgsclfydbgrcetf8Vebcs4aCasydbgLcetf8Vebcs4faCascwfydbglcetf8Vebcs4fgombcbhsxekcehsazaLcdtfydbgLceSmbcehsazarcdtfydbgrceSmbcehsazalcdtfydbglceSmbdnarcdSaLcdSfalcdSfcd6mbaocefhsxekaocdfhskdnasaX9kmba8AaKcK2fgLIdwa5:thhaLIdla8F:th8KaLIdbaa:th8EdndnakJbbbb9DTmba8E:lg8Ea8K:lg8Ka8Ea8K9EEg8Kah:lgha8Kah9EEag:vJbbjZMhhxekahahNa8Ea8ENa8Ka8KNMM:rag:va8NNJbbjZMJ9VO:d86JbbjZaLIdCa8JNaLIdxa8MNa8LaLIdzNMMakN:tghahJ9VO:d869DENhhkaKaQasaX6ahaE9DVgLEhQasaXaLEhXahaEaLEhEkaAclfhAavcufgvmbkka3cefg3aB9hmbkkaQcu9hmekama5Ud:ODama8FUd:KDamaaUd:GDamcuBd:qDamcFFF;7rBdjDaIcba8AaYamc:GDfakJbbbb9Damc:qDfamcjDfz:ejjjbamyd:qDhQdndnaxJbbbb9ETmba8UaD6mbaQcuSmeceh3amIdjDaR9EmixdkaQcu9hmekdna8UTmbdnamydlgza8Uci2fgsciGTmbadasfcba8Uazcu7fciGcefz:njjjb8AkabaPcltfgzam8Pib83dbazcwfamcwf8Pib83dbaPcefhPkc3hzinazc98Smvamc:Cwfazfydbcbyd;u1jjbH:bjjjbbazc98fhzxbkkcbh3a8Uaq9pmbamydwaCaiaQcx2fgsydbcetf8Vebcs4aCascwfydbcetf8Vebcs4faCasclfydbcetf8Vebcs4ffaw9nmekcbhscbhAdna81TmbcbhAamczfhXinamczfaAcdtfaXydbgLBdbaXclfhXaAaYaLfRbbTfhAa81cufg81mbkkamydwhlamydbhXam9cu83i:GDam9cu83i:ODam9cu83i:qDam9cu83i:yDaAc;8eaAclfc:bd6Eh81inamcjDfasfcFFF;7rBdbasclfgscz9hmbka81cdthBdnalTmbaeaXcdtfhocbhrindnazaoarcdtfydbcdtgsfydbgvTmbaOaHasfydbcdtfhAcuhLcuhsinazaiaAydbgKcx2fgXclfydbcdtfydbazaXydbcdtfydbfazaXcwfydbcdtfydbfgXasaXas6gXEhsaKaLaXEhLaAclfhAavcufgvmbkaLcuSmba8AaLcK2fgAIdway:tgEaENaAIdba8S:tgEaENaAIdla8R:tgEaENMM:rhEcbhAindndnasamc:qDfaAfgvydbgX6mbasaX9hmeaEamcjDfaAfIdb9FTmekavasBdbamc:GDfaAfaLBdbamcjDfaAfaEUdbxdkaAclfgAcz9hmbkkarcefgral9hmbkkamczfaBfhLcbhscbhAindnamc:GDfasfydbgXcuSmbaLaAcdtfaXBdbaAcefhAkasclfgscz9hmbkaAa81fg81TmbJFFuuhhcuhKamczfhsa81hvcuhLina8AasydbgXcK2fgAIdway:tgEaENaAIdba8S:tgEaENaAIdla8R:tgEaENMM:rhEdndnazaiaXcx2fgAclfydbcdtfydbazaAydbcdtfydbfazaAcwfydbcdtfydbfgAaL6mbaAaL9hmeaEah9DTmekaEhhaAhLaXhKkasclfhsavcufgvmbkaKcuSmbaKhQkdnamaiaQcx2fgrydbarclfydbarcwfydbaCabaeadaPawaqa3z:fjjjbTmbaPcefhPJbbbbh8VJbbbbh8WJbbbbh8XJbbbbh8YJbbbbh8ZJbbbbh80kcbhXinaOaHaraXcdtfydbcdtgAfydbcdtfgKhsazaAfgvydbgLhAdnaLTmbdninasydbaQSmeasclfhsaAcufgATmdxbkkasaKaLcdtfc98fydbBdbavavydbcufBdbkaXcefgXci9hmbka8AaQcK2fgsIdbhEasIdlhhasIdwh8KasIdxh8EasIdzh5asIdCh8FaYaQfce86bba80a8FMh80a8Za5Mh8Za8Ya8EMh8Ya8Xa8KMh8Xa8WahMh8Wa8VaEMh8Vamydxh8Uxbkkamc:WDf8KjjjjbaPk;Vvivuv99lu8Jjjjjbca9Rgv8Kjjjjbdndnalcw0mbaiydbhoaeabcitfgralcdtcufBdlaraoBdbdnalcd6mbaiclfhoalcufhwarcxfhrinaoydbhDarcuBdbarc98faDBdbarcwfhraoclfhoawcufgwmbkkalabfhrxekcbhDavczfcwfcbBdbav9cb83izavcwfcbBdbav9cb83ibJbbjZhqJbbjZhkinadaiaDcdtfydbcK2fhwcbhrinavczfarfgoawarfIdbgxaoIdbgm:tgPakNamMgmUdbavarfgoaPaxam:tNaoIdbMUdbarclfgrcx9hmbkJbbjZaqJbbjZMgq:vhkaDcefgDal9hmbkcbhoadcbcecdavIdlgxavIdwgm9GEgravIdbgPam9GEaraPax9GEgscdtgrfhzavczfarfIdbhxaihralhwinaiaocdtfgDydbhHaDarydbgOBdbaraHBdbarclfhraoazaOcK2fIdbax9Dfhoawcufgwmbkaeabcitfhrdndnaocv6mbaoalc98f6mekaraiydbBdbaralcdtcufBdlaiclfhoalcufhwarcxfhrinaoydbhDarcuBdbarc98faDBdbarcwfhraoclfhoawcufgwmbkalabfhrxekaraxUdbararydlc98GasVBdlabcefaeadaiaoz:djjjbhwararydlciGawabcu7fcdtVBdlawaeadaiaocdtfalao9Rz:djjjbhrkavcaf8Kjjjjbark:;idiud99dndnabaecitfgwydlgDciGgqciSmbinabcbaDcd4gDalaqcdtfIdbawIdb:tgkJbbbb9FEgwaecefgefadaialavaoarz:ejjjbak:larIdb9FTmdabawaD7aefgecitfgwydlgDciGgqci9hmbkkabaecitfgeclfhbdnavmbcuhwindnaiaeydbgDfRbbmbadaDcK2fgqIdwalIdw:tgkakNaqIdbalIdb:tgkakNaqIdlalIdl:tgkakNMM:rgkarIdb9DTmbarakUdbaoaDBdbkaecwfheawcefgwabydbcd46mbxdkkcuhwindnaiaeydbgDfRbbmbadaDcK2fgqIdbalIdb:t:lgkaqIdlalIdl:t:lgxakax9EEgkaqIdwalIdw:t:lgxakax9EEgkarIdb9DTmbarakUdbaoaDBdbkaecwfheawcefgwabydbcd46mbkkk;llevudnabydwgxaladcetfgm8Vebcs4alaecetfgP8Vebgscs4falaicetfgz8Vebcs4ffaD0abydxaq9pVakVgDce9hmbavawcltfgxab8Pdb83dbaxcwfabcwfgx8Pdb83dbdnaxydbgqTmbaoabydbcdtfhxaqhsinalaxydbcetfcFFi87ebaxclfhxascufgsmbkkdnabydxglci2gsabydlgxfgkciGTmbarakfcbalaxcu7fciGcefz:njjjb8Aabydxci2hsabydlhxabydwhqkab9cb83dwababydbaqfBdbabascifc98GaxfBdlaP8Vebhscbhxkdnascztcz91cu9kmbabaxcefBdwaPax87ebaoabydbcdtfaxcdtfaeBdbkdnam8Uebcu9kmbababydwgxcefBdwamax87ebaoabydbcdtfaxcdtfadBdbkdnaz8Uebcu9kmbababydwgxcefBdwazax87ebaoabydbcdtfaxcdtfaiBdbkarabydlfabydxci2faPRbb86bbarabydlfabydxci2fcefamRbb86bbarabydlfabydxci2fcdfazRbb86bbababydxcefBdxaDk8LbabaeadaialavaoarawaDaDaqJbbbbz:cjjjbk;Nkovud99euv99eul998Jjjjjbc:W;ae9Rgo8KjjjjbdndnadTmbavcd4hrcbhwcbhDindnaiaeclfydbar2cdtfgvIdbaiaeydbar2cdtfgqIdbgk:tgxaiaecwfydbar2cdtfgmIdlaqIdlgP:tgsNamIdbak:tgzavIdlaP:tgPN:tgkakNaPamIdwaqIdwgH:tgONasavIdwaH:tgHN:tgPaPNaHazNaOaxN:tgxaxNMM:rgsJbbbb9Bmbaoc:W:qefawcx2fgAakas:vUdwaAaxas:vUdlaAaPas:vUdbaoc8Wfawc8K2fgAaq8Pdb83dbaAav8Pdb83dxaAam8Pdb83dKaAcwfaqcwfydbBdbaAcCfavcwfydbBdbaAcafamcwfydbBdbawcefhwkaecxfheaDcifgDad6mbkab9cb83dbabcyf9cb83dbabcaf9cb83dbabcKf9cb83dbabczf9cb83dbabcwf9cb83dbawTmeaocbBd8Sao9cb83iKao9cb83izaoczfaoc8Wfawci2cxaoc8Sfcbcrz1jjjbaoIdKhCaoIdChXaoIdzhQao9cb83iwao9cb83ibaoaoc:W:qefawcxaoc8Sfcbciz1jjjbJbbjZhkaoIdwgPJbbbbJbbjZaPaPNaoIdbgPaPNaoIdlgsasNMM:rgx:vaxJbbbb9BEgzNhxasazNhsaPazNhzaoc:W:qefheawhvinaecwfIdbaxNaeIdbazNasaeclfIdbNMMgPakaPak9DEhkaecxfheavcufgvmbkabaCUdwabaXUdlabaQUdbabaoId3UdxdndnakJ;n;m;m899FmbJbbbbhPaoc:W:qefheaoc8WfhvinaCavcwfIdb:taecwfIdbgHNaQavIdb:taeIdbgONaXavclfIdb:taeclfIdbgLNMMaxaHNazaONasaLNMM:vgHaPaHaP9EEhPavc8KfhvaecxfheawcufgwmbkabaxUd8KabasUdaabazUd3abaCaxaPN:tUdKabaXasaPN:tUdCabaQazaPN:tUdzabJbbjZakakN:t:rgkUdydndnaxJbbj:;axJbbj:;9GEgPJbbjZaPJbbjZ9FEJbb;:9cNJbbbZJbbb:;axJbbbb9GEMgP:lJbbb9p9DTmbaP:Ohexekcjjjj94hekabae86b8UdndnasJbbj:;asJbbj:;9GEgPJbbjZaPJbbjZ9FEJbb;:9cNJbbbZJbbb:;asJbbbb9GEMgP:lJbbb9p9DTmbaP:Ohvxekcjjjj94hvkabav86bRdndnazJbbj:;azJbbj:;9GEgPJbbjZaPJbbjZ9FEJbb;:9cNJbbbZJbbb:;azJbbbb9GEMgP:lJbbb9p9DTmbaP:Ohqxekcjjjj94hqkabaq86b8SdndnaecKtcK91:YJbb;:9c:vax:t:lavcKtcK91:YJbb;:9c:vas:t:laqcKtcK91:YJbb;:9c:vaz:t:lakMMMJbb;:9cNJbbjZMgk:lJbbb9p9DTmbak:Ohexekcjjjj94hekaecFbaecFb9iEhexekabcjjj;8iBdycFbhekabae86b8Vxekab9cb83dbabcyf9cb83dbabcaf9cb83dbabcKf9cb83dbabczf9cb83dbabcwf9cb83dbkaoc:W;aef8Kjjjjbk;Iwwvul99iud99eue99eul998Jjjjjbcje9Rgr8Kjjjjbavcd4hwaicd4hDdndnaoTmbarc;abfcbaocdtgvz:njjjb8Aarc;Gbfcbavz:njjjb8AarhvarcafhiaohqinavcFFF97BdbaicFFF;7rBdbaiclfhiavclfhvaqcufgqmbkdnadTmbcbhkinaeakaD2cdtfgvIdwhxavIdlhmavIdbhPalakaw2cdtfIdbhsarc;abfhzarhiarc;GbfhHarcafhqcj1jjbhvaohOinasavcwfIdbaxNavIdbaPNavclfIdbamNMMgAMhCakhXdnaAas:tgAaqIdbgQ9DgLmbaHydbhXkaHaXBdbakhXdnaCaiIdbgK9EmbazydbhXaKhCkazaXBdbaiaCUdbaqaAaQaLEUdbavcxfhvaqclfhqaHclfhHaiclfhiazclfhzaOcufgOmbkakcefgkad9hmbkkadThkJbbbbhCcbhXarc;abfhvarc;Gbfhicbhqinalavydbgzaw2cdtfIdbalaiydbgHaw2cdtfIdbaeazaD2cdtfgzIdwaeaHaD2cdtfgHIdw:tgsasNazIdbaHIdb:tgsasNazIdlaHIdl:tgsasNMM:rMMgsaCasaC9EgzEhCaqaXazEhXaiclfhiavclfhvaoaqcefgq9hmbkaCJbbbZNhKxekadThkcbhXJbbbbhKkJbbbbhCdnaearc;abfaXcdtgifydbgqaD2cdtfgvIdwaearc;GbfaifydbgzaD2cdtfgiIdwgm:tgsasNavIdbaiIdbgY:tgAaANavIdlaiIdlgP:tgQaQNMM:rgxJbbbb9ETmbaxalaqaw2cdtfIdbMalazaw2cdtfIdb:taxaxM:vhCkasaCNamMhmaQaCNaPMhPaAaCNaYMhYdnakmbaDcdthvawcdthiindnalIdbg8AaecwfIdbam:tgCaCNaeIdbaY:tgsasNaeclfIdbaP:tgAaANMM:rgQMgEaK9ETmbJbbbbhxdnaQJbbbb9ETmbaEaK:taQaQM:vhxkaxaCNamMhmaxaANaPMhPaxasNaYMhYa8AaKaQMMJbbbZNhKkaeavfhealaifhladcufgdmbkkabaKUdxabamUdwabaPUdlabaYUdbarcjef8Kjjjjbkjeeiu8Jjjjjbcj8W9Rgr8Kjjjjbaici2hwdnaiTmbawceawce0EhDarhiinaiaeadRbbcdtfydbBdbadcefhdaiclfhiaDcufgDmbkkabarawaladaoz:hjjjbarcj8Wf8Kjjjjbk:3lequ8JjjjjbcjP9Rgl8Kjjjjbcbhvalcjxfcbaiz:njjjb8AdndnadTmbcjehoaehrincuhwarhDcuhqavhkdninawakaoalcjxfaDcefRbbfRbb9RcFeGci6aoalcjxfaDRbbfRbb9RcFeGci6faoalcjxfaDcdfRbbfRbb9RcFeGci6fgxaq9mgmEhwdnammbaxce0mdkaxaqaxaq9kEhqaDcifhDadakcefgk9hmbkkaeawci2fgDcdfRbbhqaDcefRbbhxaDRbbhkaeavci2fgDcifaDawav9Rci2z:qjjjb8Aakalcjxffaocefgo86bbaxalcjxffao86bbaDcdfaq86bbaDcefax86bbaDak86bbaqalcjxffao86bbarcifhravcefgvad9hmbkalcFeaicetz:njjjbhoadci2gDceaDce0EhqcbhxindnaoaeRbbgkcetfgw8UebgDcu9kmbawax87ebaocjlfaxcdtfabakcdtfydbBdbaxhDaxcefhxkaeaD86bbaecefheaqcufgqmbkaxcdthDxekcbhDkabalcjlfaDz:mjjjb8AalcjPf8Kjjjjbk9teiucbcbyd;C1jjbgeabcifc98GfgbBd;C1jjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik;teeeudndnaeabVciGTmbabhixekdndnadcz9pmbabhixekabhiinaiaeydbBdbaiaeydlBdlaiaeydwBdwaiaeydxBdxaeczfheaiczfhiadc9Wfgdcs0mbkkadcl6mbinaiaeydbBdbaeclfheaiclfhiadc98fgdci0mbkkdnadTmbinaiaeRbb86bbaicefhiaecefheadcufgdmbkkabk:3eedudndnabciGTmbabhixekaecFeGc:b:c:ew2hldndnadcz9pmbabhixekabhiinaialBdxaialBdwaialBdlaialBdbaiczfhiadc9Wfgdcs0mbkkadcl6mbinaialBdbaiclfhiadc98fgdci0mbkkdnadTmbinaiae86bbaicefhiadcufgdmbkkabk9teiucbcbyd;C1jjbgeabcrfc94GfgbBd;C1jjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik9:eiuZbhedndncbyd;C1jjbgdaecztgi9nmbcuheadai9RcFFifcz4nbcuSmekadhekcbabae9Rcifc98Gcbyd;C1jjbfgdBd;C1jjbdnadZbcztge9nmbadae9RcFFifcz4nb8Akk:;Deludndndnadch9pmbabaeSmdaeabadfgi9Rcbadcet9R0mekabaead;8qbbxekaeab7ciGhldndndnabae9pmbdnalTmbadhvabhixikdnabciGmbadhvabhixdkadTmiabaeRbb86bbadcufhvdnabcefgiciGmbaecefhexdkavTmiabaeRbe86beadc9:fhvdnabcdfgiciGmbaecdfhexdkavTmiabaeRbd86bdadc99fhvdnabcifgiciGmbaecifhexdkavTmiabaeRbi86biabclfhiaeclfheadc98fhvxekdnalmbdnaiciGTmbadTmlabadcufgifglaeaifRbb86bbdnalciGmbaihdxekaiTmlabadc9:fgifglaeaifRbb86bbdnalciGmbaihdxekaiTmlabadc99fgifglaeaifRbb86bbdnalciGmbaihdxekaiTmlabadc98fgdfaeadfRbb86bbkadcl6mbdnadc98fgocd4cefciGgiTmbaec98fhlabc98fhvinavadfaladfydbBdbadc98fhdaicufgimbkkaocx6mbaec9Wfhvabc9WfhoinaoadfgicxfavadfglcxfydbBdbaicwfalcwfydbBdbaiclfalclfydbBdbaialydbBdbadc9Wfgdci0mbkkadTmdadhidnadciGglTmbaecufhvabcufhoadhiinaoaifavaifRbb86bbaicufhialcufglmbkkadcl6mdaec98fhlabc98fhvinavaifgecifalaifgdcifRbb86bbaecdfadcdfRbb86bbaecefadcefRbb86bbaeadRbb86bbaic98fgimbxikkavcl6mbdnavc98fglcd4cefcrGgdTmbavadcdt9RhvinaiaeydbBdbaeclfheaiclfhiadcufgdmbkkalc36mbinaiaeydbBdbaiaeydlBdlaiaeydwBdwaiaeydxBdxaiaeydzBdzaiaeydCBdCaiaeydKBdKaiaeyd3Bd3aecafheaicafhiavc9Gfgvci0mbkkavTmbdndnavcrGgdmbavhlxekavc94GhlinaiaeRbb86bbaicefhiaecefheadcufgdmbkkavcw6mbinaiaeRbb86bbaiaeRbe86beaiaeRbd86bdaiaeRbi86biaiaeRbl86blaiaeRbv86bvaiaeRbo86boaiaeRbr86braicwfhiaecwfhealc94fglmbkkabkk9Tdbcjwk9ubbjZbbbbbbbbbbbbbbjZbbbbbbbbbbbbbbjZ86;nAZ86;nAZ86;nAZ86;nA:;86;nAZ86;nAZ86;nAZ86;nA:;86;nAZ86;nAZ86;nAZ86;nA:;bc;uwkxebbbdbbb9GNbb";
  var wasmpack = new Uint8Array([
    32,
    0,
    65,
    2,
    1,
    106,
    34,
    33,
    3,
    128,
    11,
    4,
    13,
    64,
    6,
    253,
    10,
    7,
    15,
    116,
    127,
    5,
    8,
    12,
    40,
    16,
    19,
    54,
    20,
    9,
    27,
    255,
    113,
    17,
    42,
    67,
    24,
    23,
    146,
    148,
    18,
    14,
    22,
    45,
    70,
    69,
    56,
    114,
    101,
    21,
    25,
    63,
    75,
    136,
    108,
    28,
    118,
    29,
    73,
    115
  ]);
  if (typeof WebAssembly !== "object") {
    return {
      supported: false
    };
  }
  var instance;
  var ready = WebAssembly.instantiate(unpack(wasm), {}).then(function(result) {
    instance = result.instance;
    instance.exports.__wasm_call_ctors();
  });
  function unpack(data) {
    var result = new Uint8Array(data.length);
    for (var i = 0; i < data.length; ++i) {
      var ch = data.charCodeAt(i);
      result[i] = ch > 96 ? ch - 97 : ch > 64 ? ch - 39 : ch + 4;
    }
    var write = 0;
    for (var i = 0; i < data.length; ++i) {
      result[write++] = result[i] < 60 ? wasmpack[result[i]] : (result[i] - 60) * 64 + result[++i];
    }
    return result.buffer.slice(0, write);
  }
  function assert(cond) {
    if (!cond) {
      throw new Error("Assertion failed");
    }
  }
  function bytes(view) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  var BOUNDS_SIZE = 48;
  var MESHLET_SIZE = 16;
  function extractMeshlet(buffers, index) {
    var vertex_offset = buffers.meshlets[index * 4 + 0];
    var triangle_offset = buffers.meshlets[index * 4 + 1];
    var vertex_count = buffers.meshlets[index * 4 + 2];
    var triangle_count = buffers.meshlets[index * 4 + 3];
    return {
      vertices: buffers.vertices.subarray(vertex_offset, vertex_offset + vertex_count),
      triangles: buffers.triangles.subarray(triangle_offset, triangle_offset + triangle_count * 3)
    };
  }
  function buildMeshlets(indices, vertex_positions, vertex_count, vertex_positions_stride, max_vertices, max_triangles, cone_weight) {
    var sbrk = instance.exports.sbrk;
    var max_meshlets = instance.exports.meshopt_buildMeshletsBound(indices.length, max_vertices, max_triangles);
    var meshletsp = sbrk(max_meshlets * MESHLET_SIZE);
    var meshlet_verticesp = sbrk(max_meshlets * max_vertices * 4);
    var meshlet_trianglesp = sbrk(max_meshlets * max_triangles * 3);
    var indicesp = sbrk(indices.byteLength);
    var verticesp = sbrk(vertex_positions.byteLength);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(indices), indicesp);
    heap.set(bytes(vertex_positions), verticesp);
    var count = instance.exports.meshopt_buildMeshlets(
      meshletsp,
      meshlet_verticesp,
      meshlet_trianglesp,
      indicesp,
      indices.length,
      verticesp,
      vertex_count,
      vertex_positions_stride,
      max_vertices,
      max_triangles,
      cone_weight
    );
    heap = new Uint8Array(instance.exports.memory.buffer);
    var meshletBytes = heap.subarray(meshletsp, meshletsp + count * MESHLET_SIZE);
    var meshlets = new Uint32Array(meshletBytes.buffer, meshletBytes.byteOffset, meshletBytes.byteLength / 4).slice();
    for (var i = 0; i < count; ++i) {
      var vertex_offset = meshlets[i * 4 + 0];
      var triangle_offset = meshlets[i * 4 + 1];
      var vertex_count = meshlets[i * 4 + 2];
      var triangle_count = meshlets[i * 4 + 3];
      instance.exports.meshopt_optimizeMeshlet(
        meshlet_verticesp + vertex_offset * 4,
        meshlet_trianglesp + triangle_offset,
        triangle_count,
        vertex_count
      );
    }
    var last_vertex_offset = meshlets[(count - 1) * 4 + 0];
    var last_triangle_offset = meshlets[(count - 1) * 4 + 1];
    var last_vertex_count = meshlets[(count - 1) * 4 + 2];
    var last_triangle_count = meshlets[(count - 1) * 4 + 3];
    var used_vertices = last_vertex_offset + last_vertex_count;
    var used_triangles = last_triangle_offset + (last_triangle_count * 3 + 3 & ~3);
    var result = {
      meshlets,
      vertices: new Uint32Array(heap.buffer, meshlet_verticesp, used_vertices).slice(),
      triangles: new Uint8Array(heap.buffer, meshlet_trianglesp, used_triangles * 3).slice(),
      meshletCount: count
    };
    sbrk(meshletsp - sbrk(0));
    return result;
  }
  function extractBounds(boundsp) {
    var bounds_floats = new Float32Array(instance.exports.memory.buffer, boundsp, BOUNDS_SIZE / 4);
    return {
      centerX: bounds_floats[0],
      centerY: bounds_floats[1],
      centerZ: bounds_floats[2],
      radius: bounds_floats[3],
      coneApexX: bounds_floats[4],
      coneApexY: bounds_floats[5],
      coneApexZ: bounds_floats[6],
      coneAxisX: bounds_floats[7],
      coneAxisY: bounds_floats[8],
      coneAxisZ: bounds_floats[9],
      coneCutoff: bounds_floats[10]
    };
  }
  function computeMeshletBounds(buffers, vertex_positions, vertex_count, vertex_positions_stride) {
    var sbrk = instance.exports.sbrk;
    var results = [];
    var verticesp = sbrk(vertex_positions.byteLength);
    var meshlet_verticesp = sbrk(buffers.vertices.byteLength);
    var meshlet_trianglesp = sbrk(buffers.triangles.byteLength);
    var resultp = sbrk(BOUNDS_SIZE);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(vertex_positions), verticesp);
    heap.set(bytes(buffers.vertices), meshlet_verticesp);
    heap.set(bytes(buffers.triangles), meshlet_trianglesp);
    for (var i = 0; i < buffers.meshletCount; ++i) {
      var vertex_offset = buffers.meshlets[i * 4 + 0];
      var triangle_offset = buffers.meshlets[i * 4 + 0 + 1];
      var triangle_count = buffers.meshlets[i * 4 + 0 + 3];
      instance.exports.meshopt_computeMeshletBounds(
        resultp,
        meshlet_verticesp + vertex_offset * 4,
        meshlet_trianglesp + triangle_offset,
        triangle_count,
        verticesp,
        vertex_count,
        vertex_positions_stride
      );
      results.push(extractBounds(resultp));
    }
    sbrk(verticesp - sbrk(0));
    return results;
  }
  function computeClusterBounds(indices, vertex_positions, vertex_count, vertex_positions_stride) {
    var sbrk = instance.exports.sbrk;
    var resultp = sbrk(BOUNDS_SIZE);
    var indicesp = sbrk(indices.byteLength);
    var verticesp = sbrk(vertex_positions.byteLength);
    var heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(bytes(indices), indicesp);
    heap.set(bytes(vertex_positions), verticesp);
    instance.exports.meshopt_computeClusterBounds(resultp, indicesp, indices.length, verticesp, vertex_count, vertex_positions_stride);
    var result = extractBounds(resultp);
    sbrk(resultp - sbrk(0));
    return result;
  }
  return {
    ready,
    supported: true,
    buildMeshlets: function(indices, vertex_positions, vertex_positions_stride, max_vertices, max_triangles, cone_weight) {
      assert(indices.length % 3 == 0);
      assert(vertex_positions instanceof Float32Array);
      assert(vertex_positions.length % vertex_positions_stride == 0);
      assert(vertex_positions_stride >= 3);
      assert(max_vertices <= 256 || max_vertices > 0);
      assert(max_triangles <= 512);
      assert(max_triangles % 4 == 0);
      cone_weight = cone_weight || 0;
      var indices32 = indices.BYTES_PER_ELEMENT == 4 ? indices : new Uint32Array(indices);
      return buildMeshlets(
        indices32,
        vertex_positions,
        vertex_positions.length / vertex_positions_stride,
        vertex_positions_stride * 4,
        max_vertices,
        max_triangles,
        cone_weight
      );
    },
    computeClusterBounds: function(indices, vertex_positions, vertex_positions_stride) {
      assert(indices.length % 3 == 0);
      assert(indices.length / 3 <= 512);
      assert(vertex_positions instanceof Float32Array);
      assert(vertex_positions.length % vertex_positions_stride == 0);
      assert(vertex_positions_stride >= 3);
      var indices32 = indices.BYTES_PER_ELEMENT == 4 ? indices : new Uint32Array(indices);
      return computeClusterBounds(indices32, vertex_positions, vertex_positions.length / vertex_positions_stride, vertex_positions_stride * 4);
    },
    computeMeshletBounds: function(buffers, vertex_positions, vertex_positions_stride) {
      assert(buffers.meshletCount != 0);
      assert(vertex_positions instanceof Float32Array);
      assert(vertex_positions.length % vertex_positions_stride == 0);
      assert(vertex_positions_stride >= 3);
      return computeMeshletBounds(buffers, vertex_positions, vertex_positions.length / vertex_positions_stride, vertex_positions_stride * 4);
    },
    extractMeshlet: function(buffers, index) {
      assert(index >= 0 && index < buffers.meshletCount);
      return extractMeshlet(buffers, index);
    }
  };
})();

// viewer/src/gltf-loader.js
var io = new WebIO().registerExtensions([EXTMeshFeatures, EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
async function loadGltf(url, options = {}) {
  await MeshoptDecoder.ready;
  const response = await fetch(url, { cache: options.fetchCache || "default" });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const document2 = await io.readBinary(bytes);
  const primitives = [];
  const componentFeatures = options.componentFeatures || /* @__PURE__ */ new Map();
  function visit(node, inheritedDesignator = "") {
    const designator = componentFeatures.has(node.getName()) ? node.getName() : inheritedDesignator;
    const mesh = node.getMesh();
    if (mesh) {
      const matrix = node.getWorldMatrix();
      for (const primitive of mesh.listPrimitives()) {
        const positionAccessor = primitive.getAttribute("POSITION");
        const normalAccessor = primitive.getAttribute("NORMAL");
        const netAccessor = primitive.getAttribute("_FEATURE_ID_0");
        const objectAccessor = primitive.getAttribute("_FEATURE_ID_1");
        const indices = primitive.getIndices()?.getArray();
        if (!positionAccessor || !indices) continue;
        const count = positionAccessor.getCount();
        const position = new Float32Array(count * 3);
        const normal = new Float32Array(count * 3);
        const netId = new Uint32Array(count);
        const objectFeatureId = new Uint32Array(count);
        const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        const value = [];
        const featureId = componentFeatures.get(designator)?.featureId || options.defaultFeatureId || 0;
        for (let index = 0; index < count; index += 1) {
          positionAccessor.getElement(index, value);
          transformPoint(position, index * 3, value, matrix);
          bounds[0] = Math.min(bounds[0], position[index * 3]);
          bounds[1] = Math.min(bounds[1], position[index * 3 + 1]);
          bounds[2] = Math.min(bounds[2], position[index * 3 + 2]);
          bounds[3] = Math.max(bounds[3], position[index * 3]);
          bounds[4] = Math.max(bounds[4], position[index * 3 + 1]);
          bounds[5] = Math.max(bounds[5], position[index * 3 + 2]);
          if (normalAccessor) {
            normalAccessor.getElement(index, value);
            transformNormal(normal, index * 3, value, matrix);
          } else {
            normal.set([0, 0, 1], index * 3);
          }
          netId[index] = Number(netAccessor?.getScalar(index) || 0);
          objectFeatureId[index] = objectAccessor ? Number(objectAccessor.getScalar(index) || 0) : Number(featureId);
        }
        const material = primitive.getMaterial();
        primitives.push({
          position,
          normal,
          netId,
          objectFeatureId,
          indices,
          designator,
          nodeName: node.getName(),
          meshName: mesh.getName(),
          bounds,
          material: material ? {
            name: material.getName(),
            baseColor: material.getBaseColorFactor(),
            metallic: material.getMetallicFactor(),
            roughness: material.getRoughnessFactor(),
            emissive: material.getEmissiveFactor()
          } : { baseColor: options.baseColor || [0.55, 0.58, 0.64, 1], metallic: 0.05, roughness: 0.72, emissive: [0, 0, 0] }
        });
      }
    }
    for (const child of node.listChildren()) visit(child, designator);
  }
  for (const scene2 of document2.getRoot().listScenes()) {
    for (const child of scene2.listChildren()) visit(child);
  }
  return { byteLength: bytes.byteLength, primitives };
}
function transformPoint(output, offset, point, matrix) {
  const x = matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12];
  const y = matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13];
  const z = matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14];
  output[offset] = x;
  output[offset + 1] = -z;
  output[offset + 2] = y;
}
function transformNormal(output, offset, normal, matrix) {
  const x = matrix[0] * normal[0] + matrix[4] * normal[1] + matrix[8] * normal[2];
  const y = matrix[1] * normal[0] + matrix[5] * normal[1] + matrix[9] * normal[2];
  const z = matrix[2] * normal[0] + matrix[6] * normal[1] + matrix[10] * normal[2];
  const size = Math.hypot(x, y, z) || 1;
  output[offset] = x / size;
  output[offset + 1] = -z / size;
  output[offset + 2] = y / size;
}

// viewer/src/renderer.js
var VERTEX_STRIDE = 40;
var DRAW_UNIFORM_SIZE = 256;
var GLOBAL_UNIFORM_SIZE = 112;
var MAIN_SHADER = `
struct Globals {
  viewProjection: mat4x4f,
  activeNet: u32,
  selectedLayer: u32,
  time: f32,
  hasHighlight: f32,
  selectedFeature: u32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
  lightDirection: vec4f,
};
struct Draw {
  color: vec4f,
  material: vec4f,
  offset: vec4f,
  flags: vec4f,
};
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<uniform> draw: Draw;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) netId: u32,
  @location(3) objectId: u32,
  @location(4) layerId: u32,
  @location(5) materialId: u32,
};
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) @interpolate(flat) netId: u32,
  @location(2) @interpolate(flat) objectId: u32,
  @location(3) world: vec3f,
};
@vertex fn vs(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.world = input.position + draw.offset.xyz;
  output.position = globals.viewProjection * vec4f(output.world, 1.0);
  output.normal = normalize(input.normal);
  output.netId = input.netId;
  output.objectId = input.objectId;
  return output;
}
fn aces(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3f(0), vec3f(1));
}
@fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
  let kind = u32(draw.flags.x);
  let copper = kind == 1u;
  let component = kind == 2u;
  let selected = globals.activeNet != 0u && input.netId == globals.activeNet;
  let selectedComponent = component && globals.selectedFeature != 0u && input.objectId == globals.selectedFeature;
  var base = draw.color.rgb;
  if (selected && copper) {
    let pulse = 0.88 + 0.12 * sin(globals.time * 3.2);
    base = vec3f(0.08, 1.0, 0.2) * pulse;
  } else if (globals.hasHighlight > 0.5 && copper) {
    base = mix(base, vec3f(0.12, 0.14, 0.17), 0.58);
  }
  if (selectedComponent) {
    let pulse = 0.84 + 0.16 * sin(globals.time * 3.6);
    base = mix(base, vec3f(0.15, 0.72, 1.0) * pulse, 0.72);
  }
  if (draw.flags.z > 0.5 && copper && !selected) { discard; }
  let normal = normalize(input.normal);
  let light = normalize(globals.lightDirection.xyz);
  let diffuse = max(dot(normal, light), 0.0);
  let hemi = mix(0.28, 0.62, normal.z * 0.5 + 0.5);
  let roughness = clamp(draw.material.y, 0.05, 1.0);
  let metallic = clamp(draw.material.x, 0.0, 1.0);
  let specular = pow(max(dot(normal, normalize(light + vec3f(0.3, -0.4, 0.85))), 0.0), mix(96.0, 6.0, roughness));
  let shaded = base * (hemi + diffuse * 0.72) + mix(vec3f(0.04), base, metallic) * specular * 0.5;
  var lit = select(shaded, base, draw.flags.w > 0.5);
  return vec4f(aces(lit), draw.flags.y);
}
`;
var PICK_SHADER = `
struct Globals {
  viewProjection: mat4x4f,
  activeNet: u32,
  selectedLayer: u32,
  time: f32,
  hasHighlight: f32,
  selectedFeature: u32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
  lightDirection: vec4f,
};
struct Draw { color: vec4f, material: vec4f, offset: vec4f, flags: vec4f };
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<uniform> draw: Draw;
struct Input {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) netId: u32,
  @location(3) objectId: u32,
  @location(4) layerId: u32,
  @location(5) materialId: u32,
};
struct Output {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) objectId: u32,
};
@vertex fn vs(input: Input) -> Output {
  var output: Output;
  output.position = globals.viewProjection * vec4f(input.position + draw.offset.xyz, 1.0);
  output.objectId = input.objectId;
  return output;
}
@fragment fn fs(input: Output) -> @location(0) u32 { return input.objectId; }
`;
var BARREL_SHADER = `
struct Globals {
  viewProjection: mat4x4f,
  activeNet: u32,
  selectedLayer: u32,
  time: f32,
  hasHighlight: f32,
  selectedFeature: u32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
  lightDirection: vec4f,
};
struct Draw { color: vec4f, material: vec4f, offset: vec4f, flags: vec4f };
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<uniform> draw: Draw;
@group(0) @binding(2) var<storage, read> layerOffsets: array<f32>;
struct Input {
  @location(0) unit: vec3f,
  @location(1) normal: vec3f,
  @location(2) radiusMix: f32,
  @location(3) dimensions: vec4f,
  @location(4) span: vec2f,
  @location(5) ids: vec4u,
};
struct Output {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) @interpolate(flat) netId: u32,
  @location(2) @interpolate(flat) objectId: u32,
  @location(3) @interpolate(flat) visible: u32,
};
@vertex fn vs(input: Input) -> Output {
  let radius = mix(input.dimensions.z, input.dimensions.w, input.radiusMix);
  let z0 = input.span.x + layerOffsets[input.ids.z];
  let z1 = input.span.y + layerOffsets[input.ids.w];
  let world = vec3f(
    input.dimensions.x + input.unit.x * radius,
    input.dimensions.y + input.unit.y * radius,
    mix(z0, z1, input.unit.z)
  );
  var output: Output;
  output.position = globals.viewProjection * vec4f(world, 1.0);
  output.normal = input.normal;
  output.netId = input.ids.x;
  output.objectId = input.ids.y;
  output.visible = select(0u, 1u, globals.selectedLayer == 0u || (globals.selectedLayer >= input.ids.z && globals.selectedLayer <= input.ids.w));
  return output;
}
@fragment fn fs(input: Output) -> @location(0) vec4f {
  if (input.visible == 0u) { discard; }
  let selected = globals.activeNet != 0u && input.netId == globals.activeNet;
  var base = draw.color.rgb;
  if (selected) {
    base = vec3f(0.1, 1.0, 0.22) * (0.88 + 0.12 * sin(globals.time * 3.2));
  } else if (globals.hasHighlight > 0.5) {
    base = mix(base, vec3f(0.12, 0.14, 0.17), 0.58);
  }
  if (draw.flags.z > 0.5 && !selected) { discard; }
  let light = normalize(globals.lightDirection.xyz);
  let lit = base * (0.38 + max(dot(normalize(input.normal), light), 0.0) * 0.72);
  return vec4f(lit, 1.0);
}
`;
var BARREL_PICK_SHADER = `
struct Globals {
  viewProjection: mat4x4f,
  activeNet: u32,
  selectedLayer: u32,
  time: f32,
  hasHighlight: f32,
  selectedFeature: u32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
  lightDirection: vec4f,
};
struct Draw { color: vec4f, material: vec4f, offset: vec4f, flags: vec4f };
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<uniform> draw: Draw;
@group(0) @binding(2) var<storage, read> layerOffsets: array<f32>;
struct Input {
  @location(0) unit: vec3f,
  @location(1) normal: vec3f,
  @location(2) radiusMix: f32,
  @location(3) dimensions: vec4f,
  @location(4) span: vec2f,
  @location(5) ids: vec4u,
};
struct Output {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) objectId: u32,
  @location(1) @interpolate(flat) visible: u32,
};
@vertex fn vs(input: Input) -> Output {
  let radius = mix(input.dimensions.z, input.dimensions.w, input.radiusMix);
  let world = vec3f(
    input.dimensions.x + input.unit.x * radius,
    input.dimensions.y + input.unit.y * radius,
    mix(input.span.x + layerOffsets[input.ids.z], input.span.y + layerOffsets[input.ids.w], input.unit.z)
  );
  var output: Output;
  output.position = globals.viewProjection * vec4f(world, 1.0);
  output.objectId = input.ids.y;
  output.visible = select(0u, 1u, globals.selectedLayer == 0u || (globals.selectedLayer >= input.ids.z && globals.selectedLayer <= input.ids.w));
  return output;
}
@fragment fn fs(input: Output) -> @location(0) u32 {
  if (input.visible == 0u) { discard; }
  return input.objectId;
}
`;
var Renderer = class _Renderer {
  static async create(canvas2) {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable in this browser");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice();
    return new _Renderer(canvas2, device);
  }
  constructor(canvas2, device) {
    this.canvas = canvas2;
    this.device = device;
    device.addEventListener("uncapturederror", (event) => {
      console.error(`Uncaptured WebGPU error: ${event.error?.message || event.error}`);
    });
    device.lost.then((info) => {
      console.error(`WebGPU device lost: ${info.reason}`, info.message);
    });
    this.context = canvas2.getContext("webgpu");
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });
    this.entries = [];
    this.barrels = null;
    this.globalBuffer = device.createBuffer({ size: GLOBAL_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layerOffsetBuffer = device.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }
      ]
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
    const vertexBuffers = [{
      arrayStride: VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
        { shaderLocation: 2, offset: 24, format: "uint32" },
        { shaderLocation: 3, offset: 28, format: "uint32" },
        { shaderLocation: 4, offset: 32, format: "uint32" },
        { shaderLocation: 5, offset: 36, format: "uint32" }
      ]
    }];
    this.pipeline = this.makePipeline(layout, MAIN_SHADER, this.format, vertexBuffers);
    this.pickPipeline = this.makePipeline(layout, PICK_SHADER, "r32uint", vertexBuffers);
    this.barrelPipeline = this.makeBarrelPipeline(layout, BARREL_SHADER, this.format);
    this.barrelPickPipeline = this.makeBarrelPipeline(layout, BARREL_PICK_SHADER, "r32uint");
    this.depth = null;
    this.pickTexture = null;
    this.pickSerial = Promise.resolve();
    this.bundleCache = /* @__PURE__ */ new Map();
    this.globalScratch = new ArrayBuffer(GLOBAL_UNIFORM_SIZE);
    this.globalScratchF32 = new Float32Array(this.globalScratch);
    this.globalScratchView = new DataView(this.globalScratch);
    this.drawScratch = new Float32Array(DRAW_UNIFORM_SIZE / 4);
    this.barrelDrawScratch = new Float32Array(DRAW_UNIFORM_SIZE / 4);
    this.nextEntryId = 1;
  }
  makePipeline(layout, code, format, buffers) {
    const module = this.device.createShaderModule({ code });
    return this.device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: "vs", buffers },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format,
          blend: format === "r32uint" ? void 0 : {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
          }
        }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: 1 }
    });
  }
  makeBarrelPipeline(layout, code, format) {
    const module = this.device.createShaderModule({ code });
    return this.device.createRenderPipeline({
      layout,
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 28,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32" }
            ]
          },
          {
            arrayStride: 40,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 3, offset: 0, format: "float32x4" },
              { shaderLocation: 4, offset: 16, format: "float32x2" },
              { shaderLocation: 5, offset: 24, format: "uint32x4" }
            ]
          }
        ]
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format,
          blend: format === "r32uint" ? void 0 : {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
          }
        }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" }
    });
  }
  resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.depth?.destroy();
    this.pickTexture?.destroy();
    this.depth = this.device.createTexture({ size: [width, height], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.pickTexture = this.device.createTexture({ size: [width, height], format: "r32uint", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  }
  addPrimitive(primitive, metadata) {
    const count = primitive.position.length / 3;
    const vertices = new ArrayBuffer(count * VERTEX_STRIDE);
    const vertexF32 = new Float32Array(vertices);
    const vertexU32 = new Uint32Array(vertices);
    for (let index = 0; index < count; index += 1) {
      const word = index * 10;
      const source = index * 3;
      vertexF32[word] = primitive.position[source];
      vertexF32[word + 1] = primitive.position[source + 1];
      vertexF32[word + 2] = primitive.position[source + 2];
      vertexF32[word + 3] = primitive.normal[source];
      vertexF32[word + 4] = primitive.normal[source + 1];
      vertexF32[word + 5] = primitive.normal[source + 2];
      vertexU32[word + 6] = primitive.netId[index] || 0;
      vertexU32[word + 7] = primitive.objectFeatureId[index] || 0;
      vertexU32[word + 8] = metadata.layerId || 0;
      vertexU32[word + 9] = metadata.materialId || 0;
    }
    const vertexBuffer = this.device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vertexBuffer, 0, vertices);
    const indices = primitive.indices instanceof Uint32Array ? primitive.indices : new Uint32Array(primitive.indices);
    const indexBuffer = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(indexBuffer, 0, indices);
    const drawBuffer = this.device.createBuffer({ size: DRAW_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.globalBuffer } },
        { binding: 1, resource: { buffer: drawBuffer } },
        { binding: 2, resource: { buffer: this.layerOffsetBuffer } }
      ]
    });
    const entry = {
      ...metadata,
      bounds: primitive.bounds || metadata.bounds || null,
      id: this.nextEntryId++,
      vertexBuffer,
      indexBuffer,
      indexCount: indices.length,
      drawBuffer,
      bindGroup
    };
    this.entries.push(entry);
    this.bundleCache.clear();
    return entry;
  }
  removeEntries(entries) {
    if (!entries?.length) return;
    const removeIds = new Set(entries.map((entry) => entry.id));
    for (const entry of entries) {
      entry.vertexBuffer?.destroy?.();
      entry.indexBuffer?.destroy?.();
      entry.drawBuffer?.destroy?.();
    }
    this.entries = this.entries.filter((entry) => !removeIds.has(entry.id));
    this.bundleCache.clear();
  }
  setBarrels(records) {
    if (!records?.length) return;
    const segments = 20;
    const vertices = [];
    const indices = [];
    for (const inner of [0, 1]) {
      const base = vertices.length / 7;
      for (let index = 0; index < segments; index += 1) {
        const angle = Math.PI * 2 * index / segments;
        const x = Math.cos(angle);
        const y = Math.sin(angle);
        for (const t of [0, 1]) vertices.push(x, y, t, inner ? -x : x, inner ? -y : y, 0, inner);
      }
      for (let index = 0; index < segments; index += 1) {
        const next = (index + 1) % segments;
        const a = base + index * 2;
        const b = base + next * 2;
        indices.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
    const vertexArray = new Float32Array(vertices);
    const indexArray = new Uint16Array(indices);
    const instances = new ArrayBuffer(records.length * 40);
    const view = new DataView(instances);
    records.forEach((record, index) => {
      const offset = index * 40;
      view.setFloat32(offset, record.centerMm[0] / 1e3, true);
      view.setFloat32(offset + 4, -record.centerMm[1] / 1e3, true);
      view.setFloat32(offset + 8, Math.min(record.drillWidthMm, record.drillHeightMm) / 2e3, true);
      view.setFloat32(offset + 12, Math.max(record.outerWidthMm, record.outerHeightMm) / 2e3, true);
      view.setFloat32(offset + 16, record.startZMm / 1e3, true);
      view.setFloat32(offset + 20, record.endZMm / 1e3, true);
      view.setUint32(offset + 24, record.netId || 0, true);
      view.setUint32(offset + 28, record.objectFeatureId || 0, true);
      view.setUint32(offset + 32, record.startLayerId || 0, true);
      view.setUint32(offset + 36, record.endLayerId || 0, true);
    });
    const vertexBuffer = this.device.createBuffer({ size: vertexArray.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const indexBuffer = this.device.createBuffer({ size: indexArray.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    const instanceBuffer = this.device.createBuffer({ size: instances.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vertexBuffer, 0, vertexArray);
    this.device.queue.writeBuffer(indexBuffer, 0, indexArray);
    this.device.queue.writeBuffer(instanceBuffer, 0, instances);
    const drawBuffer = this.device.createBuffer({ size: DRAW_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.globalBuffer } },
        { binding: 1, resource: { buffer: drawBuffer } },
        { binding: 2, resource: { buffer: this.layerOffsetBuffer } }
      ]
    });
    this.barrels = { records, vertexBuffer, indexBuffer, instanceBuffer, indexCount: indexArray.length, instanceCount: records.length, drawBuffer, bindGroup };
  }
  render({
    panels,
    activeNetId,
    selectedFeatureId,
    time,
    layerOffsets,
    visibleLayers,
    showBoard,
    showComponents,
    componentOpacity,
    boardOpacity,
    isolateNet,
    compareMode = false,
    compareOffsets: compareOffsets2 = /* @__PURE__ */ new Map(),
    layerAlphas = null,
    visibleTileIds = null
  }) {
    this.resize();
    this.device.queue.writeBuffer(this.layerOffsetBuffer, 0, layerOffsets);
    const targetView = this.context.getCurrentTexture().createView();
    panels.forEach((panel2, panelIndex) => {
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: targetView,
          clearValue: { r: 0.91, g: 0.93, b: 0.94, a: 1 },
          loadOp: panelIndex === 0 ? "clear" : "load",
          storeOp: "store"
        }],
        depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" }
      });
      const viewport = clampViewport(panel2.viewport, this.canvas.width, this.canvas.height);
      pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
      pass.setScissorRect(viewport.x, viewport.y, viewport.width, viewport.height);
      this.writeGlobals(panel2.matrix, activeNetId, panel2.layerId, time, selectedFeatureId);
      const visibleEntries = this.entries.filter((entry) => this.visible(entry, panel2.layerId, visibleLayers, showBoard, showComponents, componentOpacity, compareMode, visibleTileIds));
      for (const entry of visibleEntries) {
        this.writeDraw(
          entry,
          activeNetId,
          componentOpacity,
          boardOpacity,
          isolateNet,
          compareMode,
          compareOffsets2.get(entry.layerId),
          layerAlphas?.get(entry.layerId) ?? 1
        );
      }
      if (visibleEntries.length > 64) {
        pass.executeBundles([this.renderBundle(visibleEntries, panel2.layerId)]);
      } else {
        pass.setPipeline(this.pipeline);
        for (const entry of visibleEntries) {
          pass.setBindGroup(0, entry.bindGroup);
          pass.setVertexBuffer(0, entry.vertexBuffer);
          pass.setIndexBuffer(entry.indexBuffer, "uint32");
          pass.drawIndexed(entry.indexCount);
        }
      }
      if (!compareMode && this.barrels && (panel2.layerId === 0 || visibleLayers.has(panel2.layerId))) {
        this.writeBarrelDraw(isolateNet);
        pass.setPipeline(this.barrelPipeline);
        pass.setBindGroup(0, this.barrels.bindGroup);
        pass.setVertexBuffer(0, this.barrels.vertexBuffer);
        pass.setVertexBuffer(1, this.barrels.instanceBuffer);
        pass.setIndexBuffer(this.barrels.indexBuffer, "uint16");
        pass.drawIndexed(this.barrels.indexCount, this.barrels.instanceCount);
      }
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    });
  }
  visible(entry, panelLayer, visibleLayers, showBoard, showComponents, componentOpacity, compareMode = false, visibleTileIds = null) {
    if (entry.kind === "board" && entry.boardRole === "pad") return false;
    if (!compareMode && entry.kind === "copper" && visibleTileIds && !visibleTileIds.has(entry.tileId)) return false;
    if (compareMode) return entry.kind === "copper" && visibleLayers.has(entry.layerId);
    if (entry.kind === "board") return panelLayer === 0 && showBoard;
    if (entry.kind === "component") return panelLayer === 0 && showComponents && componentOpacity > 1e-3;
    return panelLayer ? entry.layerId === panelLayer : visibleLayers.has(entry.layerId);
  }
  writeGlobals(matrix, activeNetId, selectedLayer, time, selectedFeatureId = 0) {
    const data = this.globalScratch;
    const floats = this.globalScratchF32;
    floats.fill(0);
    floats.set(matrix, 0);
    const view = this.globalScratchView;
    view.setUint32(64, activeNetId || 0, true);
    view.setUint32(68, selectedLayer || 0, true);
    view.setFloat32(72, time, true);
    view.setFloat32(76, activeNetId ? 1 : 0, true);
    view.setUint32(80, selectedFeatureId || 0, true);
    floats.set([0.35, -0.5, 0.8, 0], 24);
    this.device.queue.writeBuffer(this.globalBuffer, 0, data);
  }
  writeDraw(entry, activeNetId, componentOpacity, boardOpacity = 1, isolateNet = false, compareMode = false, compareOffset = null, layerAlpha = 1) {
    const data = this.drawScratch;
    data.fill(0);
    const color = entry.kind === "copper" ? entry.color : entry.material.baseColor;
    data.set(color, 0);
    data.set([entry.material.metallic || 0, entry.material.roughness ?? 0.72, 0, 0], 4);
    const boardOverlayOffset = boardContextOffset(entry);
    data.set([
      compareOffset?.[0] || 0,
      compareOffset?.[1] || 0,
      (compareMode ? -(entry.baseZ || 0) : entry.layerOffset || 0) + boardOverlayOffset,
      0
    ], 8);
    const materialAlpha = Number.isFinite(color?.[3]) ? color[3] : 1;
    const opacity = entry.kind === "component" ? componentOpacity : entry.kind === "board" ? boardOpacity * boardRoleOpacity(entry, materialAlpha) : layerAlpha;
    const kind = entry.kind === "copper" ? 1 : entry.kind === "component" ? 2 : 0;
    data.set([kind, opacity, isolateNet ? 1 : 0, compareMode ? 1 : 0], 12);
    this.device.queue.writeBuffer(entry.drawBuffer, 0, data);
  }
  writeBarrelDraw(isolateNet = false) {
    const data = this.barrelDrawScratch;
    data.fill(0);
    data.set([0.55, 0.35, 0.16, 0.78], 0);
    data.set([0.75, 0.32, 0, 0], 4);
    data.set([1, 1, isolateNet ? 1 : 0, 0], 12);
    this.device.queue.writeBuffer(this.barrels.drawBuffer, 0, data);
  }
  renderBundle(entries, panelLayerId) {
    const key = `${panelLayerId}:${entries.map((entry) => entry.id).join(",")}`;
    const cached = this.bundleCache.get(key);
    if (cached) return cached;
    const encoder = this.device.createRenderBundleEncoder({
      colorFormats: [this.format],
      depthStencilFormat: "depth24plus"
    });
    encoder.setPipeline(this.pipeline);
    for (const entry of entries) {
      encoder.setBindGroup(0, entry.bindGroup);
      encoder.setVertexBuffer(0, entry.vertexBuffer);
      encoder.setIndexBuffer(entry.indexBuffer, "uint32");
      encoder.drawIndexed(entry.indexCount);
    }
    const bundle = encoder.finish();
    this.bundleCache.set(key, bundle);
    if (this.bundleCache.size > 32) this.bundleCache.delete(this.bundleCache.keys().next().value);
    return bundle;
  }
  pick(panel2, x, y, options) {
    const operation = this.pickSerial.then(() => this.performPick(panel2, x, y, options));
    this.pickSerial = operation.catch(() => 0);
    return operation;
  }
  async performPick(panel2, x, y, options) {
    this.resize();
    const pixelX = Math.max(0, Math.min(this.canvas.width - 1, Math.floor(x)));
    const pixelY = Math.max(0, Math.min(this.canvas.height - 1, Math.floor(y)));
    this.writeGlobals(
      panel2.matrix,
      options.activeNetId,
      panel2.layerId,
      performance.now() / 1e3,
      options.selectedFeatureId
    );
    this.device.queue.writeBuffer(this.layerOffsetBuffer, 0, options.layerOffsets);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.pickTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" }
    });
    const viewport = clampViewport(panel2.viewport, this.canvas.width, this.canvas.height);
    pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
    pass.setScissorRect(viewport.x, viewport.y, viewport.width, viewport.height);
    pass.setPipeline(this.pickPipeline);
    for (const entry of this.entries) {
      if (!this.visible(
        entry,
        panel2.layerId,
        options.visibleLayers,
        options.showBoard,
        options.showComponents,
        options.componentOpacity,
        options.compareMode,
        options.visibleTileIds
      )) continue;
      if (entry.kind === "board") continue;
      this.writeDraw(
        entry,
        options.activeNetId,
        options.componentOpacity,
        options.boardOpacity,
        options.isolateNet,
        options.compareMode,
        options.compareOffsets?.get(entry.layerId)
      );
      pass.setBindGroup(0, entry.bindGroup);
      pass.setVertexBuffer(0, entry.vertexBuffer);
      pass.setIndexBuffer(entry.indexBuffer, "uint32");
      pass.drawIndexed(entry.indexCount);
    }
    if (!options.compareMode && this.barrels) {
      this.writeBarrelDraw(options.isolateNet);
      pass.setPipeline(this.barrelPickPipeline);
      pass.setBindGroup(0, this.barrels.bindGroup);
      pass.setVertexBuffer(0, this.barrels.vertexBuffer);
      pass.setVertexBuffer(1, this.barrels.instanceBuffer);
      pass.setIndexBuffer(this.barrels.indexBuffer, "uint16");
      pass.drawIndexed(this.barrels.indexCount, this.barrels.instanceCount);
    }
    pass.end();
    const readBuffer = this.device.createBuffer({
      label: "pick-readback",
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    encoder.copyTextureToBuffer(
      { texture: this.pickTexture, origin: { x: pixelX, y: pixelY } },
      { buffer: readBuffer, bytesPerRow: 256 },
      { width: 1, height: 1 }
    );
    this.device.queue.submit([encoder.finish()]);
    try {
      await readBuffer.mapAsync(GPUMapMode.READ);
      const value = new DataView(readBuffer.getMappedRange()).getUint32(0, true);
      readBuffer.unmap();
      return value;
    } finally {
      if (readBuffer.mapState === "mapped") readBuffer.unmap();
      readBuffer.destroy();
    }
  }
};
function boardRoleOpacity(entry, materialAlpha) {
  if (entry.kind !== "board") return 1;
  if (entry.boardRole === "substrate") return 1;
  if (entry.boardRole === "soldermask") return Math.min(materialAlpha, 0.72);
  if (entry.boardRole === "silkscreen") return Math.min(materialAlpha, 0.92);
  return materialAlpha;
}
function boardContextOffset(entry) {
  if (entry.kind !== "board") return 0;
  if (entry.boardRole !== "soldermask" && entry.boardRole !== "silkscreen") return 0;
  const bounds = entry.bounds;
  const centerZ = bounds ? (bounds[2] + bounds[5]) * 0.5 : 0;
  const direction = centerZ < 0 ? -1 : 1;
  const roleOffset = entry.boardRole === "silkscreen" ? 35e-6 : 18e-6;
  return direction * roleOffset;
}
function clampViewport(viewport, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.floor(viewport.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(viewport.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.floor(viewport.width))),
    height: Math.max(1, Math.min(height - y, Math.floor(viewport.height)))
  };
}

// viewer/src/schematic-world-renderer.js
var PAGE_SHADER = `
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
  let nativeDetail = page.flags.w > 0.5;
  if (edge < 0.006) {
    if (containsNet) { return vec4f(0.12, 0.92, 0.35, 1.0); }
    if (selected) { return vec4f(0.12, 0.45, 0.95, 1.0); }
    return vec4f(0.28, 0.32, 0.39, 1.0);
  }
  if (nativeDetail) {
    return vec4f(0.925, 0.918, 0.865, 1.0);
  }
  let dim = select(1.0, select(0.42, 1.0, containsNet), hasActiveNet);
  return vec4f(sampled.rgb * dim, 1.0);
}`;
var EDGE_SHADER = `
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
var HIGHLIGHT_SHADER = `
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
var NET_FLOW_SHADER = `
struct Globals {
  camera: vec4f,
  viewport: vec2f,
  activeNet: u32,
  _pad: u32,
};
@group(0) @binding(0) var<uniform> globals: Globals;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) distance: f32,
  @location(1) kind: f32,
};
@vertex fn vs(@location(0) world: vec2f, @location(1) flow: vec2f) -> Out {
  let halfViewport = globals.viewport * globals.camera.z * 0.5;
  let clip = vec2f(
    (world.x - globals.camera.x) / halfViewport.x,
    -(world.y - globals.camera.y) / halfViewport.y
  );
  var out: Out;
  out.position = vec4f(clip, 0.05, 1.0);
  out.distance = flow.x;
  out.kind = flow.y;
  return out;
}
@fragment fn fs(input: Out) -> @location(0) vec4f {
  let selected = input.kind > 1.5;
  let intersheet = input.kind > 0.5 && !selected;
  let speed = select(0.62, 0.88, intersheet || selected);
  let period = select(18.0, 28.0, intersheet || selected);
  let phase = fract(input.distance / period - globals.camera.w * speed);
  let dash = smoothstep(0.04, 0.13, phase) * (1.0 - smoothstep(0.38, 0.52, phase));
  let intraBase = vec3f(0.94, 0.48, 0.12);
  let intraDash = vec3f(1.0, 0.86, 0.24);
  let interBase = vec3f(0.10, 0.46, 0.92);
  let interDash = vec3f(0.42, 0.82, 1.0);
  let selectedBase = vec3f(0.08, 1.0, 0.34);
  let selectedDash = vec3f(0.86, 1.0, 0.72);
  let base = select(select(intraBase, interBase, intersheet), selectedBase, selected);
  let bright = select(select(intraDash, interDash, intersheet), selectedDash, selected);
  let color = base + (bright - base) * dash;
  let alpha = select(select(0.24, 0.30, intersheet) + dash * 0.54, 0.44 + dash * 0.50, selected);
  return vec4f(color, alpha);
}`;
var VECTOR_SHADER = `
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
var IMAGE_SHADER = `
struct Globals {
  camera: vec4f,
  viewport: vec2f,
  activeNet: u32,
  _pad: u32,
};
struct ImageQuad {
  originSize: vec4f,
  flags: vec4f,
};
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<uniform> imageQuad: ImageQuad;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var imageTexture: texture_2d<f32>;

struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) index: u32) -> Out {
  var positions = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0)
  );
  let uv = positions[index];
  let world = imageQuad.originSize.xy + uv * imageQuad.originSize.zw;
  let halfViewport = globals.viewport * globals.camera.z * 0.5;
  let clip = vec2f(
    (world.x - globals.camera.x) / halfViewport.x,
    -(world.y - globals.camera.y) / halfViewport.y
  );
  var out: Out;
  out.position = vec4f(clip, 0.08, 1.0);
  out.uv = uv;
  return out;
}

@fragment fn fs(input: Out) -> @location(0) vec4f {
  return textureSample(imageTexture, imageSampler, input.uv);
}`;
var PICK_SHADER2 = `
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
var NATIVE_DETAIL_BASE_ENTER_PX_PER_MM = 6.2;
var NATIVE_DETAIL_BASE_EXIT_PX_PER_MM = 4.6;
var NATIVE_DETAIL_BASE_PREFETCH_PX_PER_MM = 3.8;
var MAX_VECTOR_FLOATS = 4 * 1024 * 1024;
var MAX_VECTOR_VERTICES = Math.floor(MAX_VECTOR_FLOATS / 6);
var MAX_VECTOR_DRAW_FLOATS = MAX_VECTOR_VERTICES * 6;
var MAX_PICK_VERTICES = 512 * 1024;
var MAX_NET_FLOW_FLOATS = 512 * 1024;
var MAX_NET_TRACKING_ANCHORS_PER_PAGE = 96;
var MAX_NET_TRACKING_PAGES = 96;
var VECTOR_TILE_SIZE_MM = 18;
var MAX_RESIDENT_VECTOR_BYTES = 96 * 1024 * 1024;
var MAX_CONCURRENT_VECTOR_LOADS = 2;
var SchematicWorldRenderer = class _SchematicWorldRenderer {
  static async create(canvas2, manifestUrl) {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable in this browser");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice();
    const response = await fetch(manifestUrl, { cache: "default" });
    if (!response.ok) throw new Error(`Failed to load schematic manifest: ${response.status}`);
    const manifest = await response.json();
    if (!["prism.schematic_world_a0", "prism.schematic_vector_a0"].includes(manifest.schema)) {
      throw new Error(`Unsupported schematic scene schema: ${manifest.schema}`);
    }
    const featurePath = manifest.featureTable || manifest.features;
    const featureResponse = await fetch(new URL(featurePath, manifestUrl), { cache: "default" });
    if (!featureResponse.ok) throw new Error(`Failed to load schematic features: ${featureResponse.status}`);
    const features = normalizeFeatureTable(await featureResponse.json());
    return new _SchematicWorldRenderer(canvas2, device, manifestUrl, manifest, features);
  }
  constructor(canvas2, device, manifestUrl, manifest, featuresByPage) {
    this.canvas = canvas2;
    this.device = device;
    this.manifestUrl = manifestUrl;
    this.manifest = manifest;
    this.isNativeScene = manifest.schema === "prism.schematic_vector_a0";
    this.pages = manifest.pages || [];
    this.featuresByPage = featuresByPage;
    this.featuresById = /* @__PURE__ */ new Map();
    for (const items of Object.values(featuresByPage)) {
      for (const feature of items) this.featuresById.set(Number(feature.id), feature);
    }
    this.context = canvas2.getContext("webgpu");
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });
    this.flowCanvas = null;
    this.flowContext = null;
    this.globalBuffer = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
      ]
    });
    const pageModule = device.createShaderModule({ code: PAGE_SHADER });
    this.pagePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: pageModule, entryPoint: "vs" },
      fragment: { module: pageModule, entryPoint: "fs", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" }
    });
    this.edgeLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }]
    });
    const edgeModule = device.createShaderModule({ code: EDGE_SHADER });
    this.edgePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.edgeLayout] }),
      vertex: {
        module: edgeModule,
        entryPoint: "vs",
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }]
      },
      fragment: {
        module: edgeModule,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
          }
        }]
      },
      primitive: { topology: "line-list" }
    });
    this.edgeBindGroup = device.createBindGroup({
      layout: this.edgeLayout,
      entries: [{ binding: 0, resource: { buffer: this.globalBuffer } }]
    });
    const highlightModule = device.createShaderModule({ code: HIGHLIGHT_SHADER });
    this.highlightPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.edgeLayout] }),
      vertex: {
        module: highlightModule,
        entryPoint: "vs",
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }]
      },
      fragment: {
        module: highlightModule,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
          }
        }]
      },
      primitive: { topology: "line-list" }
    });
    this.highlightBufferSize = 4 * 1024 * 1024;
    this.highlightBuffer = device.createBuffer({
      size: this.highlightBufferSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    const netFlowModule = device.createShaderModule({ code: NET_FLOW_SHADER });
    this.netFlowPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.edgeLayout] }),
      vertex: {
        module: netFlowModule,
        entryPoint: "vs",
        buffers: [{
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" }
          ]
        }]
      },
      fragment: {
        module: netFlowModule,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
          }
        }]
      },
      primitive: { topology: "triangle-list" }
    });
    this.netFlowBuffer = device.createBuffer({
      size: MAX_NET_FLOW_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.globalUniformScratch = new Float32Array(12);
    this.pageUniformScratch = new Float32Array(8);
    this.imageUniformScratch = new Float32Array(8);
    this.vectorScratch = new Float32Array(MAX_VECTOR_FLOATS);
    this.highlightScratch = new Float32Array(this.highlightBufferSize / 4);
    this.netFlowScratch = new Float32Array(MAX_NET_FLOW_FLOATS);
    this.netTrackingCache = null;
    this.selectedIntrasheetLinkIndex = -1;
    this.truncatedHighlightCount = 0;
    this.truncatedVectorCount = 0;
    this.frameSerial = 0;
    this.querySerial = 0;
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
            { shaderLocation: 1, offset: 8, format: "float32x4" }
          ]
        }]
      },
      fragment: {
        module: vectorModule,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
          }
        }]
      },
      primitive: { topology: "triangle-list" }
    });
    this.vectorBuffer = device.createBuffer({
      size: MAX_VECTOR_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.vectorBuffers = [this.vectorBuffer];
    const imageModule = device.createShaderModule({ code: IMAGE_SHADER });
    this.imagePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: imageModule, entryPoint: "vs" },
      fragment: {
        module: imageModule,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
          }
        }]
      },
      primitive: { topology: "triangle-list" }
    });
    const pickModule = device.createShaderModule({ code: PICK_SHADER2 });
    this.pickPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.edgeLayout] }),
      vertex: {
        module: pickModule,
        entryPoint: "vs",
        buffers: [{
          arrayStride: 12,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "uint32" }
          ]
        }]
      },
      fragment: { module: pickModule, entryPoint: "fs", targets: [{ format: "r32uint" }] },
      primitive: { topology: "triangle-list" }
    });
    this.pickVertexBuffer = device.createBuffer({
      size: MAX_PICK_VERTICES * 12,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.pickReadBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    this.pickTexture = null;
    this.pickTextureSize = [0, 0];
    this.pickPending = false;
    this.vectorChunks = /* @__PURE__ */ new Map();
    this.failedVectorChunks = /* @__PURE__ */ new Map();
    this.nativeDetailState = /* @__PURE__ */ new Map();
    this.domDetailPageIds = /* @__PURE__ */ new Set();
    this.nativeDetailThresholds = /* @__PURE__ */ new Map();
    this.residentVectorBytes = 0;
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    this.placeholder = this.createSolidTexture([245, 247, 249, 255]);
    this.pageResources = /* @__PURE__ */ new Map();
    this.imageResources = /* @__PURE__ */ new Map();
    this.loading = /* @__PURE__ */ new Map();
    this.selectedPageId = "";
    this.selectedFeatureId = 0;
    this.activeNetUid = "";
    this.showHierarchy = true;
    this.downloadedBytes = 0;
    this.world = manifest.worldBoundsMm;
    this.center = [
      (this.world.minX + this.world.maxX) / 2,
      (this.world.minY + this.world.maxY) / 2
    ];
    this.scale = Math.max(
      (this.world.maxX - this.world.minX) / 900,
      (this.world.maxY - this.world.minY) / 650,
      0.1
    ) * 1.16;
    this.edgeBuffer = this.createEdgeBuffer();
    for (const page of this.pages) this.createPageResource(page);
  }
  createSolidTexture(rgba) {
    const texture = this.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.device.queue.writeTexture(
      { texture },
      new Uint8Array(rgba),
      { bytesPerRow: 4 },
      [1, 1]
    );
    return texture;
  }
  createPageResource(page) {
    const uniform = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const resource = {
      page,
      uniform,
      texture: this.placeholder,
      textureWidth: 0,
      svgBlob: null,
      bindGroup: null
    };
    this.pageResources.set(page.id, resource);
    this.updateBindGroup(resource);
  }
  createImageResource(path) {
    const uniform = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const resource = {
      path,
      uniform,
      texture: this.placeholder,
      loaded: false,
      bindGroup: null
    };
    this.imageResources.set(path, resource);
    this.updateBindGroup(resource);
    return resource;
  }
  updateBindGroup(resource) {
    resource.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.globalBuffer } },
        { binding: 1, resource: { buffer: resource.uniform } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: resource.texture.createView() }
      ]
    });
  }
  async loadImageTexture(path) {
    const resource = this.imageResources.get(path) || this.createImageResource(path);
    if (resource.loaded) return resource;
    const key = `image:${path}`;
    if (this.loading.has(key)) return this.loading.get(key);
    const promise = (async () => {
      try {
        const response = await fetch(new URL(path, this.manifestUrl), { cache: "default" });
        if (!response.ok) throw new Error(`Failed to load schematic image ${path}: ${response.status}`);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        const texture = this.device.createTexture({
          size: [bitmap.width, bitmap.height],
          format: "rgba8unorm-srgb",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);
        bitmap.close();
        if (resource.texture !== this.placeholder) resource.texture.destroy();
        resource.texture = texture;
        resource.loaded = true;
        this.updateBindGroup(resource);
      } finally {
        this.loading.delete(key);
      }
      return resource;
    })();
    this.loading.set(key, promise);
    return promise;
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
        target.worldY
      );
    }
    const data = new Float32Array(vertices);
    if (!data.length) return null;
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
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
    if (this.flowCanvas && (this.flowCanvas.width !== width || this.flowCanvas.height !== height)) {
      this.flowCanvas.width = width;
      this.flowCanvas.height = height;
    }
  }
  setFlowOverlayCanvas(canvas2) {
    if (!canvas2) return;
    this.flowCanvas = canvas2;
    this.flowContext = canvas2.getContext("webgpu");
    this.flowContext.configure({
      device: this.device,
      format: this.format,
      alphaMode: "premultiplied"
    });
  }
  writeGlobals() {
    const floats = this.globalUniformScratch;
    floats[0] = this.center[0];
    floats[1] = this.center[1];
    floats[2] = this.scale;
    floats[3] = performance.now() * 1e-3;
    floats[4] = this.canvas.width;
    floats[5] = this.canvas.height;
    this.device.queue.writeBuffer(this.globalBuffer, 0, floats);
  }
  pagePixelWidth(page) {
    return page.widthMm / this.scale;
  }
  pageSourcePixelsPerMm(page) {
    const x = this.pagePixelWidth(page) / Math.max(1, page.sourceWidthMm || page.widthMm);
    const y = page.heightMm / this.scale / Math.max(1, page.sourceHeightMm || page.heightMm);
    return Math.min(x, y);
  }
  pageNativeDetailThresholds(page) {
    const cached = this.nativeDetailThresholds.get(page.id);
    if (cached) return cached;
    const sourceWidth = Math.max(1, page.sourceWidthMm || page.widthMm);
    const sourceHeight = Math.max(1, page.sourceHeightMm || page.heightMm);
    const sourceArea = sourceWidth * sourceHeight;
    const featureDensity = Math.max(0, page.featureCount || page.featureIds?.length || 0) / Math.max(1, sourceArea);
    const densityBias = clamp(1 - featureDensity * 72, 0.84, 1.08);
    const aspectBias = clamp(Math.sqrt(Math.max(sourceWidth, sourceHeight) / Math.max(1, Math.min(sourceWidth, sourceHeight))) / 1.18, 0.92, 1.14);
    const enter = clamp(NATIVE_DETAIL_BASE_ENTER_PX_PER_MM * densityBias * aspectBias, 5, 7.4);
    const thresholds = {
      enter,
      exit: clamp(Math.min(enter - 1.2, NATIVE_DETAIL_BASE_EXIT_PX_PER_MM * densityBias), 3.8, enter - 0.7),
      prefetch: clamp(Math.min(enter - 2, NATIVE_DETAIL_BASE_PREFETCH_PX_PER_MM * densityBias), 3, enter - 1)
    };
    this.nativeDetailThresholds.set(page.id, thresholds);
    return thresholds;
  }
  pageWantsNativeDetail(page) {
    if (!this.pageHasNativeDetail(page)) return false;
    const density = this.pageSourcePixelsPerMm(page);
    const active = this.nativeDetailState.get(page.id) === true;
    const thresholds = this.pageNativeDetailThresholds(page);
    const threshold = active ? thresholds.exit : thresholds.enter;
    const next = density >= threshold;
    if (next !== active) this.nativeDetailState.set(page.id, next);
    return next;
  }
  pageNativeDetailReady(page) {
    if (this.domDetailPageIds.has(page.id)) return false;
    if (!this.pageWantsNativeDetail(page)) return false;
    const chunk = this.vectorChunks.get(page.id);
    if (!chunk?.loaded || !chunk.segments?.length && !chunk.fills?.length) return false;
    return this.visibleNativeImagesReady(page, chunk);
  }
  visibleNativeImagesReady(page, chunk) {
    if (!chunk?.images?.length) return true;
    const sourceBounds = this.sourceViewportBounds(page, 4);
    let ready = true;
    for (const image of chunk.images) {
      if (!intersectsBounds(image.bounds, sourceBounds)) continue;
      const resource = this.imageResources.get(image.path) || this.createImageResource(image.path);
      if (!resource.loaded) {
        ready = false;
        void this.loadImageTexture(image.path).catch(() => {
        });
      }
    }
    return ready;
  }
  visiblePages() {
    const halfW = this.canvas.width * this.scale / 2;
    const halfH = this.canvas.height * this.scale / 2;
    const left = this.center[0] - halfW;
    const right = this.center[0] + halfW;
    const top = this.center[1] - halfH;
    const bottom = this.center[1] + halfH;
    return this.pages.filter((page) => page.worldX + page.widthMm >= left && page.worldX <= right && page.worldY + page.heightMm >= top && page.worldY <= bottom);
  }
  worldViewportBounds(padMm = 0) {
    const halfW = this.canvas.width * this.scale / 2;
    const halfH = this.canvas.height * this.scale / 2;
    return [
      this.center[0] - halfW - padMm,
      this.center[1] - halfH - padMm,
      this.center[0] + halfW + padMm,
      this.center[1] + halfH + padMm
    ];
  }
  sourceViewportBounds(page, padMm = 2.5) {
    const bounds = this.worldViewportBounds(this.scale * 8);
    const left = (bounds[0] - page.worldX) / page.widthMm * page.sourceWidthMm - padMm;
    const top = (bounds[1] - page.worldY) / page.heightMm * page.sourceHeightMm - padMm;
    const right = (bounds[2] - page.worldX) / page.widthMm * page.sourceWidthMm + padMm;
    const bottom = (bounds[3] - page.worldY) / page.heightMm * page.sourceHeightMm + padMm;
    return [
      Math.max(-padMm, Math.min(left, right)),
      Math.max(-padMm, Math.min(top, bottom)),
      Math.min(page.sourceWidthMm + padMm, Math.max(left, right)),
      Math.min(page.sourceHeightMm + padMm, Math.max(top, bottom))
    ];
  }
  render() {
    this.frameSerial += 1;
    this.resize();
    this.writeGlobals();
    const visible = this.visiblePages();
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.045, g: 0.055, b: 0.073, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
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
      const showDomDetail = this.domDetailPageIds.has(page.id);
      const showNativeDetail = !showDomDetail && this.pageNativeDetailReady(page);
      const values = this.pageUniformScratch;
      values[0] = page.worldX;
      values[1] = page.worldY;
      values[2] = page.widthMm;
      values[3] = page.heightMm;
      values[4] = page.id === this.selectedPageId ? 1 : 0;
      values[5] = containsNet ? 1 : 0;
      values[6] = this.activeNetUid ? 1 : 0;
      values[7] = showNativeDetail || showDomDetail ? 1 : 0;
      this.device.queue.writeBuffer(resource.uniform, 0, values);
      pass.setBindGroup(0, resource.bindGroup);
      pass.draw(6);
      const wantedWidth = clamp(
        Math.ceil(this.pagePixelWidth(page) * 1.3 / 512) * 512,
        512,
        6144
      );
      if (resource.textureWidth < wantedWidth * 0.82) void this.loadPageTexture(page, wantedWidth).catch(() => {
      });
    }
    this.scheduleVisibleVectorLoads(visible);
    this.drawVisibleImages(pass, visible);
    this.drawVisibleVectors(pass, visible);
    const flowCount = this.writeNetTrackingOverlay();
    if (flowCount && !this.flowContext) {
      pass.setPipeline(this.netFlowPipeline);
      pass.setBindGroup(0, this.edgeBindGroup);
      pass.setVertexBuffer(0, this.netFlowBuffer);
      pass.draw(flowCount);
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
    this.renderFlowOverlay(flowCount);
    this.evictVectorChunks(visible);
    return visible;
  }
  renderFlowOverlay(flowCount) {
    if (!this.flowContext) return;
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.flowContext.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    if (flowCount) {
      pass.setPipeline(this.netFlowPipeline);
      pass.setBindGroup(0, this.edgeBindGroup);
      pass.setVertexBuffer(0, this.netFlowBuffer);
      pass.draw(flowCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
  drawVisibleImages(pass, visiblePages) {
    if (!this.isNativeScene) return;
    let pipelineSet = false;
    for (const page of visiblePages) {
      if (this.domDetailPageIds.has(page.id)) continue;
      if (!this.pageNativeDetailReady(page)) continue;
      const chunk = this.vectorChunks.get(page.id);
      if (!chunk?.images?.length) continue;
      const sourceBounds = this.sourceViewportBounds(page, 4);
      for (const image of chunk.images) {
        if (!intersectsBounds(image.bounds, sourceBounds)) continue;
        const resource = this.imageResources.get(image.path) || this.createImageResource(image.path);
        if (!resource.loaded) void this.loadImageTexture(image.path).catch(() => {
        });
        const origin = image.worldOrigin || this.sourceToWorld(page, [image.xMm, image.yMm]);
        const size = image.worldSize || this.sourceSizeToWorld(page, image.widthMm, image.heightMm);
        const values = this.imageUniformScratch;
        values[0] = origin[0];
        values[1] = origin[1];
        values[2] = size[0];
        values[3] = size[1];
        values[4] = 0;
        values[5] = 0;
        values[6] = 0;
        values[7] = 0;
        this.device.queue.writeBuffer(resource.uniform, 0, values);
        if (!pipelineSet) {
          pass.setPipeline(this.imagePipeline);
          pipelineSet = true;
        }
        pass.setBindGroup(0, resource.bindGroup);
        pass.draw(6);
      }
    }
  }
  drawVisibleVectors(pass, visiblePages) {
    if (!this.isNativeScene) return 0;
    const values = this.vectorScratch;
    let offset = 0;
    let truncated = 0;
    let submittedVertices = 0;
    let submittedChunks = 0;
    let pipelineSet = false;
    const flush = () => {
      if (!offset) return;
      let buffer = this.vectorBuffers[submittedChunks];
      if (!buffer) {
        buffer = this.device.createBuffer({
          size: MAX_VECTOR_FLOATS * 4,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
        this.vectorBuffers.push(buffer);
      }
      this.device.queue.writeBuffer(buffer, 0, values, 0, offset);
      if (!pipelineSet) {
        pass.setPipeline(this.vectorPipeline);
        pass.setBindGroup(0, this.edgeBindGroup);
        pipelineSet = true;
      }
      const vertices = Math.floor(offset / 6);
      pass.setVertexBuffer(0, buffer);
      pass.draw(vertices);
      submittedVertices += vertices;
      submittedChunks += 1;
      offset = 0;
    };
    const ensure = (floatCount) => {
      if (floatCount > MAX_VECTOR_DRAW_FLOATS || floatCount > values.length) {
        truncated += 1;
        return false;
      }
      if (offset + floatCount > MAX_VECTOR_DRAW_FLOATS || offset + floatCount > values.length) flush();
      return true;
    };
    for (const page of visiblePages) {
      if (this.domDetailPageIds.has(page.id)) continue;
      if (!this.pageHasNativeDetail(page)) continue;
      const chunk = this.vectorChunks.get(page.id);
      if (!chunk?.segments?.length && !chunk?.fills?.length) continue;
      if (!this.pageNativeDetailReady(page)) continue;
      chunk.lastUsedFrame = this.frameSerial;
      const sourceBounds = this.sourceViewportBounds(page);
      const candidates = querySpatialIndex(chunk.spatial, sourceBounds);
      for (const fill of candidates.fills) {
        if (!intersectsBounds(fill.bounds, sourceBounds)) continue;
        if (!ensure(18)) continue;
        const feature = this.featuresById.get(fill.featureId);
        const isSelectedNet = this.activeNetUid && feature?.netUid === this.activeNetUid;
        const isSelectedFeature = this.selectedFeatureId === fill.featureId;
        const color = isSelectedFeature ? [0.24, 0.58, 1, 1] : isSelectedNet ? [0.06, 1, 0.24, 1] : this.activeNetUid && isElectricalFeature(feature) ? mutedVectorColor(feature, fill.kind, fill.color) : vectorColor(feature, fill.kind, fill.color);
        const points = fill.worldPoints || fill.points.map((point) => this.sourceToWorld(page, point));
        offset = writeFilledTriangle(values, offset, points[0], points[1], points[2], color);
      }
      for (const segment of candidates.segments) {
        if (!intersectsBounds(segment.bounds, sourceBounds)) continue;
        const feature = this.featuresById.get(segment.featureId);
        const isSelectedNet = this.activeNetUid && feature?.netUid === this.activeNetUid;
        const isSelectedFeature = this.selectedFeatureId === segment.featureId;
        const color = isSelectedFeature ? [0.24, 0.58, 1, 1] : isSelectedNet ? [0.06, 1, 0.24, 1] : this.activeNetUid && isElectricalFeature(feature) ? mutedVectorColor(feature, segment.kind, segment.color) : vectorColor(feature, segment.kind, segment.color);
        const width = this.segmentWorldWidth(page, segment, feature, isSelectedNet || isSelectedFeature);
        for (const visibleSegment of this.visibleSegmentParts(page, segment, feature)) {
          if (!ensure(36)) continue;
          const a = visibleSegment.worldA || this.sourceToWorld(page, visibleSegment.a);
          const b = visibleSegment.worldB || this.sourceToWorld(page, visibleSegment.b);
          offset = writeStrokeQuad(values, offset, a, b, width, color);
        }
      }
    }
    flush();
    this.truncatedVectorCount = truncated;
    this.vectorTruncated = truncated > 0;
    this.lastVectorVertices = submittedVertices;
    this.lastVectorChunks = submittedChunks;
    return submittedVertices;
  }
  pageHasNativeDetail(page) {
    if (!this.isNativeScene) return false;
    return page?.nativeDetail?.enabled !== false;
  }
  scheduleVisibleVectorLoads(visiblePages) {
    if (!this.isNativeScene) return;
    const inFlight = [...this.vectorChunks.values()].filter((chunk) => chunk?.promise && !chunk.loaded).length;
    let slots = Math.max(0, MAX_CONCURRENT_VECTOR_LOADS - inFlight);
    if (!slots) return;
    const candidates = visiblePages.filter((page) => !this.domDetailPageIds.has(page.id)).filter((page) => this.pageHasNativeDetail(page) && this.pageSourcePixelsPerMm(page) >= this.pageNativeDetailThresholds(page).prefetch).filter((page) => !this.vectorChunks.get(page.id)?.loaded && !this.vectorChunks.get(page.id)?.promise).sort((a, b) => {
      const aDistance = Math.hypot(a.worldX + a.widthMm / 2 - this.center[0], a.worldY + a.heightMm / 2 - this.center[1]);
      const bDistance = Math.hypot(b.worldX + b.widthMm / 2 - this.center[0], b.worldY + b.heightMm / 2 - this.center[1]);
      return aDistance - bDistance;
    });
    for (const page of candidates) {
      void this.loadPageVectors(page).catch(() => {
      });
      slots -= 1;
      if (!slots) break;
    }
  }
  featurePrimitiveBounds(page, featureId) {
    const chunk = this.vectorChunks.get(page.id);
    if (!chunk?.segments?.length && !chunk?.fills?.length) return null;
    const xs = [];
    const ys = [];
    for (const segment of chunk.segments || []) {
      if (segment.featureId !== featureId) continue;
      xs.push(segment.a[0], segment.b[0]);
      ys.push(segment.a[1], segment.b[1]);
    }
    for (const fill of chunk.fills || []) {
      if (fill.featureId !== featureId) continue;
      for (const point of fill.points || []) {
        xs.push(point[0]);
        ys.push(point[1]);
      }
    }
    if (!xs.length) return null;
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  symbolClipBounds(page) {
    if (!this._symbolClipBounds) this._symbolClipBounds = /* @__PURE__ */ new Map();
    if (this._symbolClipBounds.has(page.id)) return this._symbolClipBounds.get(page.id);
    const bounds = (this.featuresByPage[page.id] || []).filter((feature) => feature?.kind === "symbol_body" && feature.boundsMm && !String(feature.sourceId || "").includes(":overplot")).map((feature) => {
      const tight = this.featurePrimitiveBounds(page, feature.id) || feature.boundsMm;
      return [tight[0] - 0.02, tight[1] - 0.02, tight[2] + 0.02, tight[3] + 0.02];
    }).filter((bounds2) => {
      const width = bounds2[2] - bounds2[0];
      const height = bounds2[3] - bounds2[1];
      return Math.max(width, height) <= 12 && width * height <= 80;
    });
    this._symbolClipBounds.set(page.id, bounds);
    return bounds;
  }
  visibleSegmentParts(page, segment, feature) {
    if (segment._visibleParts) return segment._visibleParts;
    const kind = String(feature?.kind || "");
    const role = String(feature?.semanticRole || "");
    if (kind !== "wire" && role !== "wire") {
      segment._visibleParts = [segment];
      return segment._visibleParts;
    }
    let parts = [segment];
    for (const bounds of this.symbolClipBounds(page)) {
      const next = [];
      for (const part of parts) next.push(...clipSegmentOutsideBounds(part, bounds));
      parts = next;
      if (!parts.length) break;
    }
    for (const part of parts) {
      part.worldA = sourceToWorldPoint(page, part.a);
      part.worldB = sourceToWorldPoint(page, part.b);
    }
    segment._visibleParts = parts;
    return segment._visibleParts;
  }
  netTrackingSegments() {
    if (!this.activeNetUid) return { netUid: "", anchorsByPage: /* @__PURE__ */ new Map(), segments: [], intrasheetSegments: [] };
    const selectedFeatureId = Number(this.selectedFeatureId || 0);
    const selectedFeatureKey = String(this.selectedFeatureKey || "");
    const selectedSourceId = String(this.selectedSourceId || "");
    if (this.netTrackingCache?.netUid === this.activeNetUid && this.netTrackingCache?.selectedFeatureId === selectedFeatureId && this.netTrackingCache?.selectedFeatureKey === selectedFeatureKey && this.netTrackingCache?.selectedSourceId === selectedSourceId) {
      return this.netTrackingCache;
    }
    this.selectedIntrasheetLinkIndex = -1;
    const pageById = new Map(this.pages.map((page) => [page.id, page]));
    const pageIds = this.manifest.netToPages?.[this.activeNetUid] || [];
    const candidatePages = pageIds.length ? pageIds.map((id) => pageById.get(id)).filter(Boolean) : this.pages.filter((page) => page.netUids?.includes(this.activeNetUid));
    const anchorsByPage = /* @__PURE__ */ new Map();
    for (const page of candidatePages.slice(0, MAX_NET_TRACKING_PAGES)) {
      const anchors = this.netTrackingAnchorsForPage(page);
      if (anchors.length) anchorsByPage.set(page.id, anchors);
    }
    const segments = [];
    const intrasheetSegments = [];
    for (const [pageId, anchors] of anchorsByPage) {
      const pageSegments = nearestNeighborAnchorSegments(limitAnchorsForTracking(anchors), "intrasheet", pageId);
      segments.push(...pageSegments);
      intrasheetSegments.push(...pageSegments);
    }
    const pageAnchors = [...anchorsByPage.entries()].map(([pageId, anchors]) => representativeNetAnchor(pageById.get(pageId), anchors, {
      featureId: selectedFeatureId,
      stableKey: selectedFeatureKey,
      sourceId: selectedSourceId
    })).filter(Boolean);
    segments.push(...nearestNeighborAnchorSegments(pageAnchors, "intersheet", ""));
    const indexedIntrasheetSegments = intrasheetSegments.map((segment, index) => ({ ...segment, intrasheetIndex: index }));
    let intrasheetCursor = 0;
    const indexedSegments = segments.map((segment, index) => {
      if (segment.type !== "intrasheet") return { ...segment, id: index };
      const intrasheetIndex = intrasheetCursor;
      intrasheetCursor += 1;
      return { ...segment, id: index, intrasheetIndex };
    });
    this.netTrackingCache = {
      netUid: this.activeNetUid,
      selectedFeatureId,
      selectedFeatureKey,
      selectedSourceId,
      anchorsByPage,
      segments: indexedSegments,
      intrasheetSegments: indexedIntrasheetSegments
    };
    if (this.selectedIntrasheetLinkIndex >= this.netTrackingCache.intrasheetSegments.length) {
      this.selectedIntrasheetLinkIndex = -1;
    }
    return this.netTrackingCache;
  }
  netTrackingAnchorsForPage(page) {
    const items = this.featuresByPage[page.id] || [];
    const anchors = [];
    for (const feature of items) {
      if (feature.netUid !== this.activeNetUid || !feature.boundsMm) continue;
      if (!isNetTrackingAnchor(feature)) continue;
      const bounds = feature.boundsMm;
      const centerSource = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
      const center = this.sourceToWorld(page, centerSource);
      anchors.push({
        pageId: page.id,
        featureId: Number(feature.id || 0),
        stableKey: String(feature.stableKey || ""),
        sourceId: String(feature.sourceId || feature.sourceUid || feature.objectId || ""),
        kind: feature.kind || feature.semanticRole || "",
        source: centerSource,
        world: center,
        bounds,
        priority: netTrackingAnchorPriority(feature)
      });
    }
    anchors.sort((a, b) => b.priority - a.priority || a.source[1] - b.source[1] || a.source[0] - b.source[0]);
    return anchors;
  }
  writeNetTrackingOverlay() {
    const tracking = this.netTrackingSegments();
    this.lastNetFlowSegments = tracking.segments.length;
    this.lastNetFlowIntrasheetSegments = tracking.intrasheetSegments.length;
    if (!tracking.segments.length) {
      this.lastNetFlowVertices = 0;
      return 0;
    }
    const viewport = this.worldViewportBounds(this.scale * 96);
    const values = this.netFlowScratch;
    let offset = 0;
    let distanceSeed = 0;
    for (const segment of tracking.segments) {
      if (!intersectsBounds(segmentWorldBounds(segment), viewport)) continue;
      const isSelectedIntrasheet = segment.type === "intrasheet" && segment.intrasheetIndex === this.selectedIntrasheetLinkIndex;
      const widthPx = isSelectedIntrasheet ? 9.5 : segment.type === "intersheet" ? 8 : 4.8;
      const kind = isSelectedIntrasheet ? 2 : segment.type === "intersheet" ? 1 : 0;
      const written = writeFlowQuad(
        values,
        offset,
        segment.a,
        segment.b,
        widthPx * this.scale,
        kind,
        distanceSeed,
        this.scale
      );
      if (written === offset) continue;
      offset = written;
      distanceSeed += Math.hypot(segment.b[0] - segment.a[0], segment.b[1] - segment.a[1]) / Math.max(this.scale, 1e-6);
      if (offset + 24 > values.length) break;
    }
    if (!offset) {
      this.lastNetFlowVertices = 0;
      return 0;
    }
    this.device.queue.writeBuffer(this.netFlowBuffer, 0, values, 0, offset);
    this.lastNetFlowVertices = offset / 4;
    return offset / 4;
  }
  cycleNetIntrasheetLink(direction = 1) {
    const tracking = this.netTrackingSegments();
    if (!tracking.intrasheetSegments.length) return null;
    const count = tracking.intrasheetSegments.length;
    this.selectedIntrasheetLinkIndex = (this.selectedIntrasheetLinkIndex + direction + count) % count;
    const segment = tracking.intrasheetSegments[this.selectedIntrasheetLinkIndex];
    if (!segment) return null;
    const bounds = segmentWorldBounds(segment, 14 * this.scale);
    this.center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    this.scale = Math.max(
      (bounds[2] - bounds[0]) / Math.max(1, this.canvas.width * 0.36),
      (bounds[3] - bounds[1]) / Math.max(1, this.canvas.height * 0.3),
      this.scale * 0.35,
      0.025
    );
    return { pageId: segment.pageId, segment };
  }
  writeNetHighlights(visiblePages) {
    if (!this.activeNetUid) return 0;
    const values = this.highlightScratch;
    let offset = 0;
    let truncated = 0;
    for (const page of visiblePages) {
      const sourceBounds = this.sourceViewportBounds(page, 5);
      for (const feature of this.featuresByPage[page.id] || []) {
        if (feature.netUid !== this.activeNetUid || !feature.boundsMm) continue;
        if (!intersectsBounds(feature.boundsMm, sourceBounds)) continue;
        const bounds = this.featureWorldBounds(page, feature.boundsMm);
        if (offset + 16 > values.length) {
          truncated += 1;
          continue;
        }
        values[offset++] = bounds[0];
        values[offset++] = bounds[1];
        values[offset++] = bounds[2];
        values[offset++] = bounds[1];
        values[offset++] = bounds[2];
        values[offset++] = bounds[1];
        values[offset++] = bounds[2];
        values[offset++] = bounds[3];
        values[offset++] = bounds[2];
        values[offset++] = bounds[3];
        values[offset++] = bounds[0];
        values[offset++] = bounds[3];
        values[offset++] = bounds[0];
        values[offset++] = bounds[3];
        values[offset++] = bounds[0];
        values[offset++] = bounds[1];
      }
    }
    this.truncatedHighlightCount = truncated;
    if (!offset) return 0;
    this.device.queue.writeBuffer(this.highlightBuffer, 0, values, 0, offset);
    return offset / 2;
  }
  featureWorldBounds(page, bounds) {
    return [
      page.worldX + bounds[0] / page.sourceWidthMm * page.widthMm,
      page.worldY + bounds[1] / page.sourceHeightMm * page.heightMm,
      page.worldX + bounds[2] / page.sourceWidthMm * page.widthMm,
      page.worldY + bounds[3] / page.sourceHeightMm * page.heightMm
    ];
  }
  sourceToWorld(page, point) {
    return [
      page.worldX + point[0] / page.sourceWidthMm * page.widthMm,
      page.worldY + point[1] / page.sourceHeightMm * page.heightMm
    ];
  }
  sourceSizeToWorld(page, widthMm, heightMm) {
    return [
      widthMm / page.sourceWidthMm * page.widthMm,
      heightMm / page.sourceHeightMm * page.heightMm
    ];
  }
  async loadPageVectors(page) {
    if (!this.pageHasNativeDetail(page) || !page.chunks?.lod2) return null;
    const existing = this.vectorChunks.get(page.id);
    if (existing?.loaded) return existing;
    if (existing?.promise) return existing.promise;
    const promise = (async () => {
      try {
        const response = await fetch(new URL(page.chunks.lod2, this.manifestUrl));
        if (!response.ok) throw new Error(`Failed to load schematic vector chunk ${page.id}: ${response.status}`);
        const payload = await response.json();
        const geometry = primitiveGeometry(payload.primitives || []);
        prepareWorldGeometry(page, geometry);
        const jsonBytes = JSON.stringify(payload).length;
        const bytes = jsonBytes;
        const chunk = {
          loaded: true,
          segments: geometry.segments,
          fills: geometry.fills,
          images: geometry.images,
          spatial: buildSpatialIndex(geometry),
          unsupported: payload.unsupported || [],
          bytes,
          lastUsedFrame: this.frameSerial
        };
        this.vectorChunks.set(page.id, chunk);
        this.failedVectorChunks.delete(page.id);
        this.residentVectorBytes += bytes;
        return chunk;
      } catch (error) {
        const current = this.failedVectorChunks.get(page.id) || { count: 0, message: "" };
        this.failedVectorChunks.set(page.id, {
          count: current.count + 1,
          message: error?.message || String(error)
        });
        this.vectorChunks.delete(page.id);
        throw error;
      }
    })();
    this.vectorChunks.set(page.id, { loaded: false, promise, segments: [] });
    return promise;
  }
  evictVectorChunks(visiblePages) {
    if (this.residentVectorBytes <= MAX_RESIDENT_VECTOR_BYTES) return;
    const visibleIds = new Set(visiblePages.map((page) => page.id));
    const candidates = [...this.vectorChunks.entries()].filter(([, chunk]) => chunk?.loaded).filter(([pageId]) => !visibleIds.has(pageId) && pageId !== this.selectedPageId).sort((a, b) => (a[1].lastUsedFrame || 0) - (b[1].lastUsedFrame || 0));
    for (const [pageId, chunk] of candidates) {
      this.vectorChunks.delete(pageId);
      this.residentVectorBytes = Math.max(0, this.residentVectorBytes - (chunk.bytes || 0));
      if (this.residentVectorBytes <= MAX_RESIDENT_VECTOR_BYTES * 0.82) break;
    }
  }
  stats() {
    const visible = this.visiblePages();
    const visibleDensities = visible.map((page) => this.pageSourcePixelsPerMm(page));
    const visibleThresholds = visible.map((page) => this.pageNativeDetailThresholds(page).enter);
    return {
      residentVectorBytes: this.residentVectorBytes,
      vectorChunks: [...this.vectorChunks.values()].filter((chunk) => chunk?.loaded).length,
      vectorLoads: [...this.vectorChunks.values()].filter((chunk) => chunk?.promise && !chunk.loaded).length,
      failedVectorChunks: this.failedVectorChunks.size,
      vectorVertices: this.lastVectorVertices || 0,
      vectorDrawChunks: this.lastVectorChunks || 0,
      truncatedVectors: this.truncatedVectorCount || 0,
      nativeDetailPages: [...this.nativeDetailState.values()].filter(Boolean).length,
      nativePxPerMm: Number((Math.max(0, ...visibleDensities) || 0).toFixed(2)),
      nativeThresholdPxPerMm: Number((visibleThresholds.length ? Math.min(...visibleThresholds) : 0).toFixed(2)),
      domDetailPages: this.domDetailPageIds.size,
      netFlowSegments: this.lastNetFlowSegments || 0,
      netFlowIntrasheetSegments: this.lastNetFlowIntrasheetSegments || 0,
      netFlowVertices: this.lastNetFlowVertices || 0
    };
  }
  setDomDetailPageIds(ids) {
    this.domDetailPageIds = new Set(ids || []);
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
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
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
        await this.loadPageTexture(page, 512).catch(() => {
        });
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
      this.center[1] + (y - this.canvas.height / 2) * this.scale
    ];
  }
  worldToScreen(x, y) {
    const ratioX = this.canvas.clientWidth / this.canvas.width;
    const ratioY = this.canvas.clientHeight / this.canvas.height;
    return [
      ((x - this.center[0]) / this.scale + this.canvas.width / 2) * ratioX,
      ((y - this.center[1]) / this.scale + this.canvas.height / 2) * ratioY
    ];
  }
  hitPage(clientX, clientY) {
    const [x, y] = this.screenToWorld(clientX, clientY);
    return [...this.pages].reverse().find((page) => x >= page.worldX && x <= page.worldX + page.widthMm && y >= page.worldY && y <= page.worldY + page.heightMm) || null;
  }
  async pickFeature(clientX, clientY) {
    if (!this.isNativeScene) return this.hitFeature(clientX, clientY);
    const page = this.hitPage(clientX, clientY);
    if (!page) return null;
    if (!this.pageHasNativeDetail(page)) return this.hitFeature(clientX, clientY);
    await this.loadPageVectors(page);
    const feature = await this.gpuPickFeature(page, clientX, clientY);
    if (feature && !isBackgroundOrPageFeature(feature)) {
      return { page, feature, source: this.clientToSource(page, clientX, clientY), native: true, gpu: true };
    }
    return this.hitFeature(clientX, clientY);
  }
  hitFeature(clientX, clientY) {
    const page = this.hitPage(clientX, clientY);
    if (!page) return null;
    const [sourceX, sourceY] = this.clientToSource(page, clientX, clientY);
    const tolerance = Math.max(
      0.45,
      5 * this.scale * this.canvas.width / Math.max(1, this.canvas.clientWidth) * page.sourceWidthMm / page.widthMm
    );
    const vectorHit = this.hitResidentVectorFeature(page, sourceX, sourceY, tolerance);
    if (vectorHit) return { page, feature: vectorHit, source: [sourceX, sourceY], native: true };
    const symbolInterior = this.hitSymbolInterior(page, sourceX, sourceY);
    if (symbolInterior) return { page, feature: symbolInterior, source: [sourceX, sourceY], native: true, interior: true };
    const candidates = (this.featuresByPage[page.id] || []).filter((feature) => {
      if (isBackgroundOrPageFeature(feature)) return false;
      const bounds = feature.boundsMm;
      return bounds && sourceX >= bounds[0] - tolerance && sourceX <= bounds[2] + tolerance && sourceY >= bounds[1] - tolerance && sourceY <= bounds[3] + tolerance;
    }).map((feature) => ({
      feature,
      priority: featurePickPriority(feature),
      area: Math.max(1e-4, (feature.boundsMm[2] - feature.boundsMm[0]) * (feature.boundsMm[3] - feature.boundsMm[1]))
    })).sort((a, b) => b.priority - a.priority || a.area - b.area);
    return { page, feature: candidates[0]?.feature || null, source: [sourceX, sourceY] };
  }
  hitSymbolInterior(page, sourceX, sourceY) {
    let best = null;
    for (const feature of this.featuresByPage[page.id] || []) {
      const kind = String(feature?.kind || "");
      if (kind !== "symbol_body" && kind !== "symbol_instance") continue;
      if (String(feature?.sourceId || "").includes(":overplot")) continue;
      const bounds = feature.boundsMm;
      if (!bounds) continue;
      if (sourceX < bounds[0] || sourceX > bounds[2] || sourceY < bounds[1] || sourceY > bounds[3]) continue;
      const area = Math.max(1e-4, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]));
      const score = (kind === "symbol_body" ? 0 : 1e6) + area;
      if (!best || score < best.score) best = { feature, score };
    }
    return best?.feature || null;
  }
  clientToSource(page, clientX, clientY) {
    const [worldX, worldY] = this.screenToWorld(clientX, clientY);
    return [
      (worldX - page.worldX) / page.widthMm * page.sourceWidthMm,
      (worldY - page.worldY) / page.heightMm * page.sourceHeightMm
    ];
  }
  ensurePickTexture() {
    if (this.pickTexture && this.pickTextureSize[0] === this.canvas.width && this.pickTextureSize[1] === this.canvas.height) return;
    if (this.pickTexture) this.pickTexture.destroy();
    this.pickTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: "r32uint",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    this.pickTextureSize = [this.canvas.width, this.canvas.height];
  }
  writePickVectors(pages) {
    const buffer = new ArrayBuffer(MAX_PICK_VERTICES * 12);
    const view = new DataView(buffer);
    let count = 0;
    const pickSegments = [];
    for (const page of pages) {
      const chunk = this.vectorChunks.get(page.id);
      if (!chunk?.segments?.length && !chunk?.fills?.length && !chunk?.images?.length) continue;
      const sourcePoint = this._pickSourcePointByPage?.get(page.id);
      const sourceBounds = sourcePoint ? [sourcePoint[0] - 2.5, sourcePoint[1] - 2.5, sourcePoint[0] + 2.5, sourcePoint[1] + 2.5] : [0, 0, page.sourceWidthMm, page.sourceHeightMm];
      const candidates = querySpatialIndex(chunk.spatial, sourceBounds);
      for (const image of candidates.images) {
        if (!intersectsBounds(image.bounds, sourceBounds)) continue;
        const feature = this.featuresById.get(image.featureId);
        if (!feature || isBackgroundOrPageFeature(feature)) continue;
        pickSegments.push({ page, image, feature, priority: featurePickPriority(feature) - 5 });
      }
      for (const fill of candidates.fills) {
        if (!intersectsBounds(fill.bounds, sourceBounds)) continue;
        const feature = this.featuresById.get(fill.featureId);
        if (!feature || isBackgroundOrPageFeature(feature)) continue;
        pickSegments.push({ page, fill, feature, priority: featurePickPriority(feature) - 2 });
      }
      for (const segment of candidates.segments) {
        if (!intersectsBounds(segment.bounds, sourceBounds)) continue;
        const feature = this.featuresById.get(segment.featureId);
        if (!feature || isBackgroundOrPageFeature(feature)) continue;
        pickSegments.push({ page, segment, feature, priority: featurePickPriority(feature) });
      }
    }
    pickSegments.sort((a, b) => a.priority - b.priority);
    for (const { page, segment, fill, image, feature } of pickSegments) {
      if (count + 6 > MAX_PICK_VERTICES) break;
      if (image) {
        const p0 = this.sourceToWorld(page, [image.xMm, image.yMm]);
        const p1 = this.sourceToWorld(page, [image.xMm + image.widthMm, image.yMm]);
        const p2 = this.sourceToWorld(page, [image.xMm, image.yMm + image.heightMm]);
        const p3 = this.sourceToWorld(page, [image.xMm + image.widthMm, image.yMm + image.heightMm]);
        count = writePickTriangle(view, count, p0, p1, p2, image.featureId);
        count = writePickTriangle(view, count, p2, p1, p3, image.featureId);
      } else if (fill) {
        const points = fill.worldPoints || fill.points.map((point) => this.sourceToWorld(page, point));
        count = writePickTriangle(view, count, points[0], points[1], points[2], fill.featureId);
      } else {
        const width = Math.max(this.segmentWorldWidth(page, segment, feature, false), this.scale * 7);
        for (const visibleSegment of this.visibleSegmentParts(page, segment, feature)) {
          if (count + 6 > MAX_PICK_VERTICES) break;
          const a = visibleSegment.worldA || this.sourceToWorld(page, visibleSegment.a);
          const b = visibleSegment.worldB || this.sourceToWorld(page, visibleSegment.b);
          count = writePickStrokeQuad(view, count, a, b, width, segment.featureId);
        }
      }
    }
    if (!count) return 0;
    this.device.queue.writeBuffer(this.pickVertexBuffer, 0, buffer, 0, count * 12);
    return count;
  }
  async gpuPickFeature(page, clientX, clientY) {
    if (this.pickPending) return null;
    const sourcePoint = this.clientToSource(page, clientX, clientY);
    this._pickSourcePointByPage = /* @__PURE__ */ new Map([[page.id, sourcePoint]]);
    const count = this.writePickVectors([page]);
    this._pickSourcePointByPage = null;
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
        storeOp: "store"
      }]
    });
    pass.setPipeline(this.pickPipeline);
    pass.setBindGroup(0, this.edgeBindGroup);
    pass.setVertexBuffer(0, this.pickVertexBuffer);
    pass.draw(count);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: this.pickTexture, origin: { x, y } },
      { buffer: this.pickReadBuffer, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 }
    );
    this.pickPending = true;
    this.device.queue.submit([encoder.finish()]);
    try {
      await this.pickReadBuffer.mapAsync(GPUMapMode.READ);
      const id = new DataView(this.pickReadBuffer.getMappedRange()).getUint32(0, true);
      this.pickReadBuffer.unmap();
      return id ? this.featuresById.get(id) || null : null;
    } finally {
      if (this.pickReadBuffer.mapState === "mapped") this.pickReadBuffer.unmap();
      this.pickPending = false;
    }
  }
  hitResidentVectorFeature(page, sourceX, sourceY, tolerance) {
    if (!this.isNativeScene) return null;
    const chunk = this.vectorChunks.get(page.id);
    if (!chunk?.loaded) return null;
    let best = null;
    for (const segment of chunk.segments) {
      const feature = this.featuresById.get(segment.featureId);
      const widthTolerance = Math.max(tolerance, (segment.widthMm || 0) * 0.5 + tolerance * 0.45);
      if (!feature) continue;
      for (const visibleSegment of this.visibleSegmentParts(page, segment, feature)) {
        const distance = pointSegmentDistance([sourceX, sourceY], visibleSegment.a, visibleSegment.b);
        if (distance > widthTolerance) continue;
        const score = distance - featurePickPriority(feature) * 0.025 + (isElectricalFeature(feature) ? 0 : 8);
        if (!best || score < best.score) best = { feature, score };
      }
    }
    return best?.feature || null;
  }
  segmentWorldWidth(page, segment, feature, selected) {
    const sourceWidth = (segment.widthMm || 0.15) / Math.max(1, page.sourceWidthMm) * page.widthMm;
    return Math.max(sourceWidth, this.scale * nativeStrokePixelWidth(feature, segment.kind, selected));
  }
  pan(dx, dy) {
    const ratio = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    this.center[0] -= dx * this.scale * ratio;
    this.center[1] -= dy * this.scale * ratio;
  }
  zoom(delta, clientX, clientY) {
    const before = this.screenToWorld(clientX, clientY);
    this.scale = clamp(this.scale * Math.exp(delta * 15e-4), 0.015, 16);
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
      page.heightMm / Math.max(1, this.canvas.height * 0.84)
    );
  }
  frameWorld() {
    this.resize();
    this.center = [
      (this.world.minX + this.world.maxX) / 2,
      (this.world.minY + this.world.maxY) / 2
    ];
    this.scale = Math.max(
      (this.world.maxX - this.world.minX) / Math.max(1, this.canvas.width * 0.9),
      (this.world.maxY - this.world.minY) / Math.max(1, this.canvas.height * 0.88),
      0.05
    );
  }
};
function thumbnailPath(page) {
  return page.thumbnail?.path || page.svg;
}
function normalizeFeatureTable(payload) {
  if (payload.schema === "prism.schematic_vector_a0.features") {
    const byId = new Map((payload.features || []).map((feature) => [Number(feature.id), feature]));
    const pages = {};
    for (const [pageId, ids] of Object.entries(payload.pages || {})) {
      pages[pageId] = ids.map((id) => byId.get(Number(id))).filter(Boolean);
    }
    return pages;
  }
  return payload.pages || {};
}
function primitiveGeometry(primitives) {
  const segments = [];
  const fills = [];
  const images = [];
  for (const primitive of primitives) {
    const featureId = Number(primitive.featureId || 0);
    if (!featureId) continue;
    if (primitive.kind === "plotimage" && primitive.image?.path) {
      const xMm = primitive.xMm || 0;
      const yMm = primitive.yMm || 0;
      const widthMm2 = primitive.widthMm || 0;
      const heightMm = primitive.heightMm || 0;
      images.push({
        featureId,
        kind: primitive.kind,
        xMm,
        yMm,
        widthMm: widthMm2,
        heightMm,
        bounds: [xMm, yMm, xMm + widthMm2, yMm + heightMm],
        path: primitive.image.path
      });
      continue;
    }
    const semanticRole = String(primitive.semanticRole || "");
    const radiusMm = primitive.radiusMm || primitive.diameterMm / 2 || 0;
    const filled = String(primitive.fill || "").toUpperCase() === "FILLED_SHAPE";
    const widthMm = primitive.widthMm || primitive.pen_widthMm || (semanticRole === "junction" ? 0.08 : 0.15);
    const lineStyle = String(primitive.lineStyle || primitive.line_style || "DEFAULT").toUpperCase();
    const color = primitive.color || primitive.strokeColor || primitive.style?.color || "";
    const fillColor = primitive.fillColor || primitive.color || primitive.style?.color || "";
    const add2 = (a, b) => appendStyledSegment(segments, { featureId, kind: primitive.kind, widthMm, lineStyle, color }, a, b);
    const x1 = primitive.x1Mm;
    const y1 = primitive.y1Mm;
    const x2 = primitive.x2Mm;
    const y2 = primitive.y2Mm;
    if (primitive.trianglesMm?.length) {
      for (const triangle of primitive.trianglesMm) {
        if (Array.isArray(triangle) && triangle.length === 3) {
          fills.push({ featureId, kind: primitive.kind, color: fillColor, points: triangle, bounds: pointsBounds(triangle) });
        }
      }
      if (primitive.pointsMm?.length >= 2) {
        for (let index = 1; index < primitive.pointsMm.length; index += 1) {
          add2(primitive.pointsMm[index - 1], primitive.pointsMm[index]);
        }
        if (shouldClosePolyline(primitive)) {
          add2(primitive.pointsMm[primitive.pointsMm.length - 1], primitive.pointsMm[0]);
        }
      }
    } else if (primitive.pointsMm?.length >= 2) {
      if (filled && primitive.pointsMm.length >= 3) appendPolygonFan(fills, featureId, primitive.kind, primitive.pointsMm, fillColor);
      for (let index = 1; index < primitive.pointsMm.length; index += 1) {
        add2(primitive.pointsMm[index - 1], primitive.pointsMm[index]);
      }
      if (shouldClosePolyline(primitive)) {
        add2(primitive.pointsMm[primitive.pointsMm.length - 1], primitive.pointsMm[0]);
      }
    } else if (primitive.polylinesMm?.length) {
      for (const polyline of primitive.polylinesMm) {
        if (!Array.isArray(polyline) || polyline.length < 2) continue;
        for (let index = 1; index < polyline.length; index += 1) add2(polyline[index - 1], polyline[index]);
      }
    } else if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)) {
      if (primitive.kind === "rect") {
        if (filled) appendRectFill(fills, featureId, primitive.kind, [x1, y1, x2, y2], fillColor);
        add2([x1, y1], [x2, y1]);
        add2([x2, y1], [x2, y2]);
        add2([x2, y2], [x1, y2]);
        add2([x1, y2], [x1, y1]);
      } else {
        add2([x1, y1], [x2, y2]);
      }
    } else if (Number.isFinite(primitive.cxMm) && Number.isFinite(primitive.cyMm)) {
      const radius = primitive.radiusMm || primitive.diameterMm / 2 || 0.4;
      if (filled) appendCircleFill(fills, featureId, primitive.kind, [primitive.cxMm, primitive.cyMm], radius, fillColor);
      appendCircle(segments, { featureId, kind: primitive.kind, widthMm, lineStyle, color }, [primitive.cxMm, primitive.cyMm], radius);
    } else if (primitive.contoursMm?.length) {
      for (const contour of primitive.contoursMm) {
        if (!Array.isArray(contour) || contour.length < 2) continue;
        for (let index = 1; index < contour.length; index += 1) add2(contour[index - 1], contour[index]);
        add2(contour[contour.length - 1], contour[0]);
      }
    } else if (Number.isFinite(primitive.start_xMm) && Number.isFinite(primitive.start_yMm) && Number.isFinite(primitive.end_xMm) && Number.isFinite(primitive.end_yMm)) {
      if (Number.isFinite(primitive.mid_xMm) && Number.isFinite(primitive.mid_yMm)) {
        add2([primitive.start_xMm, primitive.start_yMm], [primitive.mid_xMm, primitive.mid_yMm]);
        add2([primitive.mid_xMm, primitive.mid_yMm], [primitive.end_xMm, primitive.end_yMm]);
      } else {
        add2([primitive.start_xMm, primitive.start_yMm], [primitive.end_xMm, primitive.end_yMm]);
      }
    } else if (Number.isFinite(primitive.start_xMm) && Number.isFinite(primitive.start_yMm) && Number.isFinite(primitive.mid_xMm) && Number.isFinite(primitive.mid_yMm) && Number.isFinite(primitive.end_xMm) && Number.isFinite(primitive.end_yMm)) {
      add2([primitive.start_xMm, primitive.start_yMm], [primitive.mid_xMm, primitive.mid_yMm]);
      add2([primitive.mid_xMm, primitive.mid_yMm], [primitive.end_xMm, primitive.end_yMm]);
    } else if (primitive.boundsMm && primitive.kind !== "text") {
      const [left, top, right, bottom] = primitive.boundsMm;
      add2([left, top], [right, top]);
      add2([right, top], [right, bottom]);
      add2([right, bottom], [left, bottom]);
      add2([left, bottom], [left, top]);
    }
  }
  return { segments, fills, images };
}
function prepareWorldGeometry(page, geometry) {
  for (const segment of geometry.segments || []) {
    segment.worldA = sourceToWorldPoint(page, segment.a);
    segment.worldB = sourceToWorldPoint(page, segment.b);
  }
  for (const fill of geometry.fills || []) {
    fill.worldPoints = fill.points.map((point) => sourceToWorldPoint(page, point));
  }
  for (const image of geometry.images || []) {
    image.worldOrigin = sourceToWorldPoint(page, [image.xMm, image.yMm]);
    image.worldSize = sourceSizeToWorld(page, image.widthMm, image.heightMm);
  }
}
function sourceToWorldPoint(page, point) {
  return [
    page.worldX + point[0] / page.sourceWidthMm * page.widthMm,
    page.worldY + point[1] / page.sourceHeightMm * page.heightMm
  ];
}
function sourceSizeToWorld(page, widthMm, heightMm) {
  return [
    widthMm / page.sourceWidthMm * page.widthMm,
    heightMm / page.sourceHeightMm * page.heightMm
  ];
}
function appendRectFill(fills, featureId, kind, bounds, color) {
  const [left, top, right, bottom] = bounds;
  fills.push(
    { featureId, kind, color, points: [[left, top], [right, top], [left, bottom]], bounds: [left, top, right, bottom] },
    { featureId, kind, color, points: [[left, bottom], [right, top], [right, bottom]], bounds: [left, top, right, bottom] }
  );
}
function appendCircleFill(fills, featureId, kind, center, radius, color) {
  const steps = 36;
  for (let index = 0; index < steps; index += 1) {
    const a = index / steps * Math.PI * 2;
    const b = (index + 1) / steps * Math.PI * 2;
    fills.push({
      featureId,
      kind,
      color,
      points: [
        center,
        [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius],
        [center[0] + Math.cos(b) * radius, center[1] + Math.sin(b) * radius]
      ],
      bounds: [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius]
    });
  }
}
function appendPolygonFan(fills, featureId, kind, points, color) {
  const anchor = points[0];
  const bounds = pointsBounds(points);
  for (let index = 2; index < points.length; index += 1) {
    fills.push({ featureId, kind, color, points: [anchor, points[index - 1], points[index]], bounds });
  }
}
function appendStyledSegment(segments, segment, a, b) {
  const bounds = segmentBounds(a, b, segment.widthMm || 0.15);
  const style = segment.lineStyle || "DEFAULT";
  if (!["DASH", "DASHED", "DOT", "DOTTED", "DASHDOT", "DASH_DOT"].includes(style)) {
    segments.push({ ...segment, a, b, bounds });
    return;
  }
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length3 = Math.hypot(dx, dy);
  if (length3 < 1e-6) return;
  const ux = dx / length3;
  const uy = dy / length3;
  const unit = Math.max(segment.widthMm * 4, 0.45);
  const pattern = style.includes("DOT") ? [unit * 0.8, unit * 0.75, unit * 3, unit * 0.75] : [unit * 3, unit * 1.5];
  let offset = 0;
  let patternIndex = 0;
  while (offset < length3) {
    const span = Math.min(pattern[patternIndex % pattern.length], length3 - offset);
    if (patternIndex % 2 === 0) {
      const start = [a[0] + ux * offset, a[1] + uy * offset];
      const end = [a[0] + ux * (offset + span), a[1] + uy * (offset + span)];
      segments.push({ ...segment, a: start, b: end, bounds: segmentBounds(start, end, segment.widthMm || 0.15) });
    }
    offset += span;
    patternIndex += 1;
  }
}
function appendCircle(segments, segment, center, radius) {
  const steps = 32;
  for (let index = 0; index < steps; index += 1) {
    const a = index / steps * Math.PI * 2;
    const b = (index + 1) / steps * Math.PI * 2;
    segments.push({
      ...segment,
      a: [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius],
      b: [center[0] + Math.cos(b) * radius, center[1] + Math.sin(b) * radius],
      bounds: [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius]
    });
  }
}
function pointsBounds(points, pad = 0) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points || []) {
    left = Math.min(left, point[0]);
    top = Math.min(top, point[1]);
    right = Math.max(right, point[0]);
    bottom = Math.max(bottom, point[1]);
  }
  if (!Number.isFinite(left)) return [0, 0, 0, 0];
  return [left - pad, top - pad, right + pad, bottom + pad];
}
function segmentBounds(a, b, widthMm = 0) {
  const pad = Math.max(0.05, widthMm * 0.5);
  return [
    Math.min(a[0], b[0]) - pad,
    Math.min(a[1], b[1]) - pad,
    Math.max(a[0], b[0]) + pad,
    Math.max(a[1], b[1]) + pad
  ];
}
function intersectsBounds(a, b) {
  if (!a || !b) return true;
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
function buildSpatialIndex(geometry) {
  const index = {
    cellSize: VECTOR_TILE_SIZE_MM,
    cells: /* @__PURE__ */ new Map(),
    segments: geometry.segments || [],
    fills: geometry.fills || [],
    images: geometry.images || [],
    queryId: 0
  };
  for (const item of index.segments) addSpatialItem(index, "segments", item);
  for (const item of index.fills) addSpatialItem(index, "fills", item);
  for (const item of index.images) addSpatialItem(index, "images", item);
  return index;
}
function addSpatialItem(index, bucketName, item) {
  const bounds = item.bounds;
  if (!bounds) return;
  const minX = Math.floor(bounds[0] / index.cellSize);
  const maxX = Math.floor(bounds[2] / index.cellSize);
  const minY = Math.floor(bounds[1] / index.cellSize);
  const maxY = Math.floor(bounds[3] / index.cellSize);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const key = `${x}:${y}`;
      let cell = index.cells.get(key);
      if (!cell) {
        cell = { segments: [], fills: [], images: [] };
        index.cells.set(key, cell);
      }
      cell[bucketName].push(item);
    }
  }
}
function querySpatialIndex(index, bounds) {
  if (!index) return { segments: [], fills: [], images: [] };
  index.queryId = (index.queryId || 0) + 1;
  const queryId = index.queryId;
  const result = { segments: [], fills: [], images: [] };
  const minX = Math.floor(bounds[0] / index.cellSize);
  const maxX = Math.floor(bounds[2] / index.cellSize);
  const minY = Math.floor(bounds[1] / index.cellSize);
  const maxY = Math.floor(bounds[3] / index.cellSize);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const cell = index.cells.get(`${x}:${y}`);
      if (!cell) continue;
      collectSpatialItems(cell.segments, result.segments, queryId, "segments");
      collectSpatialItems(cell.fills, result.fills, queryId, "fills");
      collectSpatialItems(cell.images, result.images, queryId, "images");
    }
  }
  return result;
}
function collectSpatialItems(items, output, queryId, bucketName) {
  const marker = `_${bucketName}QueryId`;
  for (const item of items) {
    if (item[marker] === queryId) continue;
    item[marker] = queryId;
    output.push(item);
  }
}
function shouldClosePolyline(primitive) {
  const kind = String(primitive.kind || "");
  const filled = String(primitive.fill || "").toUpperCase() === "FILLED_SHAPE";
  if (filled || primitive.closed === true) return true;
  if (["polygon", "fill"].includes(kind)) return true;
  const points = primitive.pointsMm || [];
  if (points.length >= 3) {
    const first = points[0];
    const last = points[points.length - 1];
    return Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6;
  }
  return false;
}
function isElectricalFeature(feature) {
  return Boolean(feature?.netUid);
}
function isNetTrackingAnchor(feature) {
  const kind = String(feature?.kind || "");
  const role = String(feature?.semanticRole || "");
  if (kind === "pin" || kind === "pin_body") return true;
  if (kind === "label" || kind === "global_label" || kind === "hierarchical_label") return true;
  if (kind === "netclass_flag" || kind === "power_symbol" || kind === "power_port") return true;
  if (role === "label" || role === "global_label" || role === "hierarchical_label") return true;
  return false;
}
function netTrackingAnchorPriority(feature) {
  const kind = String(feature?.kind || "");
  const role = String(feature?.semanticRole || "");
  if (kind === "global_label" || role === "global_label") return 130;
  if (kind === "hierarchical_label" || role === "hierarchical_label") return 125;
  if (kind === "label" || role === "label") return 118;
  if (kind === "pin" || kind === "pin_body") return 106;
  if (kind === "power_symbol" || kind === "power_port" || kind === "netclass_flag") return 98;
  return 50;
}
function limitAnchorsForTracking(anchors) {
  if (anchors.length <= MAX_NET_TRACKING_ANCHORS_PER_PAGE) return anchors;
  const limited = anchors.slice(0, MAX_NET_TRACKING_ANCHORS_PER_PAGE);
  limited.sort((a, b) => a.source[1] - b.source[1] || a.source[0] - b.source[0]);
  return limited;
}
function representativeNetAnchor(page, anchors, selected = {}) {
  if (!page || !anchors?.length) return null;
  const selectedAnchor = selected.featureId || selected.stableKey || selected.sourceId ? anchors.find((anchor) => selected.featureId && Number(anchor.featureId || 0) === Number(selected.featureId) || selected.stableKey && anchor.stableKey === selected.stableKey || selected.sourceId && anchor.sourceId === selected.sourceId) : null;
  if (selectedAnchor) {
    return {
      ...selectedAnchor,
      kind: "selected-net-occurrence",
      priority: 200
    };
  }
  const preferred = anchors.filter((anchor) => anchor.priority >= 118).slice(0, 16);
  const candidates = preferred.length ? preferred : anchors.slice(0, 16);
  let x = 0;
  let y = 0;
  for (const anchor of candidates) {
    x += anchor.world[0];
    y += anchor.world[1];
  }
  const point = [x / candidates.length, y / candidates.length];
  return {
    pageId: page.id,
    featureId: candidates[0]?.featureId || 0,
    kind: "page-net-occurrence",
    source: [0, 0],
    world: point,
    bounds: [point[0], point[1], point[0], point[1]],
    priority: 1
  };
}
function nearestNeighborAnchorSegments(anchors, type, pageId) {
  if (!anchors || anchors.length < 2) return [];
  const remaining = anchors.map((anchor) => ({ ...anchor })).sort((a, b) => a.world[1] - b.world[1] || a.world[0] - b.world[0]);
  const segments = [];
  let current = remaining.shift();
  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const distance = Math.hypot(candidate.world[0] - current.world[0], candidate.world[1] - current.world[1]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    const next = remaining.splice(bestIndex, 1)[0];
    segments.push({
      type,
      pageId: pageId || current.pageId || next.pageId || "",
      a: current.world,
      b: next.world,
      sourceFeatureIds: [current.featureId, next.featureId].filter(Boolean)
    });
    current = next;
  }
  return segments;
}
function segmentWorldBounds(segment, pad = 0) {
  return [
    Math.min(segment.a[0], segment.b[0]) - pad,
    Math.min(segment.a[1], segment.b[1]) - pad,
    Math.max(segment.a[0], segment.b[0]) + pad,
    Math.max(segment.a[1], segment.b[1]) + pad
  ];
}
function featurePickPriority(feature) {
  const kind = String(feature?.kind || "");
  const semantic = String(feature?.semanticRole || "");
  const role = semantic || kind;
  if (role === "pin_number" || role === "pin_name") return 120;
  if (role === "pin_body" || kind === "pin") return 110;
  if (role === "symbol_reference" || role === "symbol_value") return 92;
  if (kind === "junction" || kind === "no_connect") return 88;
  if (kind === "wire" || kind === "bus" || kind === "bus_entry") return 78;
  if (role === "symbol_body" || kind === "symbol_body") return 45;
  if (kind === "symbol_instance" || kind === "symbol_overplot") return 30;
  if (kind === "text" || String(role).includes("text")) return 24;
  return 10;
}
function isBackgroundOrPageFeature(feature) {
  const kind = String(feature?.kind || "");
  const semantic = String(feature?.semanticRole || "");
  if (kind === "page" || kind === "sheet_header") return true;
  if (kind === "graphic_rect" && semantic === "graphic_rect" && !feature?.netUid && !feature?.componentUid) {
    const bounds = feature.boundsMm || [];
    return bounds[2] - bounds[0] > 150 && bounds[3] - bounds[1] > 120;
  }
  return false;
}
function parseColor(color) {
  if (!color || typeof color !== "string") return null;
  const value = color.trim();
  const match = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (!match) return null;
  const hex2 = match[1];
  const alpha = match[2] ?? "ff";
  return [
    parseInt(hex2.slice(0, 2), 16) / 255,
    parseInt(hex2.slice(2, 4), 16) / 255,
    parseInt(hex2.slice(4, 6), 16) / 255,
    parseInt(alpha, 16) / 255
  ];
}
function vectorColor(feature, primitiveKind, sourceColor = "") {
  const parsed = parseColor(sourceColor || feature?.color || "");
  if (feature?.dnp && ["symbol_reference", "symbol_value", "symbol_text"].includes(String(feature?.kind || ""))) {
    return [0.5, 0.52, 0.54, 0.56];
  }
  if (parsed) return parsed;
  if (feature?.dnp) return [0.5, 0.52, 0.54, 0.56];
  if (isElectricalFeature(feature)) return [0.12, 0.56, 0.2, 0.96];
  if (feature?.kind === "pin_name") return [0, 0.28, 0.31, 0.96];
  if (feature?.kind === "pin_number") return [0.45, 0.17, 0.16, 0.96];
  if (feature?.kind === "pin_body") return [0.28, 0.18, 0.18, 0.88];
  if (feature?.kind === "symbol_body" || feature?.kind === "symbol_instance") return [0.42, 0.18, 0.18, 0.72];
  if (feature?.kind === "symbol_reference" || feature?.kind === "symbol_value") return [0.05, 0.13, 0.16, 0.94];
  if (feature?.kind === "text" || String(primitiveKind || "").startsWith("text")) return [0.05, 0.13, 0.16, 0.94];
  return [0.16, 0.17, 0.19, 0.7];
}
function mutedVectorColor(feature, primitiveKind, sourceColor = "") {
  const color = vectorColor(feature, primitiveKind, sourceColor);
  return [color[0] * 0.72, color[1] * 0.72, color[2] * 0.72, Math.min(color[3], 0.38)];
}
function nativeStrokePixelWidth(feature, primitiveKind, selected) {
  if (selected) return 5.5;
  if (["pin_name", "pin_number"].includes(String(feature?.kind || ""))) return 1.5;
  if (feature?.kind === "pin_body") return 1.7;
  if (String(primitiveKind || "").startsWith("text")) return 1.35;
  if (primitiveKind === "bus" || feature?.kind === "bus") return 4.2;
  if (isElectricalFeature(feature)) return 2.6;
  if (feature?.kind === "symbol_body" || feature?.kind === "symbol_instance" || feature?.kind === "sheet") return 1.5;
  return 1.25;
}
function writeVectorVertex(values, offset, point, color) {
  values[offset++] = point[0];
  values[offset++] = point[1];
  values[offset++] = color[0];
  values[offset++] = color[1];
  values[offset++] = color[2];
  values[offset++] = color[3];
  return offset;
}
function writeStrokeQuad(values, offset, a, b, width, color) {
  const quad = strokeQuadPoints(a, b, width);
  if (!quad) return offset;
  for (const point of quad) offset = writeVectorVertex(values, offset, point, color);
  return offset;
}
function writeFilledTriangle(values, offset, a, b, c, color) {
  offset = writeVectorVertex(values, offset, a, color);
  offset = writeVectorVertex(values, offset, b, color);
  offset = writeVectorVertex(values, offset, c, color);
  return offset;
}
function writeFlowVertex(values, offset, point, distancePx, kind) {
  values[offset++] = point[0];
  values[offset++] = point[1];
  values[offset++] = distancePx;
  values[offset++] = kind;
  return offset;
}
function writeFlowQuad(values, offset, a, b, width, kind, distanceStartPx, scale2) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length3 = Math.hypot(dx, dy);
  if (length3 < 1e-6 || offset + 24 > values.length) return offset;
  const half = width * 0.5;
  const tx = dx / length3;
  const ty = dy / length3;
  const nx = -ty * half;
  const ny = tx * half;
  const p0 = [a[0] + nx, a[1] + ny];
  const p1 = [a[0] - nx, a[1] - ny];
  const p2 = [b[0] + nx, b[1] + ny];
  const p3 = [b[0] - nx, b[1] - ny];
  const distanceEndPx = distanceStartPx + length3 / Math.max(scale2, 1e-6);
  offset = writeFlowVertex(values, offset, p0, distanceStartPx, kind);
  offset = writeFlowVertex(values, offset, p1, distanceStartPx, kind);
  offset = writeFlowVertex(values, offset, p2, distanceEndPx, kind);
  offset = writeFlowVertex(values, offset, p2, distanceEndPx, kind);
  offset = writeFlowVertex(values, offset, p1, distanceStartPx, kind);
  offset = writeFlowVertex(values, offset, p3, distanceEndPx, kind);
  return offset;
}
function strokeQuadPoints(a, b, width) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length3 = Math.hypot(dx, dy);
  if (length3 < 1e-6) return null;
  const half = width * 0.5;
  const tx = dx / length3 * half;
  const ty = dy / length3 * half;
  const nx = -dy / length3 * half;
  const ny = dx / length3 * half;
  const start = [a[0] - tx, a[1] - ty];
  const end = [b[0] + tx, b[1] + ty];
  const p0 = [start[0] + nx, start[1] + ny];
  const p1 = [start[0] - nx, start[1] - ny];
  const p2 = [end[0] + nx, end[1] + ny];
  const p3 = [end[0] - nx, end[1] - ny];
  return [p0, p1, p2, p2, p1, p3];
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
function clipSegmentOutsideBounds(segment, bounds) {
  const [left, top, right, bottom] = bounds;
  const [ax, ay] = segment.a;
  const [bx, by] = segment.b;
  const eps = 1e-6;
  const make = (a, b) => ({ ...segment, a, b });
  if (Math.abs(ay - by) <= eps) {
    const y = ay;
    if (y < top - eps || y > bottom + eps) return [segment];
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const overlapStart = Math.max(minX, left);
    const overlapEnd = Math.min(maxX, right);
    if (overlapEnd <= overlapStart + eps) return [segment];
    const parts = [];
    const ascending = ax <= bx;
    if (minX < overlapStart - eps) {
      const a = ascending ? [minX, y] : [overlapStart, y];
      const b = ascending ? [overlapStart, y] : [minX, y];
      parts.push(make(a, b));
    }
    if (overlapEnd < maxX - eps) {
      const a = ascending ? [overlapEnd, y] : [maxX, y];
      const b = ascending ? [maxX, y] : [overlapEnd, y];
      parts.push(make(a, b));
    }
    return parts;
  }
  if (Math.abs(ax - bx) <= eps) {
    const x = ax;
    if (x < left - eps || x > right + eps) return [segment];
    const minY = Math.min(ay, by);
    const maxY = Math.max(ay, by);
    const overlapStart = Math.max(minY, top);
    const overlapEnd = Math.min(maxY, bottom);
    if (overlapEnd <= overlapStart + eps) return [segment];
    const parts = [];
    const ascending = ay <= by;
    if (minY < overlapStart - eps) {
      const a = ascending ? [x, minY] : [x, overlapStart];
      const b = ascending ? [x, overlapStart] : [x, minY];
      parts.push(make(a, b));
    }
    if (overlapEnd < maxY - eps) {
      const a = ascending ? [x, overlapEnd] : [x, maxY];
      const b = ascending ? [x, maxY] : [x, overlapEnd];
      parts.push(make(a, b));
    }
    return parts;
  }
  return [segment];
}
function writePickVertex(view, index, point, featureId) {
  const offset = index * 12;
  view.setFloat32(offset, point[0], true);
  view.setFloat32(offset + 4, point[1], true);
  view.setUint32(offset + 8, featureId, true);
}
function writePickStrokeQuad(view, index, a, b, width, featureId) {
  const quad = strokeQuadPoints(a, b, width);
  if (!quad) return index;
  for (const point of quad) {
    writePickVertex(view, index, point, featureId);
    index += 1;
  }
  return index;
}
function writePickTriangle(view, index, a, b, c, featureId) {
  writePickVertex(view, index, a, featureId);
  writePickVertex(view, index + 1, b, featureId);
  writePickVertex(view, index + 2, c, featureId);
  return index + 3;
}

// viewer/src/svg-dom-schematic-renderer.js
var SVG_NS = "http://www.w3.org/2000/svg";
var UNSAFE_TAGS = /* @__PURE__ */ new Set(["script", "foreignobject", "iframe", "object", "embed"]);
var ID_REF_ATTRIBUTES = /* @__PURE__ */ new Set(["href", "xlink:href"]);
var DEFAULT_MAX_MOUNTED_WORLD_PAGES = 1;
var DEFAULT_MAX_CACHED_SVG_PAGES = 18;
var DEFAULT_PRELOAD_SVG_PAGES = 8;
var SvgDomSchematicRenderer = class _SvgDomSchematicRenderer {
  static create(host, manifestUrl, manifest, featuresByPage, callbacks = {}) {
    return new _SvgDomSchematicRenderer(host, manifestUrl, manifest, featuresByPage, callbacks);
  }
  constructor(host, manifestUrl, manifest, featuresByPage, callbacks) {
    this.host = host;
    this.manifestUrl = manifestUrl;
    this.manifest = manifest;
    this.featuresByPage = featuresByPage || {};
    this.callbacks = callbacks;
    this.activePage = null;
    this.activeSvgUrl = "";
    this.container = null;
    this.svg = null;
    this.overlay = null;
    this.mountedPages = /* @__PURE__ */ new Map();
    this.loadingPages = /* @__PURE__ */ new Map();
    this.svgCache = /* @__PURE__ */ new Map();
    this.serial = 0;
    this.maxMountedWorldPages = DEFAULT_MAX_MOUNTED_WORLD_PAGES;
    this.maxCachedSvgPages = DEFAULT_MAX_CACHED_SVG_PAGES;
    this.worldHandlersInstalled = false;
    this.worldDrag = null;
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.drag = null;
    this.selected = null;
    this.highlightedNetUid = "";
    this.index = emptyIndex();
    this.lastStats = {
      mountedPages: 0,
      domNodes: 0,
      indexedFeatures: 0,
      indexedNets: 0,
      mountMs: 0,
      coldMounts: 0,
      warmMounts: 0,
      highlightMs: 0,
      selectionMs: 0,
      cachedSvgPages: 0,
      cachedSvgBytes: 0,
      heapMb: null,
      fallbackReason: ""
    };
  }
  get active() {
    return Boolean(this.container && this.activePage);
  }
  get worldActive() {
    return this.mountedPages.size > 0;
  }
  stats() {
    return {
      ...this.lastStats,
      activePage: this.activePage?.name || [...this.mountedPages.values()][0]?.page?.name || "-",
      mountedPages: this.active ? 1 : this.mountedPages.size
    };
  }
  dispose() {
    this.unmountPage();
    this.unmountWorldPages();
  }
  unmountPage() {
    this.container?.remove();
    this.container = null;
    this.svg = null;
    this.overlay = null;
    this.activePage = null;
    this.activeSvgUrl = "";
    this.index = emptyIndex();
    this.host.hidden = true;
  }
  unmountWorldPages() {
    for (const entry of this.mountedPages.values()) entry.container.remove();
    this.mountedPages.clear();
    this.loadingPages.clear();
    if (!this.active) this.host.hidden = true;
  }
  async preloadPages(pages) {
    const started = performance.now();
    const results = await Promise.allSettled((pages || []).slice(0, DEFAULT_PRELOAD_SVG_PAGES).map((page) => this.loadSvgTemplate(page)));
    this.lastStats.preloadedPages = results.filter((result) => result.status === "fulfilled" && result.value).length;
    this.lastStats.preloadMs = performance.now() - started;
    this.updateCacheStats();
  }
  syncWorldPages(pages, worldRenderer, options = {}) {
    if (!worldRenderer) return;
    this.installWorldHandlers(worldRenderer);
    const visiblePages = (pages || []).slice(0, options.maxMountedPages || this.maxMountedWorldPages);
    const wanted = new Set(visiblePages.map((page) => page.id));
    for (const [pageId, entry] of this.mountedPages) {
      if (!wanted.has(pageId)) {
        entry.container.remove();
        this.mountedPages.delete(pageId);
      }
    }
    for (const page of visiblePages) {
      const entry = this.mountedPages.get(page.id);
      if (entry) {
        entry.lastUsed = ++this.serial;
        this.positionWorldEntry(entry, worldRenderer);
      } else if (!this.loadingPages.has(page.id)) {
        const promise = this.mountWorldPage(page).then((mounted) => {
          if (mounted && wanted.has(page.id)) this.positionWorldEntry(mounted, worldRenderer);
          else mounted?.container.remove();
        }).finally(() => this.loadingPages.delete(page.id));
        this.loadingPages.set(page.id, promise);
      }
    }
    this.pruneMountedWorldPages(wanted);
    this.host.hidden = visiblePages.length === 0 && !this.active;
    this.setSelection(this.selected);
    this.setHighlightedNet(options.activeNetUid ?? this.highlightedNetUid);
    this.lastStats.mountedPages = this.mountedPages.size;
    this.updateCacheStats();
  }
  async mountWorldPage(page) {
    const started = performance.now();
    const wasCached = this.hasCachedSvg(page);
    const imported = await this.loadImportedSvg(page);
    if (!imported) return null;
    const container = document.createElement("div");
    container.className = "svg-dom-page svg-dom-world-page";
    container.dataset.pageId = page.id;
    container.append(imported);
    this.host.append(container);
    const overlay = createOverlay(imported);
    const selectionOverlay = createSelectionOverlay(imported);
    const index = buildDomIndex(imported, page, this.featuresByPage[page.id] || []);
    const entry = {
      page,
      container,
      svg: imported,
      overlay,
      selectionOverlay,
      index,
      mountMs: performance.now() - started,
      lastUsed: ++this.serial,
      warm: wasCached
    };
    this.mountedPages.set(page.id, entry);
    this.lastStats = {
      ...this.lastStats,
      mountedPages: this.mountedPages.size,
      domNodes: [...this.mountedPages.values()].reduce((total, item) => total + item.svg.querySelectorAll("*").length, 0),
      indexedFeatures: [...this.mountedPages.values()].reduce((total, item) => total + item.index.featureToElements.size, 0),
      indexedNets: new Set([...this.mountedPages.values()].flatMap((item) => [...item.index.netToElements.keys()])).size,
      mountMs: entry.mountMs,
      coldMounts: this.lastStats.coldMounts + (entry.warm ? 0 : 1),
      warmMounts: this.lastStats.warmMounts + (entry.warm ? 1 : 0),
      fallbackReason: ""
    };
    this.updateCacheStats();
    return entry;
  }
  async loadImportedSvg(page) {
    const template = await this.loadSvgTemplate(page);
    if (!template) return null;
    return template.cloneNode(true);
  }
  async loadSvgTemplate(page) {
    const svgUrl = this.svgUrlForPage(page);
    const cached = this.svgCache.get(svgUrl);
    if (cached?.template) {
      cached.lastUsed = ++this.serial;
      return cached.template;
    }
    if (cached?.promise) return cached.promise;
    const started = performance.now();
    const promise = (async () => {
      const response = await fetch(svgUrl, { cache: "default" });
      if (!response.ok) {
        this.lastStats.fallbackReason = `Failed to load SVG page ${page.id}: ${response.status}`;
        this.callbacks.onFallback?.(this.lastStats.fallbackReason);
        return null;
      }
      const svgText = await response.text();
      const parser = new DOMParser();
      const svgDocument = parser.parseFromString(svgText, "image/svg+xml");
      const svg = svgDocument.documentElement;
      if (!svg || svg.localName.toLowerCase() !== "svg" || svgDocument.querySelector("parsererror")) {
        this.lastStats.fallbackReason = `Invalid SVG for page ${page.id}`;
        this.callbacks.onFallback?.(this.lastStats.fallbackReason);
        return null;
      }
      sanitizeSvgDocument(svgDocument, svgUrl, page.id);
      const imported = document.importNode(svg, true);
      imported.classList.add("svg-dom-page-svg");
      ensureSvgStyle(imported);
      const entry = this.svgCache.get(svgUrl) || {};
      Object.assign(entry, {
        template: imported,
        promise: null,
        pageId: page.id,
        byteLength: svgText.length * 2,
        loadMs: performance.now() - started,
        lastUsed: ++this.serial
      });
      this.svgCache.set(svgUrl, entry);
      this.pruneSvgCache();
      this.updateCacheStats();
      return imported;
    })();
    this.svgCache.set(svgUrl, {
      promise,
      pageId: page.id,
      byteLength: 0,
      loadMs: 0,
      lastUsed: ++this.serial
    });
    return promise;
  }
  svgUrlForPage(page) {
    return new URL(page.svg || page.thumbnail?.path, this.manifestUrl).toString();
  }
  positionWorldEntry(entry, worldRenderer) {
    const { page, container } = entry;
    const [x0, y0] = worldRenderer.worldToScreen(page.worldX, page.worldY);
    const [x1, y1] = worldRenderer.worldToScreen(page.worldX + page.widthMm, page.worldY + page.heightMm);
    const width = Math.max(1, x1 - x0);
    const height = Math.max(1, y1 - y0);
    container.style.transform = `translate3d(${x0}px, ${y0}px, 0)`;
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
  }
  installWorldHandlers(worldRenderer) {
    if (this.worldHandlersInstalled) return;
    this.worldHandlersInstalled = true;
    const target = this.host;
    target.oncontextmenu = (event) => event.preventDefault();
    target.onpointerdown = (event) => {
      const allowTextSelection = event.button === 0 && !event.shiftKey && Boolean(event.target.closest?.("text"));
      const featureElement = event.target.closest?.("[data-feature-key]");
      const fallbackFeature = featureElement ? null : this.featureAtEvent(event);
      this.worldDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        button: event.button,
        moved: false,
        pan: !allowTextSelection && (event.button === 0 || event.button === 1 || event.shiftKey),
        allowTextSelection
      };
      if (!allowTextSelection) target.setPointerCapture(event.pointerId);
    };
    target.onpointermove = (event) => {
      if (!this.worldDrag || this.worldDrag.pointerId !== event.pointerId) return;
      const dx = event.clientX - this.worldDrag.lastX;
      const dy = event.clientY - this.worldDrag.lastY;
      this.worldDrag.lastX = event.clientX;
      this.worldDrag.lastY = event.clientY;
      if (Math.hypot(event.clientX - this.worldDrag.startX, event.clientY - this.worldDrag.startY) > 3) {
        this.worldDrag.moved = true;
      }
      if (this.worldDrag.pan) worldRenderer.pan(dx, dy);
    };
    target.onpointerup = (event) => {
      if (!this.worldDrag || this.worldDrag.pointerId !== event.pointerId) return;
      const drag = this.worldDrag;
      this.worldDrag = null;
      if (!drag.allowTextSelection) target.releasePointerCapture(event.pointerId);
      if (drag.button !== 0) return;
      if (drag.moved) return;
      const element = event.target.closest?.("[data-feature-key]");
      if (element) this.selectElement(element, event);
      else {
        const hit = this.featureAtEvent(event);
        if (hit) this.selectFeature(hit.entry, hit.feature, event);
        else this.callbacks.onBlank?.();
      }
    };
    target.ondblclick = (event) => {
      const element = event.target.closest?.("[data-feature-key]");
      const hit = element ? null : this.featureAtEvent(event);
      const entry = hit?.entry || this.entryForPoint(event.clientX, event.clientY);
      const selection = element ? this.selectionFromElement(element) : hit ? this.selectionFromFeature(hit.entry, hit.feature) : this.selected;
      if (isSheetSelection(selection)) this.callbacks.onOpenPage?.(selection);
      else if (selection?.netUid) this.callbacks.onHighlightNet?.(selection.netUid, selection);
      else if (!hit && entry?.page) this.callbacks.onOpenPage?.({ kind: "page", pageId: entry.page.id, page: entry.page });
    };
    target.onwheel = (event) => {
      event.preventDefault();
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 0.65) {
        worldRenderer.pan(-event.deltaX, -event.deltaY);
      } else {
        worldRenderer.zoom(event.deltaY, event.clientX, event.clientY);
      }
    };
  }
  async focusPage(page, options = {}) {
    if (!page) return false;
    if (this.activePage?.id === page.id && this.active) {
      if (options.frame !== false) this.fitPage();
      return true;
    }
    const started = performance.now();
    const imported = await this.loadImportedSvg(page);
    if (!imported) return false;
    const container = document.createElement("div");
    container.className = "svg-dom-page";
    container.append(imported);
    this.host.replaceChildren(container);
    this.host.hidden = false;
    this.container = container;
    this.svg = imported;
    this.activePage = page;
    this.activeSvgUrl = new URL(page.svg || page.thumbnail?.path, this.manifestUrl).toString();
    this.overlay = createOverlay(imported);
    this.selectionOverlay = createSelectionOverlay(imported);
    this.index = buildDomIndex(imported, page, this.featuresByPage[page.id] || []);
    this.installPageHandlers();
    this.fitPage();
    this.setSelection(this.selected);
    this.setHighlightedNet(this.highlightedNetUid);
    this.lastStats = {
      ...this.lastStats,
      mountedPages: 1,
      domNodes: imported.querySelectorAll("*").length,
      indexedFeatures: this.index.featureToElements.size,
      indexedNets: this.index.netToElements.size,
      mountMs: performance.now() - started,
      fallbackReason: ""
    };
    this.updateCacheStats();
    return true;
  }
  installPageHandlers() {
    const target = this.host;
    target.oncontextmenu = (event) => event.preventDefault();
    target.onpointerdown = (event) => {
      if (!this.active) return;
      const allowTextSelection = event.button === 0 && !event.shiftKey && Boolean(event.target.closest?.("text"));
      const featureElement = event.target.closest?.("[data-feature-key]");
      const fallbackFeature = featureElement ? null : this.featureAtEvent(event);
      this.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        button: event.button,
        moved: false,
        pan: !allowTextSelection && (event.button === 0 || event.button === 1 || event.shiftKey),
        featureElement,
        allowTextSelection
      };
      if (!allowTextSelection) target.setPointerCapture(event.pointerId);
    };
    target.onpointermove = (event) => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - this.drag.lastX;
      const dy = event.clientY - this.drag.lastY;
      this.drag.lastX = event.clientX;
      this.drag.lastY = event.clientY;
      if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 3) {
        this.drag.moved = true;
      }
      if (this.drag.pan) {
        this.view.tx += dx;
        this.view.ty += dy;
        this.applyTransform();
      }
    };
    target.onpointerup = (event) => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      const drag = this.drag;
      this.drag = null;
      if (!drag.allowTextSelection) target.releasePointerCapture(event.pointerId);
      if (drag.button !== 0) return;
      if (drag.moved) return;
      const element = event.target.closest?.("[data-feature-key]");
      if (element) this.selectElement(element, event);
      else {
        const hit = this.featureAtEvent(event);
        if (hit) this.selectFeature(hit.entry, hit.feature, event);
        else this.callbacks.onBlank?.();
      }
    };
    target.ondblclick = (event) => {
      const element = event.target.closest?.("[data-feature-key]");
      const hit = element ? null : this.featureAtEvent(event);
      const selection = element ? this.selectionFromElement(element) : hit ? this.selectionFromFeature(hit.entry, hit.feature) : this.selected;
      if (isSheetSelection(selection)) this.callbacks.onOpenPage?.(selection);
      else if (selection?.netUid) this.callbacks.onHighlightNet?.(selection.netUid, selection);
      else if (!hit && this.activePage) this.callbacks.onOpenPage?.({ kind: "page", pageId: this.activePage.id, page: this.activePage });
    };
    target.onwheel = (event) => {
      event.preventDefault();
      if (!this.active) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 0.65) {
        this.view.tx -= event.deltaX;
        this.view.ty -= event.deltaY;
        this.applyTransform();
        return;
      }
      const rect = this.host.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const before = this.screenToSvg(localX, localY);
      const factor = Math.exp(-event.deltaY * 16e-4);
      this.view.scale = clamp2(this.view.scale * factor, 0.02, 80);
      this.view.tx = localX - before[0] * this.view.scale;
      this.view.ty = localY - before[1] * this.view.scale;
      this.applyTransform();
    };
  }
  selectElement(element, event) {
    const started = performance.now();
    const selection = this.selectionFromElement(element);
    this.setSelection(selection);
    if (event) {
      const rect = this.host.getBoundingClientRect();
      selection.anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    this.callbacks.onSelect?.(selection);
    this.lastStats.selectionMs = performance.now() - started;
  }
  selectFeature(entry, feature, event) {
    const started = performance.now();
    const selection = this.selectionFromFeature(entry, feature);
    this.setSelection(selection);
    if (event) {
      const rect = this.host.getBoundingClientRect();
      selection.anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    this.callbacks.onSelect?.(selection);
    this.lastStats.selectionMs = performance.now() - started;
  }
  selectionFromElement(element) {
    const featureKey = element.dataset.featureKey || "";
    const entry = this.entryForElement(element);
    const feature = entry.index.featureByKey.get(featureKey) || {};
    return this.selectionFromFeature(entry, feature, element);
  }
  selectionFromFeature(entry, feature, element = null) {
    const featureKey = feature?.stableKey || element?.dataset?.featureKey || "";
    const page = entry?.page || this.activePage;
    const kind = feature?.kind || element?.dataset?.role || element?.dataset?.primitive || "feature";
    const netUid = feature?.netUid || element?.dataset?.netUid || "";
    const netName = feature?.netName || element?.dataset?.netName || "";
    if (kind === "sheet") {
      return {
        kind: "sheet",
        featureKey,
        sheetInstancePath: feature?.sheetInstancePath || page?.sheetInstancePath || "",
        sourceId: feature?.sourceId || element?.dataset?.sourceId || element?.dataset?.objectId || element?.dataset?.uuid || "",
        sheetName: feature?.sheet_name || feature?.sheetName || element?.dataset?.sheetName || feature?.objectId || "",
        sheetFile: feature?.sheet_file || feature?.sheetFile || element?.dataset?.sheetFile || "",
        feature
      };
    }
    if (kind === "pin" || kind === "pin_body" || kind === "pin_name" || kind === "pin_number" || element?.dataset?.pin) {
      return {
        kind: "pin",
        featureKey,
        sheetInstancePath: feature?.sheetInstancePath || page?.sheetInstancePath || "",
        sourceId: feature?.sourceId || element?.dataset?.sourceId || element?.dataset?.objectId || element?.dataset?.uuid || "",
        symbolUuid: feature?.symbolUuid || element?.dataset?.symbolUuid || "",
        reference: feature?.reference || element?.dataset?.designator || element?.dataset?.component || element?.dataset?.ref || "",
        pinNumber: feature?.pinNumber || element?.dataset?.pin || "",
        pinName: feature?.pinName || "",
        netUid,
        netName,
        feature
      };
    }
    if (kind === "symbol_body" || kind === "symbol_instance" || kind === "component" || element?.dataset?.ref) {
      return {
        kind: "component",
        featureKey,
        sheetInstancePath: feature?.sheetInstancePath || page?.sheetInstancePath || "",
        sourceId: feature?.sourceId || element?.dataset?.sourceId || element?.dataset?.objectId || element?.dataset?.uuid || "",
        symbolUuid: feature?.symbolUuid || element?.dataset?.symbolUuid || "",
        reference: feature?.reference || element?.dataset?.designator || element?.dataset?.component || element?.dataset?.ref || "",
        netUid,
        netName,
        feature
      };
    }
    return {
      kind: netUid ? "feature" : kind,
      featureKey,
      sheetInstancePath: feature?.sheetInstancePath || page?.sheetInstancePath || "",
      sourceId: feature?.sourceId || element?.dataset?.sourceId || element?.dataset?.objectId || element?.dataset?.uuid || "",
      role: kind,
      netUid,
      netName,
      feature
    };
  }
  setSelection(selection) {
    this.selected = selection || null;
    for (const element of this.host.querySelectorAll(".prism-svg-selected")) {
      element.classList.remove("prism-svg-selected");
    }
    for (const overlay of this.host.querySelectorAll("[data-prism-overlay='selection']")) {
      overlay.replaceChildren();
    }
    const featureKey = selection?.featureKey || "";
    if (!featureKey) return;
    for (const entry of this.entries()) {
      for (const element of entry.index.featureToElements.get(featureKey) || []) {
        element.classList.add("prism-svg-selected");
      }
      this.drawSelectionOverlay(entry, selection);
    }
    for (const element of this.index.featureToElements.get(featureKey) || []) {
      element.classList.add("prism-svg-selected");
    }
    this.drawSelectionOverlay({ page: this.activePage, index: this.index, selectionOverlay: this.selectionOverlay }, selection);
  }
  setHighlightedNet(netUid) {
    this.highlightedNetUid = netUid || "";
    const started = performance.now();
    for (const entry of this.entries()) this.updateEntryHighlight(entry);
    if (!this.svg || !this.overlay) {
      this.lastStats.highlightMs = performance.now() - started;
      return;
    }
    this.updateEntryHighlight({ svg: this.svg, overlay: this.overlay, index: this.index, page: this.activePage });
    this.lastStats.highlightMs = performance.now() - started;
  }
  updateEntryHighlight(entry) {
    if (!entry?.svg || !entry?.overlay) return;
    entry.overlay.replaceChildren();
    if (!this.highlightedNetUid) {
      return;
    }
    const viewBox = svgViewBox(entry.svg, entry.page);
    const dimmer = document.createElementNS(SVG_NS, "rect");
    dimmer.setAttribute("x", String(viewBox[0]));
    dimmer.setAttribute("y", String(viewBox[1]));
    dimmer.setAttribute("width", String(viewBox[2]));
    dimmer.setAttribute("height", String(viewBox[3]));
    dimmer.setAttribute("class", "prism-svg-net-dimmer");
    entry.overlay.append(dimmer);
    const elements = entry.index.netToElements.get(this.highlightedNetUid) || [];
    const limited = elements.slice(0, 2200);
    for (const element of limited) {
      const overlayElement = overlayClone(element);
      entry.overlay.append(overlayElement);
    }
  }
  entries() {
    return [...this.mountedPages.values()];
  }
  entryForElement(element) {
    const container = element.closest?.(".svg-dom-page");
    const pageId = container?.dataset.pageId || "";
    return this.mountedPages.get(pageId) || {
      page: this.activePage,
      index: this.index,
      svg: this.svg,
      overlay: this.overlay,
      selectionOverlay: this.selectionOverlay
    };
  }
  featureAtEvent(event) {
    const entry = this.entryForPoint(event.clientX, event.clientY);
    if (!entry) return null;
    const point = this.clientToSvg(entry, event.clientX, event.clientY);
    if (!point) return null;
    const tolerance = Math.max(0.18, 5 * svgUnitsPerCssPixel(entry));
    const candidates = entry.index.features.filter((feature2) => (feature2?.domBoundsMm || feature2?.boundsMm) && isSelectableFeature(feature2)).filter((feature2) => point[0] >= (feature2.domBoundsMm || feature2.boundsMm)[0] - tolerance && point[0] <= (feature2.domBoundsMm || feature2.boundsMm)[2] + tolerance && point[1] >= (feature2.domBoundsMm || feature2.boundsMm)[1] - tolerance && point[1] <= (feature2.domBoundsMm || feature2.boundsMm)[3] + tolerance).map((feature2) => ({
      feature: feature2,
      priority: featurePriority(feature2),
      area: Math.max(
        1e-4,
        ((feature2.domBoundsMm || feature2.boundsMm)[2] - (feature2.domBoundsMm || feature2.boundsMm)[0]) * ((feature2.domBoundsMm || feature2.boundsMm)[3] - (feature2.domBoundsMm || feature2.boundsMm)[1])
      )
    })).sort((a, b) => b.priority - a.priority || a.area - b.area);
    const feature = candidates[0]?.feature;
    return feature ? { entry, feature, point } : null;
  }
  entryForPoint(clientX, clientY) {
    for (const entry of [...this.entries()].reverse()) {
      const rect = entry.container.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return entry;
    }
    if (this.container) {
      const rect = this.container.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return { page: this.activePage, container: this.container, svg: this.svg, index: this.index, selectionOverlay: this.selectionOverlay };
      }
    }
    return null;
  }
  clientToSvg(entry, clientX, clientY) {
    if (!entry?.container || !entry?.svg || !entry?.page) return null;
    const rect = entry.container.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const viewBox = svgViewBox(entry.svg, entry.page);
    return [
      viewBox[0] + (clientX - rect.left) / rect.width * viewBox[2],
      viewBox[1] + (clientY - rect.top) / rect.height * viewBox[3]
    ];
  }
  drawSelectionOverlay(entry, selection) {
    if (!entry?.selectionOverlay || !selection?.featureKey) return;
    const feature = entry.index.featureByKey.get(selection.featureKey);
    const bounds = feature?.domBoundsMm || feature?.boundsMm;
    if (!bounds) return;
    const [x0, y0, x1, y1] = bounds;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x0));
    rect.setAttribute("y", String(y0));
    rect.setAttribute("width", String(Math.max(1e-3, x1 - x0)));
    rect.setAttribute("height", String(Math.max(1e-3, y1 - y0)));
    rect.setAttribute("rx", "0.65");
    rect.setAttribute("ry", "0.65");
    rect.setAttribute("class", "prism-svg-selection-box");
    entry.selectionOverlay.append(rect);
  }
  fitPage() {
    if (!this.svg || !this.activePage) return;
    const viewBox = svgViewBox(this.svg, this.activePage);
    const width = viewBox[2] || this.activePage.sourceWidthMm || this.activePage.widthMm || 1;
    const height = viewBox[3] || this.activePage.sourceHeightMm || this.activePage.heightMm || 1;
    const rect = this.host.getBoundingClientRect();
    const scale2 = Math.min(rect.width / width, rect.height / height) * 0.92;
    this.view.scale = clamp2(scale2, 0.02, 80);
    this.view.tx = (rect.width - width * this.view.scale) / 2 - viewBox[0] * this.view.scale;
    this.view.ty = (rect.height - height * this.view.scale) / 2 - viewBox[1] * this.view.scale;
    this.applyTransform();
  }
  frameSelection(selection = this.selected) {
    if (!selection?.featureKey || !this.active) {
      this.fitPage();
      return;
    }
    const elements = this.index.featureToElements.get(selection.featureKey) || [];
    const bounds = elementBounds(elements);
    if (!bounds) return;
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, bounds[2] - bounds[0]);
    const height = Math.max(1, bounds[3] - bounds[1]);
    const scale2 = Math.min(rect.width / width, rect.height / height) * 0.36;
    this.view.scale = clamp2(scale2, 0.04, 80);
    this.view.tx = rect.width / 2 - (bounds[0] + bounds[2]) / 2 * this.view.scale;
    this.view.ty = rect.height / 2 - (bounds[1] + bounds[3]) / 2 * this.view.scale;
    this.applyTransform();
  }
  pan(dx, dy) {
    if (!this.active) return;
    this.view.tx += dx;
    this.view.ty += dy;
    this.applyTransform();
  }
  zoom(deltaY, clientX, clientY) {
    if (!this.active) return;
    const rect = this.host.getBoundingClientRect();
    const localX = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const localY = (clientY ?? rect.top + rect.height / 2) - rect.top;
    const before = this.screenToSvg(localX, localY);
    const factor = Math.exp(-deltaY * 16e-4);
    this.view.scale = clamp2(this.view.scale * factor, 0.02, 80);
    this.view.tx = localX - before[0] * this.view.scale;
    this.view.ty = localY - before[1] * this.view.scale;
    this.applyTransform();
  }
  screenToSvg(x, y) {
    return [
      (x - this.view.tx) / Math.max(1e-6, this.view.scale),
      (y - this.view.ty) / Math.max(1e-6, this.view.scale)
    ];
  }
  applyTransform() {
    if (!this.container) return;
    this.container.style.transform = `translate3d(${this.view.tx}px, ${this.view.ty}px, 0) scale(${this.view.scale})`;
  }
  hasCachedSvg(page) {
    const entry = this.svgCache.get(this.svgUrlForPage(page));
    return Boolean(entry?.template);
  }
  pruneMountedWorldPages(wanted = /* @__PURE__ */ new Set()) {
    if (this.mountedPages.size <= this.maxMountedWorldPages) return;
    const candidates = [...this.mountedPages.entries()].filter(([pageId]) => !wanted.has(pageId)).sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    for (const [pageId, entry] of candidates) {
      if (this.mountedPages.size <= this.maxMountedWorldPages) break;
      entry.container.remove();
      this.mountedPages.delete(pageId);
    }
  }
  pruneSvgCache() {
    const entries = [...this.svgCache.entries()].filter(([, entry]) => entry?.template);
    if (entries.length <= this.maxCachedSvgPages) return;
    const mountedUrls = new Set([...this.mountedPages.values()].map((entry) => this.svgUrlForPage(entry.page)));
    if (this.activePage) mountedUrls.add(this.svgUrlForPage(this.activePage));
    const candidates = entries.filter(([url]) => !mountedUrls.has(url)).sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    for (const [url] of candidates) {
      if ([...this.svgCache.values()].filter((entry) => entry?.template).length <= this.maxCachedSvgPages) break;
      this.svgCache.delete(url);
    }
  }
  updateCacheStats() {
    const cached = [...this.svgCache.values()].filter((entry) => entry?.template);
    this.lastStats.cachedSvgPages = cached.length;
    this.lastStats.cachedSvgBytes = cached.reduce((total, entry) => total + (entry.byteLength || 0), 0);
    const memory = performance?.memory;
    this.lastStats.heapMb = memory?.usedJSHeapSize ? memory.usedJSHeapSize / 1048576 : null;
  }
};
function sanitizeSvgDocument(document2, svgUrl, pageId) {
  for (const element of [...document2.querySelectorAll("*")]) {
    if (UNSAFE_TAGS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name;
      const lower = name.toLowerCase();
      const value = attribute.value || "";
      if (lower.startsWith("on")) {
        element.removeAttribute(name);
        continue;
      }
      if ((lower === "href" || lower === "xlink:href" || lower === "src") && isUnsafeUrl(value)) {
        if ((lower === "href" || lower === "xlink:href") && element.localName.toLowerCase() === "image" && isSafeImageDataUrl(value)) {
          continue;
        }
        element.removeAttribute(name);
        continue;
      }
      if (lower === "style") {
        element.setAttribute(name, stripUnsafeCssUrls(value));
      }
    }
  }
  const prefix = `prism-${slug(pageId)}-`;
  const idMap = /* @__PURE__ */ new Map();
  for (const element of document2.querySelectorAll("[id]")) {
    const oldId = element.getAttribute("id");
    const newId = `${prefix}${slug(oldId)}`;
    idMap.set(oldId, newId);
    element.setAttribute("id", newId);
  }
  for (const element of document2.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const lower = attribute.name.toLowerCase();
      let value = attribute.value || "";
      if (ID_REF_ATTRIBUTES.has(lower)) {
        if (value.startsWith("#") && idMap.has(value.slice(1))) {
          value = `#${idMap.get(value.slice(1))}`;
        } else if (isRelativeResourceUrl(value)) {
          value = new URL(value, svgUrl).toString();
        }
      }
      value = rewriteLocalRefs(value, idMap);
      element.setAttribute(attribute.name, value);
    }
  }
}
function buildDomIndex(svg, page, features) {
  const bySource = /* @__PURE__ */ new Map();
  const byStableKey = /* @__PURE__ */ new Map();
  const byId = /* @__PURE__ */ new Map();
  const normalizedFeatures = [];
  for (const feature of features) {
    const normalized = normalizeFeature(feature, page);
    normalizedFeatures.push(normalized);
    byStableKey.set(normalized.stableKey, normalized);
    byId.set(Number(normalized.id || 0), normalized);
    for (const key of sourceKeys(normalized)) {
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(normalized);
    }
  }
  const featureToElements = /* @__PURE__ */ new Map();
  const netToElements = /* @__PURE__ */ new Map();
  const featureByKey = /* @__PURE__ */ new Map();
  for (const feature of normalizedFeatures) {
    featureByKey.set(feature.stableKey, feature);
  }
  for (const element of svg.querySelectorAll("[data-uuid], [data-element-key], [data-primitive], [data-ref], [data-pin], [data-object-id], [data-designator], [data-component]")) {
    const feature = matchFeature(element, bySource, page);
    if (feature && !isSelectableFeature(feature)) continue;
    if (!feature && !isSelectableElement(element)) continue;
    const fallbackKey = stableFallbackKey(element, page);
    const stableKey = feature?.stableKey || fallbackKey;
    const netUid = feature?.netUid || "";
    const netName = feature?.netName || "";
    element.classList.add("prism-feature");
    element.dataset.featureKey = stableKey;
    element.dataset.sourceId = feature?.sourceId || element.dataset.uuid || element.dataset.elementKey || "";
    element.dataset.role = feature?.kind || element.dataset.primitive || element.dataset.ref || "feature";
    if (feature?.id) element.dataset.featureId = String(feature.id);
    if (netUid) element.dataset.netUid = netUid;
    if (netName) element.dataset.netName = netName;
    if (!element.id) element.id = `prism-feature-${slug(stableKey)}`;
    addToMap(featureToElements, stableKey, element);
    featureByKey.set(stableKey, feature || {
      id: 0,
      stableKey,
      kind: element.dataset.role,
      sourceId: element.dataset.sourceId,
      sheetInstancePath: page.sheetInstancePath || ""
    });
    if (netUid) addToMap(netToElements, netUid, element);
  }
  for (const [stableKey, elements] of featureToElements) {
    const feature = featureByKey.get(stableKey);
    const bounds = elementBounds(elements);
    if (feature && bounds) feature.domBoundsMm = mergeBounds(feature.boundsMm, bounds);
  }
  return { featureToElements, netToElements, featureByKey, byId, bySource, features: normalizedFeatures };
}
function matchFeature(element, bySource, page) {
  const keys = [
    element.dataset.uuid,
    element.dataset.elementKey,
    element.dataset.sourceId,
    element.dataset.objectId,
    element.dataset.componentUid,
    element.dataset.componentUuid,
    element.dataset.ref && `${element.dataset.ref}:${element.dataset.pin || ""}`
  ].filter(Boolean);
  const candidates = keys.flatMap((key) => bySource.get(key) || []);
  if (!candidates.length) return null;
  const role = String(element.dataset.primitive || element.dataset.ref || element.dataset.pin || "").toLowerCase();
  return candidates.map((feature) => ({ feature, score: featureMatchScore(feature, role, page) })).sort((a, b) => b.score - a.score)[0].feature;
}
function featureMatchScore(feature, role, page) {
  let score = 0;
  const kind = String(feature.kind || "").toLowerCase();
  if (feature.sheetInstancePath === page.sheetInstancePath) score += 20;
  if (feature.netUid) score += 4;
  if (role && kind.includes(role)) score += 8;
  if (role === "symbol" && kind === "symbol_body") score += 12;
  if ((role === "label" || role === "port") && (kind.includes("label") || kind.includes("port"))) score += 12;
  if (role === "sheet" && kind === "sheet") score += 12;
  if (kind !== "record") score += 2;
  if (kind.includes("pin")) score += 2;
  return score;
}
function normalizeFeature(feature, page) {
  const sourceId = feature.sourceId || feature.sourceUid || feature.uuid || feature.objectId || feature.stableKey || "";
  return {
    ...feature,
    id: Number(feature.id || 0),
    sourceId,
    stableKey: feature.stableKey || `${page.sheetInstancePath || page.id}|${sourceId}|0|${feature.kind || "feature"}|0`,
    sheetInstancePath: feature.sheetInstancePath || page.sheetInstancePath || ""
  };
}
function sourceKeys(feature) {
  const keys = new Set([
    feature.sourceId,
    feature.sourceUid,
    feature.uuid,
    feature.objectId,
    feature.stableKey
  ].filter(Boolean).map(String));
  if (feature.reference && feature.pinNumber) keys.add(`${feature.reference}:${feature.pinNumber}`);
  if (feature.componentDesignator) keys.add(feature.componentDesignator);
  if (feature.reference) keys.add(feature.reference);
  return [...keys];
}
function stableFallbackKey(element, page) {
  const source = element.dataset.uuid || element.dataset.elementKey || element.dataset.objectId || element.dataset.ref || element.id || "svg";
  const role = element.dataset.primitive || element.dataset.role || element.localName || "feature";
  return `${page.sheetInstancePath || page.id}|${source}|0|${role}|0`;
}
function ensureSvgStyle(svg) {
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = `
    .prism-feature { cursor: pointer; }
    .prism-svg-selected { outline: none; filter: drop-shadow(0 0 2.4px rgba(59,130,246,0.98)); }
    .prism-svg-selection-box {
      fill: rgba(59, 130, 246, 0.12);
      stroke: #3b82f6;
      stroke-width: 0.38mm;
      stroke-dasharray: 1.4 0.7;
      vector-effect: non-scaling-stroke;
      pointer-events: none;
    }
    .prism-svg-net-dimmer { fill: rgba(10, 14, 22, 0.055); pointer-events: none; }
    .prism-svg-net-overlay { pointer-events: none; }
    .prism-svg-net-overlay * {
      stroke: #18ef52 !important;
      fill: none !important;
      stroke-width: 0.34mm !important;
      vector-effect: non-scaling-stroke;
      opacity: 0.98;
    }
  `;
  svg.prepend(style);
}
function createOverlay(svg) {
  const overlay = document.createElementNS(SVG_NS, "g");
  overlay.setAttribute("class", "prism-svg-net-overlay");
  overlay.setAttribute("data-prism-overlay", "net-highlight");
  svg.append(overlay);
  return overlay;
}
function createSelectionOverlay(svg) {
  const overlay = document.createElementNS(SVG_NS, "g");
  overlay.setAttribute("class", "prism-svg-selection-overlay");
  overlay.setAttribute("data-prism-overlay", "selection");
  overlay.style.pointerEvents = "none";
  svg.append(overlay);
  return overlay;
}
function overlayClone(element) {
  const clone = element.cloneNode(true);
  clone.removeAttribute("id");
  clone.removeAttribute("data-feature-key");
  clone.removeAttribute("data-net-uid");
  clone.removeAttribute("data-net-name");
  clone.classList.add("prism-svg-net-overlay-clone");
  for (const node of [clone, ...Array.from(clone.querySelectorAll?.("*") || [])]) {
    if (node instanceof SVGElement) {
      node.removeAttribute("filter");
      node.style.pointerEvents = "none";
      node.style.stroke = "#18ef52";
      node.style.fill = "none";
      node.style.opacity = "0.98";
      node.style.vectorEffect = "non-scaling-stroke";
    }
  }
  return clone;
}
function elementBounds(elements) {
  let bounds = null;
  for (const element of elements) {
    if (!element.getBBox) continue;
    try {
      const box = element.getBBox();
      const next = [box.x, box.y, box.x + box.width, box.y + box.height];
      bounds = bounds ? [
        Math.min(bounds[0], next[0]),
        Math.min(bounds[1], next[1]),
        Math.max(bounds[2], next[2]),
        Math.max(bounds[3], next[3])
      ] : next;
    } catch {
    }
  }
  return bounds;
}
function mergeBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3])
  ];
}
function svgViewBox(svg, page) {
  const value = svg.getAttribute("viewBox");
  if (value) {
    const parts = value.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) return parts;
  }
  return [0, 0, page.sourceWidthMm || page.widthMm || 1, page.sourceHeightMm || page.heightMm || 1];
}
function emptyIndex() {
  return {
    featureToElements: /* @__PURE__ */ new Map(),
    netToElements: /* @__PURE__ */ new Map(),
    featureByKey: /* @__PURE__ */ new Map(),
    byId: /* @__PURE__ */ new Map(),
    bySource: /* @__PURE__ */ new Map(),
    features: []
  };
}
function svgUnitsPerCssPixel(entry) {
  const rect = entry?.container?.getBoundingClientRect?.();
  if (!entry?.svg || !entry?.page || !rect?.width || !rect?.height) return 0.1;
  const viewBox = svgViewBox(entry.svg, entry.page);
  return Math.max(viewBox[2] / rect.width, viewBox[3] / rect.height);
}
function isBackgroundFeature(feature) {
  const kind = String(feature?.kind || "").toLowerCase();
  const role = String(feature?.semanticRole || "").toLowerCase();
  const source = String(`${feature?.sourceId || ""} ${feature?.objectId || ""} ${feature?.text || ""}`).toLowerCase();
  return kind.includes("page") || role.includes("page") || kind.includes("background") || role.includes("background") || source.includes("background") || source.includes("sheet_header") || source.includes("sheet header") || source.includes("drawing-sheet");
}
function featurePriority(feature) {
  const kind = String(feature?.kind || feature?.semanticRole || "").toLowerCase();
  if (kind.includes("pin")) return 90;
  if (kind.includes("label") || kind.includes("port")) return 78;
  if (kind.includes("wire") || kind.includes("bus") || kind.includes("junction")) return 70;
  if (kind.includes("symbol") || kind.includes("component")) return 54;
  if (kind.includes("image")) return 30;
  return 20;
}
function isSelectableFeature(feature) {
  if (!feature || isBackgroundFeature(feature)) return false;
  const kind = String(feature.kind || feature.semanticRole || "").toLowerCase();
  return [
    "pin",
    "label",
    "port",
    "wire",
    "bus",
    "junction",
    "no_connect",
    "symbol",
    "component",
    "sheet",
    "image",
    "text"
  ].some((token) => kind.includes(token));
}
function isSelectableElement(element) {
  const role = String(`${element?.dataset?.primitive || ""} ${element?.dataset?.ref || ""} ${element?.dataset?.role || ""} ${element?.dataset?.objectId || ""} ${element?.dataset?.text || ""}`).toLowerCase();
  if (!role || role.includes("background") || role.includes("sheet_header") || role.includes("sheet header") || role.includes("drawing-sheet")) {
    return false;
  }
  return [
    "pin",
    "label",
    "port",
    "wire",
    "bus",
    "junction",
    "no_connect",
    "symbol",
    "component",
    "sheet",
    "image",
    "text"
  ].some((token) => role.includes(token));
}
function isSheetSelection(selection) {
  return String(selection?.kind || selection?.feature?.kind || "").toLowerCase() === "sheet";
}
function addToMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
function isUnsafeUrl(value) {
  const clean2 = String(value || "").trim().toLowerCase();
  if (!clean2 || clean2.startsWith("#")) return false;
  return clean2.startsWith("javascript:") || clean2.startsWith("data:") || clean2.startsWith("http://") || clean2.startsWith("https://");
}
function isSafeImageDataUrl(value) {
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(String(value || "").trim());
}
function isRelativeResourceUrl(value) {
  const clean2 = String(value || "").trim();
  return clean2 && !clean2.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(clean2);
}
function stripUnsafeCssUrls(value) {
  return String(value || "").replace(/url\(([^)]+)\)/gi, (match, raw) => {
    const clean2 = raw.trim().replace(/^['"]|['"]$/g, "");
    return isUnsafeUrl(clean2) ? "none" : match;
  });
}
function rewriteLocalRefs(value, idMap) {
  let output = String(value || "");
  output = output.replace(/url\(#([^)]+)\)/g, (match, id) => idMap.has(id) ? `url(#${idMap.get(id)})` : match);
  output = output.replace(/^#(.+)$/, (match, id) => idMap.has(id) ? `#${idMap.get(id)}` : match);
  return output;
}
function slug(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "item";
}
function clamp2(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// viewer/src/main.js
var COPPER_TILE_GPU_BUDGET_BYTES = 72 * 1024 * 1024;
var COPPER_TILE_PREFETCH_MARGIN = 0.35;
var TILE_SCHEDULER_INTERVAL_MS = 120;
var MAX_TILE_LOADS_PER_TICK = 12;
var INTERACTIVE_TILE_LOADS_PER_TICK = 48;
var COMPARE_REVEAL_DURATION_MS = 230;
var TILE_VERTEX_STRIDE_BYTES = 40;
var TILE_INDEX_BYTES = 4;
var topology = window.__TOPOLOGY__ || {};
var semanticGeometry = window.__SEMANTIC_GEOMETRY__ || {};
var appEl;
var canvas;
var schematicCanvas;
var schematicDomLayer;
var schematicFlowOverlay;
var statusEl;
var viewerKindEl;
var selectionEl;
var diagnosticsEl;
var layersEl;
var searchControlsEl;
var viewControlsEl;
var fallbackEl;
var labelsEl;
var schematicLabelsEl;
var gizmo;
var selectionCardEl;
var primaryHeadingEl;
var primaryDescriptionEl;
var state = {
  workspace: "pcb",
  mode: "3d",
  cameraTool: "orbit",
  compareLayers: /* @__PURE__ */ new Set(),
  desiredCompareLayers: /* @__PURE__ */ new Set(),
  visible3dLayers: /* @__PURE__ */ new Set(),
  activeNetId: 0,
  selectedFeatureId: 0,
  selectionAnchor: null,
  showBoard: true,
  showComponents: true,
  isolateNet: false,
  separation: 0,
  dragging: false,
  dragMode: "orbit",
  lastX: 0,
  lastY: 0,
  pointerStartX: 0,
  pointerStartY: 0,
  loadedBytes: 0,
  triangles: 0,
  residentTileBytes: 0,
  residentTileGpuBytes: 0,
  residentTileTriangles: 0,
  tileLoads: 0,
  tileEvictions: 0,
  tileSchedulerMs: 0,
  lastTileScheduleAt: 0,
  visibleTileIds: /* @__PURE__ */ new Set(),
  frameCpuMs: 0,
  frameCpuP95Ms: 0,
  frameIntervalMs: 0,
  frameIntervalP95Ms: 0,
  frameSamples: [],
  fps: 0,
  frames: 0,
  fpsAt: performance.now(),
  activeTab: "layers",
  selectedPageId: "",
  selectedSchematicFeature: null,
  schematicDragging: false,
  schematicLastX: 0,
  schematicLastY: 0,
  schematicStartX: 0,
  schematicStartY: 0
};
var scene = {
  manifest: null,
  manifestUrl: "",
  layers: [],
  copperLayers: [],
  nets: [],
  features: /* @__PURE__ */ new Map(),
  tiles: /* @__PURE__ */ new Map(),
  loaded: /* @__PURE__ */ new Set(),
  loading: /* @__PURE__ */ new Map(),
  failed: /* @__PURE__ */ new Map(),
  residentTiles: /* @__PURE__ */ new Map(),
  componentFeatures: /* @__PURE__ */ new Map(),
  layerZOffsets: new Float32Array(256),
  layerZOffsetSignature: ""
};
var compareAnimation = {
  key: "",
  started: 0,
  from: /* @__PURE__ */ new Map(),
  current: /* @__PURE__ */ new Map()
};
var compareTransition = {
  phase: "idle",
  previous: /* @__PURE__ */ new Set(),
  target: /* @__PURE__ */ new Set(),
  previousOffsets: /* @__PURE__ */ new Map(),
  started: 0
};
var schematicScene = {
  manifest: null,
  manifestUrl: "",
  pages: [],
  byId: /* @__PURE__ */ new Map(),
  activeNetUid: "",
  visiblePages: [],
  fitted: false,
  rendererMode: new URLSearchParams(location.search).get("schematicRenderer") || "svg-dom",
  domFallbackReason: ""
};
var gizmoHits = [];
var renderer;
var schematicRenderer;
var schematicDomRenderer;
var camera;
var panel;
var compareOffsets = /* @__PURE__ */ new Map();
var lastFrame = performance.now();
function lookup(root, selector) {
  if (root?.querySelector) return root.querySelector(selector);
  return document.querySelector(selector);
}
function resolveDom(root = document) {
  appEl = lookup(root, "#app");
  canvas = lookup(root, "#viewport");
  schematicCanvas = lookup(root, "#schematic-viewport");
  schematicDomLayer = lookup(root, "#schematic-dom-layer");
  schematicFlowOverlay = lookup(root, "#schematic-flow-overlay");
  statusEl = lookup(root, "#status");
  viewerKindEl = lookup(root, "#viewer-kind");
  selectionEl = lookup(root, "#selection");
  diagnosticsEl = lookup(root, "#diagnostics");
  layersEl = lookup(root, "#layers");
  searchControlsEl = lookup(root, "#search-controls");
  viewControlsEl = lookup(root, "#view-controls");
  fallbackEl = lookup(root, "#fallback");
  labelsEl = lookup(root, "#panel-labels");
  schematicLabelsEl = lookup(root, "#schematic-labels");
  gizmo = lookup(root, "#axis-gizmo");
  selectionCardEl = lookup(root, "#selection-card");
  primaryHeadingEl = lookup(root, "#primary-heading");
  primaryDescriptionEl = lookup(root, "#primary-description");
}
function reportBootError(error) {
  console.error(error);
  if (statusEl) statusEl.textContent = "Renderer failed";
  if (fallbackEl) {
    fallbackEl.hidden = false;
    fallbackEl.textContent = error.stack || error.message || String(error);
  }
}
async function mountStandaloneViewer(options = {}) {
  topology = options.topology || window.__TOPOLOGY__ || {};
  semanticGeometry = options.semanticGeometry || window.__SEMANTIC_GEOMETRY__ || {};
  resolveDom(options.root || document);
  await boot();
  return {
    dispose() {
      renderer?.dispose?.();
      schematicRenderer?.dispose?.();
      schematicDomRenderer?.dispose?.();
    }
  };
}
if (!window.__PRISM_SEMANTIC_VIEWER_MANUAL_BOOT__) {
  mountStandaloneViewer().catch(reportBootError);
}
async function boot() {
  const manifestPath = semanticGeometry.assets?.scene_manifest || semanticGeometry.semantic_gltf?.path;
  if (!manifestPath) throw new Error("This bundle does not contain prism.semantic_gltf_a0");
  scene.manifestUrl = new URL(manifestPath, location.href).toString();
  scene.manifest = await fetchJson(scene.manifestUrl);
  if (scene.manifest.schema !== "prism.semantic_gltf_a0") {
    throw new Error(`Unsupported scene schema: ${scene.manifest.schema}`);
  }
  scene.layers = scene.manifest.layers || [];
  scene.copperLayers = scene.layers.filter(
    (layer) => layer.role === "copper" || String(layer.name).endsWith(".Cu")
  );
  scene.nets = scene.manifest.nets || [];
  for (const feature of scene.manifest.objectFeatures || []) {
    scene.features.set(Number(feature.id), { ...feature, bounds: runtimeBounds(feature.boundsMm) });
  }
  for (const component of scene.manifest.components || []) {
    scene.componentFeatures.set(component.designator, component);
    scene.features.set(Number(component.featureId), {
      ...component,
      kind: "component",
      sourceUid: component.uid,
      netId: 0,
      bounds: null
    });
  }
  for (const tile of scene.manifest.tiles || []) scene.tiles.set(tile.id, tile);
  const first = scene.copperLayers[0];
  if (first) {
    state.compareLayers.add(Number(first.id));
    state.desiredCompareLayers.add(Number(first.id));
    for (const layer of scene.copperLayers) state.visible3dLayers.add(Number(layer.id));
  }
  renderer = await Renderer.create(canvas);
  camera = new CameraController(runtimeBoundsFromGltf(scene.manifest.bbox));
  renderer.setBarrels(scene.manifest.barrels || []);
  await loadBoard();
  await loadSchematicWorld();
  renderControls();
  bindInteractions();
  bindSchematicInteractions();
  bindWorkspaceTabs();
  bindPanelTabs();
  statusEl.textContent = "WebGPU semantic glTF active";
  void loadComponents();
  scheduleTileResidency(performance.now(), { force: true });
  requestAnimationFrame(frame);
}
async function loadSchematicWorld() {
  const nativePath = semanticGeometry.assets?.schematic_native_manifest || semanticGeometry.schematic_vector?.path || semanticGeometry.schematic_scene?.path;
  const fallbackPath = semanticGeometry.assets?.schematic_manifest || semanticGeometry.schematic_world?.path;
  const tab = document.querySelector("[data-workspace=schematic]");
  if (!nativePath && !fallbackPath) {
    tab.disabled = true;
    tab.title = "No schematic world assets are available";
    return;
  }
  const candidates = [nativePath, fallbackPath].filter(Boolean);
  let lastError = null;
  for (const path of candidates) {
    try {
      schematicScene.manifestUrl = new URL(path, location.href).toString();
      schematicRenderer = await SchematicWorldRenderer.create(schematicCanvas, schematicScene.manifestUrl);
      schematicRenderer.setFlowOverlayCanvas(schematicFlowOverlay);
      break;
    } catch (error) {
      lastError = error;
      schematicRenderer = null;
      if (path === fallbackPath) throw error;
    }
  }
  if (!schematicRenderer) throw lastError || new Error("Failed to load schematic viewer assets");
  schematicScene.manifest = schematicRenderer.manifest;
  schematicScene.pages = schematicRenderer.pages;
  schematicScene.byId = new Map(schematicScene.pages.map((page) => [page.id, page]));
  state.selectedPageId = schematicScene.pages[0]?.id || "";
  schematicRenderer.selectedPageId = state.selectedPageId;
  const svgDomEnabled = !["native", "legacy", "webgpu"].includes(String(schematicScene.rendererMode).toLowerCase());
  if (svgDomEnabled) {
    schematicDomRenderer = SvgDomSchematicRenderer.create(
      schematicDomLayer,
      schematicScene.manifestUrl,
      schematicScene.manifest,
      schematicRenderer.featuresByPage,
      {
        onSelect: selectSchematicDomSelection,
        onBlank: clearSchematicSelection,
        onHighlightNet: highlightSchematicNetByUid,
        onOpenPage: openSchematicDomTarget,
        onFallback: (reason) => {
          schematicScene.domFallbackReason = reason;
          console.warn(reason);
        }
      }
    );
    void schematicDomRenderer.preloadPages(schematicScene.pages);
  }
  void schematicRenderer.preloadOverview();
}
async function fetchJson(url) {
  const response = await fetch(url, { cache: "default" });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return response.json();
}
async function loadTile(tile) {
  const resident = scene.residentTiles.get(tile.id);
  if (resident) {
    resident.lastUsed = performance.now();
    return;
  }
  if (scene.loading.has(tile.id)) return scene.loading.get(tile.id);
  const promise = (async () => {
    try {
      const loaded = await loadGltf(new URL(tile.path, scene.manifestUrl).toString());
      state.loadedBytes += loaded.byteLength;
      const layer = scene.layers.find((item) => Number(item.id) === Number(tile.layerId));
      const entries = [];
      let triangles = 0;
      let gpuBytes = 0;
      for (const primitive of loaded.primitives) {
        const entry = renderer.addPrimitive(primitive, {
          kind: "copper",
          tileId: tile.id,
          layerId: Number(tile.layerId),
          color: layerColor(layer),
          baseZ: Number(layer?.z_mm || 0) / 1e3,
          material: { baseColor: [1, 1, 1, 1], metallic: 0.78, roughness: 0.32 }
        });
        entries.push(entry);
        triangles += primitive.indices.length / 3;
        gpuBytes += estimatePrimitiveGpuBytes(primitive);
      }
      const record = {
        tile,
        entries,
        byteLength: loaded.byteLength,
        gpuBytes,
        triangles,
        lastUsed: performance.now(),
        pinned: false
      };
      scene.residentTiles.set(tile.id, record);
      scene.loaded.add(tile.id);
      state.tileLoads += 1;
      state.residentTileBytes += loaded.byteLength;
      state.residentTileGpuBytes += gpuBytes;
      state.residentTileTriangles += triangles;
      state.triangles = state.residentTileTriangles;
      scene.failed.delete(tile.id);
    } catch (error) {
      const previous = scene.failed.get(tile.id) || { count: 0, message: "" };
      scene.failed.set(tile.id, { count: previous.count + 1, message: error?.message || String(error) });
      console.warn(`Failed to load tile ${tile.id}`, error);
      throw error;
    } finally {
      scene.loading.delete(tile.id);
    }
  })();
  scene.loading.set(tile.id, promise);
  return promise;
}
function estimatePrimitiveGpuBytes(primitive) {
  return primitive.position.length / 3 * TILE_VERTEX_STRIDE_BYTES + primitive.indices.length * TILE_INDEX_BYTES;
}
function evictTile(tileId) {
  const record = scene.residentTiles.get(tileId);
  if (!record) return;
  renderer.removeEntries(record.entries);
  scene.residentTiles.delete(tileId);
  scene.loaded.delete(tileId);
  state.residentTileBytes = Math.max(0, state.residentTileBytes - record.byteLength);
  state.residentTileGpuBytes = Math.max(0, state.residentTileGpuBytes - record.gpuBytes);
  state.residentTileTriangles = Math.max(0, state.residentTileTriangles - record.triangles);
  state.triangles = state.residentTileTriangles;
  state.tileEvictions += 1;
}
function scheduleTileResidency(now = performance.now(), options = {}) {
  if (!renderer || !camera || state.workspace !== "pcb") return;
  const interactiveComparePreload = state.mode === "layer" && compareTransition.phase === "preload";
  if (!options.force && !interactiveComparePreload && now - state.lastTileScheduleAt < TILE_SCHEDULER_INTERVAL_MS) return;
  const started = performance.now();
  state.lastTileScheduleAt = now;
  const needed = neededTileIdsForView();
  state.visibleTileIds = needed;
  const activeLoads = scene.loading.size;
  const maxLoads = interactiveComparePreload ? INTERACTIVE_TILE_LOADS_PER_TICK : MAX_TILE_LOADS_PER_TICK;
  const loadBudget = Math.max(0, maxLoads - activeLoads);
  const missing = [...needed].map((tileId) => scene.tiles.get(tileId)).filter((tile) => tile && !scene.residentTiles.has(tile.id) && !scene.loading.has(tile.id)).sort((a, b) => tileDistanceToFocus(a) - tileDistanceToFocus(b)).slice(0, loadBudget);
  for (const tile of missing) void loadTile(tile);
  for (const tileId of needed) {
    const record = scene.residentTiles.get(tileId);
    if (record) record.lastUsed = now;
  }
  evictUnneededTiles(needed);
  state.tileSchedulerMs = performance.now() - started;
}
function neededTileIdsForView() {
  const needed = /* @__PURE__ */ new Set();
  const visibleLayers = state.mode === "3d" ? state.visible3dLayers : compareResidencyLayers();
  if (!visibleLayers.size || !panel) return needed;
  if (state.mode === "layer") {
    for (const tile of scene.tiles.values()) {
      if (visibleLayers.has(Number(tile.layerId))) needed.add(tile.id);
    }
    return needed;
  }
  const activeNetTiles = /* @__PURE__ */ new Set();
  if (state.activeNetId) {
    for (const tile of scene.tiles.values()) {
      if (visibleLayers.has(Number(tile.layerId)) && tileHasNet(tile, state.activeNetId)) {
        activeNetTiles.add(tile.id);
      }
    }
  }
  for (const tile of scene.tiles.values()) {
    if (!visibleLayers.has(Number(tile.layerId))) continue;
    const offset = state.mode === "layer" ? compareOffsets.get(Number(tile.layerId)) : null;
    if (tileIntersectsView(tile, panel.matrix, offset, COPPER_TILE_PREFETCH_MARGIN)) needed.add(tile.id);
  }
  for (const tileId of activeNetTiles) needed.add(tileId);
  return needed;
}
function compareResidencyLayers() {
  if (state.mode !== "layer") return state.compareLayers;
  if (compareTransition.phase === "idle") return state.compareLayers;
  return unionSets(compareTransition.previous, compareTransition.target);
}
function compareRenderLayers() {
  if (state.mode !== "layer") return state.visible3dLayers;
  if (compareTransition.phase === "reveal") return unionSets(compareTransition.previous, compareTransition.target);
  return state.compareLayers;
}
function unionSets(...sets) {
  const output = /* @__PURE__ */ new Set();
  for (const set of sets) {
    for (const value of set || []) output.add(Number(value));
  }
  return output;
}
function evictUnneededTiles(needed) {
  const budget = COPPER_TILE_GPU_BUDGET_BYTES;
  if (state.residentTileGpuBytes <= budget) return;
  const candidates = [...scene.residentTiles.values()].filter((record) => !needed.has(record.tile.id) && !scene.loading.has(record.tile.id)).sort((a, b) => a.lastUsed - b.lastUsed);
  for (const record of candidates) {
    if (state.residentTileGpuBytes <= budget) break;
    evictTile(record.tile.id);
  }
}
function tileIntersectsView(tile, matrix, offset = null, marginScale = 0) {
  const bounds = tileRuntimeBounds(tile);
  if (!bounds) return true;
  const margin = Math.max(bounds[3] - bounds[0], bounds[4] - bounds[1]) * marginScale;
  const expanded = [
    bounds[0] - margin + (offset?.[0] || 0),
    bounds[1] - margin + (offset?.[1] || 0),
    bounds[2] - 2e-3,
    bounds[3] + margin + (offset?.[0] || 0),
    bounds[4] + margin + (offset?.[1] || 0),
    bounds[5] + 2e-3
  ];
  return boundsIntersectsClip(expanded, matrix);
}
function tileRuntimeBounds(tile) {
  const bounds = tile.boundsMm;
  if (!bounds || bounds.length !== 4) return null;
  const layer = scene.layers.find((item) => Number(item.id) === Number(tile.layerId));
  const z = Number(layer?.z_mm || 0) / 1e3;
  return [
    bounds[0] / 1e3,
    -bounds[3] / 1e3,
    z - 4e-4,
    bounds[2] / 1e3,
    -bounds[1] / 1e3,
    z + 4e-4
  ];
}
function boundsIntersectsClip(bounds, matrix) {
  const corners = [
    [bounds[0], bounds[1], bounds[2]],
    [bounds[3], bounds[1], bounds[2]],
    [bounds[0], bounds[4], bounds[2]],
    [bounds[3], bounds[4], bounds[2]],
    [bounds[0], bounds[1], bounds[5]],
    [bounds[3], bounds[1], bounds[5]],
    [bounds[0], bounds[4], bounds[5]],
    [bounds[3], bounds[4], bounds[5]]
  ].map((point) => clipPoint(matrix, point));
  const planes = [
    (point) => point[0] < -point[3],
    (point) => point[0] > point[3],
    (point) => point[1] < -point[3],
    (point) => point[1] > point[3],
    (point) => point[2] < 0,
    (point) => point[2] > point[3]
  ];
  return !planes.some((outside) => corners.every(outside));
}
function clipPoint(matrix, point) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]
  ];
}
function tileHasNet(tile, netId) {
  return Array.isArray(tile.netIds) && tile.netIds.some((value) => Number(value) === Number(netId));
}
function tileDistanceToFocus(tile) {
  const bounds = tileRuntimeBounds(tile);
  if (!bounds || !camera) return 0;
  const x = (bounds[0] + bounds[3]) * 0.5 - camera.focus[0];
  const y = (bounds[1] + bounds[4]) * 0.5 - camera.focus[1];
  return x * x + y * y;
}
async function loadBoard() {
  const path = semanticGeometry.assets?.base_board_glb;
  if (!path) return;
  const loaded = await loadGltf(new URL(path, location.href).toString(), { defaultFeatureId: 0 });
  state.loadedBytes += loaded.byteLength;
  const contextPrimitives = loaded.primitives.filter((primitive) => boardRole(primitive) !== "pad");
  for (const primitive of mergePrimitivesByMaterial(contextPrimitives, boardRole)) {
    renderer.addPrimitive(primitive, {
      kind: "board",
      boardRole: primitive.groupKey,
      layerId: 0,
      material: primitive.material,
      color: primitive.material.baseColor
    });
  }
}
function boardRole(primitive) {
  const name = `${primitive.nodeName || ""} ${primitive.meshName || ""} ${primitive.material?.name || ""}`.toLowerCase();
  if (name.includes("_pad") || name.includes(".pad") || name.endsWith("pad")) return "pad";
  if (name.includes("silkscreen")) return "silkscreen";
  if (name.includes("soldermask")) return "soldermask";
  return "substrate";
}
async function loadComponents() {
  const path = semanticGeometry.assets?.components_glb;
  if (!path) return;
  const loaded = await loadGltf(new URL(path, location.href).toString(), {
    componentFeatures: scene.componentFeatures
  });
  state.loadedBytes += loaded.byteLength;
  for (const primitive of loaded.primitives) {
    const component = scene.componentFeatures.get(primitive.designator);
    if (component) mergeFeatureBounds(component.featureId, primitive.position);
  }
  for (const primitive of mergePrimitivesByMaterial(loaded.primitives)) {
    renderer.addPrimitive(primitive, {
      kind: "component",
      layerId: 0,
      material: primitive.material,
      color: primitive.material.baseColor
    });
  }
}
function mergePrimitivesByMaterial(primitives, classifier = () => "") {
  const groups = /* @__PURE__ */ new Map();
  for (const primitive of primitives) {
    const groupKey = classifier(primitive);
    const key = `${groupKey}:${JSON.stringify(primitive.material)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(primitive);
  }
  return [...groups.values()].map((group) => {
    const vertexCount = group.reduce((sum, item) => sum + item.position.length / 3, 0);
    const indexCount = group.reduce((sum, item) => sum + item.indices.length, 0);
    const position = new Float32Array(vertexCount * 3);
    const normal = new Float32Array(vertexCount * 3);
    const netId = new Uint32Array(vertexCount);
    const objectFeatureId = new Uint32Array(vertexCount);
    const indices = new Uint32Array(indexCount);
    let vertexOffset = 0;
    let indexOffset = 0;
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const item of group) {
      const count = item.position.length / 3;
      position.set(item.position, vertexOffset * 3);
      normal.set(item.normal, vertexOffset * 3);
      netId.set(item.netId, vertexOffset);
      objectFeatureId.set(item.objectFeatureId, vertexOffset);
      for (let index = 0; index < item.indices.length; index += 1) {
        indices[indexOffset + index] = Number(item.indices[index]) + vertexOffset;
      }
      if (item.bounds) {
        bounds[0] = Math.min(bounds[0], item.bounds[0]);
        bounds[1] = Math.min(bounds[1], item.bounds[1]);
        bounds[2] = Math.min(bounds[2], item.bounds[2]);
        bounds[3] = Math.max(bounds[3], item.bounds[3]);
        bounds[4] = Math.max(bounds[4], item.bounds[4]);
        bounds[5] = Math.max(bounds[5], item.bounds[5]);
      }
      vertexOffset += count;
      indexOffset += item.indices.length;
    }
    return {
      position,
      normal,
      netId,
      objectFeatureId,
      indices,
      material: group[0].material,
      groupKey: classifier(group[0]),
      bounds: Number.isFinite(bounds[0]) ? bounds : null
    };
  });
}
function runtimeBounds(bounds) {
  if (!bounds || bounds.length !== 6) return null;
  return [
    bounds[0] / 1e3,
    -bounds[4] / 1e3,
    bounds[2] / 1e3,
    bounds[3] / 1e3,
    -bounds[1] / 1e3,
    bounds[5] / 1e3
  ];
}
function runtimeBoundsFromGltf(bounds) {
  const minimum = bounds?.min || [0, 0, 0];
  const maximum = bounds?.max || [0.08, 16e-4, 0.05];
  return [minimum[0], -maximum[2], minimum[1], maximum[0], -minimum[2], maximum[1]];
}
function mergeFeatureBounds(featureId, positions) {
  const feature = scene.features.get(Number(featureId));
  if (!feature || !positions.length) return;
  const incoming = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    incoming[0] = Math.min(incoming[0], positions[index]);
    incoming[1] = Math.min(incoming[1], positions[index + 1]);
    incoming[2] = Math.min(incoming[2], positions[index + 2]);
    incoming[3] = Math.max(incoming[3], positions[index]);
    incoming[4] = Math.max(incoming[4], positions[index + 1]);
    incoming[5] = Math.max(incoming[5], positions[index + 2]);
  }
  feature.bounds = feature.bounds ? [
    Math.min(feature.bounds[0], incoming[0]),
    Math.min(feature.bounds[1], incoming[1]),
    Math.min(feature.bounds[2], incoming[2]),
    Math.max(feature.bounds[3], incoming[3]),
    Math.max(feature.bounds[4], incoming[4]),
    Math.max(feature.bounds[5], incoming[5])
  ] : incoming;
}
function layerColor(layer) {
  const colors = {
    "F.Cu": "#a9423c",
    "B.Cu": "#315b9a",
    "In1.Cu": "#477a55",
    "In2.Cu": "#806244",
    "In3.Cu": "#347c86",
    "In4.Cu": "#685889",
    "In5.Cu": "#92793e"
  };
  const inner = ["#477a55", "#806244", "#347c86", "#685889", "#92793e", "#82556e"];
  const name = String(layer?.name || "");
  const index = Math.max(0, scene.copperLayers.findIndex((item) => item.name === name) - 1);
  return [...hex(colors[name] || inner[index % inner.length]), 1];
}
function hex(value) {
  const clean2 = value.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(clean2.slice(offset, offset + 2), 16) / 255);
}
function frame(now) {
  const frameStarted = performance.now();
  const frameInterval = Math.max(0, now - lastFrame);
  if (state.workspace === "schematic" && schematicRenderer) {
    lastFrame = now;
    const visible = schematicRenderer.visiblePages();
    const domPages = schematicDomRenderer ? schematicDomDetailPages(visible) : [];
    schematicRenderer.setDomDetailPageIds(domPages.map((page) => page.id));
    schematicScene.visiblePages = schematicRenderer.render();
    schematicDomRenderer?.syncWorldPages(domPages, schematicRenderer, { activeNetUid: schematicScene.activeNetUid });
    updateSchematicLabels();
    recordFrameSample(frameInterval, performance.now() - frameStarted);
    updateDiagnostics(now);
    requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min(0.05, (now - lastFrame) / 1e3);
  lastFrame = now;
  camera.update(dt);
  renderer.resize();
  const layerZOffsets = stackupOffsets();
  for (const entry of renderer.entries) entry.layerOffset = layerZOffsets[entry.layerId] || 0;
  updateCompareTransition(now);
  compareOffsets = updateCompareLayout(now);
  const compareAlphas = compareLayerAlphas(now);
  panel = {
    layerId: 0,
    viewport: { x: 0, y: 0, width: canvas.width, height: canvas.height },
    matrix: camera.matrix(canvas.width, canvas.height, state.mode === "layer")
  };
  scheduleTileResidency(now);
  const visibleLayers = state.mode === "3d" ? state.visible3dLayers : compareRenderLayers();
  renderer.render({
    panels: [panel],
    activeNetId: state.activeNetId,
    selectedFeatureId: state.selectedFeatureId,
    time: now / 1e3,
    layerOffsets: layerZOffsets,
    visibleLayers,
    showBoard: state.showBoard,
    showComponents: state.showComponents,
    componentOpacity: clamp(1 - state.separation / 0.1, 0, 1),
    boardOpacity: state.activeNetId ? 0.34 : 1 - state.separation * 0.72,
    isolateNet: state.isolateNet,
    compareMode: state.mode === "layer",
    compareOffsets,
    layerAlphas: compareAlphas,
    visibleTileIds: state.mode === "3d" ? state.visibleTileIds : null
  });
  drawGizmo();
  updateLayerLabels();
  recordFrameSample(frameInterval, performance.now() - frameStarted);
  updateDiagnostics(now);
  requestAnimationFrame(frame);
}
function schematicPageScreenMetrics(page) {
  if (!schematicRenderer || !page) return { widthPx: 0, heightPx: 0, sourcePxPerMm: 0, area: 0 };
  const widthPx = schematicRenderer.pagePixelWidth(page);
  const heightPx = page.heightMm / Math.max(1e-6, schematicRenderer.scale);
  const sourcePxPerMm = schematicRenderer.pageSourcePixelsPerMm(page);
  return { widthPx, heightPx, sourcePxPerMm, area: widthPx * heightPx };
}
function schematicDomDetailPages(visiblePages) {
  if (!schematicDomRenderer || !schematicRenderer) return [];
  const visible = visiblePages || [];
  const viewportArea = Math.max(1, schematicCanvas.clientWidth * schematicCanvas.clientHeight);
  const detail = visible.map((page) => ({ page, ...schematicPageScreenMetrics(page) })).filter((item) => item.widthPx >= 760 && item.heightPx >= 520 && item.area >= viewportArea * 0.36 && item.sourcePxPerMm >= 1.25).sort((a, b) => b.area - a.area);
  const maxMounted = 1;
  return detail.slice(0, maxMounted).map((item) => item.page);
}
function stackupOffsets() {
  const bbox = scene.manifest.bbox;
  const diagonal = Math.hypot(
    (bbox.max[0] - bbox.min[0]) * 1e3,
    (bbox.max[2] - bbox.min[2]) * 1e3
  );
  const gap = state.separation * state.separation * clamp(diagonal * 0.12, 8, 25) / 1e3;
  const signature = `${state.separation}:${gap}:${scene.copperLayers.length}`;
  if (scene.layerZOffsetSignature === signature) return scene.layerZOffsets;
  const output = scene.layerZOffsets;
  output.fill(0);
  const middle = (scene.copperLayers.length - 1) / 2;
  scene.copperLayers.forEach((layer, index) => {
    output[Number(layer.id)] = (middle - index) * gap;
  });
  scene.layerZOffsetSignature = signature;
  return output;
}
function updateCompareLayout(now) {
  if (state.mode !== "layer") {
    compareAnimation.key = "3d";
    compareAnimation.current.clear();
    return /* @__PURE__ */ new Map();
  }
  const selected = scene.copperLayers.filter((layer) => state.compareLayers.has(Number(layer.id)));
  const count = Math.max(1, selected.length);
  const aspect = canvas.width / Math.max(1, canvas.height);
  let columns = 1;
  if (count === 2) columns = aspect >= 1 ? 2 : 1;
  else if (count === 3 || count === 4) columns = 2;
  else if (count > 4) columns = Math.ceil(Math.sqrt(count * aspect));
  const rows = Math.ceil(count / columns);
  const bounds = runtimeBoundsFromGltf(scene.manifest.bbox);
  const boardWidth = bounds[3] - bounds[0];
  const boardHeight = bounds[4] - bounds[1];
  const pitchX = boardWidth * 1.18;
  const pitchY = boardHeight * 1.22;
  const targets = selected.map((layer, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      layer,
      layerId: Number(layer.id),
      column,
      row,
      offset: [
        (column - (columns - 1) / 2) * pitchX,
        ((rows - 1) / 2 - row) * pitchY,
        0
      ]
    };
  });
  const key = `${columns}x${rows}:${targets.map((item) => item.layerId).join(",")}`;
  if (key !== compareAnimation.key) {
    compareAnimation.key = key;
    compareAnimation.started = now;
    compareAnimation.from = new Map(compareAnimation.current);
    const totalWidth = columns * boardWidth + (columns - 1) * (pitchX - boardWidth);
    const totalHeight = rows * boardHeight + (rows - 1) * (pitchY - boardHeight);
    camera.targetFocus = [
      (bounds[0] + bounds[3]) / 2,
      (bounds[1] + bounds[4]) / 2,
      (bounds[2] + bounds[5]) / 2
    ];
    camera.targetOrthoScale = Math.max(totalHeight, totalWidth / aspect) * 1.08;
  }
  const progress = clamp((now - compareAnimation.started) / 420, 0, 1);
  const eased = 1 - Math.pow(1 - progress, 3);
  const offsets = /* @__PURE__ */ new Map();
  for (const target of targets) {
    const start = compareAnimation.from.get(target.layerId) || [0, 0, 0];
    const current = target.offset.map(
      (value, index) => start[index] + (value - start[index]) * eased
    );
    offsets.set(target.layerId, current);
    compareAnimation.current.set(target.layerId, current);
  }
  if (compareTransition.phase === "reveal") {
    for (const layerId of compareTransition.previous) {
      if (!offsets.has(Number(layerId))) {
        offsets.set(Number(layerId), compareTransition.previousOffsets.get(Number(layerId)) || [0, 0, 0]);
      }
    }
  }
  for (const layerId of [...compareAnimation.current.keys()]) {
    if (!targets.some((item) => item.layerId === layerId)) {
      compareAnimation.current.delete(layerId);
    }
  }
  return offsets;
}
function beginCompareLayerTransition(targetLayers) {
  const target = new Set([...targetLayers].map(Number));
  if (setsEqual(target, state.desiredCompareLayers) && compareTransition.phase !== "idle") return;
  state.desiredCompareLayers = target;
  if (setsEqual(target, state.compareLayers)) {
    compareTransition.phase = "idle";
    compareTransition.previous.clear();
    compareTransition.target.clear();
    return;
  }
  compareTransition.phase = "preload";
  compareTransition.previous = new Set(state.compareLayers);
  compareTransition.target = new Set(target);
  compareTransition.previousOffsets = new Map(compareAnimation.current);
  compareTransition.started = performance.now();
  scheduleTileResidency(compareTransition.started, { force: true });
}
function updateCompareTransition(now) {
  if (state.mode !== "layer" || compareTransition.phase === "idle") return;
  if (compareTransition.phase === "preload") {
    if (!compareTargetTilesReady(compareTransition.target)) {
      scheduleTileResidency(now, { force: true });
      return;
    }
    compareTransition.phase = "reveal";
    compareTransition.started = now;
    compareTransition.previousOffsets = new Map(compareAnimation.current);
    state.compareLayers = new Set(compareTransition.target);
    compareAnimation.key = "";
    return;
  }
  if (compareTransition.phase === "reveal" && now - compareTransition.started >= COMPARE_REVEAL_DURATION_MS) {
    state.compareLayers = new Set(compareTransition.target);
    compareTransition.phase = "idle";
    compareTransition.previous.clear();
    compareTransition.target.clear();
    compareTransition.previousOffsets.clear();
    scheduleTileResidency(now, { force: true });
  }
}
function compareTargetTilesReady(targetLayers) {
  for (const tile of scene.tiles.values()) {
    if (!targetLayers.has(Number(tile.layerId))) continue;
    if (!scene.residentTiles.has(tile.id) && !scene.failed.has(tile.id)) return false;
  }
  return true;
}
function compareLayerAlphas(now) {
  if (state.mode !== "layer" || compareTransition.phase !== "reveal") return null;
  const progress = clamp((now - compareTransition.started) / COMPARE_REVEAL_DURATION_MS, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  const alphas = /* @__PURE__ */ new Map();
  for (const layerId of compareTransition.previous) {
    alphas.set(Number(layerId), compareTransition.target.has(Number(layerId)) ? 1 : 1 - eased);
  }
  for (const layerId of compareTransition.target) {
    alphas.set(Number(layerId), compareTransition.previous.has(Number(layerId)) ? 1 : eased);
  }
  return alphas;
}
function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
function renderControls() {
  if (state.workspace === "schematic") {
    renderSchematicControls();
    return;
  }
  viewerKindEl.textContent = "Semantic GLTF A0";
  primaryHeadingEl.textContent = "Layers";
  primaryDescriptionEl.textContent = "Visibility and compare";
  document.querySelector('[data-panel="search"] .section-heading span').textContent = "Nets, components and pins";
  document.querySelector('[data-panel="view"] .section-heading span').textContent = "Camera and stackup";
  layersEl.innerHTML = `
    <div class="mode-toolbar">
      <button data-mode="layer">Layer Compare</button>
      <button data-mode="3d">3D</button>
    </div>
    <div class="layer-presets">
      <button data-preset="all">All</button><button data-preset="none">None</button>
      <button data-preset="outer">Outer</button><button data-preset="inner">Inner</button>
    </div>
    <div class="layer-list"></div>`;
  searchControlsEl.innerHTML = `
    <label class="control-field"><span>Search</span>
      <input id="entity-search" class="layer-select" type="search" placeholder="Net, component or pin">
      <div id="search-results" class="search-results"></div>
    </label>
    <div class="quick-actions">
      <button id="frame-selection">Frame</button>
      <button id="show-net-layers">Net layers</button>
      <button id="isolate-net">Isolate</button>
      <button id="clear-selection">Clear</button>
    </div>`;
  viewControlsEl.innerHTML = `
    <div class="camera-toolbar mode-toolbar">
      <button data-tool="orbit">Orbit</button><button data-tool="pan">Pan</button>
    </div>
    <div class="toggle-list">
      <label class="toggle-row"><input id="show-board" type="checkbox"><span>Board substrate</span></label>
      <label class="toggle-row"><input id="show-components" type="checkbox"><span>Components</span></label>
    </div>
    <label class="control-field range-field"><span>Stackup separation</span>
      <input id="separation" type="range" min="0" max="1" step="0.002">
    </label>`;
  refreshControls();
  bindControlEvents();
}
function renderSchematicControls() {
  viewerKindEl.textContent = schematicDomRenderer ? "Schematic SVG DOM" : schematicScene.manifest?.schema === "prism.schematic_vector_a0" ? "Schematic Vector A0" : "Schematic World A0";
  primaryHeadingEl.textContent = "Pages";
  primaryDescriptionEl.textContent = `${schematicScene.pages.length} hierarchy instances`;
  document.querySelector('[data-panel="search"] .section-heading span').textContent = "Pages, nets and components";
  document.querySelector('[data-panel="view"] .section-heading span').textContent = "World navigation";
  layersEl.innerHTML = `
    <div class="layer-presets">
      <button data-page-action="world">Fit world</button>
      <button data-page-action="parent">Parent</button>
      <button data-page-action="previous">Previous</button>
      <button data-page-action="next">Next</button>
    </div>
    <div class="page-list">${schematicScene.pages.map((page) => `
      <button class="page-row ${page.id === state.selectedPageId ? "active" : ""}" data-page="${page.id}">
        <span>${page.sheetNumber}</span>
        <strong>${escapeHtml(page.name)}</strong>
        <small>L${page.depth}</small>
      </button>`).join("")}</div>`;
  searchControlsEl.innerHTML = `
    <label class="control-field"><span>Search</span>
      <input id="entity-search" class="layer-select" type="search" placeholder="Page, net or component">
      <div id="search-results" class="search-results"></div>
    </label>
    <div class="quick-actions">
      <button id="frame-selection">Frame</button>
      <button id="clear-selection">Clear</button>
    </div>`;
  viewControlsEl.innerHTML = `
    <div class="toggle-list">
      <label class="toggle-row"><input id="show-hierarchy" type="checkbox" checked><span>Hierarchy links</span></label>
    </div>
    <div class="selection-section">
      <span class="selection-section-title">Navigation</span>
      <div class="selection-table">
        <div class="selection-row"><span><strong>Home</strong></span><span>World</span><span>Frame every page</span></div>
        <div class="selection-row"><span><strong>[ / ]</strong></span><span>Pages</span><span>Previous or next instance</span></div>
        <div class="selection-row"><span><strong>Alt+Up</strong></span><span>Parent</span><span>Move up hierarchy</span></div>
      </div>
    </div>`;
  layersEl.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => selectSchematicPage(button.dataset.page, true));
  });
  layersEl.querySelectorAll("[data-page-action]").forEach((button) => {
    button.addEventListener("click", () => navigateSchematic(button.dataset.pageAction));
  });
  searchControlsEl.querySelector("#entity-search").addEventListener("input", (event) => {
    renderSchematicSearch(event.target.value);
  });
  searchControlsEl.querySelector("#frame-selection").addEventListener("click", frameSchematicSelection);
  searchControlsEl.querySelector("#clear-selection").addEventListener("click", clearSchematicSelection);
  viewControlsEl.querySelector("#show-hierarchy").checked = schematicRenderer?.showHierarchy ?? true;
  viewControlsEl.querySelector("#show-hierarchy").addEventListener("change", (event) => {
    schematicRenderer.showHierarchy = event.target.checked;
  });
}
function selectSchematicPage(pageId, shouldFrame) {
  const page = schematicScene.byId.get(pageId);
  if (!page || !schematicRenderer) return;
  state.selectedPageId = page.id;
  state.selectedSchematicFeature = null;
  schematicRenderer.selectedPageId = page.id;
  schematicRenderer.selectedFeatureId = 0;
  selectionEl.textContent = JSON.stringify(page, null, 2);
  if (shouldFrame) schematicRenderer.framePage(page);
  layersEl.querySelectorAll("[data-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page.id);
  });
}
function navigateSchematic(action) {
  if (!schematicRenderer) return;
  if (action === "world") {
    schematicRenderer.frameWorld();
    return;
  }
  const index = Math.max(0, schematicScene.pages.findIndex((page) => page.id === state.selectedPageId));
  let target = null;
  if (action === "previous") target = schematicScene.pages[(index - 1 + schematicScene.pages.length) % schematicScene.pages.length];
  else if (action === "next") target = schematicScene.pages[(index + 1) % schematicScene.pages.length];
  else if (action === "parent") target = schematicScene.byId.get(schematicScene.pages[index]?.parentId);
  if (target) selectSchematicPage(target.id, true);
}
function openSchematicDomTarget(selection) {
  if (!selection || !schematicRenderer) return;
  clearSchematicSelection();
  if (selection.kind === "page" && selection.pageId) {
    selectSchematicPage(selection.pageId, true);
    return;
  }
  if (selection.kind !== "sheet") return;
  const currentPage = schematicScene.pages.find((page) => page.sheetInstancePath === selection.sheetInstancePath) || schematicScene.byId.get(state.selectedPageId);
  const sheetFile = String(selection.sheetFile || selection.feature?.sheet_file || "").replace(/\\/g, "/");
  const sheetName = String(selection.sheetName || selection.feature?.sheet_name || selection.feature?.objectId || "");
  const target = schematicScene.pages.find((page) => {
    if (currentPage && page.parentId && page.parentId !== currentPage.id) return false;
    const sourcePath = String(page.sourcePath || "").replace(/\\/g, "/");
    return sheetFile && sourcePath.endsWith(sheetFile) || sheetName && page.name === sheetName;
  }) || schematicScene.pages.find((page) => {
    const sourcePath = String(page.sourcePath || "").replace(/\\/g, "/");
    return sheetFile && sourcePath.endsWith(sheetFile) || sheetName && page.name === sheetName;
  });
  if (target) selectSchematicPage(target.id, true);
}
function renderSchematicSearch(query) {
  const container = searchControlsEl.querySelector("#search-results");
  const value = query.trim().toLowerCase();
  if (!value) {
    container.innerHTML = "";
    return;
  }
  const pages = schematicScene.pages.filter((page) => `${page.name} ${page.sheetPath}`.toLowerCase().includes(value)).slice(0, 8);
  const nets = scene.nets.filter((net) => String(net.name).toLowerCase().includes(value)).slice(0, 8);
  container.innerHTML = [
    ...pages.map((page) => `<button data-page="${page.id}"><b>${escapeHtml(page.name)}</b><span>Page ${page.sheetNumber}</span></button>`),
    ...nets.map((net) => `<button data-schematic-net="${net.id}"><b>${escapeHtml(net.name)}</b><span>${(schematicScene.manifest.netToPages?.[net.uid] || []).length} pages</span></button>`)
  ].join("");
  container.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => selectSchematicPage(button.dataset.page, true));
  });
  container.querySelectorAll("[data-schematic-net]").forEach((button) => {
    button.addEventListener("click", () => selectSchematicNet(Number(button.dataset.schematicNet), true));
  });
}
function selectSchematicNet(netId, shouldFrame) {
  const net = scene.nets.find((item) => Number(item.id) === netId);
  if (!net || !schematicRenderer) return;
  state.activeNetId = netId;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = null;
  schematicRenderer.selectedFeatureId = 0;
  schematicRenderer.selectedFeatureKey = "";
  schematicRenderer.selectedSourceId = "";
  schematicScene.activeNetUid = net.uid;
  schematicRenderer.activeNetUid = net.uid;
  schematicDomRenderer?.setHighlightedNet(net.uid);
  selectionEl.textContent = JSON.stringify(net, null, 2);
  updateSelectionCard();
  const pageIds = schematicScene.manifest.netToPages?.[net.uid] || [];
  if (shouldFrame && pageIds.length) selectSchematicPage(pageIds[0], true);
}
function highlightSchematicNetByUid(netUid, selection = null) {
  const net = scene.nets.find((item) => item.uid === netUid);
  if (!net) return;
  state.activeNetId = Number(net.id);
  schematicScene.activeNetUid = net.uid;
  if (schematicRenderer) {
    schematicRenderer.activeNetUid = net.uid;
    schematicRenderer.selectedFeatureId = Number(selection?.feature?.id || selection?.featureId || 0);
    schematicRenderer.selectedFeatureKey = selection?.feature?.stableKey || selection?.featureKey || "";
    schematicRenderer.selectedSourceId = selection?.feature?.sourceId || selection?.sourceId || "";
  }
  schematicDomRenderer?.setHighlightedNet(net.uid);
  if (selection) state.selectedSchematicFeature = { ...selection, pageId: state.selectedPageId };
  selectionEl.textContent = JSON.stringify(selection ? { ...selection, net } : net, null, 2);
  updateSelectionCard();
}
function clearSchematicSelection() {
  state.activeNetId = 0;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = null;
  schematicScene.activeNetUid = "";
  if (schematicRenderer) {
    schematicRenderer.activeNetUid = "";
    schematicRenderer.selectedFeatureId = 0;
    schematicRenderer.selectedFeatureKey = "";
    schematicRenderer.selectedSourceId = "";
  }
  schematicDomRenderer?.setSelection(null);
  schematicDomRenderer?.setHighlightedNet("");
  selectionEl.textContent = "No object selected";
  updateSelectionCard();
}
function frameSchematicSelection() {
  const page = schematicScene.byId.get(state.selectedPageId);
  if (page) schematicRenderer.framePage(page);
  else schematicRenderer.frameWorld();
}
function selectSchematicDomSelection(selection) {
  state.selectedPageId = selection.sheetInstancePath ? schematicScene.pages.find((page) => page.sheetInstancePath === selection.sheetInstancePath)?.id || state.selectedPageId : state.selectedPageId;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = { ...selection, pageId: state.selectedPageId };
  if (selection.anchor) state.selectionAnchor = selection.anchor;
  if (schematicRenderer) {
    schematicRenderer.selectedPageId = state.selectedPageId;
    schematicRenderer.selectedFeatureId = Number(selection.feature?.id || 0);
  }
  const net = selection.netUid ? scene.nets.find((item) => item.uid === selection.netUid) : null;
  const component = selection.reference ? scene.componentFeatures.get(selection.reference) : null;
  if (component) state.selectedFeatureId = Number(component.featureId || 0);
  selectionEl.textContent = JSON.stringify({ ...selection, net, component }, null, 2);
  updateSelectionCard();
}
function selectSchematicFeature(hit) {
  const { page, feature } = hit;
  if (!feature) {
    state.selectedSchematicFeature = null;
    schematicRenderer.selectedFeatureId = 0;
    selectSchematicPage(page.id, false);
    updateSelectionCard();
    return;
  }
  const featureId = Number(feature.id || 0);
  state.selectedPageId = page.id;
  schematicRenderer.selectedPageId = page.id;
  schematicRenderer.selectedFeatureId = featureId;
  state.selectedSchematicFeature = { ...feature, pageId: page.id };
  state.selectionAnchor = null;
  if (feature.netUid) {
    const net = scene.nets.find((item) => item.uid === feature.netUid);
    if (net) {
      selectSchematicNet(Number(net.id), false);
      state.selectedSchematicFeature = { ...feature, pageId: page.id };
      schematicRenderer.selectedFeatureId = featureId;
      return;
    }
  }
  if (feature.reference) {
    const component = scene.componentFeatures.get(feature.reference);
    if (component) {
      selectFeature(Number(component.featureId), false);
      state.selectedSchematicFeature = { ...feature, pageId: page.id };
      schematicRenderer.selectedFeatureId = featureId;
      return;
    }
  }
  state.activeNetId = 0;
  state.selectedFeatureId = 0;
  schematicRenderer.activeNetUid = "";
  selectionEl.textContent = JSON.stringify({ page: page.name, ...feature }, null, 2);
  updateSelectionCard();
}
function refreshControls() {
  layersEl.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });
  viewControlsEl.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === state.cameraTool);
  });
  viewControlsEl.querySelector("#show-board").checked = state.showBoard;
  viewControlsEl.querySelector("#show-components").checked = state.showComponents;
  viewControlsEl.querySelector("#separation").value = state.separation;
  const list = layersEl.querySelector(".layer-list");
  const selected = state.mode === "3d" ? state.visible3dLayers : state.desiredCompareLayers;
  list.innerHTML = scene.copperLayers.map((layer, index) => `
    <label class="layer-row">
      <input type="checkbox" data-layer="${layer.id}" ${selected.has(Number(layer.id)) ? "checked" : ""}>
      <span class="swatch" style="background:${rgbCss(layerColor(layer))}"></span>
      <span>${layer.name}</span><small>${index + 1}</small>
    </label>`).join("");
  list.querySelectorAll("[data-layer]").forEach((input) => input.addEventListener("change", () => {
    const layerId = Number(input.dataset.layer);
    if (state.mode === "3d") {
      input.checked ? state.visible3dLayers.add(layerId) : state.visible3dLayers.delete(layerId);
      scheduleTileResidency(performance.now(), { force: true });
    } else {
      const target = new Set(state.desiredCompareLayers);
      input.checked ? target.add(layerId) : target.delete(layerId);
      beginCompareLayerTransition(target);
    }
  }));
}
function bindControlEvents() {
  layersEl.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    if (state.mode === "layer") camera.setAxis("z", false);
    else {
      camera.frame(runtimeBoundsFromGltf(scene.manifest.bbox));
      state.visibleTileIds = /* @__PURE__ */ new Set();
    }
    refreshControls();
    scheduleTileResidency(performance.now(), { force: true });
  }));
  layersEl.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", () => {
    const target = state.mode === "3d" ? state.visible3dLayers : /* @__PURE__ */ new Set();
    target.clear();
    const preset = button.dataset.preset;
    for (const [index, layer] of scene.copperLayers.entries()) {
      const include = preset === "all" || preset === "outer" && (index === 0 || index === scene.copperLayers.length - 1) || preset === "inner" && index > 0 && index < scene.copperLayers.length - 1;
      if (include) target.add(Number(layer.id));
    }
    if (state.mode === "3d") scheduleTileResidency(performance.now(), { force: true });
    else beginCompareLayerTransition(target);
    refreshControls();
  }));
  viewControlsEl.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => {
    state.cameraTool = button.dataset.tool;
    refreshControls();
  }));
  viewControlsEl.querySelector("#show-board").addEventListener("change", (event) => {
    state.showBoard = event.target.checked;
  });
  viewControlsEl.querySelector("#show-components").addEventListener("change", (event) => {
    state.showComponents = event.target.checked;
  });
  viewControlsEl.querySelector("#separation").addEventListener("input", (event) => {
    state.separation = Number(event.target.value);
  });
  searchControlsEl.querySelector("#clear-selection").addEventListener("click", clearSelection);
  searchControlsEl.querySelector("#isolate-net").addEventListener("click", () => {
    state.isolateNet = !state.isolateNet;
    searchControlsEl.querySelector("#isolate-net").classList.toggle("active", state.isolateNet);
  });
  searchControlsEl.querySelector("#frame-selection").addEventListener("click", frameSelection);
  searchControlsEl.querySelector("#show-net-layers").addEventListener("click", showNetLayers);
  const search = searchControlsEl.querySelector("#entity-search");
  search.addEventListener("input", () => renderSearch(search.value));
}
function bindPanelTabs() {
  document.querySelectorAll(".rail-tab").forEach((button) => button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    const closing = state.activeTab === tab && !appEl.classList.contains("panel-collapsed");
    state.activeTab = tab;
    appEl.classList.toggle("panel-collapsed", closing);
    document.querySelectorAll(".rail-tab").forEach((item) => {
      item.classList.toggle("active", !closing && item.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-panel").forEach((item) => {
      item.classList.toggle("active", !closing && item.dataset.panel === tab);
    });
  }));
}
function showNetLayers() {
  const net = scene.nets.find((item) => Number(item.id) === state.activeNetId);
  if (!net) return;
  const names = new Set(net.metrics?.layers || []);
  const target = state.mode === "3d" ? state.visible3dLayers : /* @__PURE__ */ new Set();
  target.clear();
  for (const layer of scene.copperLayers) {
    if (names.has(layer.name)) target.add(Number(layer.id));
  }
  if (state.mode === "3d") scheduleTileResidency(performance.now(), { force: true });
  else beginCompareLayerTransition(target);
  refreshControls();
}
function renderSearch(query) {
  const container = searchControlsEl.querySelector("#search-results");
  const value = query.trim().toLowerCase();
  if (!value) {
    container.innerHTML = "";
    return;
  }
  const nets = scene.nets.filter((net) => String(net.name).toLowerCase().includes(value)).slice(0, 8);
  const components = [...scene.componentFeatures.values()].filter((item) => `${item.designator} ${item.value} ${item.footprint}`.toLowerCase().includes(value)).slice(0, 6);
  container.innerHTML = [
    ...nets.map((net) => `<button data-net="${net.id}"><b>${escapeHtml(net.name)}</b><span>${escapeHtml(net.netClass || "")}</span></button>`),
    ...components.map((item) => `<button data-feature="${item.featureId}"><b>${escapeHtml(item.designator)}</b><span>${escapeHtml(item.value)}</span></button>`)
  ].join("");
  container.querySelectorAll("[data-net]").forEach((button) => {
    button.addEventListener("click", () => selectNet(Number(button.dataset.net), true));
  });
  container.querySelectorAll("[data-feature]").forEach((button) => {
    button.addEventListener("click", () => selectFeature(Number(button.dataset.feature), true));
  });
}
function selectNet(netId, shouldFrame) {
  if (shouldFrame) state.selectionAnchor = null;
  state.activeNetId = netId;
  state.selectedFeatureId = 0;
  const net = scene.nets.find((item) => Number(item.id) === netId);
  if (state.workspace === "schematic" && net && schematicRenderer) {
    schematicScene.activeNetUid = net.uid;
    schematicRenderer.activeNetUid = net.uid;
  }
  selectionEl.textContent = JSON.stringify(net || {}, null, 2);
  updateSelectionCard();
  if (shouldFrame && net?.boundsMm) camera.frame(runtimeBounds(net.boundsMm));
  scheduleTileResidency(performance.now(), { force: true });
}
function selectFeature(featureId, shouldFrame = false) {
  const feature = scene.features.get(featureId);
  if (shouldFrame) state.selectionAnchor = null;
  state.selectedFeatureId = featureId;
  state.activeNetId = Number(feature?.netId || 0);
  selectionEl.textContent = feature ? JSON.stringify(feature, null, 2) : "No object selected";
  updateSelectionCard();
  if (shouldFrame && feature?.bounds) camera.frame(feature.bounds);
  scheduleTileResidency(performance.now(), { force: true });
}
function clearSelection() {
  state.activeNetId = 0;
  state.selectedFeatureId = 0;
  state.selectedSchematicFeature = null;
  state.selectionAnchor = null;
  state.isolateNet = false;
  schematicScene.activeNetUid = "";
  if (schematicRenderer) schematicRenderer.activeNetUid = "";
  schematicDomRenderer?.setSelection(null);
  schematicDomRenderer?.setHighlightedNet("");
  selectionEl.textContent = "No object selected";
  updateSelectionCard();
}
function selectionProperties(items) {
  return `<div class="selection-properties">${items.map(([label, value]) => `
    <div class="selection-property">
      <small>${escapeHtml(label)}</small>
      <strong title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</strong>
    </div>`).join("")}</div>`;
}
function selectionHeader(type, title, accent) {
  return `
    <div class="selection-card-head">
      <span class="selection-card-accent" style="background:${accent}"></span>
      <div class="selection-card-title"><small>${escapeHtml(type)}</small><strong>${escapeHtml(title)}</strong></div>
      <button class="selection-card-close" type="button" aria-label="Clear selection">&times;</button>
    </div>`;
}
function netSelectionContent(net) {
  const details = topology.net_details?.[net.uid] || {};
  const terminals = details.terminals || [];
  const metrics = net.metrics || {};
  const endpointRows = terminals.length ? terminals.slice(0, 12).map((terminal) => `
      <div class="selection-row">
        <span><strong>${escapeHtml(terminal.designator || "?")}</strong></span>
        <span>Pin ${escapeHtml(terminal.pin || "?")}</span>
        <span title="${escapeHtml(terminal.value || "")}">${escapeHtml(terminal.value || "Component")}</span>
      </div>`).join("") : `<div class="selection-empty">No connected pin metadata is available.</div>`;
  return `
    ${selectionHeader("Net", net.name, "#18ef52")}
    ${selectionProperties([
    ["Class", net.netClass || "Default"],
    ["Length", `${Number(metrics.traceLengthMm || 0).toFixed(2)} mm`],
    ["Layers", (metrics.layers || []).join(", ") || "Unknown"]
  ])}
    <div class="selection-section">
      <span class="selection-section-title">Connected pins</span>
      <div class="selection-table">
        ${endpointRows}
        ${terminals.length > 12 ? `<div class="selection-empty">${terminals.length - 12} additional pins</div>` : ""}
      </div>
    </div>`;
}
function componentSelectionContent(component) {
  const meshes = component.meshNames || [];
  return `
    ${selectionHeader("Component", component.designator || "Unknown", "#3b82f6")}
    ${selectionProperties([
    ["Value", component.value || "Not specified"],
    ["Footprint", component.footprint || "Not specified"],
    ["Models", meshes.length || 0]
  ])}
    <div class="selection-section">
      <span class="selection-section-title">Component details</span>
      <div class="selection-table">
        <div class="selection-row">
          <span><strong>Reference</strong></span>
          <span>${escapeHtml(component.designator || "Unknown")}</span>
          <span title="${escapeHtml(component.uid || "")}">${escapeHtml(component.uid || "No source UID")}</span>
        </div>
        <div class="selection-row">
          <span><strong>Geometry</strong></span>
          <span>${meshes.length} ${meshes.length === 1 ? "mesh" : "meshes"}</span>
          <span title="${escapeHtml(meshes.join(", "))}">${escapeHtml(meshes.join(", ") || "No named model nodes")}</span>
        </div>
      </div>
    </div>`;
}
function schematicFeatureSelectionContent(feature, page) {
  const kind = String(feature.kind || "").toLowerCase();
  const isPin = kind.startsWith("pin");
  const isComponent = kind === "component" || kind.includes("symbol");
  if (isComponent) {
    return `
      ${selectionHeader("Component", feature.reference || feature.componentDesignator || "Unknown", "#3b82f6")}
      ${selectionProperties([
      ["Value", feature.value || feature.componentValue || "Not specified"],
      ["Footprint", feature.componentFootprint || feature.footprint || "Not specified"],
      ["Library", feature.libraryRef || "Not specified"],
      ["UID", feature.componentUid || feature.uuid || feature.sourceId || "Not resolved"]
    ])}
      <div class="selection-section">
        <span class="selection-section-title">Schematic placement</span>
        ${selectionProperties([
      ["Page", page?.name || "Unknown"],
      ["Sheet", feature.sheetInstancePath || "/"]
    ])}
      </div>`;
  }
  const pinRows = isPin ? [
    ["Symbol", feature.reference || feature.designator || "Unknown"],
    ["Value", feature.value || feature.componentValue || "Not specified"],
    ["Pin", `${feature.pinNumber || "-"}${feature.pinName ? ` ${feature.pinName}` : ""}`],
    ["Net", feature.netName || "Not connected"],
    ["PCB Pad", feature.pcbPadId || "Not resolved"],
    ["Component UID", feature.componentUid || "Not resolved"]
  ] : [
    ["Page", page?.name || "Unknown"],
    ["Kind", feature.kind.replaceAll("_", " ")],
    ["Net", feature.netName || "Not connected"]
  ];
  return `
    ${selectionHeader(
    feature.kind.replaceAll("_", " "),
    feature.pinName || feature.reference || feature.designator || feature.text || feature.netName || "Schematic object",
    "#3b82f6"
  )}
    ${selectionProperties(pinRows)}
    <div class="selection-section">
      <span class="selection-section-title">Source identity</span>
      <div class="selection-table">
        <div class="selection-row">
          <span><strong>${isPin ? "Pin UUID" : "UUID"}</strong></span>
          <span title="${escapeHtml(feature.uuid || feature.sourceId || "")}">${escapeHtml(feature.uuid || feature.sourceId || "-")}</span>
          <span title="${escapeHtml(feature.objectId || "")}">${escapeHtml(feature.objectId || "No object ID")}</span>
        </div>
        <div class="selection-row">
          <span><strong>Sheet</strong></span>
          <span>${escapeHtml(page?.name || "Unknown")}</span>
          <span title="${escapeHtml(feature.sheetInstancePath || "")}">${escapeHtml(feature.sheetInstancePath || "/")}</span>
        </div>
      </div>
    </div>`;
}
function updateSelectionCard() {
  const feature = scene.features.get(state.selectedFeatureId);
  const component = feature?.kind === "component" ? feature : null;
  const schematicFeature = state.workspace === "schematic" ? state.selectedSchematicFeature : null;
  const schematicPage = schematicFeature ? schematicScene.byId.get(schematicFeature.pageId) : null;
  const net = state.activeNetId ? scene.nets.find((item) => Number(item.id) === state.activeNetId) : null;
  if (!component && !net && !schematicFeature) {
    selectionCardEl.hidden = true;
    selectionCardEl.innerHTML = "";
    return;
  }
  selectionCardEl.innerHTML = `
    ${schematicFeature ? schematicFeatureSelectionContent(schematicFeature, schematicPage) : component ? componentSelectionContent(component) : netSelectionContent(net)}
    <div class="selection-card-actions">
      <button type="button" data-action="frame">Frame selection</button>
    </div>`;
  selectionCardEl.hidden = false;
  const activeCanvas = state.workspace === "schematic" ? schematicCanvas : canvas;
  const anchor = state.selectionAnchor;
  if (anchor) {
    const maxLeft = Math.max(16, activeCanvas.clientWidth - 380);
    const maxTop = Math.max(16, activeCanvas.clientHeight - 330);
    selectionCardEl.style.left = `${clamp(anchor.x + 18, 16, maxLeft)}px`;
    selectionCardEl.style.top = `${clamp(anchor.y + 18, 16, maxTop)}px`;
  } else {
    selectionCardEl.style.left = "20px";
    selectionCardEl.style.top = "20px";
  }
  selectionCardEl.querySelector(".selection-card-close").addEventListener("click", clearSelection);
  selectionCardEl.querySelector("[data-action=frame]").addEventListener("click", frameSelection);
}
function frameSelection() {
  if (state.workspace === "schematic") {
    frameSchematicSelection();
    return;
  }
  const feature = scene.features.get(state.selectedFeatureId);
  if (feature?.bounds) camera.frame(feature.bounds);
  else {
    const net = scene.nets.find((item) => Number(item.id) === state.activeNetId);
    if (net?.boundsMm) camera.frame(runtimeBounds(net.boundsMm));
  }
}
function bindInteractions() {
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    state.dragging = true;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.pointerStartX = event.clientX;
    state.pointerStartY = event.clientY;
    state.dragMode = state.mode === "layer" || state.cameraTool === "pan" || event.shiftKey || event.button !== 0 ? "pan" : "orbit";
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (state.dragMode === "pan") camera.pan(dx, dy, canvas.clientHeight, state.mode === "layer");
    else camera.orbit(dx, dy);
  });
  canvas.addEventListener("pointerup", async (event) => {
    state.dragging = false;
    canvas.releasePointerCapture(event.pointerId);
    if (Math.hypot(event.clientX - state.pointerStartX, event.clientY - state.pointerStartY) < 3) {
      await pickAt(event);
    }
  });
  canvas.addEventListener("dblclick", async (event) => {
    await pickAt(event);
    frameSelection();
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 0.4) {
      camera.pan(-event.deltaX, 0, canvas.clientHeight, state.mode === "layer");
    } else {
      camera.dolly(event.deltaY, state.mode === "layer");
    }
  }, { passive: false });
  window.addEventListener("keydown", handleKey);
}
function bindWorkspaceTabs() {
  document.querySelectorAll("[data-workspace]").forEach((button) => {
    button.addEventListener("click", () => switchWorkspace(button.dataset.workspace));
  });
}
function switchWorkspace(workspace) {
  if (workspace === "schematic" && !schematicRenderer) return;
  state.workspace = workspace;
  const schematic = workspace === "schematic";
  canvas.hidden = schematic;
  schematicCanvas.hidden = !schematic;
  schematicDomLayer.hidden = !schematic || !schematicDomRenderer;
  schematicFlowOverlay.hidden = !schematic;
  gizmo.hidden = schematic;
  labelsEl.hidden = schematic;
  schematicLabelsEl.hidden = !schematic;
  document.querySelectorAll("[data-workspace]").forEach((button) => {
    button.classList.toggle("active", button.dataset.workspace === workspace);
  });
  statusEl.textContent = schematic ? schematicDomRenderer ? "SVG DOM + WebGPU schematic world active" : "WebGPU schematic world active" : "WebGPU semantic glTF active";
  if (schematic && !schematicScene.fitted) {
    schematicRenderer.resize();
    schematicRenderer.frameWorld();
    schematicScene.fitted = true;
  }
  renderControls();
}
function bindSchematicInteractions() {
  schematicCanvas.addEventListener("pointerdown", (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    state.schematicDragging = true;
    state.schematicLastX = event.clientX;
    state.schematicLastY = event.clientY;
    state.schematicStartX = event.clientX;
    state.schematicStartY = event.clientY;
    schematicCanvas.setPointerCapture(event.pointerId);
  });
  schematicCanvas.addEventListener("pointermove", (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    if (!state.schematicDragging || !schematicRenderer) return;
    const dx = event.clientX - state.schematicLastX;
    const dy = event.clientY - state.schematicLastY;
    state.schematicLastX = event.clientX;
    state.schematicLastY = event.clientY;
    schematicRenderer.pan(dx, dy);
  });
  schematicCanvas.addEventListener("pointerup", async (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    state.schematicDragging = false;
    schematicCanvas.releasePointerCapture(event.pointerId);
    if (Math.hypot(event.clientX - state.schematicStartX, event.clientY - state.schematicStartY) < 3) {
      const hit = await schematicRenderer.pickFeature(event.clientX, event.clientY);
      if (hit) selectSchematicFeature(hit);
      else clearSchematicSelection();
    }
  });
  schematicCanvas.addEventListener("dblclick", (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    const page = schematicRenderer.hitPage(event.clientX, event.clientY);
    if (page) selectSchematicPage(page.id, true);
  });
  schematicCanvas.addEventListener("wheel", (event) => {
    if (schematicDomRenderer?.worldActive || schematicDomRenderer?.active) return;
    event.preventDefault();
    schematicRenderer.zoom(event.deltaY, event.clientX, event.clientY);
  }, { passive: false });
}
async function pickAt(event) {
  if (!panel) return;
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.width / rect.width;
  const y = (event.clientY - rect.top) * canvas.height / rect.height;
  state.selectionAnchor = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
  const featureId = await renderer.pick(panel, x, y, {
    activeNetId: state.activeNetId,
    selectedFeatureId: state.selectedFeatureId,
    layerOffsets: stackupOffsets(),
    visibleLayers: state.mode === "3d" ? state.visible3dLayers : state.compareLayers,
    showBoard: state.showBoard,
    showComponents: state.showComponents,
    componentOpacity: clamp(1 - state.separation / 0.1, 0, 1),
    boardOpacity: 1 - state.separation * 0.72,
    isolateNet: state.isolateNet,
    compareMode: state.mode === "layer",
    compareOffsets,
    visibleTileIds: state.mode === "3d" ? state.visibleTileIds : null
  });
  if (featureId) selectFeature(featureId, false);
  else clearSelection();
}
function handleKey(event) {
  if (event.target instanceof HTMLInputElement) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  const key = event.key.toLowerCase();
  if (state.workspace === "schematic") {
    if (key === "/") {
      event.preventDefault();
      openTab("search");
      searchControlsEl.querySelector("#entity-search")?.focus();
    } else if (key === "escape") {
      if (schematicScene.activeNetUid) {
        schematicScene.activeNetUid = "";
        state.activeNetId = 0;
        schematicRenderer.activeNetUid = "";
        schematicDomRenderer?.setHighlightedNet("");
        updateSelectionCard();
      } else clearSchematicSelection();
    } else if (key === "~" || event.key === "~") {
      event.preventDefault();
      const netUid = state.selectedSchematicFeature?.netUid;
      if (netUid) {
        if (schematicScene.activeNetUid === netUid) {
          schematicScene.activeNetUid = "";
          state.activeNetId = 0;
          schematicRenderer.activeNetUid = "";
          schematicDomRenderer?.setHighlightedNet("");
        } else highlightSchematicNetByUid(netUid, state.selectedSchematicFeature);
      }
    } else if (key === "home") {
      schematicRenderer?.frameWorld();
    } else if (key === "[") navigateSchematic("previous");
    else if (key === "]") navigateSchematic("next");
    else if (key === "n") {
      event.preventDefault();
      const result = schematicRenderer?.cycleNetIntrasheetLink(event.shiftKey ? -1 : 1);
      if (result?.pageId) {
        state.selectedPageId = result.pageId;
        schematicRenderer.selectedPageId = result.pageId;
        updateSchematicLabels();
      }
    } else if (event.altKey && key === "arrowup") navigateSchematic("parent");
    else if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const dx = event.key === "ArrowRight" ? 32 : event.key === "ArrowLeft" ? -32 : 0;
      const dy = event.key === "ArrowDown" ? 32 : event.key === "ArrowUp" ? -32 : 0;
      schematicRenderer?.pan(dx, dy);
    }
    return;
  }
  if (key === "/") {
    event.preventDefault();
    openTab("search");
    searchControlsEl.querySelector("#entity-search").focus();
  } else if (key === "escape") clearSelection();
  else if (key === "home") camera.frame(runtimeBoundsFromGltf(scene.manifest.bbox));
  else if (["x", "y", "z"].includes(key)) camera.setAxis(key, event.shiftKey);
  else if (key === "f") camera.flip();
  else if (key === "r") camera.rotateZ(event.shiftKey ? -1 : 1);
  else if (key === " ") {
    event.preventDefault();
    const feature = scene.features.get(state.selectedFeatureId);
    if (feature?.bounds) {
      camera.setFocus([
        (feature.bounds[0] + feature.bounds[3]) / 2,
        (feature.bounds[1] + feature.bounds[4]) / 2,
        (feature.bounds[2] + feature.bounds[5]) / 2
      ]);
    }
  } else if (event.key.startsWith("Arrow")) {
    event.preventDefault();
    const dx = event.key === "ArrowRight" ? 32 : event.key === "ArrowLeft" ? -32 : 0;
    const dy = event.key === "ArrowDown" ? 32 : event.key === "ArrowUp" ? -32 : 0;
    camera.pan(dx, dy, canvas.clientHeight, state.mode === "layer");
  }
}
function openTab(tab) {
  state.activeTab = tab;
  appEl.classList.remove("panel-collapsed");
  document.querySelectorAll(".rail-tab").forEach((item) => {
    item.classList.toggle("active", item.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((item) => {
    item.classList.toggle("active", item.dataset.panel === tab);
  });
}
function drawGizmo() {
  const context = gizmo.getContext("2d");
  context.clearRect(0, 0, gizmo.width, gizmo.height);
  const center = [gizmo.width / 2, gizmo.height / 2];
  const basis = camera.basis();
  const worldAxes = [
    { axis: "x", label: "X", color: "#e23838", vector: [1, 0, 0] },
    { axis: "y", label: "Y", color: "#2dbd50", vector: [0, 1, 0] },
    { axis: "z", label: "Z", color: "#3157d5", vector: [0, 0, 1] }
  ];
  const endpoints = [];
  for (const axis of worldAxes) {
    for (const sign of [-1, 1]) {
      const vector = axis.vector.map((value) => value * sign);
      const projected = [
        dot3(vector, basis.right),
        -dot3(vector, basis.up),
        dot3(vector, basis.back)
      ];
      endpoints.push({
        ...axis,
        sign,
        depth: projected[2],
        point: [center[0] + projected[0] * 34, center[1] + projected[1] * 34]
      });
    }
  }
  for (const axis of worldAxes) {
    const positive = endpoints.find((item) => item.axis === axis.axis && item.sign === 1);
    context.strokeStyle = axis.color;
    context.lineWidth = 2.4;
    context.beginPath();
    context.moveTo(...center);
    context.lineTo(...positive.point);
    context.stroke();
  }
  gizmoHits = [];
  for (const endpoint of endpoints.sort((a, b) => b.depth - a.depth)) {
    const front = endpoint.sign === 1;
    const radius = front ? 13 : 9;
    context.beginPath();
    context.arc(endpoint.point[0], endpoint.point[1], radius, 0, Math.PI * 2);
    context.fillStyle = front ? endpoint.color : `${endpoint.color}66`;
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = darken(endpoint.color, front ? 0.45 : 0.58);
    context.stroke();
    if (front) {
      context.fillStyle = "#07101c";
      context.font = "700 13px system-ui";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(endpoint.label, endpoint.point[0], endpoint.point[1] + 0.5);
    }
    gizmoHits.push({ ...endpoint, radius: radius + 5 });
  }
}
gizmo.addEventListener("click", (event) => {
  const scaleX = gizmo.width / gizmo.clientWidth;
  const scaleY = gizmo.height / gizmo.clientHeight;
  const point = [event.offsetX * scaleX, event.offsetY * scaleY];
  const hit = gizmoHits.map((item) => ({ item, distance: Math.hypot(point[0] - item.point[0], point[1] - item.point[1]) })).filter(({ item, distance }) => distance <= item.radius).sort((a, b) => a.distance - b.distance)[0]?.item;
  if (hit) camera.setAxis(hit.axis, hit.sign < 0);
});
function updateLayerLabels() {
  if (state.mode !== "layer" || !panel) {
    labelsEl.innerHTML = "";
    return;
  }
  const bounds = runtimeBoundsFromGltf(scene.manifest.bbox);
  const visibleLayers = compareRenderLayers();
  labelsEl.innerHTML = scene.copperLayers.filter((layer) => visibleLayers.has(Number(layer.id))).map((layer) => {
    const offset = compareOffsets.get(Number(layer.id)) || [0, 0, 0];
    const screen = projectPoint(
      [bounds[0] + offset[0], bounds[4] + offset[1], 0],
      panel.matrix,
      canvas.clientWidth,
      canvas.clientHeight
    );
    if (!screen || screen[0] < -100 || screen[0] > canvas.clientWidth + 100 || screen[1] < -100 || screen[1] > canvas.clientHeight + 100) return "";
    return `<span style="left:${screen[0]}px;top:${screen[1]}px">${escapeHtml(layer.name)}</span>`;
  }).join("");
}
function updateSchematicLabels() {
  if (state.workspace !== "schematic" || !schematicRenderer) {
    schematicLabelsEl.innerHTML = "";
    return;
  }
  schematicLabelsEl.innerHTML = schematicScene.visiblePages.filter((page) => schematicRenderer.pagePixelWidth(page) > 120).map((page) => {
    const [left, top] = schematicRenderer.worldToScreen(
      page.worldX + 8 * schematicRenderer.scale,
      page.worldY - 6 * schematicRenderer.scale
    );
    const selected = page.id === state.selectedPageId;
    const containsNet = schematicScene.activeNetUid && page.netUids.includes(schematicScene.activeNetUid);
    const accent = containsNet ? "#18ef52" : selected ? "#3b82f6" : "#4b8de8";
    return `<div class="schematic-page-label" style="left:${left}px;top:${top}px;border-left-color:${accent}">
        <strong>${escapeHtml(page.name)}</strong>
        <small>Page ${page.sheetNumber} &middot; ${page.featureCount.toLocaleString()} features</small>
      </div>`;
  }).join("");
}
function projectPoint(point, matrix, width, height) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (Math.abs(clipW) < 1e-8) return null;
  return [
    (clipX / clipW * 0.5 + 0.5) * width,
    (0.5 - clipY / clipW * 0.5) * height
  ];
}
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function darken(color, factor) {
  const clean2 = color.replace("#", "");
  return `#${[0, 2, 4].map((offset) => Math.round(parseInt(clean2.slice(offset, offset + 2), 16) * factor).toString(16).padStart(2, "0")).join("")}`;
}
function recordFrameSample(intervalMs, cpuMs) {
  state.frameSamples.push({ intervalMs, cpuMs });
  if (state.frameSamples.length > 180) state.frameSamples.shift();
}
function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
function updateDiagnostics(now) {
  state.frames += 1;
  if (now - state.fpsAt <= 500) return;
  state.fps = state.frames * 1e3 / (now - state.fpsAt);
  const samples = state.frameSamples;
  state.frameIntervalMs = samples.length ? samples.reduce((sum, item) => sum + item.intervalMs, 0) / samples.length : 0;
  state.frameCpuMs = samples.length ? samples.reduce((sum, item) => sum + item.cpuMs, 0) / samples.length : 0;
  state.frameIntervalP95Ms = percentile(samples.map((item) => item.intervalMs), 0.95);
  state.frameCpuP95Ms = percentile(samples.map((item) => item.cpuMs), 0.95);
  state.frames = 0;
  state.fpsAt = now;
  const schematicStats = state.workspace === "schematic" && schematicRenderer ? schematicRenderer.stats() : null;
  const domStats = state.workspace === "schematic" && schematicDomRenderer ? schematicDomRenderer.stats() : null;
  const rows = state.workspace === "schematic" && schematicRenderer ? schematicDomRenderer?.active ? [
    ["Renderer", "SVG DOM schematic detail"],
    ["Pages", schematicScene.pages.length],
    ["Mounted pages", domStats.mountedPages],
    ["Active page", domStats.activePage],
    ["DOM nodes", domStats.domNodes.toLocaleString()],
    ["Indexed features", domStats.indexedFeatures.toLocaleString()],
    ["Indexed nets", domStats.indexedNets.toLocaleString()],
    ["SVG cache", `${domStats.cachedSvgPages} pages / ${(domStats.cachedSvgBytes / 1048576).toFixed(1)} MB`],
    ["Selection", `${domStats.selectionMs.toFixed(1)} ms`],
    ["Active net", scene.nets.find((net) => net.uid === schematicScene.activeNetUid)?.name || "-"],
    ["Tracking links", `${schematicStats.netFlowSegments} total / ${schematicStats.netFlowIntrasheetSegments} local`],
    ["Tracking verts", schematicStats.netFlowVertices.toLocaleString()],
    ["Mount", `${domStats.mountMs.toFixed(1)} ms`],
    ["Highlight", `${domStats.highlightMs.toFixed(1)} ms`],
    ["Fallback", domStats.fallbackReason || "-"],
    ["Frame interval", `${state.frameIntervalMs.toFixed(2)} ms avg / ${state.frameIntervalP95Ms.toFixed(2)} p95`],
    ["CPU frame", `${state.frameCpuMs.toFixed(2)} ms avg / ${state.frameCpuP95Ms.toFixed(2)} p95`],
    ["FPS", state.fps.toFixed(1)]
  ] : [
    ["Renderer", schematicDomRenderer ? "SVG DOM + WebGPU world" : "WebGPU schematic world"],
    ["Pages", schematicScene.pages.length],
    ["Visible pages", schematicScene.visiblePages.length],
    ["DOM pages", domStats ? domStats.mountedPages : 0],
    ["DOM nodes", domStats ? domStats.domNodes.toLocaleString() : "0"],
    ["Indexed SVG features", domStats ? domStats.indexedFeatures.toLocaleString() : "0"],
    ["SVG cache", domStats ? `${domStats.cachedSvgPages} pages / ${(domStats.cachedSvgBytes / 1048576).toFixed(1)} MB` : "0 pages"],
    ["JS heap", domStats?.heapMb ? `${domStats.heapMb.toFixed(1)} MB` : "-"],
    ["Hierarchy links", schematicScene.manifest.edges?.length || 0],
    ["Selected page", schematicScene.byId.get(state.selectedPageId)?.name || "-"],
    ["Active net", scene.nets.find((net) => net.uid === schematicScene.activeNetUid)?.name || "-"],
    ["Tracking links", `${schematicStats.netFlowSegments} total / ${schematicStats.netFlowIntrasheetSegments} local`],
    ["Downloaded", `${(schematicRenderer.downloadedBytes / 1048576).toFixed(1)} MB`],
    ["Resident vectors", `${(schematicStats.residentVectorBytes / 1048576).toFixed(1)} MB`],
    ["Vector pages", `${schematicStats.vectorChunks} loaded / ${schematicStats.vectorLoads} loading`],
    ["Vector draw", `${schematicStats.vectorVertices.toLocaleString()} verts / ${schematicStats.vectorDrawChunks} chunks`],
    ["Native detail", `${schematicStats.nativeDetailPages} pages @ ${schematicStats.nativePxPerMm} / ${schematicStats.nativeThresholdPxPerMm} px/mm`],
    ["Vector failures", schematicStats.failedVectorChunks],
    ["Truncated", schematicStats.truncatedVectors],
    ["Frame interval", `${state.frameIntervalMs.toFixed(2)} ms avg / ${state.frameIntervalP95Ms.toFixed(2)} p95`],
    ["CPU frame", `${state.frameCpuMs.toFixed(2)} ms avg / ${state.frameCpuP95Ms.toFixed(2)} p95`],
    ["FPS", state.fps.toFixed(1)]
  ] : [
    ["Renderer", "WebGPU semantic glTF"],
    ["Mode", state.mode === "3d" ? "3D" : "Layer Compare"],
    ["Visible layers", state.mode === "3d" ? state.visible3dLayers.size : state.compareLayers.size],
    ["Resident tiles", scene.loaded.size],
    ["Loading tiles", scene.loading.size],
    ["Failed tiles", scene.failed.size],
    ["Triangles", Math.round(state.triangles).toLocaleString()],
    ["Downloaded", `${(state.loadedBytes / 1048576).toFixed(1)} MB`],
    ["Resident GLB", `${(state.residentTileBytes / 1048576).toFixed(1)} MB`],
    ["Resident GPU", `${(state.residentTileGpuBytes / 1048576).toFixed(1)} MB`],
    ["Tile loads", state.tileLoads.toLocaleString()],
    ["Tile evictions", state.tileEvictions.toLocaleString()],
    ["Tile scheduler", `${state.tileSchedulerMs.toFixed(2)} ms`],
    ["Active net", scene.nets.find((net) => Number(net.id) === state.activeNetId)?.name || "-"],
    ["Frame interval", `${state.frameIntervalMs.toFixed(2)} ms avg / ${state.frameIntervalP95Ms.toFixed(2)} p95`],
    ["CPU frame", `${state.frameCpuMs.toFixed(2)} ms avg / ${state.frameCpuP95Ms.toFixed(2)} p95`],
    ["FPS", state.fps.toFixed(1)]
  ];
  diagnosticsEl.innerHTML = rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
}
function rgbCss(color) {
  return `rgb(${color.slice(0, 3).map((value) => Math.round(value * 255)).join(" ")})`;
}
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
  );
}
export {
  mountStandaloneViewer
};
