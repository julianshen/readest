# OpenAI (ChatGPT) Translation Provider — Design

**Date:** 2026-06-11
**Status:** Approved
**Scope:** apps/readest-app

## Goal

Let users translate book text through OpenAI models. When the translation
provider is set to OpenAI and an OpenAI API key is configured, translation
requests route through the user's own OpenAI account. The settings UI also
gives the AI assistant native OpenAI support as a side effect.

## Decisions made

| Question | Decision |
|---|---|
| OAuth vs API key | **API key only.** OpenAI has no official third-party OAuth for API access; the Codex-style "Sign in with ChatGPT" flow is unofficial and deferred. The settings section is laid out so an OAuth button can be added later without redesign. |
| Where settings live | **Extend the existing AIPanel** (Settings → AI) with an OpenAI provider section. No new tab. |
| Architecture | **First-class `OpenAIProvider` in `services/ai` + an `openai` translator in `services/translators`** that reads the same credentials. Translation works regardless of which provider the assistant uses. |

## Components

### 1. `src/services/ai/providers/OpenAIProvider.ts` (new)

- `id: 'openai'`, name "OpenAI (ChatGPT)", `requiresAuth: true`.
- Built on `@ai-sdk/openai-compatible` (existing dependency), default base URL
  `https://api.openai.com/v1`, overridable via settings — this is the
  "custom API integration" path (Azure OpenAI, LiteLLM, proxies, any
  OpenAI-compatible endpoint).
- Transport via existing `getAIFetch()` (Tauri Rust HTTP transport; no CORS
  preflight, no Android cleartext issues) and existing `AI_TIMEOUTS`/retry
  utils. Follows `OpenRouterProvider` as the structural template.
- `AISettings` additions: `openaiApiKey?`, `openaiBaseUrl?`,
  `openaiModel?` (default `gpt-4o-mini`), `openaiEmbeddingModel?`
  (default `text-embedding-3-small`).
- `AIProviderName` union gains `'openai'`; `getAIProvider()` gains a case
  that throws if the key is missing (same pattern as OpenRouter/AI Gateway).

### 2. `AIPanel.tsx` (extend)

- 4th provider radio: "OpenAI (ChatGPT)".
- Fields: masked API key input, model select with custom-model fallback,
  base URL field (collapsed/advanced, prefilled with the official endpoint).
- Reuse the existing Test Connection (`isAvailable`) and health check
  (`healthCheck`) buttons.
- Use existing settings primitives so e-ink rules apply automatically.

### 3. `src/services/translators/providers/openai.ts` (new)

- Registered in `availableTranslators`; the Language panel dropdown and
  `useTranslator` pick it up with no UI changes.
- Reads credentials from `useSettingsStore.getState().settings.aiSettings`
  (plain module, not a hook) — independent of the assistant's active provider.
- `translate(texts, sourceLang, targetLang)`:
  - One chat completion per batch. System prompt: translate each element of
    a JSON array from source to target language; return a JSON array of the
    same length; no commentary. Temperature 0.
  - Parse and validate output length; on malformed output retry once, then
    throw.
  - Reuse the existing translation cache (`cache.ts`) keyed per provider so
    repeated views don't re-bill.
  - Error mapping to existing `ErrorCodes`: HTTP 401 → `UNAUTHORIZED`,
    HTTP 429 → quota-exceeded message; other failures surface as generic
    translation errors through the existing paths.
- The `token` parameter (Readest cloud token) is ignored by this provider.

### 4. Availability gating

- Add optional `isAvailable?: () => boolean` to the `TranslationProvider`
  interface.
- `isTranslatorAvailable(translator, hasToken)` checks it after the existing
  `disabled`/`quotaExceeded`/`authRequired` checks: if `isAvailable` exists
  and returns false, the provider is unavailable.
- The OpenAI translator's `isAvailable` = "an OpenAI API key is configured".
- Net behavior: provider selected + key present → translation uses OpenAI;
  key absent → provider filtered out and `useTranslator`'s existing fallback
  picks the next available provider. No new conditionals elsewhere.

## Error handling

- Invalid key (401): surfaced as `UNAUTHORIZED` so the existing UI messaging
  applies.
- Rate limit (429): quota-style error message.
- Network/timeout: existing AI retry/timeout utils; final failure follows the
  translator error path (toast + fallback).
- Malformed LLM output (length mismatch, non-JSON): one retry, then error —
  never silently return misaligned translations.

## Testing

Test-first (repo rule):

1. `openai` translator unit tests (mock fetch/client): aligned input/output
   arrays; cache hit skips network; missing key → `isAvailable()` false;
   malformed output → retry then throw; 401/429 mapping.
2. `isTranslatorAvailable` honors the new `isAvailable` hook.
3. `getAIProvider('openai')` returns the provider; missing key throws.

## Out of scope

- ChatGPT OAuth ("Sign in with ChatGPT") — deferred; UI leaves room for it.
- Streaming translation.
- Per-feature model overrides (one model setting serves assistant +
  translation).
- Translation "polish" integration beyond what the registry provides.

## Files

New: `services/ai/providers/OpenAIProvider.ts`,
`services/translators/providers/openai.ts`, test files.

Modified: `services/ai/types.ts`, `services/ai/providers/index.ts`,
`services/translators/types.ts`, `services/translators/providers/index.ts`,
`components/settings/AIPanel.tsx`.
