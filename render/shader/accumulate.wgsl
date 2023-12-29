struct RenderState {
  samples: i32,
  env_theta: f32,
  num_hits: u32,
  num_misses: u32,
  num_rays: u32,
  numShadowRays: u32,
  // Refactor once R/W storage textures exists
  colorBuffer: array<vec4<f32>>,
};

struct TempBuffer {
  elements: array<vec4<f32>>,
}

@group(0) @binding(0) var<storage, read_write> render_state: RenderState;
@group(0) @binding(1) var<storage, read_write> tempBuffer: TempBuffer;
@group(0) @binding(2) var accumulateTex : texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(128, 1, 1)
fn main(
  @builtin(global_invocation_id) GID : vec3<u32>,
) {
  let dims = vec2<u32>(textureDimensions(accumulateTex));
  if (any(GID.xy > dims)) {
    return;
  }
  let colorIdx = GID.x + GID.y * dims.x;
  var color: vec3<f32> = max(render_state.colorBuffer[colorIdx].rgb,  vec3<f32>(0f));
  var acc: vec3<f32> = tempBuffer.elements[colorIdx].rgb;
  acc = vec3<f32>(color + (acc * f32(render_state.samples)))/(f32(render_state.samples + 1));
  let result = vec4<f32>(acc, 1.0);
  tempBuffer.elements[colorIdx] = result;
  textureStore(accumulateTex, vec2<i32>(GID.xy), result);
}