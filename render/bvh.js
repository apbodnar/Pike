import { Queue } from './util/utility.js'
import { BoundingBox, Triangle } from './primitives.js'


export class BVH {
  constructor(scene) {
    this.exp = 1;
    this.triangles = this._createTriangles(scene.indices, scene.attributes);
    let xIndices = [...this.triangles.keys()];
    let yIndices = Array.from(xIndices);
    let zIndices = Array.from(yIndices);
    this.depth = 0;
    this._sortIndices(xIndices, 0);
    this._sortIndices(yIndices, 1);
    this._sortIndices(zIndices, 2);
    this._numLeafTris = 0;
    this.largestLeaf = 0;
    this.root = this.buildTree([xIndices, yIndices, zIndices], this.depth);
    console.log("Largest leaf:", this.largestLeaf);
  }

  _createTriangles(indices, attributes) {
    const triangles = [];
    for (const triDesc of indices) {
      triangles.push(new Triangle(triDesc, attributes));
    }
    return triangles;
  }

  buildTree(indices, depth) {
    this.depth = Math.max(depth, this.depth);
    let root = new Node(this.triangles, indices);
    root.setObjectSplit();
    const count = root.indices[root.splitAxis].length;
    if (root.leaf) {
      this._numLeafTris += count;
      this.largestLeaf = Math.max(count, this.largestLeaf);
      return root;
    }

    let splitIndices = this._constructCachedIndexList(indices, root.splitAxis, root.splitIndex);
    root.left = this.buildTree(splitIndices.left, depth + 1, root.splitAxis);
    root.right = this.buildTree(splitIndices.right, depth + 1, root.splitAxis);
    root.clearTempBuffers();
    return root;
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


  numLeafTris() {
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
      leftIndices[axis] = new Array(leftIndices[splitAxis].length)
      rightIndices[axis] = new Array(rightIndices[splitAxis].length)
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
      let c1 = this.triangles[i1].bounds.centroid[axis];
      let c2 = this.triangles[i2].bounds.centroid[axis];
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

export class Node {
  static TRAVERSAL_COST = 0.5;

  constructor(triangles, indices) {
    this.triangles = triangles;
    this.indices = indices;
    this.bounds = new BoundingBox();
    for (const i of this.indices[0]) {
      this.bounds.addTriangle(triangles[i]);
    }
    this.leaf = false;
    this.left = null;
    this.right = null;
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

  setObjectSplit() {
    let bestCost = Infinity;
    let parentSurfaceArea = this.bounds.getSurfaceArea();
    const axes = [0, 1, 2];
    for (const axis of axes) {
      let bbFront = new BoundingBox();
      let bbBack = new BoundingBox();
      let indices = this.indices[axis];
      let surfacesFront = Array(indices.length);
      let surfacesBack = Array(indices.length);
      for (let i = 0; i < indices.length; i++) {
        let triFront = this.triangles[indices[i]];
        let triBack = this.triangles[indices[indices.length - 1 - i]];
        bbFront.addBoundingBox(triFront.bounds);
        bbBack.addBoundingBox(triBack.bounds);
        surfacesFront[i] = bbFront.getSurfaceArea();
        surfacesBack[i] = bbBack.getSurfaceArea();
      }

      for (let i = 0; i < indices.length; i++) {
        let sAf = surfacesFront[i];
        let sAb = surfacesBack[surfacesBack.length - 1 - i];
        let cost = Node.TRAVERSAL_COST +
          (sAf / parentSurfaceArea) * (i + 1) +
          (sAb / parentSurfaceArea) * (indices.length - 1 - i);
        if (cost < bestCost) {
          bestCost = cost;
          this.splitIndex = i + 1;
          this.splitAxis = axis;
        }
      }
    }
    if (bestCost > this.indices[this.splitAxis].length) {
      this.leaf = true;
    }
  }
}

