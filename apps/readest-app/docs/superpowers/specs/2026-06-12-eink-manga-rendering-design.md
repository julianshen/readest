# E-ink Manga Rendering — Design

**Date:** 2026-06-12
**Status:** Awaiting review
**Scope:** apps/readest-app

## Goal

Make manga legible and pleasant on e-ink (Boox): per-book image contrast /
brightness adjustment with an e-ink preset, and a full-refresh-per-page
default for comics in e-ink mode.

## What already exists (verified)

- E-ink mode toggles `data-eink` on the document root (useEinkMode.ts:10);
  `viewSettings.isEink`, `epdMode`, `epdRefreshInterval` persist per book
  (types/book.ts:280-282).
- EPD plumbing: `setEpdMode` / `doEpdRefresh` via `plugin:eink` bridge calls
  (bridge.ts:270-289), with `useEpdPageRefresh` firing a GC refresh every N
  page turns (default 5).
- NO content image filters exist today; `applyImageStyle(document)`
  (style.ts:1081-1119) already iterates the iframe's `<img>` elements on
  load — the natural hook for a filter.

## Decisions made

| Question | Decision |
|---|---|
| Adjustment controls | Two per-book sliders for fixed-layout books: **Contrast** (50–200%, default 100) and **Brightness** (50–150%, default 100), implemented as a CSS `filter` on the page images. Plus a one-tap **"E-ink boost" preset** = contrast 140 / brightness 110 / grayscale. |
| Grayscale | Included in the boost preset (`grayscale(1)`) — color manga panels dither badly otherwise. Not a separate control. |
| True dithering | Not feasible in CSS; out of scope. Contrast+grayscale approximates the benefit. The Boox EPD A2/GC modes handle hardware dithering. |
| Where applied | `img.style.filter` set inside the existing `applyImageStyle` pass, driven by new `ViewSettings.imageContrast` / `imageBrightness` / `imageGrayscale` fields. Applies on load and when the settings change (re-run the pass via the existing styles effect in FoliateViewer). |
| Scope of controls | Shown for fixed-layout books in the view-settings Color/Image panel. Work on ALL screens (useful for washed-out scans even on LCD), but the preset button only shows when `isEink`. |
| Refresh default | When a CBZ opens with `isEink` and the user has not set a per-book `epdRefreshInterval`, default it to 1 (full refresh every page) — manga pages are full-bleed images where ghosting is much more visible than text. Existing per-book override unchanged. |

## Architecture

1. **Types:** `ViewSettings.imageContrast: number` (100),
   `imageBrightness: number` (100), `imageGrayscale: boolean` (false).
2. **`applyImageStyle`** (style.ts): compose
   `filter: contrast(C%) brightness(B%) [grayscale(1)]` when any value is
   non-default; skip entirely otherwise (no perf cost for novels).
3. **FoliateViewer:** include the three fields in the dependency list of the
   style-application effect so slider changes re-apply live; for CBZ + isEink
   without explicit `epdRefreshInterval`, seed 1 into the per-book settings.
4. **Settings UI:** Color/Image panel section (fixed-layout only): two
   sliders + "E-ink boost" preset button (sets all three fields at once;
   pressing again resets to defaults).

## Error handling

None novel — CSS filters can't fail; out-of-range slider values are clamped
by the control.

## Testing

- Unit: filter-string composition (defaults → no filter; combinations
  compose correctly); CBZ+eink seeds `epdRefreshInterval=1` only when unset.
- Manual on Boox: boost preset visibly improves a gray-heavy manga page; no
  regression on text books (filter absent); per-page refresh eliminates
  ghosting.

## Out of scope

- True error-diffusion dithering (would need canvas re-rendering of pages).
- Auto-contrast (histogram analysis).
- Per-series presets.
