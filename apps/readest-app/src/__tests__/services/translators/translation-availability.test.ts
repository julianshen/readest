import { describe, it, expect } from 'vitest';

import {
  getTranslationUnavailableReason,
  isTranslationAvailable,
} from '@/services/translators/utils';
import type { Book } from '@/types/book';

const book = (over: Partial<Book>): Book =>
  ({ format: 'EPUB', primaryLanguage: 'en', ...over }) as Book;

describe('getTranslationUnavailableReason', () => {
  it('returns no-book when the book is missing', () => {
    expect(getTranslationUnavailableReason(null, 'de')).toBe('no-book');
    expect(getTranslationUnavailableReason(undefined, 'de')).toBe('no-book');
  });

  it('returns pdf for PDF books', () => {
    expect(getTranslationUnavailableReason(book({ format: 'PDF' }), 'de')).toBe('pdf');
  });

  it('returns no-language when the book has no usable primary language', () => {
    expect(getTranslationUnavailableReason(book({ primaryLanguage: '' }), 'de')).toBe(
      'no-language',
    );
    expect(getTranslationUnavailableReason(book({ primaryLanguage: 'und' }), 'de')).toBe(
      'no-language',
    );
  });

  it('returns same-language when the target matches the book language', () => {
    expect(getTranslationUnavailableReason(book({ primaryLanguage: 'en' }), 'en')).toBe(
      'same-language',
    );
    expect(getTranslationUnavailableReason(book({ primaryLanguage: 'en-US' }), 'en')).toBe(
      'same-language',
    );
  });

  it('returns null (available) when the target differs from the source', () => {
    expect(getTranslationUnavailableReason(book({ primaryLanguage: 'en' }), 'de')).toBeNull();
  });
});

describe('isTranslationAvailable delegates to the reason', () => {
  it('is true only when there is no blocking reason', () => {
    expect(isTranslationAvailable(book({ primaryLanguage: 'en' }), 'de')).toBe(true);
    expect(isTranslationAvailable(book({ primaryLanguage: 'en' }), 'en')).toBe(false);
    expect(isTranslationAvailable(book({ format: 'PDF' }), 'de')).toBe(false);
    expect(isTranslationAvailable(null, 'de')).toBe(false);
  });
});
