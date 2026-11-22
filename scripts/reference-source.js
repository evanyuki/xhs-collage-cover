const fs = require('node:fs/promises');
const path = require('node:path');
const { IMAGE_TYPES } = require('./cover-source');
const { sha256 } = require('./compare-png');

const HEX = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const COMMON = ['id', 'type', 'box', 'rotate', 'opacity'];
const FIELDS = {
  shape: ['fill', 'stroke', 'strokeWidth', 'radius', 'grid', 'gridColor', 'polygon'],
  text: ['bind', 'color', 'font', 'fontSize', 'minFontSize', 'weight', 'align', 'valign',
    'wrap', 'lineHeight', 'tracking', 'stroke', 'strokeWidth'],
  list: ['bind', 'font', 'weight', 'color', 'labelColor', 'titleColor', 'bodyColor',
    'labelSize', 'titleSize', 'bodySize', 'labelWidth', 'gap', 'lineGap', 'lineHeight'],
  image: ['asset', 'assetBind', 'crop', 'fit']
};
const CHOICES = {
  font: ['display', 'body', 'hand'], align: ['left', 'center', 'right'],
  valign: ['top', 'middle', 'bottom'], fit: ['contain', 'cover']
};
const COLORS = ['fill', 'stroke', 'color', 'gridColor', 'labelColor', 'titleColor', 'bodyColor'];
const POSITIVE = ['grid', 'fontSize', 'minFontSize', 'lineHeight', 'titleSize', 'labelSize', 'bodySize'];
const NONNEGATIVE = ['strokeWidth', 'radius', 'labelWidth', 'gap', 'lineGap'];
const FONT_TYPES = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };

function fail(field, message) {
  throw new Error(field + '：' + message);
}

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, '需要 JSON 对象');
  return value;
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(field, '需要非空字符串');
  return value;
}

function checkKeys(object, supported, field) {
  for (const key of Object.keys(object)) {
    if (!supported.includes(key)) fail(field + '.' + key, '不支持该字段');
  }
}

function normalized(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function point(value, field) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(normalized)) fail(field, '需要 0..1 的 [x,y]');
}

function box(value, field) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(normalized) ||
      value[2] <= 0 || value[3] <= 0 || value[0] + value[2] > 1.0000001 || value[1] + value[3] > 1.0000001) {
    fail(field, '需要页面内的 [x,y,宽,高]，单位为 0..1');
  }
}

function color(value, palette, field) {
  if (typeof value !== 'string' || !(HEX.test(value) || (value.startsWith('$') && Object.hasOwn(palette, value.slice(1))))) {
    fail(field, '需要十六进制颜色或已定义的 $调色名');
  }
}

function checkLayer(layer, palette, field) {
  record(layer, field);
  text(layer.id, field + '.id');
  if (typeof layer.type !== 'string' || !Object.hasOwn(FIELDS, layer.type)) fail(field + '.type', '需要 shape、text、image 或 list');
  checkKeys(layer, COMMON.concat(FIELDS[layer.type]), field);
  box(layer.box, field + '.box');
  for (const [key, value] of Object.entries(layer)) {
    const name = field + '.' + key;
    if (COLORS.includes(key)) color(value, palette, name);
    if (Object.hasOwn(CHOICES, key) && !CHOICES[key].includes(value)) fail(name, '可用值为 ' + CHOICES[key].join(' / '));
    if (POSITIVE.includes(key) && (!Number.isFinite(value) || value <= 0)) fail(name, '需要正数');
    if (NONNEGATIVE.includes(key) && (!Number.isFinite(value) || value < 0)) fail(name, '需要非负数');
    if (['rotate', 'tracking'].includes(key) && !Number.isFinite(value)) fail(name, '需要有限数值');
    if (key === 'opacity' && !normalized(value)) fail(name, '范围为 0..1');
    if (key === 'weight' && (!Number.isInteger(value) || value < 100 || value > 900)) fail(name, '字重范围为 100..900');
    if (key === 'wrap' && typeof value !== 'boolean') fail(name, '需要布尔值');
  }
  if (layer.type === 'text' || layer.type === 'list') text(layer.bind, field + '.bind');
  if (layer.minFontSize > layer.fontSize) fail(field, 'minFontSize 大于 fontSize');
  if (layer.polygon !== undefined) {
    if (!Array.isArray(layer.polygon) || layer.polygon.length < 3) fail(field + '.polygon', '至少需要三个顶点');
    layer.polygon.forEach((p, i) => point(p, field + '.polygon[' + i + ']'));
  }
  if (layer.type === 'image') {
    if (['asset', 'assetBind', 'crop'].filter(key => Object.hasOwn(layer, key)).length !== 1) {
      fail(field, '图片层需要在 asset、assetBind、crop 中选择一种');
    }
    if (layer.assetBind !== undefined) text(layer.assetBind, field + '.assetBind');
  }
}

function readLayers(design, palette, roles) {
  const shared = new Map();
  if (design.shared !== undefined && !Array.isArray(design.shared)) fail('design.shared', '需要图层数组');
  for (const [i, layer] of (design.shared || []).entries()) {
    checkLayer(layer, palette, 'design.shared[' + i + ']');
    if (shared.has(layer.id)) fail('design.shared', '图层 id 重复 ' + layer.id);
    shared.set(layer.id, layer);
  }
  const plans = {};
  for (const role of roles) {
    const sequence = design[role];
    if (!Array.isArray(sequence) || !sequence.length) fail('design.' + role, '需要按绘制顺序列出图层');
    const seen = new Set();
    plans[role] = sequence.map((entry, i) => {
      const field = 'design.' + role + '[' + i + ']';
      const layer = typeof entry === 'string' ? shared.get(entry) : entry;
      if (!layer) fail(field, '找不到图层 ' + entry);
      if (typeof entry !== 'string') checkLayer(layer, palette, field);
      if (seen.has(layer.id)) fail(field, '页内图层 id 重复 ' + layer.id);
      seen.add(layer.id);
      return layer;
    });
    const layers = plans[role];
    const listCount = layers.filter(layer => layer.type === 'list').length;
    if (listCount > 1) fail('design.' + role, '每个页面最多容纳一个自动排版的 list');
    if (role === 'cover' && !layers.some(layer => layer.bind || layer.type === 'image')) {
      fail('design.cover', '封面需要文字、列表或插画作为主体');
    }
  }
  return plans;
}

function checkBindings(layers, bindings, field) {
  for (const layer of layers) {
    if (!layer.bind) continue;
    const name = field + '.' + layer.bind;
    if (!Object.hasOwn(bindings, layer.bind)) fail(name, '缺少图层 ' + layer.id + ' 绑定的文案');
    const value = bindings[layer.bind];
    if (layer.type === 'text') {
      text(value, name);
    } else {
      if (!Array.isArray(value) || !value.length) fail(name, '需要非空条目数组');
      for (const [index, item] of value.entries()) {
        const row = name + '[' + index + ']';
        record(item, row);
        checkKeys(item, ['label', 'title', 'body'], row);
        text(item.title, row + '.title');
        text(item.body, row + '.body');
        if (item.label !== undefined) text(item.label, row + '.label');
      }
    }
  }
}

function prepareContent(input, plans) {
  record(input, 'content');
  const cover = { ...record(input.cover, 'content.cover') };
  checkBindings(plans.cover, cover, 'content.cover');
  if (!plans.inside) {
    if (input.sections !== undefined && (!Array.isArray(input.sections) || input.sections.length)) {
      fail('content.sections', '有内页内容时需提供对应的内页参考与设计');
    }
    return { cover };
  }
  if (!Array.isArray(input.sections) || !input.sections.length) fail('content.sections', '提供内页参考后至少需要一节内容');
  const sections = input.sections.map((section, i) => {
    const name = 'content.sections[' + i + ']';
    const bindings = { ...cover, ...record(section, name) };
    checkBindings(plans.inside, bindings, name);
    return bindings;
  });
  return { cover, sections };
}

function localPath(value, field, base, assetRoot) {
  text(value, field);
  if (!path.isAbsolute(value) && /^[a-z][a-z\d+.-]*:/i.test(value)) fail(field, '需要本地文件路径');
  return path.resolve(assetRoot && /^assets[\\/]/.test(value) ? assetRoot : base, value);
}

async function readLocalImage(file, field = '参考图') {
  const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!mime) fail(field, '不支持的图片格式 ' + file);
  const bytes = await fs.readFile(file);
  return { url: 'data:' + mime + ';base64,' + bytes.toString('base64'), hash: sha256(bytes) };
}

async function prepareFonts(specs, sourceDir, root, inputPaths) {
  if (specs === undefined) return undefined;
  record(specs, 'design.fonts');
  checkKeys(specs, CHOICES.font, 'design.fonts');
  const fonts = {};
  const loaded = new Map();
  for (const [name, spec] of Object.entries(specs)) {
    const field = 'design.fonts.' + name;
    checkKeys(record(spec, field), ['path', 'weight'], field);
    const file = localPath(spec.path, field + '.path', sourceDir, root);
    const weight = spec.weight === undefined ? 400 : spec.weight;
    if (!Number.isInteger(weight) || weight < 100 || weight > 900) fail(field + '.weight', '字重范围为 100..900');
    const mime = FONT_TYPES[path.extname(file).toLowerCase()];
    if (!mime) fail(field + '.path', '支持 WOFF2、WOFF、TTF 或 OTF 字体');
    if (!loaded.has(file)) {
      try {
        const bytes = await fs.readFile(file);
        loaded.set(file, 'data:' + mime + ';base64,' + bytes.toString('base64'));
      } catch (error) {
        fail(field + '.path', '无法读取字体 ' + file + ' (' + error.message + ')');
      }
    }
    inputPaths.add(file);
    fonts[name] = { src: loaded.get(file), weight };
  }
  return fonts;
}

// This function runs in Chromium. Decode once, sampling pixels and extracting
// transparent crops from the source at its natural resolution.
async function inspectPixels({ url, samples = [], crops = [], paletteSize = 0 }) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error('图片没有可用尺寸');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  function sample([x, y]) {
    const sx = Math.min(width - 1, Math.floor(width * x));
    const sy = Math.min(height - 1, Math.floor(height * y));
    ctx.clearRect(0, 0, 1, 1);
    ctx.drawImage(image, sx, sy, 1, 1, 0, 0, 1, 1);
    const rgba = [...ctx.getImageData(0, 0, 1, 1).data];
    if (rgba[3] === 255) rgba.pop();
    return '#' + rgba.map(n => n.toString(16).padStart(2, '0')).join('');
  }
  const colors = samples.map(sample);
  const palette = [];
  if (paletteSize > 0) {
    const scale = Math.min(1, 192 / Math.max(width, height));
    const w = canvas.width = Math.max(1, Math.round(scale * width));
    const h = canvas.height = Math.max(1, Math.round(scale * height));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const bins = new Map();
    let opaque = 0;
    for (let i = 0; i < w * h; i++) {
      const [r, g, b, a] = rgba.subarray(i * 4, i * 4 + 4);
      if (a < 128) continue;
      opaque++;
      const bin = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
      // Prefer a coordinate inside a flat region over a boundary pixel.
      const left = i % w ? (i - 1) * 4 : i * 4;
      const above = i >= w ? (i - w) * 4 : i * 4;
      let contrast = i % w === 0 || i < w ? Infinity : 0;
      for (let c = 0; c < 3; c++) {
        contrast += Math.abs(rgba[i * 4 + c] - rgba[left + c]) + Math.abs(rgba[i * 4 + c] - rgba[above + c]);
      }
      if (!bins.has(bin)) bins.set(bin, { count: 0, contrast: Infinity, index: i });
      const group = bins.get(bin);
      group.count++;
      if (contrast < group.contrast) Object.assign(group, { contrast, index: i });
    }
    canvas.width = canvas.height = 1;
    for (const { count, index } of [...bins.values()].sort((a, b) => b.count - a.count).slice(0, paletteSize)) {
      const at = [((index % w) + 0.5) / w, (Math.floor(index / w) + 0.5) / h];
      palette.push({ color: sample(at), fraction: count / opaque, at });
    }
  }
  const images = crops.map(([x, y, w, h]) => {
    const sx = Math.min(width - 1, Math.floor(width * x));
    const sy = Math.min(height - 1, Math.floor(height * y));
    canvas.width = Math.max(1, Math.min(width, Math.round(width * (x + w))) - sx);
    canvas.height = Math.max(1, Math.min(height, Math.round(height * (y + h))) - sy);
    ctx.drawImage(image, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  });
  return { width, height, colors, images, palette };
}

async function prepareReferenceSource(source, sourcePath, root, browserPage) {
  if (source.kind !== 'reference-source' || source.schemaVersion !== 1) fail('reference-source', '需要版本 1 的创作稿');
  const refs = record(source.references, 'references');
  checkKeys(refs, ['cover', 'inside'], 'references');
  const roles = Object.hasOwn(refs, 'inside') ? ['cover', 'inside'] : ['cover'];
  const design = record(source.design, 'design');
  if (!refs.inside && design.inside !== undefined) fail('design.inside', '缺少 references.inside');
  const palette = record(design.colors ?? {}, 'design.colors');
  const plans = readLayers(design, palette, roles);
  const content = prepareContent(source.content, plans);
  const inputPaths = new Set();
  const fonts = await prepareFonts(design.fonts, path.dirname(sourcePath), root, inputPaths);
  const references = {};
  const colors = Object.create(null);
  const images = new Map();
  const assets = new Map();
  const work = Object.fromEntries(roles.map(role => [role, { samples: [], crops: [] }]));
  for (const [key, value] of Object.entries(palette)) {
    const field = 'design.colors.' + key;
    if (typeof value === 'string') {
      if (!HEX.test(value)) fail(field, '需要十六进制颜色或取色坐标');
      colors[key] = value;
    } else {
      record(value, field);
      if (!roles.includes(value.from)) fail(field, '引用了不存在的参考图角色');
      point(value.at, field + '.at');
      work[value.from].samples.push({ key, at: value.at });
    }
  }
  const layers = new Set(Object.values(plans).flat());
  async function loadAsset(value, field) {
    const file = localPath(value, field, path.dirname(sourcePath), root);
    if (!assets.has(file)) assets.set(file, await readLocalImage(file, field));
    inputPaths.add(file);
    return assets.get(file).url;
  }
  for (const layer of layers) {
    if (layer.type !== 'image') continue;
    if (layer.asset !== undefined) {
      images.set(layer, await loadAsset(layer.asset, layer.id + '.asset'));
    } else if (layer.crop !== undefined) {
      const crop = record(layer.crop, layer.id + '.crop');
      if (!roles.includes(crop.from)) fail(layer.id + '.crop.from', '引用了不存在的参考图角色');
      box(crop.box, layer.id + '.crop.box');
      if (crop.box[2] * crop.box[3] >= 0.999999) fail(layer.id + '.crop.box', '请框选无字局部素材');
      work[crop.from].crops.push(layer);
    }
  }
  for (const role of roles) {
    const keys = new Set(plans[role].filter(layer => layer.assetBind).map(layer => layer.assetBind));
    for (const key of keys) {
      if (plans[role].some(layer => layer.bind === key)) fail(key, '同一页的配图和文字应使用不同的内容字段');
      for (const data of role === 'cover' ? [content.cover] : content.sections) {
        if (!Object.hasOwn(data, key)) fail(role + '.' + key, '缺少绑定的图片路径');
        data[key] = await loadAsset(data[key], role + '.' + key);
      }
    }
  }
  for (const role of roles) {
    const field = 'references.' + role;
    const ref = record(refs[role], field);
    if (!Array.isArray(ref.observations) || !ref.observations.length) fail(field + '.observations', '请记录对该图的版式观察');
    ref.observations.forEach((value, i) => text(value, field + '.observations[' + i + ']'));
    const file = localPath(ref.path, field + '.path', path.dirname(sourcePath));
    inputPaths.add(file);
    const { url, hash } = await readLocalImage(file, field);
    if (ref.sha256 !== undefined && (typeof ref.sha256 !== 'string' || ref.sha256.toLowerCase() !== hash)) {
      fail(field + '.sha256', '所选参考图与稿件记录不同 ' + file);
    }
    if ([...assets.values()].some(asset => asset.hash === hash)) fail(field, '参考整图不能作为插画素材，请框选局部或指定单独图片');
    const { samples, crops } = work[role];
    let scan;
    try {
      scan = await browserPage.evaluate(inspectPixels, {
        url, samples: samples.map(sample => sample.at), crops: crops.map(layer => layer.crop.box)
      });
    } catch (error) {
      fail(field, '无法解码或读取参考图 ' + file + ' (' + error.message + ')');
    }
    references[role] = { width: scan.width, height: scan.height, sha256: hash };
    samples.forEach(({ key }, i) => { colors[key] = scan.colors[i]; });
    crops.forEach((layer, i) => images.set(layer, scan.images[i]));
  }
  const pages = Object.fromEntries(roles.map(role => {
    const { width, height } = references[role];
    const layers = plans[role].map(layer => {
      if (layer.type !== 'image' || layer.assetBind) return layer;
      const { asset, crop, ...placement } = layer;
      return { ...placement, src: images.get(layer) };
    });
    const page = { width, height, layers, colors };
    if (fonts) page.fonts = fonts;
    return [role, page];
  }));
  return { pages, content, references, inputPaths: [...inputPaths] };
}

module.exports = { prepareReferenceSource, inspectPixels, readLocalImage };
