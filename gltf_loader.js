/**
 * A small, mostly useless GLTF loader.
 */

import * as utils from './utility.js'
import { Vec, Vec3 } from './vector.js';

const INT16 = 5122;
const UINT16 = 5123;
const UINT32 = 5125;
const FLOAT32 = 5126;

const STRIDE = {
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const TRIANGLES = 4;
const ELEMENT_COUNT = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4.
}

export class GLTFLoader {
  constructor() {
    this.manifest = null;
    this.buffers = null;
    this.bufferViews = null;
    this.accessors = null;
    this.images = null;
    this.meshes = [];
  }

  async load(url) {
    const split = url.split('/');
    split.pop();
    const pwd = split.join('/') + '/';
    this.manifest = await (await fetch(url)).json();
    // Only support GLTF 2.0
    console.assert(this.manifest.asset.version === "2.0", "Wrong GLTF version");
    // Fetch the blobs
    this.buffers = await Promise.all(
      this.manifest.buffers.map(async (b) => { return (await fetch(pwd + b.uri)).arrayBuffer(); })
    );
    // Init buffer views;
    this.bufferViews = this.manifest.bufferViews.map((v) => {
      const buffer = this.buffers[v.buffer];
      return new DataView(buffer, v.byteOffset, v.byteLength);
    });
    // Fetch the images
    this.images = this.manifest.images ? await Promise.all(
      this.manifest.images.map((i) => { return utils.getImage(pwd + i.uri); })
    ) : [];
    const scene = this.manifest.scenes[this.manifest.scene];
    for (const nodeIdx of scene.nodes) {
      const root = this.nodeDescAt(nodeIdx);
      this._constructMeshes(root, null);
    }
    return new GLTF(this.meshes, this.manifest.asset);
  }

  accessorDescAt(i) {
    return this.manifest.accessors[i];
  }

  nodeDescAt(i) {
    return this.manifest.nodes[i];
  }

  meshDescAt(i) {
    return this.manifest.meshes[i];
  }

  bufferViewDescAt(i) {
    return this.manifest.bufferViews[i];
  }

  materialDescAt(i) {
    return this.manifest.materials[i];
  }

  _constructMeshes(node, parentMatrix) {
    const m = this._getMatrixForNode(node, parentMatrix);
    if ('mesh' in node) {
      const meshDesc = this.meshDescAt(node.mesh);
      this.meshes.push(new GLTFMesh(meshDesc, m, this));
    }
    if (node.children) {
      for (const childIdx of node.children) {
        const child = this.nodeDescAt(childIdx);
        this._constructMeshes(child, m);
      }
    }
  }

  _getMatrixForNode(node, parentMatrix) {
    let m = node.matrix;
    if (!m) {
      const t = node.translation ?? [0, 0, 0];
      const r = node.rotation ?? [0, 0, 0, 1];
      const s = node.scale ?? [1, 1, 1];
      m = Vec.composeTRSMatrix(t,r,s);
    }

    if (parentMatrix) {
      return Vec.matMultiply(parentMatrix, m);
    } else {
      return m;
    }
  }

  getMeshes() {
    return this.meshes;
  }
}

class GLTFMaterial {
  constructor(desc, loader) {
    this.id = Math.round(Math.random() * 10000);
    this.desc = desc;
    this.loader = loader;
  }

  usesMetallicRoughness() {
    return !!this.desc.pbrMetallicRoughness;
  }

  getBaseColor() {
    return this.desc.pbrMetallicRoughness?.baseColorFactor?.slice(0, 3) ?? [0.8, 0.8, 0.8];
  }

  getMetallicRoughness() {
    return [0, this.desc.pbrMetallicRoughness?.roughnessFactor ?? 0.3, this.desc.pbrMetallicRoughness?.metallicFactor ?? 0];
  }

  hasNormalTexture() {
    return !!this.desc.normalTexture;
  }

  getNormalTexture() {
    return this.loader.images[this.desc.normalTexture.index];
  }

  hasMetallicRoughnessTexture() {
    return !!this.desc.pbrMetallicRoughness?.metallicRoughnessTexture;
  }

  getMetallicRoughnessTexture() {
    const idx = this.desc.pbrMetallicRoughness.metallicRoughnessTexture.index;
    return this.loader.images[idx];
  }

  hasBaseColorTexture() {
    return !!this.desc.pbrMetallicRoughness?.baseColorTexture;
  }

  getBaseColorTexture() {
    const idx = this.desc.pbrMetallicRoughness.baseColorTexture.index;
    return this.loader.images[idx];
  }

  usesSpecularGlossiness() {
    return !!this.desc.extensions?.KHR_materials_pbrSpecularGlossiness;
  }
}

class GLTFPrimitive {
  constructor(desc, mesh) {
    this.desc = desc;
    this.mesh = mesh;
    this.loader = this.mesh.loader;
    this.material = new GLTFMaterial(this.loader.materialDescAt(this.desc.material), this.loader);
    if (this.desc.attributes.NORMAL === undefined) {
      this.computedNormals = new Array(this.indexCount()).fill({ n: [0, 0, 0], count: 0 });
      this._computeNormals();
    }
    console.assert(this.desc.mode === TRIANGLES);
  }

  indexCount() {
    const accessorIdx = this.desc.indices;
    const accessorDesc = this.loader.accessorDescAt(accessorIdx);
    return accessorDesc.count;
  }

  indexAt(i) {
    const accessorIdx = this.desc.indices;
    return this._getAccessorValueAt(accessorIdx, i);
  }

  attributeCount() {
    const accessorIdx = this.desc.attributes.POSITION;
    const accessorDesc = this.loader.accessorDescAt(accessorIdx);
    return accessorDesc.count;
  }

  positionAt(i) {
    const accessorIdx = this.desc.attributes.POSITION;
    const pos = this._getAccessorValueAt(accessorIdx, i);
    return Vec.matVecMultiply(this.mesh.matrix, pos);
  }

  uvAt(i) {
    const accessorIdx = this.desc.attributes.TEXCOORD_0;
    if (accessorIdx !== undefined) {
      return this._getAccessorValueAt(accessorIdx, i);
    } else {
      return [0.5, 0.5];
    }
  }

  normalAt(i) {
    const accessorIdx = this.desc.attributes.NORMAL;
    const norm = accessorIdx !== undefined ? this._getAccessorValueAt(accessorIdx, i) : Vec3.normalize(this.computedNormals[i].n);
    const mat = Vec.transposeMatrix(Vec.invertMatrix(this.mesh.matrix));
    return Vec.matVecMultiply(mat, norm);
    // return norm;
  }

  tangentAt(i) {
    const accessorIdx = this.desc.attributes.TANGENT;
    let tan;
    if (accessorIdx !== undefined) {
      tan = this._getAccessorValueAt(accessorIdx, i);
    } else {
      const normal = this.normalAt(i);
      tan = Math.abs(normal[2]) < 0.999 ? Vec3.normalize(Vec3.cross(normal, [0, 1, 0])) : [1, 0, 0];
    }
    const mat = Vec.transposeMatrix(Vec.invertMatrix(this.mesh.matrix));
    return Vec.matVecMultiply(mat, tan).slice(0, 3);
  }

  _addComputedNormal(normal, i) {
    const current = Vec3.scale(this.computedNormals[i].n, count);
    this.computedNormals[i].count++;
    const n = Vec3.scale(Vec3.sum(current, normal), 1 / this.computedNormals[i].count);
    this.computedNormals[i].n = n;
  }

  _computeNormals() {
    for (let i = 0; i < this.indexCount(); i += 3) {
      const p0 = positionAt(i);
      const p1 = positionAt(i + 1);
      const p2 = positionAt(i + 2);
      const e0 = Vec3.sub(p1, p0);
      const e1 = Vec3.sub(p2, p0);
      const n = Vec3.cross(e0, e1);
      this._addComputedNormal(n, i);
      this._addComputedNormal(n, i + 1);
      this._addComputedNormal(n, i + 2);
    }
  }

  _getAccessorValueAt(accessorIdx, i) {
    const accessorDesc = this.loader.accessorDescAt(accessorIdx);
    const offsetBytes = accessorDesc.byteOffset ?? 0;
    const bufferViewDesc = this.loader.accessorDescAt(accessorDesc.bufferView);
    const stride = bufferViewDesc.byteStride ?? this._getStride(accessorDesc);
    const view = this.loader.bufferViews[accessorDesc.bufferView];
    const start = i * stride + offsetBytes;
    return this._getTypedValue(view, start, accessorDesc.componentType, accessorDesc.type);
  }

  _getStride(accessorDesc) {
    return STRIDE[accessorDesc.componentType] * ELEMENT_COUNT[accessorDesc.type];
  }

  _getTypedValue(view, start, compType, elementType) {
    const elementCount = ELEMENT_COUNT[elementType];
    const vec = new Array(elementCount);
    for (let i = 0; i < elementCount; i++) {
      switch (compType) {
        case INT16: {
          vec[i] = view.getInt16(start + i * 2, true);
          break;
        }
        case UINT16: {
          vec[i] = view.getUint16(start + i * 2, true);
          break;
        }
        case UINT32: {
          vec[i] = view.getUint32(start + i * 4, true);
          break;
        }
        case FLOAT32: {
          vec[i] = view.getFloat32(start + i * 4, true);
          break;
        }
        default: {
          throw new Error("Unsupported element type");
        }
      }
    }
    return vec;
  }
}

class GLTFMesh {
  constructor(desc, matrix, loader) {
    this.desc = desc;
    this.matrix = matrix;
    this.loader = loader;
    this.primitives = this.desc.primitives.map((p) => {
      return new GLTFPrimitive(p, this);
    });
  }

  getPrimitives() {
    return this.primitives;
  }
}

export class GLTF {
  constructor(meshes, asset) {
    this.meshes = meshes;
    this.asset = asset;
  }
}