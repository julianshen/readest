import type { OcrBBox } from '@/services/ocr/types';

// Geometry of the rendered comic page, gathered the same way
// MangaBubbleTranslator.onSelect does (iframe rect + CSS transform scale,
// image bounding rect in iframe-local coords, image natural size).
export interface OverlayGeometry {
  frameLeft: number;
  frameTop: number;
  frameScaleX: number;
  frameScaleY: number;
  imgLeft: number;
  imgTop: number;
  imgWidth: number; // rendered (iframe-local) px
  imgHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Inverse of computeNaturalCropRect: image-pixel bbox -> viewport rect.
export const mapImageBBoxToViewport = (bbox: OcrBBox, g: OverlayGeometry): ViewportRect => {
  const kx = g.imgWidth / g.naturalWidth; // natural px -> iframe-local px
  const ky = g.imgHeight / g.naturalHeight;
  const localLeft = g.imgLeft + bbox.x * kx;
  const localTop = g.imgTop + bbox.y * ky;
  return {
    left: g.frameLeft + localLeft * g.frameScaleX,
    top: g.frameTop + localTop * g.frameScaleY,
    width: bbox.w * kx * g.frameScaleX,
    height: bbox.h * ky * g.frameScaleY,
  };
};
