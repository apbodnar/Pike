import {
  WGSLPackedStructArray,
  RadianceBinStruct,
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
    let normalized = [0, 0, 0]
    let color = this._pixelAt(x, y);
    //let phi = (y / img.height) * Math.PI;
    let scale = 1;//Math.sin(phi);
    let power = scale * Math.pow(2.0, color[3] - 128);
    normalized[0] = power * color[0] / 255.0;
    normalized[1] = power * color[1] / 255.0;
    normalized[2] = power * color[2] / 255.0;
    return this._luma(normalized);
  }

  _biTreeSplitting(totalRadiance, minRadiance, xmin, ymin, xmax, ymax) {
    let boxes = []
    let biSplit = (radiance, x0, y0, x1, y1) => {
      if (radiance <= minRadiance || (y1 - y0) * (x1 - x0) < 2) {
        boxes.push({
          x0: x0 / this.img.width,
          y0: y0 / this.img.height,
          x1: x1 / this.img.width,
          y1: y1 / this.img.height,
        });
        return
      }
      let subRadiance = 0;
      let vertSplit = x1 - x0 > y1 - y0
      let xs = x1;
      let ys = (y1 - y0) / 2 + y0;
      if (vertSplit) {
        xs = (x1 - x0) / 2 + x0;
        ys = y1;
      }
      for (let x = x0; x < xs; x++) {
        for (let y = y0; y < ys; y++) {
          subRadiance += this._getRadiance(x, y);
        }
      }
      biSplit(subRadiance, x0, y0, xs, ys);
      if (vertSplit) {
        biSplit(radiance - subRadiance, xs, y0, x1, y1);
      } else {
        biSplit(radiance - subRadiance, x0, ys, x1, y1);
      }
    }
    biSplit(totalRadiance, xmin, ymin, xmax, ymax);
    return boxes;
  }

  async createLuminanceStrataBuffer() {
    const time = performance.now();
    console.log("Processing env radiance distribution for", this.img.src);
    let totalRadiance = 0;
    let brightestTexel = 0;
    for (let y = 0; y < this.img.height; y++) {
      for (let x = 0; x < this.img.width; x++) {
        let rad = this._getRadiance(x, y);
        brightestTexel = Math.max(rad, brightestTexel);
        totalRadiance += rad;
      }
    }
    let minRadiance = Math.max(totalRadiance / 64, brightestTexel / 2);
    let boxes = this._biTreeSplitting(totalRadiance, minRadiance, 0, 0, this.img.width, this.img.height);
    console.log("Processing env took", (performance.now() - time) / 1000.0, "seconds for", boxes.length, "bins");
    let radianceBinBuffer = new WGSLPackedStructArray(RadianceBinStruct, boxes.length);
    for (const bin of boxes) {
      radianceBinBuffer.push(new RadianceBinStruct(bin));
    }
    return radianceBinBuffer
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
