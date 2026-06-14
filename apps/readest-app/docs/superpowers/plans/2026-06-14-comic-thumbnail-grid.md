# Comic Page-Thumbnail Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the useless filename-list TOC for CBZ comics with a lazy, on-device **page-thumbnail grid** in the reader sidebar — tap a thumbnail to jump to that page, current page highlighted, RTL books laid out right-to-left.

**Architecture:** The sidebar's TOC tab currently renders `<TOCView>` (a tree of one item per page, labelled by filename). For image comics (CBZ) we branch to a new `<PageThumbnailGrid>` instead. Each grid cell is an IntersectionObserver-driven lazy thumbnail: when a cell scrolls near view it calls a new foliate `section.loadImage()` (raw image `Blob`), decodes it with `createImageBitmap`, draws it to a ~160px-wide canvas, and caches the resulting JPEG dataURL in a per-bookKey module-scope **LRU (cap 200)**. Tapping a cell navigates via the existing `view.goTo(href)`. The full-size bitmap is closed immediately, so a 1000-page CBZ holds ≤200 small dataURLs.

**Tech Stack:** Vendored `packages/foliate-js` (submodule on `julianshen/foliate-js` fork, branch `feat/manga-reading-mode`), `apps/readest-app` (Next.js + React, vitest/jsdom). foliate source is bundled/imported directly — no foliate build step.

---

## Background: verified integration points (current code)

- **CBZ section shape** (`packages/foliate-js/comic-book.js:154-163`): `{ id: name, load: () => load(name), unload, size }`. `load()` returns a blob URL to an **HTML doc wrapping `<img>`** — NOT a raw image — so it can't be drawn to canvas directly. The raw image comes from the closure `loadBlob(name)` (used by `book.getCover` at line 153). We add a `loadImage` method exposing it.
- **Sidebar TOC branch** (`src/app/reader/components/sidebar/Content.tsx:97-99`):
  ```tsx
  {targetTab === 'toc' && bookDoc.toc && (
    <TOCView toc={bookDoc.toc} bookKey={sideBarBookKey} />
  )}
  ```
- **TOC navigation** (`src/app/reader/components/sidebar/TOCView.tsx:214`): `getView(bookKey)?.goTo(item.href)`. For CBZ, `href` == the image filename (`book.toc = files.map(name => ({ label: name, href: name }))`, comic-book.js:164). `view.goTo(href: string)` is at `types/view.ts:71`.
- **Stores in sidebar:** `useReaderStore()` → `getView`, `getProgress`, `getViewSettings`; `useBookDataStore()` → `getBookData(bookKey)` (`bookData.book.format`, `bookData.isFixedLayout`).
- **Current page:** `useReaderStore().getProgress(bookKey)?.index` is the current **section index** (0-based) — matches the CBZ page index.
- **`IMAGE_BOOK_FORMATS`** (`src/types/book.ts:40`): `new Set(['CBZ'])`.
- **RTL:** `bookDoc.dir === 'rtl'` (set by comic-book.js:152 from ComicInfo Manga=YesAndRightToLeft).

---

## File Structure

- **`packages/foliate-js/comic-book.js`** (modify) — add `loadImage: () => loadBlob(name)` to each section.
- **`apps/readest-app/src/utils/thumbnailCache.ts`** (create) — pure per-bookKey LRU of page dataURLs.
- **`apps/readest-app/src/__tests__/utils/thumbnail-cache.test.ts`** (create) — LRU eviction tests.
- **`apps/readest-app/src/app/reader/hooks/useSectionThumbnail.ts`** (create) — generates+caches a thumbnail for a section.
- **`apps/readest-app/src/app/reader/components/sidebar/PageThumbnailGrid.tsx`** (create) — the grid (IntersectionObserver cells, highlight, tap→goTo, RTL).
- **`apps/readest-app/src/app/reader/components/sidebar/Content.tsx`** (modify) — branch TOC→grid for CBZ.

---

## Task 1: foliate — expose raw page image via `loadImage`

**Files:**
- Modify: `packages/foliate-js/comic-book.js`

No unit test (one-line accessor); covered by the thumbnail hook + manual.

- [ ] **Step 1: Add `loadImage` to the section object**

In `comic-book.js`, change the section literal (lines ~154-163):

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

to:

```js
    book.sections = files.map(name => {
        const section = {
            id: name,
            load: () => load(name),
            // Raw image Blob for the page (for thumbnails); `load()` returns an
            // HTML-wrapper blob URL instead, which can't be drawn to a canvas.
            loadImage: () => loadBlob(name),
            unload: () => unload(name),
            size: getSize(name),
        }
        sectionsByName.set(name, section)
        return section
    })
```

- [ ] **Step 2: Verify foliate scroll/spread tests still pass**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/document/comic-spread-detection.test.ts --run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd packages/foliate-js && git add comic-book.js && \
  git commit -m "feat(comic-book): expose raw page image blob via section.loadImage"
```

---

## Task 2: pure thumbnail LRU cache

**Files:**
- Create: `apps/readest-app/src/utils/thumbnailCache.ts`
- Test: `apps/readest-app/src/__tests__/utils/thumbnail-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/utils/thumbnail-cache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { ThumbnailLRU } from '@/utils/thumbnailCache';

describe('ThumbnailLRU', () => {
  it('returns undefined for a missing key', () => {
    const lru = new ThumbnailLRU(3);
    expect(lru.get(0)).toBeUndefined();
  });

  it('stores and retrieves by index', () => {
    const lru = new ThumbnailLRU(3);
    lru.set(2, 'data:a');
    expect(lru.get(2)).toBe('data:a');
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const lru = new ThumbnailLRU(2);
    lru.set(1, 'a');
    lru.set(2, 'b');
    lru.set(3, 'c'); // evicts 1 (oldest)
    expect(lru.get(1)).toBeUndefined();
    expect(lru.get(2)).toBe('b');
    expect(lru.get(3)).toBe('c');
  });

  it('get() marks an entry as recently used so it survives eviction', () => {
    const lru = new ThumbnailLRU(2);
    lru.set(1, 'a');
    lru.set(2, 'b');
    lru.get(1); // 1 is now most-recent; 2 is oldest
    lru.set(3, 'c'); // evicts 2
    expect(lru.get(1)).toBe('a');
    expect(lru.get(2)).toBeUndefined();
    expect(lru.get(3)).toBe('c');
  });

  it('re-setting an existing key refreshes recency without growing size', () => {
    const lru = new ThumbnailLRU(2);
    lru.set(1, 'a');
    lru.set(2, 'b');
    lru.set(1, 'a2'); // refresh 1
    lru.set(3, 'c'); // evicts 2
    expect(lru.get(1)).toBe('a2');
    expect(lru.get(2)).toBeUndefined();
    expect(lru.get(3)).toBe('c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/thumbnail-cache.test.ts --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/readest-app/src/utils/thumbnailCache.ts`:

```ts
// Per-bookKey LRU of page-thumbnail dataURLs (insertion-order Map; re-insert on
// access to mark recency). Caps memory for large comics: a 1000-page CBZ keeps
// at most `capacity` small JPEG dataURLs resident, not 1000 decoded images.
export class ThumbnailLRU {
  private readonly map = new Map<number, string>();
  constructor(private readonly capacity: number) {}

  get(index: number): string | undefined {
    const value = this.map.get(index);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.map.delete(index);
    this.map.set(index, value);
    return value;
  }

  set(index: number, dataUrl: string): void {
    if (this.map.has(index)) this.map.delete(index);
    this.map.set(index, dataUrl);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

const THUMBNAIL_CAPACITY = 200;
const caches = new Map<string, ThumbnailLRU>();

// One LRU per bookKey; created on demand. Call clearThumbnailCache on unmount.
export const getThumbnailCache = (bookKey: string): ThumbnailLRU => {
  let cache = caches.get(bookKey);
  if (!cache) {
    cache = new ThumbnailLRU(THUMBNAIL_CAPACITY);
    caches.set(bookKey, cache);
  }
  return cache;
};

export const clearThumbnailCache = (bookKey: string): void => {
  caches.delete(bookKey);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/thumbnail-cache.test.ts --run`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/utils/thumbnailCache.ts apps/readest-app/src/__tests__/utils/thumbnail-cache.test.ts && \
  git commit -m "feat(reader): per-bookKey LRU cache for comic page thumbnails"
```

---

## Task 3: `useSectionThumbnail` hook (generate + cache one thumbnail)

**Files:**
- Create: `apps/readest-app/src/app/reader/hooks/useSectionThumbnail.ts`

No unit test (DOM canvas/createImageBitmap not in jsdom); covered by the cache test + manual.

- [ ] **Step 1: Write the hook**

Create `apps/readest-app/src/app/reader/hooks/useSectionThumbnail.ts`:

```ts
import { useEffect, useState } from 'react';

import { getThumbnailCache } from '@/utils/thumbnailCache';

const THUMB_WIDTH = 160;

interface ComicSection {
  id: string;
  loadImage?: () => Promise<Blob>;
}

// Lazily produces a JPEG dataURL thumbnail for a comic page, cached per bookKey.
// `enabled` is driven by the cell's IntersectionObserver so off-screen cells do
// no decoding work. Returns null until ready (or on decode failure).
export const useSectionThumbnail = (
  bookKey: string,
  section: ComicSection,
  index: number,
  enabled: boolean,
): string | null => {
  const cache = getThumbnailCache(bookKey);
  const [dataUrl, setDataUrl] = useState<string | null>(() => cache.get(index) ?? null);

  useEffect(() => {
    if (!enabled || dataUrl || !section.loadImage) return;
    let cancelled = false;
    (async () => {
      try {
        const blob = await section.loadImage!();
        const bitmap = await createImageBitmap(blob);
        const scale = THUMB_WIDTH / bitmap.width;
        const canvas = document.createElement('canvas');
        canvas.width = THUMB_WIDTH;
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const url = canvas.toDataURL('image/jpeg', 0.7);
        cache.set(index, url);
        if (!cancelled) setDataUrl(url);
      } catch {
        // decode failure → leave null; the cell shows a numbered placeholder
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, index]);

  return dataUrl;
};
```

- [ ] **Step 2: Verify lint**

Run: `cd apps/readest-app && pnpm lint`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/reader/hooks/useSectionThumbnail.ts && \
  git commit -m "feat(reader): useSectionThumbnail hook (lazy canvas thumbnail + LRU)"
```

---

## Task 4: `PageThumbnailGrid` component

**Files:**
- Create: `apps/readest-app/src/app/reader/components/sidebar/PageThumbnailGrid.tsx`

- [ ] **Step 1: Write the component**

Create `apps/readest-app/src/app/reader/components/sidebar/PageThumbnailGrid.tsx`:

```tsx
import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';

import { BookDoc } from '@/libs/document';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { clearThumbnailCache } from '@/utils/thumbnailCache';
import { useSectionThumbnail } from '../../hooks/useSectionThumbnail';

interface ComicSection {
  id: string;
  loadImage?: () => Promise<Blob>;
}

interface ThumbCellProps {
  bookKey: string;
  section: ComicSection;
  index: number;
  href: string;
  current: boolean;
  onSelect: (href: string) => void;
}

const ThumbCell: React.FC<ThumbCellProps> = ({
  bookKey,
  section,
  index,
  href,
  current,
  onSelect,
}) => {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setVisible(true)),
      { rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const dataUrl = useSectionThumbnail(bookKey, section, index, visible);

  return (
    <button
      ref={ref}
      onClick={() => onSelect(href)}
      className={clsx(
        'flex flex-col items-center gap-1 rounded p-1',
        current ? 'bg-base-300 ring-primary ring-2' : 'hover:bg-base-200',
      )}
      aria-label={`Page ${index + 1}`}
      aria-current={current ? 'true' : undefined}
    >
      <div className='bg-base-200 flex aspect-[2/3] w-full items-center justify-center overflow-hidden rounded'>
        {dataUrl ? (
          <img src={dataUrl} alt='' className='h-full w-full object-cover' />
        ) : (
          <span className='text-base-content/40 text-xs'>{index + 1}</span>
        )}
      </div>
      <span className='text-base-content/70 text-xs'>{index + 1}</span>
    </button>
  );
};

const PageThumbnailGrid: React.FC<{ bookKey: string; bookDoc: BookDoc }> = ({
  bookKey,
  bookDoc,
}) => {
  const { getView, getProgress } = useReaderStore();
  const { setSideBarVisible } = useSidebarStore();
  const sections = (bookDoc.sections ?? []) as unknown as ComicSection[];
  const toc = bookDoc.toc ?? [];
  const currentIndex = getProgress(bookKey)?.index ?? 0;
  const rtl = bookDoc.dir === 'rtl';
  const isMobile = window.innerWidth < 640 || window.innerHeight < 640;

  useEffect(() => () => clearThumbnailCache(bookKey), [bookKey]);

  const handleSelect = (href: string) => {
    getView(bookKey)?.goTo(href);
    if (isMobile) setSideBarVisible(false);
  };

  return (
    <div
      dir={rtl ? 'rtl' : 'ltr'}
      className='grid grid-cols-3 gap-2 p-3'
      data-setting-id='reader.sidebar.thumbnail-grid'
    >
      {sections.map((section, index) => (
        <ThumbCell
          key={section.id}
          bookKey={bookKey}
          section={section}
          index={index}
          href={toc[index]?.href ?? section.id}
          current={index === currentIndex}
          onSelect={handleSelect}
        />
      ))}
    </div>
  );
};

export default PageThumbnailGrid;
```

- [ ] **Step 2: Verify lint**

Run: `cd apps/readest-app && pnpm lint`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/reader/components/sidebar/PageThumbnailGrid.tsx && \
  git commit -m "feat(reader): PageThumbnailGrid sidebar component (lazy cells, RTL, jump-on-tap)"
```

---

## Task 5: Branch the sidebar TOC tab to the grid for CBZ

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/sidebar/Content.tsx`

- [ ] **Step 1: Add imports + bookData**

In `Content.tsx`, add imports:

```tsx
import { IMAGE_BOOK_FORMATS } from '@/types/book';
import PageThumbnailGrid from './PageThumbnailGrid';
```

Add `getBookData` to the existing `useBookDataStore()` destructure (line 23) and read bookData:

```tsx
  const { getConfig, setConfig, getBookData } = useBookDataStore();
```

After `const config = getConfig(sideBarBookKey);` (line 25), add:

```tsx
  const bookData = getBookData(sideBarBookKey);
  const isComic = !!bookData?.book && IMAGE_BOOK_FORMATS.has(bookData.book.format);
```

- [ ] **Step 2: Branch the TOC render**

Replace the TOC branch (lines 97-99):

```tsx
              {targetTab === 'toc' && bookDoc.toc && (
                <TOCView toc={bookDoc.toc} bookKey={sideBarBookKey} />
              )}
```

with:

```tsx
              {targetTab === 'toc' &&
                (isComic ? (
                  <PageThumbnailGrid bookKey={sideBarBookKey} bookDoc={bookDoc} />
                ) : (
                  bookDoc.toc && <TOCView toc={bookDoc.toc} bookKey={sideBarBookKey} />
                ))}
```

- [ ] **Step 3: Verify lint + full suite**

Run: `cd apps/readest-app && pnpm lint && pnpm test -- src/__tests__/utils/thumbnail-cache.test.ts --run`
Expected: lint exit 0; tests PASS.

- [ ] **Step 4: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/reader/components/sidebar/Content.tsx && \
  git commit -m "feat(reader): show page-thumbnail grid instead of text TOC for CBZ comics"
```

---

## Task 6: foliate push, repin, full verification, PR

- [ ] **Step 1: Push foliate branch**

```bash
cd /home/julianshen/projects/readest/packages/foliate-js
git log --oneline -2   # expect the loadImage commit on top
git push fork feat/manga-reading-mode
```

- [ ] **Step 2: Repin submodule**

```bash
cd /home/julianshen/projects/readest && git add packages/foliate-js && git status --short
```

- [ ] **Step 3: Full verification gate**

```bash
cd /home/julianshen/projects/readest/apps/readest-app
pnpm test && pnpm lint && pnpm build-web && pnpm check:all
```

Expected: all green. (No new i18n strings — page numbers are numeric; if lint flags an untranslated literal, wrap it.)

- [ ] **Step 4: Commit repin + open PR**

```bash
cd /home/julianshen/projects/readest
git commit -m "build(foliate-js): repin to comic thumbnail loadImage"
```

Then dispatch a final code reviewer, then **superpowers:finishing-a-development-branch** (option 2: push + PR). Respond to bot comments; CI green before merge.

---

## Notes / guardrails

- **Memory:** LRU cap 200 + `bitmap.close()` + JPEG-0.7 dataURLs keep large comics bounded. `clearThumbnailCache(bookKey)` on grid unmount.
- **PDF excluded:** branch gated on `IMAGE_BOOK_FORMATS` (CBZ only); PDF keeps the text TOC.
- **RTL:** `dir='rtl'` on the grid reverses cell flow to match reading order (no manual index mapping).
- **Navigation reuse:** `view.goTo(href)` with the page filename href — identical to how `TOCView` already navigates.
- **Submodule discipline:** the `loadImage` change is 1 commit in foliate; the app repo repins in Task 6.
