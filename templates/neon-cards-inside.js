(() => {
  function element(tag, className, value) {
    const node = document.createElement(tag);
    node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function createEntry(item, number) {
    const row = element('li', 'inside-entry');
    const label = element('h2', 'inside-label');
    label.append(element('span', 'inside-number', number), element('span', 'inside-label-text', item.title));
    row.append(label, element('p', 'inside-copy', item.body));
    return row;
  }

  function createMarks() {
    const layer = element('div', 'inside-marks');
    layer.setAttribute('aria-hidden', 'true');
    for (const shape of ['ring', 'lightning', 'spark left', 'spark right', 'star']) {
      layer.append(element('i', 'inside-' + shape));
    }
    return layer;
  }

  function fitHeading(heading, text) {
    let size = parseFloat(getComputedStyle(heading).fontSize);
    while (text.scrollWidth > text.clientWidth + 1 && size > 52) {
      size = Math.max(52, size - 2);
      heading.style.fontSize = size + 'px';
    }
    text.style.whiteSpace = 'pre-wrap';
    const maxHeight = 2 * parseFloat(getComputedStyle(text).lineHeight);
    if (text.getBoundingClientRect().height > maxHeight + 1) {
      throw new Error('内页标题超过两行，请缩短该页标题');
    }
  }

  async function measureSection(title, items, startIndex) {
    const paper = element('section', 'inside-paper');
    const heading = element('h1', 'inside-heading');
    const headingText = element('span', 'inside-heading-text', title);
    heading.append(headingText);
    const list = element('ol', 'inside-list');
    list.start = startIndex + 1;
    items.forEach((item, i) => list.append(createEntry(item, startIndex + i + 1)));
    paper.append(list);
    document.getElementById('sheet-content').replaceChildren(paper, heading, createMarks());

    // Force the browser to request the fonts for these exact glyphs before measuring.
    paper.getBoundingClientRect();
    await document.fonts.ready;
    fitHeading(heading, headingText);
    const headingBottom = heading.getBoundingClientRect().bottom;
    const paperTop = paper.getBoundingClientRect().top + paper.clientTop;
    list.style.top = Math.ceil(headingBottom + 58 - paperTop) + 'px';

    const bounds = list.getBoundingClientRect();
    const heights = Array.from(list.children, (row, i) => {
      const height = row.getBoundingClientRect().height;
      if (height > bounds.height + 0.5) {
        throw new Error('内页第 ' + (startIndex + i + 1) + ' 条内容超过整页容量，请拆为多条');
      }
      return height;
    });
    return { list, bounds, heights, gap: parseFloat(getComputedStyle(list).rowGap) };
  }

  window.planSetInside = async function planSetInside(title, items, startIndex) {
    const { bounds, heights, gap } = await measureSection(title, items, startIndex);
    // At each boundary, keep the shortest continuation, balancing free space across its pages.
    const best = new Array(items.length + 1);
    best[items.length] = { pages: 0, cost: 0 };
    for (let first = items.length - 1; first >= 0; first--) {
      let height = 0;
      for (let count = 1; count <= Math.min(5, items.length - first); count++) {
        height += heights[first + count - 1] + (count > 1 ? gap : 0);
        if (height > bounds.height + 0.5) break;
        const tail = best[first + count];
        const pages = 1 + tail.pages;
        const cost = (bounds.height - height) ** 2 + tail.cost;
        const current = best[first];
        // For equal costs the later candidate places one more item on the earlier page.
        if (!current || pages < current.pages || (pages === current.pages && cost <= current.cost + 0.01)) {
          best[first] = { count, pages, cost };
        }
      }
    }
    const counts = [];
    for (let first = 0; first < items.length; first += best[first].count) counts.push(best[first].count);
    return counts;
  };

  window.renderSetInside = async function renderSetInside(title, items, startIndex) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 5) {
      throw new Error('每张内页需要 1 至 5 条内容');
    }
    const { list, bounds, gap } = await measureSection(title, items, startIndex);
    const freeHeight = () => bounds.bottom - list.lastElementChild.getBoundingClientRect().bottom;
    if (freeHeight() < -0.5) throw new Error('内页排版超出纸张：' + title);
    const count = list.childElementCount;
    const sizes = count <= 3 ? ['large', 'medium'] : count === 4 ? ['medium'] : [];
    for (const size of sizes) {
      list.dataset.typeSize = size;
      if (freeHeight() >= 0) break;
      delete list.dataset.typeSize;
    }
    if (count > 1) {
      const maxGap = count === 5 ? 66 : count === 4 ? 112 : 156;
      list.style.rowGap = Math.min(maxGap, gap + Math.floor(freeHeight() / (count - 1))) + 'px';
    }
    return { count };
  };
})();
