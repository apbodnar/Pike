let EPSILON: f32 = 0.0000001;
let MAX_T: f32 = 100000.0;
let M_PI: f32 = 3.141592653589793;
let M_TAU: f32 = 6.283185307179586;
let INV_PI: f32 = 0.3183098861837907;
let INV_TAU: f32 = 0.15915494309189535;
let NUM_BOUNCES: i32 = 5;
let NO_HIT_IDX: i32 = -1;

var<private> seed: u32;
var<private> stack: array<i32, 32>;

// Keep vertex positions separate from other "attributes" to maximize locality during traversal.
struct Triangle {
  v1: vec3<f32>;
  v2: vec3<f32>;
  v3: vec3<f32>;
  [[align(16)]] matId: i32;
};

struct VertexAttribute {
  tangent: vec3<f32>;
  bitangent: vec3<f32>;
  normal: vec3<f32>;
  uv: vec2<f32>;
};

struct VertexAttributes {
  attributes: [[stride(192)]] array<array<VertexAttribute, 3>>;
};

struct MaterialIndex {
  diffMap: i32;
  metRoughMap: i32;
  normMap: i32;
  emitMap: i32;
};

struct MaterialIndices {
  indices: [[stride(16)]] array<MaterialIndex>;
};

struct Node {
  index: i32;
  left: i32;
  right: i32;
  triangles: i32;
  boxMin: vec3<f32>;
  boxMax: vec3<f32>;
};

struct BVH {
  nodes: [[stride(48)]] array<Node>;
};

struct Triangles {
  triangles: [[stride(64)]] array<Triangle>;
};

struct Ray {
  origin: vec3<f32>;
  dir: vec3<f32>;
};

struct Hit {
  t: f32;
  index: i32;
  tests: f32;
  bary: vec3<f32>;
};

struct State {
  eye: Ray;
  samples: i32;
  fov: f32;
  envTheta: f32;
};

struct LuminanceCoords {
  coords: [[stride(8)]] array<vec2<i32>>;
};

struct LuminanceBin {
  h0: i32;
  h1: i32;
};

struct LuminanceBins {
  bins: [[stride(8)]] array<LuminanceBin>;
};

struct Sample {
  wi: vec3<f32>;
  pdf: f32;
};

[[group(0), binding(0)]] var inputTex : texture_2d<f32>;
[[group(0), binding(1)]] var outputTex : texture_storage_2d<rgba32float, write>;

[[group(1), binding(0)]] var<storage, read> bvh: BVH;
[[group(1), binding(1)]] var<storage, read> triangles: Triangles;
[[group(1), binding(2)]] var<storage, read> attrs: VertexAttributes;
[[group(1), binding(3)]] var<storage, read> materials: MaterialIndices;
[[group(1), binding(4)]] var atlasTex: texture_2d_array<f32>;
[[group(1), binding(5)]] var envTex: texture_2d<f32>;
[[group(1), binding(6)]] var<storage, read> envCoords: LuminanceCoords;
[[group(1), binding(7)]] var<storage, read> envLuminance: LuminanceBins;
[[group(1), binding(8)]] var pdfTex: texture_2d<f32>;

[[group(2), binding(0)]] var<uniform> state: State;
[[group(2), binding(1)]] var atlasSampler: sampler;
[[group(2), binding(2)]] var envSampler: sampler;

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
  let e1: vec3<f32> = tri.v2 - tri.v1;
  let e2: vec3<f32> = tri.v3 - tri.v1;
  let p: vec3<f32> = cross(ray.dir, e2);
  let det: f32 = dot(e1, p);
  if(abs(det) < EPSILON){return MAX_T;}
  let invDet = 1f / det;
  let t: vec3<f32> = ray.origin - tri.v1;
  let u: f32 = dot(t, p) * invDet;
  if(u < 0f || u > 1f){return MAX_T;}
  let q: vec3<f32> = cross(t, e1);
  let v: f32 = dot(ray.dir, q) * invDet;
  if(v < 0f || u + v > 1f){return MAX_T;}
  let dist: f32 = dot(e2, q) * invDet;
  (*bary) = vec3<f32>(1f - u - v, u, v);
  return select(MAX_T, dist, dist > EPSILON);
}

// fn tightRayTriangleIntersect(ray: Ray, tri: Triangle, bary: ptr<function, vec3<f32>>) -> f32 {
//   var kz = 0;
//   let x = abs(ray.dir.x);
//   let y = abs(ray.dir.y);
//   let z = abs(ray.dir.z);
//   var maxAxis = 0;
//   maxAxis = select(maxAxis, 0, abs(x) > ray.dir[maxAxis]);
//   maxAxis = select(maxAxis, 1, abs(y) > ray.dir[maxAxis]);
//   maxAxis = select(maxAxis, 2, abs(z) > ray.dir[maxAxis]);
//   let kx = (kz + 1) % 3;
//   let ky = (kx + 1) % 3;
//   if (ray.dir[kz] < 0.0f) {
//     let temp = kx;
//     kx = ky;
//     ky = temp;
//   }
// }

fn processLeaf(leaf: Node, ray: Ray, result: ptr<function, Hit>){
  let leafSize = leaf.triangles >> 24u;
  let baseIdx = leaf.triangles & 0x00ffffff;
  var i: i32 = 0;
  loop {
    if (i >= leafSize) { break;}
    var bary = vec3<f32>();
    let tri: Triangle = triangles.triangles[baseIdx + i];
    let res: f32 = rayTriangleIntersect(ray, tri, &bary);
    (*result).tests = (*result).tests + 1f;
    if(res < (*result).t){
      (*result).index = baseIdx + i;
      (*result).t = res;
      (*result).bary = bary;
    }
    i = i + 1;
  }
}

fn envColor(dir: vec3<f32>) -> vec3<f32> {
  let u = state.envTheta + atan2(dir.z, dir.x) / M_TAU;
  let v = acos(dir.y) * INV_PI;
  let c = vec2<f32>(u, v);
  let rgbe = textureSampleLevel(envTex, envSampler, c, 0f);
  return rgbe.rgb * pow(2.0, rgbe.a * 255.0 - 128.0);
}

fn envPdf(dir: vec3<f32>) -> f32 {
  let dims = vec2<f32>(textureDimensions(envTex, 0));
  let u = (1f + state.envTheta + atan2(dir.z, dir.x) / M_TAU) % 1f;
  let v = acos(dir.y) * INV_PI;
  let c = vec2<i32>(vec2<f32>(u, v) * dims);
  let phi = v * M_PI;
  let sinPhi = sin(phi);
  return textureLoad(pdfTex, c, 0).r / sinPhi;
}

// Solid angle formulation; should reduce clumping near high latitudes
fn sampleEnv(ONB: mat3x3<f32>) -> Sample {
  let dims = vec2<f32>(textureDimensions(envTex, 0));
  let numBins = arrayLength(&envLuminance.bins);
  let idx = i32(hash() % numBins);
  let bin = envLuminance.bins[idx];
  let coordIdx = i32(hash() % u32(bin.h1 - bin.h0)) + bin.h0;
  let coord = envCoords.coords[coordIdx];
  let u = -state.envTheta +((0.5 + f32(coord.x)) / dims.x);
  let v = (0.5 + f32(coord.y)) / dims.y;
  let theta = u * M_TAU;
  let phi = v * M_PI;
  let sinPhi = sin(phi);
  let dir = vec3<f32>(cos(theta) * sinPhi, cos(phi), sin(theta) * sinPhi);
  let pdf = textureLoad(pdfTex, coord, 0).r / sinPhi;
  return Sample(dir * ONB, pdf);
}

fn lambertPdf(wi: vec3<f32>, n: vec3<f32>) -> f32 {
  return max(dot(wi, n), 0f) * INV_PI;
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
  return INV_PI * max(0f, sample.wi.z) / sample.pdf;
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
  return GGX_D(m, au, av) * GGX_G1(wo, m, au, av) / (4f * wo.z);
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
    r0 = r0 * r0;
    let tmp = (1f - cosTheta);
    let tmp2 = tmp * tmp;
    return r0 + (1f - r0) * tmp2 * tmp2 * tmp;
}

fn powerHeuristic(pdf0: f32, pdf1: f32) -> f32 {
  let pdf02 = pdf0 * pdf0;
  return (pdf02)/(pdf02 + pdf1 * pdf1);
}

fn createPrimaryRay(gid: vec2<f32>, dims: vec2<f32>) -> Ray {
  let uv = (2f * ((gid + vec2<f32>(rand(), rand())) / dims) - 1f) * vec2<f32>(dims.x / dims.y, -1f);
  let origin = state.eye.origin;
  let up = vec3<f32>(0f, 1f, 0f);
  let basisX: vec3<f32> = normalize(cross(state.eye.dir, up)) * state.fov;
  let basisY: vec3<f32> = normalize(cross(basisX, state.eye.dir)) * state.fov;
  let screen: vec3<f32> = uv.x * basisX + uv.y * basisY + state.eye.dir + state.eye.origin;
 return Ray(state.eye.origin, normalize(screen - state.eye.origin));
}

fn interpolateVertexAttribute(i: i32, bary: vec3<f32>) -> VertexAttribute {
  var attr: array<VertexAttribute, 3> = attrs.attributes[i];
  return VertexAttribute(
    mat3x3<f32>(attr[0].tangent, attr[1].tangent, attr[2].tangent) * bary,
    mat3x3<f32>(attr[0].bitangent, attr[1].bitangent, attr[2].bitangent) * bary,
    mat3x3<f32>(attr[0].normal, attr[1].normal, attr[2].normal) * bary,
    mat3x2<f32>(attr[0].uv, attr[1].uv, attr[2].uv) * bary,
  );
}

fn intersectScene(ray: Ray, anyHit: bool) -> Hit {
  var result = Hit(MAX_T, -1, 0f, vec3<f32>());
  var sptr: i32 = 0;
  stack[sptr] = -1;
  sptr = sptr + 1;
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
        stack[sptr] = deferred;
        sptr = sptr + 1;
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
    sptr = sptr - 1;
		idx = stack[sptr];
	}
	return result;
}

[[stage(compute), workgroup_size(16, 16, 1)]]
fn main(
  [[builtin(global_invocation_id)]] GID : vec3<u32>,
) {
  let dims = vec2<f32>(textureDimensions(inputTex, 0));
  let gid = vec2<f32>(GID.xy);
  if (any(gid >= dims)) {
    return;
  }
  seed = (GID.x * 1973u + GID.y * 9277u + u32(state.samples) * 26699u) | 1u;
  seed = hash();
  var ray = createPrimaryRay(gid, dims);
  var color = vec3<f32>(0f);
  var bounces: i32 = 0;
  var throughput = vec3<f32>(1f);
  var hit = intersectScene(ray, false);
  loop {
    if (hit.index == NO_HIT_IDX && bounces == 0) {
      color = color + throughput * envColor(ray.dir);
      break;
    }
    let tri = triangles.triangles[hit.index];
    var attr = interpolateVertexAttribute(hit.index, hit.bary);
    let matIdx = materials.indices[tri.matId];
    let mapNormal = (textureSampleLevel(atlasTex, atlasSampler, attr.uv, matIdx.normMap, 0f).xyz - vec3<f32>(0.5, 0.5, 0.0)) * vec3<f32>(2.0, 2.0, 1.0);
    let normal = normalize(mat3x3<f32>(attr.tangent, attr.bitangent, attr.normal) * mapNormal);
    // ONB used for computations using the mapped normal;
    let ONB = branchlessONB(normal);
    let metRough = textureSampleLevel(atlasTex, atlasSampler, attr.uv, matIdx.metRoughMap, 0f).xyz;
    let diffuse = textureSampleLevel(atlasTex, atlasSampler, attr.uv, matIdx.diffMap, 0f).xyz;
    let specular = mix(vec3<f32>(1f), diffuse, metRough.r);
    let origin = ray.origin + ray.dir * (hit.t - EPSILON * 40f);
    let a = metRough.g * metRough.g;
    let wo = -ray.dir * ONB;
    let m = sampleGGX(wo, a, a);
    let f = mix(schlick(max(dot(wo, m), 0f), 1.4), 1f, metRough.r);
    // Sample the environment light
    let envSample = sampleEnv(ONB);
    let envDir = ONB * envSample.wi;
    if (dot(envSample.wi, m) > 0f && envSample.wi.z > 0f) {
      let shadow = intersectScene(Ray(origin, envDir), true);
      if (shadow.index == NO_HIT_IDX) {
        let env = envColor(envDir);
        let lambertWeight = powerHeuristic(envSample.pdf, lambertPdf(envDir, normal));
        color = color + (1f - f) * throughput * diffuse * evalLambert(envSample) * env * lambertWeight;
        let h = normalize(wo + envSample.wi);
        let specWeight = powerHeuristic(envSample.pdf, specularPdf(wo, h, a, a));
        color = color +  f * throughput * specular * evalSpecular(wo, envSample, a, a) * env * specWeight;
      }
    }
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
    
    throughput = throughput * bsdf;
    let dir = ONB * bsdfSample.wi;
    ray = Ray(origin, dir);
    hit = intersectScene(ray, false);
    if (hit.index == NO_HIT_IDX) {
      let weight = powerHeuristic(bsdfSample.pdf, envPdf(dir));
      color = color + throughput * envColor(dir) * weight;
      break;
    }
    bounces = bounces + 1;
    if ( bounces > NUM_BOUNCES ) { break; }
  }
  // Load the previous color value.
  var acc: vec3<f32> = textureLoad(inputTex, vec2<i32>(GID.xy), 0).rgb;
  acc = vec3<f32>(max(color, vec3<f32>(0f)) + (acc * f32(state.samples)))/(f32(state.samples + 1));
  textureStore(outputTex, vec2<i32>(GID.xy), vec4<f32>(max(acc, vec3<f32>()), 1.0));
}