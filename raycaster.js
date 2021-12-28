import { Vec3 } from './vector.js'

const MAX_T = 1e6;

export class Raycaster {

  constructor(bvh) {
    this.bvh = bvh;
  }

  rayTriangleIntersect(ray, tri) {
    let epsilon = 0.000000000001;
    let e1 = Vec3.sub(tri.verts[1], tri.verts[0]);
    let e2 = Vec3.sub(tri.verts[2], tri.verts[0]);
    let p = Vec3.cross(ray.dir, e2);
    let det = Vec3.dot(e1, p);
    if (det > -epsilon && det < epsilon) {
      return MAX_T
    }
    let invDet = 1.0 / det;
    let t = Vec3.sub(ray.pos, tri.verts[0]);
    let u = Vec3.dot(t, p) * invDet;
    if (u < 0 || u > 1) {
      return MAX_T
    }
    let q = Vec3.cross(t, e1);
    let v = Vec3.dot(ray.dir, q) * invDet;
    if (v < 0 || u + v > 1) {
      return MAX_T
    }
    t = Vec3.dot(e2, q) * invDet;
    if (t > epsilon) {
      return t;
    }
    return MAX_T;
  }

  processLeaf(ray, root) {
    let res = MAX_T;
    let tris = root.getTriangles();
    for (let i = 0; i < tris.length; i++) {
      let tmp = this.rayTriangleIntersect(ray, tris[i])
      if (tmp < res) {
        res = tmp;
      }
    }
    return res;
  }

  rayBoxIntersect(ray, bbox) {
    let invDir = Vec3.inverse(ray.dir),
      tx1 = (bbox.min[0] - ray.pos[0]) * invDir[0],
      tx2 = (bbox.max[0] - ray.pos[0]) * invDir[0],
      ty1 = (bbox.min[1] - ray.pos[1]) * invDir[1],
      ty2 = (bbox.max[1] - ray.pos[1]) * invDir[1],
      tz1 = (bbox.min[2] - ray.pos[2]) * invDir[2],
      tz2 = (bbox.max[2] - ray.pos[2]) * invDir[2];

    let tmin = Math.min(tx1, tx2);
    let tmax = Math.max(tx1, tx2);
    tmin = Math.max(tmin, Math.min(ty1, ty2));
    tmax = Math.min(tmax, Math.max(ty1, ty2));
    tmin = Math.max(tmin, Math.min(tz1, tz2));
    tmax = Math.min(tmax, Math.max(tz1, tz2));

    return tmax >= tmin && tmax >= 0 ? tmin : MAX_T;
  }

  closestNode(ray, nLeft, nRight) {
    let tLeft = this.rayBoxIntersect(ray, nLeft.boundingBox);
    let tRight = this.rayBoxIntersect(ray, nRight.boundingBox);
    let left = tLeft < MAX_T ? nLeft : null;
    let right = tRight < MAX_T ? nRight : null;
    if (tLeft < tRight) {
      return [{
        node: left,
        t: tLeft
      }, {
        node: right,
        t: tRight
      }]
    }
    return [{
      node: right,
      t: tRight
    }, {
      node: left,
      t: tLeft
    }]
  }

  traverse(ray, root, closest) {
    if (root.leaf) {
      return this.processLeaf(ray, root);
    }
    let ord = this.closestNode(ray, root.left, root.right);
    for (let i = 0; i < ord.length; i++) {
      if (ord[i].node && ord[i].t < closest) {
        let res = this.traverse(ray, ord[i].node, closest);
        closest = Math.min(res, closest);
      }
    }
    return closest;
  }

  cast(ray) {
    return this.traverse(ray, this.bvh.root, MAX_T);
  }
}