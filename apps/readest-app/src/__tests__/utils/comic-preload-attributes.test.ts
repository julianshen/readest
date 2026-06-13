import { describe, expect, it } from 'vitest';

import { getComicPreloadAttributes } from '@/utils/comicPreload';

describe('getComicPreloadAttributes', () => {
  it('uses a 128 MB byte cap off Android', () => {
    expect(getComicPreloadAttributes(false)).toEqual({
      'preload-ahead': '3',
      'preload-behind': '1',
      'cache-spreads': '8',
      'preload-concurrency': '2',
      'cache-bytes': String(128 * 1024 * 1024),
    });
  });

  it('halves the byte cap to 64 MB on Android', () => {
    expect(getComicPreloadAttributes(true)['cache-bytes']).toBe(String(64 * 1024 * 1024));
  });
});
