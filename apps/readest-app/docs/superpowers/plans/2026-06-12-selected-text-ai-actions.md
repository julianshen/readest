# Selected-Text AI Actions + Shared Answer-Language Setting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline selected-text AI actions (Explain / Simplify / Define) anchored to the reader selection, plus a shared `aiSettings.answerLanguage` setting that governs the output language of summaries/recap and Explain/Define.

**Architecture:** A small new service (`selectionAIService`) mirrors `summaryService`: it extracts spoiler-safe context (current section text up to the selection), picks a prompt + language per action, and streams the answer via the Vercel AI SDK `streamText`. A new `SelectionAIPopup` (modeled on `TranslatorPopup`/`ProofreadPopup`) renders the actions and streamed answer. A shared `answerLanguage.ts` helper resolves book-vs-UI language and is consumed by both `selectionAIService` and `summaryService`.

**Tech Stack:** Next.js + React, TypeScript (strict, no `any`), Vercel AI SDK (`ai`), Vitest + jsdom, Biome. Spec: `docs/superpowers/specs/2026-06-12-selected-text-ai-actions-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/ai/types.ts` | add `answerLanguage?: 'book' \| 'app'` to `AISettings` |
| `src/services/ai/constants.ts` | default `answerLanguage: 'book'` in `DEFAULT_AI_SETTINGS` |
| `src/services/ai/answerLanguage.ts` *(new)* | `bookLanguageName`, `resolveAnswerLanguageName` |
| `src/services/ai/prompts.ts` | add `buildExplainPrompt`, `buildDefinePrompt`, `buildSimplifyPrompt` |
| `src/services/ai/utils/selectionContext.ts` *(new)* | pure `buildSelectionContext` (truncate + mark) |
| `src/services/ai/selectionAIService.ts` *(new)* | `runSelectionAction` streaming generator |
| `src/services/ai/providers/index.ts` | add `isAIAssistantConfigured` gate helper |
| `src/services/ai/summaryService.ts` | use `resolveAnswerLanguageName` instead of hardcoded book language |
| `src/app/reader/hooks/useAISummary.ts` | pass `uiLanguage` into summary args |
| `src/app/reader/components/annotator/SelectionAIPopup.tsx` *(new)* | popup UI + streaming |
| `src/app/reader/components/annotator/AnnotationTools.tsx` | add gated `ai` toolbar button |
| `src/app/reader/components/annotator/Annotator.tsx` | wire `ai` action + popup state/render |
| `src/components/settings/AIPanel.tsx` | add "AI answer language" select |
| `public/locales/*/translation.json` | new i18n strings, all locales translated |

**Verification commands (run from `apps/readest-app/`):**
- Single test file: `npx vitest run <path>`
- Full suite: `pnpm test`
- Lint + typecheck: `pnpm lint`
- Translations gate: `pnpm check:translations`

---

## Task 1: Answer-language setting + resolver

**Files:**
- Modify: `src/services/ai/types.ts` (AISettings)
- Modify: `src/services/ai/constants.ts` (DEFAULT_AI_SETTINGS)
- Create: `src/services/ai/answerLanguage.ts`
- Test: `src/__tests__/services/ai/answerLanguage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/services/ai/answerLanguage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { BookDoc } from '@/libs/document';
import { bookLanguageName, resolveAnswerLanguageName } from '@/services/ai/answerLanguage';

const jaDoc = { metadata: { language: 'ja' } } as unknown as BookDoc;

describe('answerLanguage', () => {
  it('bookLanguageName maps the book primary language code to an English name', () => {
    expect(bookLanguageName(jaDoc)).toBe('Japanese');
  });

  it("resolveAnswerLanguageName returns the book language for 'book' and undefined", () => {
    expect(resolveAnswerLanguageName('book', jaDoc, 'en-US')).toBe('Japanese');
    expect(resolveAnswerLanguageName(undefined, jaDoc, 'en-US')).toBe('Japanese');
  });

  it("resolveAnswerLanguageName returns the UI language for 'app'", () => {
    expect(resolveAnswerLanguageName('app', jaDoc, 'en-US')).toBe('English');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/services/ai/answerLanguage.test.ts`
Expected: FAIL — cannot resolve module `@/services/ai/answerLanguage`.

- [ ] **Step 3: Create the helper module**

Create `src/services/ai/answerLanguage.ts`:

```ts
import type { BookDoc } from '@/libs/document';
import { getPrimaryLanguage } from '@/utils/book';
import { getLanguageName } from '@/utils/lang';

export type AnswerLanguageMode = 'book' | 'app';

// The book's primary language as a human-readable English name (e.g. "Japanese").
export const bookLanguageName = (bookDoc: BookDoc): string =>
  getLanguageName(getPrimaryLanguage(bookDoc.metadata.language));

// Resolve the answer language name from the user's setting. `book` (and the
// undefined default) use the book's language; `app` uses the UI locale.
export const resolveAnswerLanguageName = (
  mode: AnswerLanguageMode | undefined,
  bookDoc: BookDoc,
  uiLangCode: string,
): string => (mode === 'app' ? getLanguageName(uiLangCode) : bookLanguageName(bookDoc));
```

- [ ] **Step 4: Add the setting field + default**

In `src/services/ai/types.ts`, inside `interface AISettings`, add after `indexingMode`:

```ts
  /**
   * Output language for AI summaries/recap and selected-text Explain/Define.
   * `book` (default) uses the book's language; `app` uses the UI language.
   * Selected-text "Simplify" always uses the book's language regardless.
   */
  answerLanguage?: 'book' | 'app';
```

In `src/services/ai/constants.ts`, inside `DEFAULT_AI_SETTINGS`, add after `indexingMode: 'on-demand',`:

```ts
  answerLanguage: 'book',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/services/ai/answerLanguage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/answerLanguage.ts src/services/ai/types.ts src/services/ai/constants.ts src/__tests__/services/ai/answerLanguage.test.ts
git commit -m "feat(ai): add answerLanguage setting + shared language resolver"
```

---

## Task 2: summaryService honors answerLanguage

**Files:**
- Modify: `src/services/ai/summaryService.ts:62-68,156-162` (and the local `bookLanguageName`)
- Modify: `src/app/reader/hooks/useAISummary.ts:50-60`
- Test: `src/__tests__/services/ai/summaryService.language.test.ts`

Context: `summaryService.ts` currently defines a local `bookLanguageName` and always uses it. Replace with the shared resolver, threading a `uiLanguage` field through `SummaryArgs`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/services/ai/summaryService.language.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateTextMock = vi.fn();
vi.mock('ai', () => ({ generateText: (args: unknown) => generateTextMock(args) }));
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: () => ({ getModel: () => ({}) }),
}));

import { summarizeChapter } from '@/services/ai/summaryService';
import type { BookDoc } from '@/libs/document';
import type { AISettings } from '@/services/ai/types';

const makeDoc = () =>
  ({
    metadata: { language: 'ja' },
    toc: [],
    sections: [
      {
        linear: 'yes',
        createDocument: async () => {
          const d = document.implementation.createHTMLDocument('');
          d.body.textContent = 'これはテスト本文です。'.repeat(20);
          return d;
        },
      },
    ],
  }) as unknown as BookDoc;

const baseArgs = (answerLanguage: 'book' | 'app') => ({
  bookDoc: makeDoc(),
  bookHash: 'h1',
  bookTitle: 'T',
  uiLanguage: 'en-US',
  aiSettings: { enabled: true, provider: 'ollama', answerLanguage } as unknown as AISettings,
  sectionIndex: 0,
});

describe('summaryService answer language', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({ text: 'summary' });
  });

  it("uses the book language when answerLanguage is 'book'", async () => {
    await summarizeChapter(baseArgs('book'));
    expect(generateTextMock.mock.calls[0]![0].system).toContain('Japanese');
  });

  it("uses the UI language when answerLanguage is 'app'", async () => {
    await summarizeChapter(baseArgs('app'));
    expect(generateTextMock.mock.calls[0]![0].system).toContain('English');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/services/ai/summaryService.language.test.ts`
Expected: FAIL — `app` case yields "Japanese" (still hardcoded), and/or `uiLanguage` unused.

- [ ] **Step 3: Update summaryService**

In `src/services/ai/summaryService.ts`:

1. Replace the local `bookLanguageName` definition (around lines 35-37, the block added for the summary-language feature) and its usages with the shared resolver. At the top imports, add:

```ts
import { resolveAnswerLanguageName } from './answerLanguage';
```

and delete the local `const bookLanguageName = ...` helper.

2. Add `uiLanguage` to the `SummaryArgs` interface:

```ts
interface SummaryArgs {
  bookDoc: BookDoc;
  bookHash: string;
  bookTitle: string;
  uiLanguage: string;
  aiSettings: AISettings;
}
```

3. In `summarizeText`, replace the `buildChapterSummaryPrompt(args.bookTitle, chapterTitle, ...)` language argument:

```ts
  const system = buildChapterSummaryPrompt(
    args.bookTitle,
    chapterTitle,
    resolveAnswerLanguageName(args.aiSettings.answerLanguage, args.bookDoc, args.uiLanguage),
  );
```

4. In `recapToPosition`, replace the `buildRecapPrompt(args.bookTitle, ...)` language argument:

```ts
    system: buildRecapPrompt(
      args.bookTitle,
      resolveAnswerLanguageName(args.aiSettings.answerLanguage, args.bookDoc, args.uiLanguage),
    ),
```

- [ ] **Step 4: Thread uiLanguage from the caller**

In `src/app/reader/hooks/useAISummary.ts`, add the import:

```ts
import { getLocale } from '@/utils/misc';
```

and add `uiLanguage` to the `args` object (around line 51):

```ts
          const args = {
            bookDoc,
            bookHash: book.hash,
            bookTitle: book.title,
            uiLanguage: getLocale(),
            aiSettings,
          };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/services/ai/summaryService.language.test.ts src/__tests__/services/ai/summary-prompts.test.ts`
Expected: PASS (both files).

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/summaryService.ts src/app/reader/hooks/useAISummary.ts src/__tests__/services/ai/summaryService.language.test.ts
git commit -m "feat(ai): summaries follow the answerLanguage setting"
```

---

## Task 3: Selection prompt builders

**Files:**
- Modify: `src/services/ai/prompts.ts` (append three builders)
- Test: `src/__tests__/services/ai/selection-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/services/ai/selection-prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildExplainPrompt,
  buildDefinePrompt,
  buildSimplifyPrompt,
} from '@/services/ai/prompts';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/services/ai/selection-prompts.test.ts`
Expected: FAIL — builders are not exported.

- [ ] **Step 3: Implement the builders**

Append to `src/services/ai/prompts.ts`:

```ts
/**
 * System prompt for explaining a selected passage. The passage is marked with
 * « » inside the provided context (user message); this returns only the system
 * turn. `language` is the resolved answer language name.
 */
export function buildExplainPrompt(language: string): string {
  return (
    `A reader has marked a passage (wrapped in « ») within text from a book. ` +
    `Using ONLY the provided text — never outside knowledge of the book — explain what the ` +
    `marked passage means in its context. Be concise: at most 120 words. ` +
    `No preamble, no markdown headings. Write the explanation in ${language}.`
  );
}

/** System prompt for defining a marked word/phrase in context. */
export function buildDefinePrompt(language: string): string {
  return (
    `A reader has marked a word or phrase (wrapped in « ») within text from a book. ` +
    `Using ONLY the provided text for context — never outside knowledge — explain what the ` +
    `marked word or phrase means as it is used here. Be concise: a sentence or two. ` +
    `No preamble, no markdown headings. Write the definition in ${language}.`
  );
}

/** System prompt for simplifying a marked passage. `language` is the book language. */
export function buildSimplifyPrompt(language: string): string {
  return (
    `A reader has marked a passage (wrapped in « ») within text from a book. ` +
    `Rewrite ONLY the marked passage in simpler, plainer ${language}, preserving its meaning. ` +
    `Output only the rewritten passage — no preamble, no quotation marks, no markdown.`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/services/ai/selection-prompts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/prompts.ts src/__tests__/services/ai/selection-prompts.test.ts
git commit -m "feat(ai): add explain/define/simplify prompt builders"
```

---

## Task 4: Selection context builder (pure, spoiler-safe)

**Files:**
- Create: `src/services/ai/utils/selectionContext.ts`
- Test: `src/__tests__/services/ai/selectionContext.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/services/ai/selectionContext.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSelectionContext } from '@/services/ai/utils/selectionContext';

describe('buildSelectionContext', () => {
  it('includes preceding text and the marked selection, never text after it', () => {
    const section = 'BEFORE_TEXT SELECTED_PHRASE AFTER_TEXT';
    const ctx = buildSelectionContext(section, 'SELECTED_PHRASE', 1000);
    expect(ctx).toBe('BEFORE_TEXT «SELECTED_PHRASE»');
    expect(ctx).not.toContain('AFTER_TEXT');
  });

  it('caps the preceding context to maxChars', () => {
    const before = 'x'.repeat(50);
    const ctx = buildSelectionContext(`${before}SEL after`, 'SEL', 10);
    expect(ctx).toBe(`${'x'.repeat(10)}«SEL»`);
  });

  it('falls back to the marked selection when not found in the section', () => {
    expect(buildSelectionContext('unrelated section', 'MISSING', 1000)).toBe('«MISSING»');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/services/ai/selectionContext.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/services/ai/utils/selectionContext.ts`:

```ts
// Build the model context for a selected passage: the section text UP TO the
// selection (capped to `maxChars` of preceding context) followed by the
// selection marked with « ». Text after the selection is never included, so a
// reader can never be spoiled by content they have not reached. Falls back to
// just the marked selection when it can't be located in the section text.
export function buildSelectionContext(
  sectionText: string,
  selectedText: string,
  maxChars: number,
): string {
  const idx = sectionText.indexOf(selectedText);
  if (idx < 0) return `«${selectedText}»`;
  const start = Math.max(0, idx - maxChars);
  return `${sectionText.slice(start, idx)}«${selectedText}»`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/services/ai/selectionContext.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/utils/selectionContext.ts src/__tests__/services/ai/selectionContext.test.ts
git commit -m "feat(ai): add spoiler-safe selection context builder"
```

---

## Task 5: selectionAIService + provider gate helper

**Files:**
- Create: `src/services/ai/selectionAIService.ts`
- Modify: `src/services/ai/providers/index.ts` (add `isAIAssistantConfigured`)
- Test: `src/__tests__/services/ai/selectionAIService.test.ts`
- Test: `src/__tests__/services/ai/isAIAssistantConfigured.test.ts`

- [ ] **Step 1: Write the failing test (gate helper)**

Create `src/__tests__/services/ai/isAIAssistantConfigured.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/services/ai/isAIAssistantConfigured.test.ts`
Expected: FAIL — `isAIAssistantConfigured` not exported.

- [ ] **Step 3: Implement the gate helper**

Append to `src/services/ai/providers/index.ts`:

```ts
// True when the assistant is enabled AND the selected provider has the
// credentials it needs (getAIProvider throws otherwise). Used to gate UI that
// triggers AI calls (e.g. the selection-toolbar AI button).
export function isAIAssistantConfigured(settings: AISettings | undefined): boolean {
  if (!settings?.enabled) return false;
  try {
    getAIProvider(settings);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/services/ai/isAIAssistantConfigured.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test (service)**

Create `src/__tests__/services/ai/selectionAIService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamTextMock = vi.fn();
vi.mock('ai', () => ({ streamText: (args: unknown) => streamTextMock(args) }));
const getAIProviderMock = vi.fn();
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: (s: unknown) => getAIProviderMock(s),
}));

import { runSelectionAction, SelectionErrorCodes } from '@/services/ai/selectionAIService';
import type { BookDoc } from '@/libs/document';
import type { AISettings } from '@/services/ai/types';

const makeDoc = () =>
  ({
    metadata: { language: 'ja' },
    sections: [
      {
        createDocument: async () => {
          const d = document.implementation.createHTMLDocument('');
          d.body.textContent = 'PRE 選択された語 POST';
          return d;
        },
      },
    ],
  }) as unknown as BookDoc;

const args = (answerLanguage: 'book' | 'app') => ({
  bookDoc: makeDoc(),
  sectionIndex: 0,
  selectedText: '選択された語',
  uiLanguage: 'en-US',
  aiSettings: { enabled: true, provider: 'ollama', answerLanguage } as unknown as AISettings,
});

const drain = async (it: AsyncIterable<string>) => {
  let out = '';
  for await (const c of it) out += c;
  return out;
};

async function* fakeStream() {
  yield 'hello';
}

describe('selectionAIService', () => {
  beforeEach(() => {
    getAIProviderMock.mockReset().mockReturnValue({ getModel: () => ({}) });
    streamTextMock.mockReset().mockReturnValue({ textStream: fakeStream() });
  });

  it('explain uses the answer language and the spoiler-safe context', async () => {
    const text = await drain(runSelectionAction('explain', args('app')));
    expect(text).toBe('hello');
    const call = streamTextMock.mock.calls[0]![0];
    expect(call.system).toMatch(/in English/i); // app -> UI language
    expect(call.prompt).toBe('PRE «選択された語»'); // no POST
  });

  it("explain follows the book language when answerLanguage is 'book'", async () => {
    await drain(runSelectionAction('explain', args('book')));
    expect(streamTextMock.mock.calls[0]![0].system).toMatch(/in Japanese/i);
  });

  it('simplify always uses the book language regardless of setting', async () => {
    await drain(runSelectionAction('simplify', args('app')));
    expect(streamTextMock.mock.calls[0]![0].system).toMatch(/simpler.*Japanese/i);
  });

  it('throws NOT_CONFIGURED before any extraction when provider is unavailable', async () => {
    getAIProviderMock.mockImplementation(() => {
      throw new Error('no key');
    });
    await expect(drain(runSelectionAction('explain', args('book')))).rejects.toThrow(
      SelectionErrorCodes.NOT_CONFIGURED,
    );
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/__tests__/services/ai/selectionAIService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the service**

Create `src/services/ai/selectionAIService.ts`:

```ts
import { streamText } from 'ai';
import type { LanguageModel } from 'ai';
import type { BookDoc } from '@/libs/document';
import type { AISettings } from './types';
import { getAIProvider } from './providers';
import { extractTextFromDocument } from './utils/chunker';
import { buildSelectionContext } from './utils/selectionContext';
import { buildExplainPrompt, buildDefinePrompt, buildSimplifyPrompt } from './prompts';
import { bookLanguageName, resolveAnswerLanguageName } from './answerLanguage';

export type SelectionAction = 'explain' | 'simplify' | 'define';

export const SelectionErrorCodes = {
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
} as const;

// ≈750 tokens of preceding context; enough to resolve local references without
// bloating the request.
const MAX_CONTEXT_CHARS = 3000;

export interface SelectionArgs {
  bookDoc: BookDoc;
  sectionIndex: number;
  selectedText: string;
  uiLanguage: string;
  aiSettings: AISettings;
}

const getModelOrThrow = (aiSettings: AISettings): LanguageModel => {
  try {
    return getAIProvider(aiSettings).getModel();
  } catch {
    throw new Error(SelectionErrorCodes.NOT_CONFIGURED);
  }
};

const sectionText = async (bookDoc: BookDoc, index: number): Promise<string> => {
  const section = bookDoc.sections?.[index];
  if (!section) return '';
  try {
    const doc = await section.createDocument();
    return extractTextFromDocument(doc);
  } catch {
    return '';
  }
};

const systemPromptFor = (action: SelectionAction, args: SelectionArgs): string => {
  const answerLang = resolveAnswerLanguageName(
    args.aiSettings.answerLanguage,
    args.bookDoc,
    args.uiLanguage,
  );
  switch (action) {
    case 'explain':
      return buildExplainPrompt(answerLang);
    case 'define':
      return buildDefinePrompt(answerLang);
    case 'simplify':
      return buildSimplifyPrompt(bookLanguageName(args.bookDoc));
  }
};

export async function* runSelectionAction(
  action: SelectionAction,
  args: SelectionArgs,
): AsyncIterable<string> {
  const model = getModelOrThrow(args.aiSettings); // fail fast before any I/O
  const text = await sectionText(args.bookDoc, args.sectionIndex);
  const context = buildSelectionContext(text, args.selectedText, MAX_CONTEXT_CHARS);
  const result = streamText({
    model,
    system: systemPromptFor(action, args),
    prompt: context,
    temperature: action === 'simplify' ? 0.3 : 0.4,
  });
  for await (const chunk of result.textStream) {
    yield chunk;
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/services/ai/selectionAIService.test.ts src/__tests__/services/ai/isAIAssistantConfigured.test.ts`
Expected: PASS (both files).

- [ ] **Step 9: Commit**

```bash
git add src/services/ai/selectionAIService.ts src/services/ai/providers/index.ts src/__tests__/services/ai/selectionAIService.test.ts src/__tests__/services/ai/isAIAssistantConfigured.test.ts
git commit -m "feat(ai): selection AI service + assistant-configured gate"
```

---

## Task 6: SelectionAIPopup component

**Files:**
- Create: `src/app/reader/components/annotator/SelectionAIPopup.tsx`

This mirrors `ProofreadPopup`/`TranslatorPopup` (same `Popup` wrapper, same position props). It owns its streaming state. No component test (consistent with the Dictionary/Translate/Proofread popups).

- [ ] **Step 1: Create the component**

Create `src/app/reader/components/annotator/SelectionAIPopup.tsx`:

```tsx
import React, { useState } from 'react';
import { PiSparkle } from 'react-icons/pi';
import { FiCopy } from 'react-icons/fi';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { Position, TextSelection } from '@/utils/sel';
import { getLocale } from '@/utils/misc';
import { eventDispatcher } from '@/utils/event';
import {
  runSelectionAction,
  SelectionAction,
  SelectionErrorCodes,
} from '@/services/ai/selectionAIService';
import Popup from '@/components/Popup';

interface SelectionAIPopupProps {
  bookKey: string;
  selection: TextSelection;
  position: Position;
  trianglePosition: Position;
  popupWidth: number;
  popupHeight: number;
  onDismiss: () => void;
}

const ACTIONS: { key: SelectionAction; label: string }[] = [
  { key: 'explain', label: 'Explain' },
  { key: 'simplify', label: 'Simplify' },
  { key: 'define', label: 'Define' },
];

const SelectionAIPopup: React.FC<SelectionAIPopupProps> = ({
  bookKey,
  selection,
  position,
  trianglePosition,
  popupWidth,
  popupHeight,
  onDismiss,
}) => {
  const _ = useTranslation();
  const { getBookData } = useBookDataStore();
  const { settings } = useSettingsStore();
  const [active, setActive] = useState<SelectionAction | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [streaming, setStreaming] = useState(false);

  const run = async (action: SelectionAction) => {
    const bookData = getBookData(bookKey);
    const bookDoc = bookData?.bookDoc;
    if (!bookDoc) return;
    setActive(action);
    setAnswer('');
    setError('');
    setStreaming(true);
    try {
      const stream = runSelectionAction(action, {
        bookDoc,
        sectionIndex: selection.index,
        selectedText: selection.text,
        uiLanguage: getLocale(),
        aiSettings: settings.aiSettings,
      });
      for await (const chunk of stream) {
        setAnswer((prev) => prev + chunk);
      }
    } catch (e) {
      setError(
        (e as Error).message === SelectionErrorCodes.NOT_CONFIGURED
          ? _('Configure an AI provider in Settings → AI Assistant first')
          : _("Couldn't generate — try again"),
      );
    } finally {
      setStreaming(false);
    }
  };

  const handleCopy = () => {
    if (answer) navigator.clipboard?.writeText(answer);
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Copied') });
  };

  return (
    <div>
      <Popup
        width={popupWidth}
        height={popupHeight}
        position={position}
        trianglePosition={trianglePosition}
        className='select-text bg-base-200 absolute flex flex-col rounded-lg font-sans shadow-xl'
      >
        <div className='border-base-300 flex items-center gap-1 border-b p-2'>
          <PiSparkle className='text-base-content/70 h-4 w-4' />
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              className={`btn btn-ghost btn-xs ${active === a.key ? 'btn-active' : ''}`}
              disabled={streaming}
              onClick={() => run(a.key)}
            >
              {_(a.label)}
            </button>
          ))}
        </div>
        <div className='text-base-content min-h-[3rem] flex-1 overflow-y-auto p-3 text-sm'>
          {error ? (
            <span className='text-error'>{error}</span>
          ) : active ? (
            <span className='whitespace-pre-wrap'>
              {answer}
              {streaming && <span className='opacity-50'>▍</span>}
            </span>
          ) : (
            <span className='text-base-content/50'>{_('Pick an action above.')}</span>
          )}
        </div>
        {answer && !streaming && (
          <div className='border-base-300 flex justify-end gap-2 border-t p-2'>
            <button className='btn btn-ghost btn-xs' onClick={handleCopy}>
              <FiCopy className='h-3.5 w-3.5' /> {_('Copy')}
            </button>
          </div>
        )}
      </Popup>
      <div className='fixed inset-0 z-[-1]' onClick={onDismiss} />
    </div>
  );
};

export default SelectionAIPopup;
```

Note: confirm the `Popup` prop names against an existing caller (`TranslatorPopup.tsx`) — it takes `width`, `height`, `position`, `trianglePosition`, `className` plus children. If `TranslatorPopup` wraps differently (e.g. a `popupPadding`/triangle dir prop), match it exactly.

- [ ] **Step 2: Verify it compiles**

Run: `pnpm lint`
Expected: PASS — no type errors. (Fix any `Popup` prop mismatches surfaced here by matching `TranslatorPopup.tsx`.)

- [ ] **Step 3: Commit**

```bash
git add src/app/reader/components/annotator/SelectionAIPopup.tsx
git commit -m "feat(reader): selected-text AI popup component"
```

---

## Task 7: Wire the `ai` action into the selection toolbar

**Files:**
- Modify: `src/app/reader/components/annotator/AnnotationTools.tsx` (add `ai` button, gated)
- Modify: `src/app/reader/components/annotator/Annotator.tsx` (action handler + popup state/render)

Model every change on the existing `translate` action and `TranslatorPopup` wiring (Annotator lines ~126 state, ~597 dispatch, ~1390 render).

- [ ] **Step 1: Add the toolbar button (gated)**

In `src/app/reader/components/annotator/AnnotationTools.tsx`, add a new button entry after the `translate` entry. Use the sparkle icon (add `import { PiSparkle } from 'react-icons/pi';` at the top):

```ts
  {
    type: 'ai',
    tooltip: _('Ask AI about the selection'),
    Icon: PiSparkle,
    quickAction: false,
  },
```

Add `'ai'` to the `AnnotationToolType` union wherever the existing types (`'copy' | 'highlight' | ...`) are declared (search the file for `'translate'`). The button is filtered out at render time when AI is unavailable — see Step 3.

- [ ] **Step 2: Add popup state + dimensions in Annotator.tsx**

Near the translator popup state (around line 126), add:

```ts
  const [showSelectionAIPopup, setShowSelectionAIPopup] = useState(false);
  const [selectionAIPopupPosition, setSelectionAIPopupPosition] = useState<Position>();
```

Near where `transPopupWidth`/`transPopupHeight` are defined, add matching constants (reuse the translator dimensions):

```ts
  const selectionAIPopupWidth = 300;
  const selectionAIPopupHeight = 240;
```

Compute `selectionAIPopupPosition` in the same `useEffect` that computes `translatorPopupPosition` (mirror the `getPopupPosition(... )` call, substituting the AI width/height).

- [ ] **Step 3: Gate the button + handle the action**

Import the gate at the top of `Annotator.tsx`:

```ts
import { isAIAssistantConfigured } from '@/services/ai/providers';
import SelectionAIPopup from './SelectionAIPopup';
```

Where `toolButtons` (the filtered button list passed to `AnnotationPopup`) is built, drop the `ai` button when the assistant isn't configured:

```ts
  const aiAvailable = isAIAssistantConfigured(settings.aiSettings);
  const toolButtons = allToolButtons.filter((b) => b.type !== 'ai' || aiAvailable);
```

(If the file already maps a `buttons` array, apply the same `.filter` there.)

Add an `ai` case to the action switch in `handleQuickAction` AND to the per-button click dispatch (search for `case 'translate':` — there are two, around lines 597 and 1329). Add beside each:

```ts
        case 'ai':
          handleSelectionAI();
          break;
```

Add the handler beside `handleTranslation` (around line 959):

```ts
  const handleSelectionAI = () => {
    if (!selection || !selection.text) return;
    setShowAnnotPopup(false);
    setShowSelectionAIPopup(true);
  };
```

Ensure `handleDismissPopupAndSelection` also resets the new flag (search the dismiss handler and add `setShowSelectionAIPopup(false);` alongside `setShowDeepLPopup(false)`).

- [ ] **Step 4: Render the popup**

After the `TranslatorPopup` render block (around line 1399), add:

```tsx
      {showSelectionAIPopup && trianglePosition && selectionAIPopupPosition && selection && (
        <SelectionAIPopup
          bookKey={bookKey}
          selection={selection}
          position={selectionAIPopupPosition}
          trianglePosition={trianglePosition}
          popupWidth={selectionAIPopupWidth}
          popupHeight={selectionAIPopupHeight}
          onDismiss={handleDismissPopupAndSelection}
        />
      )}
```

- [ ] **Step 5: Verify it compiles and existing tests pass**

Run: `pnpm lint`
Expected: PASS.
Run: `npx vitest run src/__tests__/app/reader`
Expected: PASS (no regressions in reader tests).

- [ ] **Step 6: Commit**

```bash
git add src/app/reader/components/annotator/AnnotationTools.tsx src/app/reader/components/annotator/Annotator.tsx
git commit -m "feat(reader): wire selected-text AI action into the selection toolbar"
```

---

## Task 8: Settings control for answer language

**Files:**
- Modify: `src/components/settings/AIPanel.tsx`

- [ ] **Step 1: Add the select control**

In `src/components/settings/AIPanel.tsx`:

1. Add `SettingsSelect` and `Tips` to the primitives import (line 17):

```ts
import { BoxedList, SettingLabel, SettingsRow, SettingsSwitchRow, SettingsSelect, Tips } from './primitives';
```

2. Add a control inside the existing AI Assistant `BoxedList` (after the "Enable AI Assistant" switch, around line 462), bound to the `saveAiSetting` helper already in the file:

```tsx
        <SettingsRow label={_('AI answer language')} asLabel>
          <SettingsSelect
            value={settings.aiSettings?.answerLanguage ?? 'book'}
            ariaLabel={_('AI answer language')}
            options={[
              { value: 'book', label: _('Book language') },
              { value: 'app', label: _('App language') },
            ]}
            onChange={(e) => saveAiSetting('answerLanguage', e.target.value as 'book' | 'app')}
          />
        </SettingsRow>
```

3. Add a `Tips` line under that `BoxedList` explaining the scope:

```tsx
      <Tips
        description={_(
          'Sets the language for AI summaries, recaps, and Explain/Define on selected text. Simplify always uses the book’s language.',
        )}
      />
```

(Match the `Tips` prop name to its definition in `src/components/settings/primitives/Tips.tsx` — use `description` if that is the prop, otherwise children.)

- [ ] **Step 2: Verify it compiles**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/AIPanel.tsx
git commit -m "feat(settings): AI answer language control"
```

---

## Task 9: i18n strings for all locales

**Files:**
- Modify: `public/locales/*/translation.json`

New user-facing English strings introduced by this feature: `Explain`, `Simplify`, `Define`, `Ask AI about the selection`, `Ask the AI about the selection`, `Pick an action above.`, `Couldn't generate — try again`, `Copied`, `AI answer language`, `Book language`, `App language`, and the Tips sentence. (Some may already exist — the extractor de-dupes.)

- [ ] **Step 1: Run the extractor**

Run: `pnpm run i18n:extract`
Expected: new keys added to every locale as `__STRING_NOT_TRANSLATED__`.

- [ ] **Step 2: Confirm what needs translating**

Run: `grep -rno '__STRING_NOT_TRANSLATED__' public/locales/ | wc -l`
Expected: a non-zero count (new keys × locales).

- [ ] **Step 3: Translate every placeholder**

Follow the project i18n skill (`apps/readest-app/.claude/skills/i18n`): for each locale under `public/locales/`, replace each `"<Key>": "__STRING_NOT_TRANSLATED__"` with an accurate translation for that locale. Translate every locale present in `i18n-langs.json`. Use targeted per-line replacement (preserve JSON formatting). The English (`en`) locale uses the key as its own value.

- [ ] **Step 4: Verify zero placeholders + valid JSON**

Run: `pnpm check:translations`
Expected: `✅ All strings translated.`
Run: `for f in $(git diff --name-only -- '*/locales/*'); do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "INVALID $f"; done`
Expected: no `INVALID` output.

- [ ] **Step 5: Commit**

```bash
git add public/locales/
git commit -m "i18n: strings for selected-text AI actions + answer-language setting"
```

---

## Task 10: Full verification

- [ ] **Step 1: Lint + typecheck**

Run: `pnpm lint`
Expected: `Checked N files. No fixes applied.` (exit 0).

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all files pass (the new tests plus the existing 5210). 0 failures.

- [ ] **Step 3: Translations gate**

Run: `pnpm check:translations`
Expected: `✅ All strings translated.`

- [ ] **Step 4: Manual smoke (document result in the PR/commit)**

In the running app with an AI provider configured: open a book, select a passage, tap the new AI (sparkle) button, run Explain / Simplify / Define, confirm the answer streams in the popup and Copy works. Toggle Settings → AI → AI answer language between Book/App and confirm Explain/Define switch language while Simplify stays in the book's language. Confirm the AI button is hidden when the assistant is disabled/unconfigured.

---

## Self-Review notes (addressed)

- **Spec coverage:** setting+default (T1), summary respects setting (T2), prompts (T3), spoiler-safe context (T4), service + gate (T5), popup (T6), toolbar wiring + gating (T7), settings UI (T8), i18n (T9), verification (T10). All spec sections mapped.
- **Type consistency:** `SelectionAction = 'explain' | 'simplify' | 'define'`, `runSelectionAction(action, SelectionArgs)`, `resolveAnswerLanguageName(mode, bookDoc, uiLangCode)`, `bookLanguageName(bookDoc)`, `isAIAssistantConfigured(settings)`, `buildSelectionContext(sectionText, selectedText, maxChars)`, `answerLanguage?: 'book' | 'app'` — used identically across tasks.
- **Out of scope (per spec):** free-form "Ask about this", RAG retrieval context, answer caching, per-action model override.
