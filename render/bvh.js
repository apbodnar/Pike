import { Queue } from './util/utility.js'
import { BoundingBox, Triangle } from './primitives.js'

const SPLIT_ALPHA = 1.0e-5;


export class BVH {

  #numLeafTris = 0;
  #largestLeaf = 0;

  constructor(scene, exponent) {
    this.triangles = scene.indices.map(desc => new Triangle(desc, scene.attributes));
    this.exponent = exponent ?? 1;
    const xRefs = this.triangles.map(
      (tri, i) => new Reference(i, new BoundingBox().addTriangle(tri))
    );
    const yRefs = Array.from(xRefs);
    const zRefs = Array.from(xRefs);
    this.depth = 0;
    const axisRefs = [xRefs, yRefs, zRefs];
    Node.sortRefs(axisRefs);
    this.root = new Node(axisRefs, this.triangles, undefined, -1);
    this.#createChildNodes(this.root, this.depth + 1);
    console.log("Largest leaf:", this.#largestLeaf, this);
  }

  #createChildNodes(root, depth) {
    this.depth = Math.max(depth, this.depth);

    const count = root.count;
    if (root.leaf) {
      this.#numLeafTris += count;
      this.#largestLeaf = Math.max(count, this.#largestLeaf);
      return;
    }

    const forceAxis = (depth % this.exponent === 0) ? -1 : root.splitAxis;
    const [left, right] = BVH.#splitNode(root);
    root.left = new Node(left, this.triangles, root.rootNode, forceAxis);
    this.#createChildNodes(root.left, depth + 1);

    root.right = new Node(right, this.triangles, root.rootNode, forceAxis);
    this.#createChildNodes(root.right, depth + 1);
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

  static #splitNode(node) {
    const axisRefs = node.axisRefs;
    const splitAxis = node.splitAxis;
    const splitIndex = node.splitIndex;
    // Avoid re sorting by plucking from pre sorted buffers
    const leftRefs = new Array(3);
    leftRefs[splitAxis] = axisRefs[splitAxis].slice(0, splitIndex + 1);
    const rightRefs = new Array(3);
    rightRefs[splitAxis] = axisRefs[splitAxis].slice(splitIndex + 1, axisRefs[splitAxis].length);
    let setLeft = new Set(leftRefs[splitAxis]);
    for (let axis = 0; axis < 3; axis++) {
      if (axis === splitAxis) {
        continue;
      }
      leftRefs[axis] = new Array(leftRefs[splitAxis].length)
      rightRefs[axis] = new Array(rightRefs[splitAxis].length)
      let li = 0, ri = 0;
      for (let j = 0; j < axisRefs[axis].length; j++) {
        let idx = axisRefs[axis][j];
        if (setLeft.has(idx)) {
          leftRefs[axis][li++] = idx;
        } else {
          rightRefs[axis][ri++] = idx;
        }
      }
    }
    return [leftRefs, rightRefs];
  }
}

export class Node {
  static TRAVERSAL_COST = 0.5;
  static NUM_BINS = 64;

  indices = null;
  left = null;
  right = null;
  leaf = false;

  constructor(axisRefs, triangles, rootNode, forceAxis) {
    this.count = axisRefs[0].length;
    this.rootNode = rootNode ?? this;
    this.triangles = triangles;
    this.bounds = new BoundingBox();
    for (const ref of axisRefs[0]) {
      this.bounds.addBoundingBox(ref.bounds);
    }
    let split = this.getObjectSplit(axisRefs, forceAxis);
    const checkSpatialSplit = false;//(split.intersectionArea / this.rootNode.bounds.getSurfaceArea()) > SPLIT_ALPHA;
    if (checkSpatialSplit) {
      const spatialSplit = this.getSpatialSplit(split);
      if (spatialSplit.cost < split.cost && spatialSplit.index !== 0 && spatialSplit.index !== (spatialSplit.axisRefs[spatialSplit.axis].length - 1)) {
        console.log(spatialSplit);
        split = spatialSplit;
      }
    }

    if (split.cost > split.axisRefs[split.axis].length) {
      this.#setLeaf(split, axisRefs);
   } else {
      this.splitAxis = split.axis;
      this.splitIndex = split.index;
      this.axisRefs = split.axisRefs;
    }
  }

  getleafSize() {
    return this.leafTriangles.length;
  }

  static sortRefs(axisRefs, skipAxis) {
    for (let i = 0; i < 3; i++) {
      if (i === skipAxis) {
        continue;
      }
      const refs = axisRefs[i];
      refs.sort((r1, r2) => {
        let c1 = r1.bounds.centroid[i];
        let c2 = r2.bounds.centroid[i];
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

  #computeSplit(axisRefs, axes) {
    const split = new ObjectSplit();
    const parentSurfaceArea = this.bounds.getSurfaceArea();
    let leftBox;
    let rightBox;
    for (const axis of axes) {
      let bbFront = new BoundingBox();
      let bbBack = new BoundingBox();
      let refs = axisRefs[axis];
      let areasFront = new Array(refs.length);
      let areasBack = new Array(refs.length);
      let boxesFront = new Array(refs.length);
      let boxesBack = new Array(refs.length);
      // let intersectionAreas = new Array(indices.length);
      for (let i = 0; i < refs.length; i++) {
        let refFront = refs[i];
        let refBack = refs[refs.length - 1 - i];
        bbFront.addBoundingBox(refFront.bounds);
        bbBack.addBoundingBox(refBack.bounds);
        areasFront[i] = bbFront.getSurfaceArea();
        areasBack[i] = bbBack.getSurfaceArea();
        boxesFront[i] = bbFront.clone();
        boxesBack[i] = bbBack.clone();
      }

      for (let i = 0; i < refs.length; i++) {
        let sAf = areasFront[i];
        let sAb = areasBack[areasBack.length - 1 - i];
        let cost = Node.TRAVERSAL_COST +
          (sAf / parentSurfaceArea) * (i + 1) +
          (sAb / parentSurfaceArea) * (refs.length - 1 - i);
        if (cost < split.cost) {
          split.cost = cost;
          split.index = i;
          split.axis = axis;
          leftBox = boxesFront[i];
          rightBox = boxesBack[boxesBack.length - 1 - i];
        }
      }
    }
    if (split.cost < Infinity) {
      leftBox.intersectBox(rightBox);
      split.intersectionArea = leftBox.getSurfaceArea();
    }
    return split;
  }

  #setLeaf(split, axisRefs) {
    this.leaf = true;
    const refs = axisRefs[split.axis];
    this.leafTriangles = refs.map((ref) => {
      return this.triangles[ref.index];
    });
  }

  getObjectSplit(axisRefs, forceAxis) {
    const axes = forceAxis > -1 ? [forceAxis] :  [0, 1, 2];
    const split = this.#computeSplit(axisRefs, axes);
    split.axisRefs = axisRefs;
    return split;
  }

  getSpatialSplit(objectSplit) {
    const bins = new Array(Node.NUM_BINS).fill(undefined).map(e => []);
    const boxes = new Array(Node.NUM_BINS).fill(undefined).map(e => new BoundingBox());
    const nodeMax = this.bounds.max[objectSplit.axis];
    const nodeMin = this.bounds.min[objectSplit.axis];
    const nodeSpan = nodeMax - nodeMin;
    if (nodeSpan === 0) {
      return new ObjectSplit();
    }
    // Place all refs in bins
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const min = Array.from(this.bounds.min);
      const max = Array.from(this.bounds.max);
      const p0 = nodeMin + i * nodeSpan / Node.NUM_BINS;
      const p1 = nodeMin + (i + 1) * nodeSpan / Node.NUM_BINS;
      min[objectSplit.axis] = p0;
      max[objectSplit.axis] = p1;
      box.addVertex(min);
      box.addVertex(max);
    }

    // Place each refs in bins
    for (const ref of objectSplit.axisRefs[objectSplit.axis]) {
      const refMin = ref.bounds.min[objectSplit.axis] - nodeMin;
      const refMax = ref.bounds.max[objectSplit.axis] - nodeMin;
      const startIdx = Math.max(0, Math.floor((refMin / nodeSpan) * Node.NUM_BINS));
      const stopIdx = Math.min(Math.floor((refMax / nodeSpan) * Node.NUM_BINS), Node.NUM_BINS - 1);
      for (let i = startIdx; i <= stopIdx; i++) {
        const newRef = ref.cloneEmpty();
        newRef.bounds = boxes[i].clone();
        newRef.bounds.axisIntersectTriangle(this.triangles[ref.index], objectSplit.axis);
        bins[i].push(newRef);
      }
    }

    const newRefs = bins.flat();
    const split = this.#computeSplit([newRefs, newRefs, newRefs], [objectSplit.axis]);
    if (split.cost < objectSplit.cost) {
      split.axisRefs = [newRefs, Array.from(newRefs), Array.from(newRefs)];
      Node.sortRefs(split.axisRefs, split.axis);
    }
    return split;
  }
}

class ObjectSplit {
  constructor() {
    this.axis = -1;
    this.cost = Infinity;
    this.index = -1;
    this.axisRefs = null;
    this.intersectionArea = Infinity;
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
