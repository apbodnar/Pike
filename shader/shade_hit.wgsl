const EPSILON: f32 = 0.0000001;
const M_PI: f32 = 3.141592653589793;
const M_TAU: f32 = 6.283185307179586;
const INV_PI: f32 = 0.3183098861837907;
const INV_TAU: f32 = 0.15915494309189535;
const NO_HIT_IDX: i32 = -1;
const WORKGROUP_SIZE = 128;
const NUM_LUMINANCE_BINS = ###NUM_LUMINANCE_BINS###u;

var<private> seed: u32;

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

struct VertexAttribute {
  tangent: vec3<f32>,
  bitangent: vec3<f32>,
  normal: vec3<f32>,
  uv: vec2<f32>,
};

struct VertexAttributes {
  attributes: array<VertexAttribute>,
};

struct TextureTransform {
  scale: vec2<f32>,
  trans: vec2<f32>,
}

struct MaterialIndex {
  diffMap: i32,
  metRoughMap: i32,
  normMap: i32,
  emitMap: i32,
  diffMapTransform: TextureTransform,
  metRoughMapTransform: TextureTransform,
  normMapTransform: TextureTransform,
  emitMapTransform: TextureTransform,
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
  ray: Ray,
  throughput: vec4<f32>,
};

struct HitBuffer {
  elements: array<Hit>,
}

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
  wi: vec3<f32>,
  pdf: f32,
};

@group(0) @binding(0) var<storage, read> attrs: VertexAttributes;
@group(0) @binding(1) var<storage, read> materials: MaterialIndices;
@group(0) @binding(2) var atlasTex: texture_2d_array<f32>;
@group(0) @binding(3) var<uniform> envRes: vec2<u32>;
@group(0) @binding(4) var pdfTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> envCoords: LuminanceCoords;
@group(0) @binding(6) var<storage, read> envLuminance: LuminanceBins;
@group(0) @binding(7) var atlasSampler: sampler;

@group(1) @binding(0) var<storage, read_write> renderState: RenderState;
@group(1) @binding(1) var<storage, read_write> rayBuffer: DeferredRayBuffer;

@group(2) @binding(0) var<storage, read> triangles: Triangles;
@group(2) @binding(1) var<storage, read_write> hitBuffer: HitBuffer;

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

fn envPdf(dir: vec3<f32>) -> f32 {
  let dims = vec2<f32>(envRes);
  let u = (1f + renderState.envTheta + atan2(dir.z, dir.x) / M_TAU) % 1f;
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
  let u = -renderState.envTheta +((0.5 + f32(coord.x)) / dims.x);
  let v = (0.5 + f32(coord.y)) / dims.y;
  let theta = u * M_TAU;
  let phi = v * M_PI;
  let sinPhi = sin(phi);
  let dir = vec3<f32>(cos(theta) * sinPhi, cos(phi), sin(theta) * sinPhi);
  let pdf = textureLoad(pdfTex, coord, 0).r / sinPhi;
  return Sample(dir * ONB, pdf);
}

fn lambertPdf(wi: vec3<f32>, n: vec3<f32>) -> f32 {
  return max(dot(wi, n), EPSILON) * INV_PI;
}

fn sampleLambert() -> Sample {
  let normal = vec3<f32>(0f, 0f, 1f);
  let r: f32 = sqrt(rand());
  let phi: f32 = M_TAU * rand();
  let x = r * cos(phi);
  let y = r * sin(phi);
  let z = sqrt(max(0.0, 1.0 - x*x - y*y));
  let dir = vec3<f32>(x, y, z);
  let pdf = lambertPdf(dir, normal);
  return Sample(dir, pdf);
}

fn evalLambert(sample: Sample) -> f32 {
  // Lambertian BRDF = Albedo / Pi
  // TODO: the math can be simplified once i'm confident in all the statistical derivations elsewhere
  // https://computergraphics.stackexchange.com/questions/8578
  return INV_PI * max(EPSILON, sample.wi.z) / sample.pdf;
}

// D for Cook Torrence microfacet BSDF using GGX distribution.
// m: the microfacet normal centered on (0, 0, 1)
// au: anisotropic roughness along the tangent
// av: anisotropic roughness along the bitangent 
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
fn sampleGGX(wo: vec3<f32>, au: f32, av: f32) -> vec3<f32> {
  // Section 3.2: transforming the view direction to the hemisphere configuration
  let Vh = normalize(vec3(au * wo.x, av * wo.y, wo.z));
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

fn specularPdf(wo: vec3<f32>, m: vec3<f32>, au: f32, av: f32) -> f32 {
  return max(EPSILON, GGX_D(m, au, av) * GGX_G1(wo, m, au, av) / (4f * wo.z));
}

fn sampleSpecular(wo: vec3<f32>,  m: vec3<f32>, au: f32, av: f32) -> Sample {
  let wi = reflect(-wo, m);
  let pdf = specularPdf(wo, m, au, av);
  return Sample(wi, pdf);
}

fn evalSpecular(wo: vec3<f32>, sample: Sample, au: f32, av: f32) -> f32 {
  let H = normalize(wo + sample.wi);
  let D = GGX_D(H, au, av);
  let G = GGX_G(sample.wi, wo, H, au, av);
  return max(D * G / (4f * wo.z * sample.pdf), 0f);
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

fn applyTextureTransform(uv: vec2<f32>, t: TextureTransform) -> vec2<f32> {
  return uv * t.scale + t.trans;
}

fn interpolateVertexAttribute(tri: Triangle, bary: vec3<f32>) -> VertexAttribute {
  //var attr: array<VertexAttribute, 3> = attrs.attributes[i];
  return VertexAttribute(
    normalize(mat3x3<f32>(attrs.attributes[tri.i1].tangent, attrs.attributes[tri.i2].tangent, attrs.attributes[tri.i3].tangent) * bary),
    normalize(mat3x3<f32>(attrs.attributes[tri.i1].bitangent, attrs.attributes[tri.i2].bitangent, attrs.attributes[tri.i3].bitangent) * bary),
    normalize(mat3x3<f32>(attrs.attributes[tri.i1].normal, attrs.attributes[tri.i2].normal, attrs.attributes[tri.i3].normal) * bary),
    mat3x2<f32>(attrs.attributes[tri.i1].uv, attrs.attributes[tri.i2].uv, attrs.attributes[tri.i3].uv) * bary,
  );
}

fn emitBounceRay(deferredRay: DeferredRay) {
  let idx = atomicAdd(&renderState.numRays, 1);
  rayBuffer.elements[idx] = deferredRay;
}

fn emitShadowRay(deferredRay: DeferredRay) {
  let offset = arrayLength(&rayBuffer.elements) / 2;
  let idx = atomicAdd(&renderState.numShadowRays, 1) + offset;
  rayBuffer.elements[idx] = deferredRay;
}

@compute @workgroup_size(WORKGROUP_SIZE, 1, 1)
fn main(
  @builtin(global_invocation_id) GID : vec3<u32>,
) {
  let tid = GID.x;
  if (tid >= renderState.numHits) {
    return;
  }
  let hit = hitBuffer.elements[tid];
  let ray = hit.ray;
  let samples = u32(renderState.samples) & 0x0fffffffu;
  let colorIdx = bitcast<u32>(hit.throughput.w);
  var color = vec3<f32>(0f);
  var throughput = hit.throughput.rgb;
  seed = (GID.x * 1973u + colorIdx * 9277u + samples * 26699u) | 1u;
  seed = hash();
  
  let tri = triangles.triangles[hit.index];
  let attr = interpolateVertexAttribute(tri, hit.bary);
  let matIdx = materials.indices[tri.matId];
  let mapNormal = (textureSampleLevel(atlasTex, atlasSampler, applyTextureTransform(attr.uv, matIdx.normMapTransform), matIdx.normMap, 0f).xyz - vec3<f32>(0.5, 0.5, 0.0)) * vec3<f32>(2.0, 2.0, 1.0);
  let normal =  normalize(mat3x3<f32>(attr.tangent, attr.bitangent, attr.normal) * mapNormal);
  // ONB used for computations using the mapped normal;
  
  let ONB = branchlessONB(normal);
  let origin = ray.origin + ray.dir * (hit.t - EPSILON * 40f);

  let metRough = textureSampleLevel(atlasTex, atlasSampler, applyTextureTransform(attr.uv, matIdx.metRoughMapTransform), matIdx.metRoughMap, 0f).xyz;
  let diffuse = textureSampleLevel(atlasTex, atlasSampler, applyTextureTransform(attr.uv, matIdx.diffMapTransform), matIdx.diffMap, 0f).xyz;
  let specular = mix(vec3<f32>(1f), diffuse, metRough.b);
  
  let a = metRough.g * metRough.g;
  let wo = -ray.dir * ONB;
  let m = sampleGGX(wo, a, a);
  let f = mix(schlick(max(dot(wo, m), 0f), 1.5), 1f, metRough.b);

  // Sample the BSDF
  var bsdfSample: Sample;
  var bsdf: vec3<f32>;
  if (rand() > f) {
    bsdfSample = sampleLambert();
    bsdf = diffuse * evalLambert(bsdfSample);
  } else {
    bsdfSample = sampleSpecular(wo, m, a, a);
    bsdf = specular * evalSpecular(wo, bsdfSample, a, a);
  }
  
  if (bsdfSample.wi.z > 0f) {
    let dir = ONB * bsdfSample.wi;
    let weight = powerHeuristic(bsdfSample.pdf, envPdf(dir));
    let bounceRay = Ray(origin, dir);
    let bounceThroughput = vec4<f32>(bsdf * throughput * weight, bitcast<f32>(colorIdx));
    let deferredBounceRay = DeferredRay(bounceRay, bounceThroughput);
    emitBounceRay(deferredBounceRay);
  }
  
  // Sample the environment light
  let envSample = sampleEnv(ONB);
  let envDir = ONB * envSample.wi;
  if (dot(envSample.wi, m) > 0f && envSample.wi.z > 0f) {
    let lambertWeight = powerHeuristic(envSample.pdf, lambertPdf(envDir, normal));
    var scale = (1f - f) * diffuse * evalLambert(envSample) * lambertWeight;
    let h = normalize(wo + envSample.wi);
    let specWeight = powerHeuristic(envSample.pdf, specularPdf(wo, h, a, a));
    scale += f * specular * evalSpecular(wo, envSample, a, a) * specWeight;
    let shadowRay = Ray(origin, envDir);
    let shadowThroughput = vec4<f32>(scale * throughput, hit.throughput.w);
    let deferredShadowRay = DeferredRay(shadowRay, shadowThroughput);
    emitShadowRay(deferredShadowRay);
  }
}