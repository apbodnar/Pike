const EPSILON: f32 = 0.0000001;
const M_PI: f32 = 3.141592653589793;
const M_TAU: f32 = 6.283185307179586;
const INV_PI: f32 = 0.3183098861837907;
const INV_TAU: f32 = 0.15915494309189535;
const NO_HIT_IDX: i32 = -1;
const WORKGROUP_SIZE = 128;
const SAMPLE_ENV_LIGHT = true;
const NUM_SCENE_LIGHTS = 0;
const ENV_SAMPLE = 0x00000000;
const LIGHT_SAMPLE = 0x10000000;

var<private> seed: u32;

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

struct QuantizedVertexAttribute {
  tangent: u32,
  bitangent: u32,
  normal: u32,
  uv: u32,
};

struct VertexAttribute {
  tangent: vec3<f32>,
  bitangent: vec3<f32>,
  normal: vec3<f32>,
  uv: vec2<f32>,
};

struct VertexAttributes {
  attributes: array<QuantizedVertexAttribute>,
};

struct LightBox {
  min: vec3<f32>,
  max: vec3<f32>,
}

// struct LightBoxBuffer {
//   elements: array<LightBox, NUM_SCENE_LIGHTS>,
// }

struct MaterialIndex {
  diffMap: i32,
  metRoughMap: i32,
  normMap: i32,
  emitMap: i32,
};

struct MaterialIndices {
  indices: array<MaterialIndex>,
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
  deferred_ray: DeferredRay,
};

struct HitBuffer {
  elements: array<Hit>,
}

struct RenderState {
  samples: u32,
  env_theta: f32,
  num_hits: u32,
  num_misses: u32,
  num_rays: atomic<u32>,
  numShadowRays: atomic<u32>,
  // Refactor once R/W storage textures exists
  colorBuffer: array<vec4<f32>>,
};

struct LuminanceCoords {
  coords: array<vec2<i32>>,
};

struct LuminanceBin {
  h0: i32,
  h1: i32,
};

struct LuminanceBins {
  bins: array<LuminanceBin>,
};

struct Sample {
  // incoming (in the sense of a reverse path) ray direction in hemisphere space
  wi: vec3<f32>,
  pdf: f32,
};

struct SurfaceInteraction {
  basis: mat3x3<f32>,
  wo: vec3<f32>,
  origin: vec3<f32>,
  normal: vec3<f32>,
  baseColor: vec3<f32>,
  specularColor: vec3<f32>,
  emissionColor: vec3<f32>,
  metallic: f32,
  opacity: f32,
  roughAlpha: f32, 
}

@group(0) @binding(0) var<storage, read> attrs: VertexAttributes;
@group(0) @binding(1) var<storage, read> materials: MaterialIndices;
@group(0) @binding(2) var atlasTex: texture_2d_array<f32>;
@group(0) @binding(3) var<uniform> envRes: vec2<u32>;
@group(0) @binding(4) var pdfTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> envCoords: LuminanceCoords;
@group(0) @binding(6) var<storage, read> envLuminance: LuminanceBins;
@group(0) @binding(7) var atlasSampler: sampler;
// @group(0) @binding(8) var<uniform> lightBoxBuffer: LightBoxBuffer;

@group(1) @binding(0) var<storage, read_write> render_state: RenderState;
@group(1) @binding(1) var<storage, read_write> ray_buffer: DeferredRayBuffer;

@group(2) @binding(0) var<storage, read> triangles: Triangles;
@group(2) @binding(1) var<storage, read_write> hit_buffer: HitBuffer;

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

// From: "Building an Orthonormal Basis, Revisited - Pixar et. al"
fn branchlessONB(n: vec3<f32>) -> mat3x3<f32> {
  // sign() performs catastrophically slowly last checked
  //let lastBit: u32 = bitcast<u32>(n.z) & 2147483648u;
  //let sign = bitcast<f32>(bitcast<u32>(-1f) | lastBit);
  let sign = select(-1f, 1f, n.z > 0f);
  //let sign = sign(n.z);
  let a = -1f / (sign + n.z);
  let b = n.x * n.y * a;
  let b1 = vec3<f32>(1f + sign * n.x * n.x * a, sign * b, -sign * n.x);
  let b2 = vec3<f32>(b, sign + n.y * n.y * a, -n.y);
  return mat3x3<f32>(b1, b2, n);
}

fn getSurfaceInteraction(hit: Hit) -> SurfaceInteraction {
  let ray = hit.deferred_ray.ray;
  let tri = triangles.triangles[hit.index];
  let attr = interpolateVertexAttribute(tri, hit.bary);
  let matIdx = materials.indices[tri.mat_id];
  let mapNormal = (textureSampleLevel(atlasTex, atlasSampler, attr.uv, matIdx.normMap, 0f).xyz - vec3<f32>(0.5, 0.5, 0.0)) * vec3<f32>(2.0, 2.0, 1.0);
  var si = SurfaceInteraction();
  si.normal = normalize(mat3x3<f32>(attr.tangent, attr.bitangent, attr.normal) * mapNormal);
  si.origin = ray.origin + ray.dir * (hit.t - EPSILON * 40f);
  // ONB used for computations using the mapped normal;
  si.basis = branchlessONB(si.normal);
  si.wo = -ray.dir * si.basis;
  let baseColorOpacity = textureSampleLevel(atlasTex, atlasSampler, attr.uv, matIdx.diffMap, 0f);
  si.baseColor = baseColorOpacity.rgb;
  si.opacity = baseColorOpacity.a;
  let metRough = textureSampleLevel(atlasTex, atlasSampler, attr.uv, matIdx.metRoughMap, 0f).xyz;
  si.metallic = metRough.b;
  si.roughAlpha = metRough.g * metRough.g;
  si.emissionColor = textureSampleLevel(atlasTex, atlasSampler, attr.uv, matIdx.emitMap, 0f).xyz;
  si.specularColor = mix(vec3<f32>(1f), si.baseColor, si.metallic);
  return si;
}

fn envPdf(dir: vec3<f32>) -> f32 {
  let dims = vec2<f32>(envRes);
  let u = (1f + render_state.env_theta + atan2(dir.z, dir.x) / M_TAU) % 1f;
  let v = acos(dir.y) * INV_PI;
  let c = vec2<i32>(vec2<f32>(u, v) * dims);
  let phi = v * M_PI;
  let sinPhi = sin(phi);
  return textureLoad(pdfTex, c, 0).r / sinPhi;
}

// Solid angle formulation; should reduce clumping near high latitudes
fn sampleEnv(ONB: mat3x3<f32>) -> Sample {
  let dims = vec2<f32>(envRes);
  let idx = i32(hash() % arrayLength(&envLuminance.bins));
  let bin = envLuminance.bins[idx];
  let coordIdx = i32(hash() % u32(bin.h1 - bin.h0)) + bin.h0;
  let coord = envCoords.coords[coordIdx];
  let u = -render_state.env_theta +((0.5 + f32(coord.x)) / dims.x);
  let v = (0.5 + f32(coord.y)) / dims.y;
  let theta = u * M_TAU;
  let phi = v * M_PI;
  let sinPhi = sin(phi);
  let dir = vec3<f32>(cos(theta) * sinPhi, cos(phi), sin(theta) * sinPhi);
  let pdf = textureLoad(pdfTex, coord, 0).r / sinPhi;
  return Sample(dir * ONB, pdf);
}

// fn sampleSceneLight(si: SurfaceInteraction) -> Sample {
//   let light = lightBoxBuffer.elements[hash() % NUM_SCENE_LIGHTS];
//   let span = light.max - light.min;
//   let boxPoint = light.min + span * vec3<f32>(rand(), rand(), rand());
//   let len = length(boxPoint - si.origin);
//   let dir = (boxPoint - si.origin) / len;
//   let pdf = 1f;//(span.x * span.y * span.z) / NUM_SCENE_LIGHTS / len;
//   return Sample(dir * si.basis, pdf);
// }

fn lambertPdf(wi: vec3<f32>) -> f32 {
  return max(wi.z, EPSILON) * INV_PI;
}

fn sampleLambert() -> Sample {
  let normal = vec3<f32>(0f, 0f, 1f);
  let r: f32 = sqrt(rand());
  let phi: f32 = M_TAU * rand();
  let x = r * cos(phi);
  let y = r * sin(phi);
  let z = sqrt(max(0.0, 1.0 - x*x - y*y));
  let dir = vec3<f32>(x, y, z);
  let pdf = lambertPdf(dir);
  return Sample(dir, pdf);
}

fn evalLambert(si: SurfaceInteraction, sample: Sample) -> vec3<f32> {
  // Lambertian BRDF = Albedo / Pi
  // TODO: the math can be simplified once i'm confident in all the statistical derivations elsewhere
  // https://computergraphics.stackexchange.com/questions/8578
  return si.baseColor * INV_PI * max(EPSILON, sample.wi.z) / sample.pdf;
}

// GGX NDF and PDF from: A Simpler and Exact Sampling Routine for the GGX
// Distribution of Visible Normals - Eric Heitz
// https://hal.archives-ouvertes.fr/hal-01509746/document

fn GGX_D(m: vec3<f32>, au: f32, av: f32) -> f32 {
  let auv = au * av;
  let tangent = m.x / au;
  let bitangent = m.y / av;
  let ellipse = tangent * tangent + bitangent * bitangent + m.z * m.z;
  return 1f / (M_PI * auv * ellipse * ellipse);
}

fn GGX_G1(w: vec3<f32>, m: vec3<f32>, au: f32, av: f32) -> f32 {
  let up = vec3<f32>(0f, 0f, 1f);
  let ax = w.x * au;
  let ay = w.y * av;
  let axy2 = ax * ax + ay * ay;
  let tanTheta = axy2 / (w.z * w.z);
  var result = 2f / (1f + sqrt(1f + tanTheta));
  return select(result, 0f, dot(w, m) * dot(w, up) <= 0f);
}

fn GGX_PDF(wo: vec3<f32>, m: vec3<f32>, au: f32, av: f32) -> f32 {
  let up = vec3<f32>(0f, 0f, 1f);
  let D = GGX_D(m, au, av);
  return D * GGX_G1(wo, m, au, av) * abs(dot(wo, m)) / dot(wo, up);
}

fn GGX_G(wi: vec3<f32>, wo: vec3<f32>, m: vec3<f32>, au: f32, av: f32) -> f32 {
  return GGX_G1(wi, m, au, av) * GGX_G1(wo, m, au, av);
}

//From: "Sampling the GGX Distribution of Visible Normals - Eric Heitz"
fn sampleGGX(si: SurfaceInteraction) -> vec3<f32> {
  // No anisotropy for now.
  let au = si.roughAlpha;
  let av = si.roughAlpha;
  // Section 3.2: transforming the view direction to the hemisphere configuration
  let Vh = normalize(vec3(au * si.wo.x, av * si.wo.y, si.wo.z));
  // Section 4.1: orthonormal basis (with special case if cross product is zero)
  let lensq = dot(Vh.xy, Vh.xy);
  let T1 = select(vec3<f32>(1f,0f,0f),  vec3<f32>(-Vh.y, Vh.x, 0f) * inverseSqrt(lensq), lensq > 0f);
  let T2 = cross(Vh, T1);
  // Section 4.2: parameterization of the projected area
  let r = sqrt(rand());
  let phi = M_TAU * rand();
  let t1 = r * cos(phi);
  var t2 = r * sin(phi);
  let s = 0.5 * (1.0 + Vh.z);
  t2 = (1.0 - s)*sqrt(1.0 - t1*t1) + s*t2;
  // Section 4.3: reprojection onto hemisphere
  let Nh = t1*T1 + t2*T2 + sqrt(max(0.0, 1.0 - t1*t1 - t2*t2))*Vh;
  // Section 3.4: transforming the normal back to the ellipsoid configuration
  return normalize(vec3<f32>(au * Nh.x, av * Nh.y, max(0.0, Nh.z)));
}

fn specularPdf(si: SurfaceInteraction, m: vec3<f32>) -> f32 {
  let au = si.roughAlpha;
  let av = si.roughAlpha;
  return max(EPSILON, GGX_D(m, au, av) * GGX_G1(si.wo, m, au, av) / (4f * si.wo.z));
}

fn sampleSpecular(si: SurfaceInteraction,  m: vec3<f32>) -> Sample {
  let wi = reflect(-si.wo, m);
  let pdf = specularPdf(si, m);
  return Sample(wi, pdf);
}

fn evalSpecular(si: SurfaceInteraction, sample: Sample) -> vec3<f32> {
  let au = si.roughAlpha;
  let av = si.roughAlpha;
  let H = normalize(si.wo + sample.wi);
  let D = GGX_D(H, au, av);
  let G = GGX_G(sample.wi, si.wo, H, au, av);
  return max(D * G / (4f * si.wo.z * sample.pdf), 0f) * si.specularColor;
}

fn createMaterialSampleRay(si: SurfaceInteraction, sample: Sample, f: f32, rayThroughput: vec4<f32>) -> DeferredRay {
  let lambertWeight = powerHeuristic(sample.pdf, lambertPdf(sample.wi));
  var scale = (1f - f) * evalLambert(si, sample) * lambertWeight;
  let h = normalize(si.wo + sample.wi);
  let specWeight = powerHeuristic(sample.pdf, specularPdf(si, h));
  scale += f * evalSpecular(si, sample) * specWeight;
  let ray = Ray(si.origin, si.basis * sample.wi);
  let throughput = vec4<f32>(scale * rayThroughput.rgb, rayThroughput.w);
  return DeferredRay(ray, throughput);
}

fn schlick(cosTheta: f32, ior: f32) -> f32 {
    var r0 = (1f - ior) / (1f + ior); // ior = n2/n1
    r0 *= r0;
    let tmp = (1f - cosTheta);
    let tmp2 = tmp * tmp;
    return r0 + (1f - r0) * tmp2 * tmp2 * tmp;
}

fn powerHeuristic(pdf0: f32, pdf1: f32) -> f32 {
  let pdf02 = pdf0 * pdf0;
  return (pdf02)/(pdf02 + pdf1 * pdf1);
}

fn interpolateVertexAttribute(tri: Triangle, bary: vec3<f32>) -> VertexAttribute {
  //var attr: array<VertexAttribute, 3> = attrs.attributes[i];
  let tangents = mat3x3<f32>(
    unpack4x8snorm(attrs.attributes[tri.i1].tangent).xyz, 
    unpack4x8snorm(attrs.attributes[tri.i2].tangent).xyz, 
    unpack4x8snorm(attrs.attributes[tri.i3].tangent).xyz
  );
  let bitangents = mat3x3<f32>(
    unpack4x8snorm(attrs.attributes[tri.i1].bitangent).xyz, 
    unpack4x8snorm(attrs.attributes[tri.i2].bitangent).xyz, 
    unpack4x8snorm(attrs.attributes[tri.i3].bitangent).xyz
  );
  let normals = mat3x3<f32>(
    unpack4x8snorm(attrs.attributes[tri.i1].normal).xyz, 
    unpack4x8snorm(attrs.attributes[tri.i2].normal).xyz, 
    unpack4x8snorm(attrs.attributes[tri.i3].normal).xyz
  );
  let uvs = mat3x2<f32>(
    unpack2x16snorm(attrs.attributes[tri.i1].uv),
    unpack2x16snorm(attrs.attributes[tri.i2].uv),
    unpack2x16snorm(attrs.attributes[tri.i3].uv)
  );
  return VertexAttribute(
    normalize(tangents * bary),
    normalize(bitangents * bary),
    normalize(normals * bary),
    uvs * bary,
  );
}

fn emitBounceRay(deferred_ray: DeferredRay) {
  let idx = atomicAdd(&render_state.num_rays, 1);
  ray_buffer.elements[idx] = deferred_ray;
}

fn emitShadowRay(deferred_ray: DeferredRay) {
  let offset = arrayLength(&ray_buffer.elements) / 2;
  let idx = atomicAdd(&render_state.numShadowRays, 1) + offset;
  ray_buffer.elements[idx] = deferred_ray;
}

@compute @workgroup_size(WORKGROUP_SIZE, 1, 1)
fn main(
  @builtin(global_invocation_id) GID : vec3<u32>,
) {
  let tid = GID.x;
  if (tid >= render_state.num_hits) {
    return;
  }
  let hit = hit_buffer.elements[tid];
  let ray = hit.deferred_ray.ray;
  let coordMask = bitcast<u32>(hit.deferred_ray.throughput.w);
  let colorIdx = coordMask & 0x0fffffffu;
  let rayType = coordMask & 0xf0000000u;
  var colorThroughput = hit.deferred_ray.throughput.rgb;
  seed = (GID.x * 1973u + colorIdx * 9277u + render_state.samples * 26699u) | 1u;
  seed = hash();
  
  let si = getSurfaceInteraction(hit);

  if (rand() > si.opacity) {
    let alphaOrigin = ray.origin + ray.dir * (hit.t + EPSILON * 40f);
    let bounceRay = Ray(alphaOrigin, ray.dir);
    emitBounceRay(DeferredRay(bounceRay, hit.deferred_ray.throughput));
    return;
  }
  
  // Add the surface's emission if there is any
  if(dot(si.emissionColor, vec3<f32>(1f)) > 0f) {
    let attenuation = max(dot(si.normal, si.basis * si.wo), 0f);
    render_state.colorBuffer[colorIdx] += vec4<f32>(vec3<f32>(50f) * si.emissionColor * colorThroughput * attenuation, 1.0);
    return;
  }
  // Kill the path if this was a light ray to avoid creating too many bounce rays.
  if (rayType == LIGHT_SAMPLE) {
    return;
  }

  let m = sampleGGX(si);
  let f = mix(schlick(max(dot(si.wo, m), 0f), 1.5), 1f, si.metallic);

  // Sample the BSDF
  var bsdfSample: Sample;
  var bsdf: vec3<f32>;
  if (rand() > f) {
    bsdfSample = sampleLambert();
    bsdf = evalLambert(si, bsdfSample);
  } else {
    bsdfSample = sampleSpecular(si, m);
    bsdf = evalSpecular(si, bsdfSample);
  }
  
  if (bsdfSample.wi.z > 0f) {
    let dir = si.basis * bsdfSample.wi;
    let weight = select(1f, powerHeuristic(bsdfSample.pdf, envPdf(dir)), SAMPLE_ENV_LIGHT);
    let bounceRay = Ray(si.origin, dir);
    let bounceThroughput = vec4<f32>(bsdf * colorThroughput * weight, hit.deferred_ray.throughput.w);
    let deferredBounceRay = DeferredRay(bounceRay, bounceThroughput);
    emitBounceRay(deferredBounceRay);
  }

  // if (NUM_SCENE_LIGHTS > 0) {
  //   let lightSample = sampleSceneLight(si);
  //   if (lightSample.wi.z > EPSILON) {
  //     var lightDeferredRay = createMaterialSampleRay(si, lightSample, f, hit.deferred_ray.throughput);
  //     lightDeferredRay.throughput.w = bitcast<f32>(bitcast<u32>(lightDeferredRay.throughput.w) | LIGHT_SAMPLE);
  //     emitBounceRay(lightDeferredRay);
  //   }
  // }
  
  // Sample the environment light
  if (SAMPLE_ENV_LIGHT) {
    let envSample = sampleEnv(si.basis);
    if (dot(envSample.wi, m) > 0f && envSample.wi.z > 0f) {
      let deferredShadowRay = createMaterialSampleRay(si, envSample, f, hit.deferred_ray.throughput);
      emitShadowRay(deferredShadowRay);
    }
  }
}