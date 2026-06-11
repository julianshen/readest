import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock fetch for provider tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// mock logger
vi.mock('@/services/ai/logger', () => ({
  aiLogger: {
    provider: {
      init: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// mock @ai-sdk/openai-compatible so OpenAIProvider can be constructed
// without going over the network during unit tests.
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => ({
    chatModel: vi.fn((id: string) => ({ modelId: id })),
    textEmbeddingModel: vi.fn((id: string) => ({ modelId: id })),
  })),
}));

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    provider.getModel();
    const instance = vi.mocked(createOpenAICompatible).mock.results[0]?.value as {
      chatModel: ReturnType<typeof vi.fn>;
    };
    expect(instance.chatModel).toHaveBeenCalledWith('gpt-4.1');

    vi.clearAllMocks();

    const defaulted = new OpenAIProvider(settingsWithKey({ openaiModel: undefined }));
    defaulted.getModel();
    const defaultInstance = vi.mocked(createOpenAICompatible).mock.results[0]?.value as {
      chatModel: ReturnType<typeof vi.fn>;
    };
    expect(defaultInstance.chatModel).toHaveBeenCalledWith('gpt-4o-mini');
  });

  it('healthCheck succeeds when /models responds OK', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const provider = new OpenAIProvider(
      settingsWithKey({ openaiBaseUrl: 'https://api.openai.com/v1' }),
    );

    expect(await provider.healthCheck()).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
  });

  it('healthCheck returns false when /models fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const provider = new OpenAIProvider(settingsWithKey());

    expect(await provider.healthCheck()).toBe(false);
  });
});
