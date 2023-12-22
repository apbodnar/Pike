import { Queue } from './util/utility.js'
import { BoundingBox, Triangle } from './primitives.js'

const SPLIT_ALPHA = 1.0e-5;


export class BVH {

  #numLeafTris = 0;
  #largestLeaf = 0;

  constructor(scene) {
    this.triangles = scene.indices.map(desc => new Triangle(desc, scene.attributes));
    this.refs = this.triangles.map(
      (tri, i) => new Reference(i, new BoundingBox().addTriangle(tri))
    );
    let xIndices = [...this.refs.keys()];
    let yIndices = Array.from(xIndices);
    let zIndices = Array.from(yIndices);
    this.depth = 0;
    this._sortIndices(xIndices, 0);
    this._sortIndices(yIndices, 1);
    this._sortIndices(zIndices, 2);
    const axisIndices = [xIndices, yIndices, zIndices];
    this.root = new Node(axisIndices, this.refs, this.triangles);
    this.root.root = this.root;
    Node.minOverlap = this.root.bounds.getSurfaceArea() * SPLIT_ALPHA;
    this.#createChildNodes(this.root, axisIndices, this.depth);
    console.log("Largest leaf:", this.#largestLeaf);
  }

  #createChildNodes(root, axisIndices, depth) {
    this.depth = Math.max(depth, this.depth);

    const count = root.axisIndices[root.splitAxis].length;
    if (root.leaf) {
      this.#numLeafTris += count;
      this.#largestLeaf = Math.max(count, this.#largestLeaf);
      return;
    }

    const [left, right] = BVH.#constructCachedIndexList(axisIndices, root.splitAxis, root.splitIndex);
    root.left = new Node(left, root.refs, this.triangles);
    root.right = new Node(right, root.refs, this.triangles);
    this.#createChildNodes(root.left, left, depth + 1);
    this.#createChildNodes(root.right, right, depth + 1);
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

  getNumLeafTris() {
    return this.#numLeafTris;
  }

  static #constructCachedIndexList(axisIndices, splitAxis, splitIndex) {
    // Avoid re sorting by plucking from pre sorted buffers
    let leftIndices = new Array(3);
    leftIndices[splitAxis] = axisIndices[splitAxis].slice(0, splitIndex);
    let rightIndices = new Array(3);
    rightIndices[splitAxis] = axisIndices[splitAxis].slice(splitIndex, axisIndices[splitAxis].length);
    let setLeft = new Set(leftIndices[splitAxis]);
    for (let axis = 0; axis < 3; axis++) {
      if (axis === splitAxis) {
        continue;
      }
      leftIndices[axis] = new Array(leftIndices[splitAxis].length)
      rightIndices[axis] = new Array(rightIndices[splitAxis].length)
      let li = 0, ri = 0;
      for (let j = 0; j < axisIndices[axis].length; j++) {
        let idx = axisIndices[axis][j];
        if (setLeft.has(idx)) {
          leftIndices[axis][li++] = idx;
        } else {
          rightIndices[axis][ri++] = idx;
        }
      }
    }
    return [leftIndices, rightIndices];
  }

  _sortIndices(indices, axis) {
    indices.sort((i1, i2) => {
      let c1 = this.refs[i1].bounds.centroid[axis];
      let c2 = this.refs[i2].bounds.centroid[axis];
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
  static NUM_BINS = 64;
  static minOverlap = 0;

  indices = null;
  left = null;
  right = null;
  leaf = false;

  constructor(axisIndices, refs, triangles) {
    this.count = axisIndices[0].length;
    this.refs = refs;
    this.triangles = triangles;
    this.axisIndices = axisIndices;
    this.bounds = new BoundingBox();
    for (const i of this.axisIndices[0]) {
      this.bounds.addBoundingBox(refs[i].bounds);
    }
    const objectSplit = this.setObjectSplit(refs, axisIndices);
    this.splitAxis = objectSplit.axis;
    this.splitIndex = objectSplit.index;
    // if (!this.leaf) {
    //   this.setSpatialSplit(objectSplit, refs, axisIndices);
    // }
  }

  getleafSize() {
    return this.indices.length;
  }

  sortIndices(indices, axis) {
    indices.sort((i1, i2) => {
      let c1 = this.refs[i1].bounds.centroid[axis];
      let c2 = this.refs[i2].bounds.centroid[axis];
      if (c1 < c2) {
        return -1;
      }
      if (c1 > c2) {
        return 1;
      }
      return 0;
    });
  }

  #computeSplit(refs, axisIndices, axes) {
    const split = new ObjectSplit();
    const parentSurfaceArea = this.bounds.getSurfaceArea();
    for (const axis of axes) {
      let bbFront = new BoundingBox();
      let bbBack = new BoundingBox();
      let indices = axisIndices[axis];
      let areasFront = new Array(indices.length);
      let areasBack = new Array(indices.length);
      // let intersectionAreas = new Array(indices.length);
      for (let i = 0; i < indices.length; i++) {
        let refFront = refs[indices[i]];
        let refBack = refs[indices[indices.length - 1 - i]];
        bbFront.addBoundingBox(refFront.bounds);
        bbBack.addBoundingBox(refBack.bounds);
        areasFront[i] = bbFront.getSurfaceArea();
        areasBack[i] = bbBack.getSurfaceArea();
      }

      for (let i = 0; i < indices.length; i++) {
        let sAf = areasFront[i];
        let sAb = areasBack[areasBack.length - 1 - i];
        let cost = Node.TRAVERSAL_COST +
          (sAf / parentSurfaceArea) * (i + 1) +
          (sAb / parentSurfaceArea) * (indices.length - 1 - i);
        if (cost < split.cost) {
          split.cost = cost;
          split.index = i + 1;
          split.axis = axis;
        }
      }
    }
    return split;
  }

  setObjectSplit(refs, axisIndices) {
    const split = this.#computeSplit(refs, axisIndices, [0, 1, 2]);
    if (split.cost > axisIndices[split.axis].length) {
      this.leaf = true;
      this.indices = axisIndices[split.axis];
      this.leafTriangles = this.indices.map((v) => {
        return this.triangles[this.refs[v].index];
      });
    }
    return split;
  }

  setSpatialSplit(objectSplit, refs, axisIndices) {
    const bins = new Array(Node.NUM_BINS).fill(undefined).map(e => []);
    const boxes = new Array(Node.NUM_BINS).fill(undefined).map(e => new BoundingBox());
    const nodeMax = this.bounds.max[this.splitAxis];
    const nodeMin = this.bounds.min[this.splitAxis];
    const nodeSpan = nodeMax - nodeMin;
    if (nodeSpan === 0) {
      return;
    }
    // Place all refs in bins
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const min = Array.from(this.bounds.min);
      const max = Array.from(this.bounds.max);
      const p0 = nodeMin + i * nodeSpan / Node.NUM_BINS;
      const p1 = nodeMin + (i + 1) * nodeSpan / Node.NUM_BINS;
      min[this.splitAxis] = p0;
      max[this.splitAxis] = p1;
      box.addVertex(min);
      box.addVertex(max);
    }

    // Place each refs in bins
    for (const index of this.axisIndices[this.splitAxis]) {
      const ref = refs[index];
      const refMin = ref.bounds.min[this.splitAxis] - nodeMin;
      const refMax = ref.bounds.max[this.splitAxis] - nodeMin;
      const startIdx = Math.max(0, Math.floor((refMin / nodeSpan) * Node.NUM_BINS));
      const stopIdx = Math.min(Math.floor((refMax / nodeSpan) * Node.NUM_BINS), Node.NUM_BINS - 1);
      for (let i = startIdx; i <= stopIdx; i++) {
        const newRef = ref.cloneEmpty();
        newRef.bounds = boxes[i].clone();
        newRef.bounds.axisIntersectTriangle(this.triangles[ref.index], this.splitAxis);
        bins[i].push(newRef);
      }
    }

    const newRefs = bins.flat();
    const indices = new Array(newRefs.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = i;
    }
    const split = this.#computeSplit(newRefs, [indices, indices, indices], [this.splitAxis]);
    if (split.cost < objectSplit.cost) {
      this.axisIndices = [indices, Array.from(indices), Array.from(indices)];
      this.splitIndex = split.index;
      this.refs = newRefs;
      for (const indices of this.axisIndices) {
        this.sortIndices(indices, 0);
        this.sortIndices(indices, 1);
        this.sortIndices(indices, 2);
      }
    }
  }
}

class ObjectSplit {
  constructor() {
    this.axis = -1;
    this.cost = Infinity;
    this.index = -1;
  }
}

class Reference {
  constructor(index, bounds) {
    this.index = index;
    this.bounds = bounds ?? new BoundingBox();
  }

  cloneEmpty() {
    return new Reference(this.index);
  }
}
