const fs = require('node:fs/promises');
const path = require('node:path');

const IMAGE_TYPES = {
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif'
};
const TEMPLATE_IMAGES = {
  'paper-notes': ['main_illustration', 'top_doodle'],
  'sticker-journal': ['main_sticker'],
  'doodle-poster': []
};
// Older drafts and frozen proofs can still carry their original template IDs.
const LEGACY_TEMPLATES = new Map([
  ['preset-a', 'paper-notes'], ['preset-b', 'sticker-journal'],
  ['preset-c', 'doodle-poster'], ['preset-d', 'neon-cards']
]);
function canonicalTemplate(name) {
  return LEGACY_TEMPLATES.get(name) ?? name;
}
const TEXTURES = ['brush', 'paper', 'flourish', 'trailEnd'];
const SLOTS = new Set(['title', 'hero', 'blob', 'note', 'checklist', 'footer', 'tip', 'bubble', 'tag', 'scene', 'flourish', 'trailEnd']);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`);
  }
  return value;
}

function validateLayout(layout) {
  requireRecord(layout, '贴纸手帐布局');
  if (layout.variant !== undefined && layout.variant !== 'journal') {
    throw new Error('贴纸手帐仅支持 journal 版式');
  }
  for (const name of Object.keys(requireRecord(layout.textures ?? {}, 'layout.textures'))) {
    if (!TEXTURES.includes(name)) throw new Error(`未知的纹理：${name}`);
  }
  if (layout.hidden !== undefined && (!Array.isArray(layout.hidden) || layout.hidden.some(name => !SLOTS.has(name)))) {
    throw new Error('layout.hidden 需要已支持的区块名数组');
  }
  for (const [name, size] of Object.entries(requireRecord(layout.typography ?? {}, 'layout.typography'))) {
    if (!['line1', 'line2'].includes(name) || !Number.isFinite(size) || size < 56 || size > 1660) {
      throw new Error(`layout.typography.${name} 需要 56 至 1660 之间的标题字号`);
    }
  }
  for (const [name, slot] of Object.entries(requireRecord(layout.slots ?? {}, 'layout.slots'))) {
    if (!SLOTS.has(name)) throw new Error(`当前版式不支持区块定位：${name}`);
    for (const [key, value] of Object.entries(requireRecord(slot, 'layout.slots.' + name))) {
      if (!['x', 'y', 'width', 'height', 'rotate', 'z'].includes(key) || !Number.isFinite(value)) {
        throw new Error(`layout.slots.${name}.${key} 需要受支持的数值参数`);
      }
      if ((key === 'width' || key === 'height') && value <= 0) throw new Error(`${name} 区块的尺寸必须为正数`);
      if (key === 'z' && !Number.isInteger(value)) throw new Error(`${name} 区块的图层必须为整数`);
    }
  }
}

function validateSource(input) {
  if (input.schemaVersion !== 1 || input.template !== 'sticker-journal') {
    throw new Error('cover-source 版本 1 仅支持 sticker-journal');
  }
  requireRecord(input.analysis, 'analysis');
  if (!['text', 'image'].includes(input.analysis.input?.type)) {
    throw new Error('analysis.input.type 需要 text 或 image');
  }
  if (typeof input.visualReference?.path !== 'string' || !input.visualReference.path.trim()) {
    throw new Error('创作稿需要 visualReference.path，请指定参考图片');
  }
  const content = requireRecord(input.content, 'content');
  for (const field of ['title', 'body']) {
    if (typeof content[field] !== 'string' || !content[field].trim()) {
      throw new Error(`content.${field} 需要原创文本`);
    }
  }
  const cover = requireRecord(content.cover, 'content.cover');
  if (![cover.main_title_line1, cover.main_title_line2].some(v => typeof v === 'string' && v.trim())) {
    throw new Error('content.cover 需要至少一行封面标题');
  }
  for (const [field, value] of Object.entries(cover)) {
    if (field !== 'checklist' && typeof value !== 'string') throw new Error(`content.cover.${field} 需要字符串`);
  }
  if (cover.checklist !== undefined && (!Array.isArray(cover.checklist) ||
      cover.checklist.length > 4 || cover.checklist.some(v => typeof v !== 'string' || !v.trim()))) {
    throw new Error('content.cover.checklist 需要 0 至 4 条非空文案，请先选定要展示的条目');
  }
  const design = input.layout === undefined ? {} : input.layout;
  const assets = requireRecord(input.assets, 'assets');
  if (assets.stickers !== undefined && !Array.isArray(assets.stickers)) throw new Error('assets.stickers 需要数组');
  for (const [i, sticker] of (assets.stickers || []).entries()) {
    if (typeof sticker?.path !== 'string' || !sticker.path) throw new Error(`assets.stickers[${i}].path 缺少素材路径`);
  }
  if (assets.stickers?.filter(s => s.role === 'scene').length > 1) throw new Error('同一张贴纸手帐封面只支持一个 scene 主景物');
  if (assets.main_sticker_style?.focus !== undefined) {
    if (!assets.main_sticker) throw new Error('指定焦点时需要提供主图 assets.main_sticker');
    const { x, y } = requireRecord(assets.main_sticker_style.focus, 'assets.main_sticker_style.focus');
    if (![x, y].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('主图焦点 x/y 需要 0 到 1 的归一化坐标');
  }
  return { ...cover, template: input.template, design: structuredClone(design), assets: structuredClone(assets) };
}

async function readImage(reference, sourceDir, root, embedRemote) {
  if (typeof reference !== 'string' || !reference.trim()) throw new Error('素材引用需要文件路径或图片 URL');
  if (/^data:/i.test(reference)) {
    if (!/^data:image\//i.test(reference)) throw new Error('素材必须是图片 Data URL');
    return reference;
  }
  if (/^https?:\/\//i.test(reference)) {
    if (!embedRemote) return reference;
    const response = await fetch(reference, { signal: AbortSignal.timeout(30000) });
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!response.ok || !type?.startsWith('image/')) throw new Error(`在线图片不可用：${reference}`);
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  }
  const file = path.resolve(/^assets[\\/]/.test(reference) ? root : sourceDir, reference);
  const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`不支持的图片格式：${file}`);
  try {
    const bytes = await fs.readFile(file);
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`缺少素材：${file}`);
    throw error;
  }
}

async function prepareCover(input, sourcePath, root) {
  const structured = input.kind === 'cover-source';
  if (input.format !== undefined) throw new Error(`无法识别定稿格式：${input.format}`);
  if (input.kind !== undefined && !structured) throw new Error(`不支持的创作输入类型：${input.kind}`);
  const template = input.template ?? 'sticker-journal';
  if (typeof template !== 'string' || !Object.hasOwn(TEMPLATE_IMAGES, template)) {
    throw new Error(`不支持的 template 类型：${template}`);
  }
  const data = structured ? validateSource(input) : structuredClone(input);
  data.template = template;
  if (template === 'sticker-journal') {
    if (data.design === undefined) data.design = {};
    validateLayout(data.design);
    data.design.textures = { brush: 'assets/travel/brush.png', ...data.design.textures };
  } else {
    delete data.design;
  }
  const sourceDir = path.dirname(sourcePath);
  const load = ref => readImage(ref, sourceDir, root, structured);
  const assets = data.assets;
  if (assets) {
    for (const key of TEMPLATE_IMAGES[template]) {
      if (assets[key]) assets[key] = await load(assets[key]);
    }
    if (template !== 'paper-notes' && Array.isArray(assets.stickers)) {
      assets.stickers = await Promise.all(assets.stickers.map(async sticker => ({
        ...sticker, path: await load(sticker.path)
      })));
    }
  }
  const textures = data.design?.textures;
  if (textures) {
    for (const key of TEXTURES) if (textures[key]) textures[key] = await load(textures[key]);
  }
  return data;
}

module.exports = { prepareCover, canonicalTemplate, IMAGE_TYPES, SLOTS };
