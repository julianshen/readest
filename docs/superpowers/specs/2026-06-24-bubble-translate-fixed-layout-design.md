# Bubble translation for fixed-layout EPUB/MOBI (design)

**Goal:** Extend both bubble-translation features — manual drag-region (`MangaBubbleTranslator`, vision-AI) and whole-page auto OCR (`AutoBubblePageTranslator`) — from **CBZ-only** to **fixed-layout (image-page) manga in EPUB and MOBI/AZW**, so manga distributed in those containers gets the same treatment as CBZ.

**Scope:** fixed-layout (pre-paginated) EPUB + image-based MOBI/AZW/AZW3, plus the existing CBZ. **Out of scope:** PDF (has a selectable text layer → separate path), reflowable EPUB/MOBI with embedded images (the niche "drag a panel in a text book" case the user declined), and any new OCR languages.

## Background (verified)

- The gate is `MangaBubbleToggler.tsx`: `isComic = IMAGE_BOOK_FORMATS.has(book.format)` where `IMAGE_BOOK_FORMATS = {'CBZ'}`. It controls visibility of BOTH header buttons (Translate Region + the ✨ Auto-translate). The translators themselves mount unconditionally and act on dispatched events, so changing this one gate enables both features.
- foliate sets `bookDoc.rendition.layout === 'pre-paginated'` for fixed-layout EPUB **and** fixed-layout MOBI/AZW (`mobi.js:1060`, driven by the `fixedLayout` EXTH flag). The app already surfaces this as `bookData.isFixedLayout`.
- Both features locate the page image with `doc.querySelector('img')` and use `img.naturalWidth/Height` + `img.getBoundingClientRect()` for geometry, then `captureRegionToBlob(img, crop)` draws the `<img>` to a canvas.
- **Risk:** fixed-layout EPUB/MOBI manga commonly embed the page as `<svg><image href>` (foliate's `fixed-layout.js` explicitly handles SVG-root pages) or a raw image-in-spine — neither is an `<img>`, so the current `querySelector('img')` misses them.

## Design

### 1. Gate (book-level)
Replace the CBZ-only `isComic` with an `isImagePageBook(bookData)` helper (in `utils/book.ts` or alongside the format sets in `types/book.ts`):

```ts
// CBZ, or a fixed-layout (pre-paginated) EPUB / MOBI-family book — i.e. a book
// whose pages are images. Excludes PDF (text layer) and reflowable books.
isImagePageBook(bookData) =
  IMAGE_BOOK_FORMATS.has(format)                              // CBZ
  || (bookData.isFixedLayout && format in {EPUB, MOBI, AZW3}) // image-page EPUB/MOBI/AZW
```

`MangaBubbleToggler` uses `isImagePageBook(bookData)` instead of `isComic`. (The `AutoBubblePageTranslator` mount in `BooksGrid` stays gated on `MANGA_AUTO_TRANSLATE_ENABLED && android`; it doesn't need the format check because it only runs when its event fires, which only the gated toggler dispatches — but for cleanliness it may also adopt the helper.)

### 2. Page-image capture (the main work)
Introduce a shared utility `findPageImage(doc: Document): PageImage | null` that returns whatever's needed to capture + geometry-map the page image, regardless of embedding:

```ts
interface PageImage {
  source: CanvasImageSource;   // drawable: the <img>, or an Image loaded from the <svg><image> href
  rect: DOMRect;               // rendered rect in iframe-local coords (for geometry)
  naturalWidth: number;
  naturalHeight: number;
}
```
- `<img>` → `{ source: img, rect: img.getBoundingClientRect(), naturalWidth: img.naturalWidth, ... }` (today's behavior).
- `<svg><image>` (or an SVG-root document) → find the `<image>`; resolve its `href`/`xlink:href` to an off-DOM `HTMLImageElement` (await load) for `source` + natural size; `rect` from the `<image>`/`<svg>` element's `getBoundingClientRect()`.

Both `MangaBubbleTranslator.onSelect` and `AutoBubblePageTranslator.onAutoTranslate` switch from the inline `querySelector('img')` + `img.naturalWidth` to `findPageImage(doc)`, and `captureRegionToBlob` takes the `source` (a `CanvasImageSource`) instead of an `HTMLImageElement`. Geometry math (`computeNaturalCropRect`, `mapImageBBoxToViewport`, the iframe rect + CSS-transform scale) is unchanged — it already consumes `rect` + `naturalWidth/Height`.

### 3. Testing
- **Unit:** `isImagePageBook` truth table (CBZ→true; fixed-layout EPUB/MOBI/AZW→true; reflowable EPUB→false; PDF→false; fixed-layout PDF→false). The pure parts of `findPageImage` where testable (href resolution, element selection) with a jsdom fixture.
- **Fixtures:** a minimal fixed-layout manga EPUB with both an `<img>`-page variant and an `<svg><image>`-page variant (committed), to drive `findPageImage`.
- **On-device gate:** open a real fixed-layout manga EPUB (and an AZW/MOBI if available) on the emulator → the Translate Region + ✨ buttons appear → drag-region and whole-page both detect/translate, same as the CBZ gate.

## Risks / unknowns (resolved early in the plan)
1. **Exact embedding of real manga EPUB/MOBI pages** — `<img>` vs `<svg><image>` vs image-in-spine; how foliate exposes each in the content `doc`. Spike against real/sample fixed-layout books first; `findPageImage` covers the observed cases.
2. **Canvas tainting** — the page image is from the book's own blob (same-origin), so `captureRegionToBlob` should stay untainted as it does for CBZ; verify for the SVG-image path (the loaded `Image` must come from the same blob URL, not a cross-origin fetch).
3. **MOBI/AZW fixed-layout** detection actually yielding `isFixedLayout` for real Kindle manga (the EXTH flag) — verify with a sample; fall back to image-page heuristics if a real file doesn't set it.
