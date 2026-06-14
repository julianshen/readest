# "Continue to Next Volume" Series Pill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the reader reaches the last page of a book that belongs to a series, show a dismissible **"Next Volume: \<title\>"** pill in the footer that opens the next volume in one tap.

**Architecture:** A pure `findNextInSeries(library, book)` helper (in `libraryUtils`) finds the next volume — the lowest `seriesIndex` greater than the current one, falling back to title order when indices are absent/equal. `FooterBar` already computes a reactive `progressInfo` (`section` for fixed-layout comics) with `{ current, total }`; when `current + 1 >= total` (last page) and `findNextInSeries` returns a book, it renders a new `<NextVolumePill>`. The pill opens the next volume via the existing `navigateToReader(router, [hash])` path. App-only — no foliate changes.

**Tech Stack:** `apps/readest-app` (Next.js + React, vitest/jsdom). Reuses library series grouping, the footer bar, and the router-based book-open path.

---

## Background: verified integration points (current code)

- **Series fields** (post-import, `bookService.ts:423-432`): `book.metadata.series` (string), `book.metadata.seriesIndex` (number), `book.metadata.seriesTotal` (number) — flattened from `belongsTo.series` (ComicInfo.xml / EPUB collections).
- **Library access from the reader:** `useLibraryStore().getVisibleLibrary(): Book[]` (excludes deleted) — pattern from `BookMenu.tsx:35`.
- **FooterBar** (`src/app/reader/components/footerbar/FooterBar.tsx`): receives `bookKey, bookFormat, section, pageinfo` props; reads `bookData = getBookData(bookKey)`, `view = getView(bookKey)`. It already computes:
  ```ts
  const progressInfo = FIXED_LAYOUT_FORMATS.has(bookFormat) ? section : pageinfo;       // line 51
  const progressValid = !!progressInfo && progressInfo.total > 0 && progressInfo.current >= 0; // line 55
  ```
  `progressInfo.current + 1 >= progressInfo.total` ⇒ last page (the fraction the bar already uses is `(current + 1) / total`).
- **`PageInfo`** (`src/types/book.ts:122`): `{ current: number; next?: number; total: number }`.
- **Open a book:** `navigateToReader(router, bookIds: string[], queryParams?, navOptions?)` in `src/utils/nav.ts:89-103`; call with `[nextBook.hash]`. `router` from `next/navigation`'s `useRouter`.
- **Book type:** `hash`, `title`, `metadata.series`, `metadata.seriesIndex`, `readingStatus?` (`'unread' | 'reading' | 'finished'`, `book.ts:111`). Finished-marking on completion is already handled by the reader's progress auto-save, so the pill does not duplicate it.

---

## File Structure

- **`apps/readest-app/src/app/library/utils/libraryUtils.ts`** (modify) — add exported `findNextInSeries`.
- **`apps/readest-app/src/__tests__/utils/find-next-in-series.test.ts`** (create) — unit tests.
- **`apps/readest-app/src/app/reader/components/footerbar/NextVolumePill.tsx`** (create) — the pill UI.
- **`apps/readest-app/src/app/reader/components/footerbar/FooterBar.tsx`** (modify) — render the pill at end-of-book.
- **`apps/readest-app/public/locales/*/translation.json`** — "Next Volume" string ×33.

---

## Task 1: `findNextInSeries` pure helper

**Files:**
- Modify: `apps/readest-app/src/app/library/utils/libraryUtils.ts`
- Test: `apps/readest-app/src/__tests__/utils/find-next-in-series.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/utils/find-next-in-series.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { findNextInSeries } from '@/app/library/utils/libraryUtils';
import type { Book } from '@/types/book';

const mk = (hash: string, title: string, series?: string, seriesIndex?: number): Book =>
  ({ hash, title, metadata: { title, series, seriesIndex } }) as unknown as Book;

describe('findNextInSeries', () => {
  it('returns null when the book has no series', () => {
    const book = mk('a', 'Loner');
    expect(findNextInSeries([book], book)).toBeNull();
  });

  it('returns the lowest seriesIndex greater than the current', () => {
    const v1 = mk('a', 'Vol 1', 'S', 1);
    const v2 = mk('b', 'Vol 2', 'S', 2);
    const v3 = mk('c', 'Vol 3', 'S', 3);
    expect(findNextInSeries([v3, v1, v2], v1)?.hash).toBe('b');
  });

  it('skips gaps (1 -> 3 when 2 is missing)', () => {
    const v1 = mk('a', 'Vol 1', 'S', 1);
    const v3 = mk('c', 'Vol 3', 'S', 3);
    expect(findNextInSeries([v1, v3], v1)?.hash).toBe('c');
  });

  it('returns null when the current is the last volume', () => {
    const v1 = mk('a', 'Vol 1', 'S', 1);
    const v2 = mk('b', 'Vol 2', 'S', 2);
    expect(findNextInSeries([v1, v2], v2)).toBeNull();
  });

  it('ignores books from other series', () => {
    const v1 = mk('a', 'Vol 1', 'S', 1);
    const other = mk('z', 'Other 2', 'T', 2);
    expect(findNextInSeries([v1, other], v1)).toBeNull();
  });

  it('falls back to title order when indices are absent', () => {
    const a = mk('a', 'Arc A', 'S');
    const b = mk('b', 'Arc B', 'S');
    const c = mk('c', 'Arc C', 'S');
    expect(findNextInSeries([c, a, b], a)?.hash).toBe('b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/find-next-in-series.test.ts --run`
Expected: FAIL — `findNextInSeries` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/app/library/utils/libraryUtils.ts`, add (and `export`) near `createSeriesGroups`:

```ts
// Finds the next volume in `book`'s series within `library` (pass the visible
// library). Prefers the lowest seriesIndex strictly greater than the current;
// falls back to title order (first title sorting after the current) when indices
// are absent or equal. Returns null when there is no series or no next volume.
export const findNextInSeries = (library: Book[], book: Book): Book | null => {
  const series = book.metadata?.series?.trim();
  if (!series) return null;
  const inSeries = library.filter(
    (b) => b.hash !== book.hash && b.metadata?.series?.trim() === series,
  );
  if (inSeries.length === 0) return null;

  const currentIndex = book.metadata?.seriesIndex;
  if (currentIndex != null) {
    const ahead = inSeries
      .filter((b) => (b.metadata?.seriesIndex ?? -Infinity) > currentIndex)
      .sort((a, b) => a.metadata!.seriesIndex! - b.metadata!.seriesIndex!);
    if (ahead.length) return ahead[0]!;
  }

  const byTitle = [...inSeries].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return byTitle.find((b) => (b.title || '').localeCompare(book.title || '') > 0) ?? null;
};
```

Confirm `Book` is imported in this file (it is — used by `createSeriesGroups`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/find-next-in-series.test.ts --run`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/library/utils/libraryUtils.ts apps/readest-app/src/__tests__/utils/find-next-in-series.test.ts && \
  git commit -m "feat(library): findNextInSeries helper for next-volume continuation"
```

---

## Task 2: `NextVolumePill` component

**Files:**
- Create: `apps/readest-app/src/app/reader/components/footerbar/NextVolumePill.tsx`

- [ ] **Step 1: Write the component**

Create `apps/readest-app/src/app/reader/components/footerbar/NextVolumePill.tsx`:

```tsx
import clsx from 'clsx';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MdClose, MdChevronRight } from 'react-icons/md';

import { useTranslation } from '@/hooks/useTranslation';
import { navigateToReader } from '@/utils/nav';
import type { Book } from '@/types/book';

// Dismissible footer pill shown at end-of-book when a next volume exists.
const NextVolumePill: React.FC<{ nextBook: Book }> = ({ nextBook }) => {
  const _ = useTranslation();
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      className={clsx(
        'bg-base-200 eink-bordered pointer-events-auto flex items-center gap-2',
        'mx-auto mb-2 max-w-[92%] rounded-full px-3 py-2 shadow-sm',
      )}
      data-setting-id='reader.footer.next-volume'
    >
      <button
        className='btn-primary flex min-w-0 flex-1 items-center gap-1 rounded-full px-2 py-1'
        onClick={() => navigateToReader(router, [nextBook.hash])}
      >
        <span className='text-base-content/70 shrink-0 text-xs'>{_('Next Volume')}</span>
        <span className='truncate text-sm font-medium'>{nextBook.title}</span>
        <MdChevronRight className='shrink-0' size={18} />
      </button>
      <button
        className='btn btn-ghost btn-circle btn-xs shrink-0'
        aria-label={_('Dismiss')}
        onClick={() => setDismissed(true)}
      >
        <MdClose size={16} />
      </button>
    </div>
  );
};

export default NextVolumePill;
```

(Confirm `useTranslation` path and that `Dismiss` is already a translated key elsewhere — `grep -rl "'Dismiss'" src` — if not present it'll be added by extraction in Task 4. `react-icons/md` is already a dependency.)

- [ ] **Step 2: Verify lint**

Run: `cd apps/readest-app && pnpm lint`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/reader/components/footerbar/NextVolumePill.tsx && \
  git commit -m "feat(reader): NextVolumePill footer component"
```

---

## Task 3: Render the pill at end-of-book in FooterBar

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/footerbar/FooterBar.tsx`

No new unit test (the logic — `findNextInSeries` + the `atEnd` predicate — is unit-tested in Task 1; this is wiring). Covered by lint + manual.

- [ ] **Step 1: Add imports**

Near the other imports in `FooterBar.tsx`:

```ts
import { useLibraryStore } from '@/store/libraryStore';
import { findNextInSeries } from '@/app/library/utils/libraryUtils';
import NextVolumePill from './NextVolumePill';
```

- [ ] **Step 2: Compute the next volume at end-of-book**

After the existing `progressValid` line (~55), add:

```ts
  const { getVisibleLibrary } = useLibraryStore();
  const atEnd = progressValid && progressInfo!.current + 1 >= progressInfo!.total;
  const nextVolume =
    atEnd && bookData?.book ? findNextInSeries(getVisibleLibrary(), bookData.book) : null;
```

- [ ] **Step 3: Render the pill above the footer content**

Find the FooterBar's returned JSX root (the container that wraps the `MobileFooterBar`/`DesktopFooterBar` children). Render the pill just inside it, before the bar content, so it floats above the progress controls:

```tsx
      {nextVolume && <NextVolumePill key={nextVolume.hash} nextBook={nextVolume} />}
```

Place this as the first child of the footer's outermost returned element. Verify by reading the `return (` block of `FooterBar` and inserting at the top of the outer wrapper (it must be within an element that spans the footer width; if the wrapper uses `pointer-events-none` for hover transparency, the pill's own `pointer-events-auto` re-enables interaction).

- [ ] **Step 4: Verify lint + the series test**

Run: `cd apps/readest-app && pnpm lint && pnpm test -- src/__tests__/utils/find-next-in-series.test.ts --run`
Expected: lint exit 0; tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/reader/components/footerbar/FooterBar.tsx && \
  git commit -m "feat(reader): surface Next Volume pill at end of a series book"
```

---

## Task 4: i18n — translate the new string(s)

**Files:**
- Modify: `apps/readest-app/public/locales/*/translation.json`

- [ ] **Step 1: Extract**

Run: `cd apps/readest-app && pnpm run i18n:extract`
Adds `Next Volume` (and `Dismiss` if not already present) to every locale as `__STRING_NOT_TRANSLATED__`.

- [ ] **Step 2: Translate every locale**

Use the **i18n** skill (run from `apps/readest-app`). Translate every new `__STRING_NOT_TRANSLATED__` across all 33 locales in `public/locales/`.

- [ ] **Step 3: Verify**

Run: `cd apps/readest-app && grep -rl "__STRING_NOT_TRANSLATED__" public/locales/ | head` and `pnpm check:translations`
Expected: no untranslated strings; check passes.

- [ ] **Step 4: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/public/locales && \
  git commit -m "i18n: translate Next Volume strings"
```

---

## Task 5: Full verification, PR

- [ ] **Step 1: Full gate**

```bash
cd /home/julianshen/projects/readest/apps/readest-app
pnpm test && pnpm lint && pnpm build-web && pnpm check:all
```

Expected: all green.

- [ ] **Step 2: Final review + branch finish**

Dispatch a final code reviewer over the branch, then **superpowers:finishing-a-development-branch** (option 2: push + PR). Respond to bot comments; CI green before merge.

---

## Notes / guardrails

- **No foliate change** — app-only; this PR does not touch the submodule.
- **Reactive end-detection:** `atEnd` derives from `progressInfo` (props that update on relocate), so the pill appears/disappears as the user reaches/leaves the last page — no non-reactive getter.
- **Not comic-gated:** the pill works for any series book (EPUB collections too); that's a free bonus, not a regression.
- **Finished-marking:** left to the existing progress auto-save (which sets `readingStatus: 'finished'` at completion); the pill only navigates, to avoid duplicating progress logic.
- **Dismiss:** local component state; reappears next time the user lands on the last page (acceptable for v1).
