(() => {
  window.loadReferenceFonts = async function loadReferenceFonts(fonts = {}) {
    const canvas = document.getElementById('cover-canvas');
    await Promise.all(Object.entries(fonts).map(async ([role, spec]) => {
      const family = 'ReferenceFont-' + role;
      const face = new FontFace(family, 'url("' + spec.src + '")', { weight: String(spec.weight) });
      try {
        await face.load();
      } catch {
        throw new Error('无法加载参考版式的 ' + role + ' 字体');
      }
      document.fonts.add(face);
      canvas.style.setProperty('--' + role, family + ', var(--default-' + role + ')');
    }));
  };

  function ink(value, colors, fallback) {
    if (value == null) return fallback;
    if (!value.startsWith('$')) return value;
    const key = value.slice(1);
    if (!Object.hasOwn(colors, key)) throw new Error('参考色板缺少 ' + key);
    return colors[key];
  }

  function mount(canvas, tag, layer, width, height) {
    const node = document.createElement(tag);
    const [x, y, w, h] = layer.box;
    node.className = 'scene-layer scene-' + layer.type;
    Object.assign(node.style, {
      left: x * width + 'px', top: y * height + 'px',
      width: w * width + 'px', height: h * height + 'px',
      transform: layer.rotate ? 'rotate(' + layer.rotate + 'deg)' : '',
      opacity: layer.opacity ?? 1
    });
    canvas.append(node);
    return node;
  }

  function paintShape(node, layer, colors, width, height) {
    // Match the CSS size and the screenshot's backing resolution, including on high-DPI output.
    node.width = Math.max(1, Math.round(width * devicePixelRatio));
    node.height = Math.max(1, Math.round(height * devicePixelRatio));
    const ctx = node.getContext('2d');
    ctx.scale(node.width / width, node.height / height);
    const outline = new Path2D();
    if (layer.polygon) {
      layer.polygon.forEach(([x, y], i) => {
        if (i === 0) outline.moveTo(x * width, y * height);
        else outline.lineTo(x * width, y * height);
      });
      outline.closePath();
    } else {
      outline.roundRect(0, 0, width, height, Math.min(layer.radius ?? 0, width / 2, height / 2));
    }
    ctx.clip(outline);
    if (layer.fill) {
      ctx.fillStyle = ink(layer.fill, colors);
      ctx.fillRect(0, 0, width, height);
    }
    if (layer.grid) {
      ctx.beginPath();
      const step = Math.max(1 / devicePixelRatio, layer.grid);
      for (let x = 0; x < width; x += step) {
        ctx.moveTo(x + .5, 0);
        ctx.lineTo(x + .5, height);
      }
      for (let y = 0; y < height; y += step) {
        ctx.moveTo(0, y + .5);
        ctx.lineTo(width, y + .5);
      }
      ctx.strokeStyle = ink(layer.gridColor, colors, '#00000016');
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (layer.stroke && layer.strokeWidth !== 0) {
      ctx.lineWidth = 2 * (layer.strokeWidth ?? 1);
      ctx.strokeStyle = ink(layer.stroke, colors);
      ctx.lineJoin = 'round';
      ctx.stroke(outline);
    }
  }

  function setText(node, layer, value, colors, width) {
    const text = document.createElement('p');
    text.className = 'scene-copy';
    text.textContent = value;
    node.append(text);
    const size = layer.fontSize ?? (width * .04);
    const minimum = layer.minFontSize ?? size * .72;
    node.style.justifyContent = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[layer.valign ?? 'middle'];
    Object.assign(text.style, {
      fontFamily: 'var(--' + (layer.font ?? 'body') + ')',
      fontWeight: layer.weight ?? (layer.font === 'display' ? 800 : 400),
      fontSize: size + 'px', lineHeight: layer.lineHeight ?? 1.13,
      letterSpacing: (layer.tracking ?? 0) + 'px', textAlign: layer.align ?? 'left',
      whiteSpace: layer.wrap === false ? 'pre' : 'pre-wrap', color: ink(layer.color, colors, '#171719')
    });
    if (layer.stroke) text.style.webkitTextStroke = (layer.strokeWidth ?? 1) + 'px ' + ink(layer.stroke, colors);
    return function fit() {
      const fits = fontSize => {
        text.style.fontSize = fontSize + 'px';
        return text.scrollWidth <= node.clientWidth && text.scrollHeight <= node.clientHeight;
      };
      if (fits(size)) return;
      if (!fits(minimum)) throw new Error('文字 ' + layer.bind + ' 在最小字号仍放不下，请扩大图层或精简文案');
      let low = minimum;
      let high = size;
      while (high - low > .2) {
        const middle = (high + low) / 2;
        if (fits(middle)) low = middle;
        else high = middle;
      }
      text.style.fontSize = low + 'px';
    };
  }

  function makeList(node, layer, items, offset, colors, width, boxHeight) {
    const titleSize = layer.titleSize ?? width * .033;
    const bodySize = layer.bodySize ?? width * .027;
    const labelSize = layer.labelSize ?? titleSize;
    const labelWidth = layer.labelWidth ?? (items.some(item => item.label) ? titleSize * 3.8 : 0);
    if (!labelWidth && items.some(item => item.label)) throw new Error(layer.bind + ' 含标签，需要为 labelWidth 留出宽度');
    const gap = layer.gap ?? bodySize * .65;
    const lineGap = layer.lineGap ?? bodySize * .2;
    const lineHeight = layer.lineHeight ?? 1.3;
    node.start = offset + 1;
    Object.assign(node.style, {
      gap: gap + 'px', lineHeight, fontFamily: 'var(--' + (layer.font ?? 'body') + ')',
      color: ink(layer.color, colors, '#171719')
    });
    // Every item needs at least one title and one body line. Bound DOM work to one page.
    const minHeight = (titleSize + bodySize) * lineHeight + lineGap + gap;
    const candidates = items.slice(offset, offset + Math.ceil((boxHeight + gap) / minHeight) + 1);
    for (const item of candidates) {
      const row = document.createElement('li');
      row.className = 'scene-row';
      if (labelWidth) {
        row.style.gridTemplateColumns = labelWidth + 'px minmax(0, 1fr)';
        const label = document.createElement('p');
        label.className = 'scene-label';
        label.textContent = item.label ?? '';
        Object.assign(label.style, {
          fontFamily: 'var(--display)', fontSize: labelSize + 'px',
          color: ink(layer.labelColor, colors, 'inherit'), fontWeight: layer.weight ?? 800
        });
        row.append(label);
      }
      const copy = document.createElement('div');
      const title = document.createElement('p');
      title.textContent = item.title;
      Object.assign(title.style, {
        color: ink(layer.titleColor, colors, 'inherit'), fontSize: titleSize + 'px', fontWeight: layer.weight ?? 700
      });
      const body = document.createElement('p');
      body.textContent = item.body;
      Object.assign(body.style, {
        color: ink(layer.bodyColor, colors, 'inherit'), fontSize: bodySize + 'px', marginTop: lineGap + 'px'
      });
      copy.append(title, body);
      row.append(copy);
      node.append(row);
    }
    return function paginate() {
      const rows = Array.from(node.children);
      let used = 0;
      let count = 0;
      for (const row of rows) {
        // CSS layout dimensions are independent of a decorative rotation on the entire layer.
        const height = parseFloat(getComputedStyle(row).height);
        used += height + (count ? gap : 0);
        if (used > boxHeight + .02) break;
        if (row.scrollWidth > node.clientWidth) throw new Error('条目 ' + (offset + count + 1) + ' 超过列表宽度');
        count++;
      }
      if (!count) throw new Error(layer.bind + ' 第 ' + (offset + 1) + ' 条超过列表区域，请拆分条目或增大列表');
      for (const row of rows.slice(count)) row.remove();
      return count;
    };
  }

  window.renderReferencePage = async function renderReferencePage({ width, height, layers, colors, content, offset }) {
    const canvas = document.getElementById('cover-canvas');
    canvas.replaceChildren();
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const fitters = [];
    const images = [];
    let paginate;
    for (const layer of layers) {
      const [,, w, h] = layer.box;
      if (layer.type === 'shape') {
        paintShape(mount(canvas, 'canvas', layer, width, height), layer, colors, w * width, h * height);
      } else if (layer.type === 'text') {
        const node = mount(canvas, 'div', layer, width, height);
        fitters.push(setText(node, layer, content[layer.bind], colors, width));
      } else if (layer.type === 'image') {
        const img = mount(canvas, 'img', layer, width, height);
        img.alt = '';
        img.style.objectFit = layer.fit ?? 'contain';
        img.src = layer.assetBind ? content[layer.assetBind] : layer.src;
        images.push(img.decode().catch(() => { throw new Error('参考版式中的插画无法解码'); }));
      } else if (layer.type === 'list') {
        const node = mount(canvas, 'ol', layer, width, height);
        paginate = makeList(node, layer, content[layer.bind], offset, colors, width, h * height);
      }
    }
    canvas.getBoundingClientRect();
    await Promise.all([...images, document.fonts.ready]);
    for (const fit of fitters) fit();
    return { count: paginate ? paginate() : 0 };
  };
})();
