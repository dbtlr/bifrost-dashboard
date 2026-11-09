export function initials(name: string): string {
  return name.split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0] ?? '').join('').toLocaleUpperCase();
}

// An app icon that falls back to initials when there is no image or it fails to load.
export function createIcon(name: string, src: string | undefined, size = 44): HTMLSpanElement {
  const icon = document.createElement('span');
  icon.className = 'app-icon';
  icon.style.setProperty('--icon-size', `${size}px`);
  icon.setAttribute('aria-hidden', 'true');
  const fallback = document.createElement('span');
  fallback.className = 'icon-fallback';
  fallback.textContent = initials(name);
  icon.append(fallback);

  if (src) {
    const image = document.createElement('img');
    image.alt = '';
    image.width = size;
    image.height = size;
    image.decoding = 'async';
    image.loading = 'lazy';
    fallback.hidden = true;
    image.addEventListener('error', () => {
      image.hidden = true;
      fallback.hidden = false;
    }, { once: true });
    image.src = src;
    icon.append(image);
  }
  return icon;
}
