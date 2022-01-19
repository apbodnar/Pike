import { Triangle } from './bvh.js'
import { Vec3 } from './vector.js'
import { ParseMaterials } from './mtl_loader.js'
import * as Utility from './utility.js'

class VertexDatabase {
  constructor(offset) {
    this.nextIdx = offset;
    this.db = {};
  }

  getAttributeIndex(posIdx, uvIdx, normalIdx) {
    if (this.db[posIdx] === undefined) {
      this.db[posIdx] = {};
    }
    if (this.db[posIdx][uvIdx] === undefined) {
      this.db[posIdx][uvIdx] = {}
    }
    let idx = this.db[posIdx][uvIdx][normalIdx];
    if (idx !== undefined) {
      return [idx, false];
    } else {
      const next = this.nextIdx++
      this.db[posIdx][uvIdx][normalIdx] = next;
      return [next, true];
    }
  }

  // dumpDB() {
  //   for (const [posIdx, uvMap] of Object.entries()) {

  //   }
  // }
}

export async function parseMesh(objText, transforms, worldTransforms, basePath, attributes) {
  const lines = objText.split('\n');
  const vertices = [];
  const normals = [];
  const faces = [];
  const uvs = [];
  const start = attributes.length;
  let currentGroup = "PIKE_DEFAULT_GROUP";
  const groups = {};
  let materials = {};
  const vertDb = new VertexDatabase(start);
  const skips = new Set(transforms.skips);
  let urls = null;
  let hasUvs = false;
  let hasNormals = false;

  function applyRotations(vert) {
    transforms.rotate.forEach((r) => { vert = Vec3.rotateArbitrary(vert, r.axis, r.angle) });
    return vert;
  }

  function applyVectorTransforms(vert, rotationOnly = false) {
    let modelTransformed = Vec3.add(Vec3.scale(applyRotations(vert), rotationOnly ? 1 : transforms.scale), rotationOnly ? [0, 0, 0] : transforms.translate);
    if (worldTransforms) {
      worldTransforms.forEach(function (transform) {
        if (transform.rotate) {
          transform.rotate.forEach(function (rotation) {
            modelTransformed = Vec3.rotateArbitrary(modelTransformed, rotation.axis, rotation.angle);
          });
        } else if (transform.translate && !rotationOnly) {
          modelTransformed = Vec3.add(modelTransformed, transform.translate);
        }
      });
    }
    return modelTransformed;
  }

  function getNormal(tri) {
    let e1 = Vec3.sub(tri.verts[1], tri.verts[0]);
    let e2 = Vec3.sub(tri.verts[2], tri.verts[0]);
    return Vec3.normalize(Vec3.cross(e1, e2));
  }


  function averageVectors(vectors) {
    let total = [0, 0, 0];
    for (let i = 0; i < vectors.length; i++) {
      total = Vec3.add(total, vectors[i]);
    }
    return Vec3.scale(total, 1.0 / vectors.length);
  }

  function parseFace(indices, currentGroup) {
    hasUvs = indices[0][1] !== undefined || hasUvs;
    hasNormals = indices[0][2] !== undefined || hasNormals;
    for (let i = 0; i < indices.length - 2; i++) {
      faces.push({ indices: [indices[0], indices[i + 1], indices[i + 2]], group: currentGroup })
    }
  }

  function calcTangents(triangle, guess) {
    const tangents = [];
    const bitangents = [];

    if (guess) {
      debugger;
      for (let i = 0; i < 3; i++) {
        const up = Math.abs(Vec3.dot(triangle.normals[i], [0, 1, 0])) > 0.99;
        let preBitangent = up ? [1,0,0] : Vec3.normalize(Vec3.cross([0, 1, 0], triangle.normals[i]));
        const tangent = Vec3.normalize(Vec3.cross(triangle.normals[i], preBitangent))
        tangents.push(tangent);
        bitangents.push(Vec3.normalize(Vec3.cross(tangent, triangle.normals[i])));
      }
      return [tangents, bitangents];
    }

    for (let i = 0; i < triangle.uvs.length; i++) {
      triangle.uvs[i] = Array.from(triangle.uvs[i]);
      triangle.uvs[i][0] += Number.EPSILON * (i + 1);
      triangle.uvs[i][1] += Number.EPSILON * (i + 1);
    }

    let deltaPos0 = Vec3.sub(triangle.verts[1], triangle.verts[0]);
    let deltaPos1 = Vec3.sub(triangle.verts[2], triangle.verts[0]);

    let deltaUv0 = Vec3.sub(triangle.uvs[1], triangle.uvs[0]);
    let deltaUv1 = Vec3.sub(triangle.uvs[2], triangle.uvs[0]);

    let r = 1.0 / ((deltaUv0[0] * deltaUv1[1]) - (deltaUv0[1] * deltaUv1[0]));
    let preTangent = Vec3.normalize(Vec3.scale(Vec3.sub(Vec3.scale(deltaPos0, deltaUv1[1]), Vec3.scale(deltaPos1, deltaUv0[1])), r));
    //let bt = Vec3.normalize(Vec3.scale(Vec3.sub(Vec3.scale(deltaPos1, deltaUv0[0]), Vec3.scale(deltaPos0, deltaUv1[0])), r));

    for (let i = 0; i < 3; i++) {
      let normal = triangle.normals[i];
      let preBitangent = Vec3.normalize(Vec3.cross(normal, preTangent));
      let tangent = Vec3.normalize(Vec3.cross(preBitangent, normal));
      let bitangent = Vec3.normalize(Vec3.cross(normal, tangent));

      if (isNaN(Vec3.dot(tangent, bitangent))) {
        let t = Vec3.cross(triangle.normals[i], [0, 1, 0]);
        tangents.push(t);
        bitangents.push(Vec3.cross(t, triangle.normals[i]));
      }
      tangents.push(tangent);
      bitangents.push(bitangent);
    }
    return [tangents, bitangents];
  }

  function parseTriangle(indexGroup) {
    // for (let i = 0; i < indices.length; i++) {
    //   for (let j = 0; j < indices[i].length; j++) {
    //     switch (j) {
    //       case 0:
    //         indices[i][j] = indices[i][j] < 1 ? vertices.length + indices[i][j] + 1 : indices[i][j];
    //         break;
    //       case 1:
    //         break;
    //       case 2:
    //         indices[i][j] = indices[i][j] < 1 ? normals.length + indices[i][j] + 1 : indices[i][j];
    //     }
    //   }
    // }
    const indices = indexGroup.indices;
    const currentGroup = indexGroup.group;
    const attributeIndices = new Array(3);
    let guess = false;
    for (let i = 0; i < 3; i++) {
      const index = indices[i];
      const posIdx = index[0];
      const uvIdx = index[1] ?? -1;
      const normIdx = index[2] ?? -1;
      guess = index[1] === undefined || guess;
      const [idx, isNew] = vertDb.getAttributeIndex(posIdx, uvIdx, normIdx);
      if (isNew) {
        attributes.push({
          position: vertices[posIdx],
          uv: uvs[uvIdx] ?? [0.5, 0.5],
          normal: Vec3.normalize(normals[normIdx]),
          tangent: [],
          bitangent: [],
        });
      }
      attributeIndices[i] = idx;
    }

    let tri = new Triangle(
      attributeIndices,
      attributes
    );

    // let n;
    // Use mesh normals or calculate them
    // if (transforms.normals === "mesh") {
    //   n = [
    //     Vec3.normalize(normals[indices[0][2]]),
    //     Vec3.normalize(normals[indices[1][2]]),
    //     Vec3.normalize(normals[indices[2][2]]),
    //   ];
    // } else {
    //   const normal = getNormal(tri);
    //   n = [normal, normal, normal];
    // }

    // for (let i=0; i < attributeIndices.length; i++) {
    //   const attrIdx = attributeIndices[i];
    //   const attribute = attributes[attrIdx];
    //   attribute.normal.push(n[i % 3]);
    // }

    let [tangents, bitangents] = calcTangents(tri, guess);

    for (let i = 0; i < attributeIndices.length; i++) {
      const attrIdx = attributeIndices[i];
      const attribute = attributes[attrIdx];
      attribute.tangent.push(tangents[i % 3]);
      attribute.bitangent.push(bitangents[i % 3]);
    }

    groups[currentGroup].triangles.push(tri);
  }

  for (let i = 0; i < lines.length; i++) {
    let array = lines[i].trim().split(/[ ]+/);
    let vals = array.slice(1, array.length);

    if (array[0] === 'v') {
      const vertex = applyVectorTransforms(vals.splice(0, 3).map(parseFloat));
      vertices.push(vertex);
    } else if (array[0] === 'f' && !skips.has(currentGroup)) {
      if (!groups[currentGroup]) {
        groups[currentGroup] = { triangles: [], material: materials[currentGroup] || {} };
      }
      // OBJ starts counting at 1
      vals = vals.map(function (s) { return s.split('/').map((e) => { return parseFloat(e) - 1 }) });
      parseFace(vals, currentGroup);
    } else if (array[0] === 'vt') {
      let uv = vals.map(function (coord) { return parseFloat(coord) || 0 });
      // Don't support 3D textures
      let tuv = uv.splice(0, 2);
      uvs.push(tuv);
    } else if (array[0] === 'vn') {
      const normal = applyVectorTransforms(vals.map(parseFloat), true);
      normals.push(normal)
    } else if (array[0] === 'usemtl') {
      currentGroup = array.splice(1, Infinity).join(' ');
    } else if (array[0] === 'mtllib') {
      let mtlUrl = basePath + '/' + array.splice(1, Infinity).join(' ');
      let text = await Utility.getText(mtlUrl);
      let parsedMats = ParseMaterials(text, basePath);
      materials = parsedMats.materials;
      urls = parsedMats.urls;
    }
  }

  faces.forEach(parseTriangle);
  //debugger;
  attributes.slice(start).forEach(a => {
    a.tangent = averageVectors(a.tangent);
    a.bitangent = averageVectors(a.bitangent);
  })

  // Object.entries(groups).forEach((pair) => {
  //   let group = pair[1];
  //   if (transforms.normals === "smooth") {
  //     for (let i = 0; i < group.triangles.length; i++) {
  //       for (let j = 0; j < 3; j++) {
  //         group.triangles[i].normals[j] = averageNormals(vertNormals[group.triangles[i].indices[j]]);
  //       }
  //     }
  //   }
  // });

  //debugger;
  Object.entries(groups).forEach((pair) => {
    let key = pair[0];
    let group = pair[1];
    console.log(transforms.path, key, group.triangles.length, "triangles");
  });
  return Promise.resolve({ groups: groups, urls: urls });
}
