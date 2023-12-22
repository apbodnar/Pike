export class HDRLoader {
  constructor(url) {
    this.url = url;
    this.view = null;
  }

  async fetchBlob() {
    debugger;
    const blob = await fetch(this.url).then(r => r.blob());
    this.view = new DataView(await blob.arrayBuffer());
  }

  decodeRLE(rleData) {
    const array = [];

  }

  /**
   *  New run-length encoded
    In this format, the four scanline components (three primaries and
    exponent) are separated for better compression using adaptive
    run-length encoding (described by Glassner in Chapter II.8 of
    Graphics Gems II [Arvo91,p.89]). The record begins with an
    unnormalized pixel having two bytes equal to 2, followed by the
    upper byte and the lower byte of the scanline length (which must
    be less than 32768). A run is indicated by a byte with its highorder bit set, corresponding to a count with excess 128. A nonrun is indicated with a byte less than 128. The maximum
    compression ratio using this scheme is better than 100:1, but
    typical performance for Radiance pictures is more like 2:1.
  */

  parse() {
    const lines = []
    // scan lines until we get two new lines
    let line = '';
    let previous = ''
    let idx = 0;
    for (; ; idx++) {
      const byte = this.view.getInt8(idx);
      const char = String.fromCharCode(byte);
      if (char === '\n') {
        if (previous === '\n') {
          idx++;
          break;
        }
        lines.push(line);
        line = '';
      } else {
        line += char;
      }
      previous = char;
    }
    // scan the dimensions
    let dimLine = ''
    for (; ; idx++) {
      const byte = this.view.getInt8(idx);
      const char = String.fromCharCode(byte);
      if (char === '\n') {
        idx++;
        break
      }
      else {
        dimLine += char;
      }
    }
    const pattern = /-Y (\d+) \+X (\d+)/;
    const matches = dimLine.match(pattern);
    this.height = Number(matches[1]);
    this.width = Number(matches[2]);
    this.pixels = this.view.buffer.slice(idx);
    debugger;
  }

  static async load(url) {
    const loader = new HDRLoader(url);
    await loader.fetchBlob();
    loader.parse();
    return loader;
  }
}