const EPSILON: f32 = 0.0000001;
const MAX_T: f32 = 100000.0;
const NO_HIT_IDX: i32 = -1;
const WORKGROUP_SIZE = 128;
const SM_STACK_SIZE = 24;

var<private> seed: u32;
var<private> private_stack: array<i32, 32 - SM_STACK_SIZE>;
var<workgroup> shared_stack: array<array<i32, SM_STACK_SIZE>, WORKGROUP_SIZE>;
var<workgroup> queue_idx: atomic<u32>;

// Keep vertex positions separate from other "attributes" to maximize locality during traversal.
struct Triangle {
  i1: i32,
  i2: i32,
  i3: i32,
  mat_id: i32,
};

struct VertexPositions {
  pos: array<vec3<f32>>,
};

struct Node {
  child_base_idx: i32,
  triangles: i32,
  x_range_mask: u32,
  y_range_mask: u32,
  z_range_mask: u32,
};

struct BVH {
  nodes: array<Node>,
};

struct Triangles {
  elements: array<Triangle>,
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
  deferred_ray: DeferredRay,
};

struct HitBuffer {
  elements: array<Hit>,
};

struct RenderState {
  samples: i32,
  env_theta: f32,
  num_hits: atomic<u32>,
  num_misses: atomic<u32>,
  num_rays: u32,
};

@group(0) @binding(0) var<storage, read> bvh: BVH;

@group(1) @binding(0) var<storage, read> triangles: Triangles;
@group(1) @binding(1) var<storage, read> vertices: VertexPositions;
@group(1) @binding(2) var<storage, read_write> hit_buffer: HitBuffer;
@group(1) @binding(3) var<storage, read_write> miss_buffer: DeferredRayBuffer;

@group(2) @binding(0) var<storage, read_write> render_state: RenderState;
@group(2) @binding(1) var<storage, read_write> ray_buffer: DeferredRayBuffer;

fn rayBoxIntersect(node: Node, ray: Ray) -> f32 {
  let inverse = 1.0 / ray.dir;
  let x_range = unpack2x16snorm(node.x_range_mask);
  let y_range = unpack2x16snorm(node.y_range_mask);
  let z_range = unpack2x16snorm(node.z_range_mask);
  let t1 = (vec3<f32>(x_range.x, y_range.x, z_range.x) - ray.origin) * inverse;
  let t2 = (vec3<f32>(x_range.y, y_range.y, z_range.y) - ray.origin) * inverse;
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
  let inv_det = 1f / det;
  let t: vec3<f32> = ray.origin - vertices.pos[tri.i1];
  let u: f32 = dot(t, p) * inv_det;
  if(u < 0f || u > 1f){return MAX_T;}
  let q: vec3<f32> = cross(t, e1);
  let v: f32 = dot(ray.dir, q) * inv_det;
  if(v < 0f || u + v > 1f){return MAX_T;}
  let dist: f32 = dot(e2, q) * inv_det;
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
    let tri: Triangle = triangles.elements[baseIdx + i];
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
    shared_stack[tid][*sptr] = idx;
  } else {
    private_stack[*sptr - SM_STACK_SIZE] = idx;
  }
  *sptr += 1;
}

fn stackPop(sptr: ptr<function, i32>, tid: u32) -> i32{
  *sptr -= 1;
  return select(private_stack[*sptr - SM_STACK_SIZE], shared_stack[tid][*sptr], *sptr < SM_STACK_SIZE);
}

fn intersectScene(deferred_ray: DeferredRay, tid: u32) -> Hit {
  var result = Hit(MAX_T, NO_HIT_IDX, vec3<f32>(), deferred_ray);
  var sptr: i32 = 0;
  stackPush(NO_HIT_IDX, &sptr, tid);
  var idx: i32 = 0;
  var current: Node;
  loop {
    if (idx <= NO_HIT_IDX) { break; }
    current = bvh.nodes[idx];
    if (current.triangles > -1) {
      processLeaf(current, deferred_ray.ray, &result);
    } else {
      let leftIndex = current.child_base_idx;
      let rightIndex = leftIndex + 1;
      let leftHit = rayBoxIntersect(bvh.nodes[leftIndex], deferred_ray.ray);
      let rightHit = rayBoxIntersect(bvh.nodes[rightIndex], deferred_ray.ray);
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
    let qIdx = atomicAdd(&queue_idx, 1);
    let jid = qIdx + wid * WORKGROUP_SIZE ;
    if (qIdx >= WORKGROUP_SIZE || jid >= render_state.num_rays) {
      return;
    }
    let deferred_ray = ray_buffer.elements[jid];
    var hit = intersectScene(deferred_ray, LID);
    if (hit.index != NO_HIT_IDX) {
      let idx = atomicAdd(&render_state.num_hits, 1);
      hit_buffer.elements[idx] = hit;
    } else {
      let idx = atomicAdd(&render_state.num_misses, 1);
      miss_buffer.elements[idx] = deferred_ray;
    }
  }
}