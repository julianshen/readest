import { describe, expect, it } from 'vitest';

import { ThumbnailLRU } from '@/utils/thumbnailCache';

describe('ThumbnailLRU', () => {
  it('returns undefined for a missing key', () => {
    const lru = new ThumbnailLRU(3);
    expect(lru.get(0)).toBeUndefined();
  });

  it('stores and retrieves by index', () => {
    const lru = new ThumbnailLRU(3);
    lru.set(2, 'data:a');
    expect(lru.get(2)).toBe('data:a');
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const lru = new ThumbnailLRU(2);
    lru.set(1, 'a');
    lru.set(2, 'b');
    lru.set(3, 'c'); // evicts 1 (oldest)
    expect(lru.get(1)).toBeUndefined();
    expect(lru.get(2)).toBe('b');
    expect(lru.get(3)).toBe('c');
  });

  it('get() marks an entry as recently used so it survives eviction', () => {
    const lru = new ThumbnailLRU(2);
    lru.set(1, 'a');
    lru.set(2, 'b');
    lru.get(1); // 1 is now most-recent; 2 is oldest
    lru.set(3, 'c'); // evicts 2
    expect(lru.get(1)).toBe('a');
    expect(lru.get(2)).toBeUndefined();
    expect(lru.get(3)).toBe('c');
  });

  it('re-setting an existing key refreshes recency without growing size', () => {
    const lru = new ThumbnailLRU(2);
    lru.set(1, 'a');
    lru.set(2, 'b');
    lru.set(1, 'a2'); // refresh 1
    lru.set(3, 'c'); // evicts 2
    expect(lru.get(1)).toBe('a2');
    expect(lru.get(2)).toBeUndefined();
    expect(lru.get(3)).toBe('c');
  });
});
