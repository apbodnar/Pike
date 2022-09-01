const imageExtRegex = /(\.png$)|(\.bmp$)|(\.jpg$)|(\.jpeg$)/;

export async function loadAll(urls) {
  async function fetchAsset(url) {
    if (url.toLowerCase().match(imageExtRegex)) {
      try {
        return await getImage(url);
      } catch (e) {
        console.log(e, url);
        return new Image(1,1);
      }
    } else {
      return getText(url);
    }
  }
  const assets = await Promise.all(urls.map(fetchAsset));
  const assetMap = {};
  for (let i = 0; i< urls.length; i++) {
    assetMap[urls[i]] = assets[i];
  }
  return assetMap;
}

export async function getText(path) {
  return fetch(path).then(r => r.text());
}

export async function getImage(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {resolve(img)};
    img.src = path;
  });
}

export function uploadDataUrl(path, blob, callback) {
  let req = new XMLHttpRequest();
  req.addEventListener("load", function (res) {
    callback.apply(null, [res]);
  });
  req.open("POST", path, true);
  req.send(blob);
}

class QueueNode {
  constructor(el) {
    this.el = el;
    this.prev = null;
    this.next = null;
  }
}

export class Queue {
  constructor() {
    this.front = null;
    this.back = null;
  }

  enqueue(el) {
    const node = new QueueNode(el);
    if (!this.back || !this.front) {
      this.front = this.back = node;
    } else {
      node.next = this.back;
      node.next.prev = node;
      this.back = node;
    }
  }

  dequeue() {
    let node = this.front;
    this.front = node.prev;
    return node.el;
  }

  hasElements() {
    return !!this.front;
  }
}
