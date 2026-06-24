export interface PageImage {
  source: CanvasImageSource;
  rect: DOMRect;
  naturalWidth: number;
  naturalHeight: number;
}

type Sel = { kind: 'img'; el: HTMLImageElement } | { kind: 'svg'; el: Element; href: string };

/** Pure: locate the page-image element (<img>, else <svg><image>). */
export const selectPageImageEl = (doc: Document | undefined | null): Sel | null => {
  if (!doc) return null;
  const img = doc.querySelector('img') as HTMLImageElement | null;
  if (img) return { kind: 'img', el: img };
  const im = doc.querySelector('image'); // SVG <image>
  if (im) {
    const href =
      im.getAttribute('href') ||
      im.getAttribute('xlink:href') ||
      (im as unknown as SVGImageElement).href?.baseVal ||
      '';
    if (href) return { kind: 'svg', el: im, href };
  }
  return null;
};

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });

/** Resolve the page image to a drawable source + geometry. May load the SVG href. */
export const findPageImage = async (
  doc: Document | undefined | null,
): Promise<PageImage | null> => {
  const sel = selectPageImageEl(doc);
  if (!sel) return null;
  if (sel.kind === 'img') {
    const img = sel.el;
    return {
      source: img,
      rect: img.getBoundingClientRect(),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    };
  }
  try {
    const loaded = await loadImage(sel.href);
    return {
      source: loaded,
      rect: sel.el.getBoundingClientRect(),
      naturalWidth: loaded.naturalWidth,
      naturalHeight: loaded.naturalHeight,
    };
  } catch {
    return null; // SVG href failed to load (revoked blob, corrupt asset) — caller falls back
  }
};
