# AI Summary — Recap & Chapter Summary — Design

**Date:** 2026-06-11
**Status:** Approved
**Scope:** apps/readest-app

## Goal

Two reader features powered by the existing AI provider stack:

1. **Recap: Story So Far** — summarize everything from the book's start up to
   the current reading position ("previously on…"), for returning to a book
   after time away.
2. **Chapter Summary** — summarize the chapter currently being read.

Both surface in the reader's book menu and deliver results into the Notebook
panel's AI tab as ordinary conversations, so streaming, history, and
follow-up questions reuse the existing chat machinery.

## Decisions made

| Question | Decision |
|---|---|
| Scope | Recap (story so far) + current chapter. Selected-text and whole-book summaries are out of scope. |
| UI surface | Book menu entries; results open as a new conversation in the Notebook AI tab. No new dialog. |
| Long-content strategy | Hierarchical map-reduce with a per-chapter summary cache (Approach A). RAG retrieval (gappy coverage) and recent-window-only (not a real recap) were rejected. |
| Provider | The active AI assistant provider via `getAIProvider(aiSettings)` — works with Ollama, AI Gateway, OpenRouter, and OpenAI. No per-feature provider override. |

## Architecture

### 1. `src/services/ai/summaryService.ts` (new)

Public API:

- `summarizeChapter(bookKey, sectionIndex): AsyncIterable<string> | Promise<string>`
- `recapToPosition(bookKey): …` — reads the book's current progress
  (CFI/section index) from the reader store.

Responsibilities:

- **Text extraction**: section text via the same extraction path
  `ragService.indexBook` uses (foliate sections → plain text). The recap
  includes only sections strictly before the current one. The current,
  partially-read section is NOT included — intra-section truncation requires
  CFI offset math and is deferred to phase 2. this position-windowed
  construction IS the spoiler protection; the `aiSettings.spoilerProtection`
  flag governs the assistant's RAG retrieval and is not separately consulted
  here.
- **Chunking**: chapters above a token threshold are split with the existing
  `chunker.ts` and map-reduced (chunk summaries → chapter summary).
- **Per-chapter cache**: chapter summaries are cached in the AI storage
  layer, keyed `bookHash + sectionIndex + contentHash(sectionText)`. A recap
  composes cached chapter summaries and runs ONE final synthesis call;
  re-running a recap later only summarizes newly read chapters.
- **Prompts** live in `prompts.ts` alongside the existing assistant prompts:
  a chapter-summary prompt (~200-word output, factual, no commentary) and a
  recap-synthesis prompt (narrative "story so far", present tense, no
  spoilers beyond provided content).

### 2. Book menu (`BookMenu.tsx`)

An "AI" section with two entries — `Recap: Story So Far` and
`Summarize This Chapter` — visible when `aiSettings.enabled`; if no provider
is configured, invoking an entry shows a toast pointing to Settings → AI
Assistant (hiding the menu entirely would make the feature undiscoverable).

### 3. Notebook delivery

Menu handlers call the existing `openAIInNotebook` hook to open/create a
conversation (`Recap — <book title>` / `Chapter — <chapter title>`), then
`summaryService` streams the result through `aiChatStore.addMessage` as an
assistant message. The conversation is persistent and supports follow-up
questions through the normal chat flow.

## Error handling

- AI not enabled / no provider key → menu entries hidden; if reached via a
  stale state, toast pointing to Settings → AI.
- Provider failure mid-generation → error surfaces in the conversation via
  the existing chat error path; partial chapter-summary cache entries are
  not written.
- Oversized chapters → automatic chunked map-reduce; never a hard failure.
- Empty/unparseable section text → that section is skipped with a note in
  the recap ("Chapter N could not be read").

## Testing

Unit tests with a mocked provider:

1. Position windowing: recap input includes sections `< current`, truncates
   the current section, never includes later content.
2. Cache: second recap with no reading progress performs only the synthesis
   call; chapter cache invalidates when `contentHash` changes.
3. Map-reduce: chapters above the threshold are chunked; below it, a single
   call.
4. Prompt builders produce the documented constraints (length cap, no-spoiler
   instruction).

UI wiring (menu gating, notebook opening) is verified by lint and the
existing component patterns; no component tests (consistent with BookMenu
precedent).

## Out of scope (phase 2 candidates)

- Auto-recap banner when reopening a book after N days.
- Exporting summaries to annotations/notes.
- Per-feature model override; selected-text and whole-book summaries.
- Intra-section (partial current chapter) recap content — phase 2.
