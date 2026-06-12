# Comic Navigation & Series Continuation — Design

**Date:** 2026-06-12
**Status:** Awaiting review
**Scope:** apps/readest-app

## Goal

Two navigation features for comics: (1) a **page-thumbnail grid** replacing
the useless text TOC for image books, and (2) **"Continue to next volume"**
when finishing a book that belongs to a series.

## What already exists (verified)

- Library series grouping is DONE: `createSeriesGroups()` groups by
  `book.metadata.series` sorted by `seriesIndex`
  (libraryUtils.ts:295-322, 199-200), populated at import from ComicInfo.xml /
  EPUB `belongsTo` (bookService.ts:346-353).
- CBZ TOC = one item per page with filename labels (useless for nav); the
  sidebar TOC tree renders it today.
- No per-page thumbnails exist; only book covers
  (bookService.ts `getCoverImageUrl`).
- Jump API: `view.renderer.goTo({ index })` navigates to a section (= page)
  directly (types/view.ts:37).
- CBZ sections expose `load()` returning a blob URL for the page image and
  `size` (comic-book.js:124-129) — thumbnails can be made from these.

## Decisions made

| Question | Decision |
|---|---|
| Grid surface | The sidebar's TOC tab swaps to a thumbnail grid for fixed-layout image books (CBZ; not PDF in v1). Same place users already look for navigation; no new tab. |
| Thumbnail generation | Lazy + on-device: an IntersectionObserver-driven grid; each visible cell calls `section.load()`, draws the image to a ~160px-wide canvas, stores the dataURL in an in-memory LRU (cap ~200 thumbs), and revokes the full-size blob URL immediately. No disk cache in v1. |
| Grid cell | Thumbnail + page number; current page highlighted; tap → `renderer.goTo({ index })` and (on mobile) close the sidebar. RTL books lay the grid out right-to-left to match reading order. |
| Next volume trigger | When relocation reaches the final page of a book whose `metadata.series` is set, the footer shows a dismissible "Next: <title>" pill (not a modal). Tapping opens the next volume (lowest `seriesIndex` greater than current, falling back to title sort) via the existing book-open path. |
| Next-volume lookup | A pure helper `findNextInSeries(library, book): Book | null` in libraryUtils, reusing `createSeriesGroups`'s comparator. |
| Reading-status tie-in | Opening the next volume marks the finished one `readingStatus: 'finished'` (existing field, book.ts:107) if progress is at 100%. |

## Architecture

1. **`PageThumbnailGrid.tsx`** (new, sidebar component): virtualized-enough
   grid (CSS grid + IntersectionObserver per cell; no new dependency).
   Receives `bookDoc.sections`, current section index, `rtl`, and an
   `onSelect(index)` callback. Thumbnail pipeline as decided above, isolated
   in a `useSectionThumbnail(section)` hook with the LRU at module scope per
   bookKey (cleared on unmount).
2. **Sidebar wiring:** in the TOC tab render path, branch on
   `bookData.isFixedLayout && book.format === 'CBZ'` → render the grid
   instead of the TOC tree.
3. **`findNextInSeries`** (libraryUtils): pure; unit-tested. Consumed by a
   small `NextVolumePill.tsx` rendered from the reader footer area, driven by
   a `progress.sectionIndex === lastIndex` check in the existing relocation
   handler.
4. **Open path:** the pill calls the same navigation used by the library to
   open a book (router push with book id), after saving current progress.

## Error handling

- Thumbnail decode failure → cell shows the page number on a neutral
  placeholder; tap still navigates.
- Series metadata missing/inconsistent (`seriesIndex` duplicated or absent) →
  fall back to natural title sort within the series group; if the current
  book is the last (or lookup fails), no pill is shown.
- Memory: LRU cap + immediate blob revocation keeps a 1000-page CBZ at
  ≤ ~200 small dataURLs.

## Testing

- Unit: `findNextInSeries` (ordered, gaps, duplicates, missing index, last
  volume); thumbnail LRU eviction; RTL grid order mapping.
- Component-free verification for the grid via lint + manual (consistent with
  sidebar precedent).
- Manual: 300-page CBZ — grid scrolls smoothly, jumps correctly, current page
  tracks; finishing vol. 1 of a series surfaces vol. 2 and opens it.

## Out of scope

- PDF thumbnails (pdf.js render-to-canvas is a different pipeline).
- Persistent thumbnail cache on disk.
- Series management UI (renaming/merging series).
- OPDS "next volume" across un-downloaded books.
