# Webtoon Continuous-Scroll Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-book "Webtoon mode" toggle for fixed-layout comics that gives manhwa/webtoons a seamless continuous vertical scroll — zero gaps between page images, full-width, with larger lookahead so strips decode before they scroll into view.

**Architecture:** foliate's fixed-layout renderer already has a `flow="scrolled"` mode that lays pages out in a flex column and loads them on demand via an IntersectionObserver, and it **already renders every scroll page fit-width** (`scale = hostWidth / pageWidth` in `#renderScrollMode`). So webtoon mode is NOT a new renderer and needs no zoom or layout-snapshot machinery — it is simply `scrolled` + **zero page-gap** + **larger scroll lookahead**. This plan (1) makes the hard-coded `4px` scroll-page gap and the `50%` observer rootMargin configurable via two new renderer attributes (`page-gap`, `scroll-lookahead`) that default to today's values, (2) adds a `ViewSettings.webtoonMode` boolean, (3) has `FoliateViewer` force `flow=scrolled` + `page-gap=0` + `scroll-lookahead=200%` when webtoon is on (leaving the user's `scrolled`/`zoomMode` settings untouched, so turning it off restores the prior layout automatically), and (4) adds a fixed-layout-only "Webtoon mode" switch to the Layout panel.

**Deviation from the 2026-06-12 design spec (intentional, simpler):** the spec proposed also forcing `zoom='fit-width'` and snapshotting/restoring the previous `scrolled`/`zoomMode` pair. Both are unnecessary: scroll mode is inherently fit-width (verified in `#renderScrollMode`), and because webtoon mode never mutates the underlying `scrolled`/`zoomMode` settings (it only overrides the renderer attributes while on), turning it off needs no snapshot — the original settings re-apply. Same user-visible result, far less state.

**Tech Stack:** Vendored `packages/foliate-js` (git submodule on the `julianshen/foliate-js` fork, on branch `feat/manga-reading-mode`), `apps/readest-app` (Next.js + React, vitest/jsdom). foliate source `.js` is bundled directly and imported directly by vitest — **no foliate build step needed**.

---

## Background: current scroll machinery (read before starting)

In `packages/foliate-js/fixed-layout.js`, class `FixedLayout`:

- Shadow CSS (constructor, lines ~257-273): `:host([flow="scrolled"]) .scroll-page { ...; margin: 4px 0; }` — the hard-coded gap.
- Scroll fields (~200-205): `#scrollPages`, `#scrollObserver`, `#scrollMaxLoaded = 8`, `#scrollMode`.
- `#initScrollMode(targetIndex)` (~588-639): builds `.scroll-container` + `.scroll-page` divs, then creates the IntersectionObserver inline with `{ root: this, rootMargin: '50% 0px' }` (lines ~625-638) and observes each page.
- `#renderScrollMode()` (~840-852): sizes each page `scale = (hostWidth / page.vpWidth) * #scaleFactor` → **always fit-width**. (This is why webtoon needs no zoom handling.)
- `attributeChangedCallback` (~245-307) currently switches on `zoom`, `scale-factor`, `spread`, `flow`, plus the preload attributes added recently. `observedAttributes` (line ~136) lists them.

In `apps/readest-app`:

- `FoliateViewer.tsx`
  - `applyMarginAndGap()` (~712-768): on `viewSettings.scrolled`, sets scroll margins and `setAttribute('flow', 'scrolled')` (+ `no-continuous-scroll`). Called from `openBook` (~687) and from the effect at ~840 (deps include `viewSettings?.scrolled`, `noContinuousScroll`, insets).
  - `applyScrollModeClass(doc, viewSettings.scrolled)` at ~344 (relocate handler) and ~781 (styles effect).
  - `bookData = getBookData(bookKey)` (~121); `IMAGE_BOOK_FORMATS` already imported (from the preload feature).
- Live flow toggling is already a supported runtime op: `ViewMenu.tsx:122` does `setAttribute('flow', isScrolledMode ? 'scrolled' : 'paginated')`, and `LayoutPanel.tsx:265-267` re-applies `flow='scrolled'` after a gap change.
- `ViewSettings` is in `src/types/book.ts` (`scrolled: boolean` at ~182, `zoomMode` at ~226). Default in `DEFAULT_BOOK_LAYOUT` in `src/services/constants.ts` (`scrolled: false` at ~239).
- `LayoutPanel.tsx`: the fixed-layout-only block is `bookData?.isFixedLayout ? (...) : (...)` at ~484-544 (holds the "Reading Direction" select). `SettingsSwitchRow` is imported (~30) and used widely (e.g. ~548).

---

## File Structure

- **`packages/foliate-js/fixed-layout.js`** (modify) — `--page-gap` CSS var + `page-gap`/`scroll-lookahead` attributes; extract `#setupScrollObserver()` so lookahead changes rebuild the observer.
- **`apps/readest-app/src/utils/webtoon.ts`** (create) — pure `getWebtoonRendererAttributes(webtoon, scrolled)` → `{ flow, 'page-gap', 'scroll-lookahead' }`.
- **`apps/readest-app/src/__tests__/utils/webtoon-attributes.test.ts`** (create) — unit tests for the helper.
- **`apps/readest-app/src/types/book.ts`** (modify) — `webtoonMode: boolean` on `BookLayout`.
- **`apps/readest-app/src/services/constants.ts`** (modify) — `webtoonMode: false` in `DEFAULT_BOOK_LAYOUT`.
- **`apps/readest-app/src/app/reader/components/FoliateViewer.tsx`** (modify) — apply webtoon overrides in `applyMarginAndGap` + add `webtoonMode` to the effect deps.
- **`apps/readest-app/src/components/settings/LayoutPanel.tsx`** (modify) — fixed-layout-only "Webtoon mode" switch + live apply.
- **`apps/readest-app/public/locales/*/translation.json`** — "Webtoon mode" string ×33 locales.

---

## Task 1: foliate `page-gap` attribute (configurable scroll-page gap)

**Files:**
- Modify: `packages/foliate-js/fixed-layout.js`

No unit test (shadow-DOM CSS var, not jsdom-testable); covered by the app helper test (Task 3) + manual/smoke. Follows the exact pattern of the recently-added preload attributes.

- [ ] **Step 1: Make the scroll-page gap a CSS variable**

In the constructor's `sheet.replaceSync(...)` block, change:

```js
        :host([flow="scrolled"]) .scroll-page {
            position: relative;
            flex-shrink: 0;
            overflow: hidden;
            margin: 4px 0;
        }
```

to:

```js
        :host([flow="scrolled"]) .scroll-page {
            position: relative;
            flex-shrink: 0;
            overflow: hidden;
            margin: var(--page-gap, 4px) 0;
        }
```

- [ ] **Step 2: Observe the new attribute**

Change the `observedAttributes` line to add `page-gap` and `scroll-lookahead` (Task 2 uses the latter):

```js
    static observedAttributes = ['zoom', 'scale-factor', 'spread', 'flow',
        'preload-ahead', 'preload-behind', 'cache-spreads', 'preload-concurrency', 'cache-bytes',
        'page-gap', 'scroll-lookahead']
```

- [ ] **Step 3: Handle `page-gap` in `attributeChangedCallback`**

Add a case (place it after the `cache-bytes` case, before the switch closes):

```js
            case 'page-gap':
                this.style.setProperty('--page-gap', `${Math.max(0, Number.parseInt(value, 10) || 0)}px`)
                break
```

(`--page-gap` set on the host element inherits through the shadow boundary — CSS custom properties are inherited — so `.scroll-page` picks it up.)

- [ ] **Step 4: Sanity-check existing scroll tests still pass**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/document/fixed-layout-scroll-mode.test.ts --run`
Expected: PASS (no behavior change at the default gap).

- [ ] **Step 5: Commit**

```bash
cd packages/foliate-js && git add fixed-layout.js && \
  git commit -m "feat(fixed-layout): configurable scroll page-gap via --page-gap attribute"
```

---

## Task 2: foliate `scroll-lookahead` attribute (configurable observer rootMargin)

**Files:**
- Modify: `packages/foliate-js/fixed-layout.js`

- [ ] **Step 1: Add a lookahead field**

In the scroll-mode field block (after `#scrollObserver = null`), add:

```js
    #scrollLookahead = '50%'
```

- [ ] **Step 2: Extract the observer setup into a reusable method**

Add this method to the class (e.g. directly above `#initScrollMode`):

```js
    #setupScrollObserver() {
        this.#scrollObserver?.disconnect()
        this.#scrollObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue
                const index = parseInt(entry.target.dataset.index)
                const pageData = this.#scrollPages[index]
                if (pageData && pageData.state === 'idle') {
                    this.#loadScrollPage(pageData)
                }
            }
            this.#evictScrollPages()
        }, { root: this, rootMargin: `${this.#scrollLookahead} 0px` })
        for (const page of this.#scrollPages) {
            this.#scrollObserver.observe(page.el)
        }
    }
```

- [ ] **Step 3: Use it in `#initScrollMode`**

Replace the inline observer creation + observe loop (the block starting at `// Set up IntersectionObserver after scroll position is established.` through the `for (const page of this.#scrollPages) { this.#scrollObserver.observe(page.el) }` loop, lines ~623-639) with:

```js
        // Set up IntersectionObserver after scroll position is established
        // so only pages near the target are observed as intersecting. rootMargin
        // (#scrollLookahead) controls how far ahead/behind pages preload.
        this.#setupScrollObserver()
```

- [ ] **Step 4: Handle `scroll-lookahead` in `attributeChangedCallback`**

Add a case after the `page-gap` case:

```js
            case 'scroll-lookahead':
                this.#scrollLookahead = value || '50%'
                // Rebuild the observer live if we are already scrolling.
                if (this.#scrollMode && this.#scrollPages.length) this.#setupScrollObserver()
                break
```

- [ ] **Step 5: Run the scroll tests**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/document/fixed-layout-scroll-mode.test.ts --run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd packages/foliate-js && git add fixed-layout.js && \
  git commit -m "feat(fixed-layout): configurable scroll-lookahead (observer rootMargin), rebuild live"
```

---

## Task 3: app `getWebtoonRendererAttributes` helper

**Files:**
- Create: `apps/readest-app/src/utils/webtoon.ts`
- Test: `apps/readest-app/src/__tests__/utils/webtoon-attributes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/utils/webtoon-attributes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { getWebtoonRendererAttributes } from '@/utils/webtoon';

describe('getWebtoonRendererAttributes', () => {
  it('forces scrolled, zero gap, large lookahead when webtoon is on', () => {
    expect(getWebtoonRendererAttributes(true, false)).toEqual({
      flow: 'scrolled',
      'page-gap': '0',
      'scroll-lookahead': '200%',
    });
  });

  it('keeps scrolled flow but restores default gap/lookahead when off and already scrolled', () => {
    expect(getWebtoonRendererAttributes(false, true)).toEqual({
      flow: 'scrolled',
      'page-gap': '4',
      'scroll-lookahead': '50%',
    });
  });

  it('returns paginated flow with defaults when both off', () => {
    expect(getWebtoonRendererAttributes(false, false)).toEqual({
      flow: 'paginated',
      'page-gap': '4',
      'scroll-lookahead': '50%',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/webtoon-attributes.test.ts --run`
Expected: FAIL — module `@/utils/webtoon` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/readest-app/src/utils/webtoon.ts`:

```ts
// Webtoon mode is a per-book preset for fixed-layout comics: seamless vertical
// scroll for manhwa/webtoons. Scroll mode is already fit-width, so webtoon only
// needs to force the scrolled flow, remove the inter-page gap, and widen the
// lookahead so strips decode before they enter view. When off, the renderer
// returns to the user's scrolled/paginated layout with the default gap.
// Attribute names match FixedLayout's observedAttributes.
export const getWebtoonRendererAttributes = (
  webtoon: boolean,
  scrolled: boolean,
): Record<string, string> => ({
  flow: webtoon || scrolled ? 'scrolled' : 'paginated',
  'page-gap': webtoon ? '0' : '4',
  'scroll-lookahead': webtoon ? '200%' : '50%',
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/webtoon-attributes.test.ts --run`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/utils/webtoon.ts apps/readest-app/src/__tests__/utils/webtoon-attributes.test.ts && \
  git commit -m "feat(reader): pure getWebtoonRendererAttributes helper for webtoon overrides"
```

---

## Task 4: `ViewSettings.webtoonMode` type + default

**Files:**
- Modify: `apps/readest-app/src/types/book.ts`
- Modify: `apps/readest-app/src/services/constants.ts`

- [ ] **Step 1: Add the field to `BookLayout`**

In `src/types/book.ts`, in the `BookLayout` interface near `scrolled: boolean;` (line ~182), add:

```ts
  webtoonMode: boolean;
```

- [ ] **Step 2: Add the default**

In `src/services/constants.ts`, in `DEFAULT_BOOK_LAYOUT` near `scrolled: false,` (line ~239), add:

```ts
  webtoonMode: false,
```

- [ ] **Step 3: Verify types compile**

Run: `cd apps/readest-app && pnpm lint`
Expected: exit 0 (no missing-property error on `DEFAULT_BOOK_LAYOUT`).

- [ ] **Step 4: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/types/book.ts apps/readest-app/src/services/constants.ts && \
  git commit -m "feat(reader): add webtoonMode view setting (default off)"
```

---

## Task 5: FoliateViewer applies webtoon overrides

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/FoliateViewer.tsx`

No new unit test (effect wiring); covered by the helper test + manual/smoke.

- [ ] **Step 1: Import the helper**

Add near the other `@/utils` imports (e.g. beside `getComicPreloadAttributes`):

```ts
import { getWebtoonRendererAttributes } from '@/utils/webtoon';
```

- [ ] **Step 2: Apply webtoon overrides in `applyMarginAndGap`**

In `applyMarginAndGap` (lines ~712-768), the scroll handling currently keys off `viewSettings.scrolled`. Make webtoon force scrolled, and apply the gap/lookahead attributes. Replace this block (lines ~748-767):

```ts
    if (viewSettings.scrolled) {
      const headerVisible = showTopHeader;
      const footerVisible = showBottomFooter;
      const safeBottomPadding = appService?.hasSafeAreaInset ? gridInsets.bottom * 0.33 : 0;
      const footerBarHeight = safeBottomPadding + viewSettings.marginBottomPx;
      const scrollTop = headerVisible ? gridInsets.top + viewSettings.marginTopPx : 0;
      const scrollBottom = footerVisible ? Math.max(footerBarHeight, ttsBarHeight) : ttsBarHeight;
      setScrollMargins({ top: scrollTop, bottom: scrollBottom });
    } else {
      setScrollMargins({ top: 0, bottom: 0 });
    }
    viewRef.current?.renderer.setAttribute('gap', `${viewSettings.gapPercent}%`);
    if (viewSettings.scrolled) {
      viewRef.current?.renderer.setAttribute('flow', 'scrolled');
      if (viewSettings.noContinuousScroll) {
        viewRef.current?.renderer.setAttribute('no-continuous-scroll', '');
      } else {
        viewRef.current?.renderer.removeAttribute('no-continuous-scroll');
      }
    }
  };
```

with:

```ts
    const webtoon = !!viewSettings.webtoonMode;
    const scrolled = viewSettings.scrolled || webtoon;
    if (scrolled) {
      const headerVisible = showTopHeader;
      const footerVisible = showBottomFooter;
      const safeBottomPadding = appService?.hasSafeAreaInset ? gridInsets.bottom * 0.33 : 0;
      const footerBarHeight = safeBottomPadding + viewSettings.marginBottomPx;
      const scrollTop = headerVisible ? gridInsets.top + viewSettings.marginTopPx : 0;
      const scrollBottom = footerVisible ? Math.max(footerBarHeight, ttsBarHeight) : ttsBarHeight;
      setScrollMargins({ top: scrollTop, bottom: scrollBottom });
    } else {
      setScrollMargins({ top: 0, bottom: 0 });
    }
    viewRef.current?.renderer.setAttribute('gap', `${viewSettings.gapPercent}%`);
    const webtoonAttrs = getWebtoonRendererAttributes(webtoon, viewSettings.scrolled);
    viewRef.current?.renderer.setAttribute('page-gap', webtoonAttrs['page-gap']!);
    viewRef.current?.renderer.setAttribute('scroll-lookahead', webtoonAttrs['scroll-lookahead']!);
    if (scrolled) {
      viewRef.current?.renderer.setAttribute('flow', 'scrolled');
      if (viewSettings.noContinuousScroll) {
        viewRef.current?.renderer.setAttribute('no-continuous-scroll', '');
      } else {
        viewRef.current?.renderer.removeAttribute('no-continuous-scroll');
      }
    }
  };
```

- [ ] **Step 3: Apply the scroll-mode doc class for webtoon too**

In the relocate handler (~344) and the styles effect (~781), the call is `applyScrollModeClass(doc, viewSettings.scrolled || false)`. Change both to also honor webtoon:

```ts
        applyScrollModeClass(detail.doc, !!(viewSettings.scrolled || viewSettings.webtoonMode));
```

(at ~344) and

```ts
        applyScrollModeClass(doc, !!(viewSettings.scrolled || viewSettings.webtoonMode));
```

(at ~781). Verify with `grep -n applyScrollModeClass src/app/reader/components/FoliateViewer.tsx` first to confirm both call sites.

- [ ] **Step 4: Add `webtoonMode` to the `applyMarginAndGap` effect deps**

In the effect that calls `applyMarginAndGap` (deps array at ~845-857, which includes `viewSettings?.scrolled`), add:

```ts
    viewSettings?.webtoonMode,
```

Also add `viewSettings?.webtoonMode` to the styles effect deps array (~795-806, which lists `viewSettings?.scrolled`) so the scroll-mode class updates live.

- [ ] **Step 5: Verify lint + scroll tests**

Run: `cd apps/readest-app && pnpm lint && pnpm test -- src/__tests__/document/fixed-layout-scroll-mode.test.ts --run`
Expected: lint exit 0; tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/reader/components/FoliateViewer.tsx && \
  git commit -m "feat(reader): apply webtoon overrides (scrolled + zero gap + lookahead) in FoliateViewer"
```

---

## Task 6: LayoutPanel "Webtoon mode" switch

**Files:**
- Modify: `apps/readest-app/src/components/settings/LayoutPanel.tsx`

- [ ] **Step 1: Add local state for the toggle**

Near the other `useState` hooks (e.g. beside `const [writingMode, setWritingMode] = useState(viewSettings.writingMode);` at ~72), add:

```ts
  const [webtoonMode, setWebtoonMode] = useState(viewSettings.webtoonMode);
```

- [ ] **Step 2: Live-apply effect**

Near the other save effects (e.g. after the `gapPercent` effect at ~261-269), add an effect that persists the setting and applies the renderer attributes live:

```ts
  useEffect(() => {
    if (webtoonMode === viewSettings.webtoonMode) return;
    saveViewSettings(envConfig, bookKey, 'webtoonMode', webtoonMode, false, false);
    const attrs = getWebtoonRendererAttributes(webtoonMode, viewSettings.scrolled);
    view?.renderer.setAttribute('flow', attrs.flow!);
    view?.renderer.setAttribute('page-gap', attrs['page-gap']!);
    view?.renderer.setAttribute('scroll-lookahead', attrs['scroll-lookahead']!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webtoonMode]);
```

Add the import at the top of the file (beside the other `@/utils` imports):

```ts
import { getWebtoonRendererAttributes } from '@/utils/webtoon';
```

- [ ] **Step 3: Add the switch (fixed-layout only)**

Immediately after the `bookData?.isFixedLayout ? (...) : (...)` block that ends at line ~544 (the closing of the Reading Direction ternary), add a fixed-layout-only switch:

```tsx
      {bookData?.isFixedLayout && (
        <BoxedList title={_('Webtoon')} data-setting-id='settings.layout.webtoon'>
          <SettingsSwitchRow
            label={_('Webtoon Mode')}
            description={_('Seamless vertical scroll with no gaps, for manhwa and webtoons.')}
            checked={webtoonMode}
            onChange={() => setWebtoonMode(!webtoonMode)}
          />
        </BoxedList>
      )}
```

(Confirm `BoxedList` is imported in this file — it is used elsewhere, e.g. the "Border Frame" list at ~547. Confirm `SettingsSwitchRow` accepts a `description` prop by checking another usage; if it does not, drop the `description` line.)

- [ ] **Step 4: Verify lint + full settings tests**

Run: `cd apps/readest-app && pnpm lint && pnpm test -- src/__tests__/utils/webtoon-attributes.test.ts --run`
Expected: lint exit 0; tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/components/settings/LayoutPanel.tsx && \
  git commit -m "feat(settings): Webtoon mode switch in Layout panel (fixed-layout only)"
```

---

## Task 7: i18n — translate the new strings

**Files:**
- Modify: `apps/readest-app/public/locales/*/translation.json`

- [ ] **Step 1: Extract**

Run: `cd apps/readest-app && pnpm run i18n:extract`
This adds the new keys (`Webtoon`, `Webtoon Mode`, `Seamless vertical scroll with no gaps, for manhwa and webtoons.`) to every locale as `__STRING_NOT_TRANSLATED__`.

- [ ] **Step 2: Translate every locale**

Use the **i18n** skill (run from `apps/readest-app`). Translate every `__STRING_NOT_TRANSLATED__` occurrence for the new keys across all 33 locales in `public/locales/`. ("Webtoon" is a proper noun — keep it as "Webtoon" / its established local spelling.)

- [ ] **Step 3: Verify**

Run: `cd apps/readest-app && grep -rl "__STRING_NOT_TRANSLATED__" public/locales/ | head` and `pnpm check:translations`
Expected: no untranslated strings; check passes.

- [ ] **Step 4: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/public/locales && \
  git commit -m "i18n: translate Webtoon mode strings"
```

---

## Task 8: foliate push, repin, full verification, PR

**Files:**
- Modify: app repo gitlink for `packages/foliate-js` (repin)

- [ ] **Step 1: Push the foliate branch**

```bash
cd /home/julianshen/projects/readest/packages/foliate-js
git log --oneline -3   # expect the 2 new fixed-layout commits on top of the prior tip
git push fork feat/manga-reading-mode
```

- [ ] **Step 2: Repin the submodule**

```bash
cd /home/julianshen/projects/readest
git add packages/foliate-js
git status --short   # expect: M packages/foliate-js
```

- [ ] **Step 3: Full verification gate**

```bash
cd /home/julianshen/projects/readest/apps/readest-app
pnpm test          # full vitest suite (≥ prior + the new helper tests)
pnpm lint          # tsgo + biome
pnpm build-web     # production web build
pnpm check:all     # translations + lookbehind
```

Expected: all green.

- [ ] **Step 4: Commit the repin**

```bash
cd /home/julianshen/projects/readest
git commit -m "build(foliate-js): repin to webtoon scroll-mode (page-gap + scroll-lookahead)"
```

- [ ] **Step 5: Final review + branch finish**

Dispatch a final code reviewer over the branch, then use **superpowers:finishing-a-development-branch** (option 2: push + open PR), mirroring PRs #2/#7/#8/#9. CI on `julianshen/readest` must be green; respond to any CodeRabbit/Gemini/Codex bot comments before requesting merge.

---

## Notes / guardrails

- **Defaults preserve behavior:** `page-gap` defaults to `4` and `scroll-lookahead` to `50%`, reproducing today's scrolled behavior for non-webtoon books. Only `webtoonMode` books get `0` / `200%`.
- **No layout snapshot:** webtoon overrides renderer attributes only; it never mutates `scrolled`/`zoomMode`, so toggling off restores the user's layout automatically.
- **Fixed-layout only:** the switch is gated on `bookData?.isFixedLayout`; reflowable books never see it.
- **Submodule discipline:** foliate edits are 2 commits in `packages/foliate-js`; the app repo only repins (Task 8). Commit in the submodule before repinning (per the foliate-js fork-pin memory).
