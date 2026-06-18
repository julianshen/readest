import { describe, expect, it } from 'vitest';
import { mapImageBBoxToViewport, type OverlayGeometry } from '@/utils/bubbleOverlay';

// Image is 1000x1500 natural; rendered at half scale inside an iframe that the
// fixed-layout renderer also CSS-scales by 0.5; iframe sits at viewport (100,50).
const geom: OverlayGeometry = {
  frameLeft: 100,
  frameTop: 50,
  frameScaleX: 0.5,
  frameScaleY: 0.5,
  imgLeft: 0, // image's iframe-local offset
  imgTop: 0,
  imgWidth: 500, // rendered (iframe-local) image width
  imgHeight: 750,
  naturalWidth: 1000,
  naturalHeight: 1500,
};

describe('mapImageBBoxToViewport', () => {
  it('maps an image-pixel box to a viewport rect via the iframe geometry', () => {
    // box at natural (200,300) size 100x150 -> iframe-local (100,150) size 50x75
    // -> viewport: left = 100 + 100*0.5 = 150; top = 50 + 150*0.5 = 125; w=25; h=37.5
    expect(mapImageBBoxToViewport({ x: 200, y: 300, w: 100, h: 150 }, geom)).toEqual({
      left: 150,
      top: 125,
      width: 25,
      height: 37.5,
    });
  });

  it('is the inverse of the rendered-to-natural ratio at the origin', () => {
    expect(mapImageBBoxToViewport({ x: 0, y: 0, w: 0, h: 0 }, geom)).toEqual({
      left: 100,
      top: 50,
      width: 0,
      height: 0,
    });
  });
});
