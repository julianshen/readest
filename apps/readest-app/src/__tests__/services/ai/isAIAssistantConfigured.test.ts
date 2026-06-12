import { describe, it, expect } from 'vitest';
import { isAIAssistantConfigured } from '@/services/ai/providers';
import type { AISettings } from '@/services/ai/types';

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
  it('false when settings undefined', () => {
    expect(isAIAssistantConfigured(undefined)).toBe(false);
  });
});
