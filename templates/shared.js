function setText(id, value) {
  const element = document.getElementById(id);
  element.textContent = value ?? '';
  element.style.display = value ? '' : 'none';
}

function fitText(element, maxWidth, size, minSize, step = 4) {
  element.style.fontSize = size + 'px';
  while (element.scrollWidth > maxWidth && size > minSize) {
    size = Math.max(minSize, size - step);
    element.style.fontSize = size + 'px';
  }
}

function setStickers(containerId, stickers, defaults) {
  const layer = document.getElementById(containerId);
  layer.replaceChildren();
  for (const sticker of stickers || []) {
    if (!sticker.path) continue;
    const image = document.createElement('img');
    image.src = sticker.path;
    image.className = defaults.className;
    if (sticker.role === 'scene') image.dataset.role = 'scene';
    image.style.top = sticker.top || defaults.top;
    image.style.left = sticker.left || defaults.left;
    const size = (sticker.size || defaults.size) + 'px';
    image.style.width = size;
    image.style.height = size;
    image.style.transform = `scale(${sticker.scale ?? 1}) rotate(${sticker.rotate || '0deg'})`;
    layer.appendChild(image);
  }
}
