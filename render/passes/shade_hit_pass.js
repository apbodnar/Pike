import {
  WGSLPackedStructArray,
  MaterialIndexStruct,
  VertexAttributeStruct,
} from "../util/structs.js";

export class ShadeHitPass {
  constructor(device, cameraPass, tracePass, scene, envGenerator) {
    this.device = device;
    this.cameraPass = cameraPass;
    this.tracePass = tracePass;
    this.scene = scene;
    this.envGenerator = envGenerator;
    this.currentTargetIdx = -1;
    this.renderState = this.cameraPass.getRenderState();
  }

  initCollisionBindGroup() {
    this.collisionBindGroup = this.tracePass.createCollisionBindGroup2(this.pipeline.getBindGroupLayout(2));
  }

  initRayStateBindGroup() {
    this.rayStateBindGroup = this.cameraPass.createBindGroup(this.pipeline.getBindGroupLayout(1));
  }

  static async create(...args) {
    const instance = new ShadeHitPass(...args);
    await instance.initPipeline();
    //instance.initRenderTargetBindGroups();
    await instance.initShadingBindGroup();
    instance.initRayStateBindGroup();
    instance.initCollisionBindGroup();
    return instance;
  }

  async initPipeline() {
    const wgsl = await fetch('render/shader/shade_hit.wgsl').then(res => res.text());
    const patched = wgsl.replace('###NUM_LUMINANCE_BINS###', this.envGenerator.luminanceHist.length)
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({
          code: patched,
        }),
        entryPoint: 'main',
      },
    });
  }

  createAtlasTetxure() {
    let atlasRes = this.scene.texturePacker.getResolution();
    let pixels = this.scene.texturePacker.getPixels();
    const extent = {
      width: atlasRes[0],
      height: atlasRes[1],
      depthOrArrayLayers: atlasRes[2],
    };
    const layout = {
      bytesPerRow: atlasRes[0] * 4,
      rowsPerImage: atlasRes[1],
    }
    const atlasTexture = this.device.createTexture({
      size: extent,
      dimension: '2d',
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.writeTexture({ texture: atlasTexture }, pixels, layout, extent);
    return atlasTexture;
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
    const materialsBuffer = new WGSLPackedStructArray(MaterialIndexStruct, this.scene.materials.length);
    for (const mat of this.scene.materials) {
      materialsBuffer.push(new MaterialIndexStruct(mat));
    }
    const attributeBuffer = new WGSLPackedStructArray(VertexAttributeStruct, this.scene.attributes.length);
    for (let attribute of this.scene.attributes) {
      attributeBuffer.push(new VertexAttributeStruct(attribute));
    }
    const atlasTexture = this.createAtlasTetxure();
    const luminanceBinBuffer = this.envGenerator.createHistogramBuffer();
    const luminanceCoordBuffer = this.envGenerator.createEnvCoordBuffer();
    const pdfTexture = this.envGenerator.createPdfTexture(this.device);
    this.shadingBindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      label: "shading bind group",
      entries: [
        {
          binding: 0,
          resource: {
            buffer: attributeBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: attributeBuffer.size,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: materialsBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: materialsBuffer.size,
          },
        },
        {
          binding: 2,
          resource: atlasTexture.createView({ dimension: '2d-array' }),
        },
        {
          binding: 3,
          resource:  {
            buffer: this.envGenerator.createEnvResBuffer(this.device),
          },
        },
        {
          binding: 4,
          resource:  pdfTexture.createView(),
        },
        {
          binding: 5,
          resource: {
            buffer: luminanceCoordBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: luminanceCoordBuffer.size,
          },
        },
        {
          binding: 6,
          resource: {
            buffer: luminanceBinBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: luminanceBinBuffer.size,
          },
        },
        {
          binding: 7,
          resource: this.createSampler('linear'),
        },
      ],
    });
  }

  generateCommands(commandEncoder) {
    const workGroupSize = 128;
    this.cameraPass.getRenderState().clearNumRays(commandEncoder);
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