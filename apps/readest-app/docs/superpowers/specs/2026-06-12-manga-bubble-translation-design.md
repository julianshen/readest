# Manga Bubble Translation (Region OCR + Translate) — Design

**Date:** 2026-06-12
**Status:** Awaiting review
**Scope:** apps/readest-app

## Goal

Read manga in a language you don't speak: drag a rectangle over a speech
bubble (or panel) → a vision-capable AI model transcribes and translates the
text → the translation appears in a popup anchored at the region. The flagship
comic feature; the image analog of the selected-text AI actions.

## What already exists (verified)

- The `ai` SDK v6 (installed v6.0.177) supports multimodal `generateText`
  with `{ type: 'image', image }` content parts; nothing in the provider
  stack blocks it (`getAIProvider(...).getModel()` returns a standard
  `LanguageModel`). Vision capability depends on the user's chosen model
  (e.g. Gemini Flash via Gateway/OpenRouter, GPT-4o-mini via OpenAI).
- Comic pages are same-origin blob URLs inside the foliate iframe → canvas
  `drawImage` + `toBlob` is NOT tainted; foliate's quote-image.js
  (lines 58-86) demonstrates the canvas→blob pattern.
- `getRangeRectInWebview` (sel.ts:101-122) shows the iframe→webview
  coordinate transform math; `getPopupPosition` (sel.ts:308-344) and the
  `SelectionAIPopup` pattern cover the anchored-popup UX.
- Target language + provider settings: translation stack's target language
  (`getTargetLang`, TRANSLATED_LANGS) and `isAIAssistantConfigured` gate.

## Decisions made

| Question | Decision |
|---|---|
| Region selection UX | Explicit mode: a "Translate region" button in the reader header (visible for fixed-layout books when the AI assistant is configured). Tapping it enters a one-shot overlay mode — drag a rectangle; on release, translation runs; Esc/tap-outside cancels. No always-on tap interception (conflicts with page-turn taps). |
| OCR engine | The user's vision-capable AI model in ONE call: "transcribe the text in this image region and translate it to {target}". No separate on-device OCR in v1 — zero new native deps, works on all platforms, and handles stylized manga lettering better than Tesseract. |
| Output | Popup anchored at the selected rect showing the translation (primary) with the transcription collapsible underneath. Copy button. Reuses the SelectionAIPopup visual conventions. |
| Target language | The translator stack's target language (same as text translation), NOT `answerLanguage` — this is translation, not summarization. |
| Capture resolution | Crop from the image's natural resolution (map the screen rect through the current scale transform back to natural pixels), capped at 1536px on the long edge; JPEG ~0.85 to keep request sizes sane. |
| Caching | In-memory per session, keyed by page section index + rect (snapped to 8px grid) + target lang. No persistent cache in v1. |
| Privacy | The cropped region is sent to the configured AI provider. The mode button shows a one-time notice ("Sends the selected image region to your AI provider"). Local/Ollama users keep everything on-device if their model supports vision. |

## Architecture

1. **`src/services/ai/bubbleTranslationService.ts`** (new):
   `translateRegion({ imageBlob, targetLang, aiSettings }): Promise<{ transcription, translation }>` —
   builds the multimodal `generateText` call (system prompt: transcribe +
   translate, output as two labeled blocks; temperature 0.2), fail-fast
   `NOT_CONFIGURED` via the existing `getModelOrThrow` pattern, and a
   `VISION_UNSUPPORTED` error mapped from provider 4xx "image not supported"
   responses.
2. **Region capture util** (`src/utils/pageCapture.ts`, new):
   given the foliate view and a webview-coordinate rect, locate the page
   `<img>` element(s) under the rect inside the iframe, map the rect through
   the iframe transform (inverse of the `getRangeRectInWebview` math) and the
   image's displayed→natural scale, draw the crop to an offscreen canvas, and
   return a JPEG blob. Pure function of (iframe, rect) — unit-testable with a
   jsdom-stubbed canvas.
3. **`RegionSelectOverlay.tsx`** (new, reader component): full-page absolute
   overlay capturing pointer events; renders the drag rectangle (marching
   border, e-ink-safe: solid 1px on `[data-eink]`); on pointer-up ≥ a minimum
   24×24px, emits the rect and exits the mode.
4. **`BubbleTranslationPopup.tsx`** (new): anchored popup (Popup +
   getPopupPosition) showing spinner → translation → collapsible
   transcription; error states for `NOT_CONFIGURED` / `VISION_UNSUPPORTED` /
   generic failure.
5. **Header button**: in the reader header (beside the existing translate
   toggle), shown when `bookData.isFixedLayout && isAIAssistantConfigured(...)`.

## Error handling

- Model lacks vision → "This model can't read images — choose a
  vision-capable model in Settings → AI Assistant" (detected from the
  provider error; never silent).
- No text found in region → the model is instructed to answer `NO_TEXT`; UI
  shows "No text detected in this region".
- Oversized region (full page) is allowed but downscaled by the 1536px cap.
- Rate limit / network → same retry-then-clean-error convention as the
  translators (surface in the popup, no toast spam).

## Testing

- Unit: prompt construction (target language pinned; NO_TEXT contract);
  service error mapping (`NOT_CONFIGURED`, `VISION_UNSUPPORTED`); rect→natural
  pixel mapping math in `pageCapture` (pure-math cases incl. scale + offset);
  cache key snapping.
- Manual (the real gate): Japanese manga page via Gemini Flash on OpenRouter —
  bubble translation accuracy, popup anchoring, cancel flow, e-ink rendering
  of the selection rectangle.

## Out of scope (phase 2 candidates)

- Automatic bubble detection (tap a bubble instead of dragging a rect).
- Inline overlay rendering (replacing bubble text in place).
- Persistent translation cache; batch "translate whole page".
- On-device OCR fallback (Tesseract/ML Kit).
