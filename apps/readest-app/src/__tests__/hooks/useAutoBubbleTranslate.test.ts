import { describe, expect, it, vi, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  regionsToMarkers,
  useAutoBubbleTranslate,
} from '@/app/reader/hooks/useAutoBubbleTranslate';
import type { OverlayGeometry } from '@/utils/bubbleOverlay';
import type { DetectedRegion, TranslatedRegion } from '@/services/ocr/types';
import { ocrPageRegions } from '@/services/ocr/ocrBackend';

vi.mock('@/services/ocr/ocrBackend', () => ({ ocrPageRegions: vi.fn() }));

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

describe('useAutoBubbleTranslate run()', () => {
  const reg = (id: number): DetectedRegion => ({
    id,
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    original: 'x',
  });
  const args = (sectionIndex: number) => ({
    cacheKeyParts: { bookKey: 'k', sectionIndex, target: 'en' },
    imageBytes: new Uint8Array(),
    geometry: geom,
    sourceLang: 'ja' as const,
    langs: { source: 'ja', target: 'en' },
    translate: async (input: string[]) => input, // identity
  });

  it('ignores a stale run superseded by a newer one', async () => {
    let resolveStale!: (r: DetectedRegion[]) => void;
    (ocrPageRegions as Mock)
      .mockImplementationOnce(() => new Promise<DetectedRegion[]>((r) => (resolveStale = r)))
      .mockImplementationOnce(() => Promise.resolve([reg(9)]));

    const { result } = renderHook(() => useAutoBubbleTranslate());

    let stalePromise!: Promise<void>;
    act(() => {
      stalePromise = result.current.run(args(0)); // page A: OCR stays pending
    });
    await act(async () => {
      await result.current.run(args(1)); // page B: resolves, commits markers [9]
    });
    expect(result.current.markers.map((m) => m.id)).toEqual([9]);

    await act(async () => {
      resolveStale([reg(1)]); // page A finally resolves — must NOT overwrite
      await stalePromise;
    });
    expect(result.current.markers.map((m) => m.id)).toEqual([9]);
  });
});
