import {
  BVHNodeStruct,
  VertexIndexStruct,
  VertexPositionStruct,
  WGSLPackedStructArray,
} from "../util/structs.js";
import { BVH } from '../bvh.js'
import { WideBVH } from "../wide_bvh.js";

export class TracePass {
  constructor(device, cameraPass, scene) {
    this.device = device;
    this.cameraPass = cameraPass;
    this.scene = scene;
    this.initBVHBuffer();
    this.initHitBuffer();
    this.initMissBuffer();
  }

  initBVHBindGroup() {
    this.bvhBindGroup = this.createBVHBindGroup(this.pipeline.getBindGroupLayout(0));
  }

  createBVHBindGroup(layout) {
    return this.device.createBindGroup({
      layout: layout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.bvhBuffer,
            size: this.bvhBuffer.size,
          },
        },
      ],
    });
  }

  initHitBuffer() {
    this.hitBuffer = this.device.createBuffer({
      // 80 byte aligned hit buffer
      size: this.cameraPass.batchSize * 20 * 4 * 2,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  initMissBuffer() {
    this.missBuffer = this.device.createBuffer({
      // 256 byte aligned ray count + 48 byte aligned ray buffer * (1 bounce ray + 1 shadow ray + 1 light ray) 
      size: this.cameraPass.batchSize * 12 * 4 * 3,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  initCollisionBindGroup() {
    this.collisionBindGroup = this.createCollisionBindGroup(this.pipeline.getBindGroupLayout(1), "trace");
  }

  createCollisionBindGroup(layout) {
    return this.device.createBindGroup({
      layout,
      label: `collision bind group`,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.triangleBuffer,
            size: this.triangleBuffer.size,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: this.vertexBuffer,
            size: this.vertexBuffer.size,
          },
        },
        {
          binding: 2,
          resource: {
            buffer: this.hitBuffer,
            size: this.hitBuffer.size,
          },
        },
        {
          binding: 3,
          resource: {
            buffer: this.missBuffer,
            size: this.missBuffer.size,
          },
        },
      ],
    });
  }

  createCollisionBindGroup2(layout) {
    return this.device.createBindGroup({
      layout,
      label: `collision bind group 2`,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.triangleBuffer,
            size: this.triangleBuffer.size,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: this.hitBuffer,
            size: this.hitBuffer.size,
          },
        },
      ],
    });
  }

  createCollisionBindGroup3(layout) {
    return this.device.createBindGroup({
      layout,
      label: `collision bind group 3`,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.missBuffer,
            size: this.missBuffer.size,
          },
        },
      ],
    });
  }

  createCollisionBindGroup4(layout) {
    return this.device.createBindGroup({
      layout,
      label: `collision bind group`,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.triangleBuffer,
            size: this.triangleBuffer.size,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: this.vertexBuffer,
            size: this.vertexBuffer.size,
          },
        },
        {
          binding: 2,
          resource: {
            buffer: this.missBuffer,
            size: this.missBuffer.size,
          },
        },
      ],
    });
  }

  maskTriIndex(index, numTris) {
    // Protect the sign bit?
    let mask = numTris << 24;
    return mask | index;
  }

  initRayStateBindGroup() {
    this.rayStateBindGroup = this.cameraPass.createBindGroup(this.pipeline.getBindGroupLayout(2));
  }

  static async create(device, cameraPass, scene) {
    const instance = new TracePass(device, cameraPass, scene);
    await instance.initPipeline();
    instance.initBVHBindGroup();
    instance.initCollisionBindGroup();
    instance.initRayStateBindGroup();
    return instance;
  }

  async initPipeline() {
    const wgsl = await fetch('render/shader/trace.wgsl').then(res => res.text());
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({
          code: wgsl,
        }),
        entryPoint: 'main',
      },
    });
  }

  getBVH() {
    return this.bvh;
  }

  initBVHBuffer() {
    let time = performance.now();
    console.log("Building BVH:", this.scene.indices.length, "triangles");
    time = performance.now();
    this.bvh = new WideBVH(this.scene);
    this.bvh = new BVH(this.scene);
    console.log("BVH built in ", (performance.now() - time) / 1000.0, " seconds.  Depth: ", this.bvh.depth);
    time = performance.now();
    let bvhArray = this.bvh.serializeTree();
    console.log("BVH serialized in", (performance.now() - time) / 1000.0, " seconds");
    const indexBuffer = new WGSLPackedStructArray(VertexIndexStruct, this.bvh.getNumLeafTris() * 3);
    const bvhBuffer = new WGSLPackedStructArray(BVHNodeStruct, bvhArray.length);
    const vertexBuffer = new WGSLPackedStructArray(VertexPositionStruct, this.scene.attributes.length);
    let triIndex = 0;
    for (let i = 0; i < bvhArray.length; i++) {
      let e = bvhArray[i];
      let node = e.node;
      bvhBuffer.push(new BVHNodeStruct({
        index: i,
        left: node.leaf ? -1 : e.left,
        right: node.leaf ? -1 : e.right,
        triangles: node.leaf ? this.maskTriIndex(triIndex, node.getleafSize()) : -1,
        boxMin: node.bounds.min,
        boxMax: node.bounds.max,
      }));
      if (node.leaf) {
        let tris = node.leafTriangles;
        triIndex += tris.length;
        for (let j = 0; j < tris.length; j++) {
          indexBuffer.push(new VertexIndexStruct(tris[j].desc));
        }
      }
    }

    for (let attribute of this.scene.attributes) {
      vertexBuffer.push(new VertexPositionStruct(attribute));
    }
    this.triangleBuffer = indexBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE);
    this.bvhBuffer = bvhBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE);
    this.vertexBuffer = vertexBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE);
  }

  generateCommands(commandEncoder) {
    const workGroupSize = 128;
    this.cameraPass.getRenderState().clearNumHitsAndMisses(commandEncoder);
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, this.bvhBindGroup);
    computePass.setBindGroup(1, this.collisionBindGroup);
    computePass.setBindGroup(2, this.rayStateBindGroup);
    const numWorkgroups = Math.ceil(2 * this.cameraPass.batchSize / (workGroupSize));
    computePass.dispatchWorkgroups(numWorkgroups);
    computePass.end();
  }
}