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
} from './webgpu_utils.js';

async function PathTracer(scene, resolution) {
  let samples = 0;
  let lastDraw = 0;
  let elements = {
    canvasElement: document.getElementById("trace"),
    sampleRateElement: document.getElementById("per-second"),
    sampleCount: document.getElementById("counter"),
    exposureElement: document.getElementById("exposure"),
    thetaElement: document.getElementById("env-theta"),
    focalDepth: document.getElementById("focal-depth"),
    apertureSize: document.getElementById("aperture-size"),
  };
  let envTheta = 0;
  elements.thetaElement.addEventListener('input', function (e) {
    envTheta = parseFloat(e.target.value);
    samples = 0;
  }, false);
  let exposure = 1;
  elements.exposureElement.addEventListener('input', function (e) {
    exposure = parseFloat(e.target.value);
  }, false);
  let focalDepth = 0.5;
  elements.focalDepth.addEventListener('input', function (e) {
    focalDepth = parseFloat(e.target.value);
    samples = 0;
  }, false);
  let apertureSize = 0.02;
  elements.apertureSize.addEventListener('input', function (e) {
    apertureSize = parseFloat(e.target.value);
    samples = 0;
  }, false);
  let camera = new CameraController(elements.canvasElement, { dir: [0, 0, -1], origin: [0, 0, 2] }, (e) => { onCameraMove() });
  let raycaster = null;
  let postProcessBindGroup;
  let renderTargetBindGroups;
  let uniformsBindGroup;
  let renderStateBuffer;
  let postprocessParamsBuffer;
  let storageBindGroup;
  let tracerPipeline;
  let postProcessPipeline;
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice({
    requiredLimits: adapter.limits,
  });
  let context;
  function maskTriIndex(index, numTris) {
    // Protect the sign bit?
    let mask = numTris << 24;
    return mask | index;
  }

  function onCameraMove(e) {
    focusCamera();
    elements.focalDepth.value = focalDepth;
    samples = 0;
  }

  function focusCamera() {
    focalDepth = 1 - 1 / raycaster.cast(camera.getCameraRay());
  }

  async function initBVH() {
    let time = performance.now();
    console.log("Building BVH:", scene.indices.length, "triangles");
    time = performance.now();
    const bvh = new BVH(scene);
    raycaster = new Raycaster(bvh);
    //const bvh = new SplitBVH(geometry, attributes);
    console.log("BVH built in ", (performance.now() - time) / 1000.0, " seconds.  Depth: ", bvh.depth);
    time = performance.now();
    let bvhArray = bvh.serializeTree();
    console.log("BVH serialized in", (performance.now() - time) / 1000.0, " seconds");
    const attributeBuffer = new WGSLPackedStructArray(VertexAttributeStruct, scene.attributes.length);
    const indexBuffer = new WGSLPackedStructArray(VertexIndexStruct, bvh.numLeafTris * 3);
    const bvhBuffer = new WGSLPackedStructArray(BVHNodeStruct, bvhArray.length);
    const positionBuffer = new WGSLPackedStructArray(VertexPositionStruct, scene.attributes.length);
    const materialsBuffer = new WGSLPackedStructArray(MaterialIndexStruct, scene.materials.length);
    for (const mat of scene.materials) {
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
        triangles: node.leaf ? maskTriIndex(triIndex, node.getleafSize()) : -1,
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

    for (let attribute of scene.attributes) {
      attributeBuffer.push(new VertexAttributeStruct(attribute));
      positionBuffer.push(new VertexPositionStruct(attribute));
    }

    const atlasTexture = createAtlasTetxure();
    const envGenerator = new EnvironmentGenerator(scene.env);
    const envTexture = await envGenerator.createLuminanceMap(device);
    const luminanceBinBuffer = envGenerator.createHistogramBuffer();
    const luminanceCoordBuffer = envGenerator.createEnvCoordBuffer();
    const pdfTexture = envGenerator.createPdfTexture(device);
    storageBindGroup = device.createBindGroup({
      layout: tracerPipeline.getBindGroupLayout(1),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: bvhBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: bvhBuffer.size,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: indexBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: indexBuffer.size,
          },
        },
        {
          binding: 2,
          resource: {
            buffer: positionBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: positionBuffer.size,
          },
        },
        {
          binding: 3,
          resource: {
            buffer: attributeBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: attributeBuffer.size,
          },
        },
        {
          binding: 4,
          resource: {
            buffer: materialsBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
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
            buffer: luminanceCoordBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: luminanceCoordBuffer.size,
          },
        },
        {
          binding: 9,
          resource: {
            buffer: luminanceBinBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: luminanceBinBuffer.size,
          },
        },

      ],
    });
  }

  function createAtlasTetxure() {
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
    const atlasTexture = device.createTexture({
      size: extent,
      dimension: '2d',
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.writeTexture({ texture: atlasTexture }, pixels, layout, extent);
    return atlasTexture;
  }

  function tick() {
    if (samples == 0) {
      lastDraw = performance.now();
    }
    const rate = Math.round(samples * 1000 / (performance.now() - lastDraw));
    elements.sampleRateElement.value = rate && rate !== Infinity ? rate : 0;
    const tileSizeX = 16;
    const tileSizeY = 16;
    const ray = camera.getCameraRay();
    const commandEncoder = device.createCommandEncoder();
    // TODO replace once read+write in storage images is a thing
    for (const bindGroup of renderTargetBindGroups) {
      const state = new RenderStateStruct({
        pos: ray.origin,
        dir: ray.dir,
        samples: samples++,
        fov: camera.getFov(),
        envTheta,
        focalDepth,
        apertureSize,
      });
      const source = state.createWGPUBuffer(device, GPUBufferUsage.COPY_SRC);
      commandEncoder.copyBufferToBuffer(source, 0, renderStateBuffer, 0, state.size);
      const computePass = commandEncoder.beginComputePass();
      computePass.setPipeline(tracerPipeline);
      computePass.setBindGroup(0, bindGroup);
      computePass.setBindGroup(1, storageBindGroup);
      computePass.setBindGroup(2, uniformsBindGroup);
      computePass.dispatch(
        Math.ceil(resolution[0] / tileSizeX),
        Math.ceil(resolution[1] / tileSizeY)
      );
      computePass.end();
    }

    const params = new PostprocessParamsStruct({ exposure });
    const source = params.createWGPUBuffer(device, GPUBufferUsage.COPY_SRC);
    commandEncoder.copyBufferToBuffer(source, 0, postprocessParamsBuffer, 0, params.size);
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          storeOp: 'store',
        },
      ],
    });
    passEncoder.setPipeline(postProcessPipeline);
    passEncoder.setBindGroup(0, postProcessBindGroup);
    passEncoder.draw(6, 1, 0, 0);
    passEncoder.end();
    device.queue.submit([commandEncoder.finish()]);
    elements.sampleCount.value = samples;
    requestAnimationFrame(tick);
  }

  async function createPipelines() {
    elements.canvasElement.width = resolution[0];
    elements.canvasElement.height = resolution[1];
    //context = elements.canvasElement.getContext('webgpu', { colorSpace: "display-p3" });
    context = elements.canvasElement.getContext('webgpu', { colorSpace: 'display-p3', pixelFormat: 'float32' });
    const presentationFormat = context.getPreferredFormat(adapter);
    context.configure({
      device,
      format: presentationFormat,
      size: resolution,
    });
    const tracerWGSL = await fetch('./shader/tracer.wgsl').then(res => res.text());
    const quadWGSL = await fetch('./shader/postprocess.wgsl').then(res => res.text());
    tracerPipeline = device.createComputePipeline({
      compute: {
        module: device.createShaderModule({
          code: tracerWGSL,
        }),
        entryPoint: 'main',
      },
    });

    postProcessPipeline = device.createRenderPipeline({
      vertex: {
        module: device.createShaderModule({
          code: quadWGSL,
        }),
        entryPoint: 'vert_main',
      },
      fragment: {
        module: device.createShaderModule({
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

  function createSampler(filter) {
    return device.createSampler({
      magFilter: filter,
      minFilter: filter,
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
  }

  async function initWebGpu() {
    const textures = [0, 1].map(() => {
      return device.createTexture({
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

    renderTargetBindGroups = [0, 1].map((i) => {
      return device.createBindGroup({
        layout: tracerPipeline.getBindGroupLayout(0),
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
    renderStateBuffer = device.createBuffer({
      size: RenderStateStruct.getStride(),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });
    uniformsBindGroup = device.createBindGroup({
      layout: tracerPipeline.getBindGroupLayout(2),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: renderStateBuffer
          },
        },
        {
          binding: 1,
          resource: createSampler('linear'),
        },
        {
          binding: 2,
          resource: createSampler('nearest'),
        },
      ],
    });
    postprocessParamsBuffer = device.createBuffer({
      size: PostprocessParamsStruct.getStride(),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });
    postProcessBindGroup = device.createBindGroup({
      layout: postProcessPipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: textures[1].createView(),
        },
        {
          binding: 1,
          resource: {
            buffer: postprocessParamsBuffer
          },
        },
      ],
    });
  }

  async function start() {
    await createPipelines();
    await initBVH();
    await initWebGpu();
    focusCamera();
    console.log("Beginning render");
    tick();
  }
  start();
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
PathTracer(scene, resolution);
