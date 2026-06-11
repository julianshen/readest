import { describe, it, expect } from 'vitest';
import { chapterSummaryKey, hashContent } from '@/services/ai/storage/aiStore';

describe('chapter summary cache keys', () => {
  it('builds stable keys', () => {
    expect(chapterSummaryKey('abc', 3)).toBe('abc:3');
  });
  it('hashes content stably and differentiates', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello')).not.toBe(hashContent('hellp'));
  });
  it('differentiates non-ASCII content (CJK, emoji)', () => {
    expect(hashContent('雙城記')).not.toBe(hashContent('双城记'));
    expect(hashContent('a📖b')).not.toBe(hashContent('a📕b'));
  });
});
