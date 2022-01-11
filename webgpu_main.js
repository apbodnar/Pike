import * as Utility from './utility.js'
import * as ObjLoader from './obj_loader.js'
import { TexturePacker } from './texture_packer.js'
import { EnvironmentGenerator } from './env_sampler.js'
import { BVH } from './bvh.js'
import { CameraController } from './camera_controller.js'
import {
  BVHNodeStruct,
  TriangleStruct,
  VertexAttributeStruct,
  WGSLPackedStructArray,
  RenderStateStruct,
  MaterialIndexStruct,
  PostprocessParamsStruct,
} from './webgpu_utils.js';

async function PathTracer(scenePath, resolution) {
  let bvh;
  let samples = 0;
  let lastDraw = 0;

  let elements = {
    canvasElement: document.getElementById("trace"),
    sampleRateElement: document.getElementById("per-second"),
    sampleCount: document.getElementById("counter"),
    exposureElement: document.getElementById("exposure"),
    thetaElement: document.getElementById("env-theta"),
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
  let camera = new CameraController(elements.canvasElement, { dir: [0, 0, -1], origin: [0, 0, 2] }, (e) => { samples = 0 });
  let texturePacker = new TexturePacker(2048);
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
  const LEAF_SIZE = 4;

  function getMaterial(transforms, group, assets, basePath) {
    let material = {};
    let diffuseIndex = null;
    let roughnessIndex = null;
    let normalIndex = null;
    let emitIndex = null;
    if (group.material["map_kd"]) {
      let assetUrl = basePath + "/" + group.material["map_kd"];
      diffuseIndex = texturePacker.addTexture(assets[assetUrl], true);
    } else if (group.material["kd"]) {
      diffuseIndex = texturePacker.addColor(group.material["kd"]);
    } else if (typeof transforms.diffuse === 'string') {
      diffuseIndex = texturePacker.addTexture(assets[transforms.diffuse], true);
    } else if (typeof transforms.diffuse === 'object') {
      diffuseIndex = texturePacker.addColor(transforms.diffuse);
    } else {
      diffuseIndex = texturePacker.addColor([0.5, 0.5, 0.5]);
    }

    if (group.material["map_pmr"]) {
      let assetUrl = basePath + "/" + group.material["map_pmr"];
      let img = assets[assetUrl];
      img.swizzle = group.material["pmr_swizzle"] || transforms.mrSwizzle;
      roughnessIndex = texturePacker.addTexture(img);
    } else if (group.material["pmr"]) {
      roughnessIndex = texturePacker.addColor(group.material["pmr"]);
    } else if (typeof transforms.metallicRoughness === 'string') {
      let img = assets[transforms.metallicRoughness];
      img.swizzle = transforms.mrSwizzle;
      roughnessIndex = texturePacker.addTexture(img);
    } else if (typeof transforms.metallicRoughness === 'object') {
      roughnessIndex = texturePacker.addColor(transforms.metallicRoughness);
    } else if (group.material["ns"]) {
      roughnessIndex = texturePacker.addColor([0, Math.sqrt(2 / (group.material["ns"] + 2)), 0]);
    } else {
      roughnessIndex = texturePacker.addColor([0.0, 0.3, 0]);
    }

    // TODO rename this
    if (group.material["map_kem"]) {
      let assetUrl = basePath + "/" + group.material["map_kem"];
      emitIndex = texturePacker.addTexture(assets[assetUrl]);
    } else if (group.material["kem"]) {
      emitIndex = texturePacker.addColor(group.material["kem"]);
    } else if (typeof transforms.emission === 'string') {
      emitIndex = texturePacker.addTexture(assets[transforms.emission]);
    } else {
      emitIndex = texturePacker.addColor([0, 0, 0]);
    }

    if (group.material["map_bump"]) {
      let assetUrl = basePath + "/" + group.material["map_bump"];
      normalIndex = texturePacker.addTexture(assets[assetUrl]);
    } else if (transforms.normal) {
      normalIndex = texturePacker.addTexture(assets[transforms.normal]);
    } else {
      normalIndex = texturePacker.addColor([0.5, 0.5, 1]);
    }
    material.diffuseIndex = diffuseIndex;
    material.roughnessIndex = roughnessIndex;
    material.normalIndex = normalIndex;
    material.emitIndex = emitIndex;
    material.ior = group.material["ior"] || transforms.ior || 1.4;
    material.dielectric = group.material["dielectric"] || transforms.dielectric || -1;
    material.emittance = transforms.emittance;
    return material;
  }

  async function initBVH(assets) {
    let scene = JSON.parse(assets[scenePath]);
    let geometry = [];
    let materials = [];
    let props = mergeSceneProps(scene);
    for (let i = 0; i < props.length; i++) {
      let prop = props[i];
      let basePath = prop.path.split('/').slice(0, -1).join('/');
      console.log("Parsing:", prop.path);
      let parsed = await ObjLoader.parseMesh(assets[prop.path], prop, scene.worldTransforms, basePath);
      let groups = parsed.groups;
      if (parsed.urls && parsed.urls.size > 0) {
        console.log("Downloading: \n", Array.from(parsed.urls).join('\n'));
        let newTextures = await Utility.loadAll(Array.from(parsed.urls));
        assets = Object.assign(assets, newTextures);
      }
      Object.values(groups).forEach((group) => {
        let material = getMaterial(prop, group, assets, basePath);
        group.triangles.forEach((t) => {
          t.material = materials.length;
          geometry.push(t)
        });
        materials.push(material);
      });
    }

    let time = new Date().getTime();
    console.log("Building BVH:", geometry.length, "triangles");
    time = new Date().getTime();
    bvh = new BVH(geometry, LEAF_SIZE);
    console.log("BVH built in ", (new Date().getTime() - time) / 1000.0, " seconds.  Depth: ", bvh.depth);
    time = new Date().getTime();
    let bvhArray = bvh.serializeTree();
    console.log("BVH serialized in", (new Date().getTime() - time) / 1000.0, " seconds");
    let attributeBuffer = new WGSLPackedStructArray(VertexAttributeStruct, bvh.numLeafTris * 3);
    let bvhBuffer = new WGSLPackedStructArray(BVHNodeStruct, bvhArray.length);
    let trianglesBuffer = new WGSLPackedStructArray(TriangleStruct, bvh.numLeafTris * 3);
    let materialsBuffer = new WGSLPackedStructArray(MaterialIndexStruct, materials.length);
    materials.forEach((mat) => {
      materialsBuffer.push(new MaterialIndexStruct({
        diffMap: mat.diffuseIndex,
        metRoughMap: mat.roughnessIndex,
        normMap: mat.normalIndex,
        emitMap: mat.emitIndex,
      }));
    });
    let triIndex = 0;
    for (let i = 0; i < bvhArray.length; i++) {
      let e = bvhArray[i];
      let node = e.node;
      bvhBuffer.push(new BVHNodeStruct({
        index: i,
        left: node.leaf ? -1 : e.left,
        right: node.leaf ? -1 : e.right,
        triangles: node.leaf ? triIndex : -1,
        boxMin: node.boundingBox.min,
        boxMax: node.boundingBox.max,
      }));
      if (node.leaf) {
        let tris = node.getTriangles();
        triIndex += tris.length;
        for (let j = 0; j < tris.length; j++) {
          trianglesBuffer.push(new TriangleStruct({
            v0: tris[j].verts[0],
            v1: tris[j].verts[1],
            v2: tris[j].verts[2],
            matId: tris[j].material,
          }));
          for (let k = 0; k < 3; k++) {
            attributeBuffer.push(new VertexAttributeStruct({
              normal: tris[j].normals[k],
              tangent: tris[j].tangents[k],
              biTangent: tris[j].bitangents[k],
              uv: tris[j].uvs[k],
            }));
          }
        }
      }
    }
    let atlasTexture = createAtlasTetxure();
    let envGenerator = new EnvironmentGenerator(assets[scene.environment]);
    let envTexture = await envGenerator.createLuminanceMap(device);
    const luminanceBinBuffer = envGenerator.createHistogramBuffer();
    const luminanceCoordBuffer = envGenerator.createEnvCoordBuffer();
    //let envLookup = await envGenerator.createLookupTexture(device);
    //let radianceBinBuffer = await envGenerator.createLuminanceStrataBuffer();
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
            buffer: trianglesBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: trianglesBuffer.size,
          },
        },
        {
          binding: 2,
          resource: {
            buffer: attributeBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: attributeBuffer.size,
          },
        },
        {
          binding: 3,
          resource: {
            buffer: materialsBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: materialsBuffer.size,
          },
        },
        {
          binding: 4,
          resource: atlasTexture.createView({ dimension: '2d-array' }),
        },
        {
          binding: 5,
          resource: envTexture.createView(),
        },
        {
          binding: 6,
          resource: {
            buffer: luminanceCoordBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: luminanceCoordBuffer.size,
          },
        },
        {
          binding: 7,
          resource: {
            buffer: luminanceBinBuffer.createWGPUBuffer(device, GPUBufferUsage.STORAGE),
            size: luminanceBinBuffer.size,
          },
        },
      ],
    });
  }

  function createAtlasTetxure() {
    let atlasRes = texturePacker.setAndGetResolution();
    let pixels = texturePacker.getPixels();
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
    elements.sampleRateElement.value = rate !== Infinity ? rate : 0;
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
        envTheta
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
      computePass.endPass();
    }

    const params = new PostprocessParamsStruct({exposure});
    const source = params.createWGPUBuffer(device, GPUBufferUsage.COPY_SRC);
    commandEncoder.copyBufferToBuffer(source, 0, postprocessParamsBuffer, 0, params.size);
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          storeOp: 'store',
        },
      ],
    });
    passEncoder.setPipeline(postProcessPipeline);
    passEncoder.setBindGroup(0, postProcessBindGroup);
    passEncoder.draw(6, 1, 0, 0);
    passEncoder.endPass();
    device.queue.submit([commandEncoder.finish()]);
    elements.sampleCount.value = samples;
    requestAnimationFrame(tick);
  }

  function mergeSceneProps(scene) {
    return [].concat((scene.props || []), (scene.static_props || []), Object.values(scene.animated_props || []))
  }

  async function createPipelines() {
    elements.canvasElement.width = resolution[0];
    elements.canvasElement.height = resolution[1];
    context = elements.canvasElement.getContext('webgpu');
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

  function createSampler() {
    return device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
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
          resource: createSampler(),
        },
        {
          binding: 2,
          resource: createSampler(),
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

  async function start(res) {
    await createPipelines();
    await initBVH(res);
    await initWebGpu();
    console.log("Beginning render");
    tick();
  }

  let sceneRes = await Utility.getText(scenePath);
  // Use a set to prevent multiple requests
  let pathSet = new Set([scenePath]);
  let scene = JSON.parse(sceneRes);
  mergeSceneProps(scene).forEach(function (e) {
    pathSet.add(e.path);
    if (typeof e.diffuse === 'string') {
      pathSet.add(e.diffuse);
    }
    if (typeof e.metallicRoughness === 'string') {
      pathSet.add(e.metallicRoughness);
    }
    if (e.normal) {
      pathSet.add(e.normal);
    }
    if (e.emission) {
      pathSet.add(e.emission);
    }
  });
  if (typeof scene.environment === 'string') {
    pathSet.add(scene.environment);
  }
  let assetRes = await Utility.loadAll(Array.from(pathSet));
  start(assetRes);
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

let sceneMatch = window.location.search.match(/scene=([a-zA-Z0-9_]+)/);
let scenePath = Array.isArray(sceneMatch) ? 'scene/' + sceneMatch[1] + '.json' : 'scene/bunny.json';
let resolution = getResolution();

PathTracer(scenePath, resolution);
