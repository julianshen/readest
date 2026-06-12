# Selected-Text AI Actions + Shared AI Answer-Language Setting — Design

**Date:** 2026-06-12
**Status:** Approved
**Scope:** apps/readest-app

## Goal

Two related changes powered by the existing AI assistant provider stack:

1. **Selected-text AI actions** — select a passage in the reader and run one of
   three one-tap actions from the selection toolbar: **Explain**, **Simplify**,
   **Define-in-context**. The answer streams into an inline popup anchored to
   the selection, like the existing Dictionary and Translate popups.
2. **Shared "AI answer language" setting** — one global control
   (`aiSettings.answerLanguage`) that governs the output language of both the
   summary/recap feature and the selected-text Explain/Define answers. Values:
   `book` (default) or `app`. Simplify always uses the book's language.

## Decisions made

| Question | Decision |
|---|---|
| Answer surface | Inline popup anchored to the selection (sibling of `DictionaryPopup`/`TranslatorPopup`). No notebook chat, no follow-up handoff in v1. |
| Context given to the model | Selection + nearby preceding text within the current section, truncated at the selection end (spoiler-safe). No embeddings/index required. |
| Action set | Three fixed actions: Explain, Simplify, Define-in-context. No free-form input in v1. |
| Answer language | Governed by the new `aiSettings.answerLanguage` setting (`book` default \| `app`). **Simplify always uses the book's language** regardless of the setting. |
| Setting default | `book` — preserves the just-shipped recap behavior; no-op when app language equals book language. |
| Gating | The toolbar AI button is shown only when the AI assistant is enabled AND a provider is configured (same gate as the AI translator). |
| Streaming | Stream the answer via `streamText` (responsive for paragraph-length output). |

## Architecture

### 1. Shared answer-language setting

- **Type**: add `answerLanguage?: 'book' | 'app'` to `AISettings`
  (`src/services/ai/types.ts` or wherever `AISettings` is defined). Treat
  `undefined` as `'book'` so existing stored settings need no migration.
- **Settings UI**: one control in the AI Assistant settings panel — a
  `SettingsSelect` (or two-option row) labeled "AI answer language" with options
  "Book language" / "App language", plus a `Tips` line noting it covers
  summaries, recaps, and Explain/Define, and that Simplify always uses the
  book's language. Follow the existing settings primitives in
  `src/components/settings/primitives/`.
- **Language resolution helper**: a single function maps the setting +
  contexts to a human-readable language name (English name, fed to prompts):
  - `book` → `getLanguageName(getPrimaryLanguage(bookDoc.metadata.language))`
  - `app`  → `getLanguageName(<ui locale code>)` (UI locale from the existing
    i18n/user-language accessor, e.g. `getLocale()`/`getUserLang()` in
    `src/utils/book.ts` / i18n).
  Both helpers already exist (`getPrimaryLanguage`, `getLanguageName`).

### 2. `summaryService.ts` — respect the setting

`summaryService` currently hardcodes book language via `bookLanguageName()`.
Change it to resolve the language from `aiSettings.answerLanguage`:

- When `answerLanguage === 'app'`, summaries and recap are written in the UI
  language; otherwise the book's language (current behavior).
- The UI language code must be threaded in. `SummaryArgs` already carries
  `aiSettings`; add the resolved UI language (or pass the locale code) from the
  caller `useAISummary.ts`, which has access to the app locale.
- The prompt builders (`buildChapterSummaryPrompt`, `buildRecapPrompt`) are
  unchanged — they already take a `language` string param.

### 3. `selectionAIService.ts` (new)

Public API:

```
type SelectionAction = 'explain' | 'simplify' | 'define';

runSelectionAction(action, {
  bookDoc, sectionIndex, selectedText, aiSettings, uiLanguageCode,
}): AsyncIterable<string>
```

Responsibilities:

- **Context extraction**: load the current section text (same path as
  `summaryService.sectionText` → `section.createDocument()` +
  `extractTextFromDocument`), find the selected passage within it, and build a
  context string of the preceding text within the section capped to
  `MAX_CONTEXT_CHARS` (~3–4k), ending at the selection, with the selected
  passage marked (e.g. wrapped in `«…»`). Never include text after the
  selection. If the selection can't be located in the section text, fall back
  to selection-only context.
- **Language selection**: Simplify → book language; Explain/Define → resolved
  per `answerLanguage` (book or app).
- **Generation**: `getAIProvider(aiSettings).getModel()` then `streamText({
  model, system: <action prompt>, prompt: <context>, temperature })`; yield
  `textStream` chunks. Throw `SELECTION_NOT_CONFIGURED` if the provider can't
  be built (fail fast before extraction).

### 4. Prompt builders (in `prompts.ts`, beside the summary prompts)

- `buildExplainPrompt(language)` — explain what the marked passage means using
  ONLY the provided text, never outside knowledge; concise (≤120 words); write
  in `${language}`.
- `buildDefinePrompt(language)` — give the contextual sense of the marked
  word/phrase as used here; concise; write in `${language}`.
- `buildSimplifyPrompt(language)` — rewrite the marked passage in simpler,
  plainer `${language}` preserving meaning; output only the rewrite, no
  preamble.

All three: the provided text is already position-capped, so the "use only the
provided text" constraint is the spoiler guard.

### 5. Popup + toolbar wiring

- **`SelectionAIPopup.tsx`** (new, in `annotator/`): modeled on
  `DictionaryPopup`/`TranslatorPopup`. Renders the three action chips; on pick,
  streams the answer into the body; footer has Copy + dismiss. Reuses the
  existing triangle/`getPopupPosition` math in `Annotator.tsx`.
- **`AnnotationTools.tsx`**: add an `ai` button (sparkle icon) to the selection
  toolbar, gated on `aiSettings.enabled && <provider configured>`.
- **`Annotator.tsx`**: add an `ai` case to the selection-action dispatch and
  state + render for `SelectionAIPopup` (mirroring the translator popup state
  at lines ~126, ~597, ~1390).
- **i18n**: add `Explain`, `Simplify`, `Define`, the popup labels, and the
  settings strings; run the i18n extract/translate workflow so no
  `__STRING_NOT_TRANSLATED__` placeholders remain (CI `check:translations`).

## Data flow

```
select text → toolbar "AI" → SelectionAIPopup opens (3 chips)
  → pick action
    → selectionAIService.runSelectionAction(action, {...})
       → extract section text up to selection (capped, marked)
       → resolve language (Simplify=book; Explain/Define=answerLanguage)
       → streamText(provider model, action system prompt, context)
       → yield chunks → popup appends streamed text
  → Copy / dismiss
```

## Error handling

- Provider not configured → button hidden; if reached via stale state, inline
  notice in the popup pointing to Settings → AI Assistant.
- Provider/stream failure mid-generation → inline error in the popup
  ("Couldn't generate — try again"); no caching of partial output.
- Empty or oversized selection → guard before opening generation, short toast.
- Selected text not found in section text → fall back to selection-only context
  (still works, just less surrounding context).

## Testing

Unit tests with a mocked provider:

1. **Prompt builders** (mirror `summary-prompts.test.ts`): each builder embeds
   its language argument and the "use only the provided text" constraint;
   Explain/Define are concise-constrained; Simplify says "output only the
   rewrite".
2. **`selectionAIService`**: context extraction never includes text after the
   selection (truncation correctness); selection-not-found falls back to
   selection-only; language resolution per action (Simplify always book;
   Explain/Define follow `answerLanguage`); action→prompt routing; fail-fast
   `SELECTION_NOT_CONFIGURED` when no provider.
3. **`summaryService` language resolution**: `answerLanguage: 'app'` yields UI
   language; `book`/undefined yields book language.

UI wiring (toolbar gating, popup open/position) is verified by lint and the
existing popup patterns; no component tests (consistent with Dictionary/Translate
precedent).

## Out of scope (phase 2 candidates)

- Free-form "Ask about this" input and follow-up conversation / handoff into the
  notebook chat.
- Spoiler-safe RAG retrieval context (cross-section, requires indexing).
- Caching selected-text answers.
- Per-action model override.
