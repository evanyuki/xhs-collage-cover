const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { prepareReferenceSource } = require('./reference-source');
const { publishSet, protectInputs } = require('./picture-set');

const template = pathToFileURL(path.resolve(__dirname, '../templates/reference-scene.html')).href;

async function captureRole(browser, scene, sections, isCover) {
  // Lay out text in the measured reference coordinates. Rasterize at the project's normal width.
  const page = await browser.newPage({
    viewport: { width: scene.width, height: scene.height },
    deviceScaleFactor: 1242 / scene.width
  });
  try {
    await page.goto(template, { waitUntil: 'load' });
    await page.evaluate(async scene => {
      window.referenceScene = scene;
      await window.loadReferenceFonts(scene.fonts);
    }, scene);
    const list = scene.layers.find(layer => layer.type === 'list');
    const images = [];
    for (const content of sections) {
      await page.evaluate(content => { window.referenceContent = content; }, content);
      const length = list ? content[list.bind].length : 0;
      let offset = 0;
      do {
        const { count } = await page.evaluate(offset =>
          window.renderReferencePage({ ...window.referenceScene, content: window.referenceContent, offset }), offset);
        if (list && (!Number.isInteger(count) || count < 1 || count > length - offset)) {
          throw new Error('内页分页未能完整消费条目：' + list.bind);
        }
        if (isCover && count < length) throw new Error('独立封面的列表需要完整排在一张图内：' + list.bind);
        images.push(await page.screenshot({ type: 'png' }));
        offset += count;
      } while (offset < length);
    }
    return images;
  } finally {
    await page.close();
  }
}

async function renderReference(browser, source, dataPath, root, outputPath, writeOutputs) {
  const decoder = await browser.newPage();
  let draft;
  try {
    draft = await prepareReferenceSource(source, dataPath, root, decoder);
  } finally {
    await decoder.close();
  }
  const { pages, content, inputPaths, references } = draft;
  const pngPath = path.extname(outputPath).toLowerCase() === '.png';
  if (Boolean(pages.inside) === pngPath) {
    throw new Error(pages.inside ? '封面加内页请指定套图目录' : '独立封面请指定输出 .png 文件');
  }
  const images = await captureRole(browser, pages.cover, [content.cover], true);
  if (pages.inside) {
    const inside = await captureRole(browser, pages.inside, content.sections, false);
    await publishSet(outputPath, images.concat(inside), dataPath, writeOutputs, { inputPaths, references });
  } else {
    await protectInputs([outputPath], [dataPath, ...inputPaths]);
    await writeOutputs([[outputPath, images[0]]]);
    console.log('参考封面：' + outputPath);
  }
}

module.exports = { renderReference };
