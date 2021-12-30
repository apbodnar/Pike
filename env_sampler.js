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
    this.lookupData = new Int16Array(this.img.width * this.img.height);
    this.strata = this._createLuminanceStrata();
    //this.paintLookupDebugImage();
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

  _setLookupIndex(bin, i) {
    for (let x = bin.x0; x < bin.x1; x++) {
      for (let y = bin.y0; y < bin.y1; y++) {
        const idx = x + this.img.width * y;
        this.lookupData[idx] = i;
      }
    }
  }

  _biTreeSplitting(totalRadiance, minRadiance) {
    let boxes = []
    let biSplit = (radiance, x0, y0, x1, y1) => {
      if (radiance <= minRadiance || (y1 - y0) * (x1 - x0) < 2) {
        const box = { x0, y0, x1, y1 };
        this._setLookupIndex(box, boxes.length);
        boxes.push(box);
        return;
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
    biSplit(totalRadiance, 0, 0, this.img.width, this.img.height);
    return boxes;
  }

  // _biTreeSplitting2(totalRadiance, minRadiance) {
  //   let boxes = []
  //   let biSplit = (radiance, x0, y0, x1, y1, depth) => {
  //     if (depth >= 10 || radiance <= minRadiance || (y1 - y0) * (x1 - x0) < 2) {
  //       boxes.push({ x0, y0, x1, y1 });
  //       return;
  //     }
  //     let subRadiance = 0;
  //     let vertSplit = x1 - x0 > y1 - y0;
  //     let xs, ys;
  //     if (vertSplit) {
  //       xs = x0;
  //       ys = y1;
  //       for (; xs < this.img.width; xs++) {
  //         let colEnergy = 0;
  //         for (let y = y0; y < ys; y++) {
  //           colEnergy += this._getRadiance(xs, y);
  //         }
  //         if (subRadiance + colEnergy < radiance / 2) {
  //           subRadiance += colEnergy;
  //         } else {
  //           break;
  //         }
  //       }
  //     } else {
  //       xs = x1;
  //       ys = y0;
  //       for (; ys < this.img.height; ys++) {
  //         let colEnergy = 0;
  //         for (let x = x0; x < xs; x++) {
  //           colEnergy += this._getRadiance(x, ys);
  //         }
  //         if (subRadiance + colEnergy < radiance / 2) {
  //           subRadiance += colEnergy;
  //         } else {
  //           break;
  //         }
  //       }
  //     }
  //     if (vertSplit) {
  //       biSplit(subRadiance, x0, y0, xs, ys, depth + 1);
  //       biSplit(radiance - subRadiance, xs, y0, x1, y1, depth + 1);
  //     } else {
  //       biSplit(subRadiance, x0, y0, xs, ys, depth + 1);
  //       biSplit(radiance - subRadiance, x0, ys, x1, y1, depth + 1);
  //     }
  //   }
  //   biSplit(totalRadiance, 0, 0, this.img.width, this.img.height, 0);
  //   return boxes;
  // }

  paintDebugImage() {
    const canvas = document.createElement('canvas');
    canvas.className = "debug"
    canvas.width = this.img.width;
    canvas.height = this.img.height;
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < this.strata.length; i++) {
      ctx.fillStyle = `rgb(
        ${Math.floor(255 * Math.abs(Math.sin(i * 2)))},
        ${Math.floor(255 * Math.abs(Math.cos(i)))},
        0)`;
      const stratum = this.strata[i];
      const x0 = stratum.x0;
      const y0 = stratum.y0;
      const x1 = stratum.x1;
      const y1 = stratum.y1;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    document.body.appendChild(canvas);
  }

  paintLookupDebugImage() {
    const canvas = document.createElement('canvas');
    canvas.className = "debug"
    canvas.width = this.img.width;
    canvas.height = this.img.height;
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < this.lookupData.length; i++) {
      const idx = this.lookupData[i]; 
      ctx.fillStyle = `rgb(
        ${Math.floor(255 * Math.abs(Math.sin(idx * 2)))},
        ${Math.floor(255 * Math.abs(Math.cos(idx)))},
        0)`;
      const stratum = this.strata[idx];
      const x0 = stratum.x0;
      const y0 = stratum.y0;
      const x1 = stratum.x1;
      const y1 = stratum.y1;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    document.body.appendChild(canvas);
  }

  _createLuminanceStrata() {
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
    let minRadiance = Math.max(totalRadiance / 256, brightestTexel / 2);
    let strata = this._biTreeSplitting(totalRadiance, minRadiance);
    console.log("Processing env took", (performance.now() - time) / 1000.0, "seconds for", strata.length, "bins");
    return strata;
  }

  async createLuminanceStrataBuffer() {
    let luminanceStrataBuffer = new WGSLPackedStructArray(RadianceBinStruct, this.strata.length);
    for (const strata of this.strata) {
      const bin = {
        x0: strata.x0 / this.img.width,
        y0: strata.y0 / this.img.height,
        x1: strata.x1 / this.img.width,
        y1: strata.y1 / this.img.height,
      }
      luminanceStrataBuffer.push(new RadianceBinStruct(bin));
    }
    return luminanceStrataBuffer
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

  createLookupTexture(device) {
    const extent = {
      width: this.img.width,
      height: this.img.height,
    };
    const layout = {
      bytesPerRow: this.img.width * 2,
      rowsPerImage: this.img.height,
    }
    const tex = device.createTexture({
      size: extent,
      dimension: '2d',
      format: 'r16sint',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.writeTexture({ texture: tex }, this.lookupData, layout, extent);
    return tex;
  }
}
