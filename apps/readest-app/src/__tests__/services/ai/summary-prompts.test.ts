import { describe, it, expect } from 'vitest';
import { buildChapterSummaryPrompt, buildRecapPrompt } from '@/services/ai/prompts';

describe('summary prompts', () => {
  it('chapter prompt embeds title and constrains length and spoilers', () => {
    const p = buildChapterSummaryPrompt('Dune', 'Chapter 3', 'English');
    expect(p).toContain('Dune');
    expect(p).toContain('Chapter 3');
    expect(p).toMatch(/200 words/i);
    expect(p).toMatch(/only the provided text/i);
    expect(p).toMatch(/never use outside knowledge/i);
  });

  it('chapter prompt instructs the model to write in the book language', () => {
    const p = buildChapterSummaryPrompt('裁判', 'Chapter 1', 'Japanese');
    expect(p).toMatch(/in Japanese/i);
  });

  it('recap prompt embeds the book title and present-tense instruction', () => {
    const p = buildRecapPrompt('Dune', 'English');
    expect(p).toContain('Dune');
    expect(p).toMatch(/story so far/i);
    expect(p).toMatch(/do not (mention|reveal|speculate)/i);
  });

  it('recap prompt instructs the model to write in the book language', () => {
    const p = buildRecapPrompt('裁判', 'Japanese');
    expect(p).toMatch(/in Japanese/i);
  });
});
