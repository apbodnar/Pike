const M_TAU: f32 = 6.283185307179586;

var<private> seed: u32;

struct CameraState {
  eye: Ray,
  dimsMask: u32,
  fov: f32,
  focalDepth: f32,
  apertureSize: f32,
  distortion: f32,
  bokeh: f32,
};

struct RenderState {
  samples: i32,
  envTheta: f32,
  numHits: u32,
  numMisses: u32,
  numRays: atomic<u32>,
  numShadowRays: atomic<u32>,
  // Refactor once R/W storage textures exists
  colorBuffer: array<vec4<f32>>,
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

@group(0) @binding(0) var<storage, read_write> renderState: RenderState;
@group(0) @binding(1) var<storage, read_write> cameraBuffer: DeferredRayBuffer;

@group(1) @binding(0) var<uniform> cameraState: CameraState;

fn hash() -> u32 {
  //Jarzynski and Olano Hash
  var state = seed;
  seed = seed * 747796405u + 2891336453u;
  var word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand() -> f32 {
  return f32(hash()) / 4294967296.0;
}

fn createPrimaryRay(gid: vec2<f32>, res: vec2<f32>) -> Ray {
  let k = cameraState.distortion;
  var uv = (2f * ((gid + vec2<f32>(rand(), rand())) / res) - 1f) * vec2<f32>(res.x / res.y, -1f);
  let rd = length(uv);
  let ru = rd * (1f + k*rd*rd);
  let up = vec3<f32>(0f, 1f, 0f);
  uv = vec2<f32>(ru) * normalize(uv);
  let basisX: vec3<f32> = normalize(cross(cameraState.eye.dir, up)) * tan(cameraState.fov * 0.5);
  let basisY: vec3<f32> = normalize(cross(basisX, cameraState.eye.dir)) * tan(cameraState.fov * 0.5);
  let theta = rand() * M_TAU;
  let dof = (cos(theta) * basisX + sin(theta) * basisY) * cameraState.apertureSize * pow(rand(), cameraState.bokeh);
  let screen: vec3<f32> = uv.x * basisX + uv.y * basisY + cameraState.eye.dir + cameraState.eye.origin;
  let dir = normalize((screen + dof * cameraState.focalDepth) - (cameraState.eye.origin + dof));
  let origin = dof + cameraState.eye.origin;
  return Ray(origin, dir);
}


@compute @workgroup_size(128, 1, 1)
fn main(
  @builtin(global_invocation_id) GID : vec3<u32>,
) {
  var cameraRay: DeferredRay;
  let dims = vec2<u32>(cameraState.dimsMask >> 16u, cameraState.dimsMask & 0x0000ffffu);
  if (any(GID.xy >= dims)) {
    return;
  }
  let gid = vec2<f32>(GID.xy);
  seed = (GID.x * 1973u + GID.y * 9277u + u32(renderState.samples) * 26699u) | 1u;
  seed = hash();
  let idx = GID.x + GID.y * dims.x;
  cameraRay.ray = createPrimaryRay(gid, vec2<f32>(dims));
  cameraRay.throughput = vec4<f32>(vec3<f32>(1f), bitcast<f32>(idx));
  cameraBuffer.elements[idx] = cameraRay;
  atomicAdd(&renderState.numRays, 1);
}