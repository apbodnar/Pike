import { Vec3 } from './util/vector.js'

const MAX_T = 1e6;

export class Raycaster {

  constructor(bvh) {
    this.bvh = bvh;
    this.lastMeshDebug = null;
    this.normalizer = this.#makeNormalizer(bvh.root.bounds);
  }

  rayTriangleIntersect(ray, tri) {
    let epsilon = 0.000000000001;
    const v0 = this.normalizer(tri.verts[0]);
    const v1 = this.normalizer(tri.verts[1]);
    const v2 = this.normalizer(tri.verts[2]);

    let e1 = Vec3.sub(v1, v0);
    let e2 = Vec3.sub(v2, v0);
    let p = Vec3.cross(ray.dir, e2);
    let det = Vec3.dot(e1, p);

    if (det > -epsilon && det < epsilon) {
      return MAX_T
    }
    let invDet = 1.0 / det;
    let t = Vec3.sub(ray.origin, v0);
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

  #makeNormalizer(bounds) {
    const min = bounds.min;
    const span = Vec3.sub(bounds.max, bounds.min);
    const longest = Math.max(span[0], span[1], span[2]);

    return (vec) => {
      const toCenter = Vec3.add(min, Vec3.scale(span, 0.5));
      return Vec3.scale(Vec3.sub(vec, toCenter), 2 / longest); 
    }
  }

  processLeaf(ray, root) {
    let res = MAX_T;
    let tris = root.leafTriangles;
    for (let i = 0; i < tris.length; i++) {
      let tmp = this.rayTriangleIntersect(ray, tris[i])
      if (tmp < res) {
        res = tmp;
        this.lastMeshDebug = tris[i].desc.debug;
      }
    }
    return res;
  }

  rayBoxIntersect(ray, bbox) {
    const min = this.normalizer(bbox.min);
    const max = this.normalizer(bbox.max);

    let invDir = Vec3.inverse(ray.dir),
      tx1 = (min[0] - ray.origin[0]) * invDir[0],
      tx2 = (max[0] - ray.origin[0]) * invDir[0],
      ty1 = (min[1] - ray.origin[1]) * invDir[1],
      ty2 = (max[1] - ray.origin[1]) * invDir[1],
      tz1 = (min[2] - ray.origin[2]) * invDir[2],
      tz2 = (max[2] - ray.origin[2]) * invDir[2];

    let tmin = Math.min(tx1, tx2);
    let tmax = Math.max(tx1, tx2);
    tmin = Math.max(tmin, Math.min(ty1, ty2));
    tmax = Math.min(tmax, Math.max(ty1, ty2));
    tmin = Math.max(tmin, Math.min(tz1, tz2));
    tmax = Math.min(tmax, Math.max(tz1, tz2));

    return tmax >= tmin && tmax >= 0 ? tmin : MAX_T;
  }

  closestNode(ray, nLeft, nRight) {
    let tLeft = this.rayBoxIntersect(ray, nLeft.bounds);
    let tRight = this.rayBoxIntersect(ray, nRight.bounds);
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
    // console.log("DEBUG Mesh:", closest != MAX_T ? this.lastMeshDebug : null);
    return closest;
  }

  cast(ray) {
    return this.traverse(ray, this.bvh.root, MAX_T);
  }
}