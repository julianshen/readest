import { describe, expect, it } from 'vitest';

import { findNextInSeries } from '@/app/library/utils/libraryUtils';
import type { Book } from '@/types/book';

const mk = (hash: string, title: string, series?: string, seriesIndex?: number): Book =>
  ({ hash, title, metadata: { title, series, seriesIndex } }) as unknown as Book;

describe('findNextInSeries', () => {
  it('returns null when the book has no series', () => {
    const book = mk('a', 'Loner');
    expect(findNextInSeries([book], book)).toBeNull();
  });

  it('returns the lowest seriesIndex greater than the current', () => {
    const v1 = mk('a', 'Vol 1', 'S', 1);
    const v2 = mk('b', 'Vol 2', 'S', 2);
    const v3 = mk('c', 'Vol 3', 'S', 3);
    expect(findNextInSeries([v3, v1, v2], v1)?.hash).toBe('b');
  });

  it('skips gaps (1 -> 3 when 2 is missing)', () => {
    const v1 = mk('a', 'Vol 1', 'S', 1);
    const v3 = mk('c', 'Vol 3', 'S', 3);
    expect(findNextInSeries([v1, v3], v1)?.hash).toBe('c');
  });

  it('returns null when the current is the last volume', () => {
    const v1 = mk('a', 'Vol 1', 'S', 1);
    const v2 = mk('b', 'Vol 2', 'S', 2);
    expect(findNextInSeries([v1, v2], v2)).toBeNull();
  });

  it('ignores books from other series', () => {
    const v1 = mk('a', 'Vol 1', 'S', 1);
    const other = mk('z', 'Other 2', 'T', 2);
    expect(findNextInSeries([v1, other], v1)).toBeNull();
  });

  it('does not fall back to title order when an indexed book has no indexed successor', () => {
    const v1 = mk('a', 'Vol 1', 'S', 1);
    const v2 = mk('b', 'Vol 2', 'S', 2);
    const extra = mk('z', 'Zebra', 'S'); // no index, sorts after v2 by title
    // v2 is the last indexed volume; an un-indexed companion must NOT be offered.
    expect(findNextInSeries([v1, v2, extra], v2)).toBeNull();
  });

  it('falls back to title order when indices are absent', () => {
    const a = mk('a', 'Arc A', 'S');
    const b = mk('b', 'Arc B', 'S');
    const c = mk('c', 'Arc C', 'S');
    expect(findNextInSeries([c, a, b], a)?.hash).toBe('b');
  });
});
