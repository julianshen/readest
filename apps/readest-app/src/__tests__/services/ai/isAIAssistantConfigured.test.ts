import { describe, it, expect, vi } from 'vitest';
import { isAIAssistantConfigured } from '@/services/ai/providers';
import type { AISettings } from '@/services/ai/types';

// Guard: constructing an OpenRouter/OpenAI-compatible provider calls
// createOpenAICompatible. isAIAssistantConfigured runs on the reader render
// path (per page-turn), so it must NOT construct a provider just to answer
// yes/no — it should be a pure credential check.
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => ({})),
}));
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const s = (over: Partial<AISettings>): AISettings =>
  ({ enabled: true, provider: 'openrouter', ...over }) as AISettings;

describe('isAIAssistantConfigured', () => {
  it('false when disabled', () => {
    expect(isAIAssistantConfigured(s({ enabled: false, openrouterApiKey: 'k' }))).toBe(false);
  });
  it('false when provider has no key', () => {
    expect(isAIAssistantConfigured(s({ openrouterApiKey: undefined }))).toBe(false);
  });
  it('true when enabled and provider configured', () => {
    expect(isAIAssistantConfigured(s({ openrouterApiKey: 'k' }))).toBe(true);
  });
  it('true for ollama when enabled (local, no key needed)', () => {
    expect(isAIAssistantConfigured(s({ provider: 'ollama' }))).toBe(true);
  });
  it('false when settings undefined', () => {
    expect(isAIAssistantConfigured(undefined)).toBe(false);
  });

  it('does not construct a provider client (pure check, off the hot path)', () => {
    vi.mocked(createOpenAICompatible).mockClear();
    isAIAssistantConfigured(s({ openrouterApiKey: 'k' }));
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });
});
