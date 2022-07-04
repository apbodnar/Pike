import { Scene } from './scene.js'
import { EnvironmentGenerator } from './env_sampler.js'
import { BVH } from './bvh.js'
import { CameraController } from './camera_controller.js'
import { Raycaster } from './raycaster.js'
import {
  BVHNodeStruct,
  VertexAttributeStruct,
  WGSLPackedStructArray,
  RenderStateStruct,
  MaterialIndexStruct,
  PostprocessParamsStruct,
  VertexIndexStruct,
  VertexPositionStruct,
} from './utils.js';

class PikeRenderer {
  constructor(scene, resolution) {
    this.scene = scene;
    this.resolution = resolution;
    this.samples = 0;
    this.lastDraw = 0;
    this.elements = {
      canvasElement: document.getElementById("trace"),
      sampleRateElement: document.getElementById("per-second"),
      sampleCount: document.getElementById("counter"),
      exposureElement: document.getElementById("exposure"),
      thetaElement: document.getElementById("env-theta"),
      focalDepth: document.getElementById("focal-depth"),
      apertureSize: document.getElementById("aperture-size"),
    };
    this.envTheta = 0;
    this.elements.thetaElement.addEventListener('input', (e) => {
      this.envTheta = parseFloat(e.target.value);
      this.samples = 0;
    }, false);
    this.exposure = 1;
    this.elements.exposureElement.addEventListener('input', (e) => {
      this.exposure = parseFloat(e.target.value);
    }, false);
    this.focalDepth = 0.5;
    this.elements.focalDepth.addEventListener('input', (e) => {
      this.focalDepth = parseFloat(e.target.value);
      this.samples = 0;
    }, false);
    this.apertureSize = 0.02;
    this.elements.apertureSize.addEventListener('input', (e) => {
      this.apertureSize = parseFloat(e.target.value);
      this.samples = 0;
    }, false);
    this.camera = new CameraController(
      this.elements.canvasElement,
      {
        dir: [0, 0, -1],
        origin: [0, 0, 2]
      },
      () => {
        this.onCameraMove()
      }
    );
    this.raycaster = null;
    this.postProcessBindGroup;
    this.renderTargetBindGroups;
    this.uniformsBindGroup;
    this.renderStateBuffer;
    this.postprocessParamsBuffer;
    this.storageBindGroup;
    this.tracerPipeline;
    this.postProcessPipeline;
    this.context = null;
  }

  maskTriIndex(index, numTris) {
    // Protect the sign bit?
    let mask = numTris << 24;
    return mask | index;
  }

  onCameraMove() {
    this.focusCamera();
    this.elements.focalDepth.value = this.focalDepth;
    this.samples = 0;
  }

  focusCamera() {
    this.focalDepth = 1 - 1 / this.raycaster.cast(this.camera.getCameraRay());
  }

  async initBVH() {
    let time = performance.now();
    console.log("Building BVH:", this.scene.indices.length, "triangles");
    time = performance.now();
    const bvh = new BVH(this.scene);
    this.raycaster = new Raycaster(bvh);
    //const bvh = new SplitBVH(geometry, attributes);
    console.log("BVH built in ", (performance.now() - time) / 1000.0, " seconds.  Depth: ", bvh.depth);
    time = performance.now();
    let bvhArray = bvh.serializeTree();
    console.log("BVH serialized in", (performance.now() - time) / 1000.0, " seconds");
    const attributeBuffer = new WGSLPackedStructArray(VertexAttributeStruct, this.scene.attributes.length);
    const indexBuffer = new WGSLPackedStructArray(VertexIndexStruct, bvh.numLeafTris() * 3);
    const bvhBuffer = new WGSLPackedStructArray(BVHNodeStruct, bvhArray.length);
    const positionBuffer = new WGSLPackedStructArray(VertexPositionStruct, this.scene.attributes.length);
    const materialsBuffer = new WGSLPackedStructArray(MaterialIndexStruct, this.scene.materials.length);
    for (const mat of this.scene.materials) {
      materialsBuffer.push(new MaterialIndexStruct(mat));
    }
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
        let tris = node.getTriangles();
        triIndex += tris.length;
        for (let j = 0; j < tris.length; j++) {
          indexBuffer.push(new VertexIndexStruct(tris[j].desc));
        }
      }
    }

    for (let attribute of this.scene.attributes) {
      attributeBuffer.push(new VertexAttributeStruct(attribute));
      positionBuffer.push(new VertexPositionStruct(attribute));
    }

    const atlasTexture = this.createAtlasTetxure();
    const envGenerator = new EnvironmentGenerator(this.scene.env);
    const envTexture = await envGenerator.createLuminanceMap(this.device);
    const luminanceBinBuffer = envGenerator.createHistogramBuffer();
    const luminanceCoordBuffer = envGenerator.createEnvCoordBuffer();
    const pdfTexture = envGenerator.createPdfTexture(this.device);
    this.storageBindGroup = this.device.createBindGroup({
      layout: this.tracerPipeline.getBindGroupLayout(1),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: bvhBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: bvhBuffer.size,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: indexBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: indexBuffer.size,
          },
        },
        {
          binding: 2,
          resource: {
            buffer: positionBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: positionBuffer.size,
          },
        },
        {
          binding: 3,
          resource: {
            buffer: attributeBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: attributeBuffer.size,
          },
        },
        {
          binding: 4,
          resource: {
            buffer: materialsBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: materialsBuffer.size,
          },
        },
        {
          binding: 5,
          resource: atlasTexture.createView({ dimension: '2d-array' }),
        },
        {
          binding: 6,
          resource: envTexture.createView(),
        },
        {
          binding: 7,
          resource: pdfTexture.createView(),
        },
        {
          binding: 8,
          resource: {
            buffer: luminanceCoordBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: luminanceCoordBuffer.size,
          },
        },
        {
          binding: 9,
          resource: {
            buffer: luminanceBinBuffer.createWGPUBuffer(this.device, GPUBufferUsage.STORAGE),
            size: luminanceBinBuffer.size,
          },
        },

      ],
    });
  }

  createAtlasTetxure() {
    let atlasRes = scene.texturePacker.getResolution();
    let pixels = scene.texturePacker.getPixels();
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

  tick() {
    if (this.samples == 0) {
      this.lastDraw = performance.now();
    }
    const rate = Math.round(this.samples * 1000 / (performance.now() - this.lastDraw));
    this.elements.sampleRateElement.value = rate && rate !== Infinity ? rate : 0;
    const tileSizeX = 16;
    const tileSizeY = 8;
    const ray = this.camera.getCameraRay();
    const commandEncoder = this.device.createCommandEncoder();
    // TODO replace once read+write in storage images is a thing
    for (const bindGroup of this.renderTargetBindGroups) {
      const state = new RenderStateStruct({
        pos: ray.origin,
        dir: ray.dir,
        samples: this.samples++,
        fov: this.camera.getFov(),
        envTheta: this.envTheta,
        focalDepth: this.focalDepth,
        apertureSize: this.apertureSize,
      });
      const source = state.createWGPUBuffer(this.device, GPUBufferUsage.COPY_SRC);
      commandEncoder.copyBufferToBuffer(source, 0, this.renderStateBuffer, 0, state.size);
      const computePass = commandEncoder.beginComputePass();
      computePass.setPipeline(this.tracerPipeline);
      computePass.setBindGroup(0, bindGroup);
      computePass.setBindGroup(1, this.storageBindGroup);
      computePass.setBindGroup(2, this.uniformsBindGroup);
      computePass.dispatchWorkgroups(
        Math.ceil(this.resolution[0] / tileSizeX),
        Math.ceil(this.resolution[1] / tileSizeY)
      );
      computePass.end();
    }

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
    passEncoder.setPipeline(this.postProcessPipeline);
    passEncoder.setBindGroup(0, this.postProcessBindGroup);
    passEncoder.draw(6, 1, 0, 0);
    passEncoder.end();
    this.device.queue.submit([commandEncoder.finish()]);
    this.elements.sampleCount.value = this.samples;
    requestAnimationFrame(() => { this.tick() });
  }

  async createPipelines() {
    this.adapter = await navigator.gpu.requestAdapter();
    this.device = await this.adapter.requestDevice({
      requiredLimits: this.adapter.limits,
    });
    this.elements.canvasElement.width = this.resolution[0];
    this.elements.canvasElement.height = this.resolution[1];
    //context = elements.canvasElement.getContext('webgpu', { colorSpace: "display-p3" });
    this.context = this.elements.canvasElement.getContext('webgpu', { colorSpace: 'display-p3', pixelFormat: 'float32' });
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: presentationFormat,
      alphaMode: "opaque",
    });
    const tracerWGSL = await fetch('./shader/tracer.wgsl').then(res => res.text());
    const quadWGSL = await fetch('./shader/postprocess.wgsl').then(res => res.text());
    this.tracerPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({
          code: tracerWGSL,
        }),
        entryPoint: 'main',
        constants: {
          workGroupSizeX: 16,
          workGroupSizeY: 16,
        },
      },
    });

    this.postProcessPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({
          code: quadWGSL,
        }),
        entryPoint: 'vert_main',
      },
      fragment: {
        module: this.device.createShaderModule({
          code: quadWGSL,
        }),
        entryPoint: 'frag_main',
        targets: [
          {
            format: presentationFormat,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
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

  async initWebGpu() {
    const textures = [0, 1].map(() => {
      return this.device.createTexture({
        size: {
          width: resolution[0],
          height: resolution[1],
        },
        format: 'rgba32float',
        usage:
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING,
      });
    });

    this.renderTargetBindGroups = [0, 1].map((i) => {
      return this.device.createBindGroup({
        layout: this.tracerPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: textures[i].createView(),
          },
          {
            binding: 1,
            resource: textures[(i + 1) % 2].createView(),
          }
        ],
      });
    });
    this.renderStateBuffer = this.device.createBuffer({
      size: RenderStateStruct.getStride(),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });
    this.uniformsBindGroup = this.device.createBindGroup({
      layout: this.tracerPipeline.getBindGroupLayout(2),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.renderStateBuffer
          },
        },
        {
          binding: 1,
          resource: this.createSampler('linear'),
        },
        {
          binding: 2,
          resource: this.createSampler('nearest'),
        },
      ],
    });
    this.postprocessParamsBuffer = this.device.createBuffer({
      size: PostprocessParamsStruct.getStride(),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });
    this.postProcessBindGroup = this.device.createBindGroup({
      layout: this.postProcessPipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: textures[1].createView(),
        },
        {
          binding: 1,
          resource: {
            buffer: this.postprocessParamsBuffer
          },
        },
      ],
    });
  }

  async start() {
    await this.createPipelines();
    await this.initBVH();
    await this.initWebGpu();
    this.focusCamera();
    console.log("Beginning render");
    this.tick();
  }
}

function getResolution() {
  let resolutionMatch = window.location.search.match(/res=(\d+)(x*)(\d+)?/);
  if (Array.isArray(resolutionMatch) && resolutionMatch[1] && resolutionMatch[3]) {
    return [resolutionMatch[1], resolutionMatch[3]];
  } else if (Array.isArray(resolutionMatch) && resolutionMatch[1] && resolutionMatch[2]) {
    return [window.innerWidth / resolutionMatch[1], window.innerHeight / resolutionMatch[1]];
  } else if (Array.isArray(resolutionMatch) && resolutionMatch[1]) {
    return [resolutionMatch[1], resolutionMatch[1]];
  } else {
    return [window.innerWidth, window.innerHeight];
  }
}

const sceneMatch = window.location.search.match(/scene=([a-zA-Z0-9_]+)/);
const scenePath = Array.isArray(sceneMatch) ? 'scene/' + sceneMatch[1] + '.json' : 'scene/bunny.json';
const resolution = getResolution();
const scene = await new Scene().load(scenePath);
const renderer = new PikeRenderer(scene, resolution);
renderer.start()