export interface CropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CropGeometry {
  screenRect: CropRect; // drag rect in viewport coords
  frameRect: CropRect; // iframe element rect in viewport coords
  frameScaleX: number;
  frameScaleY: number;
  imgRect: CropRect; // page <img> rect in iframe-local coords
  naturalWidth: number;
  naturalHeight: number;
  maxEdge: number;
}

export interface CropResult {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  outW: number;
  outH: number;
}

const MIN_NATURAL_EDGE = 8;

// Pure geometry: map a viewport drag rect to a source-pixel crop on the page
// image, clamped to image bounds and capped at maxEdge on the long side.
export const computeNaturalCropRect = (g: CropGeometry): CropResult | null => {
  const imgW = g.imgRect.right - g.imgRect.left;
  const imgH = g.imgRect.bottom - g.imgRect.top;
  if (imgW <= 0 || imgH <= 0) return null; // image not laid out yet

  const localLeft = (g.screenRect.left - g.frameRect.left) / g.frameScaleX;
  const localTop = (g.screenRect.top - g.frameRect.top) / g.frameScaleY;
  const localRight = (g.screenRect.right - g.frameRect.left) / g.frameScaleX;
  const localBottom = (g.screenRect.bottom - g.frameRect.top) / g.frameScaleY;

  const clampedLeft = Math.max(localLeft, g.imgRect.left);
  const clampedTop = Math.max(localTop, g.imgRect.top);
  const clampedRight = Math.min(localRight, g.imgRect.right);
  const clampedBottom = Math.min(localBottom, g.imgRect.bottom);
  if (clampedRight <= clampedLeft || clampedBottom <= clampedTop) return null;

  const kx = g.naturalWidth / imgW;
  const ky = g.naturalHeight / imgH;
  const sx = (clampedLeft - g.imgRect.left) * kx;
  const sy = (clampedTop - g.imgRect.top) * ky;
  const sw = (clampedRight - clampedLeft) * kx;
  const sh = (clampedBottom - clampedTop) * ky;
  if (sw < MIN_NATURAL_EDGE || sh < MIN_NATURAL_EDGE) return null;

  const longEdge = Math.max(sw, sh);
  const k = longEdge > g.maxEdge ? g.maxEdge / longEdge : 1;
  // Clamp rounded source coords to the image bounds so drawImage never throws
  // IndexSizeError on a sub-pixel rounding overflow.
  const rsx = Math.round(sx);
  const rsy = Math.round(sy);
  const rsw = Math.min(Math.round(sw), g.naturalWidth - rsx);
  const rsh = Math.min(Math.round(sh), g.naturalHeight - rsy);
  if (rsw < MIN_NATURAL_EDGE || rsh < MIN_NATURAL_EDGE) return null;
  return {
    sx: rsx,
    sy: rsy,
    sw: rsw,
    sh: rsh,
    outW: Math.max(1, Math.round(rsw * k)),
    outH: Math.max(1, Math.round(rsh * k)),
  };
};

const snap = (n: number, grid = 8): number => Math.round(n / grid) * grid;

export const regionCacheKey = (sectionIndex: number, rect: CropRect, targetLang: string): string =>
  `${sectionIndex}:${snap(rect.left)},${snap(rect.top)},${snap(rect.right - rect.left)},${snap(
    rect.bottom - rect.top,
  )}:${targetLang}`;

// Thin DOM glue (not unit-tested): crop the page image to a JPEG blob.
export const captureRegionToBlob = async (
  source: CanvasImageSource,
  crop: CropResult,
): Promise<Blob | null> => {
  const canvas = document.createElement('canvas');
  canvas.width = crop.outW;
  canvas.height = crop.outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.outW, crop.outH);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
};
