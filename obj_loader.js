import { Triangle } from './bvh.js'
import { Vec3 } from './vector.js'
import { ParseMaterials } from './mtl_loader.js'
import * as Utility from './utility.js'

class VertexDatabase {
  constructor() {
    this.nextIdx = 0;
    this.db = {};
  }

  getAttributeIndex(posIdx, uvIdx, normalIdx) {
    if (!this.db[posIdx]) {
      this.db[posIdx] = {};
    }
    if (!this.db[posIdx][uvIdx]) {
      this.db[posIdx][uvIdx] = {}
    }
    let idx = this.db[posIdx][uvIdx][normalIdx];
    if (idx) {
      return [idx, false];
    } else {
      this.db[posIdx][uvIdx][normalIdx] = this.nextIdx++;
      return [this.db[posIdx][uvIdx][normalIdx], true];
    }
  }

  // dumpDB() {
  //   for (const [posIdx, uvMap] of Object.entries()) {

  //   }
  // }
}

export async function parseMesh(objText, transforms, worldTransforms, basePath) {
  const lines = objText.split('\n');
  const vertices = [];
  const normals = [];
  //const vertNormals = [];
  const vertTangents = [];
  const vertBitangents = [];
  const uvs = [];
  let currentGroup = "PIKE_DEFAULT_GROUP";
  const groups = {};
  let materials = {};
  const vertDb = new VertexDatabase();
  const skips = new Set(transforms.skips);
  let urls = null;

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

  function averageNormals(normArray) {
    let total = [0, 0, 0];
    for (let i = 0; i < normArray.length; i++) {
      total = Vec3.add(total, normArray[i]);
    }
    return Vec3.scale(total, 1.0 / normArray.length);
  }

  function parseFace(indices) {
    let triList = [];
    for (let i = 0; i < indices.length - 2; i++) {
      triList.push([indices[0], indices[i + 1], indices[i + 2]])
    }
    triList.forEach(parseTriangle);
  }

  function calcTangents(triangle) {
    const tangents = [];
    const bitangents = [];

    if (!triangle.uvs[0]) {
      triangle.verts.forEach((vert, i) => {
        let dir = Vec3.normalize(vert);
        let u = Math.atan2(dir[2], dir[0]) / (Math.PI * 2);
        let v = Math.asin(-dir[1]) / Math.PI + 0.5;
        triangle.uvs[i] = [u, v];
      });
    }

    for (let i = 0; i < triangle.uvs.length; i++) {
      triangle.uvs[i] = Array.from(triangle.uvs[i]);
      triangle.uvs[i][0] += Number.EPSILON * (i + 1);
      triangle.uvs[i][1] += Number.EPSILON * (i + 1);
    }

    let deltaPos0 = Vec3.sub(triangle.verts[1], triangle.verts[0]);
    let deltaPos1 = Vec3.sub(triangle.verts[2], triangle.verts[0]);

    // if (triangle.uvs[0] === undefined || triangle.uvs[1] === undefined || triangle.uvs[2] == undefined) {
    //   const tangent = Vec3.normalize(Vec3.cross([0, 1, 0], triangle.normals[0]));
    //   const bitangent = Vec3.normalize(Vec3.cross(triangle.normals[0], tangent));
    //   tangents.push(tangent, tangent, tangent);
    //   bitangents.push(bitangent, bitangent, bitangent);
    //   return [tangents, bitangents];
    // }

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

  function parseTriangle(indices) {
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
    for (let i = 0; i < 3; i++) {
      const index = indices[i];
      const posIdx = index[0];
      const uvIdx = index[1];
      const normIdx = index[2];
      //console.log(posIdx, uvIdx, normIdx);
      //console.log(vertDb.getAttributeIndex(posIdx, uvIdx, normIdx));
    }



    let tri = new Triangle(
      [
        vertices[indices[0][0]],
        vertices[indices[1][0]],
        vertices[indices[2][0]],
      ],
      [
        uvs[indices[0][1]],
        uvs[indices[1][1]],
        uvs[indices[2][1]],
      ],
    );

    // Use mesh normals or calculate them
    if (transforms.normals === "mesh") {
      tri.normals = [
        Vec3.normalize(normals[indices[0][2]]),
        Vec3.normalize(normals[indices[1][2]]),
        Vec3.normalize(normals[indices[2][2]]),
      ];
    } else {
      const normal = getNormal(tri);
      tri.normals = [normal, normal, normal];
    }

    let [tangents, bitangents] = calcTangents(tri);
    tri.tangents = tangents;
    tri.bitangents = bitangents

    for (let j = 0; j < indices.length; j++) {
      if (!vertTangents[indices[j][0]]) {
        vertTangents[indices[j][0]] = [];
      }
      vertTangents[indices[j][0]].push(tangents[j % 3]);
      if (!vertBitangents[indices[j][0]]) {
        vertBitangents[indices[j][0]] = [];
      }
      vertBitangents[indices[j][0]].push(bitangents[j % 3]);
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
      parseFace(vals);
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
