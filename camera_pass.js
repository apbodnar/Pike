import { CameraStateStuct, RenderStateStruct } from "./utils.js";


class RenderState {
  constructor(device, resolution) {
    this.device = device;
    this.samples = 0;
    this.envTheta = 0;
    this.resolution = resolution;
    this.renderStateBuffer = this.device.createBuffer({
      size: RenderStateStruct.getStride() + resolution[0] * resolution[1] * 4 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    this.debugBuffer = this.device.createBuffer({
      size: RenderStateStruct.getStride(),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
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


  async printDebugInfo() {
    let commandEncoder = this.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer( this.renderStateBuffer, 0, this.debugBuffer, 0, 16);
    this.device.queue.submit([commandEncoder.finish()]);
    await this.debugBuffer.mapAsync( GPUMapMode.READ);
    await this.device.queue.onSubmittedWorkDone();
    const b = new Uint32Array(this.debugBuffer.getMappedRange());
    console.log(b);
    this.debugBuffer.unmap();
  }

  generateCommands(commandEncoder) {
    this.clearColorBuffer(commandEncoder);
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
    commandEncoder.clearBuffer(this.renderStateBuffer, 8, 4);
  }

  clearNumRays(commandEncoder) {
    commandEncoder.clearBuffer(this.renderStateBuffer, 12, 4);
  }

  clearColorBuffer(commandEncoder) {
    commandEncoder.clearBuffer(this.renderStateBuffer, 16, this.renderStateBuffer.size - 16);
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
    this.renderState = new RenderState(this.device, this.resolution);
    this.cameraBuffer = this.createCameraRayBuffer();
    this.dimensionBuffer = this.createUniformBuffer();
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

  static async create(...args) {
    const instance = new CameraPass(...args);
    await instance.createCameraPipeline();
    instance.initBindGroup();
    instance.initCameraStateBindGroup();
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

  initCameraStateBindGroup() {
    this.cameraStateBindGroup = this.createCameraStateBindGroup(this.pipeline.getBindGroupLayout(1));
  }

  createCameraStateBindGroup(layout) {
    return this.device.createBindGroup({
      layout: layout,
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