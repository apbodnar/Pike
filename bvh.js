import { Vec3 } from './vector.js'
import { Queue } from './utility.js'

export class BVH {
  constructor(triangles) {
    let xIndices = triangles.map((_, i) => { return i });
    let yIndices = Array.from(xIndices);
    let zIndices = Array.from(yIndices);
    this.triangles = triangles;
    this.depth = 0;
    this._sortIndices(xIndices, 0);
    this._sortIndices(yIndices, 1);
    this._sortIndices(zIndices, 2);
    this._numLeafTris = 0;
    this.largestLeaf = 0;
    this.root = this.buildTree([xIndices, yIndices, zIndices], this.depth);
    console.log("Largest leaf:", this.largestLeaf);
    //const r = this.buildTree2([xIndices, yIndices, zIndices])
  }

  buildTree(indices, depth) {
    this.depth = Math.max(depth, this.depth);
    let root = new Node(this.triangles, indices);
    root.setSplit();
    const count = root.indices[root.splitAxis || 0].length;
    if (root.leaf) {
      this._numLeafTris += count;
      this.largestLeaf = Math.max(count, this.largestLeaf);
      return root;
    }
    
    let splitIndices = this._constructCachedIndexList(indices, root.splitAxis, root.splitIndex);
    root.left = this.buildTree(splitIndices.left, depth + 1);
    root.right = this.buildTree(splitIndices.right, depth + 1);
    root.clearTempBuffers();
    return root;
  }

  splitTriangles(root, leftIndices, rightIndices) {
    let rightBox = new BoundingBox();
    let leftBox = new BoundingBox();
    for (const idx of rightIndices) {
      rightBox.addTriangle(this.triangles[idx]);
    }
    for (const idx of leftIndices) {
      leftBox.addTriangle(this.triangles[idx]);
    }
    let overlap = new BoundingBox();
    if (leftBox.max[root.splitAxis] > rightBox.min[root.splitAxis]) {
      overlap.max = leftBox.max;
      overlap.min = rightBox.min;

    }
  }

  // BFS is slightly slower but generates a tiny bit (2-3%) faster BVH. Guessing because it preserves sibling locality.
  serializeTree() {
    let nodes = [];
    let root = { node: this.root, parent: -1 };
    // Array based queues are very slow at high lengths. A very naive linked list based one is far faster for large scenes.
    let qq = new Queue();
    qq.enqueue(root);
    while (qq.hasElements()) {
      root = qq.dequeue();
      let parent = nodes.length;
      nodes.push(root);
      if (!root.node.leaf) {
        qq.enqueue({ node: root.node.left, parent });
        qq.enqueue({ node: root.node.right, parent });
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.parent >= 0) {
        const parent = nodes[node.parent];
        // If i is odd, then it's the left node.  left/right nodes are always pushed on the queue together.
        if (i % 2 === 1) {
          parent.left = i;
        } else {
          parent.right = i;
        }
      }
    }
    return nodes;
  }

  get numLeafTris() {
    return this._numLeafTris;
  }

  _constructCachedIndexList(indices, splitAxis, splitIndex) {
    // Avoid re sorting by plucking from pre sorted buffers
    let leftIndices = [null, null, null];
    leftIndices[splitAxis] = indices[splitAxis].slice(0, splitIndex);
    let rightIndices = [null, null, null];
    rightIndices[splitAxis] = indices[splitAxis].slice(splitIndex, indices[splitAxis].length);
    let setLeft = new Set(leftIndices[splitAxis]);
    for (let axis = 0; axis < 3; axis++) {
      if (axis === splitAxis) {
        continue;
      }
      leftIndices[axis] = Array(leftIndices[splitAxis].length)
      rightIndices[axis] = Array(rightIndices[splitAxis].length)
      let li = 0, ri = 0;
      for (let j = 0; j < indices[axis].length; j++) {
        let idx = indices[axis][j];
        if (setLeft.has(idx)) {
          leftIndices[axis][li++] = idx;
        } else {
          rightIndices[axis][ri++] = idx;
        }
      }
    }
    return { left: leftIndices, right: rightIndices };
  }

  _sortIndices(indices, axis) {
    indices.sort((i1, i2) => {
      let c1 = this.triangles[i1].boundingBox.centroid[axis];
      let c2 = this.triangles[i2].boundingBox.centroid[axis];
      if (c1 < c2) {
        return -1;
      }
      if (c1 > c2) {
        return 1;
      }
      return 0;
    });
  }
}

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

  addNode(node) {
    for (let i = 0; i < node.indices[0].length; i++) {
      this.addTriangle(node.triangles[node.indices[0][i]]);
    }
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
    let xl = this.max[0] - this.min[0];
    let yl = this.max[1] - this.min[1];
    let zl = this.max[2] - this.min[2];
    return (xl * yl + xl * zl + yl * zl) * 2;
  }
}

export class Node {
  constructor(triangles, indices) {
    this.triangles = triangles;
    this.indices = indices;
    this.boundingBox = new BoundingBox().addNode(this);
    this.leaf = false;
    this.left = null;
    this.right = null;
    this.traversalCost = 0.250;
  }

  getleafSize() {
    return this.indices[0].length;
  }

  getTriangles() {
    // Avoid using this until final export
    return this.indices[0].map((v) => {
      return this.triangles[v];
    });
  }

  clearTempBuffers() {
    this.indices = null;
    this.triangles = null;
  }

  setSplit() {
    let bestCost = Infinity;
    let parentSurfaceArea = this.boundingBox.getSurfaceArea();
    for (let axis = 0; axis < 3; axis++) {
      let bbFront = new BoundingBox();
      let bbBack = new BoundingBox();
      let idxCache = this.indices[axis];
      let surfacesFront = Array(idxCache.length);
      let surfacesBack = Array(idxCache.length);
      for (let i = 0; i < idxCache.length; i++) {
        let triFront = this.triangles[idxCache[i]];
        let triBack = this.triangles[idxCache[idxCache.length - 1 - i]];
        bbFront.addBoundingBox(triFront.boundingBox);
        bbBack.addBoundingBox(triBack.boundingBox);
        surfacesFront[i] = bbFront.getSurfaceArea();
        surfacesBack[i] = bbBack.getSurfaceArea();
      }

      for (let i = 0; i < idxCache.length; i++) {
        let sAf = surfacesFront[i];
        let sAb = surfacesBack[surfacesBack.length - 1 - i];
        let cost = this.traversalCost +
          (sAf / parentSurfaceArea) * (i + 1) +
          (sAb / parentSurfaceArea) * (idxCache.length - 1 - i);
        if (cost < bestCost) {
          bestCost = cost;
          this.splitIndex = i + 1;
          this.splitAxis = axis;
        }
      }
    }
    if (bestCost > this.indices[0].length) {
      this.leaf = true;
    }
  }
}

export class Triangle {
  constructor(indices, attributes) {
    this.indices = indices;
    this.attributes = attributes;
    this.boundingBox = new BoundingBox().addTriangle(this);
  }

  get verts() {
    return this.indices.map((i) => {
      return this.attributes[i].position;
    })
  }

  get uvs() {
    return this.indices.map((i) => {
      return this.attributes[i].uv;
    })
  }

  get normals() {
    return this.indices.map((i) => {
      return this.attributes[i].normal;
    })
  }

  get tangents() {
    return this.indices.map((i) => {
      return this.attributes[i].tangent;
    })
  }

  get bitangents() {
    return this.indices.map((i) => {
      return this.attributes[i].bitangent;
    })
  }
}

