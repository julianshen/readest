# Manga Reading Mode — RTL Direction, Spreads & AI Gating — Design

**Date:** 2026-06-12
**Status:** Awaiting review
**Scope:** apps/readest-app + packages/foliate-js (vendored)

## Goal

Make CBZ/comic reading correct for manga: per-book right-to-left page
direction with mirrored tap zones, smart double-page spreads with an offset
fix, and gating of the text-only AI Summary feature off for image-only books.

## What already exists (verified)

- `fixed-layout.js` already mirrors spread assembly when `book.dir === 'rtl'`
  (fixed-layout.js:831, 870-874) — but `comic-book.js` never sets `book.dir`,
  so CBZ always renders LTR.
- Tap zones already invert when `viewSettings.rtl` is true via
  `swapLeftRight` (usePagination.ts:129-131); zones are computed from screen
  halves (usePagination.ts:258-269).
- `spreadMode: 'auto' | 'none'` is already applied via
  `renderer.setAttribute('spread', …)` (FoliateViewer.tsx:601-606).
- Per-book view settings persist through `saveViewSettings` /
  `getConfig(bookKey)` (helpers/settings.ts:9-60) with an `isGlobal` flag.
- `comic-book.js` parses ComicInfo.xml (title, language, series, …) but NOT
  the `Manga` element (`YesAndRightToLeft`), which declares RTL.
- `BookData.isFixedLayout` is precomputed (bookDataStore.ts:15) and available
  to `BookMenu.tsx`.

## Decisions made

| Question | Decision |
|---|---|
| Direction source | ComicInfo.xml `Manga=YesAndRightToLeft` auto-sets RTL; a per-book manual toggle overrides it. Default LTR otherwise. |
| Where the toggle lives | View settings dialog, Layout panel, shown only for fixed-layout books: "Reading direction: Left to right / Right to left". Persisted per book (not global). |
| Tap zones | No new mechanism — setting `viewSettings.rtl` per book reuses the existing `swapLeftRight` inversion. |
| Spread detection | An image with aspect ratio width/height ≥ 1 is a spread page → rendered alone, centered (`pageSpread: 'center'`). Computed lazily from image natural size at section load. |
| Spread offset | Per-book "Spread offset" toggle (+1) that treats the first page as a standalone cover (`center`), shifting all subsequent left/right pairings by one. |
| AI Summary gating | Hide the AI Summary submenu in BookMenu when `bookData.isFixedLayout` (no extractable text). |

## Architecture

### 1. Direction plumbing (foliate + viewer)

- `comic-book.js`: parse the ComicInfo.xml `Manga` element; when
  `YesAndRightToLeft`, set `book.dir = 'rtl'` alongside the existing
  `book.rendition` assignment (comic-book.js:131).
- `FoliateViewer.tsx` (direction-derivation block, lines ~237-248): for
  fixed-layout books, derive the initial `viewSettings.rtl` from `book.dir`
  when the per-book config has no explicit override; when the user toggles
  direction, persist `rtl` (and `writingMode: 'horizontal-rl' | 'horizontal-tb'`
  for consistency) per book and re-render the spread by setting `book.dir` /
  re-calling the renderer's spread layout.
- The page-turn inversion needs no work: `viewSettings.rtl` already flows
  through `viewPagination`.

### 2. Spread improvements (foliate fixed-layout/comic-book)

- `comic-book.js`: after image load (the section `load()` wrapper), record
  natural dimensions; expose `pageSpread: 'center'` for wide images so
  `fixed-layout.js`'s existing spread assembly (lines 836-897) renders them
  alone. Dimensions are only known at load time — the spread map is built
  incrementally and corrected on first display of each page (acceptable: the
  common case is detected before the page is shown because of preloading).
- Spread offset: a renderer attribute (`spread-offset`, values `0 | 1`) that,
  when `1`, marks section 0 as `center`. Wired from a per-book view setting
  `spreadOffset: boolean` via `renderer.setAttribute` in the same effect that
  sets `spread` (FoliateViewer.tsx:601-606).

### 3. Settings UI

In the view-settings Layout panel, a fixed-layout-only section:
- Reading direction (LTR / RTL) — `SettingsSelect`, two options.
- Double-page spreads (existing `spreadMode` control if not already exposed
  for comics) and "Offset spreads by one page" — `SettingsSwitchRow`.
All persisted per book (`isGlobal: false` path).

### 4. AI Summary gating

`BookMenu.tsx` (~line 226): additionally require `!bookData?.isFixedLayout`
for the AI Summary submenu. `useBookDataStore().getBookData(sideBarBookKey)`
is already accessible in that component.

## Error handling

- ComicInfo.xml absent or malformed → LTR default, manual toggle still works.
- Image dimensions unavailable (decode error) → treat as normal single page.
- Toggling direction mid-book preserves the current section index (re-anchor
  by section, not by fraction, to avoid drift from spread re-pairing).

## Testing

- Unit (foliate or app-level): ComicInfo `Manga` parsing → `book.dir`;
  spread-offset attribute marks section 0 center; wide-image detection sets
  `center`.
- App unit: per-book `rtl` persistence round-trip via the view-settings save
  path; BookMenu hides AI Summary for `isFixedLayout`.
- Manual: RTL manga CBZ — tap right = next page; spreads render as pairs in
  the right order; offset toggle fixes a misaligned book.

## Out of scope

- Vertical (top-to-bottom) comic flow — covered by the webtoon-mode spec.
- Panel detection / guided view.
- Per-series (rather than per-book) direction memory.
