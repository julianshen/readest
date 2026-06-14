import { describe, expect, it } from 'vitest';

import { computeNaturalCropRect, regionCacheKey } from '@/utils/pageCapture';

const rect = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe('computeNaturalCropRect', () => {
  it('maps a screen rect through frame offset/scale to natural image pixels', () => {
    // frame at (100,50) in viewport, scale 1; img fills 0..400 x 0..600 in-frame;
    // natural 800x1200 → 2x. Drag screen (200,150)-(300,350) → in-frame (100,100)-(200,300)
    // → natural (200,200)-(400,600): sx200 sy200 sw200 sh400.
    const out = computeNaturalCropRect({
      screenRect: rect(200, 150, 300, 350),
      frameRect: rect(100, 50, 500, 650),
      frameScaleX: 1,
      frameScaleY: 1,
      imgRect: rect(0, 0, 400, 600),
      naturalWidth: 800,
      naturalHeight: 1200,
      maxEdge: 4096,
    });
    expect(out).toEqual({ sx: 200, sy: 200, sw: 200, sh: 400, outW: 200, outH: 400 });
  });

  it('caps the long edge at maxEdge, preserving aspect', () => {
    const out = computeNaturalCropRect({
      screenRect: rect(0, 0, 100, 200),
      frameRect: rect(0, 0, 100, 200),
      frameScaleX: 1,
      frameScaleY: 1,
      imgRect: rect(0, 0, 100, 200),
      naturalWidth: 2000,
      naturalHeight: 4000,
      maxEdge: 1000,
    });
    // sw=2000 sh=4000 → long edge 4000 capped to 1000 (k=0.25): outW=500 outH=1000
    expect(out).toMatchObject({ sw: 2000, sh: 4000, outW: 500, outH: 1000 });
  });

  it('clamps the crop to the image bounds', () => {
    const out = computeNaturalCropRect({
      screenRect: rect(-50, -50, 50, 50),
      frameRect: rect(0, 0, 100, 100),
      frameScaleX: 1,
      frameScaleY: 1,
      imgRect: rect(0, 0, 100, 100),
      naturalWidth: 100,
      naturalHeight: 100,
      maxEdge: 4096,
    });
    expect(out).toMatchObject({ sx: 0, sy: 0, sw: 50, sh: 50 });
  });

  it('returns null for a degenerate (too small) region', () => {
    const out = computeNaturalCropRect({
      screenRect: rect(10, 10, 12, 12),
      frameRect: rect(0, 0, 100, 100),
      frameScaleX: 1,
      frameScaleY: 1,
      imgRect: rect(0, 0, 100, 100),
      naturalWidth: 100,
      naturalHeight: 100,
      maxEdge: 4096,
    });
    expect(out).toBeNull();
  });
});

describe('regionCacheKey', () => {
  it('snaps near-identical rects (same 8px cell) to one key', () => {
    // 9 & 11 both snap to 8; 17 & 15 both snap to 16; widths/heights match.
    expect(regionCacheKey(3, rect(9, 17, 89, 113), 'English')).toBe(
      regionCacheKey(3, rect(11, 15, 87, 111), 'English'),
    );
  });

  it('keys differ by section index and target language', () => {
    expect(regionCacheKey(3, rect(9, 17, 89, 113), 'English')).not.toBe(
      regionCacheKey(4, rect(9, 17, 89, 113), 'English'),
    );
    expect(regionCacheKey(3, rect(9, 17, 89, 113), 'English')).not.toBe(
      regionCacheKey(3, rect(9, 17, 89, 113), 'Japanese'),
    );
  });
});
