# OpenAI (ChatGPT) Translation Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate book text through the user's own OpenAI account when the translation provider is set to OpenAI and an API key is configured.

**Architecture:** A first-class `OpenAIProvider` in `src/services/ai/providers` (clone of the existing `OpenRouterProvider`, pointed at `api.openai.com`) plus an `openai` entry in the translators registry that drives that provider via the Vercel AI SDK's `generateText`. Settings live in the existing AIPanel; availability gating is a new optional `isAvailable()` hook on `TranslationProvider`.

**Tech Stack:** TypeScript, Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`, both already dependencies), Zustand settings store, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-06-11-openai-translation-design.md`

**Working directory:** all paths relative to `apps/readest-app/`. Run all commands from `apps/readest-app/`.

**Conventions that apply to every task:**
- Never use `any` (repo rule) — use `unknown` + narrowing.
- UI strings go through `_()` (`useTranslation` in components, `stubTranslation as _` in non-React modules).
- Run `pnpm lint` before each commit (tsgo + biome). lint-staged formats on commit automatically.

---

### Task 1: AISettings types and defaults for OpenAI

**Files:**
- Modify: `src/services/ai/types.ts` (lines 3, 17-36 area)
- Modify: `src/services/ai/constants.ts` (DEFAULT_AI_SETTINGS, line ~22)

- [ ] **Step 1: Add `'openai'` to the provider union and settings fields**

In `src/services/ai/types.ts`, change:

```ts
export type AIProviderName = 'ollama' | 'ai-gateway' | 'openrouter';
```

to:

```ts
export type AIProviderName = 'ollama' | 'ai-gateway' | 'openrouter' | 'openai';
```

In the `AISettings` interface, after the `openrouter*` fields block, add:

```ts
  // OpenAI's official API (or any deployment exposing the same schema, e.g.
  // Azure OpenAI / a proxy) — distinct from the generic `openrouter*` fields
  // so translation can use OpenAI even when the assistant uses another
  // provider. API key only; ChatGPT OAuth is deliberately out of scope.
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  openaiEmbeddingModel?: string;
```

- [ ] **Step 2: Add defaults**

In `src/services/ai/constants.ts`, inside `DEFAULT_AI_SETTINGS` after the `openrouter*` defaults, add:

```ts
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  openaiEmbeddingModel: 'text-embedding-3-small',
```

- [ ] **Step 3: Type-check**

Run: `pnpm lint`
Expected: passes (no consumers yet).

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/types.ts src/services/ai/constants.ts
git commit -m "feat(ai): add openai provider settings fields and defaults"
```

---

### Task 2: OpenAIProvider class + getAIProvider wiring (TDD)

**Files:**
- Create: `src/services/ai/providers/OpenAIProvider.ts`
- Modify: `src/services/ai/providers/index.ts`
- Test: `src/__tests__/services/ai/openai-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/services/ai/openai-provider.test.ts`:

```ts
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
    expect(provider.getModel().modelId).toBe('gpt-4.1');
    const defaulted = new OpenAIProvider(settingsWithKey({ openaiModel: undefined }));
    expect(defaulted.getModel().modelId).toBe('gpt-4o-mini');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/services/ai/openai-provider.test.ts`
Expected: FAIL — cannot resolve `@/services/ai/providers/OpenAIProvider`.

- [ ] **Step 3: Implement OpenAIProvider**

Create `src/services/ai/providers/OpenAIProvider.ts`. This mirrors
`OpenRouterProvider.ts` (same transport and health-check approach), minus the
OpenRouter attribution headers, with `baseUrl` public so the translator tests
can assert it:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { AIProvider, AISettings, AIProviderName } from '../types';
import { aiLogger } from '../logger';
import { AI_TIMEOUTS } from '../utils/retry';
import { getAIFetch } from '../utils/httpFetch';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * OpenAI's official API. Functionally a sibling of `OpenRouterProvider`
 * (both speak the OpenAI REST schema via `@ai-sdk/openai-compatible`), but
 * with its own credential set so translation can rely on OpenAI while the
 * assistant uses a different provider. The base URL is overridable for
 * Azure OpenAI deployments and proxies.
 *
 * Transport goes through {@link getAIFetch}: Tauri's Rust HTTP plugin in
 * the app (no CORS preflight, no Android cleartext block), window.fetch on
 * the web build.
 */
export class OpenAIProvider implements AIProvider {
  id: AIProviderName = 'openai';
  name = 'OpenAI (ChatGPT)';
  requiresAuth = true;

  readonly baseUrl: string;

  private settings: AISettings;
  private client: ReturnType<typeof createOpenAICompatible>;
  private apiKey: string;
  private httpFetch: typeof fetch;

  constructor(settings: AISettings) {
    this.settings = settings;
    if (!settings.openaiApiKey) {
      throw new Error('OpenAI API key required');
    }
    this.apiKey = settings.openaiApiKey;
    this.baseUrl = (settings.openaiBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.httpFetch = getAIFetch();
    this.client = createOpenAICompatible({
      name: 'openai',
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
      fetch: this.httpFetch,
    });
    aiLogger.provider.init('openai', settings.openaiModel || DEFAULT_MODEL);
  }

  getModel(): LanguageModel {
    const modelId = this.settings.openaiModel || DEFAULT_MODEL;
    return this.client.chatModel(modelId);
  }

  getEmbeddingModel(): EmbeddingModel {
    const modelId = this.settings.openaiEmbeddingModel || DEFAULT_EMBEDDING_MODEL;
    return this.client.textEmbeddingModel(modelId);
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await this.httpFetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(AI_TIMEOUTS.HEALTH_CHECK),
      });
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      return true;
    } catch (e) {
      aiLogger.provider.error('openai', `healthCheck failed: ${(e as Error).message}`);
      return false;
    }
  }
}
```

Note: if `aiLogger.provider.init/error` signatures reject the literal
`'openai'` (they may be typed to `AIProviderName`, which now includes it),
this compiles as-is; verify with lint in Step 5.

- [ ] **Step 4: Wire into getAIProvider**

In `src/services/ai/providers/index.ts`:

```ts
import { OllamaProvider } from './OllamaProvider';
import { AIGatewayProvider } from './AIGatewayProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { OpenAIProvider } from './OpenAIProvider';
import type { AIProvider, AISettings } from '../types';

export { OllamaProvider, AIGatewayProvider, OpenRouterProvider, OpenAIProvider };

export function getAIProvider(settings: AISettings): AIProvider {
  switch (settings.provider) {
    case 'ollama':
      return new OllamaProvider(settings);
    case 'ai-gateway':
      if (!settings.aiGatewayApiKey) {
        throw new Error('API key required for AI Gateway');
      }
      return new AIGatewayProvider(settings);
    case 'openrouter':
      if (!settings.openrouterApiKey) {
        throw new Error('API key required for OpenRouter');
      }
      return new OpenRouterProvider(settings);
    case 'openai':
      if (!settings.openaiApiKey) {
        throw new Error('API key required for OpenAI');
      }
      return new OpenAIProvider(settings);
    default:
      throw new Error(`Unknown provider: ${settings.provider}`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/services/ai/openai-provider.test.ts && pnpm lint`
Expected: 5 tests PASS; lint clean. If `getModel().modelId` fails because the
AI SDK wraps the id, change the assertion to
`expect(provider.getModel().modelId).toContain('gpt-4.1')` — do not delete the
test.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/providers/OpenAIProvider.ts src/services/ai/providers/index.ts src/__tests__/services/ai/openai-provider.test.ts
git commit -m "feat(ai): OpenAI provider via openai-compatible client"
```

---

### Task 3: `isAvailable` hook on TranslationProvider (TDD)

**Files:**
- Modify: `src/services/translators/types.ts` (TranslationProvider interface)
- Modify: `src/services/translators/providers/index.ts` (`isTranslatorAvailable` at line ~50, `getTranslatorDisplayLabel` at line ~67)
- Test: `src/__tests__/services/translators/availability.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/services/translators/availability.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  isTranslatorAvailable,
  getTranslatorDisplayLabel,
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
});

describe('getTranslatorDisplayLabel with isAvailable hook', () => {
  it('appends API Key Required when isAvailable() is false', () => {
    const p = makeProvider({ isAvailable: () => false });
    const label = getTranslatorDisplayLabel(p, true, (k) => k);
    expect(label).toBe('Fake (API Key Required)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/services/translators/availability.test.ts`
Expected: FAIL — `isAvailable` not in type / label has no suffix.

- [ ] **Step 3: Implement**

In `src/services/translators/types.ts`, inside `TranslationProvider` after the
`disabled?: boolean;` field, add:

```ts
  /**
   * Provider-specific availability beyond the Readest-cloud token check —
   * e.g. "the user configured an OpenAI API key". Checked by
   * `isTranslatorAvailable`; absent means "no extra requirement".
   */
  isAvailable?: () => boolean;
```

In `src/services/translators/providers/index.ts`, in `isTranslatorAvailable`
add one line before `return true;`:

```ts
  if (translator.isAvailable && !translator.isAvailable()) return false;
```

In `getTranslatorDisplayLabel`, after the `quotaExceeded` branch, add:

```ts
  if (translator.isAvailable && !translator.isAvailable()) {
    return `${translator.label} (${_('API Key Required')})`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/services/translators/availability.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/translators/types.ts src/services/translators/providers/index.ts src/__tests__/services/translators/availability.test.ts
git commit -m "feat(translators): provider-specific isAvailable gating"
```

---

### Task 4: The `openai` translation provider (TDD)

**Files:**
- Create: `src/services/translators/providers/openai.ts`
- Test: `src/__tests__/services/translators/openai.test.ts`

Design constraints recap: one chat request per batch, temperature 0, strict
same-length JSON array out; empty/whitespace lines pass through untouched;
retry once on malformed output only; 401 → `ErrorCodes.UNAUTHORIZED`,
429 → `ErrorCodes.DAILY_QUOTA_EXCEEDED`. Caching is orchestrated by
`useTranslator` (`getFromCache`/`storeInCache`), so this module needs NO
cache code.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/services/translators/openai.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});

// The provider class pulls in transport/logger; stub it entirely.
const getModelMock = vi.fn(() => ({ modelId: 'gpt-4o-mini' }));
vi.mock('@/services/ai/providers/OpenAIProvider', () => ({
  OpenAIProvider: vi.fn(() => ({ getModel: getModelMock })),
}));

import { useSettingsStore } from '@/store/settingsStore';
import { openaiProvider } from '@/services/translators/providers/openai';
import { ErrorCodes } from '@/services/translators/types';

const setAiSettings = (aiSettings: Record<string, unknown> | undefined) => {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, aiSettings },
  }) as never);
};

beforeEach(() => {
  generateTextMock.mockReset();
  setAiSettings({ openaiApiKey: 'sk-test', openaiModel: 'gpt-4o-mini' });
});

describe('openai translation provider', () => {
  it('is unavailable without an API key and available with one', () => {
    setAiSettings({});
    expect(openaiProvider.isAvailable!()).toBe(false);
    setAiSettings({ openaiApiKey: 'sk-test' });
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

  it('maps 429 to DAILY_QUOTA_EXCEEDED', async () => {
    const err = Object.assign(new Error('rate limited'), { statusCode: 429 });
    generateTextMock.mockRejectedValue(err);
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).rejects.toThrow(
      ErrorCodes.DAILY_QUOTA_EXCEEDED,
    );
  });

  it('throws UNAUTHORIZED when no key is configured', async () => {
    setAiSettings({});
    await expect(openaiProvider.translate(['Hello'], 'en', 'de')).rejects.toThrow(
      ErrorCodes.UNAUTHORIZED,
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/services/translators/openai.test.ts`
Expected: FAIL — module `@/services/translators/providers/openai` not found.

- [ ] **Step 3: Implement the provider**

Create `src/services/translators/providers/openai.ts`:

```ts
import { generateText } from 'ai';
import { stubTranslation as _ } from '@/utils/misc';
import { useSettingsStore } from '@/store/settingsStore';
import { normalizeToShortLang } from '@/utils/lang';
import { OpenAIProvider } from '@/services/ai/providers/OpenAIProvider';
import { ErrorCodes, TranslationProvider } from '../types';

const getAISettings = () => useSettingsStore.getState().settings?.aiSettings;

// LLMs love fencing JSON even when told not to; strip a single outer fence.
const stripCodeFences = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

const statusCodeOf = (e: unknown): number | undefined =>
  typeof e === 'object' && e !== null && 'statusCode' in e
    ? (e as { statusCode?: number }).statusCode
    : undefined;

const mapApiError = (e: unknown): Error | null => {
  const status = statusCodeOf(e);
  if (status === 401 || status === 403) return new Error(ErrorCodes.UNAUTHORIZED);
  if (status === 429) return new Error(ErrorCodes.DAILY_QUOTA_EXCEEDED);
  return null;
};

const buildSystemPrompt = (sourceLang: string, targetLang: string): string => {
  const source = normalizeToShortLang(sourceLang).toLowerCase();
  const target = normalizeToShortLang(targetLang).toLowerCase();
  const from = source && source !== 'auto' ? ` from the language with code "${source}"` : '';
  return (
    `You are a translation engine. The user message is a JSON array of strings. ` +
    `Translate each element${from} into the language with code "${target}". ` +
    `Preserve meaning, tone, inline punctuation, numbers, and any markup. ` +
    `Respond with ONLY a JSON array of strings of exactly the same length and order. ` +
    `No commentary, no code fences.`
  );
};

const parseAligned = (raw: string, expectedLength: number): string[] => {
  const parsed: unknown = JSON.parse(stripCodeFences(raw));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expectedLength ||
    !parsed.every((item): item is string => typeof item === 'string')
  ) {
    throw new Error('Misaligned translation output');
  }
  return parsed;
};

export const openaiProvider: TranslationProvider = {
  name: 'openai',
  label: _('OpenAI (ChatGPT)'),
  // Uses the user's own OpenAI key, not the Readest cloud token.
  authRequired: false,
  isAvailable: () => !!getAISettings()?.openaiApiKey,
  translate: async (texts: string[], sourceLang: string, targetLang: string): Promise<string[]> => {
    if (!texts.length) return [];
    const aiSettings = getAISettings();
    if (!aiSettings?.openaiApiKey) {
      throw new Error(ErrorCodes.UNAUTHORIZED);
    }

    // Empty/whitespace lines pass through; only real text goes to the model.
    const nonEmptyIndices = texts
      .map((line, i) => (line?.trim().length ? i : -1))
      .filter((i) => i >= 0);
    if (!nonEmptyIndices.length) return [...texts];
    const nonEmpty = nonEmptyIndices.map((i) => texts[i]!);

    const model = new OpenAIProvider(aiSettings).getModel();
    const system = buildSystemPrompt(sourceLang, targetLang);

    const requestOnce = async (): Promise<string[]> => {
      const { text } = await generateText({
        model,
        system,
        prompt: JSON.stringify(nonEmpty),
        temperature: 0,
      });
      return parseAligned(text, nonEmpty.length);
    };

    let translated: string[];
    try {
      translated = await requestOnce();
    } catch (firstError) {
      const apiError = mapApiError(firstError);
      if (apiError) throw apiError; // auth/quota: retrying won't help
      try {
        translated = await requestOnce(); // one retry for malformed output
      } catch (secondError) {
        throw mapApiError(secondError) ?? secondError;
      }
    }

    const results = [...texts];
    nonEmptyIndices.forEach((originalIndex, j) => {
      results[originalIndex] = translated[j]!;
    });
    return results;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/services/translators/openai.test.ts && pnpm lint`
Expected: 10 tests PASS; lint clean. If `useSettingsStore.setState` in the
test needs a different shape (settings may be non-optional), adjust the test
helper, not the provider.

- [ ] **Step 5: Commit**

```bash
git add src/services/translators/providers/openai.ts src/__tests__/services/translators/openai.test.ts
git commit -m "feat(translators): OpenAI translation provider"
```

---

### Task 5: Register the provider (TDD)

**Files:**
- Modify: `src/services/translators/providers/index.ts` (lines 1-30)
- Test: extend `src/__tests__/services/translators/availability.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/services/translators/availability.test.ts`:

```ts
import { getTranslator } from '@/services/translators/providers';

describe('openai translator registration', () => {
  it('is registered in the translators registry', () => {
    const t = getTranslator('openai');
    expect(t).toBeDefined();
    expect(t!.name).toBe('openai');
    expect(typeof t!.isAvailable).toBe('function');
  });
});
```

(Move the `import` to the top of the file with the existing imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/services/translators/availability.test.ts`
Expected: FAIL — `getTranslator('openai')` is a type error / undefined.

- [ ] **Step 3: Register**

In `src/services/translators/providers/index.ts`:

```ts
import { openaiProvider } from './openai';
```

after the other provider imports, then:

```ts
const openaiTranslator = createTranslator('openai', openaiProvider);
```

and add `openaiTranslator` to `availableTranslators` (before the
`// Add more translators here` comment). `TranslatorName` widens
automatically, so LangPanel's dropdown and `useTranslator` pick it up with no
further changes.

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run src/__tests__/services/translators/ && pnpm lint`
Expected: all PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/translators/providers/index.ts src/__tests__/services/translators/availability.test.ts
git commit -m "feat(translators): register openai provider"
```

---

### Task 6: AIPanel settings UI

**Files:**
- Modify: `src/components/settings/AIPanel.tsx`

No unit test (the repo doesn't component-test settings panels); verified by
lint + the manual checklist in Task 7. Follow the existing `openrouter`
blocks as the template — every step below has a 1:1 openrouter analogue in
the file.

- [ ] **Step 1: Local state** (next to the `openrouter*` state, ~line 91)

```ts
const [openaiKey, setOpenaiKey] = useState(aiSettings.openaiApiKey ?? '');
const [openaiUrl, setOpenaiUrl] = useState(
  aiSettings.openaiBaseUrl ?? DEFAULT_AI_SETTINGS.openaiBaseUrl ?? '',
);
const [openaiModel, setOpenaiModel] = useState(
  aiSettings.openaiModel ?? DEFAULT_AI_SETTINGS.openaiModel ?? '',
);
```

- [ ] **Step 2: Persistence effects** (mirror the `openrouterKey` effects at ~line 261)

```ts
useEffect(() => {
  if (openaiKey !== (aiSettings.openaiApiKey ?? '')) {
    saveAiSetting('openaiApiKey', openaiKey);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [openaiKey]);

useEffect(() => {
  if (openaiUrl !== (aiSettings.openaiBaseUrl ?? '')) {
    saveAiSetting('openaiBaseUrl', openaiUrl);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [openaiUrl]);

useEffect(() => {
  if (openaiModel !== (aiSettings.openaiModel ?? '')) {
    saveAiSetting('openaiModel', openaiModel);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [openaiModel]);
```

(Match the exact persistence pattern used by the openrouter effects in the
file — if they go through a helper other than `saveAiSetting`, use that.)

- [ ] **Step 3: Provider radio** (in the `Provider` BoxedList, ~line 416, after the
"OpenAI Compatible" row)

```tsx
<SettingsRow label={_('OpenAI (ChatGPT)')} asLabel>
  <input
    type='radio'
    name='ai-provider'
    className='radio'
    checked={provider === 'openai'}
    onChange={() => setProvider('openai')}
    disabled={!enabled}
  />
</SettingsRow>
```

- [ ] **Step 4: Configuration section** (sibling of the
`{provider === 'openrouter' && (...)}` block; copy that block's stacked-row
markup and adjust):

```tsx
{provider === 'openai' && (
  <BoxedList title={_('OpenAI Configuration')} className={disabledSection}>
    <div className='flex flex-col gap-2 py-3 pe-4'>
      <SettingLabel>{_('API Key')}</SettingLabel>
      <input
        type='password'
        className='input input-bordered input-sm w-full'
        placeholder='sk-...'
        value={openaiKey}
        onChange={(e) => setOpenaiKey(e.target.value)}
        disabled={!enabled}
      />
      <SettingLabel>{_('Model')}</SettingLabel>
      <input
        type='text'
        className='input input-bordered input-sm w-full'
        placeholder='gpt-4o-mini'
        value={openaiModel}
        onChange={(e) => setOpenaiModel(e.target.value)}
        disabled={!enabled}
      />
      <SettingLabel>{_('Base URL')}</SettingLabel>
      <input
        type='text'
        className='input input-bordered input-sm w-full'
        placeholder='https://api.openai.com/v1'
        value={openaiUrl}
        onChange={(e) => setOpenaiUrl(e.target.value)}
        disabled={!enabled}
      />
    </div>
  </BoxedList>
)}
```

Use the exact input/label markup conventions from the openrouter section in
the file (class names above are from the Ollama section; prefer the
openrouter section's if they differ). Inputs use `eink-bordered` if the
sibling sections do.

- [ ] **Step 5: Test buttons** — find where `testSettings` is assembled for the
Test Connection / health check handlers (~lines 340-390). Ensure the object
includes the new fields, e.g. add:

```ts
openaiApiKey: openaiKey,
openaiBaseUrl: openaiUrl,
openaiModel: openaiModel,
```

The handlers call `getAIProvider(testSettings)` generically, so once the
fields are present the existing Test Connection and Health Check buttons work
for OpenAI with no further changes.

- [ ] **Step 6: Lint + run unit tests**

Run: `pnpm lint && pnpm test`
Expected: clean; no test regressions.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/AIPanel.tsx
git commit -m "feat(settings): OpenAI provider section in AI panel"
```

---

### Task 7: End-to-end verification + i18n

- [ ] **Step 1: Full gates**

Run: `pnpm test && pnpm lint && pnpm format:check` (format:check from repo root: `pnpm -w format:check`)
Expected: all pass (the known-flaky `series-metadata` suite was fixed in 15e532a4).

- [ ] **Step 2: i18n extraction**

New keys: `OpenAI (ChatGPT)`, `OpenAI Configuration`, `API Key Required`,
`API Key`, `Model`, `Base URL` (several already exist). Run the `/i18n` skill
(or `i18next-scanner` per docs/i18n.md) to extract and translate.

- [ ] **Step 3: Manual smoke test (web, fastest)**

Run: `pnpm dev-web`, open Settings → AI:
1. Pick "OpenAI (ChatGPT)", paste a real key, Test Connection → success.
2. Settings → Language: translation provider dropdown shows "OpenAI (ChatGPT)" (without key: "(API Key Required)").
3. Open a book, enable translation with provider OpenAI → translated paragraphs render; check the browser network tab shows ONE `chat/completions` call per batch.
4. Remove the key → provider falls back (existing `useTranslator` fallback), no crash.

- [ ] **Step 4: Commit any i18n output**

```bash
git add public/locales
git commit -m "chore(i18n): extract OpenAI translation provider strings"
```

---

## Self-Review Notes

- Spec coverage: client (Task 2), settings tab (Task 6), translator + "use
  when selected and authenticated" (Tasks 3-5), error mapping + retry
  (Task 4), tests first throughout. OAuth intentionally absent (spec defers).
- Type consistency: `openaiApiKey/openaiBaseUrl/openaiModel/openaiEmbeddingModel`
  (Task 1) are the names used in Tasks 2, 4, 6; provider ids are `'openai'`
  in both registries.
- Caching: intentionally no cache code in the provider — `useTranslator`
  already wraps every provider with `getFromCache`/`storeInCache`.
