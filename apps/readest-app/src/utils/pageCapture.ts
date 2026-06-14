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
  const localLeft = (g.screenRect.left - g.frameRect.left) / g.frameScaleX;
  const localTop = (g.screenRect.top - g.frameRect.top) / g.frameScaleY;
  const localRight = (g.screenRect.right - g.frameRect.left) / g.frameScaleX;
  const localBottom = (g.screenRect.bottom - g.frameRect.top) / g.frameScaleY;

  const clampedLeft = Math.max(localLeft, g.imgRect.left);
  const clampedTop = Math.max(localTop, g.imgRect.top);
  const clampedRight = Math.min(localRight, g.imgRect.right);
  const clampedBottom = Math.min(localBottom, g.imgRect.bottom);
  if (clampedRight <= clampedLeft || clampedBottom <= clampedTop) return null;

  const kx = g.naturalWidth / (g.imgRect.right - g.imgRect.left);
  const ky = g.naturalHeight / (g.imgRect.bottom - g.imgRect.top);
  const sx = (clampedLeft - g.imgRect.left) * kx;
  const sy = (clampedTop - g.imgRect.top) * ky;
  const sw = (clampedRight - clampedLeft) * kx;
  const sh = (clampedBottom - clampedTop) * ky;
  if (sw < MIN_NATURAL_EDGE || sh < MIN_NATURAL_EDGE) return null;

  const longEdge = Math.max(sw, sh);
  const k = longEdge > g.maxEdge ? g.maxEdge / longEdge : 1;
  return {
    sx: Math.round(sx),
    sy: Math.round(sy),
    sw: Math.round(sw),
    sh: Math.round(sh),
    outW: Math.round(sw * k),
    outH: Math.round(sh * k),
  };
};

const snap = (n: number, grid = 8): number => Math.round(n / grid) * grid;

export const regionCacheKey = (sectionIndex: number, rect: CropRect, targetLang: string): string =>
  `${sectionIndex}:${snap(rect.left)},${snap(rect.top)},${snap(rect.right - rect.left)},${snap(
    rect.bottom - rect.top,
  )}:${targetLang}`;

// Thin DOM glue (not unit-tested): crop the page image to a JPEG blob.
export const captureRegionToBlob = async (
  img: HTMLImageElement,
  crop: CropResult,
): Promise<Blob | null> => {
  const canvas = document.createElement('canvas');
  canvas.width = crop.outW;
  canvas.height = crop.outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.outW, crop.outH);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
};
