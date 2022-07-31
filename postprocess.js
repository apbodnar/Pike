import { PostprocessParamsStruct } from "./utils.js";

export class PostProcessPass {
  constructor(device, presentationFormat, textures, context) {
    this.device = device;
    this.presentationFormat = presentationFormat;
    this.currentTargetIdx = -1;
    this.textures = textures;
    this.context = context;
    this.exposure = 1.0;
    this.postprocessParamsBuffer =
      new PostprocessParamsStruct({ exposure: this.exposure })
        .createWGPUBuffer(this.device, GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM);
  }

  setExposure(exposure) {
    this.exposure = exposure;
  }

  setTextureIndex(i) {
    this.currentTargetIdx = i;
  }

  initBindGroups() {
    this.postProcessBindGroups = [0, 1].map((i) => {
      return this.device.createBindGroup({
        label: `pingpong bind group ${i}`,
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: this.textures[i].createView(),
          },
          {
            binding: 1,
            resource: {
              buffer: this.postprocessParamsBuffer
            },
          },
        ],
      });
    });
  }

  static async create(...args) {
    const instance = new PostProcessPass(...args);
    await instance.initPipeline();
    instance.initBindGroups();
    return instance;
  }

  async initPipeline() {
    const wgsl = await fetch('./shader/postprocess.wgsl').then(res => res.text());
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({
          code: wgsl,
        }),
        entryPoint: 'vert_main',
      },
      fragment: {
        module: this.device.createShaderModule({
          code: wgsl,
        }),
        entryPoint: 'frag_main',
        targets: [
          {
            format: this.presentationFormat,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
  }

  generateCommands(commandEncoder) {
    const params = new PostprocessParamsStruct({ exposure: this.exposure });
    const source = params.createWGPUBuffer(this.device, GPUBufferUsage.COPY_SRC);
    commandEncoder.copyBufferToBuffer(source, 0, this.postprocessParamsBuffer, 0, params.size);
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          storeOp: 'store',
        },
      ],
    });
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.postProcessBindGroups[this.currentTargetIdx]);
    passEncoder.draw(6, 1, 0, 0);
    passEncoder.end();
  }
}