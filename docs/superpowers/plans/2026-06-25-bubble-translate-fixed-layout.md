# Bubble translation for fixed-layout EPUB/MOBI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both bubble-translation features (manual drag-region + auto whole-page OCR) light up on fixed-layout manga EPUB/MOBI/AZW, by generalizing the CBZ-only gate and the `<img>`-only page-image capture.

**Architecture:** A pure `isImagePageBook(format, isFixedLayout)` gate replaces the CBZ-only check in `MangaBubbleToggler`. A shared `findPageImage(doc)` resolves the page image whether it's an `<img>` or an `<svg><image>`; both translators and `captureRegionToBlob` consume it. Geometry math is unchanged.

**Tech Stack:** TypeScript/React, vitest + jsdom. No new deps.

**Context (verified):**
- Gate: `src/app/reader/components/MangaBubbleToggler.tsx` — `isComic = IMAGE_BOOK_FORMATS.has(book.format)` (`IMAGE_BOOK_FORMATS = {'CBZ'}` in `src/types/book.ts`; `FIXED_LAYOUT_FORMATS = {'PDF','CBZ'}`). `bookData.isFixedLayout` exists (true for pre-paginated EPUB/MOBI + CBZ + PDF).
- Capture: `MangaBubbleTranslator.onSelect` + `AutoBubblePageTranslator.onAutoTranslate` use `doc.querySelector('img')` → `img.naturalWidth/Height`, `img.getBoundingClientRect()`, then `captureRegionToBlob(img, crop)` (`src/utils/pageCapture.ts`) which `ctx.drawImage(img, ...)`.
- Geometry: `computeNaturalCropRect`/`mapImageBBoxToViewport` consume `imgRect` + `naturalWidth/Height` only — unchanged.
- Run from `apps/readest-app/`. Tests: `pnpm test -- <path>`. Branch `feat/bubble-translate-fixed-layout` exists.

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/book.ts` (modify) | `isImagePageBook(format, isFixedLayout)` pure gate helper. |
| `src/utils/pageImage.ts` (create) | `PageImage` type, `selectPageImageEl(doc)` (pure selection), `findPageImage(doc)` (async, resolves `<img>`/`<svg><image>` to a drawable source + rect + natural size). |
| `src/utils/pageCapture.ts` (modify) | `captureRegionToBlob` accepts `CanvasImageSource` (not just `HTMLImageElement`). |
| `src/app/reader/components/MangaBubbleToggler.tsx` (modify) | use `isImagePageBook`. |
| `src/app/reader/components/annotator/MangaBubbleTranslator.tsx` (modify) | use `findPageImage`. |
| `src/app/reader/components/annotator/AutoBubblePageTranslator.tsx` (modify) | use `findPageImage`. |
| `src/__tests__/utils/{book,pageImage}.test.ts` | unit tests. |

---

### Task 1: `isImagePageBook` gate helper

**Files:** Modify `src/utils/book.ts`; Test `src/__tests__/utils/book.test.ts` (add cases).

- [ ] **Step 1: Failing test**
```ts
import { isImagePageBook } from '@/utils/book';
it('gates image-page books, not text/PDF', () => {
  expect(isImagePageBook('CBZ', true)).toBe(true);
  expect(isImagePageBook('EPUB', true)).toBe(true);   // fixed-layout manga EPUB
  expect(isImagePageBook('MOBI', true)).toBe(true);   // fixed-layout manga MOBI/AZW
  expect(isImagePageBook('EPUB', false)).toBe(false); // reflowable
  expect(isImagePageBook('PDF', true)).toBe(false);   // has text layer
});
```
- [ ] **Step 2: Run → fail.** `pnpm test -- src/__tests__/utils/book.test.ts`
- [ ] **Step 3: Implement** in `book.ts`:
```ts
import { BookFormat, IMAGE_BOOK_FORMATS } from '@/types/book';
/** True for image-page books: CBZ, or any fixed-layout (pre-paginated) book except PDF. */
export const isImagePageBook = (format: BookFormat, isFixedLayout: boolean): boolean =>
  IMAGE_BOOK_FORMATS.has(format) || (isFixedLayout && format !== 'PDF');
```
- [ ] **Step 4: Run → pass.** **Step 5: Commit** `feat(ocr): isImagePageBook gate helper`.

### Task 2: `findPageImage` — page-image resolution

**Files:** Create `src/utils/pageImage.ts`, `src/__tests__/utils/pageImage.test.ts`.

- [ ] **Step 1: Failing test** (pure selection + href; jsdom doesn't load images, so test element selection, not naturalWidth):
```ts
import { selectPageImageEl } from '@/utils/pageImage';
it('prefers <img>, falls back to <svg><image> href', () => {
  const d = new DOMParser().parseFromString('<html><body><img src="blob:x"></body></html>', 'text/html');
  expect(selectPageImageEl(d)?.kind).toBe('img');
  const s = new DOMParser().parseFromString(
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="blob:y"/></svg>', 'image/svg+xml');
  const sel = selectPageImageEl(s);
  expect(sel?.kind).toBe('svg');
  expect(sel?.href).toBe('blob:y');
});
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `pageImage.ts`:
```ts
export interface PageImage { source: CanvasImageSource; rect: DOMRect; naturalWidth: number; naturalHeight: number }
type Sel = { kind: 'img'; el: HTMLImageElement } | { kind: 'svg'; el: Element; href: string };

/** Pure: locate the page-image element (<img>, else <svg><image>). */
export const selectPageImageEl = (doc: Document): Sel | null => {
  const img = doc.querySelector('img') as HTMLImageElement | null;
  if (img) return { kind: 'img', el: img };
  const im = doc.querySelector('image'); // SVG <image>
  if (im) {
    const href = im.getAttribute('href') || im.getAttribute('xlink:href')
      || (im as unknown as SVGImageElement).href?.baseVal || '';
    if (href) return { kind: 'svg', el: im, href };
  }
  return null;
};

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i);
    i.onerror = reject; i.src = src; });

/** Resolve the page image to a drawable source + geometry. Async (may load the SVG href). */
export const findPageImage = async (doc: Document): Promise<PageImage | null> => {
  const sel = selectPageImageEl(doc);
  if (!sel) return null;
  if (sel.kind === 'img') {
    const img = sel.el;
    return { source: img, rect: img.getBoundingClientRect(),
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
  }
  const loaded = await loadImage(sel.href); // blob: URL → same-origin, untainted
  return { source: loaded, rect: sel.el.getBoundingClientRect(),
    naturalWidth: loaded.naturalWidth, naturalHeight: loaded.naturalHeight };
};
```
- [ ] **Step 4: Run → pass.** **Step 5: Commit** `feat(ocr): findPageImage (img + svg-image embeddings)`.

### Task 3: `captureRegionToBlob` accepts `CanvasImageSource`

**Files:** Modify `src/utils/pageCapture.ts`.

- [ ] **Step 1:** Change the signature `captureRegionToBlob(img: HTMLImageElement, ...)` → `captureRegionToBlob(source: CanvasImageSource, ...)`; `ctx.drawImage(source, ...)` already accepts `CanvasImageSource`. No behavior change for the `<img>` path. (Existing `computeNaturalCropRect` etc. unchanged — they take rects/sizes, not the element.)
- [ ] **Step 2:** `pnpm test -- src/__tests__/utils/pageCapture` (if any) + `pnpm lint` clean.
- [ ] **Step 3: Commit** `refactor(ocr): captureRegionToBlob takes CanvasImageSource`.

### Task 4: Toggler gate → `isImagePageBook`

**Files:** Modify `MangaBubbleToggler.tsx`.

- [ ] **Step 1:** Replace `const isComic = !!bookData?.book && IMAGE_BOOK_FORMATS.has(bookData.book.format);` with `const isImagePage = !!bookData?.book && isImagePageBook(bookData.book.format, !!bookData.isFixedLayout);` and the `if (!isComic) return null;` guard accordingly. Update imports (drop `IMAGE_BOOK_FORMATS`, add `isImagePageBook`).
- [ ] **Step 2:** `pnpm lint` clean; existing toggler behavior for CBZ unchanged.
- [ ] **Step 3: Commit** `feat(ocr): show bubble-translate on fixed-layout EPUB/MOBI`.

### Task 5: Manual translator uses `findPageImage`

**Files:** Modify `MangaBubbleTranslator.tsx`.

- [ ] **Step 1:** In `onSelect`, replace `const img = doc?.querySelector('img')...; if (!img || !iframe) return;` + the `img.naturalWidth/Height` + `img.getBoundingClientRect()` usage with `const pageImg = await findPageImage(doc); if (!pageImg || !iframe) return;` then use `pageImg.rect` (as `imgRect`), `pageImg.naturalWidth/Height`, and `captureRegionToBlob(pageImg.source, crop)`. Keep the primary-content selection + iframe/transform geometry exactly as-is.
- [ ] **Step 2:** `pnpm lint` + the existing OCR tests pass.
- [ ] **Step 3: Commit** `feat(ocr): manual bubble translate via findPageImage`.

### Task 6: Auto translator uses `findPageImage`

**Files:** Modify `AutoBubblePageTranslator.tsx`.

- [ ] **Step 1:** In `onAutoTranslate`, replace `const img = doc?.querySelector('img')...` + `img.naturalWidth/Height` + `imgRect` + `captureRegionToBlob(img, ...)` with `findPageImage(doc)` → `pageImg.{source,rect,naturalWidth,naturalHeight}`. The full-page crop uses `pageImg.naturalWidth/Height`; `captureRegionToBlob(pageImg.source, crop)`. Geometry/markers unchanged. (Optionally swap the BooksGrid `isComic`-adjacent gate to `isImagePageBook` for consistency, but it's already android+flag gated.)
- [ ] **Step 2:** `pnpm exec vitest run src/__tests__/services/ocr/` + `pnpm lint` clean.
- [ ] **Step 3: Commit** `feat(ocr): auto bubble translate via findPageImage`.

### Task 7: Fixed-layout EPUB fixture + on-device gate

**Files:** `src/__tests__/fixtures/` builder for a minimal fixed-layout manga EPUB (one `<img>`-page variant + one `<svg><image>`-page variant, each a rendered-text "bubble" image like the CBZ fixtures).

- [ ] **Step 1:** Build the fixed-layout EPUB fixture(s): OPF with `<meta property="rendition:layout">pre-paginated</meta>`, XHTML pages embedding a generated JP-text image via `<img>` (variant A) and `<svg><image>` (variant B).
- [ ] **Step 2:** Push to the emulator, import, open. Verify: the **Translate Region + ✨ buttons now appear** (gate), and BOTH features work — drag a region → popup; tap ✨ → markers + translation — for the `<img>` page AND the `<svg><image>` page. This resolves the real-embedding spike; if a variant fails (e.g., tainted canvas or a missed embedding), fix `findPageImage`/`captureRegionToBlob` and note it.
- [ ] **Step 3:** Capture screenshots. Commit any fix + the fixture.

## Final verification
- `pnpm test` (no new failures beyond the known `document.test.ts`), `pnpm lint`, `pnpm check:translations` (no new strings expected). On-device gate passed for both embeddings.

## Self-review
- Spec coverage: gate (T1,T4), capture generalization (T2,T3,T5,T6), testing (T1,T2,T7) — all mapped.
- Type consistency: `PageImage`/`CanvasImageSource` flows T2→T3→T5/T6 consistently; `isImagePageBook(format, isFixedLayout)` signature identical in T1/T4.
- Known spike (not a placeholder): real fixed-layout embeddings — produced by T7's fixtures (img + svg-image), the two documented foliate cases; a 3rd real-world embedding would be a fast-follow.
