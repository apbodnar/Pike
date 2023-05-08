import {
  Vec3
} from './util/vector.js'

export class CameraController {
  constructor(canvas, ray, onChange) {
    let xi, yi;
    this.ray = ray;
    let mode = false;
    const keySet = new Set(['w', 'a', 's', 'd', 'r', 'f']);
    this.activeEvents = new Set();
    this.fovScale = 1;
    this.onChange = onChange;
    this.time = performance.now();

    canvas.addEventListener("mousedown", (e) => {
      mode = e.which === 1;
      xi = e.layerX;
      yi = e.layerY;
    }, false);
    canvas.addEventListener("mousemove", (e) => {
      if (mode) {
        this.activeEvents.add("mouse");
        let rx = (xi - e.layerX) / 180.0;
        let ry = (yi - e.layerY) / 180.0;
        this.ray.dir = Vec3.normalize(Vec3.rotateY(this.ray.dir, rx));
        let axis = Vec3.normalize(Vec3.cross(this.ray.dir, [0, 1, 0]));
        this.ray.dir = Vec3.normalize(Vec3.rotateArbitrary(this.ray.dir, axis, -ry));
        xi = e.layerX;
        yi = e.layerY;
      }
    }, false);
    canvas.addEventListener("mouseup", () => {
      mode = false;
      this.activeEvents.delete("mouse");
    }, false);
    canvas.addEventListener('mousewheel', (e) => {
      this.fovScale -= e.wheelDelta / 1200 * this.fovScale;
      this.onChange({ray: this.ray, fov: this.fovScale});
    }, false);

    document.addEventListener("keypress", (e) => {
      if (keySet.has(e.key)) {
        this.activeEvents.add(e.key);
      }
    }, false);
    document.addEventListener("keyup", (e) => {
      if (keySet.has(e.key)) {
        this.activeEvents.delete(e.key);
      }
    });
    this._integrate();
  }

  _addTranslation(shift) {
    this.ray.origin = Vec3.add(this.ray.origin, shift);
  }

  getCameraRay() {
    return this.ray;
  }

  getFov() {
    return this.fovScale;
  }

  _integrate() {
    const now = performance.now();
    const delta = (now - this.time) / 1000;
    this.time = now;
    const strafe = Vec3.normalize(Vec3.cross(this.ray.dir, [0, 1, 0]));
    for (const key of this.activeEvents) {
      switch (key) {
        case 'w':
          this._addTranslation(Vec3.scale(this.ray.dir, delta));
          break;
        case 'a':
          this._addTranslation(Vec3.scale(strafe, -delta));
          break;
        case 's':
          this._addTranslation(Vec3.scale(this.ray.dir, -delta));
          break;
        case 'd':
          this._addTranslation(Vec3.scale(strafe, delta));
          break;
        case 'r':
          this._addTranslation(Vec3.scale(Vec3.normalize(Vec3.cross(this.ray.dir, strafe)), -delta));
          break;
        case 'f':
          this._addTranslation(Vec3.scale(Vec3.normalize(Vec3.cross(this.ray.dir, strafe)), delta));
          break;
      }
    }
    if (this.activeEvents.size) {
      this.onChange({ray: this.ray, fov: this.fovScale});
    }
    requestAnimationFrame(() => { this._integrate() });
  }  
}