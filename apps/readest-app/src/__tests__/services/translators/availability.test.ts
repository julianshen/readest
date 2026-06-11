import { describe, it, expect } from 'vitest';
import { isTranslatorAvailable, getTranslatorDisplayLabel } from '@/services/translators/providers';
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
});

describe('getTranslatorDisplayLabel with isAvailable hook', () => {
  it('appends API Key Required when isAvailable() is false', () => {
    const p = makeProvider({ isAvailable: () => false });
    const label = getTranslatorDisplayLabel(p, true, (k) => k);
    expect(label).toBe('Fake (API Key Required)');
  });
});
