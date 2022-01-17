import {
  WGSLPackedStructArray,
  RadianceBinStruct,
  LuminanceBinStruct,
  LuminanceCoordStruct,
} from './webgpu_utils.js';

export class EnvironmentGenerator {
  constructor(img) {
    this.img = img;
    let canvas = document.createElement('canvas')
    canvas.width = this.img.width;
    canvas.height = this.img.height;
    let ctx = canvas.getContext('2d');
    ctx.drawImage(this.img, 0, 0, this.img.width, this.img.height);
    let pixels = ctx.getImageData(0, 0, this.img.width, this.img.height);
    this.data = pixels.data;
    this.radiance = new Array(this.data.length / 4);
    //this.paintLookupDebugImage();
    //this.paintDebugImage();
    this.totalRadiance = 0;
    this.brightestTexel = 0;
    this.luminanceHist = null;
    this.uvMap = null
    //this._sortPixels();
    this.createLuminanceHistogram();
    // this.paintSortedDebugImage();
    //createLuminanceHistogram
  }

  _luma(c) {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  _pixelAt(px, py) {
    let color = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      color[i] = this.data[((py * (this.img.width * 4)) + (px * 4)) + i];
    }
    return color;
  }

  _getRadiance(x, y) {
    let color = this._pixelAt(x, y);
    //let phi = (y / img.height) * Math.PI;
    let power = Math.pow(2.0, color[3] - 128);
    return power * this._luma(color) / 255.0;
  }

  _setLookupIndex(bin, i) {
    for (let x = bin.x0; x < bin.x1; x++) {
      for (let y = bin.y0; y < bin.y1; y++) {
        const idx = x + this.img.width * y;
        this.lookupData[idx] = i;
      }
    }
  }

  _luminance(pixel) {
    const r = pixel[i];
    const g = pixel[i + 1];
    const b = pixel[i + 2];
    const a = pixel[i + 3];
    const power = Math.pow(2.0, a - 128);
    return power * this._luma([r, g, b]) / 255;
  }

  _sortPixels() {
    this.sortedLuminance = new Array(this.data.length / 4);
    for (let y = 0; y < this.img.height; y++) {
      for (let x = 0; x < this.img.width; x++) {
        let rad = this._getRadiance(x, y);
        this.brightestTexel = Math.max(rad, this.brightestTexel);
        this.totalRadiance += rad;
        const uv = { x, y };
        this.sortedLuminance[y * this.img.width + x] = { rad, uv };
      }
    }
    this.sortedLuminance.sort((a, b) => { return b.rad - a.rad });
    return;
  }

  createLuminanceHistogram() {
    const time = performance.now();
    this._sortPixels();
    const numBins = Math.min(256, Math.max(32, 2 * Math.ceil(this.totalRadiance / this.brightestTexel)));
    const binSize = this.totalRadiance / numBins;
    this.uvMap = this.sortedLuminance.map(l => l.uv);
    this.luminanceHist = [];
    let currentLuminance = 0;
    for (let i = 0; i < this.sortedLuminance.length; i++) {
      if (currentLuminance >= binSize) {
        const prev = this.luminanceHist.length > 0 ? this.luminanceHist[this.luminanceHist.length - 1].h1 : 0;
        this.luminanceHist.push({ h0: prev, h1: i });
        currentLuminance = 0;
      }
      const lum = this.sortedLuminance[i];
      currentLuminance += lum.rad;
    }
    const last = this.luminanceHist[this.luminanceHist.length - 1].h1;
    this.luminanceHist.push({ h0: last, h1: this.uvMap.length });
    console.log("Sorting took:", (performance.now() - time) / 1000, "seconds for", this.luminanceHist.length, "bins.");
  }

  createHistogramBuffer() {
    let luminanceBinBuffer = new WGSLPackedStructArray(LuminanceBinStruct, this.luminanceHist.length);
    for (const bin of this.luminanceHist) {
      luminanceBinBuffer.push(new LuminanceBinStruct(bin));
    }
    return luminanceBinBuffer
  }

  createEnvCoordBuffer() {
    let luminanceCoordBuffer = new WGSLPackedStructArray(LuminanceCoordStruct, this.uvMap.length);
    for (const bin of this.uvMap) {
      luminanceCoordBuffer.push(new LuminanceCoordStruct(bin));
    }
    return luminanceCoordBuffer
  }

  createPdfTexture(device) {
    const pdfBuffer = new Float32Array(this.uvMap.length);
    for (const bin of this.luminanceHist) {
      for (let i = bin.h0; i < bin.h1; i++) {
        const coord = this.uvMap[i];
        const idx = coord.x + this.img.width * coord.y;
        const binPdf = 1 / this.luminanceHist.length;
        const coordPdf = this.uvMap.length / (bin.h1 - bin.h0);
        const spherePdf = 1 / (Math.PI * Math.PI * 2);
        const pdf = binPdf * coordPdf * spherePdf;
        console.assert(pdf > 0);
        pdfBuffer[idx] = pdf;
      }
    }
    const extent = {
      width: this.img.width,
      height: this.img.height,
    };
    const layout = {
      bytesPerRow: this.img.width * 4,
      rowsPerImage: this.img.height,
    }
    const tex = device.createTexture({
      size: extent,
      dimension: '2d',
      format: 'r32float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.writeTexture({ texture: tex }, pdfBuffer, layout, extent);
    return tex;
  }

  paintSortedDebugImage() {
    // const canvas = document.createElement('canvas');
    // canvas.className = "debug"
    // canvas.width = window.innerWidth;
    // canvas.height = window.innerHeight;
    // const ctx = canvas.getContext('2d');
    // ctx.fillStyle = 'red';
    // for (let i = 0; i < canvas.width; i++) {
    //   let idx = Math.floor(this.sortedLuminance.length * i / canvas.width);
    //   let l = Math.floor(canvas.height * (this.sortedLuminance[idx].rad / this.brightestTexel));
    //   ctx.fillRect(i, 0, 1, l);
    // }
    for (const bin of this.luminanceHist) {
      const high = this.sortedLuminance[bin.h1 - 1].rad
      const low = this.sortedLuminance[bin.h0].rad
      console.log(high / low, bin.h1 - bin.h0);
    }
    //document.body.appendChild(canvas);
  }

  async createLuminanceMap(device) {
    const imageBitmap = await createImageBitmap(this.img);
    const extent = {
      width: imageBitmap.width,
      height: imageBitmap.height
    };
    const radianceTexture = device.createTexture({
      size: extent,
      dimension: '2d',
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: radianceTexture },
      extent);
    return radianceTexture;
  }
}
