const fs = require('node:fs/promises');
const path = require('node:path');
const { PNG } = require('playwright-core/lib/utilsBundle');
const { sha256 } = require('./compare-png');
const { canonicalTemplate, IMAGE_TYPES, SLOTS } = require('./cover-source');
const { isCoverProof, validateProofManifest } = require('./cover-proof');
const { protectInputs } = require('./picture-set');

const COMPOSITIONS = new Set(['portrait', 'landscape', 'text']);
const STRUCTURE = ['title', 'hero', 'scene', 'note', 'checklist'];

function localFile(value, sourcePath, field) {
  if (typeof value !== 'string' || !value.trim() ||
      (!path.isAbsolute(value) && /^[a-z][a-z\d+.\-]*:/i.test(value))) {
    throw new Error('visualReference.' + field + ' 需要本地文件路径');
  }
  return path.resolve(path.dirname(sourcePath), value);
}

async function readCompanion(file, explicit) {
  let bytes;
  try {
    bytes = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && !explicit) return null;
    throw error;
  }
  const candidate = JSON.parse(bytes.replace(/^\uFEFF/, ''));
  if (!isCoverProof(candidate)) {
    if (explicit) throw new Error('visualReference.proof 需要贴纸手帐的定稿 JSON');
    return null;
  }
  validateProofManifest(candidate);
  return candidate;
}

async function loadVisualReference(ref, sourcePath, page, outputPaths) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error('visualReference 需要对象');
  const file = localFile(ref.path, sourcePath, 'path');
  const extension = path.extname(file).toLowerCase();
  if (!IMAGE_TYPES[extension]) throw new Error('不支持的参考图片格式：' + file);
  if (ref.composition !== undefined && !COMPOSITIONS.has(ref.composition)) {
    throw new Error('visualReference.composition 需要 portrait、landscape 或 text');
  }
  if (ref.requiredSlots !== undefined && (!Array.isArray(ref.requiredSlots) ||
      !ref.requiredSlots.length || ref.requiredSlots.some(name => !SLOTS.has(name)))) {
    throw new Error('visualReference.requiredSlots 需要非空的贴纸手帐区块名数组');
  }
  if (ref.observations !== undefined && (!Array.isArray(ref.observations) ||
      !ref.observations.length || ref.observations.some(item => typeof item !== 'string' || !item.trim()))) {
    throw new Error('visualReference.observations 需要非空字符串数组');
  }
  const bytes = await fs.readFile(file);
  const fileHash = sha256(bytes);
  if (ref.sha256 !== undefined && (typeof ref.sha256 !== 'string' || ref.sha256.toLowerCase() !== fileHash)) {
    throw new Error('参考图片的 SHA-256 与 visualReference.sha256 不符：' + ref.path);
  }

  const explicit = ref.proof !== undefined;
  if (explicit && extension !== '.png') throw new Error('与定稿配对时请选择该定稿导出的 PNG');
  const proofFile = explicit ? localFile(ref.proof, sourcePath, 'proof') : path.join(path.dirname(file), path.parse(file).name + '.json');
  const proof = extension === '.png' ? await readCompanion(proofFile, explicit) : null;
  const inputs = extension === '.png' ? [file, proofFile] : [file];
  await protectInputs(outputPaths, inputs);

  // Decode the chosen image itself. A sibling proof can only supply geometry
  // after its canvas size and decoded pixels have been matched to this PNG.
  let width, height, rgbaSha256;
  if (extension === '.png') {
    const image = PNG.sync.read(bytes);
    ({ width, height } = image);
    if (proof) rgbaSha256 = sha256(image.data);
  } else {
    const url = 'data:' + IMAGE_TYPES[extension] + ';base64,' + bytes.toString('base64');
    ({ width, height } = await page.evaluate(async src => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    }, url));
  }
  if (!width || !height) throw new Error('参考图没有可用的图像尺寸');

  const plan = { sha256: fileHash, composition: ref.composition, requiredSlots: [...new Set(ref.requiredSlots)] };
  if (proof) {
    if (proof.render.rgbaSha256 !== rgbaSha256 || proof.render.width !== width || proof.render.height !== height) {
      throw new Error('参考 PNG 的尺寸或 RGBA 像素与参考定稿不符：' + proofFile);
    }
    const layout = proof.resolvedLayout;
    if (!COMPOSITIONS.has(layout?.composition) || !layout.resolvedSlots || canonicalTemplate(proof.source?.template) !== 'sticker-journal') {
      throw new Error('参考定稿缺少可复用的贴纸手帐版式');
    }
    if (proof.source.layout?.variant !== undefined && proof.source.layout.variant !== 'journal') {
      throw new Error('参考定稿的布局不适用于当前贴纸手帐');
    }
    if (plan.composition && plan.composition !== layout.composition) throw new Error('指定的构图与所选参考定稿的实际构图不同');
    plan.composition = layout.composition;
    plan.proofIntegrity = proof.integrity;
    plan.regions = Object.fromEntries(STRUCTURE.filter(name => layout.resolvedSlots[name]).map(name => [name, layout.resolvedSlots[name]]));
    plan.requiredSlots = [...new Set([...Object.keys(plan.regions), ...plan.requiredSlots])];
  } else {
    if (!plan.composition || !plan.requiredSlots.length || !ref.observations?.length) {
      throw new Error('普通参考图需要填写 visualReference.composition、requiredSlots 和 observations');
    }
    const structure = STRUCTURE.filter(name => plan.requiredSlots.includes(name));
    const primary = plan.composition === 'text' ? 'title' : 'hero';
    if (!structure.includes(primary) || structure.length < 2) {
      throw new Error('普通参考图的 requiredSlots 需包含 ' + primary + ' 及另一结构区块（title/hero/scene/note/checklist）');
    }
  }
  return plan;
}

function checkVisualReference(plan, layout, canvas) {
  const problems = [];
  if (layout?.composition !== plan.composition) problems.push('参考构图为 ' + plan.composition + '，实际主图构图为 ' + layout?.composition);
  for (const name of plan.requiredSlots) {
    const rect = layout?.resolvedSlots?.[name];
    if (!rect || rect.width <= 0 || rect.height <= 0 || rect.x >= canvas.width || rect.y >= canvas.height ||
        rect.x + rect.width <= 0 || rect.y + rect.height <= 0) {
      problems.push('画面缺少可见的 ' + name + ' 区块');
      continue;
    }
    if (name === 'hero' && plan.composition === 'portrait' && rect.width >= 1.2 * rect.height) {
      problems.push('竖版参考的主角区域被排成横幅');
    }
    const region = plan.regions?.[name];
    if (!region) continue;
    // Permit copy reflow and a different pose without losing the reference's
    // major placements. Distances are proportions of the full canvas.
    const dx = Math.abs(rect.x + rect.width / 2 - region.x - region.width / 2) / canvas.width;
    const dy = Math.abs(rect.y + rect.height / 2 - region.y - region.height / 2) / canvas.height;
    if (dx > 0.18 || dy > 0.16) problems.push(name + ' 的中心偏离参考位置过远');
    if (name === 'hero' || name === 'scene') {
      const ratios = [rect.width / region.width, rect.height / region.height];
      if (ratios.some(value => value < 0.6 || value > 1.55)) problems.push(name + ' 的尺寸偏离参考主次关系');
    }
  }
  if (problems.length) throw new Error('参考图版式校验失败：' + problems.join('；'));
}

module.exports = { loadVisualReference, checkVisualReference };
