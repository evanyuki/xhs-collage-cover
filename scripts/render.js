#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');
const { prepareCover, canonicalTemplate } = require('./cover-source');
const { preparePictureSet, renderPictureSet } = require('./picture-set');
const { renderReference } = require('./render-reference');
const { readLocalImage, inspectPixels } = require('./reference-source');
const { loadVisualReference, checkVisualReference } = require('./visual-reference');
const { captureProof, isCoverProof, replayProof, settleAuthorPage } = require('./cover-proof');

const ROOT_DIR = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const positional = [];
  const flags = {
    checkBrowser: false,
    channel: process.env.BROWSER_CHANNEL || '',
    executablePath: process.env.CHROME_PATH || ''
  };
  const options = new Map([['--freeze', 'freeze'], ['--channel', 'channel'], ['--browser', 'executablePath']]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check-browser') {
      flags.checkBrowser = true;
    } else if (arg === '--inspect-reference') {
      flags.inspectReference = true;
    } else if (arg === '--replay-only') {
      flags.replayOnly = true;
    } else if (options.has(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} 缺少参数值`);
      flags[options.get(arg)] = argv[++i];
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    } else {
      throw new Error(`无法识别参数：${arg}`);
    }
  }
  if (flags.inspectReference && (!positional.length || flags.freeze || flags.replayOnly || flags.checkBrowser)) {
    throw new Error('用法：node scripts/render.js --inspect-reference 参考图 [更多参考图...]');
  }
  if (!flags.inspectReference && positional.length > 2) throw new Error('用法：node scripts/render.js 输入.json 输出PNG或套图目录 [--freeze 定稿.json]');
  if (flags.checkBrowser && (positional.length || flags.freeze || flags.replayOnly)) {
    throw new Error('--check-browser 仅支持浏览器选项');
  }
  return { positional, flags };
}

function getCandidateExecutablePaths() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Arc.app/Contents/MacOS/Arc',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ];
  }
  if (platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA;
    return [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData && path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      localAppData && path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    ].filter(Boolean);
  }
  // Linux / WSL
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/brave-browser'
  ];
}

async function launchLocalBrowser(flags) {
  const baseLaunchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  };

  // 1. 优先使用用户显式指定的浏览器可执行路径（--browser 或 CHROME_PATH）
  if (flags.executablePath) {
    if (!fs.existsSync(flags.executablePath)) {
      throw new Error(`指定的浏览器路径不存在: ${flags.executablePath}`);
    }
    const browser = await chromium.launch({
      ...baseLaunchOpts,
      executablePath: flags.executablePath
    });
    return { browser, source: `executablePath (${flags.executablePath})` };
  }

  // 2. 其次使用用户显式指定的 channel（--channel 或 BROWSER_CHANNEL）
  if (flags.channel) {
    const browser = await chromium.launch({
      ...baseLaunchOpts,
      channel: flags.channel
    });
    return { browser, source: `channel (${flags.channel})` };
  }

  // 3. 自动尝试系统 Chrome / Edge channel
  let lastError;
  for (const ch of ['chrome', 'msedge']) {
    try {
      const browser = await chromium.launch({ ...baseLaunchOpts, channel: ch });
      return { browser, source: `system channel (${ch})` };
    } catch (err) {
      lastError = `${ch}: ${err.message.split('\n')[0]}`;
    }
  }

  // 4. 兜底扫描常见本地 Chromium 系浏览器路径（Chromium / Brave / Arc 等）
  for (const candidate of getCandidateExecutablePaths()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const browser = await chromium.launch({ ...baseLaunchOpts, executablePath: candidate });
      return { browser, source: `local binary (${candidate})` };
    } catch (err) {
      lastError = `${candidate}: ${err.message.split('\n')[0]}`;
    }
  }

  throw new Error('无法启动本机 Chromium 浏览器，可用 --browser 指定路径。' + lastError);
}

async function writeOutputs(entries) {
  const files = [];
  try {
    for (const [target, bytes] of entries) {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const suffix = '.' + randomUUID();
      const file = { target, staged: target + suffix + '.tmp', backup: target + suffix + '.prev' };
      files.push(file);
      // A null entry retires an old page when a regenerated set is shorter.
      file.remove = bytes === null;
      if (!file.remove) await fs.promises.writeFile(file.staged, bytes, { flag: 'wx' });
      if (entries.length > 1 && fs.existsSync(target)) {
        await fs.promises.copyFile(target, file.backup, fs.constants.COPYFILE_EXCL);
        file.hasBackup = true;
      }
    }
    for (const file of files) {
      if (file.remove) await fs.promises.rm(file.target, { force: true });
      else await fs.promises.rename(file.staged, file.target);
      file.published = true;
    }
  } catch (error) {
    for (const file of files.filter(f => f.published).reverse()) {
      if (file.hasBackup) await fs.promises.rename(file.backup, file.target);
      else await fs.promises.rm(file.target, { force: true });
    }
    throw error;
  } finally {
    for (const file of files) {
      await fs.promises.rm(file.staged, { force: true });
      if (file.hasBackup) await fs.promises.rm(file.backup, { force: true });
    }
  }
}

// Chromium limits the size of a CSS custom-property value. Keep large paper
// scans out of the CSS text, and give the freezer the original bytes by URL.
async function bindTextures(page, textures) {
  const aliases = {};
  for (const [key, dataUrl] of Object.entries(textures || {})) {
    if (!dataUrl) continue;
    const objectUrl = await page.evaluate(async url => {
      const response = await fetch(url);
      const source = URL.createObjectURL(await response.blob());
      // Decode before the same scan is painted into several differently sized
      // masks. This also matches the offline replay's resource preparation.
      const texture = new Image();
      texture.src = source;
      await texture.decode();
      return source;
    }, dataUrl);
    aliases[objectUrl] = dataUrl;
    textures[key] = objectUrl;
  }
  return aliases;
}

(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.checkBrowser) {
    const { browser, source } = await launchLocalBrowser(flags);
    const version = browser.version();
    await browser.close();
    console.log(`${source} (Chromium ${version})`);
    return;
  }
  if (flags.inspectReference) {
    const { browser } = await launchLocalBrowser(flags);
    try {
      const page = await browser.newPage();
      const observations = [];
      for (const file of positional) {
        const { url, hash } = await readLocalImage(path.resolve(file), '参考图');
        const { width, height, palette } = await page.evaluate(inspectPixels, { url, paletteSize: 8 });
        observations.push({ file, width, height, sha256: hash, palette });
      }
      console.log(JSON.stringify(observations, null, 2));
    } finally {
      await browser.close();
    }
    return;
  }

  const dataPath = path.resolve(positional[0] ?? path.join(ROOT_DIR, 'examples', 'sticker-journal.json'));
  const source = JSON.parse(fs.readFileSync(dataPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('输入需要 JSON 对象');
  if (source.format === undefined && source.template !== undefined) source.template = canonicalTemplate(source.template);
  if (source.kind === undefined && source.format === undefined &&
      (source.references !== undefined || source.visualReference !== undefined)) {
    throw new Error('带参考图的稿件请使用 kind: "reference-source"，贴纸手帐也支持 "cover-source"');
  }
  const set = source.template === 'neon-cards' && source.kind === undefined && source.format === undefined
    ? preparePictureSet(source) : null;
  const referenceDraft = source.kind === 'reference-source' && source.format === undefined;
  const sourceName = path.parse(dataPath).name;
  const defaultOutput = set || (referenceDraft && source.references?.inside) ? sourceName
    : referenceDraft ? sourceName + '.png' : 'note_cover.png';
  const outputPath = path.resolve(positional[1] ?? path.join(ROOT_DIR, 'output', defaultOutput));

  const freezePath = flags.freeze && path.resolve(flags.freeze);
  const replaying = isCoverProof(source);
  const paths = [dataPath, outputPath, freezePath].filter(Boolean);
  if (new Set(paths.map(p => process.platform === 'win32' ? p.toLowerCase() : p)).size !== paths.length) {
    throw new Error('输入 JSON、输出 PNG 和定稿 JSON 需要使用不同路径');
  }
  if (flags.replayOnly && !replaying) throw new Error('离线重绘只接受定稿 JSON');
  if (freezePath && (replaying || source.kind !== 'cover-source')) throw new Error('--freeze 需要贴纸手帐的 cover-source 创作稿');

  const coverData = replaying || set || referenceDraft ? null : await prepareCover(source, dataPath, ROOT_DIR);
  const { browser } = await launchLocalBrowser(flags);
  try {
    if (replaying) {
      const replay = await replayProof(browser, source);
      await writeOutputs([[outputPath, replay.png]]);
      console.log(`离线重绘：${outputPath}`);
      return;
    }
    if (referenceDraft) {
      await renderReference(browser, source, dataPath, ROOT_DIR, outputPath, writeOutputs);
      return;
    }
    const page = await browser.newPage({
      viewport: { width: 1242, height: 1660 },
      deviceScaleFactor: 1
    });
    if (set) {
      await renderPictureSet(page, set, outputPath, dataPath, writeOutputs);
      return;
    }

    const htmlPath = path.join(ROOT_DIR, 'templates', coverData.template + '.html');
    const reference = source.kind === 'cover-source'
      ? await loadVisualReference(source.visualReference, dataPath, page, [outputPath, freezePath].filter(Boolean))
      : null;
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    const assetAliases = await bindTextures(page, coverData.design?.textures);

    const qaReport = await page.evaluate(async (data) => {
      window.injectData(data);

      // 对纯白底贴纸图执行边缘泛洪去白底 (BFS) + 自动裁剪紧致透明边
      async function processStickerImage(imgEl) {
        const threshold = 242;
        const w = imgEl.naturalWidth;
        const h = imgEl.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgEl, 0, 0);

        const imgData = ctx.getImageData(0, 0, w, h);
        const d = imgData.data;

        const corners = [0, w - 1, (h - 1) * w, h * w - 1];
        const alreadyTransparent = corners.every((idx) => d[idx * 4 + 3] < 240);

        if (!alreadyTransparent) {
          const visited = new Uint8Array(w * h);
          const queue = new Int32Array(w * h);
          let head = 0;
          let tail = 0;

          const isNearWhite = (i) =>
            d[i * 4] >= threshold && d[i * 4 + 1] >= threshold && d[i * 4 + 2] >= threshold;

          const enqueue = (x, y) => {
            const idx = y * w + x;
            if (!visited[idx] && isNearWhite(idx)) {
              visited[idx] = 1;
              queue[tail++] = idx;
            }
          };

          for (let x = 0; x < w; x++) {
            enqueue(x, 0);
            enqueue(x, h - 1);
          }
          for (let y = 0; y < h; y++) {
            enqueue(0, y);
            enqueue(w - 1, y);
          }

          while (head < tail) {
            const idx = queue[head++];
            d[idx * 4 + 3] = 0;
            const x = idx % w;
            const y = (idx - x) / w;
            if (x > 0) enqueue(x - 1, y);
            if (x < w - 1) enqueue(x + 1, y);
            if (y > 0) enqueue(x, y - 1);
            if (y < h - 1) enqueue(x, y + 1);
          }

          // 1px 边缘柔化，削弱亮白锯齿
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const idx = y * w + x;
              if (visited[idx]) continue;
              const touchesBg =
                visited[idx - 1] || visited[idx + 1] || visited[idx - w] || visited[idx + w];
              if (touchesBg && d[idx * 4] > 212 && d[idx * 4 + 1] > 212 && d[idx * 4 + 2] > 212) {
                d[idx * 4 + 3] = 75;
              }
            }
          }
          ctx.putImageData(imgData, 0, 0);
        }

        let minX = w, minY = h, maxX = 0, maxY = 0;
        let hasOpaque = false;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 20) {
              hasOpaque = true;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }

        if (hasOpaque) {
          const pad = 12;
          const cw = maxX - minX + 1;
          const ch = maxY - minY + 1;
          const out = document.createElement('canvas');
          out.width = cw + pad * 2;
          out.height = ch + pad * 2;
          out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, pad, pad, cw, ch);
          imgEl.src = out.toDataURL('image/png');
          await imgEl.decode();
        }
      }

      for (const img of document.images) {
        if (img.style.display === 'none') continue;
        try {
          await img.decode();
        } catch {
          throw new Error('图片加载失败：' + (img.id || img.alt || img.className));
        }
        if (!img.matches('.sticker-effect, .sticker-auto-cutout')) continue;
        const src = img.currentSrc;
        const isSvg = src.startsWith('data:') ? /^data:image\/svg\+xml[;,]/i.test(src)
          : new URL(src).pathname.toLowerCase().endsWith('.svg');
        if (!isSvg) await processStickerImage(img);
      }

      const canvas = document.getElementById('cover-canvas');
      canvas.getBoundingClientRect();
      await document.fonts.ready;
      const { layout, warnings } = await window.finalizeLayout(data) || { layout: null, warnings: [] };

      // 真实 DOM 边界溢出检测
      const canvasRect = canvas.getBoundingClientRect();
      const titles = canvas.querySelectorAll('.title-line, .brush-pill, .poster-row');
      for (const el of titles) {
        if (!el.checkVisibility()) continue;
        const r = el.getBoundingClientRect();
        if (r.right > canvasRect.right - 16 || r.left < canvasRect.left + 16) {
          warnings.push('标题超出左右安全边距：' + el.textContent.trim());
        }
      }

      return { warnings, layout };
    }, coverData);
    if (reference) {
      checkVisualReference(reference, qaReport.layout, page.viewportSize());
      qaReport.layout.visualReference = { sha256: reference.sha256 };
      if (reference.proofIntegrity) qaReport.layout.visualReference.proofIntegrity = reference.proofIntegrity;
    }
    const { warnings } = qaReport;
    if (freezePath && warnings.length) throw new Error('定稿版式检查失败：' + warnings.join('；'));
    for (const warning of warnings) console.warn('版式提醒：' + warning);
    if (coverData.template === 'sticker-journal') await settleAuthorPage(page);
    const png = await page.screenshot({ type: 'png' });
    if (freezePath) {
      const proof = await captureProof(page, {
        source, assetRoot: ROOT_DIR, assetAliases, resolvedLayout: qaReport.layout, authorPng: png
      });
      await replayProof(browser, proof);
      await writeOutputs([[outputPath, png], [freezePath, JSON.stringify(proof)]]);
      console.log(`定稿：${freezePath}`);
    } else {
      await writeOutputs([[outputPath, png]]);
    }
    console.log(`封面：${outputPath}`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
