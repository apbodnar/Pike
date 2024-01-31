import { Vec3 } from './util/vector.js'

export class BoundingBox {
  constructor() {
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
    this._centroid = null;
  }

  addVertex(vert) {
    this.min = Vec3.min(vert, this.min);
    this.max = Vec3.max(vert, this.max);
    this._centroid = null;
    return this;
  }

  addTriangle(triangle) {
    for (let i = 0; i < triangle.verts.length; i++) {
      this.addVertex(triangle.verts[i]);
    }
    this._centroid = null;
    return this;
  }

  addBoundingBox(box) {
    this.min = Vec3.min(this.min, box.min);
    this.max = Vec3.max(this.max, box.max);
    this._centroid = null;
    return this;
  }

  get centroid() {
    if (!this._centroid) {
      this._centroid = Vec3.scale(Vec3.add(this.min, this.max), 0.5);
    }
    return this._centroid;
  }

  getSurfaceArea() {
    let xl = Math.max(this.max[0] - this.min[0], 0);
    let yl = Math.max(this.max[1] - this.min[1], 0);
    let zl = Math.max(this.max[2] - this.min[2], 0);
    return (xl * yl + xl * zl + yl * zl) * 2;
  }

  intersectBox(box) {
    this.min = Vec3.max(this.min, box.min);
    this.max = Vec3.min(this.max, box.max);
    return this;
  }

  axisIntersectTriangle(triangle, axis) {
    const temp = new BoundingBox();
    const axisMin = this.min[axis] - Number.EPSILON * 2;
    const axisMax = this.max[axis] + Number.EPSILON * 2;
    for (let i = 0; i < 3; i++) {
      const v0 = triangle.verts[i];
      const v1 = triangle.verts[(i + 1) % 3];
      const p0 = v0[axis];
      const p1 = v1[axis];
      const tMin = (axisMin - p0) / (p1 - p0);
      if (tMin >= 0 && tMin <= 1) {
        temp.addVertex(Vec3.lerp1(v0, v1, tMin));
      }
      const tMax = (axisMax - p0) / (p1 - p0);
      if (tMax >= 0 && tMax <= 1) {
        temp.addVertex(Vec3.lerp1(v0, v1, tMax));
      }
      if (p0 >= axisMin && p0 <= axisMax) {
        temp.addVertex(v0);
      }
    }
    // remove this
    if (!temp.isFinite()) {
      alert("bad box");
    }
    this._centroid = null;
    this.max = temp.max;
    this.min = temp.min;
  }

  isFinite() {
    for (const v of [...this.max, ...this.min]) {
      if (!Number.isFinite(v)) {
        return false;
      }
    }
    return true;
  }

  clone() {
    return new BoundingBox().addBoundingBox(this);
  }
}


export class Triangle {
  constructor(desc, attributes) {
    this.desc = desc;
    this.attributes = attributes;
    this.verts = [desc.i0, desc.i1, desc.i2].map((i) => { return this.attributes[i].pos });
  }
}