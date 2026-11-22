(() => {
  const content = document.getElementById('sheet-content');
  const displayFont = getComputedStyle(content).getPropertyValue('--display-font').trim();
  const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });

  // A small repeatable tile gives the exposed blue margins a printed-paper grain on every sheet.
  function makePaperGrain() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grain = ctx.createImageData(256, 256);
    let seed = 94317;
    function random() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    for (let i = 0; i < grain.data.length; i += 4) {
      const shade = random() - .5;
      grain.data[i] = grain.data[i + 1] = grain.data[i + 2] = shade > 0 ? 255 : 0;
      grain.data[i + 3] = Math.round(Math.abs(shade) * 46);
    }
    ctx.putImageData(grain, 0, 0);
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 630; i++) {
      const x = random() * 256;
      const y = random() * 256;
      ctx.strokeStyle = random() > .53 ? 'rgba(255,255,255,.044)' : 'rgba(0,20,75,.064)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + random() * 2 - 1, y + random() * 9 + 2);
      ctx.stroke();
    }
    document.getElementById('cover-canvas').style.setProperty('--printed-grain', 'url(' + canvas.toDataURL() + ')');
  }
  makePaperGrain();

  function lineOptions(text) {
    const glyphs = Array.from(graphemes.segment(text), part => part.segment);
    if (glyphs.length > 64) return [];
    const options = [[text]];
    if (glyphs.length < 3) return options;
    const wordChar = /[\p{Script=Latin}\p{Number}]/u;
    for (let i = 1; i < glyphs.length; i++) {
      // Keep Latin words/numbers intact when considering a two-line tile.
      if (wordChar.test(glyphs[i - 1]) && wordChar.test(glyphs[i])) continue;
      const first = glyphs.slice(0, i).join('').trim();
      const second = glyphs.slice(i).join('').trim();
      if (first && second) options.push([first, second]);
    }
    return options;
  }

  // The upper cards reserve a strip where the lower pair crosses their edges.
  const inkBoxes = [
    { x: .51, y: .465, w: .80, h: .735, tilt: -2 },
    { x: .51, y: .48, w: .84, h: .81, tilt: 2 },
    { x: .50, y: .53, w: .84, h: .79, tilt: -.8 },
    { x: .50, y: .505, w: .86, h: .81, tilt: .9 }
  ];

  function drawTile(frame, word, index) {
    const canvas = document.createElement('canvas');
    canvas.width = frame.clientWidth;
    canvas.height = frame.clientHeight;
    frame.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const typeSize = 128;
    ctx.font = '800 ' + typeSize + 'px ' + displayFont;
    const box = inkBoxes[index];
    let best;
    for (const lines of lineOptions(word)) {
      const measured = lines.map(text => {
        const m = ctx.measureText(text);
        return {
          text, left: m.actualBoundingBoxLeft, top: m.actualBoundingBoxAscent,
          width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
          height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
        };
      });
      if (measured.some(line => line.width <= 0 || line.height <= 0)) continue;
      const gap = typeSize * .11;
      const height = measured.reduce((total, line) => total + line.height, 0) + gap * (lines.length - 1);
      const width = Math.max(...measured.map(line => line.width));
      const fitX = canvas.width * box.w / width;
      const fitY = canvas.height * box.h / height;
      const scale = Math.min(fitX, fitY);
      if (!best || scale > best.scale) {
        best = { measured, height, gap, scale, xScale: Math.min(fitX, scale * 1.12), yScale: Math.min(fitY, scale * 1.32) };
      }
    }
    if (!best || best.scale * typeSize < 64) {
      throw new Error('cover.tiles[' + index + '] 无法在字卡中清晰排下，请缩短这组标题');
    }
    ctx.fillStyle = ctx.strokeStyle = getComputedStyle(frame).color;
    ctx.lineWidth = 1.7;
    ctx.lineJoin = 'round';
    ctx.translate(canvas.width * box.x, canvas.height * box.y);
    ctx.rotate(box.tilt * Math.PI / 180);
    ctx.scale(best.xScale, best.yScale);
    let y = -best.height / 2;
    for (const line of best.measured) {
      const x = line.left - line.width / 2;
      ctx.strokeText(line.text, x, y + line.top);
      ctx.fillText(line.text, x, y + line.top);
      y += line.height + best.gap;
    }
  }

  function fillLabel(selector, value, field, startSize, minSize, slashes) {
    const label = content.querySelector(selector);
    if (!value) {
      label.hidden = true;
      return;
    }
    const text = document.createElement('span');
    text.textContent = slashes ? '* / ' + value + ' /' : value;
    label.appendChild(text);
    const style = getComputedStyle(label);
    const maxBox = parseFloat(style.maxWidth) || label.offsetWidth;
    const maxText = maxBox - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
      - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    fitText(text, maxText, startSize, minSize, 1);
    if (text.scrollWidth > maxText) {
      throw new Error(field + ' 太长，无法在保持可读字号的情况下放入纸条');
    }
  }

  window.renderSetCover = async function renderSetCover(cover) {
    content.replaceChildren(document.getElementById('set-cover-template').content.cloneNode(true));
    const title = content.querySelector('.set-cover-tiles');
    title.setAttribute('aria-label', cover.tiles.join(''));
    const allText = [...cover.tiles, cover.audience, cover.kicker || '', ...cover.ribbons].join('');
    await document.fonts.load('800 128px ' + displayFont, allText);
    cover.tiles.forEach((word, index) => {
      const frame = document.createElement('span');
      frame.className = 'set-cover-frame';
      frame.setAttribute('aria-hidden', 'true');
      title.appendChild(frame);
      if (index === 2) frame.appendChild(document.getElementById('set-cover-ring').content.cloneNode(true));
      drawTile(frame, word, index);
    });
    fillLabel('.set-cover-audience', cover.audience, 'cover.audience', 57, 35, true);
    fillLabel('.set-cover-kicker', cover.kicker, 'cover.kicker', 52, 30, false);
    fillLabel('.set-cover-ribbon.first', cover.ribbons[0], 'cover.ribbons[0]', 52, 31, true);
    fillLabel('.set-cover-ribbon.second', cover.ribbons[1], 'cover.ribbons[1]', 52, 31, true);
  };
})();
