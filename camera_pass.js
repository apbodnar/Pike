import { CameraStateStuct, RenderStateStruct } from "./utils.js";


class RenderState {
  constructor(device) {
    this.device = device;
    this.samples = 0;
    this.envTheta = 0;

    this.renderStateBuffer = this.device.createBuffer({
      size: RenderStateStruct.getStride(),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
  }

  incrementSamples() {
    this.samples++;
  }

  resetSamples() {
    this.samples = 0;
  }

  getSamples() {
    return this.samples;
  }

  setEnvRotation(theta) {
    this.envTheta = theta;
  }

  getRenderStateBuffer() {
    return this.renderStateBuffer;
  }

  generateCommands(commandEncoder) {
    const renderState = new RenderStateStruct({
      samples: this.samples,
      envTheta: this.envTheta,
      numHits: 0,
      numRays: 0,
    });
    const renderStateSource = renderState.createWGPUBuffer(this.device, GPUBufferUsage.COPY_SRC);
    commandEncoder.copyBufferToBuffer(renderStateSource, 0, this.renderStateBuffer, 0, renderState.size);
  }

  clearNumHits(commandEncoder) {
    const renderState = new RenderStateStruct({
      samples: this.samples,
      envTheta: this.envTheta,
      numHits: 0,
      numRays: 0,
    });
    const renderStateSource = renderState.createWGPUBuffer(this.device, GPUBufferUsage.COPY_SRC);
    commandEncoder.copyBufferToBuffer(renderStateSource, 8, this.renderStateBuffer, 8, 4);
  }

  clearNumRays(commandEncoder) {
    const renderState = new RenderStateStruct({
      samples: this.samples,
      envTheta: this.envTheta,
      numHits: 0,
      numRays: 0,
    });
    const renderStateSource = renderState.createWGPUBuffer(this.device, GPUBufferUsage.COPY_SRC);
    commandEncoder.copyBufferToBuffer(renderStateSource, 12, this.renderStateBuffer, 12, 4);
  }
}

export class CameraPass {
  constructor(device, resolution) {
    this.device = device;
    this.resolution = resolution;
    this.cameraStateBuffer = this.device.createBuffer({
      size: CameraStateStuct.getStride(),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });
    this.renderState = new RenderState(this.device);
    this.cameraBuffer = this.createCameraRayBuffer();
    this.dimensionBuffer = this.createUniformBuffer();
    this.zeroBuffer = this.createZeroBuffer();
  }

  getRenderState() {
    return this.renderState;
  }

  createCameraRayBuffer() {
    const db = this.device.createBuffer({
      // 256 byte aligned ray count + 48 byte aligned ray buffer * (1 bounce ray + 1 shadow ray) 
      size: this.resolution[0] * this.resolution[1] * 12 * 4 * 2,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    return db;
  }

  createUniformBuffer() {
    const buffer = new Uint32Array(this.resolution)
    const db = this.device.createBuffer({
      size: buffer.byteLength,
      mappedAtCreation: true,
      usage: GPUBufferUsage.UNIFORM,
    });
    new Uint32Array(db.getMappedRange()).set(buffer);
    db.unmap();
    return db;
  }

  createZeroBuffer() {
    const buffer = new Uint32Array([0]);
    const db = this.device.createBuffer({
      size: buffer.byteLength,
      mappedAtCreation: true,
      usage: GPUBufferUsage.COPY_SRC,
    });
    new Uint32Array(db.getMappedRange()).set(buffer);
    db.unmap();
    return db;
  }

  setCameraState(state) {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer, 0);
    view.setUint16(0, this.resolution[1], true);
    view.setUint16(2, this.resolution[0], true);
    state.dimsMask = view.getUint32(0, true);
    this.cameraState = new CameraStateStuct(state);
  }

  getCameraBindGroup() {
    return this.bindGroup;
  }

  static async create(device, resolution) {
    const instance = new CameraPass(device, resolution);
    await instance.createCameraPipeline();
    instance.initBindGroup();
    instance.createCameraStateBindGroup();
    return instance;
  }

  async createCameraPipeline() {
    const cameraWGSL = await fetch('./shader/camera.wgsl').then(res => res.text());
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({
          code: cameraWGSL,
        }),
        entryPoint: 'main',
      },
    });
  }

  initBindGroup() {
    this.bindGroup = this.createBindGroup(this.pipeline.getBindGroupLayout(0));
  }

  createBindGroup(layout) {
    return this.device.createBindGroup({
      layout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.renderState.getRenderStateBuffer(),
          },
        },
        {
          binding: 1,
          resource: {
            buffer: this.cameraBuffer,
            size: this.cameraBuffer.size,
          },
        },
      ],
    });
  }

  createCameraStateBindGroup() {
    this.cameraStateBindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(1),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.cameraStateBuffer,
          },
        },
      ],
    });
  }

  generateCommands(commandEncoder) {
    const workGroupSize = 128;
    const cameraStateSource = this.cameraState.createWGPUBuffer(this.device, GPUBufferUsage.COPY_SRC);
    commandEncoder.copyBufferToBuffer(cameraStateSource, 0, this.cameraStateBuffer, 0, this.cameraState.size);
    //this.renderState.clearNumRays(commandEncoder);
    //commandEncoder.copyBufferToBuffer(this.zeroBuffer, 0, this.cameraBuffer, 0, 4);
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, this.bindGroup);
    computePass.setBindGroup(1, this.cameraStateBindGroup);
    computePass.dispatchWorkgroups(
      Math.ceil(this.resolution[0] / workGroupSize),
      Math.ceil(this.resolution[1] / 1),
    );
    computePass.end();
  }
}