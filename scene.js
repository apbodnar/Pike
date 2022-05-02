import { GLTFLoader } from "./gltf_loader.js";
import { Vec3, Vec } from './vector.js'
import * as utils from './utility.js'
import { TexturePacker } from "./texture_packer.js";

export class Scene {
  constructor() {
    this.desc = null;
    this.groups = null;
    this.materials = [];
    this.materialIds = {};
    this.texturePacker = new TexturePacker(2048);
  }
  
  async load(uri) {
    this.desc = await (await fetch(uri)).json();
    this.groups = await Promise.all(this.desc.props.map((prop) => {
      return new GLTFLoader().load(prop.uri);
    }))
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
    this._createBuffers();
    this.env = await utils.getImage(this.desc.environment);
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
    const emitMapTransform = [1, 1, 0, 0];
    return {
      diffMap,
      metRoughMap,
      normMap,
      emitMap: 0,
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
q
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
          const attrCount = primitive.attributeCount();
          offset += attrCount;
          for (let i = 0; i < attrCount; i++) {
            const normal = this._applyVectorTransforms(primitive.normalAt(i), group.transforms, true);
            const signedTangent = primitive.tangentAt(i);
            const tangent = this._applyVectorTransforms(signedTangent.slice(0, 3), group.transforms, true);
            const bitangent = Vec3.normalize(Vec3.scale(Vec3.cross(primitive.normalAt(i), primitive.tangentAt(i)), signedTangent[3] || 1));
            this.attributes.push({
              pos: this._applyVectorTransforms(primitive.positionAt(i), group.transforms),
              tangent: Vec3.normalize(tangent),
              normal: Vec3.normalize(normal),
              uv: primitive.uvAt(i),
              bitangent: bitangent,
            });
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
