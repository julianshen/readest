import { describe, it, expect } from 'vitest';
import type { BookDoc } from '@/libs/document';
import { bookLanguageName, resolveAnswerLanguageName } from '@/services/ai/answerLanguage';

const jaDoc = { metadata: { language: 'ja' } } as unknown as BookDoc;

describe('answerLanguage', () => {
  it('bookLanguageName maps the book primary language code to an English name', () => {
    expect(bookLanguageName(jaDoc)).toBe('Japanese');
  });

  it("resolveAnswerLanguageName returns the book language for 'book' and undefined", () => {
    expect(resolveAnswerLanguageName('book', jaDoc, 'en-US')).toBe('Japanese');
    expect(resolveAnswerLanguageName(undefined, jaDoc, 'en-US')).toBe('Japanese');
  });

  it("resolveAnswerLanguageName returns the UI language for 'app'", () => {
    expect(resolveAnswerLanguageName('app', jaDoc, 'en-US')).toBe('English');
  });
});
