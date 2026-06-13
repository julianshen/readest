# Comic Page-Preloading Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make comic (CBZ) page turns feel instant by exposing and tuning foliate's fixed-layout preload machinery — more spreads ahead/behind, higher concurrency, a larger LRU cache — with a byte-aware memory guard so large scans never OOM the WebView.

**Architecture:** foliate's `FixedLayout` web component already preloads adjacent spreads into an LRU cache, but the knobs (`#preloadAhead`-equivalent, concurrency, cache size) are hard-coded (`1`/`0`/`1`/cache `2`). This plan (1) extracts the eviction *decision* into a pure exported function `selectSpreadsToEvict` so it is unit-testable, (2) makes eviction byte-aware and protects the current spread + immediate neighbors, (3) backs the knobs with renderer attributes (`preload-ahead`, `preload-behind`, `cache-spreads`, `preload-concurrency`, `cache-bytes`) defaulting to today's behavior, and (4) has `FoliateViewer` set comic-tuned values for CBZ books only (`64 MB` byte cap on Android, `128 MB` elsewhere). Defaults preserve current behavior for EPUB fixed-layout and PDF.

**Tech Stack:** Vendored `packages/foliate-js` (git submodule on the `julianshen/foliate-js` fork, currently detached at `ab1aabb` = tip of local branch `feat/manga-reading-mode`), `apps/readest-app` (Next.js + React, vitest/jsdom). foliate source `.js` is bundled directly by Next/webpack and imported directly by vitest (`import ... from 'foliate-js/fixed-layout.js'`) — **no foliate build step is needed**.

---

## Background: current preload machinery (read before starting)

In `packages/foliate-js/fixed-layout.js`, class `FixedLayout`:

- Fields (lines ~154-164): `#preloadCache`, `#prerenderedSpreads` (cacheKey → `{center}` or `{left,right}` frames), `#spreadAccessTime` (cacheKey → ms), `#maxConcurrentPreloads = 1`, `#numPrerenderedSpreads = 1`, `#maxCachedSpreads = 2`, `#preloadQueue`, `#activePreloads`, `#spreadGeneration`. Cache keys are `` `spread-${index}` ``.
- `this.#spreads` is the assembled spread list; each spread is `{center}` or `{left, right}` where the values are **section objects** that carry a `.size` field (comic-book.js sets `size: getSize(name)` per section).
- `#preloadNextSpreads()` (lines ~1034-1063) currently derives counts: `forwardPreloadCount = Math.max(1, #numPrerenderedSpreads - 1)`, `backwardPreloadCount = Math.max(0, #numPrerenderedSpreads - forwardPreloadCount)`. With `#numPrerenderedSpreads = 1` that is forward 1 / backward 0.
- `#processPreloadQueue()` (lines ~1065-1138) honors `#maxConcurrentPreloads`.
- `#cleanupPreloadCache()` (lines ~1139-1175) evicts purely by count: if `#prerenderedSpreads.size > #maxCachedSpreads`, sort all keys by `#spreadAccessTime` ascending and remove the oldest `size - max`. It does NOT protect the current spread and is NOT byte-aware.
- `observedAttributes` (line 136) is `['zoom', 'scale-factor', 'spread', 'flow']`; `attributeChangedCallback` (lines ~245-281) switches on those.
- `assembleSpreads` and `sectionNeedsRespread` are already `export`ed pure functions at the top of the file — the model for `selectSpreadsToEvict`.

`#numPrerenderedSpreads` is referenced ONLY at lines ~1037, 1040, 1041. It will be replaced by explicit `#preloadAhead` / `#preloadBehind` fields.

---

## File Structure

- **`packages/foliate-js/fixed-layout.js`** (modify) — add exported `selectSpreadsToEvict`; add `#preloadAhead`/`#preloadBehind`/`#maxCachedBytes` fields; replace derived counts; make `#cleanupPreloadCache` use the pure function + byte awareness + protected keys; extend `observedAttributes` + `attributeChangedCallback`.
- **`apps/readest-app/src/__tests__/document/comic-preload-eviction.test.ts`** (create) — unit tests for `selectSpreadsToEvict`.
- **`apps/readest-app/src/utils/comicPreload.ts`** (create) — pure `getComicPreloadAttributes(isAndroid)` returning the attribute name→string-value map for CBZ.
- **`apps/readest-app/src/__tests__/utils/comic-preload-attributes.test.ts`** (create) — unit tests for `getComicPreloadAttributes`.
- **`apps/readest-app/src/app/reader/components/FoliateViewer.tsx`** (modify) — in the fixed-layout open branch, when the book is an image comic (CBZ), set the comic preload attributes.

---

## Task 1: Pure eviction selector `selectSpreadsToEvict`

**Files:**
- Modify: `packages/foliate-js/fixed-layout.js` (add exported function near `assembleSpreads`/`sectionNeedsRespread`)
- Test: `apps/readest-app/src/__tests__/document/comic-preload-eviction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/document/comic-preload-eviction.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { selectSpreadsToEvict } from 'foliate-js/fixed-layout.js';

type Entry = { key: string; accessTime: number; bytes: number };

const entries = (...rows: [string, number, number][]): Entry[] =>
  rows.map(([key, accessTime, bytes]) => ({ key, accessTime, bytes }));

describe('selectSpreadsToEvict', () => {
  it('evicts nothing when under both caps', () => {
    const e = entries(['spread-0', 1, 10], ['spread-1', 2, 10]);
    expect(selectSpreadsToEvict(e, { maxSpreads: 8, maxBytes: 100 })).toEqual([]);
  });

  it('evicts oldest first until within the count cap', () => {
    const e = entries(['spread-0', 1, 5], ['spread-1', 3, 5], ['spread-2', 2, 5]);
    // 3 entries, cap 2 -> drop the single oldest by accessTime (spread-0 @1)
    expect(selectSpreadsToEvict(e, { maxSpreads: 2, maxBytes: Infinity })).toEqual(['spread-0']);
  });

  it('evicts oldest first until within the byte cap', () => {
    const e = entries(['spread-0', 1, 60], ['spread-1', 2, 60], ['spread-2', 3, 60]);
    // total 180 > 100; drop oldest (60) -> 120 still > 100; drop next (60) -> 60 ok
    expect(selectSpreadsToEvict(e, { maxSpreads: 99, maxBytes: 100 })).toEqual([
      'spread-0',
      'spread-1',
    ]);
  });

  it('never evicts a protected key even when it is the oldest', () => {
    const e = entries(['spread-0', 1, 50], ['spread-1', 2, 50], ['spread-2', 3, 50]);
    // 3 entries, cap 2 -> evict one; the oldest (spread-0) is protected, so the
    // next-oldest unprotected (spread-1) is evicted instead.
    expect(
      selectSpreadsToEvict(e, { maxSpreads: 2, maxBytes: Infinity, protectedKeys: ['spread-0'] }),
    ).toEqual(['spread-1']);
  });

  it('stops evicting when only protected keys remain even if still over cap', () => {
    const e = entries(['spread-0', 1, 50], ['spread-1', 2, 50]);
    expect(
      selectSpreadsToEvict(e, {
        maxSpreads: 0,
        maxBytes: 0,
        protectedKeys: ['spread-0', 'spread-1'],
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/document/comic-preload-eviction.test.ts --run`
Expected: FAIL — `selectSpreadsToEvict` is not exported (import is `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `packages/foliate-js/fixed-layout.js`, directly after the existing `sectionNeedsRespread` export (just before `export class FixedLayout`), add:

```js
// Pure LRU+byte eviction selector for the prerendered-spread cache. Given the
// current cache entries ({ key, accessTime, bytes }) and the caps, returns the
// keys to evict: oldest-accessed first, skipping protected keys (the current
// spread and its immediate neighbors), stopping as soon as BOTH the count cap
// and the byte cap are satisfied (or only protected keys remain).
/**
 * @param {{ key: string, accessTime: number, bytes: number }[]} entries
 * @param {{ maxSpreads: number, maxBytes: number, protectedKeys?: string[] }} opts
 * @returns {string[]}
 */
export const selectSpreadsToEvict = (entries, { maxSpreads, maxBytes, protectedKeys = [] }) => {
    const protectedSet = new Set(protectedKeys)
    let totalCount = entries.length
    let totalBytes = entries.reduce((sum, e) => sum + (e.bytes || 0), 0)
    const candidates = entries
        .filter(e => !protectedSet.has(e.key))
        .sort((a, b) => a.accessTime - b.accessTime)
    const evict = []
    const withinCaps = () =>
        totalCount <= maxSpreads && (maxBytes == null || totalBytes <= maxBytes)
    for (const candidate of candidates) {
        if (withinCaps()) break
        evict.push(candidate.key)
        totalCount--
        totalBytes -= candidate.bytes || 0
    }
    return evict
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/document/comic-preload-eviction.test.ts --run`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd packages/foliate-js && git add fixed-layout.js && \
  git commit -m "feat(fixed-layout): pure selectSpreadsToEvict for byte-aware LRU eviction"
cd ../../apps/readest-app && cd ../.. && git add apps/readest-app/src/__tests__/document/comic-preload-eviction.test.ts && \
  git commit -m "test: cover selectSpreadsToEvict count/byte/protected behavior"
```

(Two commits because the function lives in the submodule and the test lives in the app repo. The submodule repin happens in Task 5.)

---

## Task 2: Byte-aware, protected eviction wired into `#cleanupPreloadCache`

**Files:**
- Modify: `packages/foliate-js/fixed-layout.js` (`#cleanupPreloadCache` + a small `#spreadByteSize` helper + `#maxCachedBytes` field)

No new unit test: the decision logic is fully covered by Task 1's pure tests; this task is the DOM-wiring that consumes it. The existing `comic-spread-detection.test.ts` and `fixed-layout-scroll-mode.test.ts` plus the full suite (Task 5) guard against regressions.

- [ ] **Step 1: Add the byte-cap field**

In the field block (after `#maxCachedSpreads = 2`, line ~159) add:

```js
    #maxCachedBytes = Infinity
```

- [ ] **Step 2: Add a byte-size helper**

Add this method to the class (e.g. directly above `#cleanupPreloadCache`):

```js
    // Total image bytes for the cached spread at `cacheKey`, derived from the
    // section `.size` fields (comic-book.js sets these). Returns 0 if the spread
    // is gone (e.g. after a respread shifted indices); such stale keys are
    // cleared separately, so undercounting them here is harmless.
    #spreadByteSize(cacheKey) {
        const index = Number.parseInt(cacheKey.slice('spread-'.length), 10)
        const spread = this.#spreads?.[index]
        if (!spread) return 0
        return (spread.center?.size ?? 0) + (spread.left?.size ?? 0) + (spread.right?.size ?? 0)
    }
```

- [ ] **Step 3: Replace the body of `#cleanupPreloadCache`**

Replace the entire current `#cleanupPreloadCache()` method (the count-only version, lines ~1139-1175) with:

```js
    #cleanupPreloadCache() {
        if (
            this.#prerenderedSpreads.size <= this.#maxCachedSpreads &&
            this.#maxCachedBytes === Infinity
        ) {
            return
        }

        const entries = Array.from(this.#prerenderedSpreads.keys()).map(key => ({
            key,
            accessTime: this.#spreadAccessTime.get(key) || 0,
            bytes: this.#spreadByteSize(key),
        }))

        // Protect the current spread and its immediate neighbors so eviction can
        // never drop a frame we are about to (or just did) display.
        const protectedKeys = [this.#index - 1, this.#index, this.#index + 1]
            .filter(i => i >= 0)
            .map(i => `spread-${i}`)

        const framesToDelete = selectSpreadsToEvict(entries, {
            maxSpreads: this.#maxCachedSpreads,
            maxBytes: this.#maxCachedBytes,
            protectedKeys,
        })

        framesToDelete.forEach(key => {
            const frames = this.#prerenderedSpreads.get(key)
            if (frames) {
                if (frames.center) {
                    this.#removeOverlayerForFrame(frames.center)
                    frames.center.element?.remove()
                } else {
                    this.#removeOverlayerForFrame(frames.left)
                    this.#removeOverlayerForFrame(frames.right)
                    frames.left?.element?.remove()
                    frames.right?.element?.remove()
                }
            }
            this.#prerenderedSpreads.delete(key)
            this.#spreadAccessTime.delete(key)
            this.#preloadCache.delete(key)
        })
    }
```

- [ ] **Step 4: Run the existing fixed-layout tests to verify no regression**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/document/comic-spread-detection.test.ts src/__tests__/document/fixed-layout-scroll-mode.test.ts --run`
Expected: PASS (all existing tests still green).

- [ ] **Step 5: Commit**

```bash
cd packages/foliate-js && git add fixed-layout.js && \
  git commit -m "feat(fixed-layout): byte-aware LRU eviction that protects current spread + neighbors"
```

---

## Task 3: Attribute wiring for the preload knobs

**Files:**
- Modify: `packages/foliate-js/fixed-layout.js` (`observedAttributes`, `attributeChangedCallback`, field renames, `#preloadNextSpreads`)

No new unit test (web-component attribute plumbing); covered by Task 4's helper test (produces the exact attribute map) + the full suite + manual verification.

- [ ] **Step 1: Replace `#numPrerenderedSpreads` with explicit ahead/behind fields**

In the field block, replace:

```js
    #numPrerenderedSpreads = 1
```

with:

```js
    #preloadAhead = 1
    #preloadBehind = 0
```

- [ ] **Step 2: Use the explicit fields in `#preloadNextSpreads`**

In `#preloadNextSpreads()` (lines ~1034-1063), replace:

```js
        if (this.#numPrerenderedSpreads <= 0) return

        const toPreload = []
        const forwardPreloadCount = Math.max(1, this.#numPrerenderedSpreads - 1)
        const backwardPreloadCount = Math.max(0, this.#numPrerenderedSpreads - forwardPreloadCount)
```

with:

```js
        if (this.#preloadAhead <= 0 && this.#preloadBehind <= 0) return

        const toPreload = []
        const forwardPreloadCount = this.#preloadAhead
        const backwardPreloadCount = this.#preloadBehind
```

(The two `for` loops below already use `forwardPreloadCount`/`backwardPreloadCount` unchanged.)

- [ ] **Step 3: Extend `observedAttributes`**

Change (line 136):

```js
    static observedAttributes = ['zoom', 'scale-factor', 'spread', 'flow']
```

to:

```js
    static observedAttributes = ['zoom', 'scale-factor', 'spread', 'flow',
        'preload-ahead', 'preload-behind', 'cache-spreads', 'preload-concurrency', 'cache-bytes']
```

- [ ] **Step 4: Handle the new attributes in `attributeChangedCallback`**

Inside the `switch (name)` in `attributeChangedCallback` (before the closing `}` of the switch, after the `flow` case), add:

```js
            case 'preload-ahead':
                this.#preloadAhead = Math.max(0, Number.parseInt(value, 10) || 0)
                break
            case 'preload-behind':
                this.#preloadBehind = Math.max(0, Number.parseInt(value, 10) || 0)
                break
            case 'cache-spreads':
                this.#maxCachedSpreads = Math.max(1, Number.parseInt(value, 10) || 1)
                break
            case 'preload-concurrency':
                this.#maxConcurrentPreloads = Math.max(1, Number.parseInt(value, 10) || 1)
                break
            case 'cache-bytes': {
                const bytes = Number.parseInt(value, 10)
                this.#maxCachedBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : Infinity
                break
            }
```

- [ ] **Step 5: Run the fixed-layout suite to verify no regression**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/document/comic-spread-detection.test.ts src/__tests__/document/fixed-layout-scroll-mode.test.ts src/__tests__/document/comic-preload-eviction.test.ts --run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd packages/foliate-js && git add fixed-layout.js && \
  git commit -m "feat(fixed-layout): expose preload-ahead/behind, cache-spreads, preload-concurrency, cache-bytes attributes"
```

---

## Task 4: `getComicPreloadAttributes` helper + FoliateViewer wiring

**Files:**
- Create: `apps/readest-app/src/utils/comicPreload.ts`
- Test: `apps/readest-app/src/__tests__/utils/comic-preload-attributes.test.ts`
- Modify: `apps/readest-app/src/app/reader/components/FoliateViewer.tsx` (fixed-layout open branch, lines ~668-671)

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/utils/comic-preload-attributes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { getComicPreloadAttributes } from '@/utils/comicPreload';

describe('getComicPreloadAttributes', () => {
  it('uses a 128 MB byte cap off Android', () => {
    expect(getComicPreloadAttributes(false)).toEqual({
      'preload-ahead': '3',
      'preload-behind': '1',
      'cache-spreads': '8',
      'preload-concurrency': '2',
      'cache-bytes': String(128 * 1024 * 1024),
    });
  });

  it('halves the byte cap to 64 MB on Android', () => {
    expect(getComicPreloadAttributes(true)['cache-bytes']).toBe(String(64 * 1024 * 1024));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/comic-preload-attributes.test.ts --run`
Expected: FAIL — module `@/utils/comicPreload` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/readest-app/src/utils/comicPreload.ts`:

```ts
// Comic (CBZ) preload tuning for foliate's fixed-layout renderer: preload more
// spreads ahead/behind with higher concurrency and a larger LRU cache so page
// turns feel instant, bounded by a byte cap (halved on Android, where WebView
// memory is tighter). Attribute names match FixedLayout's observedAttributes.
const MB = 1024 * 1024;

export const getComicPreloadAttributes = (isAndroid: boolean): Record<string, string> => ({
  'preload-ahead': '3',
  'preload-behind': '1',
  'cache-spreads': '8',
  'preload-concurrency': '2',
  'cache-bytes': String((isAndroid ? 64 : 128) * MB),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/comic-preload-attributes.test.ts --run`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into FoliateViewer**

In `apps/readest-app/src/app/reader/components/FoliateViewer.tsx`:

First, add the import alongside the other `@/utils` / `@/types` imports near the top of the file:

```ts
import { IMAGE_BOOK_FORMATS } from '@/types/book';
import { getComicPreloadAttributes } from '@/utils/comicPreload';
```

(If `@/types/book` is already imported, add `IMAGE_BOOK_FORMATS` to the existing import instead of duplicating it. Verify with `grep -n "@/types/book" src/app/reader/components/FoliateViewer.tsx` first.)

Then in the fixed-layout open branch (lines ~668-671), change:

```ts
      if (bookDoc?.rendition?.layout === 'pre-paginated') {
        view.renderer.setAttribute('zoom', viewSettings.zoomMode);
        view.renderer.setAttribute('spread', viewSettings.spreadMode);
        view.renderer.setAttribute('scale-factor', viewSettings.zoomLevel);
      } else {
```

to:

```ts
      if (bookDoc?.rendition?.layout === 'pre-paginated') {
        view.renderer.setAttribute('zoom', viewSettings.zoomMode);
        view.renderer.setAttribute('spread', viewSettings.spreadMode);
        view.renderer.setAttribute('scale-factor', viewSettings.zoomLevel);
        // Image comics (CBZ) benefit from aggressive preloading for instant page
        // turns; PDF renders via pdf.js with its own costs, so leave it at the
        // renderer defaults.
        if (bookData?.book?.format && IMAGE_BOOK_FORMATS.has(bookData.book.format)) {
          const preloadAttrs = getComicPreloadAttributes(!!appService?.isAndroidApp);
          for (const [name, value] of Object.entries(preloadAttrs)) {
            view.renderer.setAttribute(name, value);
          }
        }
      } else {
```

(`bookData` is already in scope — declared at line ~121 as `const bookData = getBookData(bookKey)` — and `appService` is destructured from `useEnv()` earlier in the component.)

- [ ] **Step 6: Run lint + the new tests**

Run: `cd apps/readest-app && pnpm lint && pnpm test -- src/__tests__/utils/comic-preload-attributes.test.ts src/__tests__/document/comic-preload-eviction.test.ts --run`
Expected: lint exit 0; tests PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/utils/comicPreload.ts \
          apps/readest-app/src/__tests__/utils/comic-preload-attributes.test.ts \
          apps/readest-app/src/app/reader/components/FoliateViewer.tsx && \
  git commit -m "feat(reader): tune CBZ preload (ahead/behind/cache/concurrency + byte cap) via renderer attributes"
```

---

## Task 5: Submodule push, repin, full verification

**Files:**
- Modify: app repo gitlink for `packages/foliate-js` (repin)

- [ ] **Step 1: Confirm the submodule commits are on the fork branch**

The submodule was detached at `ab1aabb`. Move the local branch up to include the new commits and push:

```bash
cd /home/julianshen/projects/readest/packages/foliate-js
git log --oneline -4   # expect the 3 new fixed-layout commits on top of ab1aabb
git branch -f feat/manga-reading-mode HEAD   # advance the fork branch to current HEAD
git checkout feat/manga-reading-mode
git push fork feat/manga-reading-mode
```

Expected: push succeeds to `julianshen/foliate-js`.

- [ ] **Step 2: Repin the submodule in the app repo**

```bash
cd /home/julianshen/projects/readest
git add packages/foliate-js
git status --short   # expect: M packages/foliate-js
```

- [ ] **Step 3: Run the full verification gate**

```bash
cd /home/julianshen/projects/readest/apps/readest-app
pnpm test          # full vitest suite
pnpm lint          # tsgo + biome
pnpm build-web     # production web build
```

Expected: all tests pass (≥ the prior 5456 + the ~7 new), lint exit 0, build succeeds.

- [ ] **Step 4: Commit the repin**

```bash
cd /home/julianshen/projects/readest
git commit -m "build(foliate-js): repin to comic preload tuning"
```

- [ ] **Step 5: Final review + branch finish**

Dispatch the final code reviewer over the whole branch, then use **superpowers:finishing-a-development-branch** (option 2: push + open PR), mirroring how PRs #2/#7/#8 shipped. CI on the fork (`julianshen/readest`) must be green; respond to any CodeRabbit/Gemini/Codex bot comments before requesting merge.

---

## Notes / guardrails

- **Defaults preserve behavior:** `#preloadAhead = 1`, `#preloadBehind = 0`, `#maxCachedSpreads = 2`, `#maxConcurrentPreloads = 1`, `#maxCachedBytes = Infinity` reproduce today's EPUB-fixed-layout / PDF behavior exactly. Only CBZ books receive the tuned attributes.
- **PDF excluded** intentionally — `IMAGE_BOOK_FORMATS` is `{ 'CBZ' }`; PDF (`FIXED_LAYOUT_FORMATS` minus image books) keeps renderer defaults.
- **Submodule discipline:** foliate edits are 3 commits in `packages/foliate-js`; the app repo only repins (Task 5). Do not edit foliate from the app working tree without committing in the submodule first (per the foliate-js fork-pin memory).
- **No user-facing setting** in this version (out of scope per the design spec).
