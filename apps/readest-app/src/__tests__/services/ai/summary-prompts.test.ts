import { describe, it, expect } from 'vitest';
import { buildChapterSummaryPrompt, buildRecapPrompt } from '@/services/ai/prompts';

describe('summary prompts', () => {
  it('chapter prompt embeds title and constrains length and spoilers', () => {
    const p = buildChapterSummaryPrompt('Dune', 'Chapter 3');
    expect(p).toContain('Dune');
    expect(p).toContain('Chapter 3');
    expect(p).toMatch(/200 words/i);
    expect(p).toMatch(/only the provided text/i);
  });

  it('recap prompt embeds the book title and present-tense instruction', () => {
    const p = buildRecapPrompt('Dune');
    expect(p).toContain('Dune');
    expect(p).toMatch(/story so far/i);
    expect(p).toMatch(/do not (mention|reveal|speculate)/i);
  });
});
