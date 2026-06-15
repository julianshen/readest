import { describe, expect, it } from 'vitest';

import {
  captureScrollModeAnchor,
  restoreScrollModeAnchor,
  selectScrollPagesToEvict,
} from 'foliate-js/fixed-layout.js';

describe('fixed-layout scroll page eviction selection', () => {
  const pages = (indices: number[]) => indices.map((index) => ({ index }));

  it('evicts nothing when loaded pages are at or below the cap', () => {
    expect(selectScrollPagesToEvict(pages([0, 1, 2]), 1, 3)).toEqual([]);
    expect(selectScrollPagesToEvict(pages([4, 5, 6]), 5, 3)).toEqual([]);
  });

  it('evicts the pages farthest from the current index, keeping the nearest N', () => {
    const loaded = pages([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const evicted = selectScrollPagesToEvict(loaded, 0, 3).map((p) => p.index);
    expect(evicted.sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it('keeps the current page and its closest neighbors when centered', () => {
    const loaded = pages([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const evicted = selectScrollPagesToEvict(loaded, 5, 3).map((p) => p.index);
    expect(evicted).toContain(0);
    expect(evicted).toContain(9);
    expect(evicted).not.toContain(5);
    expect(evicted).toHaveLength(7);
  });
});

describe('fixed-layout scroll mode anchor preservation', () => {
  it('captures the current intra-page offset', () => {
    const anchor = captureScrollModeAnchor(
      [
        { index: 0, top: 0, height: 1000 },
        { index: 1, top: 1008, height: 1000 },
      ],
      1350,
      1,
    );

    expect(anchor).toEqual({
      index: 1,
      fraction: 0.342,
      scrollTop: 1350,
    });
  });

  it('restores the same intra-page position after page sizes change', () => {
    const anchor = captureScrollModeAnchor(
      [
        { index: 0, top: 0, height: 1000 },
        { index: 1, top: 1008, height: 1000 },
      ],
      1350,
      1,
    );

    const restored = restoreScrollModeAnchor(
      [
        { index: 0, top: 0, height: 900 },
        { index: 1, top: 908, height: 900 },
      ],
      anchor,
      5000,
    );

    expect(restored).toBeCloseTo(1215.8);
    expect(restored).not.toBe(908);
  });

  it('falls back to the previous scrollTop when the anchor page disappears', () => {
    const restored = restoreScrollModeAnchor(
      [{ index: 0, top: 0, height: 900 }],
      { index: 1, fraction: 0.4, scrollTop: 1350 },
      1200,
    );

    expect(restored).toBe(1200);
  });
});
