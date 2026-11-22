const { createHash } = require('node:crypto');
const { PNG } = require('playwright-core/lib/utilsBundle');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function rgbaSha256(png) {
  return sha256(PNG.sync.read(png).data);
}

function comparePngBuffers(first, second) {
  const a = PNG.sync.read(first);
  const b = PNG.sync.read(second);
  const result = {
    width: a.width, height: a.height, otherWidth: b.width, otherHeight: b.height,
    totalPixels: a.width * a.height, differentPixels: null, maxChannelDiff: null,
    identical: false
  };
  if (a.width !== b.width || a.height !== b.height) return result;

  let different = 0;
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
      Math.abs(a.data[i + 3] - b.data[i + 3])
    );
    if (delta !== 0) different++;
    if (delta > max) max = delta;
  }
  return { ...result, differentPixels: different, maxChannelDiff: max, identical: different === 0 };
}

module.exports = { comparePngBuffers, rgbaSha256, sha256 };
