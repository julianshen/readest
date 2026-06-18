import { describe, expect, it } from 'vitest';
import { regionsToMarkers } from '@/app/reader/hooks/useAutoBubbleTranslate';
import type { OverlayGeometry } from '@/utils/bubbleOverlay';
import type { TranslatedRegion } from '@/services/ocr/types';

const geom: OverlayGeometry = {
  frameLeft: 0,
  frameTop: 0,
  frameScaleX: 1,
  frameScaleY: 1,
  imgLeft: 0,
  imgTop: 0,
  imgWidth: 100,
  imgHeight: 100,
  naturalWidth: 100,
  naturalHeight: 100,
};

describe('regionsToMarkers', () => {
  it('maps translated regions to positioned markers (1:1 geometry)', () => {
    const regions: TranslatedRegion[] = [
      { id: 5, bbox: { x: 10, y: 20, w: 30, h: 40 }, original: 'あ', translation: 'A' },
    ];
    expect(regionsToMarkers(regions, geom)).toEqual([
      { id: 5, rect: { left: 10, top: 20, width: 30, height: 40 }, translation: 'A' },
    ]);
  });
});
