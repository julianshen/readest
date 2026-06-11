import { describe, it, expect } from 'vitest';
import { getAIProvider } from '@/services/ai/providers';
import { OpenAIProvider } from '@/services/ai/providers/OpenAIProvider';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import type { AISettings } from '@/services/ai/types';

const settingsWithKey = (overrides: Partial<AISettings> = {}): AISettings => ({
  ...DEFAULT_AI_SETTINGS,
  provider: 'openai',
  openaiApiKey: 'sk-test',
  ...overrides,
});

describe('OpenAIProvider', () => {
  it('getAIProvider returns an OpenAIProvider for provider "openai"', () => {
    const provider = getAIProvider(settingsWithKey());
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.id).toBe('openai');
  });

  it('getAIProvider throws when the OpenAI key is missing', () => {
    expect(() => getAIProvider({ ...DEFAULT_AI_SETTINGS, provider: 'openai' })).toThrow(
      /API key required/i,
    );
  });

  it('isAvailable reflects key presence', async () => {
    const provider = new OpenAIProvider(settingsWithKey());
    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  it('uses the default base URL and strips trailing slashes from overrides', () => {
    const provider = new OpenAIProvider(
      settingsWithKey({ openaiBaseUrl: 'https://example.com/v1///' }),
    );
    expect(provider.baseUrl).toBe('https://example.com/v1');
    const defaulted = new OpenAIProvider(settingsWithKey({ openaiBaseUrl: undefined }));
    expect(defaulted.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('getModel uses the configured model id with gpt-4o-mini fallback', () => {
    const provider = new OpenAIProvider(settingsWithKey({ openaiModel: 'gpt-4.1' }));
    expect((provider.getModel() as { modelId: string }).modelId).toBe('gpt-4.1');
    const defaulted = new OpenAIProvider(settingsWithKey({ openaiModel: undefined }));
    expect((defaulted.getModel() as { modelId: string }).modelId).toBe('gpt-4o-mini');
  });
});
