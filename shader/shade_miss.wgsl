const M_TAU: f32 = 6.283185307179586;
const INV_PI: f32 = 0.3183098861837907;
const WORKGROUP_SIZE = 128;

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

struct RenderState {
  samples: i32,
  envTheta: f32,
  numHits: u32,
  numMisses: u32,
  numRays: atomic<u32>,
  numShadowRays: u32,
  // Refactor once R/W storage textures exists
  colorBuffer: array<vec4<f32>>,
};

@group(0) @binding(0) var envTex: texture_2d<f32>;
@group(0) @binding(1) var envSampler: sampler;

@group(1) @binding(0) var<storage, read_write> renderState: RenderState;

@group(2) @binding(0) var<storage, read_write> missBuffer: DeferredRayBuffer;

fn envColor(dir: vec3<f32>) -> vec3<f32> {
  let u = renderState.envTheta + atan2(dir.z, dir.x) / M_TAU;
  let v = acos(dir.y) * INV_PI;
  let c = vec2<f32>(u, v);
  let rgbe = textureSampleLevel(envTex, envSampler, c, 0f);
  return rgbe.rgb * pow(2.0, rgbe.a * 255.0 - 128.0);
}

@compute @workgroup_size(WORKGROUP_SIZE, 1, 1)
fn main(
  @builtin(global_invocation_id) GID : vec3<u32>,
) {
  let tid = GID.x;
  if (tid >= renderState.numMisses) {
    return;
  }
  let deferredRay = missBuffer.elements[tid];
  let colorIdx = bitcast<u32>(deferredRay.throughput.w);
  var color = envColor(deferredRay.ray.dir) * deferredRay.throughput.rgb;
  renderState.colorBuffer[colorIdx] += vec4<f32>(color, 1.0);
}