# Webtoon Continuous-Scroll Mode — Design

**Date:** 2026-06-12
**Status:** Awaiting review
**Scope:** apps/readest-app + packages/foliate-js (vendored)

## Goal

A "Webtoon" reading mode for vertical-strip comics (manhwa/webtoons): seamless
continuous vertical scroll with zero gaps between page images, fit-width
scaling, and smooth lookahead loading.

## What already exists (verified)

- Fixed-layout already supports `flow="scrolled"`: a flex-column
  `.scroll-container` of `.scroll-page` divs with on-demand loading via an
  IntersectionObserver with 50% rootMargin (fixed-layout.js:172-188, 477-529).
- Each `.scroll-page` currently has a hard-coded `margin: 4px 0` gap
  (fixed-layout.js:184).
- `viewSettings.scrolled` maps to the `flow` attribute
  (FoliateViewer.tsx:615-622); `zoomMode` (`fit-width` etc.) is applied via
  the `zoom` attribute.
- Spread preloading only triggers on spread navigation, not while scrolling
  (fixed-layout.js:991-1020).

## Decisions made

| Question | Decision |
|---|---|
| What "Webtoon mode" is | A per-book preset, not a new renderer: `scrolled: true` + `zoomMode: 'fit-width'` + zero page gap + larger scroll lookahead. One toggle, not four. |
| Where the toggle lives | View settings Layout panel, fixed-layout books only: "Webtoon mode" switch. Persisted per book. Turning it on snapshots the previous layout values and restores them when turned off. |
| Gap removal | New renderer attribute `page-gap` (px). Webtoon mode sets `0`; the default stays `4` so existing scrolled behavior is unchanged. |
| Lookahead | Raise the IntersectionObserver `rootMargin` to ~200% viewport height when in webtoon mode (renderer attribute `scroll-lookahead`), so the next strips decode before they enter view. |
| Spreads in webtoon mode | Ignored — every image renders as a full-width single page (spread logic is bypassed in scroll mode already). |
| Progress | Unchanged: fraction-based progress and the footer slider already work in scrolled mode. |

## Architecture

1. **foliate `fixed-layout.js`:**
   - `page-gap` attribute → sets the `.scroll-page` vertical margin via an
     inline style/CSS variable instead of the hard-coded 4px.
   - `scroll-lookahead` attribute → IntersectionObserver rootMargin
     (`'50%'` default, `'200%'` for webtoon).
2. **`FoliateViewer.tsx`** (the fixed-layout settings effect, ~601-622):
   when `viewSettings.webtoonMode` is true, set `flow='scrolled'`,
   `zoom='fit-width'`, `page-gap='0'`, `scroll-lookahead='200%'`; otherwise
   apply the user's normal scrolled/zoom settings with defaults.
3. **Types/settings:** `ViewSettings.webtoonMode: boolean` (default false) +
   the snapshot fields needed to restore prior layout (store the previous
   `scrolled`/`zoomMode` pair in the same per-book config).
4. **Settings UI:** one `SettingsSwitchRow` ("Webtoon mode") in the Layout
   panel, fixed-layout only, beside the manga direction controls from the
   manga-reading-mode spec.

## Error handling

- Extremely tall images (strips exceeding canvas/texture limits on Android
  WebView, ~8k px) render as-is; if blank-tile artifacts are reported, cap
  display height and split visually — explicitly deferred until observed.
- Toggling webtoon mode preserves position by section index.

## Testing

- foliate browser test: `page-gap=0` produces adjacent pages with no margin;
  `scroll-lookahead` changes observer rootMargin.
- App unit: webtoon toggle writes/restores the layout snapshot per book.
- Manual: a webtoon CBZ scrolls seamlessly with no visible seams or load
  hitches at normal reading speed.

## Out of scope

- Horizontal continuous scroll.
- Auto-detection of webtoon content (tall-image heuristics) — manual toggle
  only in v1.
