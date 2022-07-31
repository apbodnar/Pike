export class TraceShadowPass {
  constructor(device, cameraPass, tracePass) {
    this.device = device;
    this.cameraPass = cameraPass;
    this.tracePass = tracePass;
  }

  initBVHBindGroup() {
    this.bvhBindGroup = this.tracePass.createBVHBindGroup(this.pipeline.getBindGroupLayout(0));
  }

  initCollisionBindGroup() {
    this.collisionBindGroup = this.tracePass.createCollisionBindGroup4(this.pipeline.getBindGroupLayout(1));
  }

  initRayStateBindGroup() {
    this.rayStateBindGroup = this.cameraPass.createBindGroup(this.pipeline.getBindGroupLayout(2));
  }

  static async create(...args) {
    const instance = new TraceShadowPass(...args);
    await instance.initPipeline();
    instance.initBVHBindGroup();
    instance.initCollisionBindGroup();
    instance.initRayStateBindGroup();
    return instance;
  }

  async initPipeline() {
    const wgsl = await fetch('./shader/trace_shadow.wgsl').then(res => res.text());
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

  generateCommands(commandEncoder) {
    const workGroupSize = 128;
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, this.bvhBindGroup);
    computePass.setBindGroup(1, this.collisionBindGroup);
    computePass.setBindGroup(2, this.rayStateBindGroup);
    const numWorkgroups = Math.ceil(2 * this.cameraPass.resolution[0] * this.cameraPass.resolution[1] / workGroupSize);
    computePass.dispatchWorkgroups(numWorkgroups);
    computePass.end();
  }
}