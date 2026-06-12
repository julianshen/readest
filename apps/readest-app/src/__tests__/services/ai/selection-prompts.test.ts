import { describe, it, expect } from 'vitest';
import { buildExplainPrompt, buildDefinePrompt, buildSimplifyPrompt } from '@/services/ai/prompts';

describe('selection prompts', () => {
  it('explain prompt pins language, forbids outside knowledge, caps length', () => {
    const p = buildExplainPrompt('English');
    expect(p).toMatch(/in English/i);
    expect(p).toMatch(/only the provided text/i);
    expect(p).toMatch(/120 words/i);
  });

  it('define prompt pins language and asks for the contextual sense', () => {
    const p = buildDefinePrompt('French');
    expect(p).toMatch(/in French/i);
    expect(p).toMatch(/only the provided text/i);
    expect(p).toMatch(/used here|as it is used/i);
  });

  it('simplify prompt pins language and asks for the rewrite only', () => {
    const p = buildSimplifyPrompt('Japanese');
    expect(p).toMatch(/simpler.*Japanese/i);
    expect(p).toMatch(/only the rewritten|output only/i);
  });
});
