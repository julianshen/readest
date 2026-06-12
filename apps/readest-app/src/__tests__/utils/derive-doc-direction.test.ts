import { describe, expect, it } from 'vitest';

import { deriveDocDirection } from '@/utils/book';

describe('deriveDocDirection', () => {
  const base = {
    writingDir: undefined,
    uiRtl: false,
    writingMode: 'auto' as const,
    isFixedLayout: false,
    bookDir: undefined,
  };

  it('defaults to horizontal ltr', () => {
    expect(deriveDocDirection(base)).toEqual({ vertical: false, rtl: false });
  });

  it('uses the document writing direction when present', () => {
    expect(deriveDocDirection({ ...base, writingDir: { vertical: true, rtl: true } })).toEqual({
      vertical: true,
      rtl: true,
    });
  });

  it('derives rtl from writingMode horizontal-rl', () => {
    expect(deriveDocDirection({ ...base, writingMode: 'horizontal-rl' }).rtl).toBe(true);
  });

  it('derives vertical and rtl from writingMode vertical-rl', () => {
    expect(deriveDocDirection({ ...base, writingMode: 'vertical-rl' })).toEqual({
      vertical: true,
      rtl: true,
    });
  });

  it('derives rtl from book.dir for fixed-layout books (RTL manga)', () => {
    expect(deriveDocDirection({ ...base, isFixedLayout: true, bookDir: 'rtl' }).rtl).toBe(true);
  });

  it('ignores book.dir for reflowable books', () => {
    expect(deriveDocDirection({ ...base, bookDir: 'rtl' }).rtl).toBe(false);
  });

  it('derives rtl from an RTL UI language', () => {
    expect(deriveDocDirection({ ...base, uiRtl: true }).rtl).toBe(true);
  });
});
