import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── env-safety mocks (same header as availability.test.ts) ──────────────────
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: vi.fn(() => false),
  getAPIBaseUrl: vi.fn(() => 'https://api.example.com'),
}));

vi.mock('@/utils/misc', () => ({
  stubTranslation: (s: string) => s,
}));

vi.mock('@/utils/lang', () => ({
  normalizeToShortLang: vi.fn((lang: string) => {
    const map: Record<string, string> = {
      'en-US': 'en',
      'fr-FR': 'fr',
      'zh-CN': 'zh',
      AUTO: 'auto',
      en: 'en',
      fr: 'fr',
      de: 'de',
      zh: 'zh',
      auto: 'auto',
    };
    return map[lang] ?? lang;
  }),
  normalizeToFullLang: vi.fn((lang: string) => {
    const map: Record<string, string> = {
      en: 'en',
      fr: 'fr',
      de: 'de',
      zh: 'zh-Hans',
      auto: 'auto',
    };
    return map[lang] ?? lang;
  }),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

vi.mock('@/utils/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    from: vi.fn(),
  },
}));

vi.stubGlobal('fetch', vi.fn());

// ── module-under-test mocks ─────────────────────────────────────────────────

// Use vi.hoisted so the mock factories can reference these variables safely
// after hoisting (vi.mock calls are moved to the top of the file by vitest).
const { generateTextMock, getModelMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  getModelMock: vi.fn(() => ({ modelId: 'gpt-4o-mini' })),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});

// The provider factory pulls in transport/logger via the provider classes;
// stub the whole registry. The translator resolves its model through
// getAIProvider() so it follows whatever provider the AI assistant uses.
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: vi.fn(() => ({ getModel: getModelMock })),
}));

import { useSettingsStore } from '@/store/settingsStore';
import { openaiProvider } from '@/services/translators/providers/openai';
import { ErrorCodes } from '@/services/translators/types';

const setAiSettings = (aiSettings: Record<string, unknown> | undefined) => {
  useSettingsStore.setState(
    (state) =>
      ({
        settings: { ...state.settings, aiSettings },
      }) as never,
  );
};

beforeEach(() => {
  generateTextMock.mockReset();
  setAiSettings({
    enabled: true,
    provider: 'openai',
    openaiApiKey: 'sk-test',
    openaiModel: 'gpt-4o-mini',
  });
});

describe('openai translation provider', () => {
  it('is unavailable until the AI assistant is enabled and configured', () => {
    setAiSettings({});
    expect(openaiProvider.isAvailable!()).toBe(false);
    // configured but assistant disabled
    setAiSettings({ enabled: false, provider: 'openai', openaiApiKey: 'sk-test' });
    expect(openaiProvider.isAvailable!()).toBe(false);
    // enabled but provider missing its key
    setAiSettings({ enabled: true, provider: 'openai' });
    expect(openaiProvider.isAvailable!()).toBe(false);
    setAiSettings({ enabled: true, provider: 'openai', openaiApiKey: 'sk-test' });
    expect(openaiProvider.isAvailable!()).toBe(true);
  });

  it('follows the AI assistant provider selection, not just OpenAI', () => {
    setAiSettings({ enabled: true, provider: 'openrouter', openrouterApiKey: 'or-test' });
    expect(openaiProvider.isAvailable!()).toBe(true);
    setAiSettings({
      enabled: true,
      provider: 'ollama',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'llama3.2',
    });
    expect(openaiProvider.isAvailable!()).toBe(true);
    setAiSettings({ enabled: true, provider: 'ai-gateway' });
    expect(openaiProvider.isAvailable!()).toBe(false);
    setAiSettings({ enabled: true, provider: 'ai-gateway', aiGatewayApiKey: 'gw-test' });
    expect(openaiProvider.isAvailable!()).toBe(true);
  });

  it('translates a batch and preserves order', async () => {
    generateTextMock.mockResolvedValue({ text: '["Hallo","Welt"]' });
    const out = await openaiProvider.translate(['Hello', 'World'], 'en', 'de');
    expect(out).toEqual(['Hallo', 'Welt']);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]![0];
    expect(call.temperature).toBe(0);
    expect(call.prompt).toBe(JSON.stringify(['Hello', 'World']));
    expect(call.model).toEqual({ modelId: 'gpt-4o-mini' });
  });

  it('passes empty lines through without sending them', async () => {
    generateTextMock.mockResolvedValue({ text: '["Hallo"]' });
    const out = await openaiProvider.translate(['Hello', '  ', ''], 'en', 'de');
    expect(out).toEqual(['Hallo', '  ', '']);
    expect(generateTextMock.mock.calls[0]![0].prompt).toBe(JSON.stringify(['Hello']));
  });

  it('returns [] for an empty batch without calling the API', async () => {
    await expect(openaiProvider.translate([], 'en', 'de')).resolves.toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('retries once on malformed output, then succeeds', async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: 'not json at all' })
      .mockResolvedValueOnce({ text: '["Hallo"]' });
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).resolves.toEqual(['Hallo']);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('throws after a second malformed response', async () => {
    generateTextMock.mockResolvedValue({ text: '["wrong","length"]' });
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).rejects.toThrow();
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('throws when array elements are not strings', async () => {
    generateTextMock.mockResolvedValue({ text: '[null]' });
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).rejects.toThrow();
    expect(generateTextMock).toHaveBeenCalledTimes(2); // retried
  });

  it('accepts a fenced JSON code block', async () => {
    generateTextMock.mockResolvedValue({ text: '```json\n["Hallo"]\n```' });
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).resolves.toEqual(['Hallo']);
  });

  it('maps 401 to UNAUTHORIZED without retrying', async () => {
    const err = Object.assign(new Error('bad key'), { statusCode: 401 });
    generateTextMock.mockRejectedValue(err);
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).rejects.toThrow(
      ErrorCodes.UNAUTHORIZED,
    );
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('maps 403 to UNAUTHORIZED without retrying', async () => {
    const err = Object.assign(new Error('forbidden'), { statusCode: 403 });
    generateTextMock.mockRejectedValue(err);
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).rejects.toThrow(
      ErrorCodes.UNAUTHORIZED,
    );
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('maps 429 to DAILY_QUOTA_EXCEEDED', async () => {
    const err = Object.assign(new Error('rate limited'), { statusCode: 429 });
    generateTextMock.mockRejectedValue(err);
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).rejects.toThrow(
      ErrorCodes.DAILY_QUOTA_EXCEEDED,
    );
  });

  it('throws UNAUTHORIZED when the assistant is not configured', async () => {
    setAiSettings({});
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).rejects.toThrow(
      ErrorCodes.UNAUTHORIZED,
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
