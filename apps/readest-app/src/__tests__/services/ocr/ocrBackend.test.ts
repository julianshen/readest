import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { ocrPageRegions } from '@/services/ocr/ocrBackend';

afterEach(() => invoke.mockReset());

describe('ocrPageRegions', () => {
  it('calls the ocr_page_regions command with bytes as a number array and the source lang', async () => {
    invoke.mockResolvedValue([{ id: 0, bbox: { x: 1, y: 2, w: 3, h: 4 }, original: 'あ' }]);
    const out = await ocrPageRegions(new Uint8Array([7, 8, 9]), 'ja');
    expect(invoke).toHaveBeenCalledWith('ocr_page_regions', {
      imageBytes: [7, 8, 9],
      sourceLang: 'ja',
    });
    expect(out).toEqual([{ id: 0, bbox: { x: 1, y: 2, w: 3, h: 4 }, original: 'あ' }]);
  });
});
