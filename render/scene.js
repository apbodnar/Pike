import { GLTFLoader } from "./util/gltf_loader.js";
// import { HDRLoader } from "./util/hdr_loader.js";
import { Vec3, Vec } from './util/vector.js'
import * as utils from './util/utility.js'
import { TexturePacker } from "./util/texture_packer.js";
import { BoundingBox } from "./primitives.js";

export class Scene {
  constructor() {
    this.desc = null;
    this.groups = null;
    this.materials = [];
    this.materialIds = {};
    this.texturePacker = null;
  }

  async load(uri) {
    this.desc = await (await fetch(uri)).json();

    this.groups = await Promise.all(this.desc.props.map((prop) => {
      return new GLTFLoader().load(prop.uri);
    }));
    this.texturePacker = new TexturePacker(this.desc.atlasRes ?? 1024);
    const images = [];
    this.groups.forEach((g, i) => {
      images.push(...g.images);
      g.transforms = this.desc.props[i].transforms;
      g.skipMaterials = new Set(this.desc.props[i].skipMaterials);
      g.skipMeshes = new Set(this.desc.props[i].skipMeshes);
    });
    //this.texturePacker.reserveImages(images);
    [this.indexCount, this.attributeCount] = this._counts();
    this.attributes = [];
    this.indices = [];
    this.lights = [];
    this._createBuffers();
    console.log('Num lights: ', this.lights.length);
    this.env = await utils.getImage(this.desc.environment);
    //this.env = await HDRLoader.load('environment/adams_place_bridge_2k.hdr')
    return this;
  }

  _createSceneMaterial(material) {
    const diffMap = material.hasBaseColorTexture() ?
      this.texturePacker.addTexture(material.getBaseColorTexture(), true) :
      this.texturePacker.addColor(material.getBaseColor());
    const diffMapTransform = [1, 1, 0, 0];
    const metRoughMap = material.hasMetallicRoughnessTexture() ?
      this.texturePacker.addTexture(material.getMetallicRoughnessTexture()) :
      this.texturePacker.addColor(material.getMetallicRoughness());
    const metRoughMapTransform = [1, 1, 0, 0];
    const normMap = material.hasNormalTexture() ?
      this.texturePacker.addTexture(material.getNormalTexture()) :
      this.texturePacker.addColor([0.5, 0.5, 1]);
    const normMapTransform = [1, 1, 0, 0];
    const emitMap = material.hasEmissiveTexture() ?
      this.texturePacker.addTexture(material.getEmissiveTexture(), true) :
      this.texturePacker.addColor(material.getEmissive());
    const emitMapTransform = [1, 1, 0, 0];
    return {
      diffMap,
      metRoughMap,
      normMap,
      emitMap,
      diffMapTransform,
      metRoughMapTransform,
      normMapTransform,
      emitMapTransform
    };
  }

  _applyRotations(vert, transforms) {
    transforms.rotate.forEach((r) => { vert = Vec3.rotateArbitrary(vert, r.axis, r.angle) });
    return vert;
  }

  _applyVectorTransforms(vert, transforms, rotationOnly = false) {
    let modelTransformed = Vec.add(Vec.scale(this._applyRotations(vert, transforms), rotationOnly ? 1 : transforms.scale), rotationOnly ? [0, 0, 0] : transforms.translate);
    return modelTransformed;
  }

  _counts() {
    let indexCount = 0;
    let attributeCount = 0;
    for (const group of this.groups) {
      for (const mesh of group.meshes) {
        for (const primitive of mesh.primitives) {
          attributeCount += primitive.attributeCount();
          indexCount += primitive.indexCount()
        }
      }
    }
    return [indexCount, attributeCount];
  }

  _computeBounds(primitive) {
    const indexCount = primitive.indexCount();
    const box = new BoundingBox();
    for (let i = 0; i < indexCount; i++) {
      box.addVertex();
    }
  }

  _quantizeVec3ToInt(vec) {
    const bytes = new Int8Array(4);
    // This is lazy/wrong
    bytes[0] = vec[0] * (vec[0] > 0 ? 127 : 128);
    bytes[1] = vec[1] * (vec[1] > 0 ? 127 : 128);
    bytes[2] = vec[2] * (vec[2] > 0 ? 127 : 128);
    return new Uint32Array(bytes.buffer);
  }

  _quantizeVec2ToInt(vec) {
    const shorts = new Int16Array(2);
    shorts[0] = vec[0] * (vec[0] > 0 ? 32767 : 32768);
    shorts[1] = vec[1] * (vec[1] > 0 ? 32767 : 32768);
    return new Uint32Array(shorts.buffer);
  }

  _createBuffers() {
    let offset = 0;
    for (const group of this.groups) {
      for (const mesh of group.meshes) {
        if (group.skipMeshes.has(mesh.desc.name)) {
          continue;
        }
        for (const primitive of mesh.primitives) {
          if (primitive.material?.desc?.name) {
            if (group.skipMaterials.has(primitive.material.desc.name)) {
              continue;
            }
          }
          if (primitive.material.hasEmissive()) {
            this.lights.push();
          }
          let matId = this.materialIds[primitive.material.id]
          if (matId === undefined) {
            matId = this.materials.length;
            this.materialIds[primitive.material.id] = matId;
            this.materials.push(this._createSceneMaterial(primitive.material));
          }
          const indexCount = primitive.indexCount();
          for (let i = 0; i < indexCount; i += 3) {
            this.indices.push({
              i0: offset + primitive.indexAt(i)[0],
              i1: offset + primitive.indexAt(i + 1)[0],
              i2: offset + primitive.indexAt(i + 2)[0],
              matId,
              debug: { mesh: mesh.desc }
            });
          }
          let box = null;
          if (primitive.material.hasEmissive()) {
            box = new BoundingBox();
          }
          const attrCount = primitive.attributeCount();
          offset += attrCount;
          for (let i = 0; i < attrCount; i++) {
            const pos = this._applyVectorTransforms(primitive.positionAt(i), group.transforms);
            const normal = this._applyVectorTransforms(primitive.normalAt(i), group.transforms, true);
            const signedTangent = primitive.tangentAt(i);
            const tangent = this._applyVectorTransforms(signedTangent.slice(0, 3), group.transforms, true);
            const bitangent = Vec3.normalize(Vec3.scale(Vec3.cross(primitive.normalAt(i), primitive.tangentAt(i)), signedTangent[3] || 1));
            this.attributes.push({
              pos,
              tangent: this._quantizeVec3ToInt(Vec3.normalize(tangent)),
              bitangent: this._quantizeVec3ToInt(bitangent),
              normal: this._quantizeVec3ToInt(Vec3.normalize(normal)),
              uv: this._quantizeVec2ToInt(primitive.uvAt(i)),
            });
            if (box) {
              box.addVertex(pos);
            }
          }
          if (box) {
            this.lights.push(box);
          }
        }
      }
    }
  }

  dumpGroup(i) {
    for (const mesh of this.groups[i].meshes) {
      for (const primitive of mesh.primitives) {
        console.log("indices:", primitive.indexCount(), "attributes:", primitive.attributeCount());
      }
    }
  }
}
