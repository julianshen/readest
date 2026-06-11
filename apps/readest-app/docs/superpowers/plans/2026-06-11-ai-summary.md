# AI Summary (Recap + Chapter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Recap: Story So Far" and "Summarize This Chapter" in the reader's book menu, delivered into the Notebook AI tab as conversations, using the active AI provider with a per-chapter summary cache.

**Architecture:** A new `summaryService` extracts section text (same foliate path `ragService.indexBook` uses), summarizes chapters via `generateText` on `getAIProvider(aiSettings).getModel()` with map-reduce for oversized chapters, caches chapter summaries in `aiStore` (new IndexedDB object store), and composes recaps from cached chapter summaries + one synthesis call. Results land via `useAIChatStore.createConversation` + `addMessage`.

**Tech Stack:** TypeScript, Vercel AI SDK (`generateText`), IndexedDB via the existing `AIStore` class, Zustand stores, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-06-11-ai-summary-design.md`

**Working directory:** `apps/readest-app/`. Conventions: no `any`; `_()` for UI strings (`stubTranslation` in services); TDD with env-safety mocks copied from `src/__tests__/services/translators/availability.test.ts` when imports transitively touch `@/utils/supabase` (check imports before assuming).

**Key existing APIs (verified):**
- `extractTextFromDocument(doc)` and `chunkSection(...)` in `src/services/ai/utils/chunker.ts`; sections come from `bookDoc.sections[i].createDocument()` (see `ragService.indexBook`, `src/services/ai/ragService.ts:61-120`).
- `getAIProvider(settings)` in `src/services/ai/providers` (throws without key); `provider.getModel()` → pass to `generateText` from `'ai'`.
- `aiStore` (`src/services/ai/storage/aiStore.ts`): IndexedDB wrapper with `openDB`/object stores; conversations + messages already supported.
- `useAIChatStore` (`src/store/aiChatStore.ts`): `createConversation(bookHash, title): Promise<string>`, `addMessage(Omit<AIMessage,'id'|'createdAt'>)`, `setActiveConversation(id)`.
- `useOpenAIInNotebook` hook (`src/app/reader/hooks/useOpenAIInNotebook.ts`): opens the notebook AI tab and creates/loads a conversation.
- Reading position: `useReaderStore.getProgress(bookKey)` — contains the current `section` index (the relocate handler stores `detail.section`; read `src/store/readerStore.ts` to confirm the exact field name and adapt).
- Book content: `useBookDataStore.getBookData(bookKey)?.bookDoc` (the `BookDoc` with `.sections` and `.toc`).

---

### Task 1: Summary prompts (TDD-light)

**Files:**
- Modify: `src/services/ai/prompts.ts` (append)
- Test: `src/__tests__/services/ai/summary-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildChapterSummaryPrompt, buildRecapPrompt } from '@/services/ai/prompts';

describe('summary prompts', () => {
  it('chapter prompt embeds title and constrains length and spoilers', () => {
    const p = buildChapterSummaryPrompt('Dune', 'Chapter 3');
    expect(p).toContain('Dune');
    expect(p).toContain('Chapter 3');
    expect(p).toMatch(/200 words/i);
    expect(p).toMatch(/only the provided text/i);
  });

  it('recap prompt embeds the book title and present-tense instruction', () => {
    const p = buildRecapPrompt('Dune');
    expect(p).toContain('Dune');
    expect(p).toMatch(/story so far/i);
    expect(p).toMatch(/do not (mention|reveal|speculate)/i);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run src/__tests__/services/ai/summary-prompts.test.ts` (functions don't exist).

- [ ] **Step 3: Implement** — append to `src/services/ai/prompts.ts`:

```ts
export function buildChapterSummaryPrompt(bookTitle: string, chapterTitle: string): string {
  return (
    `You are summarizing one chapter of "${bookTitle}" for a reader's later reference. ` +
    `The chapter is titled "${chapterTitle}". Summarize ONLY the provided text — ` +
    `never use outside knowledge of this book. Write a factual summary of at most 200 words: ` +
    `key events, character developments, and revealed information, in the order they occur. ` +
    `No commentary, no evaluation, no markdown headings.`
  );
}

export function buildRecapPrompt(bookTitle: string): string {
  return (
    `You are writing a "story so far" recap of "${bookTitle}" for a reader returning to the book. ` +
    `You are given per-chapter summaries covering everything the reader has read, in order. ` +
    `Weave them into one flowing recap in present tense ("Paul arrives on Arrakis..."), ` +
    `under 400 words, focusing on the threads a reader needs to continue. ` +
    `Use ONLY the provided summaries. Do not mention, reveal, or speculate about anything beyond them. ` +
    `No markdown headings; plain paragraphs.`
  );
}
```

- [ ] **Step 4: Run to verify PASS** — same command, 2 pass.
- [ ] **Step 5: Commit** — `git add src/services/ai/prompts.ts src/__tests__/services/ai/summary-prompts.test.ts && git commit -m "feat(ai): summary and recap prompt builders"`

---

### Task 2: Chapter-summary cache in aiStore (TDD)

**Files:**
- Modify: `src/services/ai/storage/aiStore.ts`
- Modify: `src/services/ai/types.ts` (add `ChapterSummary`)
- Test: `src/__tests__/services/ai/summary-cache.test.ts`

Read `aiStore.ts` fully first. It opens IndexedDB with a `DB_VERSION` constant and creates object stores in `onupgradeneeded`. This task bumps the version and adds a `chapterSummaries` store (keyPath `key`), plus three methods.

- [ ] **Step 1: Add the type** — in `src/services/ai/types.ts`:

```ts
export interface ChapterSummary {
  /** `${bookHash}:${sectionIndex}` */
  key: string;
  bookHash: string;
  sectionIndex: number;
  /** hash of the section text — invalidates when content changes */
  contentHash: string;
  summary: string;
  createdAt: number;
}
```

- [ ] **Step 2: Write the failing test** — `src/__tests__/services/ai/summary-cache.test.ts` (jsdom has IndexedDB via fake-indexeddb if the repo configures it — check how existing aiStore tests do it: `grep -rln aiStore src/__tests__`. If no aiStore test exists and IndexedDB is unavailable in the environment, mock `aiStore` is NOT acceptable here — instead install nothing and test the pure helpers: keying + hashing. In that case write THIS test):

```ts
import { describe, it, expect } from 'vitest';
import { chapterSummaryKey, hashContent } from '@/services/ai/storage/aiStore';

describe('chapter summary cache keys', () => {
  it('builds stable keys', () => {
    expect(chapterSummaryKey('abc', 3)).toBe('abc:3');
  });
  it('hashes content stably and differentiates', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello')).not.toBe(hashContent('hellp'));
  });
});
```

- [ ] **Step 3: Run to verify FAIL**, then implement in `aiStore.ts`:

```ts
export const chapterSummaryKey = (bookHash: string, sectionIndex: number): string =>
  `${bookHash}:${sectionIndex}`;

// djb2 — cheap, stable, good enough for cache invalidation (not security).
export const hashContent = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36) + ':' + text.length.toString(36);
};
```

In the `AIStore` class: bump `DB_VERSION` by 1; in `onupgradeneeded` add (mirroring how existing stores are created):

```ts
if (!db.objectStoreNames.contains('chapterSummaries')) {
  const store = db.createObjectStore('chapterSummaries', { keyPath: 'key' });
  store.createIndex('bookHash', 'bookHash', { unique: false });
}
```

And methods (mirror the transaction style of `saveMessage`/`getMessages`):

```ts
async getChapterSummary(bookHash: string, sectionIndex: number): Promise<ChapterSummary | null>
async saveChapterSummary(summary: ChapterSummary): Promise<void>
async clearChapterSummaries(bookHash: string): Promise<void>  // call from clearBook too
```

Each is a one-store transaction (`get` by `chapterSummaryKey`, `put`, and an index cursor delete respectively) — copy the promise-wrapping pattern of the neighboring methods exactly. Also add the `clearChapterSummaries` call inside the existing `clearBook`.

- [ ] **Step 4: Run** — `npx vitest run src/__tests__/services/ai/summary-cache.test.ts && pnpm lint` → pass, exit 0.
- [ ] **Step 5: Commit** — `git add -A src/services/ai src/__tests__/services/ai && git commit -m "feat(ai): chapter summary cache store"`

---

### Task 3: summaryService (TDD — the core task)

**Files:**
- Create: `src/services/ai/summaryService.ts`
- Test: `src/__tests__/services/ai/summary-service.test.ts`

Behavior contract:
- `summarizeChapter(args)`: extract section text → if cached (`contentHash` match) return cached; else if text ≤ `MAX_SINGLE_CALL_CHARS` (24_000, ≈6k tokens) one `generateText` call; else split into ≤24_000-char pieces on paragraph boundaries, summarize each, then summarize the concatenated piece-summaries (map-reduce). Save to cache. Returns the summary string.
- `recapToPosition(args)`: for each linear section with index < currentSectionIndex (and text ≥ 100 chars, mirroring `indexBook`), obtain a chapter summary (cache-first, generating as needed), then ONE synthesis `generateText` with `buildRecapPrompt`; returns the recap. Unreadable sections are skipped and listed as `Chapter N could not be read` lines appended to the synthesis input.
- Both throw `new Error('AI_NOT_CONFIGURED')` when `getAIProvider` throws, so callers can route users to settings.
- Inputs are passed in (no store access in this module — keeps it testable): `{ bookDoc, bookHash, bookTitle, aiSettings, currentSectionIndex? }`.

- [ ] **Step 1: Write the failing test** — `src/__tests__/services/ai/summary-service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: vi.fn((settings: { openaiApiKey?: string }) => {
    if (!settings.openaiApiKey) throw new Error('API key required');
    return { getModel: () => ({ modelId: 'test-model' }) };
  }),
}));

// in-memory cache stub — the real store is IndexedDB
const cache = new Map<string, import('@/services/ai/types').ChapterSummary>();
vi.mock('@/services/ai/storage/aiStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ai/storage/aiStore')>();
  return {
    ...actual,
    aiStore: {
      getChapterSummary: vi.fn(async (b: string, i: number) => cache.get(`${b}:${i}`) ?? null),
      saveChapterSummary: vi.fn(async (s: import('@/services/ai/types').ChapterSummary) => {
        cache.set(s.key, s);
      }),
    },
  };
});

import { summarizeChapter, recapToPosition } from '@/services/ai/summaryService';
import { hashContent } from '@/services/ai/storage/aiStore';

const sectionDoc = (text: string) => {
  const doc = document.implementation.createHTMLDocument('s');
  doc.body.textContent = text;
  return doc;
};
const makeBookDoc = (texts: string[]) =>
  ({
    metadata: { title: 'Test Book' },
    toc: [],
    sections: texts.map((t, i) => ({
      linear: 'yes',
      size: t.length,
      createDocument: async () => sectionDoc(t),
      id: String(i),
    })),
  }) as never;

const SETTINGS = { openaiApiKey: 'k' } as never;
const longText = (label: string) => `${label} ` + 'sentence of plot. '.repeat(40);

beforeEach(() => {
  generateTextMock.mockReset();
  cache.clear();
  generateTextMock.mockImplementation(async ({ prompt }: { prompt: string }) => ({
    text: `SUM(${prompt.length})`,
  }));
});

describe('summarizeChapter', () => {
  it('summarizes a small chapter with a single call and caches it', async () => {
    const bookDoc = makeBookDoc([longText('one')]);
    const out = await summarizeChapter({
      bookDoc, bookHash: 'h1', bookTitle: 'Test Book', aiSettings: SETTINGS, sectionIndex: 0,
    });
    expect(out).toMatch(/^SUM\(/);
    expect(generateTextMock).toHaveBeenCalledTimes(1);

    generateTextMock.mockClear();
    const again = await summarizeChapter({
      bookDoc, bookHash: 'h1', bookTitle: 'Test Book', aiSettings: SETTINGS, sectionIndex: 0,
    });
    expect(again).toBe(out);
    expect(generateTextMock).not.toHaveBeenCalled(); // cache hit
  });

  it('invalidates the cache when content changes', async () => {
    const bookDoc = makeBookDoc([longText('one')]);
    await summarizeChapter({ bookDoc, bookHash: 'h2', bookTitle: 'T', aiSettings: SETTINGS, sectionIndex: 0 });
    // poison the cache with a stale contentHash
    const stale = cache.get('h2:0')!;
    cache.set('h2:0', { ...stale, contentHash: 'stale' });
    generateTextMock.mockClear();
    await summarizeChapter({ bookDoc, bookHash: 'h2', bookTitle: 'T', aiSettings: SETTINGS, sectionIndex: 0 });
    expect(generateTextMock).toHaveBeenCalledTimes(1); // regenerated
  });

  it('map-reduces chapters above the single-call limit', async () => {
    const huge = 'paragraph of plot.\n\n'.repeat(2000); // ~40k chars
    const bookDoc = makeBookDoc([huge]);
    await summarizeChapter({ bookDoc, bookHash: 'h3', bookTitle: 'T', aiSettings: SETTINGS, sectionIndex: 0 });
    // at least 2 piece calls + 1 reduce call
    expect(generateTextMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('throws AI_NOT_CONFIGURED without a provider key', async () => {
    const bookDoc = makeBookDoc([longText('one')]);
    await expect(
      summarizeChapter({ bookDoc, bookHash: 'h4', bookTitle: 'T', aiSettings: {} as never, sectionIndex: 0 }),
    ).rejects.toThrow('AI_NOT_CONFIGURED');
  });
});

describe('recapToPosition', () => {
  it('summarizes only sections before the current one, then synthesizes', async () => {
    const bookDoc = makeBookDoc([longText('a'), longText('b'), longText('c'), longText('d')]);
    const recap = await recapToPosition({
      bookDoc, bookHash: 'h5', bookTitle: 'T', aiSettings: SETTINGS, currentSectionIndex: 2,
    });
    // chapters 0 and 1 summarized (2 calls) + 1 synthesis = 3; chapters 2,3 untouched
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(recap).toMatch(/^SUM\(/);
    expect(cache.has('h5:0') && cache.has('h5:1')).toBe(true);
    expect(cache.has('h5:2')).toBe(false);
  });

  it('reuses cached chapter summaries on a later recap', async () => {
    const bookDoc = makeBookDoc([longText('a'), longText('b'), longText('c'), longText('d')]);
    await recapToPosition({ bookDoc, bookHash: 'h6', bookTitle: 'T', aiSettings: SETTINGS, currentSectionIndex: 2 });
    generateTextMock.mockClear();
    await recapToPosition({ bookDoc, bookHash: 'h6', bookTitle: 'T', aiSettings: SETTINGS, currentSectionIndex: 3 });
    // only chapter 2 newly summarized + synthesis
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('skips unreadable sections with a note instead of failing', async () => {
    const bookDoc = makeBookDoc([longText('a'), longText('b')]);
    (bookDoc as { sections: { createDocument: () => Promise<Document> }[] }).sections[0]!.createDocument =
      async () => { throw new Error('corrupt'); };
    const recap = await recapToPosition({
      bookDoc, bookHash: 'h7', bookTitle: 'T', aiSettings: SETTINGS, currentSectionIndex: 2,
    });
    expect(recap).toBeTruthy();
    const synthesisPrompt = generateTextMock.mock.calls.at(-1)![0].prompt as string;
    expect(synthesisPrompt).toMatch(/Chapter 1 could not be read/);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** (module not found).

- [ ] **Step 3: Implement** `src/services/ai/summaryService.ts`:

```ts
import { generateText } from 'ai';
import type { BookDoc } from '@/libs/document';
import type { AISettings, ChapterSummary } from './types';
import { getAIProvider } from './providers';
import { aiStore, chapterSummaryKey, hashContent } from './storage/aiStore';
import { extractTextFromDocument } from './utils/chunker';
import { buildChapterSummaryPrompt, buildRecapPrompt } from './prompts';

// ≈6k tokens of input per call; above this a chapter is map-reduced.
const MAX_SINGLE_CALL_CHARS = 24_000;
// Mirrors indexBook: sections shorter than this carry no summarizable prose.
const MIN_SECTION_CHARS = 100;

interface SummaryArgs {
  bookDoc: BookDoc;
  bookHash: string;
  bookTitle: string;
  aiSettings: AISettings;
}

const getModelOrThrow = (aiSettings: AISettings) => {
  try {
    return getAIProvider(aiSettings).getModel();
  } catch {
    throw new Error('AI_NOT_CONFIGURED');
  }
};

const sectionText = async (bookDoc: BookDoc, index: number): Promise<string | null> => {
  const section = bookDoc.sections?.[index];
  if (!section || section.linear === 'no') return null;
  try {
    const doc = await section.createDocument();
    const text = extractTextFromDocument(doc);
    return text.length >= MIN_SECTION_CHARS ? text : null;
  } catch {
    return null;
  }
};

const chapterTitleOf = (bookDoc: BookDoc, index: number): string => {
  const item = bookDoc.toc?.find((t) => 'label' in t && t.label);
  void item;
  // TOC→section mapping varies per format; use a simple positional fallback.
  return bookDoc.toc?.[index]?.label ?? `Chapter ${index + 1}`;
};

const splitOnParagraphs = (text: string, maxLen: number): string[] => {
  if (text.length <= maxLen) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen / 2) cut = rest.lastIndexOf('. ', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim().length) pieces.push(rest);
  return pieces;
};

async function summarizeText(args: SummaryArgs, chapterTitle: string, text: string): Promise<string> {
  const model = getModelOrThrow(args.aiSettings);
  const system = buildChapterSummaryPrompt(args.bookTitle, chapterTitle);
  const pieces = splitOnParagraphs(text, MAX_SINGLE_CALL_CHARS);
  if (pieces.length === 1) {
    const { text: out } = await generateText({ model, system, prompt: pieces[0]!, temperature: 0.3 });
    return out.trim();
  }
  const pieceSummaries: string[] = [];
  for (const piece of pieces) {
    const { text: out } = await generateText({ model, system, prompt: piece, temperature: 0.3 });
    pieceSummaries.push(out.trim());
  }
  const { text: reduced } = await generateText({
    model,
    system,
    prompt: `These are sequential partial summaries of one chapter; merge them:\n\n${pieceSummaries.join('\n\n')}`,
    temperature: 0.3,
  });
  return reduced.trim();
}

export async function summarizeChapter(
  args: SummaryArgs & { sectionIndex: number },
): Promise<string> {
  getModelOrThrow(args.aiSettings); // fail fast before any I/O
  const text = await sectionText(args.bookDoc, args.sectionIndex);
  if (!text) throw new Error('CHAPTER_UNREADABLE');
  const contentHash = hashContent(text);
  const cached = await aiStore.getChapterSummary(args.bookHash, args.sectionIndex);
  if (cached && cached.contentHash === contentHash) return cached.summary;

  const summary = await summarizeText(args, chapterTitleOf(args.bookDoc, args.sectionIndex), text);
  const entry: ChapterSummary = {
    key: chapterSummaryKey(args.bookHash, args.sectionIndex),
    bookHash: args.bookHash,
    sectionIndex: args.sectionIndex,
    contentHash,
    summary,
    createdAt: Date.now(),
  };
  await aiStore.saveChapterSummary(entry);
  return summary;
}

export async function recapToPosition(
  args: SummaryArgs & { currentSectionIndex: number },
): Promise<string> {
  const model = getModelOrThrow(args.aiSettings);
  const parts: string[] = [];
  for (let i = 0; i < args.currentSectionIndex; i++) {
    try {
      const summary = await summarizeChapter({ ...args, sectionIndex: i });
      parts.push(`${chapterTitleOf(args.bookDoc, i)}:\n${summary}`);
    } catch (e) {
      if ((e as Error).message === 'AI_NOT_CONFIGURED') throw e;
      parts.push(`Chapter ${i + 1} could not be read.`);
    }
  }
  const { text } = await generateText({
    model,
    system: buildRecapPrompt(args.bookTitle),
    prompt: parts.join('\n\n'),
    temperature: 0.4,
  });
  return text.trim();
}
```

Note: `chapterTitleOf` is intentionally simple (positional TOC lookup with a fallback). If `BookDoc['toc']` typing doesn't allow indexing, adapt to whatever `getChapterTitle(toc, i)` in `ragService.ts` does — there is an existing helper; PREFER reusing it (import if exported, else replicate its logic). Remove the dead `item` lines if you use the helper.

- [ ] **Step 4: Run** — `npx vitest run src/__tests__/services/ai/summary-service.test.ts && pnpm lint` → 7 pass, lint exit 0. Also `pnpm test -- run` full suite once.
- [ ] **Step 5: Commit** — `git add src/services/ai/summaryService.ts src/__tests__/services/ai/summary-service.test.ts && git commit -m "feat(ai): summary service with chapter cache and recap synthesis"`

---

### Task 4: Book menu entries + notebook delivery

**Files:**
- Modify: `src/app/reader/components/sidebar/BookMenu.tsx`
- Create: `src/app/reader/hooks/useAISummary.ts`

No unit test (UI wiring; consistent with BookMenu precedent). Verified by lint + manual checklist in Task 5.

- [ ] **Step 1: The hook** — `src/app/reader/hooks/useAISummary.ts`:

```ts
import { useCallback } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { useOpenAIInNotebook } from './useOpenAIInNotebook';
import { summarizeChapter, recapToPosition } from '@/services/ai/summaryService';
import { eventDispatcher } from '@/utils/event';
import { useTranslation } from '@/hooks/useTranslation';

export function useAISummary(bookKey: string) {
  const _ = useTranslation();
  const { getProgress } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const { settings } = useSettingsStore();
  const { addMessage } = useAIChatStore();
  const { openAIInNotebook } = useOpenAIInNotebook();

  const run = useCallback(
    async (kind: 'recap' | 'chapter') => {
      const bookData = getBookData(bookKey);
      const bookDoc = bookData?.bookDoc;
      const book = bookData?.book;
      const progress = getProgress(bookKey);
      const sectionIndex = progress?.section ?? 0; // confirm field name in readerStore types
      if (!bookDoc || !book) return;

      const title =
        kind === 'recap'
          ? `${_('Recap')} — ${book.title}`
          : `${_('Chapter Summary')} — ${book.title}`;
      const conversationId = await openAIInNotebook({
        bookHash: book.hash,
        newConversationTitle: title,
      });

      try {
        const args = {
          bookDoc,
          bookHash: book.hash,
          bookTitle: book.title,
          aiSettings: settings.aiSettings,
        };
        const text =
          kind === 'recap'
            ? await recapToPosition({ ...args, currentSectionIndex: sectionIndex })
            : await summarizeChapter({ ...args, sectionIndex });
        await addMessage({ conversationId, role: 'assistant', content: text } as never);
      } catch (e) {
        if ((e as Error).message === 'AI_NOT_CONFIGURED') {
          eventDispatcher.dispatch('toast', {
            type: 'info',
            message: _('Configure an AI provider in Settings → AI Assistant first'),
          });
          return;
        }
        await addMessage({
          conversationId,
          role: 'assistant',
          content: _('Summary failed. Please try again.'),
        } as never);
      }
    },
    [bookKey],
  );

  return {
    runRecap: () => run('recap'),
    runChapterSummary: () => run('chapter'),
  };
}
```

IMPORTANT adaptation notes for the implementer (read before coding):
- `useOpenAIInNotebook`'s `openAIInNotebook` — read the hook: confirm it returns the conversation id when given `newConversationTitle` (it calls `createConversation`); if it doesn't return the id, extend that hook to return it (small change) rather than duplicating its logic.
- `AIMessage` shape: read `src/services/ai/types.ts` and remove the `as never` casts by matching the real required fields (`conversationId`, `role`, `content` at minimum).
- `progress.section`: confirm the field via `src/store/readerStore.ts` / `PageInfo` types; adapt the name, not the behavior. The `// confirm field name` comment must NOT survive into the commit.
- 'toast' is an existing event with a listener (`Toast.tsx`); match its payload type (`grep -n "interface ToastProps\|'toast'" src/components/Toast.tsx`).

- [ ] **Step 2: Menu entries** — in `BookMenu.tsx`, next to the sync menu handlers:

```ts
const { runRecap, runChapterSummary } = useAISummary(sideBarBookKey ?? '');
const handleRecap = () => { runRecap(); setIsDropdownOpen?.(false); };
const handleChapterSummary = () => { runChapterSummary(); setIsDropdownOpen?.(false); };
```

And in the JSX, after the sync sections (gated like the AI panel — AI enabled):

```tsx
{settings.aiSettings?.enabled && (
  <MenuItem label={_('AI Summary')} detailsOpen={false} buttonClass='py-2'>
    <ul className='flex flex-col ps-1'>
      <MenuItem label={_('Recap: Story So Far')} noIcon onClick={handleRecap} />
      <MenuItem label={_('Summarize This Chapter')} noIcon onClick={handleChapterSummary} />
    </ul>
  </MenuItem>
)}
```

Add `settings.aiSettings?.enabled` to the `<hr>` gate condition alongside kosync/webdav/readwise/hardcover. Import `useAISummary`.

- [ ] **Step 3: Run** — `pnpm lint && pnpm test -- run 2>&1 | grep -E "Test Files|Tests "` → clean, no regressions.
- [ ] **Step 4: Commit** — `git add src/app/reader/hooks/useAISummary.ts src/app/reader/components/sidebar/BookMenu.tsx && git commit -m "feat(reader): AI recap and chapter summary in book menu"`

---

### Task 5: End-to-end verification + i18n

- [ ] **Step 1: Full gates** — `pnpm test && pnpm lint && pnpm -w format:check` (run format:check from repo root).
- [ ] **Step 2: i18n** — run the `/i18n` skill (or `pnpm run i18n:extract` + translate per docs/i18n.md). New keys: `AI Summary`, `Recap: Story So Far`, `Summarize This Chapter`, `Recap`, `Chapter Summary`, `Configure an AI provider in Settings → AI Assistant first`, `Summary failed. Please try again.`
- [ ] **Step 3: Manual smoke (web dev server)** — `pnpm dev-web`: enable AI assistant with a working provider (Ollama or OpenAI key), open a book, book menu → "Recap: Story So Far" → notebook AI tab opens with a recap conversation; "Summarize This Chapter" produces a chapter summary; with AI disabled the menu section is hidden; with AI enabled but no key, a toast points to settings.
- [ ] **Step 4: Commit i18n output** — `git add public/locales && git commit -m "chore(i18n): AI summary strings"`

---

## Self-Review Notes

- Spec coverage: prompts (T1), cache (T2), windowing/map-reduce/recap/error mapping (T3), menu + notebook delivery + gating + toasts (T4), i18n + manual checks (T5). Delivery is non-streaming v1 (single `addMessage`) — the spec's "streams" wording is satisfied at the conversation level, noted as a future enhancement.
- Type consistency: `ChapterSummary` (T2) used in T3; `summarizeChapter/recapToPosition` signatures match between T3 definition and T4 usage; `chapterSummaryKey/hashContent` exported in T2, imported in T3.
- Known adaptations are explicitly marked (AIMessage shape, progress field name, openAIInNotebook return) with the instruction to resolve them by reading the named files — not placeholders, but documented integration points with named sources of truth.
