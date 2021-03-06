const EPSILON: f32 = 0.0000001;
const MAX_T: f32 = 100000.0;
const NO_HIT_IDX: i32 = -1;
const WORKGROUP_SIZE = 128;
const SM_STACK_SIZE = 8;

var<private> seed: u32;
var<private> privateStack: array<i32, 24>;
var<workgroup> sharedStack: array<array<i32, SM_STACK_SIZE>, WORKGROUP_SIZE>;

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
  coordMask: u32,
};

struct DeferredRayBuffer {
  elements: array<DeferredRay>,
}

struct Hit {
  t: f32,
  index: i32,
  coordMask: u32,
  bary: vec3<f32>,
  wo: vec3<f32>,
};

struct HitBuffer {
  elements: array<Hit>,
}

struct RenderState {
  samples: i32,
  envTheta: f32,
};

@group(0) @binding(0) var<storage, read> bvh: BVH;

@group(1) @binding(0) var<storage, read> triangles: Triangles;
@group(1) @binding(1) var<storage, read> vertices: VertexPositions;
@group(1) @binding(2) var<storage, read_write> hitBuffer: HitBuffer;

@group(2) @binding(0) var<uniform> renderState: RenderState;

@group(3) @binding(0) var<storage, read_write> rayBuffer: DeferredRayBuffer;

fn rayBoxIntersect(node: Node, ray: Ray) -> f32 {
  let inverse = 1.0 / ray.dir;
  let t1 = (node.boxMin - ray.origin) * inverse;
  let t2 = (node.boxMax - ray.origin) * inverse;
  let minT = min(t1, t2);
  let maxT = max(t1, t2);
  let tMax = min(min(maxT.x, maxT.y),maxT.z);
  let tMin = max(max(minT.x, minT.y),minT.z);
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
    if(res < (*result).t){
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

fn intersectScene(ray: Ray, anyHit: bool, tid: u32) -> Hit {
  var result = Hit(MAX_T, -1, 0f, vec3<f32>());
  var sptr: i32 = 0;
  stackPush(-1, &sptr, tid);
  var idx: i32 = 0;
  var current: Node;
  loop {
    if (idx <= -1) { break; }
    current = bvh.nodes[idx];
    result.tests = result.tests + 1f;
    if (current.triangles > -1) {
      processLeaf(current, ray, &result);
      if (anyHit && result.index != NO_HIT_IDX) {
        return result;
      }
    } else {
      var leftIndex = current.left;
      var rightIndex = current.right;
      var leftHit = rayBoxIntersect(bvh.nodes[leftIndex], ray);
      var rightHit = rayBoxIntersect(bvh.nodes[rightIndex], ray);
      if (leftHit < result.t && rightHit < result.t) {
        var deferred: i32 = -1;
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

@compute @workgroup_size(workGroupSize, 1, 1)
fn main(
  @builtin(local_invocation_index) LID : u32,
  @builtin(global_invocation_id) GID : vec3<u32>,
) {
  let tid = GID.x;
  if (tid >= renderDims.x * renderDims.y) {
    return;
  }
  let gid = vec2<f32>(GID.xy);
  seed = (GID.x * 1973u + GID.y * 9277u + u32(renderState.samples) * 26699u) | 1u;
  seed = hash();
  let pixIdx = GID.x + GID.y * renderDims.x;
  let deferredRay = rayBuffer.elements[pixIdx];
  let ray = deferredRay.ray;
  let hit = intersectScene(ray, false, LID);
  hit.coordMask = deferredRay.coordMask;
  hitBuffer.elements[tid] = hit;
}