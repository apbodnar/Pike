import { CameraStateStuct } from "./utils.js";

export class CameraPass {
  constructor(device, resolution, renderState) {
    this.device = device;
    this.resolution = resolution;
    this.cameraStateBuffer = this.device.createBuffer({
      size: CameraStateStuct.getStride(),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });
    this.renderState = renderState;
    this.cameraBuffer = this.createCameraRayBuffer();
    this.dimensionBuffer = this.createUniformBuffer();
  }

  createCameraRayBuffer() {
    const db = this.device.createBuffer({
      size: this.resolution[0] * this.resolution[1] * 12 * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    return db;
  }

  createUniformBuffer() {
    const db = this.device.createBuffer({
      size: 2 * 4,
      mappedAtCreation: true,
      usage: GPUBufferUsage.UNIFORM,
    });
    const buffer = new Uint32Array(this.resolution)
    new Uint32Array(db.getMappedRange()).set(buffer);
    db.unmap();
    return db;
  }

  setCameraState(state) {
    this.cameraState = new CameraStateStuct(state);
  }

  getCameraBindGroup() {
    return this.bindGroup;
  }

  static async create(device, resolution, renderState) {
    const instance = new CameraPass(device, resolution, renderState);
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
    this.renderStateBindGroup = this.renderState.createBindGroup(this.pipeline.getBindGroupLayout(2))
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
            buffer: this.cameraBuffer,
            size: this.cameraBuffer.size,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: this.dimensionBuffer,
            size: this.dimensionBuffer.size,
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
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, this.bindGroup);
    computePass.setBindGroup(1, this.cameraStateBindGroup);
    computePass.setBindGroup(2, this.renderStateBindGroup);
    computePass.dispatchWorkgroups(
      Math.ceil(this.resolution[0] / 128),
      Math.ceil(this.resolution[1] / 1),
    );
    computePass.end();
  }
}