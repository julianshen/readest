# Manga Reading Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct manga (CBZ) reading: auto right-to-left page direction from ComicInfo.xml with a per-book manual toggle, mirrored tap zones, wide-image double-page spreads rendered standalone, and the text-only AI Summary menu hidden for image-only books.

**Architecture:** ComicInfo's `Manga` element sets `book.dir = 'rtl'` in vendored foliate-js (`comic-book.js`); the existing `book.dir → fixed-layout RTL spread mirroring` and `writingMode → per-book persistence + viewer recreation` machinery do the rest. Wide pages are detected at image load in `comic-book.js` and trigger a deferred re-spread in `fixed-layout.js`. App-side changes are thin: a direction-derivation helper for tap zones, a two-option Reading Direction select in the Layout settings panel, and a gating condition in the sidebar BookMenu.

**Tech Stack:** TypeScript/React (apps/readest-app), vanilla JS (packages/foliate-js — a **git submodule**, see Task 0), vitest + jsdom, i18next-scanner.

**Spec:** `apps/readest-app/docs/superpowers/specs/2026-06-12-manga-reading-mode-design.md`

---

## Deviations from the spec (verified against the code, simpler than planned)

1. **Spread offset toggle — NO new code.** The spec proposed a new `spread-offset` renderer attribute. Verified: `ViewMenu.tsx:62-63,162-181` already exposes both `spreadMode` (auto/none) and `keepCoverSpread` per book for pre-paginated books. `keepCoverSpread=true` (the default) renders page 0 standalone, shifting all pairings by one; `false` pairs the cover with page 1. Both pairings are reachable, which is exactly the offset fix. **Do not build the attribute.**
2. **Per-book direction persistence — reuse `writingMode`.** The spec proposed persisting a new `rtl` setting. Verified: `viewSettings.writingMode` (`'auto' | 'horizontal-tb' | 'horizontal-rl' | 'vertical-rl'`) is already persisted per book (`saveViewSettings(..., skipGlobal=true)` at `LayoutPanel.tsx:299`), already drives `bookDoc.dir` at open (`FoliateViewer.tsx:512-522`), and already triggers viewer recreation when a writingMode change enters or leaves a `*-rl` mode (`LayoutPanel.tsx:305-311`). That existing recreate path does **not** cover `auto → horizontal-tb` for fixed-layout books — Task 4 closes that gap. The Reading Direction toggle writes `writingMode = 'horizontal-tb' | 'horizontal-rl'`. No new ViewSettings field.

## Key existing code (read these before each task)

| What | Where |
| --- | --- |
| CBZ parsing, ComicInfo.xml reader | `packages/foliate-js/comic-book.js` (140 lines, whole file) |
| Spread assembly honoring `pageSpread`/`rtl` | `packages/foliate-js/fixed-layout.js:828-897` (`open`, `#spread`, `#respread`) |
| `book.dir` → renderer RTL | `packages/foliate-js/fixed-layout.js:831` |
| writingMode → `bookDoc.dir` at open | `apps/readest-app/src/app/reader/components/FoliateViewer.tsx:512-528` |
| `viewSettings.rtl`/`vertical` derivation on doc load | `apps/readest-app/src/app/reader/components/FoliateViewer.tsx:237-248` |
| Tap-zone inversion using `viewSettings.rtl` | `apps/readest-app/src/app/reader/hooks/usePagination.ts:129-131` |
| writingMode UI + save + recreate | `apps/readest-app/src/components/settings/LayoutPanel.tsx:290-314,450-490` |
| AI Summary menu | `apps/readest-app/src/app/reader/components/sidebar/BookMenu.tsx:190-194,226-233` |
| CBZ fixture builder for tests | `apps/readest-app/src/__tests__/document/series-metadata.test.ts:31-56` |
| Component-test store-mock pattern | `apps/readest-app/src/__tests__/components/ProgressBar.test.tsx` |

All `pnpm` commands below run from `apps/readest-app/`.

---

### Task 0: Branch + foliate-js submodule setup

`packages/foliate-js` is a **git submodule** pointing at `https://github.com/readest/foliate-js.git` (no push access). Tasks 1 and 3 modify it. Work happens on a branch inside the submodule; it is pushed to a fork and the superproject gitlink + `.gitmodules` URL are updated in Task 7.

- [ ] **Step 1: Create the app branch**

```bash
cd /home/julianshen/projects/readest
git checkout main && git pull
git checkout -b feat/manga-reading-mode
```

(If executing in a worktree instead, use `pnpm worktree:new feat/manga-reading-mode` from the repo root — never bare `git worktree add`.)

- [ ] **Step 2: Fork foliate-js and branch the submodule**

```bash
gh repo fork readest/foliate-js --clone=false
cd packages/foliate-js
git remote add fork https://github.com/julianshen/foliate-js.git 2>/dev/null || true
git checkout -b feat/manga-reading-mode
cd ../..
```

Expected: `gh repo view julianshen/foliate-js --json name` succeeds; `git -C packages/foliate-js branch --show-current` prints `feat/manga-reading-mode`.

---

### Task 1: ComicInfo.xml `Manga` element → `book.dir = 'rtl'`

**Files:**
- Create: `apps/readest-app/src/__tests__/fixtures/cbz.ts`
- Create: `apps/readest-app/src/__tests__/document/comic-manga-rtl.test.ts`
- Modify: `apps/readest-app/src/__tests__/document/series-metadata.test.ts:31-56` (use shared fixture helper)
- Modify: `packages/foliate-js/comic-book.js` (in the submodule)

- [ ] **Step 1: Extract the CBZ fixture builder into a shared module**

Create `apps/readest-app/src/__tests__/fixtures/cbz.ts` with the `makeCbzFixture` function moved verbatim from `series-metadata.test.ts:31-56`, exported:

```ts
export const makeCbzFixture = async ({
  comicInfo,
  comicInfoPath = 'ComicInfo.xml',
  imageCount,
}: {
  comicInfo?: string;
  comicInfoPath?: string;
  imageCount: number;
}): Promise<File> => {
  const { BlobWriter, TextReader, ZipWriter } = await import('@zip.js/zip.js');
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  for (let i = 0; i < imageCount; i++) {
    await writer.add(`${i}.png`, new TextReader(`image-${i}`));
  }
  if (comicInfo) {
    await writer.add(comicInfoPath, new TextReader(comicInfo));
  }
  const blob = await writer.close();
  // zip.js yields a Blob from another realm (Node's); jsdom's File constructor
  // doesn't recognize it as a BlobPart and stringifies it to "[object Blob]".
  // Hand over raw bytes instead so the File holds the actual archive.
  return new File([await blob.arrayBuffer()], 'fixture.cbz', {
    type: 'application/vnd.comicbook+zip',
  });
};
```

In `series-metadata.test.ts`, delete the local `makeCbzFixture` (lines 31-56) and add `import { makeCbzFixture } from '../fixtures/cbz';`.

- [ ] **Step 2: Verify the refactor didn't break the series test**

Run: `pnpm test -- src/__tests__/document/series-metadata.test.ts`
Expected: PASS (all existing tests green).

- [ ] **Step 3: Write the failing test**

Create `apps/readest-app/src/__tests__/document/comic-manga-rtl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { DocumentLoader } from '@/libs/document';
import { makeCbzFixture } from '../fixtures/cbz';

const openCbz = async (comicInfo?: string) => {
  const file = await makeCbzFixture({ comicInfo, imageCount: 3 });
  const result = await new DocumentLoader(file).open();
  expect(result.format).toBe('CBZ');
  return result.book;
};

describe('ComicInfo.xml Manga element sets book.dir', () => {
  it('sets dir to rtl for Manga=YesAndRightToLeft', async () => {
    const book = await openCbz(
      '<?xml version="1.0"?><ComicInfo><Title>T</Title><Manga>YesAndRightToLeft</Manga></ComicInfo>',
    );
    expect(book.dir).toBe('rtl');
  });

  it('leaves dir unset for Manga=Yes (manga, but not right-to-left)', async () => {
    const book = await openCbz(
      '<?xml version="1.0"?><ComicInfo><Title>T</Title><Manga>Yes</Manga></ComicInfo>',
    );
    expect(book.dir).toBeUndefined();
  });

  it('leaves dir unset when ComicInfo.xml is absent', async () => {
    const book = await openCbz();
    expect(book.dir).toBeUndefined();
  });

  it('leaves dir unset when ComicInfo.xml is malformed', async () => {
    const book = await openCbz('<ComicInfo><Manga>YesAndRightToLeft');
    expect(book.dir).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test -- src/__tests__/document/comic-manga-rtl.test.ts`
Expected: FAIL — `expect(book.dir).toBe('rtl')` receives `undefined` (the other three may already pass; that's fine).

- [ ] **Step 5: Implement in comic-book.js**

In `packages/foliate-js/comic-book.js`, inside `readComicInfoXML`, add an `rtl` field to the returned object (after `seriesTotal: get('Count'),`):

```js
        seriesTotal: get('Count'),
        rtl: get('Manga')?.toLowerCase() === 'yesandrighttoleft' || undefined,
```

In `makeComicBook`, after the `book.metadata = { ... }` assignment block (currently ending around line 116), add:

```js
    if (merged.rtl) book.dir = 'rtl'
```

(`merged` already spreads ComicBookInfo under ComicInfo, and the malformed-XML path returns `null` from `readComicInfoXML`, so the LTR default falls out for free.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test -- src/__tests__/document/comic-manga-rtl.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 7: Commit (submodule first, then app)**

```bash
cd /home/julianshen/projects/readest/packages/foliate-js
git add comic-book.js
git commit -m "feat(comic-book): parse ComicInfo Manga element into book.dir for RTL manga"
cd /home/julianshen/projects/readest
git add apps/readest-app/src/__tests__/fixtures/cbz.ts \
        apps/readest-app/src/__tests__/document/comic-manga-rtl.test.ts \
        apps/readest-app/src/__tests__/document/series-metadata.test.ts
git commit -m "test: cover ComicInfo Manga RTL parsing; share CBZ fixture builder"
```

Note: do NOT `git add packages/foliate-js` (the gitlink) yet — that happens once in Task 7.

---

### Task 2: Derive `viewSettings.rtl` from `book.dir` for fixed-layout books (tap zones)

Tap zones already invert when `viewSettings.rtl` is true (`usePagination.ts:129-131`), but for CBZ the derivation in `FoliateViewer.tsx:237-243` never sees `book.dir`. Extract the derivation into a pure helper, add the fixed-layout term, wire it back.

**Files:**
- Create: `apps/readest-app/src/__tests__/utils/derive-doc-direction.test.ts`
- Modify: `apps/readest-app/src/utils/book.ts` (add helper next to `getBookDirFromWritingMode`, line ~231)
- Modify: `apps/readest-app/src/app/reader/components/FoliateViewer.tsx:237-243`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/utils/derive-doc-direction.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { deriveDocDirection } from '@/utils/book';

describe('deriveDocDirection', () => {
  const base = {
    writingDir: undefined,
    uiRtl: false,
    writingMode: 'auto' as const,
    isFixedLayout: false,
    bookDir: undefined,
  };

  it('defaults to horizontal ltr', () => {
    expect(deriveDocDirection(base)).toEqual({ vertical: false, rtl: false });
  });

  it('uses the document writing direction when present', () => {
    expect(deriveDocDirection({ ...base, writingDir: { vertical: true, rtl: true } })).toEqual({
      vertical: true,
      rtl: true,
    });
  });

  it('derives rtl from writingMode horizontal-rl', () => {
    expect(deriveDocDirection({ ...base, writingMode: 'horizontal-rl' }).rtl).toBe(true);
  });

  it('derives vertical and rtl from writingMode vertical-rl', () => {
    expect(deriveDocDirection({ ...base, writingMode: 'vertical-rl' })).toEqual({
      vertical: true,
      rtl: true,
    });
  });

  it('derives rtl from book.dir for fixed-layout books (RTL manga)', () => {
    expect(deriveDocDirection({ ...base, isFixedLayout: true, bookDir: 'rtl' }).rtl).toBe(true);
  });

  it('ignores book.dir for reflowable books', () => {
    expect(deriveDocDirection({ ...base, bookDir: 'rtl' }).rtl).toBe(false);
  });

  it('derives rtl from an RTL UI language', () => {
    expect(deriveDocDirection({ ...base, uiRtl: true }).rtl).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/__tests__/utils/derive-doc-direction.test.ts`
Expected: FAIL — `deriveDocDirection` is not exported from `@/utils/book`.

- [ ] **Step 3: Implement the helper**

In `apps/readest-app/src/utils/book.ts`, after `getBookDirFromLanguage` (~line 246), add:

```ts
// Derives the per-document vertical/rtl flags used by pagination tap zones.
// Mirrors the historical inline logic in FoliateViewer.docLoadHandler, plus
// the fixed-layout term: comic pages carry no text direction, so RTL manga
// (book.dir set from ComicInfo.xml or the reading-direction setting) must
// flow through book.dir.
export const deriveDocDirection = ({
  writingDir,
  uiRtl,
  writingMode,
  isFixedLayout,
  bookDir,
}: {
  writingDir: { vertical: boolean; rtl: boolean } | undefined;
  uiRtl: boolean;
  writingMode: WritingMode;
  isFixedLayout: boolean;
  bookDir: string | undefined;
}): { vertical: boolean; rtl: boolean } => ({
  vertical: writingDir?.vertical || writingMode.includes('vertical') || false,
  rtl:
    writingDir?.rtl ||
    uiRtl ||
    writingMode.includes('rl') ||
    (isFixedLayout && bookDir === 'rtl') ||
    false,
});
```

(`WritingMode` is already imported in `book.ts` for `getBookDirFromWritingMode`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- src/__tests__/utils/derive-doc-direction.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Wire into FoliateViewer**

In `apps/readest-app/src/app/reader/components/FoliateViewer.tsx`, replace lines 237-243:

```ts
      const newVertical =
        writingDir?.vertical || viewSettings.writingMode.includes('vertical') || false;
      const newRtl =
        writingDir?.rtl ||
        getDirFromUILanguage() === 'rtl' ||
        viewSettings.writingMode.includes('rl') ||
        false;
```

with:

```ts
      const { vertical: newVertical, rtl: newRtl } = deriveDocDirection({
        writingDir: writingDir || undefined,
        uiRtl: getDirFromUILanguage() === 'rtl',
        writingMode: viewSettings.writingMode,
        isFixedLayout: !!bookData?.isFixedLayout,
        bookDir: bookDoc.dir,
      });
```

Update the import at line 45 to include the helper:

```ts
import { deriveDocDirection, getBookDirFromLanguage, getBookDirFromWritingMode } from '@/utils/book';
```

- [ ] **Step 6: Run full checks**

Run: `pnpm test -- src/__tests__/utils/derive-doc-direction.test.ts && pnpm lint`
Expected: tests PASS, lint exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/utils/book.ts \
        apps/readest-app/src/app/reader/components/FoliateViewer.tsx \
        apps/readest-app/src/__tests__/utils/derive-doc-direction.test.ts
git commit -m "feat(reader): mirror tap zones for RTL fixed-layout books via book.dir"
```

---

### Task 3: Wide-image spread detection + deferred re-spread

Wide pages (width ≥ height) are double-page spreads scanned as one image; they must render alone and centered. `fixed-layout.js`'s spread assembly already honors `section.pageSpread === 'center'` (lines 853-856) — but dimensions are only known after image load, after the spread map is built. So: `comic-book.js` probes dimensions inside `load()` and fires a hint; `fixed-layout.js` re-spreads (re-anchored by section, per the spec's error-handling note) when a hinted section is currently paired.

**Files:**
- Create: `apps/readest-app/src/__tests__/document/comic-spread-detection.test.ts`
- Modify: `packages/foliate-js/comic-book.js` (submodule)
- Modify: `packages/foliate-js/fixed-layout.js` (submodule)

- [ ] **Step 1: Write the failing tests**

Create `apps/readest-app/src/__tests__/document/comic-spread-detection.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeComicBook } from 'foliate-js/comic-book.js';
import { sectionNeedsRespread } from 'foliate-js/fixed-layout.js';

type Dimensions = { width: number; height: number };

// jsdom has no URL.createObjectURL / createImageBitmap; stub both. The image
// "blobs" carry their entry name as text so the bitmap stub can map name → size.
const stubImageDecoding = (images: Record<string, Dimensions>) => {
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const name = await blob.text();
    const dims = images[name];
    if (!dims) throw new Error('decode failure');
    return { ...dims, close: vi.fn() };
  });
};

const openComic = async (images: Record<string, Dimensions | null>) => {
  const names = Object.keys(images);
  const entries = names.map((filename) => ({ filename }));
  const loadBlob = async (name: string) => new Blob([name], { type: 'image/png' });
  stubImageDecoding(
    Object.fromEntries(
      Object.entries(images).filter(([, dims]) => dims !== null),
    ) as Record<string, Dimensions>,
  );
  return makeComicBook(
    { entries, loadBlob, getSize: () => 0, getComment: async () => '' },
    new File([], 'fixture.cbz'),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('comic-book wide-image spread detection', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => {};
  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('marks a wide page center and fires the spread hint', async () => {
    const book = await openComic({
      '0.png': { width: 800, height: 1200 },
      '1.png': { width: 2000, height: 1400 },
    });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await book.sections[1].load();
    expect(book.sections[1].pageSpread).toBe('center');
    expect(hint).toHaveBeenCalledWith(book.sections[1]);
  });

  it('leaves tall pages unmarked and fires no hint', async () => {
    const book = await openComic({ '0.png': { width: 800, height: 1200 } });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await book.sections[0].load();
    expect(book.sections[0].pageSpread).toBeUndefined();
    expect(hint).not.toHaveBeenCalled();
  });

  it('treats decode failures as normal single pages', async () => {
    const book = await openComic({ '0.png': null });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await expect(book.sections[0].load()).resolves.toBeTruthy();
    expect(book.sections[0].pageSpread).toBeUndefined();
    expect(hint).not.toHaveBeenCalled();
  });

  it('still loads when createImageBitmap is unavailable', async () => {
    const book = await openComic({ '0.png': { width: 2000, height: 1000 } });
    vi.unstubAllGlobals(); // remove createImageBitmap
    await expect(book.sections[0].load()).resolves.toBeTruthy();
    expect(book.sections[0].pageSpread).toBeUndefined();
  });

  it('fires the hint at most once per section', async () => {
    const book = await openComic({ '0.png': { width: 2000, height: 1000 } });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await book.sections[0].load();
    await book.sections[0].load();
    expect(hint).toHaveBeenCalledTimes(1);
  });
});

describe('sectionNeedsRespread', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };

  it('returns true when the section is currently paired left/right', () => {
    expect(sectionNeedsRespread([{ right: a }, { left: b, right: c }], b)).toBe(true);
    expect(sectionNeedsRespread([{ right: a }, { left: b, right: c }], c)).toBe(true);
  });

  it('returns false when the section is already centered', () => {
    expect(sectionNeedsRespread([{ center: a }, { left: b, right: c }], a)).toBe(false);
  });

  it('returns false when the section is not in the map or the map is missing', () => {
    expect(sectionNeedsRespread([{ right: a }], b)).toBe(false);
    expect(sectionNeedsRespread(undefined, a)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/__tests__/document/comic-spread-detection.test.ts`
Expected: FAIL — `sectionNeedsRespread` is not exported, and `pageSpread` stays `undefined` for the wide page.

- [ ] **Step 3: Implement detection in comic-book.js**

In `packages/foliate-js/comic-book.js`, inside `makeComicBook`, restructure as follows.

Above the `load` function (after `const urls = new Map()`), add:

```js
    const sectionsByName = new Map()
    const probedSpreads = new Set()
    // An image at least as wide as it is tall is a scanned double-page spread:
    // mark it `center` so the spread assembly renders it alone. Dimensions are
    // only knowable by decoding, so this runs lazily on first load and notifies
    // the renderer through book.onSectionSpreadHint.
    const probeSpread = async (name, blob) => {
        if (probedSpreads.has(name)) return
        probedSpreads.add(name)
        if (typeof createImageBitmap !== 'function') return
        const section = sectionsByName.get(name)
        if (!section || section.pageSpread === 'center') return
        try {
            const bitmap = await createImageBitmap(blob)
            const wide = bitmap.width >= bitmap.height
            bitmap.close?.()
            if (wide) {
                section.pageSpread = 'center'
                book.onSectionSpreadHint?.(section)
            }
        } catch {
            // decode failure → treat as a normal single page
        }
    }
```

Change the start of `load` from:

```js
    const load = async name => {
        if (cache.has(name)) return cache.get(name)
        const src = URL.createObjectURL(await loadBlob(name))
```

to:

```js
    const load = async name => {
        if (cache.has(name)) return cache.get(name)
        const blob = await loadBlob(name)
        await probeSpread(name, blob)
        const src = URL.createObjectURL(blob)
```

Change the `book.sections` assignment from:

```js
    book.sections = files.map(name => ({
        id: name,
        load: () => load(name),
        unload: () => unload(name),
        size: getSize(name),
    }))
```

to:

```js
    book.sections = files.map(name => {
        const section = {
            id: name,
            load: () => load(name),
            unload: () => unload(name),
            size: getSize(name),
        }
        sectionsByName.set(name, section)
        return section
    })
```

(`book` is declared with `const book = {}` before `load` is ever *called*, so the closure references are safe.)

- [ ] **Step 4: Implement the re-spread hook in fixed-layout.js**

In `packages/foliate-js/fixed-layout.js`:

(a) Add the exported pure helper after `applyOverlayerViewBox` (before `export class FixedLayout`, ~line 84):

```js
// Whether a late `pageSpread: 'center'` hint for `section` invalidates the
// current spread map (i.e. the section is paired into a left/right spread).
export const sectionNeedsRespread = (spreads, section) => {
    if (!spreads) return false
    for (const { left, right, center } of spreads) {
        if (center === section) return false
        if (left === section || right === section) return true
    }
    return false
}
```

(b) Add a private field next to the other preload fields (~line 112, after `#activePreloads = 0`):

```js
    #spreadHintScheduled = false
```

(c) In `open(book)` (line 828), register the hint callback:

```js
    open(book) {
        this.book = book
        this.defaultViewport = book.rendition?.viewport
        this.rtl = book.dir === 'rtl'
        book.onSectionSpreadHint = section => this.#onSectionSpreadHint(section)

        this.#spread()
        if (this.#scrollMode) this.#initScrollMode()
    }
```

(d) Add the handler method right after `#respread` (~line 897):

```js
    #onSectionSpreadHint(section) {
        if (this.#scrollMode || this.spread === 'none') return
        if (!sectionNeedsRespread(this.#spreads, section)) return
        if (this.#spreadHintScheduled) return
        this.#spreadHintScheduled = true
        // Hints fire from section.load() while goToSpread/preload is mid-flight;
        // a synchronous respread would race the in-flight #showSpread. Defer one
        // tick so the current render settles, then rebuild re-anchored by section.
        setTimeout(() => {
            this.#spreadHintScheduled = false
            if (this.#index === -1) return
            this.#respread(this.spread)
        }, 0)
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- src/__tests__/document/comic-spread-detection.test.ts`
Expected: PASS, 8/8.

- [ ] **Step 6: Run task-relevant suites to catch regressions**

Run: `pnpm test -- src/__tests__/document/`
Expected: PASS (series-metadata, comic-manga-rtl, comic-spread-detection all green).

- [ ] **Step 7: Commit (submodule)**

```bash
cd /home/julianshen/projects/readest/packages/foliate-js
git add comic-book.js fixed-layout.js
git commit -m "feat(fixed-layout): render wide comic pages as standalone centered spreads"
cd /home/julianshen/projects/readest
git add apps/readest-app/src/__tests__/document/comic-spread-detection.test.ts
git commit -m "test: cover wide-page spread detection and respread predicate"
```

---

### Task 4: Reading Direction setting for fixed-layout books (Layout panel)

A two-option select (Left to Right / Right to Left) shown only for fixed-layout books, in place of the text-book Writing Mode control. It writes `writingMode` (`horizontal-tb` / `horizontal-rl`), which is already persisted per book and already flows into `bookDoc.dir` at open. One gap: the existing recreate condition only fires when either side of the change is `*-rl`, so `auto → horizontal-tb` (forcing LTR on an auto-RTL manga) would not re-render — fixed-layout books must recreate on ANY writingMode change.

**Files:**
- Create: `apps/readest-app/src/__tests__/utils/recreate-on-writing-mode.test.ts`
- Modify: `apps/readest-app/src/utils/book.ts`
- Modify: `apps/readest-app/src/components/settings/LayoutPanel.tsx:299-314,450-490`

- [ ] **Step 1: Write the failing test for the recreate predicate**

Create `apps/readest-app/src/__tests__/utils/recreate-on-writing-mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { shouldRecreateViewerOnWritingModeChange } from '@/utils/book';

describe('shouldRecreateViewerOnWritingModeChange', () => {
  it('returns false when the mode is unchanged', () => {
    expect(shouldRecreateViewerOnWritingModeChange('auto', 'auto', true)).toBe(false);
  });

  it('recreates on any change for fixed-layout books', () => {
    expect(shouldRecreateViewerOnWritingModeChange('auto', 'horizontal-tb', true)).toBe(true);
    expect(shouldRecreateViewerOnWritingModeChange('horizontal-tb', 'horizontal-rl', true)).toBe(
      true,
    );
  });

  it('recreates for reflowable books only when entering or leaving an rl mode', () => {
    expect(shouldRecreateViewerOnWritingModeChange('auto', 'horizontal-rl', false)).toBe(true);
    expect(shouldRecreateViewerOnWritingModeChange('vertical-rl', 'auto', false)).toBe(true);
    expect(shouldRecreateViewerOnWritingModeChange('auto', 'horizontal-tb', false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/__tests__/utils/recreate-on-writing-mode.test.ts`
Expected: FAIL — `shouldRecreateViewerOnWritingModeChange` not exported.

- [ ] **Step 3: Implement the predicate**

In `apps/readest-app/src/utils/book.ts`, after `deriveDocDirection`, add:

```ts
// Whether a writingMode change requires recreating the foliate viewer.
// Reflowable books only re-render on rl transitions (historical behavior);
// fixed-layout books re-pair spreads from book.dir, so any change applies.
export const shouldRecreateViewerOnWritingModeChange = (
  prev: WritingMode,
  next: WritingMode,
  isFixedLayout: boolean,
): boolean => {
  if (prev === next) return false;
  if (isFixedLayout) return true;
  const isRl = (mode: WritingMode) => mode === 'horizontal-rl' || mode === 'vertical-rl';
  return isRl(prev) || isRl(next);
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- src/__tests__/utils/recreate-on-writing-mode.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Use the predicate in LayoutPanel's writingMode effect**

In `apps/readest-app/src/components/settings/LayoutPanel.tsx`, replace the condition block at lines 305-311:

```ts
      if (
        prevWritingMode !== writingMode &&
        (['horizontal-rl', 'vertical-rl'].includes(writingMode) ||
          ['horizontal-rl', 'vertical-rl'].includes(prevWritingMode))
      ) {
        recreateViewer(envConfig, bookKey);
      }
```

with:

```ts
      if (
        shouldRecreateViewerOnWritingModeChange(
          prevWritingMode,
          writingMode,
          !!bookData?.isFixedLayout,
        )
      ) {
        recreateViewer(envConfig, bookKey);
      }
```

Update the import at line 18:

```ts
import {
  getBookDirFromWritingMode,
  getBookLangCode,
  shouldRecreateViewerOnWritingModeChange,
} from '@/utils/book';
```

- [ ] **Step 6: Add the Reading Direction UI**

In `LayoutPanel.tsx`, just above the `return` (after the `isVertical` line, ~434), add the derived value:

```ts
  // For fixed-layout books: explicit writingMode wins; otherwise follow the
  // book's parsed direction (ComicInfo Manga=YesAndRightToLeft → 'rtl').
  const fixedLayoutDirection =
    writingMode === 'horizontal-rl' || writingMode === 'vertical-rl'
      ? 'rtl'
      : writingMode === 'horizontal-tb'
        ? 'ltr'
        : bookData?.bookDoc?.dir === 'rtl'
          ? 'rtl'
          : 'ltr';
```

Then replace the writing-mode block at lines 450-490, which currently reads `{mightBeRTLBook && ( <div data-setting-id='settings.layout.writingMode' ...> ... </div> )}`, with a fixed-layout branch in front of it:

```tsx
      {bookData?.isFixedLayout ? (
        <div
          data-setting-id='settings.layout.readingDirection'
          className='flex items-center justify-between px-4'
        >
          <SettingLabel>{_('Reading Direction')}</SettingLabel>
          <SettingsSelect
            value={fixedLayoutDirection}
            onChange={(e) =>
              setWritingMode(e.target.value === 'rtl' ? 'horizontal-rl' : 'horizontal-tb')
            }
            options={[
              { value: 'ltr', label: _('Left to Right') },
              { value: 'rtl', label: _('Right to Left') },
            ]}
            ariaLabel={_('Reading Direction')}
          />
        </div>
      ) : (
        mightBeRTLBook && (
          <div
            data-setting-id='settings.layout.writingMode'
            className='flex items-center justify-between px-4'
          >
            {/* ...existing Writing Mode buttons, unchanged... */}
          </div>
        )
      )}
```

Keep the existing Writing Mode button markup byte-for-byte inside the `mightBeRTLBook && (...)` arm. `SettingsSelect` is already imported from `./primitives` (line 21-27); `bookData` is already in scope (line 40).

- [ ] **Step 7: Verify lint and the full settings test surface**

Run: `pnpm lint && pnpm test -- src/__tests__/components/settings src/__tests__/utils`
Expected: lint exit 0, tests PASS.

- [ ] **Step 8: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/utils/book.ts \
        apps/readest-app/src/components/settings/LayoutPanel.tsx \
        apps/readest-app/src/__tests__/utils/recreate-on-writing-mode.test.ts
git commit -m "feat(settings): per-book reading direction toggle for fixed-layout books"
```

---

### Task 5: Hide AI Summary for image-only books

AI Summary (Recap / Summarize Chapter) is text-only; CBZ has no extractable text. Gate the submenu — and its contribution to the divider condition — on `!bookData?.isFixedLayout`.

**Files:**
- Create: `apps/readest-app/src/__tests__/app/reader/book-menu-ai-gating.test.tsx`
- Modify: `apps/readest-app/src/app/reader/components/sidebar/BookMenu.tsx:38,190-194,226`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/app/reader/book-menu-ai-gating.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BookMenu from '@/app/reader/components/sidebar/BookMenu';

let currentBookData: { isFixedLayout: boolean } | null = null;
let aiEnabled = true;

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {} }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: () => null,
    getBookData: () => currentBookData,
  }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    bookKeys: ['book-1'],
    recreateViewer: vi.fn(),
    getViewSettings: () => null,
  }),
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: () => ({ getVisibleLibrary: () => [] }),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({ sideBarBookKey: 'book-1' }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      kosync: { enabled: false },
      webdav: { enabled: false },
      readwise: { enabled: false },
      hardcover: { enabled: false },
      aiSettings: { enabled: aiEnabled },
    },
  }),
}));
vi.mock('@/store/parallelViewStore', () => ({
  useParallelViewStore: () => ({
    parallelViews: [],
    setParallel: vi.fn(),
    unsetParallel: vi.fn(),
  }),
}));
vi.mock('@/services/environment', () => ({ isWebAppPlatform: () => false }));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: vi.fn() } }));
vi.mock('@/helpers/settings', () => ({ saveViewSettings: vi.fn() }));
vi.mock('@/app/reader/components/ProofreadRules', () => ({
  setProofreadRulesVisibility: vi.fn(),
}));
vi.mock('@/components/AboutWindow', () => ({ setAboutDialogVisible: vi.fn() }));
vi.mock('@/app/reader/hooks/useBooksManager', () => ({
  default: () => ({ openParallelView: vi.fn() }),
}));
vi.mock('@/app/reader/hooks/useAISummary', () => ({
  useAISummary: () => ({ runRecap: vi.fn(), runChapterSummary: vi.fn() }),
}));
vi.mock('@/components/Menu', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/MenuItem', () => ({
  default: ({ label, children }: { label: string; children?: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  currentBookData = null;
  aiEnabled = true;
});

describe('BookMenu AI Summary gating', () => {
  it('shows AI Summary for reflowable books when AI is enabled', () => {
    currentBookData = { isFixedLayout: false };
    render(<BookMenu />);
    expect(screen.getByText('AI Summary')).toBeTruthy();
  });

  it('hides AI Summary for fixed-layout (image-only) books', () => {
    currentBookData = { isFixedLayout: true };
    render(<BookMenu />);
    expect(screen.queryByText('AI Summary')).toBeNull();
  });

  it('hides AI Summary when the assistant is disabled', () => {
    currentBookData = { isFixedLayout: false };
    aiEnabled = false;
    render(<BookMenu />);
    expect(screen.queryByText('AI Summary')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/__tests__/app/reader/book-menu-ai-gating.test.tsx`
Expected: the fixed-layout case FAILS (AI Summary still rendered); the other two pass.

- [ ] **Step 3: Implement the gating**

In `apps/readest-app/src/app/reader/components/sidebar/BookMenu.tsx`:

Line 38, destructure `getBookData` as well:

```ts
  const { getConfig, getBookData } = useBookDataStore();
```

After line 40 (`const viewSettings = ...`), add:

```ts
  const bookData = sideBarBookKey ? getBookData(sideBarBookKey) : null;
  // AI Summary works on extracted text; image-only (fixed-layout) books have none.
  const showAISummary = !!settings.aiSettings?.enabled && !bookData?.isFixedLayout;
```

In the divider condition (lines 190-194), replace `settings.aiSettings?.enabled` with `showAISummary`:

```tsx
      {(settings.kosync.enabled ||
        settings.webdav.enabled ||
        settings.readwise.enabled ||
        settings.hardcover.enabled ||
        showAISummary) && <hr aria-hidden='true' className='border-base-200 my-1' />}
```

At line 226, replace `{settings.aiSettings?.enabled && (` with:

```tsx
      {showAISummary && (
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- src/__tests__/app/reader/book-menu-ai-gating.test.tsx`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/app/reader/components/sidebar/BookMenu.tsx \
        apps/readest-app/src/__tests__/app/reader/book-menu-ai-gating.test.tsx
git commit -m "feat(reader): hide AI Summary menu for image-only fixed-layout books"
```

---

### Task 6: i18n extraction and translation

Task 4 introduced three new translatable strings: `Reading Direction`, `Left to Right`, `Right to Left` (verified absent from all locales). English needs no entry — this project uses key-as-content (see `docs/i18n.md`); the key itself is the English string.

- [ ] **Step 1: Extract**

Run (in `apps/readest-app/`): `pnpm i18n:extract`
Expected: the three new keys appear in `public/locales/*/translation.json` with value `__STRING_NOT_TRANSLATED__` (except `en`, which stays sparse).

- [ ] **Step 2: Translate every locale**

Replace `__STRING_NOT_TRANSLATED__` for the three keys in ALL locale files under `public/locales/` with proper translations. These are standard UI terms — translate them natively per language (e.g. zh-CN: 阅读方向 / 从左到右 / 从右到左; ja: 読み方向 / 左から右 / 右から左; de: Leserichtung / Links nach rechts / Rechts nach links; fr: Sens de lecture / De gauche à droite / De droite à gauche; etc.). Match each locale's existing tone and capitalization conventions.

- [ ] **Step 3: Verify the translation gate**

Run: `pnpm check:translations`
Expected: `✅ All strings translated.` exit 0.

- [ ] **Step 4: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/public/locales
git commit -m "i18n: translate reading-direction settings strings"
```

---

### Task 7: Full verification, submodule pointer, release of the branch

- [ ] **Step 1: Full test suite**

Run (in `apps/readest-app/`): `pnpm test`
Expected: all tests pass, exit 0. If anything fails, fix before proceeding (use superpowers:systematic-debugging).

- [ ] **Step 2: Lint + format + translations**

Run: `pnpm lint && pnpm format:check && pnpm check:translations`
Expected: all exit 0. (No `src-tauri` changes in this plan, so Rust checks don't apply.)

- [ ] **Step 3: Push the foliate-js branch to the fork and pin the submodule**

```bash
cd /home/julianshen/projects/readest/packages/foliate-js
git push fork feat/manga-reading-mode
cd /home/julianshen/projects/readest
# Point the submodule URL at the fork so CI / fresh clones can fetch the pinned commit
git config -f .gitmodules submodule.packages/foliate-js.url https://github.com/julianshen/foliate-js.git
git submodule sync packages/foliate-js
git add .gitmodules packages/foliate-js
git commit -m "chore: pin foliate-js to fork branch with manga RTL + wide-spread support"
```

Expected: `git submodule status packages/foliate-js` shows the new commit hash; `git config -f .gitmodules submodule.packages/foliate-js.url` prints the fork URL.

- [ ] **Step 4: Manual smoke checklist (on-device, requires an RTL manga CBZ)**

Not automatable — present to the user at finish:

- [ ] Open a manga CBZ with `Manga=YesAndRightToLeft` → pages flow right-to-left, tap RIGHT half = next page.
- [ ] Settings → Layout shows "Reading Direction" (and not "Writing Mode") for the CBZ; switching to Left to Right re-renders the book LTR and swaps tap zones back.
- [ ] A CBZ without ComicInfo defaults to LTR; toggling RTL works and persists across reopen.
- [ ] A wide (double-page) scan renders alone and centered; surrounding pairs stay correctly aligned; ViewMenu's cover-spread toggle shifts pairings by one.
- [ ] For the CBZ, the sidebar book menu shows no "AI Summary" entry; a text EPUB still shows it.

- [ ] **Step 5: Finish the branch**

Use the superpowers:finishing-a-development-branch skill — verify tests one final time, then offer merge/PR options. If a PR is created, note in the description that `packages/foliate-js` now pins a fork branch (`julianshen/foliate-js#feat/manga-reading-mode`) and CI must fetch submodules with the updated `.gitmodules`.

---

## Self-review (done at plan time)

- **Spec coverage:** Direction source (Task 1 + 4), toggle placement/persistence (Task 4), tap zones (Task 2), spread detection (Task 3), spread offset (existing `keepCoverSpread` — documented deviation), AI gating (Task 5), error handling (malformed XML → Task 1 test; decode failure → Task 3 test; re-anchor by section → `#respread` already anchors by section, Task 3 hook reuses it), i18n (Task 6). Out-of-scope items untouched.
- **Type consistency:** `deriveDocDirection` and `shouldRecreateViewerOnWritingModeChange` defined in Task 2/4 and consumed with identical signatures; `sectionNeedsRespread(spreads, section)` defined in Task 3 and tested with the same shape `fixed-layout.js` uses (`{left, right, center}` spread records); `SectionItem.pageSpread` already includes `'center'` (`document.ts:43`).
- **Submodule discipline:** foliate-js commits land in the submodule on a dedicated branch (Tasks 1, 3); the gitlink is committed exactly once (Task 7) after the fork push, so intermediate app commits never reference unpushed submodule state.
