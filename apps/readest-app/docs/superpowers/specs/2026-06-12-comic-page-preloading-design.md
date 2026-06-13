# Comic Page Preloading Tuning — Design

**Date:** 2026-06-12
**Status:** Awaiting review
**Scope:** packages/foliate-js (vendored) + apps/readest-app (settings wiring)

## Goal

Instant page turns for comics. Foliate's fixed-layout renderer ALREADY
preloads (verified): `forwardPreloadCount = 1`, `backwardPreloadCount = 0`,
`#maxCachedSpreads = 2`, concurrency 1 (fixed-layout.js:108, 991-1076), and
scrolled mode loads on demand with a 50% rootMargin observer. This spec tunes
and exposes that machinery rather than building new machinery.

## Decisions made

| Question | Decision |
|---|---|
| Defaults for comics | Forward 3 spreads, backward 1, cache 8 spreads, concurrency 2. Applied only to comic/fixed-layout image books (pre-paginated with image sections), not PDF (PDF pages render via pdf.js with its own costs). |
| Memory guard | Cache eviction stays LRU but becomes byte-aware: track each cached spread's image byte size (`section.size` is already exposed by comic-book.js) and cap the cache at 128 MB OR 8 spreads, whichever is hit first. On Android, halve the byte cap. |
| Configurability | Renderer attributes `preload-ahead`, `preload-behind`, `cache-spreads` (the byte cap stays internal). FoliateViewer sets them for CBZ; no user-facing setting in v1. |
| Scrolled mode | Covered by the webtoon spec's `scroll-lookahead` rootMargin attribute; this spec does not duplicate it. |

## Architecture

1. **fixed-layout.js:** replace the hard-coded counts with
   attribute-backed fields (same `attributeChangedCallback` pattern the
   `zoom`/`spread` attributes use, lines 194-217); add byte accounting to
   `#prerenderedSpreads` insert/evict using section sizes; bump default
   concurrency to 2.
2. **FoliateViewer.tsx** (fixed-layout settings effect, ~601-606): when the
   book format is CBZ, set `preload-ahead='3'`, `preload-behind='1'`,
   `cache-spreads='8'`.
3. **Platform cap:** pass the byte cap via one more attribute
   (`cache-bytes`), set from `appService.isAndroidApp ? 64 : 128` MB.

## Error handling

- A failed image decode during preload must not break navigation: preload
  errors are swallowed (current behavior) and the page loads normally on
  display.
- Eviction never evicts the currently-displayed spread or its immediate
  neighbors.

## Testing

- foliate browser test: attributes change the counts; byte cap evicts oldest
  spreads first and never the current spread; turning pages rapidly never
  shows an unloaded frame for preloaded spreads.
- Manual: a 200 MB CBZ on Android — page turns feel instant; memory stays
  bounded (no WebView OOM).

## Out of scope

- Decode-ahead into ImageBitmap/GPU textures.
- Adaptive counts based on measured turn latency.
- User-facing preload settings.
