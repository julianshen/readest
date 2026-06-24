import { describe, expect, it } from 'vitest';

import { isImagePageBook } from '@/utils/book';

describe('isImagePageBook', () => {
  it('returns true for CBZ regardless of isFixedLayout', () => {
    expect(isImagePageBook('CBZ', true)).toBe(true);
    expect(isImagePageBook('CBZ', false)).toBe(true);
  });

  it('returns true for fixed-layout EPUB', () => {
    expect(isImagePageBook('EPUB', true)).toBe(true);
  });

  it('returns true for fixed-layout MOBI', () => {
    expect(isImagePageBook('MOBI', true)).toBe(true);
  });

  it('returns false for reflowable EPUB', () => {
    expect(isImagePageBook('EPUB', false)).toBe(false);
  });

  it('returns false for fixed-layout PDF (text layer may exist)', () => {
    expect(isImagePageBook('PDF', true)).toBe(false);
  });
});
