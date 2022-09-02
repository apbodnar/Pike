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
    for 
  }

  parse() {
    const lines = []
    // scan lines until we get two new lines
    let line = '';
    let previous = ''
    let idx = 0;
    for(;;idx++) {
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
    for(;;idx++) {
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