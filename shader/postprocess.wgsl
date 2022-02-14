struct PostprocessParams {
  exposure: f32;
};

@group(0) @binding(0) var renderResultTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> postprocess: PostprocessParams;

struct VertexOutput {
  @builtin(position) Position : vec4<f32>;
  @location(0) fragUV : vec2<f32>;
};

@stage(vertex)
fn vert_main(@builtin(vertex_index) VertexIndex : u32) -> VertexOutput {
  var pos = array<vec2<f32>, 6>(
      vec2<f32>( 1.0,  1.0),
      vec2<f32>( 1.0, -1.0),
      vec2<f32>(-1.0, -1.0),
      vec2<f32>( 1.0,  1.0),
      vec2<f32>(-1.0, -1.0),
      vec2<f32>(-1.0,  1.0));

  var uv = array<vec2<f32>, 6>(
      vec2<f32>(1.0, 0.0),
      vec2<f32>(1.0, 1.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(1.0, 0.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(0.0, 0.0));

  var output : VertexOutput;
  output.Position = vec4<f32>(pos[VertexIndex], 0.0, 1.0);
  output.fragUV = uv[VertexIndex];
  return output;
}

fn linearToSRGB(color: vec3<f32>) -> vec3<f32> {
    let cutoff: vec3<bool> = color <= vec3<f32>(0.0031308);
    let higher: vec3<f32> = vec3<f32>(1.055) * pow(color,  vec3<f32>(1.0/2.4)) -  vec3<f32>(0.055);
    let lower: vec3<f32> = color * vec3<f32>(12.92);
    return mix(higher, lower, vec3<f32>(cutoff));
}

fn linearToDisplayP3(color: vec3<f32>) -> vec3<f32> {
    let cutoff: vec3<bool> = color <= vec3<f32>(0.0031308);
    let higher: vec3<f32> = vec3<f32>(1.055) * pow(color,  vec3<f32>(1.0/2.4)) -  vec3<f32>(0.055);
    let lower: vec3<f32> = color * vec3<f32>(12.92);
    return mix(higher, lower, vec3<f32>(cutoff));
}

fn RRTAndODTFit(v: vec3<f32>) -> vec3<f32> {
    let a = v * (v + 0.0245786) - 0.000090537;
    let b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
}

fn ACESFitted(in: vec3<f32>) -> vec3<f32> {
    var out = in * mat3x3(
      0.59719, 0.35458, 0.04823,
      0.07600, 0.90834, 0.01566,
      0.02840, 0.13383, 0.83777
    );
    // Apply RRT and ODT
    out = RRTAndODTFit(out);
    out = out * mat3x3(
      1.60475, -0.53108, -0.07367,
      -0.10208,  1.10813, -0.00605,
      -0.00327, -0.07276,  1.07602
    );
    // Clamp to [0, 1]
    out = clamp(out, vec3<f32>(0f),  vec3<f32>(1f));
    return out;
}

@stage(fragment)
fn frag_main(@location(0) fragUV : vec2<f32>) -> @location(0) vec4<f32> {
  let dims : vec2<i32> = textureDimensions(renderResultTex, 0);
  var acc: vec3<f32> = textureLoad(renderResultTex, vec2<i32>( fragUV * vec2<f32>(dims)), 0).rgb;
  acc = ACESFitted(acc * postprocess.exposure);
  acc = linearToSRGB(acc);
  return vec4<f32>(acc, 1f);
}