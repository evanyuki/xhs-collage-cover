const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(field + ' 需要非空文案');
  return value.trim();
}

function textList(value, count, field) {
  if (!Array.isArray(value) || value.length !== count) throw new Error(field + ' 需要 ' + count + ' 段文案');
  return value.map((item, index) => requiredText(item, field + '[' + index + ']'));
}

function preparePictureSet(source) {
  const cover = source.cover;
  if (!cover || typeof cover !== 'object' || Array.isArray(cover)) throw new Error('neon-cards 需要 cover 对象');
  if (!Array.isArray(source.sections) || !source.sections.length) throw new Error('sections 至少需要一组内页内容');
  return {
    cover: {
      tiles: textList(cover.tiles, 4, 'cover.tiles'),
      audience: requiredText(cover.audience, 'cover.audience'),
      kicker: cover.kicker === undefined ? '' : requiredText(cover.kicker, 'cover.kicker'),
      ribbons: textList(cover.ribbons, 2, 'cover.ribbons')
    },
    sections: source.sections.map((section, index) => {
      const field = 'sections[' + index + ']';
      const heading = requiredText(section?.heading, field + '.heading');
      if (!Array.isArray(section.items) || !section.items.length) throw new Error(field + '.items 至少需要一条内容');
      const items = section.items.map((item, i) => ({
        title: requiredText(item?.title, field + '.items[' + i + '].title'),
        body: requiredText(item?.body, field + '.items[' + i + '].body')
      }));
      return { heading, items };
    })
  };
}

function pageName(index) {
  return index === 0 ? '01-cover.png' : String(index + 1).padStart(2, '0') + '-inside.png';
}

async function listOutputFiles(directory, ownLock) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === ownLock) continue;
    const owner = entry.isDirectory() && /^\.rendering-(\d+)-[a-zA-Z0-9]{6}$/.exec(entry.name);
    if (!owner) {
      files.push(entry.name);
      continue;
    }
    try {
      process.kill(Number(owner[1]), 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        // Only remove an empty reservation left by an exited renderer.
        try {
          await fs.rmdir(path.join(directory, entry.name));
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') throw cleanupError;
        }
        continue;
      }
      if (error.code !== 'EPERM') throw error;
    }
    throw new Error('另一渲染进程正在写入套图目录：' + directory);
  }
  return files;
}

// Only names from a previous, valid page index may be overwritten or retired.
async function publishSet(directory, images, sourcePath, writeOutputs, { inputPaths = [], references } = {}) {
  const manifestName = 'pages.json';
  const manifestPath = path.join(directory, manifestName);
  await fs.mkdir(directory, { recursive: true });
  // Claim before scanning. Concurrent writers see one another before making any changes.
  const lock = await fs.mkdtemp(path.join(directory, '.rendering-' + process.pid + '-'));
  try {
    const filenames = await listOutputFiles(directory, path.basename(lock));
    let previous = [];
    if (filenames.includes(manifestName)) {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (manifest?.format !== 'xhs-picture-set-v1' || !Array.isArray(manifest.pages) || manifest.pages.length < 2 ||
          manifest.pages.some((name, i) => name !== pageName(i))) {
        throw new Error('套图目录中的 pages.json 格式不符：' + manifestPath);
      }
      previous = manifest.pages;
    } else if (filenames.length) {
      throw new Error('请指定空目录，或使用已生成的套图目录：' + directory);
    }
    const pages = images.map((_, i) => pageName(i));
    const entries = pages.map((name, i) => [path.join(directory, name), images[i]]);
    for (const name of previous.slice(pages.length)) entries.push([path.join(directory, name), null]);
    entries.push([manifestPath, JSON.stringify({ format: 'xhs-picture-set-v1', pages, references }, null, 2) + '\n']);
    const pathKey = p => process.platform === 'win32' ? p.toLowerCase() : p;
    const occupied = new Set(filenames.map(pathKey));
    for (const name of pages.slice(previous.length)) {
      if (occupied.has(pathKey(name))) throw new Error('新页与目录中已有文件重名：' + name);
    }
    await protectInputs(entries.map(([target]) => target), [sourcePath, ...inputPaths]);
    await writeOutputs(entries);
    console.log(`套图共 ${pages.length} 页：${directory}`);
  } finally {
    await fs.rmdir(lock);
  }
}

async function renderPictureSet(page, set, directory, sourcePath, writeOutputs) {
  if (path.extname(directory).toLowerCase() === '.png') throw new Error('neon-cards 输出一组 PNG，请传套图目录路径');
  const template = path.resolve(__dirname, '../templates/neon-cards.html');
  await page.goto(pathToFileURL(template).href, { waitUntil: 'load' });
  await page.evaluate(cover => window.renderSetCover(cover), set.cover);
  const images = [await page.screenshot({ type: 'png' })];
  let startIndex = 0;
  for (const { heading, items } of set.sections) {
    const counts = await page.evaluate(({ heading, items, startIndex }) =>
      window.planSetInside(heading, items, startIndex), { heading, items, startIndex });
    if (!Array.isArray(counts) || counts.some(n => !Number.isInteger(n) || n < 1 || n > 5) ||
        counts.reduce((total, n) => total + n, 0) !== items.length) {
      throw new Error('内页分页结果与条目数不符：' + heading);
    }
    let offset = 0;
    for (const count of counts) {
      const batch = items.slice(offset, offset + count);
      const rendered = await page.evaluate(({ heading, batch, startIndex }) =>
        window.renderSetInside(heading, batch, startIndex), { heading, batch, startIndex });
      if (rendered.count !== count) throw new Error('内页实际排版与分页结果不符：' + heading);
      images.push(await page.screenshot({ type: 'png' }));
      offset += count;
      startIndex += count;
    }
  }
  await publishSet(directory, images, sourcePath, writeOutputs);
}

// Resolve existing symlinks too, since uploads and illustration assets can live beside the output.
async function protectInputs(targets, inputs) {
  async function canonical(file) {
    let resolved;
    try { resolved = await fs.realpath(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; resolved = path.resolve(file); }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  const paths = new Set(await Promise.all(inputs.map(canonical)));
  for (const target of targets) {
    if (paths.has(await canonical(target))) throw new Error('输出将覆盖创作稿、参考图或插画：' + target);
  }
}

module.exports = { preparePictureSet, renderPictureSet, publishSet, protectInputs };
