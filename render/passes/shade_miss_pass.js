export class ShadeMissPass {
  constructor(device, cameraPass, tracePass, envGenerator) {
    this.device = device;
    this.cameraPass = cameraPass;
    this.tracePass = tracePass;
    this.envGenerator = envGenerator;
    this.currentTargetIdx = -1;
    this.renderState = this.cameraPass.getRenderState();
  }

  initCollisionBindGroup() {
    this.collisionBindGroup = this.tracePass.createCollisionBindGroup3(this.pipeline.getBindGroupLayout(2));
  }

  initRenderStateBindGroup() {
    this.rayStateBindGroup = this.cameraPass.createRenderStateBindGroup(this.pipeline.getBindGroupLayout(1));
  }

  static async create(...args) {
    const instance = new ShadeMissPass(...args);
    await instance.initPipeline();
    instance.initCollisionBindGroup();
    instance.initRenderStateBindGroup();
    await instance.initShadingBindGroup();
    return instance;
  }

  async initPipeline() {
    const wgsl = await fetch('render/shader/shade_miss.wgsl').then(res => res.text());
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

  createSampler(filter) {
    return this.device.createSampler({
      magFilter: filter,
      minFilter: filter,
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
  }

  async initShadingBindGroup() {
    const envTexture = await this.envGenerator.createLuminanceMap(this.device);
    this.shadingBindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      label: "shading bind group",
      entries: [
        {
          binding: 0,
          resource: envTexture.createView(),
        },
        {
          binding: 1,
          resource: this.createSampler('nearest'),
        },
      ],
    });
  }

  generateCommands(commandEncoder) {
    const workGroupSize = 128;
    //this.renderState.clearNumRays(commandEncoder);
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.pipeline);
    //computePass.setBindGroup(0, this.renderTargetBindGroups[this.currentTargetIdx]);
    computePass.setBindGroup(0, this.shadingBindGroup);
    computePass.setBindGroup(1, this.rayStateBindGroup);
    computePass.setBindGroup(2, this.collisionBindGroup);
    const numWorkgroups = Math.ceil(this.cameraPass.resolution[0] * this.cameraPass.resolution[1] / workGroupSize);
    computePass.dispatchWorkgroups(numWorkgroups);
    computePass.end();
  }
}