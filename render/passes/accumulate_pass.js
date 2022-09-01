export class AccumulatePass {
  constructor(device, resolution, renderState) {
    this.device = device;
    this.resolution = resolution;
    this.renderState = renderState
    this.accumulateTexture = this.device.createTexture({
      size: {
        width: this.resolution[0],
        height: this.resolution[1],
      },
      format: 'rgba32float',
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING,
    });
    this.tempBuffer = this.device.createBuffer({
      size: this.resolution[0] * this.resolution[1] * 4 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
  }

  static async create(...args) {
    const instance = new AccumulatePass(...args);
    await instance.createPipeline();
    instance.initBindGroup();
    return instance;
  }

  async createPipeline() {
    const cameraWGSL = await fetch('render/shader/accumulate.wgsl').then(res => res.text());
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
            buffer: this.tempBuffer,
          },
        },
        {
          binding: 2,
          resource: this.accumulateTexture.createView(),
        },
      ],
    });
  }

  getAccumulateTexture() {
    return this.accumulateTexture;
  }

  generateCommands(commandEncoder) {
    const workGroupSize = 128;
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, this.bindGroup);
    computePass.dispatchWorkgroups(
      Math.ceil(this.resolution[0] / workGroupSize),
      Math.ceil(this.resolution[1] / 1),
    );
    computePass.end();
  }
}