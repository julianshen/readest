import { describe, it, expect, vi } from 'vitest';

// Mock environment module
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

// Mock Tauri HTTP plugin
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

// Stub Supabase so importing the full providers registry (which pulls in
// deepl.ts → @/utils/access → @/utils/supabase) doesn't instantiate a real
// GoTrueClient on every `vi.resetModules()` round. Without this, each test
// that dynamically imports the registry logs a "Multiple GoTrueClient
// instances" warning from the real Supabase client.
vi.mock('@/utils/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    from: vi.fn(),
  },
}));

vi.stubGlobal('fetch', vi.fn());

import {
  isTranslatorAvailable,
  getTranslatorDisplayLabel,
  getTranslator,
} from '@/services/translators/providers';
import type { TranslationProvider } from '@/services/translators/types';

const makeProvider = (overrides: Partial<TranslationProvider>): TranslationProvider => ({
  name: 'fake',
  label: 'Fake',
  translate: async (texts) => texts,
  ...overrides,
});

describe('isTranslatorAvailable with isAvailable hook', () => {
  it('returns false when isAvailable() is false', () => {
    const p = makeProvider({ isAvailable: () => false });
    expect(isTranslatorAvailable(p, true)).toBe(false);
  });

  it('returns true when isAvailable() is true', () => {
    const p = makeProvider({ isAvailable: () => true });
    expect(isTranslatorAvailable(p, false)).toBe(true);
  });

  it('providers without the hook keep existing token-based behavior', () => {
    expect(isTranslatorAvailable(makeProvider({ authRequired: true }), false)).toBe(false);
    expect(isTranslatorAvailable(makeProvider({ authRequired: true }), true)).toBe(true);
  });

  it('disabled takes priority over isAvailable()', () => {
    const p = makeProvider({ disabled: true, isAvailable: () => true });
    expect(isTranslatorAvailable(p, true)).toBe(false);
  });
});

describe('getTranslatorDisplayLabel with isAvailable hook', () => {
  it('appends API Key Required when isAvailable() is false', () => {
    const p = makeProvider({ isAvailable: () => false });
    const label = getTranslatorDisplayLabel(p, true, (k) => k);
    expect(label).toBe('Fake (API Key Required)');
  });
});

describe('openai translator registration', () => {
  it('is registered in the translators registry', () => {
    const t = getTranslator('openai');
    expect(t).toBeDefined();
    expect(t!.name).toBe('openai');
    expect(typeof t!.isAvailable).toBe('function');
  });
});
