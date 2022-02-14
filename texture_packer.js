class ImageTransform {
  constructor(scaleU, scaleV, translateU, translateV, idx, image) {
    this.translateU = translateU;
    this.translateV = translateV;
    this.scaleU = scaleU;
    this.scaleV = scaleV;
    this.idx = idx;
    this.image = image;
  }

  toArray() {
    return [this.scaleU, this.scaleV, this.translateU, this.translateV];
  }
}

class ImageLayer {
  constructor(width, height, idx) {
    this.width = width;
    this.height = height;
    this.currentHeight = 0;
    this.currentWidth = 0;
    this.rowHeight = 0;
    this.idx = idx;
  }

  remainingWidth() {
    return this.width - this.currentWidth;
  }

  remainingHeight() {
    return this.height - this.currentHeight;
  }

  fitImage(image, writer) {
    // Scan row by row.
    while (image.height <= this.remainingHeight()) {
      if (image.width > this.remainingWidth()) {
        this.currentHeight += this.rowHeight;
        this.currentWidth = 0;
      }
      if (image.width <= this.remainingWidth() && image.height <= this.remainingHeight()) {
        this.rowHeight = Math.max(image.height, this.rowHeight);
        const translateU = this.currentWidth / this.width;
        const translateV = this.currentHeight / this.height;
        const scaleU = image.width / this.width;
        const scaleV = image.height / this.height;
        this.currentWidth += image.width;
        return new ImageTransform(scaleU, scaleV, translateU, translateV, this.idx, image);
      }
    }
    return null;
  }
}

export class TexturePacker {
  constructor(atlasRes) {
    this.res = atlasRes;
    this.imageSet = [];
    this.imageKeys = {};
    this.imageMap = {};
    this.maxRes = 1;
  }

  // addTexture(image, corrected) {
  //   if (this.imageKeys[image.currentSrc]) {
  //     return this.imageKeys[image.currentSrc]
  //   } else {
  //     this.maxRes = Math.max(this.maxRes, image.height);
  //     image.corrected = corrected;
  //     this.imageSet.push(image);
  //     this.imageKeys[image.currentSrc] = this.imageSet.length - 1;
  //     return this.imageKeys[image.currentSrc];
  //   }
  // }

  // addColor(color) {
  //   let key = color.join(' ');
  //   if (this.imageKeys[key] !== undefined) {
  //     return this.imageKeys[key]
  //   } else {
  //     this.imageSet.push(color);
  //     this.imageKeys[key] = this.imageSet.length - 1;
  //     return this.imageKeys[key];
  //   }
  // }

  addTexture(image, corrected) {
    if (this.imageKeys[image.currentSrc]) {
      return this.imageKeys[image.currentSrc]
    } else {
      this.maxRes = Math.max(this.maxRes, image.height);
      image.corrected = corrected;
      this.imageSet.push(image);
      this.imageKeys[image.currentSrc] = this.imageSet.length - 1;
      return this.imageKeys[image.currentSrc];
    }
  }

  addColor(color) {
    let key = color.join(' ');
    if (this.imageKeys[key] !== undefined) {
      return this.imageKeys[key]
    } else {
      this.imageSet.push(color);
      this.imageKeys[key] = this.imageSet.length - 1;
      return this.imageKeys[key];
    }
  }

  getResolution() {
    if (this.maxRes < this.res) {
      console.log("Using texture dimensions of " + this.maxRes + "px instead of specified " + this.res + "px.")
      this.res = this.maxRes;
    }
    return [this.res, this.res, this.imageSet.length];
  }

  getPixels() {
    let time = new Date().getTime();
    //let writer = new Canvas2DTextureWriter(this.res, this.res);
    let writer = new WebGLTextureWriter(this.res);
    let pixels = new Uint8Array(this.res * this.res * 4 * this.imageSet.length);
    for (let i = 0; i < this.imageSet.length; i++) {
      let img = this.imageSet[i];
      if (Array.isArray(img)) {
        writer.drawColor(img);
      } else {
        writer.drawTexture(img);
      }
      let pixBuffer = writer.getPixels();
      let offset = i * this.res * this.res * 4;
      pixels.set(pixBuffer, offset)
    }
    console.log("Textures packed in ", (new Date().getTime() - time) / 1000.0, " seconds");
    return pixels;
  }

  reserveImages(images) {
    this.images = images;
    this.height = -Infinity;
    this.width = -Infinity;
    // Modern sort is stable. Sort by width then height.
    this.images.sort((a, b) => {
      return b.width - a.width;
    });
    this.images.sort((a, b) => {
      return b.height - a.height;
    });
    for (const image of this.images) {
      this.height = Math.max(image.height, this.height);
      this.width = Math.max(image.width, this.width);
    }
    const imageLayers = [];
    let currentLayer = new ImageLayer(this.width, this.height, imageLayers.length);
    for (const image of this.images) {
      const transform = currentLayer.fitImage(image);
      if (transform) {
        this.imageMap[image.src] = transform;
      } else {
        imageLayers.push(currentLayer);
        currentLayer = new ImageLayer(this.width, this.height, imageLayers.length);
      }
    }
  }
}

// Incorrect because i'm too lazy to manually handle srgb
class Canvas2DTextureWriter {
  constructor(width, height) {
    this.canvasElement = document.createElement('canvas');
    this.srgbCanvasElement = document.createElement('canvas');
    this.canvasElement.width = width;
    this.canvasElement.height = height;
    this.ctx = this.canvasElement.getContext('2d');
    //this.ctx = this.canvasElement.getContext('2d', {colorSpace: 'linear'});
  }

  drawColor(color) {
    this.ctx.fillStyle = `rgb(
      ${Math.floor(255 * color[0])},
      ${Math.floor(255 * color[1])},
      ${Math.floor(255 * color[2])},
    0)`;
    this.ctx.fillRect(0, 0, this.canvasElement.width, this.canvasElement.height);
  }

  drawTexture(img) {
    this.ctx.fillStyle = 'black';
    this.ctx.fillRect(0, 0, this.canvasElement.width, this.canvasElement.height);
    this.ctx.drawImage(img, 0, 0, this.canvasElement.width, this.canvasElement.height);
  }

  getPixels() {
    return this.ctx.getImageData(0, 0, this.canvasElement.width, this.canvasElement.height).data;
  }
}

class WebGLTextureWriter {
  constructor(atlasRes) {
    this.res = atlasRes;
    this.canvasElement = document.createElement('canvas');
    this.canvasElement.width = atlasRes;
    this.canvasElement.height = atlasRes;
    let gl = this.gl = this.canvasElement.getContext("webgl2", {
      preserveDrawingBuffer: true,
      antialias: false,
      powerPreference: "high-performance"
    });

    function getShader(str, id) {
      let shader = gl.createShader(gl[id]);
      gl.shaderSource(shader, str);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.log(id + gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    }

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    let vsStr = `#version 300 es
    precision highp float;
    uniform vec4 transform;
    out vec2 texCoord;
    void main(void) {
      vec2 positions[4] = vec2[](      
        vec2(1.0, -1.0),
        vec2(1.0, 1.0),
        vec2(-1.0, -1.0),
        vec2(-1.0, 1.0)
      );
      vec2 uvs[4] = vec2[](      
        vec2(1.0, 0),
        vec2(1.0, 1.0),
        vec2(0, 0),
        vec2(0, 1.0)
      );
      texCoord = uvs[gl_VertexID];
      gl_Position = vec4(positions[gl_VertexID] * transform.xy + transform.zw * 2.0, 0, 1.0);
    }
    `;
    let fsStr = `#version 300 es
    precision highp float;
    uniform sampler2D tex;
    in vec2 texCoord;
    out vec4 fragColor;
    void main(void) {
      vec2 uv = texCoord;
      uv.y = uv.y;
      vec4 c = texture(tex, uv);
      fragColor = vec4(c.rgb * c.a, 1.0);
    }`;
    let fs = getShader(fsStr, "FRAGMENT_SHADER");
    let vs = getShader(vsStr, "VERTEX_SHADER");
    this.program = gl.createProgram();
    let uniforms = ["tex", "transform"];
    this.program.uniforms = {};
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.useProgram(this.program);
    uniforms.forEach((name) => {
      this.program.uniforms[name] = gl.getUniformLocation(this.program, name);
    });
  }

  drawColor(color) {
    let gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(color[0], color[1], color[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  drawTransformedColor(color, transform) {
    let gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(
      Math.round(this.canvasElement.width * transform.translateU),
      Math.round(this.canvasElement.height * transform.translateV),
      1,
      1
    );
    gl.clearColor(color[0], color[1], color[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  drawTexture(img) {
    let gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (img.corrected) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(0, 0, this.canvasElement.width, this.canvasElement.height);
    gl.uniform1i(this.program.uniforms.tex, 0);
    gl.uniform4fv(this.program.uniforms.transform, [1, 1, 0, 0]);
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  drawTransformedImage(image, transform) {
    let gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (image.corrected) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(0, 0, this.canvasElement.width, this.canvasElement.height);
    gl.uniform1i(this.program.uniforms.tex, 0);
    gl.uniform4fv(this.program.uniforms.tex, transform.toArray());
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  getPixels() {
    let gl = this.gl;
    let pixels = new Uint8Array(this.canvasElement.width * this.canvasElement.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.canvasElement.width, this.canvasElement.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels, 0);
    return pixels;
  }
}