import {
  add,
  boundsCenter,
  boundsRadius,
  clamp,
  lookAt,
  mat4Multiply,
  mix,
  orthographic,
  perspective,
  quatAxis,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatRotate,
  quatSlerp,
  scale,
  sub,
} from "./math.js";

const TOP = quatIdentity();

export class CameraController {
  constructor(bounds) {
    const center = boundsCenter(bounds);
    const radius = boundsRadius(bounds);
    this.focus = [...center];
    this.targetFocus = [...center];
    this.orientation = [...TOP];
    this.targetOrientation = [...TOP];
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
    this.orientation = quatSlerp(this.orientation, this.targetOrientation, amount);
    this.distance = mix(this.distance, this.targetDistance, amount);
    this.orthoScale = mix(this.orthoScale, this.targetOrthoScale, amount);
  }

  basis() {
    return {
      right: quatRotate(this.orientation, [1, 0, 0]),
      up: quatRotate(this.orientation, [0, 1, 0]),
      back: quatRotate(this.orientation, [0, 0, 1]),
    };
  }

  matrix(width, height, orthographicMode = false) {
    const aspect = Math.max(0.01, width / Math.max(1, height));
    const { up, back } = this.basis();
    const eye = add(this.focus, scale(back, this.distance));
    const view = lookAt(eye, this.focus, up);
    const projection = orthographicMode
      ? orthographic(this.orthoScale * aspect, this.orthoScale, -this.sceneRadius * 20, this.sceneRadius * 20)
      : perspective(this.fov, aspect, Math.max(0.0001, this.sceneRadius / 10000), this.sceneRadius * 100);
    return mat4Multiply(projection, view);
  }

  orbit(dx, dy) {
    const yaw = quatAxis([0, 0, 1], -dx * 0.006);
    const right = this.basis().right;
    const pitch = quatAxis(right, -dy * 0.006);
    this.targetOrientation = quatNormalize(
      quatMultiply(pitch, quatMultiply(yaw, this.targetOrientation)),
    );
  }

  pan(dx, dy, viewportHeight, orthographicMode = false) {
    const { right, up } = this.basis();
    const worldPerPixel = orthographicMode
      ? this.targetOrthoScale / Math.max(1, viewportHeight)
      : (2 * this.targetDistance * Math.tan(this.fov / 2)) / Math.max(1, viewportHeight);
    // Board-drag semantics: dragging right moves content right.
    const movement = add(scale(right, -dx * worldPerPixel), scale(up, dy * worldPerPixel));
    this.targetFocus = add(this.targetFocus, movement);
  }

  dolly(delta, orthographicMode = false) {
    if (orthographicMode) {
      this.targetOrthoScale = clamp(
        this.targetOrthoScale * Math.exp(delta * 0.001),
        this.sceneRadius * 0.015,
        this.sceneRadius * 20,
      );
    } else {
      this.targetDistance = clamp(
        this.targetDistance * Math.exp(delta * 0.001),
        this.sceneRadius * 0.02,
        this.sceneRadius * 40,
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
    const turns = {
      top: TOP,
      bottom: quatAxis([1, 0, 0], Math.PI),
      right: quatAxis([0, 1, 0], -Math.PI / 2),
      left: quatAxis([0, 1, 0], Math.PI / 2),
      front: quatAxis([1, 0, 0], Math.PI / 2),
      back: quatAxis([1, 0, 0], -Math.PI / 2),
    };
    const key =
      axis === "x" ? (opposite ? "left" : "right")
        : axis === "y" ? (opposite ? "back" : "front")
          : (opposite ? "bottom" : "top");
    this.targetOrientation = [...turns[key]];
  }

  rotateZ(direction = 1) {
    this.targetOrientation = quatNormalize(
      quatMultiply(quatAxis([0, 0, 1], direction * Math.PI / 2), this.targetOrientation),
    );
  }

  flip() {
    this.targetOrientation = quatNormalize(
      quatMultiply(quatAxis(this.basis().right, Math.PI), this.targetOrientation),
    );
  }
}
