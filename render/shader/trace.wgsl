const EPSILON: f32 = 0.0000001;
const MAX_T: f32 = 100000.0;
const NO_HIT_IDX: i32 = -1;
const WORKGROUP_SIZE = 128;
const SM_STACK_SIZE = 24;

var<private> seed: u32;
var<private> privateStack: array<i32, 32 - SM_STACK_SIZE>;
var<workgroup> sharedStack: array<array<i32, SM_STACK_SIZE>, WORKGROUP_SIZE>;
var<workgroup> queueIdx: atomic<u32>;

// Keep vertex positions separate from other "attributes" to maximize locality during traversal.
struct Triangle {
  i1: i32,
  i2: i32,
  i3: i32,
  matId: i32,
};

struct VertexPositions {
  pos: array<vec3<f32>>,
};

struct Node {
  index: i32,
  left: i32,
  right: i32,
  triangles: i32,
  boxMin: vec3<f32>,
  boxMax: vec3<f32>,
};

struct BVH {
  nodes: array<Node>,
};

struct Triangles {
  triangles: array<Triangle>,
};

struct Ray {
  origin: vec3<f32>,
  dir: vec3<f32>,
};

struct DeferredRay {
  ray: Ray,
  throughput: vec4<f32>,
};

struct DeferredRayBuffer {
  elements: array<DeferredRay>,
};

struct Hit {
  t: f32,
  index: i32,
  bary: vec3<f32>,
  deferredRay: DeferredRay,
};

struct HitBuffer {
  elements: array<Hit>,
};

struct RenderState {
  samples: i32,
  envTheta: f32,
  numHits: atomic<u32>,
  numMisses: atomic<u32>,
  numRays: u32,
};

@group(0) @binding(0) var<storage, read> bvh: BVH;

@group(1) @binding(0) var<storage, read> triangles: Triangles;
@group(1) @binding(1) var<storage, read> vertices: VertexPositions;
@group(1) @binding(2) var<storage, read_write> hitBuffer: HitBuffer;
@group(1) @binding(3) var<storage, read_write> missBuffer: DeferredRayBuffer;

@group(2) @binding(0) var<storage, read_write> renderState: RenderState;
@group(2) @binding(1) var<storage, read_write> rayBuffer: DeferredRayBuffer;

fn rayBoxIntersect(node: Node, ray: Ray) -> f32 {
  let inverse = 1.0 / ray.dir;
  let t1 = (node.boxMin - ray.origin) * inverse;
  let t2 = (node.boxMax - ray.origin) * inverse;
  let minT = min(t1, t2);
  let maxT = max(t1, t2);
  let tMax = min(min(maxT.x, maxT.y), maxT.z);
  let tMin = max(max(minT.x, minT.y), minT.z);
  return select(MAX_T, tMin, tMax >= tMin && tMax > 0.0);
}

fn rayTriangleIntersect(ray: Ray, tri: Triangle, bary: ptr<function, vec3<f32>>) -> f32 {
  let e1: vec3<f32> = vertices.pos[tri.i2] - vertices.pos[tri.i1];
  let e2: vec3<f32> = vertices.pos[tri.i3] - vertices.pos[tri.i1];
  let p: vec3<f32> = cross(ray.dir, e2);
  let det: f32 = dot(e1, p);
  if(abs(det) < EPSILON){return MAX_T;}
  let invDet = 1f / det;
  let t: vec3<f32> = ray.origin - vertices.pos[tri.i1];
  let u: f32 = dot(t, p) * invDet;
  if(u < 0f || u > 1f){return MAX_T;}
  let q: vec3<f32> = cross(t, e1);
  let v: f32 = dot(ray.dir, q) * invDet;
  if(v < 0f || u + v > 1f){return MAX_T;}
  let dist: f32 = dot(e2, q) * invDet;
  (*bary) = vec3<f32>(1f - u - v, u, v);
  return select(MAX_T, dist, dist > EPSILON);
}

fn processLeaf(leaf: Node, ray: Ray, result: ptr<function, Hit>){
  let leafSize = leaf.triangles >> 24u;
  let baseIdx = leaf.triangles & 0x00ffffff;
  var i: i32 = 0;
  loop {
    if (i >= leafSize) { break;}
    var bary = vec3<f32>();
    let tri: Triangle = triangles.triangles[baseIdx + i];
    let res: f32 = rayTriangleIntersect(ray, tri, &bary);
    if (res < (*result).t) {
      (*result).index = baseIdx + i;
      (*result).t = res;
      (*result).bary = bary;
    }
    i += 1;
  }
}

fn stackPush(idx: i32, sptr: ptr<function, i32>, tid: u32) {
  if (*sptr < SM_STACK_SIZE) {
    sharedStack[tid][*sptr] = idx;
  } else {
    privateStack[*sptr - SM_STACK_SIZE] = idx;
  }
  *sptr += 1;
}

fn stackPop(sptr: ptr<function, i32>, tid: u32) -> i32{
  *sptr -= 1;
  return select(privateStack[*sptr - SM_STACK_SIZE], sharedStack[tid][*sptr], *sptr < SM_STACK_SIZE);
}

fn intersectScene(deferredRay: DeferredRay, tid: u32) -> Hit {
  var result = Hit(MAX_T, NO_HIT_IDX, vec3<f32>(), deferredRay);
  var sptr: i32 = 0;
  stackPush(NO_HIT_IDX, &sptr, tid);
  var idx: i32 = 0;
  var current: Node;
  loop {
    if (idx <= NO_HIT_IDX) { break; }
    current = bvh.nodes[idx];
    if (current.triangles > -1) {
      processLeaf(current, deferredRay.ray, &result);
    } else {
      let leftIndex = current.left;
      let rightIndex = current.right;
      let leftHit = rayBoxIntersect(bvh.nodes[leftIndex], deferredRay.ray);
      let rightHit = rayBoxIntersect(bvh.nodes[rightIndex], deferredRay.ray);
      if (leftHit < result.t && rightHit < result.t) {
        var deferred: i32;
        if (leftHit > rightHit) {
          idx = rightIndex;
          deferred = leftIndex;
        } else {
          idx = leftIndex;
          deferred = rightIndex;
        }
        stackPush(deferred, &sptr, tid);
        continue;
      } else {
        if (leftHit < result.t) {
          idx = leftIndex;
          continue;
        }
        if (rightHit < result.t) {
          idx = rightIndex;
          continue;
        }
      }
    }
		idx = stackPop(&sptr, tid);
	}
	return result;
}

@compute @workgroup_size(WORKGROUP_SIZE, 1, 1)
fn main(
  @builtin(local_invocation_index) LID : u32,
  @builtin(global_invocation_id) GID : vec3<u32>,
  @builtin(workgroup_id) WID : vec3<u32>,
) {
  let wid = WID.x;
  loop {
    let qIdx = atomicAdd(&queueIdx, 1);
    let jid = qIdx + wid * WORKGROUP_SIZE ;
    if (qIdx >= WORKGROUP_SIZE || jid >= renderState.numRays) {
      return;
    }
    let deferredRay = rayBuffer.elements[jid];
    var hit = intersectScene(deferredRay, LID);
    if (hit.index != NO_HIT_IDX) {
      let idx = atomicAdd(&renderState.numHits, 1);
      hitBuffer.elements[idx] = hit;
    } else {
      let idx = atomicAdd(&renderState.numMisses, 1);
      missBuffer.elements[idx] = deferredRay;
    }
  }
}