const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { rgbaSha256, sha256 } = require('./compare-png');
const { IMAGE_TYPES } = require('./cover-source');

const FORMAT = 'xhs-cover-proof';
const ORIGIN = 'https://cover-proof.invalid';
const MIME_TYPES = {
  ...IMAGE_TYPES, '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.otf': 'font/otf'
};
const ALLOWED_TYPES = new Set(Object.values(MIME_TYPES));
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isCoverProof(value) {
  return value?.format === FORMAT;
}

function fingerprint(proof) {
  const manifest = Object.entries(proof.resources).map(([id, item]) => [id, item.type]);
  return sha256(JSON.stringify([
    proof.format, proof.version, proof.render, proof.source, proof.resolvedLayout, proof.scene, manifest
  ]));
}

function collectResources(assetRoot, assetAliases) {
  const root = fs.realpathSync(assetRoot);
  const resources = {};
  const normalized = new Map();
  const pendingAliases = new Set(Object.keys(assetAliases));

  function localFile(value, base) {
    const url = new URL(value, base);
    if (url.protocol !== 'file:') throw new Error('定稿需要本地素材或 data URL: ' + url.protocol);
    const file = fileURLToPath(url);
    const actual = fs.realpathSync(file);
    const relative = path.relative(root, actual);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('定稿素材不在项目素材目录: ' + actual);
    }
    return actual;
  }

  function add(value, base) {
    if (value.startsWith('#')) return value;
    if (Object.hasOwn(assetAliases, value)) {
      pendingAliases.delete(value);
      value = assetAliases[value];
    }
    const key = value.startsWith('data:') ? value : new URL(value, base).href;
    if (normalized.has(key)) return normalized.get(key);
    let type, bytes;
    if (value.startsWith('data:')) {
      const comma = value.indexOf(',');
      const metadata = value.slice(5, comma).split(';');
      type = metadata[0].toLowerCase();
      bytes = metadata.includes('base64') ? Buffer.from(value.slice(comma + 1), 'base64')
        : Buffer.from(decodeURIComponent(value.slice(comma + 1)));
    } else {
      const file = localFile(value, base);
      type = MIME_TYPES[path.extname(file).toLowerCase()];
      bytes = fs.readFileSync(file);
    }
    if (!ALLOWED_TYPES.has(type) || !bytes.length) throw new Error('定稿包含不支持的素材类型: ' + type);
    const id = sha256(bytes);
    if (!resources[id]) resources[id] = { type, data: bytes.toString('base64') };
    const target = ORIGIN + '/resources/' + id;
    normalized.set(key, target);
    return target;
  }

  function css(text, base) {
    return text.replace(CSS_URL, (_all, dq, sq, unquoted) =>
      'url("' + add((dq ?? sq ?? unquoted).trim(), base) + '")'
    );
  }
  function checkAliases() {
    if (pendingAliases.size) throw new Error('创作稿有 ' + pendingAliases.size + ' 个纹理未进入最终场景');
  }
  function readStylesheet(url) {
    const file = localFile(url);
    if (path.extname(file).toLowerCase() !== '.css') throw new Error('定稿样式表需要本地 CSS 文件');
    return fs.readFileSync(file, 'utf8');
  }
  return { resources, add, css, checkAliases, readStylesheet };
}

async function settleAuthorPage(page) {
  // Rebuild paint layers after cutout images and fitted fonts have replaced their draft
  // versions. A freshly rebuilt page has no incremental compositor history.
  await page.evaluate(async () => {
    const body = document.body;
    const inlineStyle = body.getAttribute('style');
    body.style.display = 'none';
    body.getBoundingClientRect();
    if (inlineStyle === null) body.removeAttribute('style');
    else body.setAttribute('style', inlineStyle);
    body.getBoundingClientRect();
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function usedFontFamilies(page) {
  const selector = '#cover-canvas, #cover-canvas *';
  const indices = await page.evaluate(selector =>
    Array.from(document.querySelectorAll(selector)).flatMap((el, index) =>
      Array.from(el.childNodes).some(n => n.nodeType === 3 && n.data.trim()) ? [index] : []
    ), selector);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    const groups = await Promise.all(indices.map(index =>
      session.send('CSS.getPlatformFontsForNode', { nodeId: nodeIds[index] })
    ));
    const used = groups.flatMap(group => group.fonts).filter(font => font.glyphCount);
    const systemFont = used.find(font => !font.isCustomFont);
    if (systemFont) throw new Error('排版用了未内嵌的系统字体，请更换该字形或配备字体: ' + systemFont.familyName);
    return [...new Set(used.map(font => font.familyName))].sort();
  } finally {
    await session.detach();
  }
}

async function captureProof(page, { source, assetRoot, resolvedLayout, assetAliases, authorPng }) {
  const pack = collectResources(assetRoot, assetAliases);
  // Chromium applies linked file: stylesheets but blocks direct access to their cssRules.
  const links = await page.evaluate(() => [...document.styleSheets].filter(sheet => !sheet.disabled && sheet.href).map(sheet => sheet.href));
  const linkedCss = Object.fromEntries(links.map(url => [url, pack.readStylesheet(url)]));
  // Text nodes are kept separately. Re-parsing outerHTML can normalize SVG/HTML nodes.
  const raw = await page.evaluate(async linkedCss => {
    await document.fonts.ready;
    const loadedFonts = new Set([...document.fonts].filter(face => face.status === 'loaded').map(face => face.family));
    function stylesheetText(sheet) {
      if (!sheet.href) return sheet.ownerNode.textContent;
      const copy = new CSSStyleSheet();
      copy.replaceSync(linkedCss[sheet.href]);
      return [...copy.cssRules]
        .filter(rule => !(rule instanceof CSSFontFaceRule) || loadedFonts.has(rule.style.fontFamily))
        .map(rule => rule.cssText).join('\n');
    }
    function nodeData(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.data;
      if (node.nodeType !== Node.ELEMENT_NODE || node.localName === 'script') return null;
      return {
        tag: node.localName, svg: node.namespaceURI === 'http://www.w3.org/2000/svg' || undefined,
        attrs: Object.fromEntries(Array.from(node.attributes, a => [a.name, a.value])),
        children: Array.from(node.childNodes, nodeData).filter(data => data !== null)
      };
    }
    return {
      rootAttrs: Object.fromEntries(Array.from(document.documentElement.attributes, a => [a.name, a.value])),
      styles: [...document.styleSheets].filter(sheet => !sheet.disabled).map(sheet => ({
        base: sheet.href || document.baseURI,
        media: sheet.media.mediaText, text: stylesheetText(sheet)
      })),
      body: nodeData(document.body), base: document.baseURI,
      width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio
    };
  }, linkedCss);
  function inlineNode(node) {
    if (typeof node === 'string') return;
    if ('src' in node.attrs) node.attrs.src = pack.add(node.attrs.src, raw.base);
    if ('style' in node.attrs) node.attrs.style = pack.css(node.attrs.style, raw.base);
    node.children.forEach(inlineNode);
  }
  inlineNode(raw.body);
  if (raw.rootAttrs.style) raw.rootAttrs.style = pack.css(raw.rootAttrs.style, raw.base);
  const scene = {
    rootAttrs: raw.rootAttrs, body: raw.body,
    styles: raw.styles.map(sheet => ({
      css: pack.css(sheet.text, sheet.base), media: sheet.media
    }))
  };
  pack.checkAliases();
  const proof = {
    format: FORMAT, version: 1, source, resolvedLayout,
    render: {
      width: raw.width, height: raw.height, deviceScaleFactor: raw.dpr,
      browserVersion: page.context().browser().version(),
      playwrightVersion: require('playwright-core/package.json').version, platform: process.platform, arch: process.arch,
      fontFamilies: await usedFontFamilies(page), rgbaSha256: rgbaSha256(authorPng)
    },
    scene, resources: pack.resources
  };
  proof.integrity = fingerprint(proof);
  return proof;
}

function validateProofManifest(proof) {
  if (!isCoverProof(proof) || proof.version !== 1) throw new Error('不支持的定稿 JSON 格式或版本');
  if (proof.render?.width !== 1242 || proof.render?.height !== 1660 || proof.render?.deviceScaleFactor !== 1) {
    throw new Error('定稿画布规格无效');
  }
  if (typeof proof.render.rgbaSha256 !== 'string' || !SHA256_HEX.test(proof.render.rgbaSha256)) {
    throw new Error('定稿像素摘要缺失或无效');
  }
  if (!proof.scene || !proof.resources || fingerprint(proof) !== proof.integrity) {
    throw new Error('定稿数据完整性校验失败');
  }
}

function validateProof(proof) {
  validateProofManifest(proof);
  const assets = new Map();
  for (const [id, resource] of Object.entries(proof.resources)) {
    if (!ALLOWED_TYPES.has(resource.type) || !SHA256_HEX.test(id) || typeof resource.data !== 'string') {
      throw new Error('无效的定稿素材: ' + id);
    }
    const bytes = Buffer.from(resource.data, 'base64');
    if (sha256(bytes) !== id) throw new Error('定稿素材校验失败: ' + id);
    assets.set(ORIGIN + '/resources/' + id, { bytes, type: resource.type });
  }
  return assets;
}

async function replayProof(browser, proof) {
  const assets = validateProof(proof);
  const { width, height, deviceScaleFactor } = proof.render;
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor,
    offline: true, serviceWorkers: 'block'
  });
  const shell = ORIGIN + '/document';
  let deniedUrl;
  let loadedShell = false;
  try {
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url === shell && route.request().isNavigationRequest() && !loadedShell) {
        loadedShell = true;
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'" },
          body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'
        });
      }
      const resource = assets.get(url);
      if (resource && !route.request().isNavigationRequest()) {
        return route.fulfill({ contentType: resource.type, body: resource.bytes });
      }
      deniedUrl ??= url;
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(shell);
    const imageUrls = [...assets.entries()].filter(([, item]) => item.type.startsWith('image/')).map(([url]) => url);
    await page.evaluate(async urls => {
      // Decode shared paper textures before their first use at several different scales.
      // Otherwise the first paint can use an intermediate decode in the smaller labels.
      const images = urls.map(src => { const image = new Image(); image.src = src; return image; });
      await Promise.all(images.map(image => image.decode()));
    }, imageUrls);
    await page.evaluate(scene => {
      const allowedTags = new Set(('body div section header main aside footer span p ul ol li img svg defs filter feTurbulence feDisplacementMap feColorMatrix path circle rect g line polygon polyline ellipse').split(' '));
      function create(node) {
        if (typeof node === 'string') return document.createTextNode(node);
        if (!allowedTags.has(node.tag)) throw new Error('不支持的排版元素: ' + node.tag);
        const el = node.svg ? document.createElementNS('http://www.w3.org/2000/svg', node.tag)
          : document.createElement(node.tag);
        for (const [key, value] of Object.entries(node.attrs)) {
          if (/^on|href$|^srcdoc$|^srcset$/i.test(key)) throw new Error('不支持的排版属性: ' + key);
          el.setAttribute(key, value);
        }
        for (const child of node.children) el.appendChild(create(child));
        return el;
      }
      for (const [key, value] of Object.entries(scene.rootAttrs)) {
        if (!/^(?:lang|dir|class|style|data-[a-z0-9-]+)$/.test(key)) throw new Error('不支持的文档属性: ' + key);
        document.documentElement.setAttribute(key, value);
      }
      for (const sheet of scene.styles) {
        const style = document.createElement('style');
        style.media = sheet.media;
        style.textContent = sheet.css;
        document.head.appendChild(style);
      }
      document.body.replaceWith(create(scene.body));
    }, proof.scene);
    await page.evaluate(async () => {
      await Promise.all([...document.images].filter(img => img.getAttribute('src')).map(img => img.decode()));
      document.body.getBoundingClientRect();
      await document.fonts.ready;
      if ([...document.fonts].some(font => font.status === 'error')) throw new Error('定稿字体加载失败');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await settleAuthorPage(page);
    if (deniedUrl) throw new Error('离线重绘出现未封装请求: ' + deniedUrl);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
    if (rgbaSha256(png) !== proof.render.rgbaSha256) {
      throw new Error('离线像素摘要与原稿不符；请核对浏览器版本 ' + proof.render.browserVersion +
        '、操作系统 ' + proof.render.platform + ' 和架构 ' + proof.render.arch);
    }
    return { png };
  } finally {
    await context.close();
  }
}

module.exports = { captureProof, replayProof, isCoverProof, settleAuthorPage, validateProofManifest };
