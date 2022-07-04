
var<private> seed: u32;

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

fn createPrimaryRay(gid: vec2<f32>, dims: vec2<f32>) -> Ray {
  let uv = (2f * ((gid + vec2<f32>(rand(), rand())) / dims) - 1f) * vec2<f32>(dims.x / dims.y, -1f);
  let up = vec3<f32>(0f, 1f, 0f);
  let basisX: vec3<f32> = normalize(cross(state.eye.dir, up)) * state.fov;
  let basisY: vec3<f32> = normalize(cross(basisX, state.eye.dir)) * state.fov;
  let theta = rand() * M_TAU;
  let dof = (cos(theta) * basisX + sin(theta) * basisY) * state.apertureSize * sqrt(rand());
  let screen: vec3<f32> = uv.x * basisX + uv.y * basisY + state.eye.dir + state.eye.origin;
  let dir = normalize((screen + dof * state.focalDepth) - (state.eye.origin + dof));
  let origin = dof + state.eye.origin;
  return Ray(origin, dir);
}

@compute @workgroup_size(16, 8, 1)
fn main(
  @builtin(global_invocation_id) GID : vec3<u32>,
) {
  let dims = vec2<f32>(textureDimensions(inputTex, 0));
  let gid = vec2<f32>(GID.xy);
  if (any(gid >= dims)) {
    return;
  }
  seed = (GID.x * 1973u + GID.y * 9277u + u32(state.samples) * 26699u) | 1u;
  seed = hash();
  var ray = createPrimaryRay(gid, dims);
}