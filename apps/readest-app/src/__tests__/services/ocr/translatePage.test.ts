import { describe, expect, it, vi } from 'vitest';
import { translateRegions, pageCacheKey } from '@/services/ocr/translatePage';
import type { DetectedRegion } from '@/services/ocr/types';

const regions: DetectedRegion[] = [
  { id: 0, bbox: { x: 0, y: 0, w: 1, h: 1 }, original: 'あ' },
  { id: 1, bbox: { x: 2, y: 2, w: 1, h: 1 }, original: '   ' }, // blank
];

describe('translateRegions', () => {
  it('translates non-blank originals in one batch, preserving order/ids', async () => {
    const translate = vi.fn().mockResolvedValue(['A']);
    const out = await translateRegions(regions, translate, { source: 'ja', target: 'en' });
    expect(translate).toHaveBeenCalledWith(['あ'], { source: 'ja', target: 'en' });
    expect(out).toEqual([
      { id: 0, bbox: { x: 0, y: 0, w: 1, h: 1 }, original: 'あ', translation: 'A' },
      { id: 1, bbox: { x: 2, y: 2, w: 1, h: 1 }, original: '   ', translation: '' },
    ]);
  });

  it('falls back to the original text when translation fails', async () => {
    const translate = vi.fn().mockRejectedValue(new Error('net'));
    const out = await translateRegions(regions, translate, { source: 'ja', target: 'en' });
    expect(out[0]?.translation).toBe('あ');
  });
});

describe('pageCacheKey', () => {
  it('is stable per book + section + target language', () => {
    expect(pageCacheKey('book#1', 3, 'en')).toBe('book#1::3::en');
  });
});
