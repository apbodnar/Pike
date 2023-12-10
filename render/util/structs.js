export class WGSLPackedStruct {
  constructor(args) {
    const desc = this.constructor.desc;
    for (const member of desc) {
      const value = args[member.name];
      if (value === undefined) {
        throw new Error("Unexpected member value for: " + member.name);
      }
      const v = Array.isArray(value) ? value : [value];
      if (v.length !== member.count) {
        throw new Error("Unexpected member length:" + member.name + " " + value);
      }
      member.value = value;
    }
    this.members = desc;
  }

  static get desc() { throw new Error("unimplemented"); }

  toArrayBuffer() {
    const buffer = new ArrayBuffer(this.constructor.getStride());
    const view = new DataView(buffer);
    let offset = 0;
    for (const member of this.members) {
      let nextMemberOffset = offset + this.constructor.getMemberAlignment(member);
      for (let i = 0; i < member.count; i++) {
        const v = Array.isArray(member.value) ? member.value : [member.value];
        switch (member.type) {
          case Int32Array:
            view.setInt32(offset, v[i], true);
            break;
          case Float32Array:
            view.setFloat32(offset, v[i], true);
            break;
          case Uint32Array:
            view.setUint32(offset, v[i], true);
            break;
          default:
            throw new Error('Unsupported member type');
        }
        offset += member.type.BYTES_PER_ELEMENT;
      }
      offset = nextMemberOffset;
    }
    return buffer;
  }

  static getStride() {
    const desc = this.desc;
    let structAlignment = Math.max(...desc.map(m => this.getMemberAlignment(m)));
    let offset = 0;
    for (const member of desc) {
      offset += this.getMemberAlignment(member);
    }
    const unaligned = offset % structAlignment;
    if (offset % structAlignment !== 0) {
      offset += structAlignment - unaligned;
    }
    return offset;
  }

  static getMemberAlignment(m) {
    return this._nextPOT(this._getMemberSize(m))
  }

  static getMemberAlignments() {
    return this.desc.map((m) => this.getMemberAlignment(m));
  }

  static _getMemberSize(m) {
    return m.type.BYTES_PER_ELEMENT * m.count;
  }

  static _nextPOT(v) {
    return Math.pow(2, Math.ceil(Math.log2(v)));
  }

  get size() {
    return this.constructor.getStride();
  }

  createWGPUBuffer(device, usage) {
    const buffer = this.toArrayBuffer();
    return arrayBufferToWGPUBuffer(buffer, device, usage);
  }
}

export function arrayBufferToWGPUBuffer(buffer, device, usage) {
  const db = device.createBuffer({
    size: buffer.byteLength,
    mappedAtCreation: true,
    usage,
  });
  new Uint8Array(db.getMappedRange()).set(new Uint8Array(buffer));
  db.unmap();
  return db;
}

export class WGSLPackedStructArray {
  constructor(type, count) {
    this.memberAlignments = type.getMemberAlignments();
    this.stride = type.getStride();
    this.offset = 0;
    this.buf = new ArrayBuffer(this.stride * count);
    this.dataView = new DataView(this.buf);
    this.view = new Uint8Array(this.buf);
  }

  _setArrayBuffer(struct) {
    let offset = this.offset;
    for (let i=0; i< struct.members.length; i++) {
      const member = struct.members[i];
      let nextMemberOffset = offset + this.memberAlignments[i];
      for (let i = 0; i < member.count; i++) {
        const v = Array.isArray(member.value) ? member.value : [member.value];
        switch (member.type) {
          case Int32Array:
            this.dataView.setInt32(offset, v[i], true);
            break;
          case Float32Array:
            this.dataView.setFloat32(offset, v[i], true);
            break;
          case Uint32Array:
            this.dataView.setUint32(offset, v[i], true);
            break;
          default:
            throw new Error('Unsupported member type');
        }
        offset += member.type.BYTES_PER_ELEMENT;
      }
      offset = nextMemberOffset;
    }
  }

  push(struct) {
    this._setArrayBuffer(struct);
    this.offset += this.stride;
  }

  arrayBuffer() {
    return this.buf;
  }

  get size() {
    return this.view.length;
  }

  createWGPUBuffer(device, usage) {
    const db = device.createBuffer({
      size: this.size,
      mappedAtCreation: true,
      usage,
    });
    new Uint8Array(db.getMappedRange()).set(this.view);
    db.unmap();
    return db;
  }
}

export class BVHNodeStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "index", type: Int32Array, count: 1 },
      { name: "left", type: Int32Array, count: 1 },
      { name: "right", type: Int32Array, count: 1 },
      { name: "triangles", type: Int32Array, count: 1 },
      { name: "boxMin", type: Float32Array, count: 3 },
      { name: "boxMax", type: Float32Array, count: 3 },
    ];
  }
}

export class LightBoxStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "boxMin", type: Float32Array, count: 3 },
      { name: "boxMax", type: Float32Array, count: 3 },
    ];
  }
}

export class TriangleStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "v0", type: Float32Array, count: 3 },
      { name: "v1", type: Float32Array, count: 3 },
      { name: "v2", type: Float32Array, count: 3 },
      { name: "matId", type: Int32Array, count: 1 },
    ];
  }
}

export class VertexPositionStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "pos", type: Float32Array, count: 3 },
    ];
  }
}

export class VertexIndexStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "i0", type: Int32Array, count: 1 },
      { name: "i1", type: Int32Array, count: 1 },
      { name: "i2", type: Int32Array, count: 1 },
      { name: "matId", type: Int32Array, count: 1 },
    ];
  }
}

export class VertexAttributeStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "tangent", type: Uint32Array, count: 1 }, // 4 x 8 bit quantization
      { name: "bitangent", type: Uint32Array, count: 1 },
      { name: "normal", type: Uint32Array, count: 1 },
      { name: "uv", type: Uint32Array, count: 1 },
    ];
  }
}

export class RenderStateStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "samples", type: Int32Array, count: 1 },
      { name: "envTheta", type: Float32Array, count: 1},
      { name: "numHits", type: Uint32Array, count: 1 },
      { name: "numMisses", type: Uint32Array, count: 1 },
      { name: "numRays", type: Uint32Array, count: 1 },
    ];
  }
}

export class CameraStateStuct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "pos", type: Float32Array, count: 3 },
      { name: "dir", type: Float32Array, count: 3 },
      { name: "dimsMask", type: Uint32Array, count: 1},
      { name: "fov", type: Float32Array, count: 1 },
      { name: "focalDepth", type: Float32Array, count: 1 },
      { name: "apertureSize", type: Float32Array, count: 1},
      { name: "distortion", type: Float32Array, count: 1},
      { name: "bokeh", type: Float32Array, count: 1},
      { name: "invocationOffset", type: Uint32Array, count: 1},
    ];
  }
}

export class MaterialIndexStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "diffMap", type: Int32Array, count: 1 },
      { name: "metRoughMap", type: Int32Array, count: 1 },
      { name: "normMap", type: Int32Array, count: 1 },
      { name: "emitMap", type: Int32Array, count: 1 },
      { name: "diffMapTransform", type: Float32Array, count: 4 },
      { name: "metRoughMapTransform", type: Float32Array, count: 4 },
      { name: "normMapTransform", type: Float32Array, count: 4 },
      { name: "emitMapTransform", type: Float32Array, count: 4 },
    ];
  }
}

export class RadianceBinStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "x0", type: Float32Array, count: 1 },
      { name: "y0", type: Float32Array, count: 1 },
      { name: "x1", type: Float32Array, count: 1 },
      { name: "y1", type: Float32Array, count: 1 },
    ];
  }
}

export class LuminanceBinStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "h0", type: Int32Array, count: 1 },
      { name: "h1", type: Int32Array, count: 1 },
    ];
  }
}

export class LuminanceCoordStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "x", type: Int32Array, count: 1 },
      { name: "y", type: Int32Array, count: 1 },
    ];
  }
}

export class PostprocessParamsStruct extends WGSLPackedStruct {
  static get desc() {
    return [
      { name: "exposure", type: Float32Array, count: 1 },
      { name: "saturation", type: Float32Array, count: 1 },
    ];
  }
}
