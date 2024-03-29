import { Scene } from './scene.js'
import { CameraController } from './camera_controller.js'
import { CameraPass } from './passes/camera_pass.js'
import { Raycaster } from './raycaster.js'
import { TracePass } from './passes/trace_pass.js'
import { ShadeHitPass } from './passes/shade_hit_pass.js'
import { PostProcessPass } from './passes/postprocess_pass.js'
import { AccumulatePass } from './passes/accumulate_pass.js'
import { ShadeMissPass } from './passes/shade_miss_pass.js'
import { EnvironmentGenerator } from './env_sampler.js'
import { TraceShadowPass } from './passes/trace_shadow_pass.js'

class PikeRenderer {
  constructor(scene, resolution) {
    this.scene = scene;
    this.renderState = null;
    this.resolution = resolution;
    this.BATCH_SIZE = resolution[0] * resolution[1];//512 * 512;
    this.lastDraw = 0;
    this.numBounces = 4;
    this.elements = {
      canvasElement: document.getElementById("trace"),
      sampleRateElement: document.getElementById("per-second"),
      sampleCount: document.getElementById("counter"),
      exposureElement: document.getElementById("exposure"),
      thetaElement: document.getElementById("env-theta"),
      focalDepth: document.getElementById("focal-depth"),
      apertureSize: document.getElementById("aperture-size"),
      distortion: document.getElementById("distortion"),
      bokeh: document.getElementById("bokeh"),
      saturation: document.getElementById("saturation"),
    };
    this.elements.thetaElement.addEventListener('input', (e) => {
      this.renderState.setEnvRotation(parseFloat(e.target.value));
      this.renderState.resetSamples();
    }, false);
    this.exposure = 1;
    this.elements.exposureElement.addEventListener('input', (e) => {
      this.postProcessPass.setExposure(parseFloat(e.target.value));
    }, false);
    this.saturation = 1;
    this.elements.saturation.addEventListener('input', (e) => {
      this.postProcessPass.setSaturation(parseFloat(e.target.value));
    }, false);
    this.focalDepth = 0.5;
    this.elements.focalDepth.addEventListener('input', (e) => {
      this.focalDepth = parseFloat(e.target.value);
      this.renderState.resetSamples();
    }, false);
    this.apertureSize = 0.0;
    this.elements.apertureSize.addEventListener('input', (e) => {
      this.apertureSize = parseFloat(e.target.value);
      this.renderState.resetSamples();
    }, false);
    this.distortion = 0.0;
    this.elements.distortion.addEventListener('input', (e) => {
      this.distortion = parseFloat(e.target.value);
      this.renderState.resetSamples();
    }, false);
    this.bokeh = 0.5;
    this.elements.bokeh.addEventListener('input', (e) => {
      this.bokeh = parseFloat(e.target.value);
      this.renderState.resetSamples();
    }, false);
    this.camera = new CameraController(
      this.elements.canvasElement,
      {
        dir: [0, 0, -1],
        origin: [0, 0, 2],
      },
      () => {
        this.focusCamera();
        this.elements.focalDepth.value = this.focalDepth;
        this.renderState.resetSamples();
      }
    );
    this.raycaster = null;
    this.postProcessBindGroup;
    this.renderTargetBindGroups;
    this.uniformsBindGroup;
    this.postprocessParamsBuffer;
    this.storageBindGroup;
    this.tracerPipeline;
    this.postProcessPipeline;
    this.context = null;
  }

  focusCamera() {
    this.focalDepth = 1 - 1 / this.raycaster.cast(this.camera.getCameraRay());
  }

  async initWebGpu() {
    this.adapter = await navigator.gpu.requestAdapter();
    this.device = await this.adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: this.adapter.limits.maxStorageBufferBindingSize },
      requiredFeatures: ['shader-f16'],
    });
    this.elements.canvasElement.width = this.resolution[0];
    this.elements.canvasElement.height = this.resolution[1];
    this.context = this.elements.canvasElement.getContext('webgpu', { colorSpace: 'display-p3', pixelFormat: 'float32' });
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: presentationFormat,
      alphaMode: "opaque",
    });

    const envGenerator = new EnvironmentGenerator(this.scene.env);
    this.cameraPass = await CameraPass.create(this.device, this.resolution, this.BATCH_SIZE);
    this.renderState = this.cameraPass.getRenderState();
    this.tracePass = await TracePass.create(this.device, this.cameraPass, this.scene);
    this.shadePass = await ShadeHitPass.create(this.device, this.cameraPass, this.tracePass, this.scene, envGenerator);
    this.traceShadowPass = await TraceShadowPass.create(this.device, this.cameraPass, this.tracePass);
    this.shadeMissPass = await ShadeMissPass.create(this.device, this.cameraPass, this.tracePass, envGenerator);
    this.accumulatePass = await AccumulatePass.create(this.device, this.resolution, this.renderState, this.cameraPass);
    this.postProcessPass = await PostProcessPass.create(this.device, presentationFormat, this.context, this.accumulatePass);
    this.raycaster = new Raycaster(this.tracePass.getBVH());
  }

  async tick() {
    const samples = this.renderState.getSamples();
    if (samples == 0) {
      this.lastDraw = performance.now();
    }
    const rate = Math.round(samples * 1000 / (performance.now() - this.lastDraw));
    this.elements.sampleRateElement.value = rate && rate !== Infinity ? rate : 0;
    const ray = this.camera.getCameraRay();

    let commandEncoder = this.device.createCommandEncoder();
    this.renderState.generateCommands(commandEncoder);
    this.renderState.incrementSamples();
    this.renderState.clearColorBuffer(commandEncoder);
    const NUM_BATCHES = Math.ceil(this.resolution[0] * this.resolution[1] / this.BATCH_SIZE);

    for (let j = 0; j < NUM_BATCHES; j++) {
      this.renderState.clearNumHitsAndMisses(commandEncoder);
      this.renderState.clearNumRays(commandEncoder);
      this.cameraPass.setCameraState({
        pos: ray.origin,
        dir: ray.dir,
        fov: this.camera.getFov(),
        focalDepth: this.focalDepth,
        apertureSize: this.apertureSize,
        distortion: this.distortion,
        bokeh: this.bokeh,
        invocationOffset: j * this.BATCH_SIZE,
      });
      this.cameraPass.generateCommands(commandEncoder);
      for (let i = 0; i < this.numBounces; i++) {
        this.tracePass.generateCommands(commandEncoder);
        this.shadePass.generateCommands(commandEncoder);
        this.traceShadowPass.generateCommands(commandEncoder);
        this.shadeMissPass.generateCommands(commandEncoder);
      }
    }

    this.accumulatePass.generateCommands(commandEncoder);
    this.postProcessPass.generateCommands(commandEncoder);
    this.device.queue.submit([commandEncoder.finish()]);
    this.elements.sampleCount.value = this.renderState.getSamples();
    requestAnimationFrame(() => { this.tick() });
  }

  async start() {
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