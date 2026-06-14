import { describe, expect, it } from 'vitest';

import { selectSpreadsToEvict } from 'foliate-js/fixed-layout.js';

type Entry = { key: string; accessTime: number; bytes: number };

const entries = (...rows: [string, number, number][]): Entry[] =>
  rows.map(([key, accessTime, bytes]) => ({ key, accessTime, bytes }));

describe('selectSpreadsToEvict', () => {
  it('evicts nothing when under both caps', () => {
    const e = entries(['spread-0', 1, 10], ['spread-1', 2, 10]);
    expect(selectSpreadsToEvict(e, { maxSpreads: 8, maxBytes: 100 })).toEqual([]);
  });

  it('evicts oldest first until within the count cap', () => {
    const e = entries(['spread-0', 1, 5], ['spread-1', 3, 5], ['spread-2', 2, 5]);
    // 3 entries, cap 2 -> drop the single oldest by accessTime (spread-0 @1)
    expect(selectSpreadsToEvict(e, { maxSpreads: 2, maxBytes: Infinity })).toEqual(['spread-0']);
  });

  it('evicts oldest first until within the byte cap', () => {
    const e = entries(['spread-0', 1, 60], ['spread-1', 2, 60], ['spread-2', 3, 60]);
    // total 180 > 100; drop oldest (60) -> 120 still > 100; drop next (60) -> 60 ok
    expect(selectSpreadsToEvict(e, { maxSpreads: 99, maxBytes: 100 })).toEqual([
      'spread-0',
      'spread-1',
    ]);
  });

  it('never evicts a protected key even when it is the oldest', () => {
    const e = entries(['spread-0', 1, 50], ['spread-1', 2, 50], ['spread-2', 3, 50]);
    // 3 entries, cap 2 -> evict one; the oldest (spread-0) is protected, so the
    // next-oldest unprotected (spread-1) is evicted instead.
    expect(
      selectSpreadsToEvict(e, { maxSpreads: 2, maxBytes: Infinity, protectedKeys: ['spread-0'] }),
    ).toEqual(['spread-1']);
  });

  it('stops evicting when only protected keys remain even if still over cap', () => {
    const e = entries(['spread-0', 1, 50], ['spread-1', 2, 50]);
    expect(
      selectSpreadsToEvict(e, {
        maxSpreads: 0,
        maxBytes: 0,
        protectedKeys: ['spread-0', 'spread-1'],
      }),
    ).toEqual([]);
  });
});
