# E-ink Manga Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manga legible on e-ink with per-book image Contrast/Brightness CSS filters + a one-tap "E-Ink Boost" preset (adds grayscale), and default comics on e-ink to a full hardware refresh every page.

**Architecture:** Three new `ViewSettings` fields (`imageContrast`, `imageBrightness`, `imageGrayscale`) compose into the `img { filter: … }` rule emitted by `applyFixedlayoutStyles` (the styling path comics already use), pushed live to every loaded page via the existing `renderer.setStyles()` effect — no DOM re-pass. A Color-panel section (fixed-layout only) drives the fields; the boost preset button (e-ink only) sets all three at once. The e-ink refresh default is seeded at comic config-init so it's overridable per book.

**Tech Stack:** TypeScript/React (apps/readest-app), CSS filters, Zustand view-settings, vitest + jsdom.

> **Deviation from spec (intentional, better mechanism):** the spec proposed driving the filter from the `applyImageStyle(document)` DOM pass (which runs only on section load, with no live re-apply). Instead this plan uses the **CSS `img { filter }` rule in `applyFixedlayoutStyles`** (style.ts:1246) — the exact path `invertImgColorInDark` already uses — so `renderer.setStyles()` applies changes live to all loaded pages, and slider changes need only a dep-array entry. Same observable behavior, cleaner + already-wired. The spec's `epdRefreshInterval` seed is likewise moved from `FoliateViewer.openBook` to the comic config-default layer (`bookService.getBookConfig`) so a user's per-book value cleanly overrides it with no "unset" sentinel.

---

## Key existing code (read before each task)

- **Filter rule (comics):** `src/utils/style.ts::applyFixedlayoutStyles(document, viewSettings, themeCode?)` (1208). It destructures `isDarkMode` from `themeCode` (1216) and reads `viewSettings.invertImgColorInDark` (≈1219); the `img, canvas { … }` rule at **1246** currently does `${isDarkMode && invertImgColorInDark ? 'filter: invert(100%);' : ''}`. (Reflowable books use `getColorStyles` at 220/266 — out of scope; the new controls are fixed-layout only.)
- **Live re-apply:** `src/app/reader/components/FoliateViewer.tsx` effect at ≈760-793 iterates `renderer.getContents()` and calls `applyFixedlayoutStyles(doc, viewSettings)` per loaded doc; its dep array (≈785) lists `viewSettings?.invertImgColorInDark` etc. Also applied at open (637) and inside `saveViewSettings` (helpers/settings.ts:30 → `renderer.setStyles?.(getStyles(viewSettings))`).
- **ViewSettings type:** `src/types/book.ts` — `BookLayout` block has `invertImgColorInDark` / `applyThemeToPDF` (≈225-230); `ViewSettings extends BookLayout, …` (369). Numeric fields are plain `number`.
- **Defaults:** composed in `src/services/settingsService.ts::getDefaultViewSettings` (37-53) from partials in `src/services/constants.ts`: `DEFAULT_BOOK_LAYOUT` (285-292), `DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS` (309-311, `{ overrideColor:false }`), `DEFAULT_EINK_VIEW_SETTINGS` (313-319, has `epdRefreshInterval:5`).
- **Comic config-init:** `src/services/bookService.ts::getBookConfig` (≈636) and `saveBookConfig` (≈655) build `globalViewSettings = { ...settings.globalViewSettings, ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}) }` (642/665), then `deserializeConfig(savedStr, globalViewSettings, …)` merges the SAVED config over these defaults.
- **EPD refresh:** `src/hooks/useEpdPageRefresh.ts` — `refreshInterval=1` ⇒ `doEpdRefresh()` every page (≈53-60); `0` disables. Wired in FoliateViewer (124-127): `enabled: isAndroidApp && isEink`, `refreshInterval: viewSettings?.epdRefreshInterval ?? 5`.
- **Persistence:** `src/helpers/settings.ts::saveViewSettings(envConfig, bookKey, key, value, skipGlobal=false, applyStyles=true)`.
- **Settings UI:** `src/components/settings/ColorPanel.tsx` (component 36; `viewSettings` 43; per-field local `useState` 45-71; per-field save `useEffect` e.g. 128-131; rows via `<SettingLabel>`/`<SettingsRow>`/`BoxedList`). Fixed-layout detection precedent — `LayoutPanel.tsx:40-44` (`const { getBookData } = useBookDataStore(); const bookData = getBookData(bookKey);` then `bookData?.isFixedLayout`). Range-slider precedent — `src/components/settings/color/BackgroundTextureSelector.tsx:132-146` (`<input type='range' className='range range-sm w-32' />` + `%` readout). i18n via `_()` from `useTranslation`.

---

### Task 0: Branch

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/julianshen/projects/readest
git checkout main && git pull --ff-only origin main
git checkout -b feat/eink-manga-rendering
```

---

### Task 1: ViewSettings fields + defaults

**Files:** Modify `apps/readest-app/src/types/book.ts`, `apps/readest-app/src/services/constants.ts`

- [ ] **Step 1: Add the type fields**

In `src/types/book.ts`, in the `BookLayout` interface next to `invertImgColorInDark` / `applyThemeToPDF`, add:

```ts
  imageContrast: number;
  imageBrightness: number;
  imageGrayscale: boolean;
```

- [ ] **Step 2: Add the defaults**

In `src/services/constants.ts`, in the `DEFAULT_BOOK_LAYOUT` object (the one containing `invertImgColorInDark: false`), add:

```ts
  imageContrast: 100,
  imageBrightness: 100,
  imageGrayscale: false,
```

- [ ] **Step 3: Type-check**

Run (from `apps/readest-app`): `pnpm exec tsgo --noEmit`
Expected: exit 0 (the new required `BookLayout` fields are satisfied by `DEFAULT_BOOK_LAYOUT`; if tsgo flags another object literal that must satisfy `BookLayout`/`ViewSettings` fully, add the three defaults there too — report any such site).

- [ ] **Step 4: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/types/book.ts apps/readest-app/src/services/constants.ts
git commit -m "feat(eink): add imageContrast/imageBrightness/imageGrayscale view settings"
```

---

### Task 2: Compose the image filter + apply to comic pages

**Files:**
- Create: `apps/readest-app/src/__tests__/utils/compose-image-filter.test.ts`
- Modify: `apps/readest-app/src/utils/style.ts` (add helper; wire into `applyFixedlayoutStyles` ≈1246)

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/utils/compose-image-filter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { composeImageFilter } from '@/utils/style';

describe('composeImageFilter', () => {
  it('returns empty string for all defaults and no invert', () => {
    expect(composeImageFilter({ contrast: 100, brightness: 100, grayscale: false, invert: false })).toBe('');
  });

  it('emits contrast only when non-default', () => {
    expect(composeImageFilter({ contrast: 140, brightness: 100, grayscale: false, invert: false })).toBe(
      'filter: contrast(140%);',
    );
  });

  it('composes the boost preset (contrast + brightness + grayscale)', () => {
    expect(composeImageFilter({ contrast: 140, brightness: 110, grayscale: true, invert: false })).toBe(
      'filter: contrast(140%) brightness(110%) grayscale(1);',
    );
  });

  it('keeps dark-mode invert first when combined with adjustments', () => {
    expect(composeImageFilter({ contrast: 140, brightness: 100, grayscale: false, invert: true })).toBe(
      'filter: invert(100%) contrast(140%);',
    );
  });

  it('emits invert alone when only invert is set', () => {
    expect(composeImageFilter({ contrast: 100, brightness: 100, grayscale: false, invert: true })).toBe(
      'filter: invert(100%);',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test run src/__tests__/utils/compose-image-filter.test.ts`
Expected: FAIL — `composeImageFilter` is not exported.

- [ ] **Step 3: Implement the helper**

In `apps/readest-app/src/utils/style.ts`, add (near the other exported style helpers):

```ts
// Composes the CSS `filter` declaration for page images from per-book image
// adjustments (+ the dark-mode invert). Returns '' when nothing applies, so
// novels and untouched comics pay no filter cost. Invert stays first so the
// contrast/brightness/grayscale operate on the inverted (dark-mode) image.
export const composeImageFilter = ({
  contrast = 100,
  brightness = 100,
  grayscale = false,
  invert = false,
}: {
  contrast?: number;
  brightness?: number;
  grayscale?: boolean;
  invert?: boolean;
}): string => {
  const parts: string[] = [];
  if (invert) parts.push('invert(100%)');
  if (contrast !== 100) parts.push(`contrast(${contrast}%)`);
  if (brightness !== 100) parts.push(`brightness(${brightness}%)`);
  if (grayscale) parts.push('grayscale(1)');
  return parts.length ? `filter: ${parts.join(' ')};` : '';
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test run src/__tests__/utils/compose-image-filter.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Wire it into `applyFixedlayoutStyles`**

In `src/utils/style.ts::applyFixedlayoutStyles`, replace the `img, canvas` filter line (≈1246):

```ts
      ${isDarkMode && invertImgColorInDark ? 'filter: invert(100%);' : ''}
```

with:

```ts
      ${composeImageFilter({
        contrast: viewSettings.imageContrast,
        brightness: viewSettings.imageBrightness,
        grayscale: viewSettings.imageGrayscale,
        invert: isDarkMode && invertImgColorInDark,
      })}
```

(`viewSettings`, `isDarkMode`, `invertImgColorInDark` are all already in scope in `applyFixedlayoutStyles`.)

- [ ] **Step 6: Verify**

Run: `pnpm test run src/__tests__/utils/compose-image-filter.test.ts && pnpm lint`
Expected: tests PASS, lint exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/utils/style.ts apps/readest-app/src/__tests__/utils/compose-image-filter.test.ts
git commit -m "feat(eink): compose contrast/brightness/grayscale filter for comic page images"
```

---

### Task 3: Live re-apply on slider change

**Files:** Modify `apps/readest-app/src/app/reader/components/FoliateViewer.tsx` (the `applyFixedlayoutStyles`-per-doc effect's dep array, ≈785)

- [ ] **Step 1: Add the three fields to the effect dependency list**

Find the `useEffect` (≈760-793) that calls `viewRef.current.renderer.setStyles?.(getStyles(...))` and iterates `renderer.getContents()` calling `applyFixedlayoutStyles(doc, viewSettings)`. In its dependency array (the one already containing `viewSettings?.invertImgColorInDark`), add:

```ts
    viewSettings?.imageContrast,
    viewSettings?.imageBrightness,
    viewSettings?.imageGrayscale,
```

This re-fires the per-doc `applyFixedlayoutStyles` pass when a slider/preset changes, applying the new filter live to all loaded comic pages. (No other change — the filter itself comes from Task 2.)

- [ ] **Step 2: Verify lint/type**

Run: `pnpm lint`
Expected: exit 0 (no exhaustive-deps warning, since these are now listed).

- [ ] **Step 3: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/app/reader/components/FoliateViewer.tsx
git commit -m "feat(eink): re-apply comic image filter live when adjustments change"
```

---

### Task 4: Default comics on e-ink to full refresh per page

**Files:**
- Modify: `apps/readest-app/src/services/bookService.ts` (`getBookConfig` ≈642 and `saveBookConfig` ≈665)
- Create: `apps/readest-app/src/__tests__/services/eink-comic-refresh-default.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/services/eink-comic-refresh-default.test.ts`. It targets a small pure helper (added in Step 3) so it doesn't need the fs/config harness:

```ts
import { describe, expect, it } from 'vitest';

import { comicViewSettingsDefaults } from '@/services/bookService';

describe('comicViewSettingsDefaults', () => {
  it('seeds full per-page refresh for comics on e-ink', () => {
    expect(comicViewSettingsDefaults(true)).toMatchObject({ epdRefreshInterval: 1 });
  });

  it('does not seed a refresh interval off e-ink', () => {
    expect(comicViewSettingsDefaults(false).epdRefreshInterval).toBeUndefined();
  });

  it('always includes the base fixed-layout defaults', () => {
    expect(comicViewSettingsDefaults(false)).toMatchObject({ overrideColor: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test run src/__tests__/services/eink-comic-refresh-default.test.ts`
Expected: FAIL — `comicViewSettingsDefaults` is not exported.

- [ ] **Step 3: Add the helper and use it in both config paths**

In `src/services/bookService.ts`, add an exported helper (near the top-level helpers):

```ts
// Per-book view-setting defaults applied to comics (fixed-layout) on top of the
// global settings. On e-ink, manga pages ghost badly, so default to a full
// hardware refresh every page; a user's saved per-book value still overrides
// this (the saved config is merged on top of these defaults).
export const comicViewSettingsDefaults = (isEink: boolean): Partial<ViewSettings> => ({
  ...DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS,
  ...(isEink ? { epdRefreshInterval: 1 } : {}),
});
```

(Ensure `ViewSettings` and `DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS` are imported in `bookService.ts` — `DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS` already is.)

Then in `getBookConfig` (≈640-643) replace:

```ts
  const globalViewSettings = {
    ...settings.globalViewSettings,
    ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
  };
```

with:

```ts
  const globalViewSettings = {
    ...settings.globalViewSettings,
    ...(FIXED_LAYOUT_FORMATS.has(book.format)
      ? comicViewSettingsDefaults(!!settings.globalViewSettings.isEink)
      : {}),
  };
```

Apply the identical replacement in `saveBookConfig` (≈663-666).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test run src/__tests__/services/eink-comic-refresh-default.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Verify no import regressions**

Run: `pnpm test run src/__tests__/services/ && pnpm lint`
Expected: PASS, lint exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/services/bookService.ts apps/readest-app/src/__tests__/services/eink-comic-refresh-default.test.ts
git commit -m "feat(eink): default comics to full per-page refresh on e-ink (overridable)"
```

---

### Task 5: Color-panel image-adjustment section (fixed-layout)

**Files:** Modify `apps/readest-app/src/components/settings/ColorPanel.tsx`

Follow ColorPanel's established idiom: local `useState` per field seeded from `viewSettings`, a per-field `useEffect` calling `saveViewSettings`, and rows inside a `BoxedList`.

- [ ] **Step 1: Add fixed-layout detection**

If not already present, import and use the book data (mirror `LayoutPanel.tsx:40-44`):

```ts
import { useBookDataStore } from '@/store/bookDataStore';
// inside the component:
const { getBookData } = useBookDataStore();
const bookData = getBookData(bookKey);
```

- [ ] **Step 2: Add state + persistence for the three fields**

Add near ColorPanel's other per-field state (≈45-71):

```ts
const [imageContrast, setImageContrast] = useState(viewSettings.imageContrast ?? 100);
const [imageBrightness, setImageBrightness] = useState(viewSettings.imageBrightness ?? 100);
const [imageGrayscale, setImageGrayscale] = useState(viewSettings.imageGrayscale ?? false);
```

Add per-field save effects near the others (≈128-131), following the existing pattern (compare-then-save to avoid loops):

```ts
useEffect(() => {
  saveViewSettings(envConfig, bookKey, 'imageContrast', imageContrast, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [imageContrast]);

useEffect(() => {
  saveViewSettings(envConfig, bookKey, 'imageBrightness', imageBrightness, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [imageBrightness]);

useEffect(() => {
  saveViewSettings(envConfig, bookKey, 'imageGrayscale', imageGrayscale, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [imageGrayscale]);
```

(Match the EXACT `saveViewSettings` argument shape used by the other ColorPanel effects — e.g. whether they pass `false` for `skipGlobal`. These are per-book comic settings, so `skipGlobal = false` is fine. If neighboring effects use a different signature, copy theirs.)

- [ ] **Step 3: Add the boost preset handler**

Add inside the component:

```ts
const EINK_BOOST = { contrast: 140, brightness: 110, grayscale: true };
const isBoosted =
  imageContrast === EINK_BOOST.contrast &&
  imageBrightness === EINK_BOOST.brightness &&
  imageGrayscale === EINK_BOOST.grayscale;
const toggleEinkBoost = () => {
  if (isBoosted) {
    setImageContrast(100);
    setImageBrightness(100);
    setImageGrayscale(false);
  } else {
    setImageContrast(EINK_BOOST.contrast);
    setImageBrightness(EINK_BOOST.brightness);
    setImageGrayscale(EINK_BOOST.grayscale);
  }
};
```

- [ ] **Step 4: Render the section (fixed-layout only)**

Add a `BoxedList` section in the panel's JSX, gated on `bookData?.isFixedLayout`. Use the range-slider markup from `BackgroundTextureSelector.tsx:132-146`:

```tsx
{bookData?.isFixedLayout && (
  <BoxedList>
    <SettingsRow label={_('Contrast')}>
      <div className='flex items-center gap-2'>
        <input
          type='range'
          min='50'
          max='200'
          step='5'
          value={imageContrast}
          onChange={(e) => setImageContrast(parseInt(e.target.value, 10))}
          className='range range-sm w-32'
        />
        <span className='text-base-content/70 w-12 text-end text-sm'>{imageContrast}%</span>
      </div>
    </SettingsRow>
    <SettingsRow label={_('Brightness')}>
      <div className='flex items-center gap-2'>
        <input
          type='range'
          min='50'
          max='150'
          step='5'
          value={imageBrightness}
          onChange={(e) => setImageBrightness(parseInt(e.target.value, 10))}
          className='range range-sm w-32'
        />
        <span className='text-base-content/70 w-12 text-end text-sm'>{imageBrightness}%</span>
      </div>
    </SettingsRow>
    {viewSettings.isEink && (
      <SettingsRow label={_('E-Ink Boost')}>
        <button
          type='button'
          onClick={toggleEinkBoost}
          className={`btn btn-sm ${isBoosted ? 'btn-primary' : 'btn-ghost eink-bordered'}`}
        >
          {isBoosted ? _('On') : _('Apply')}
        </button>
      </SettingsRow>
    )}
  </BoxedList>
)}
```

(Import `BoxedList`/`SettingsRow`/`SettingLabel` from `./primitives` if not already imported. The boost button uses `btn-primary` when active and `eink-bordered` per the e-ink design rule in CLAUDE.md so it stays legible on e-ink. Place the section near the other image/color rows — e.g. after the invert-in-dark row.)

- [ ] **Step 5: Verify**

Run: `pnpm lint && pnpm test run src/__tests__/components/settings`
Expected: lint exit 0, settings tests PASS (no regression).

- [ ] **Step 6: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/components/settings/ColorPanel.tsx
git commit -m "feat(eink): comic image Contrast/Brightness sliders + E-Ink Boost preset"
```

---

### Task 6: i18n, full verification, finish branch

**Files:** `apps/readest-app/public/locales/**`

- [ ] **Step 1: Extract new strings**

Run (in `apps/readest-app/`): `pnpm i18n:extract`
Expected: new keys `Contrast`, `Brightness`, `E-Ink Boost`, `Apply`, `On` appear as `__STRING_NOT_TRANSLATED__` in `public/locales/*/translation.json` (any that already exist — e.g. `On`/`Apply` may already be present — won't be re-added).

- [ ] **Step 2: Translate every locale**

For each `__STRING_NOT_TRANSLATED__` added, fill a natural translation in all locale files under `public/locales/` (e.g. zh-CN: 对比度 / 亮度 / 电子墨水增强 / 应用 / 已开启; ja: コントラスト / 明るさ / E-Inkブースト / 適用 / オン; etc.). Match each locale's tone. (Use the `/i18n` skill if available.)

- [ ] **Step 3: Translation gate**

Run: `pnpm check:translations`
Expected: `✅ All strings translated.` exit 0.

- [ ] **Step 4: Full verification**

Run (from `apps/readest-app/`): `pnpm test && pnpm lint && pnpm build-web && pnpm check:all`
Expected: all pass, exit 0. (No `src-tauri` changes in this plan, so Rust checks don't apply.)

- [ ] **Step 5: Commit i18n**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/public/locales
git commit -m "i18n: translate e-ink manga rendering settings strings"
```

- [ ] **Step 6: Manual smoke checklist (present at finish — needs a Boox/e-ink device)**

- [ ] Open a color/gray-heavy manga CBZ: the Color panel shows **Contrast** + **Brightness** sliders (and, on e-ink, the **E-Ink Boost** button); they're absent for a text EPUB.
- [ ] Dragging a slider changes the page image live (no reopen).
- [ ] "E-Ink Boost" visibly improves a washed-out page; pressing again resets to 100/100/no-grayscale.
- [ ] A text EPUB shows no image filter and no regression (novel images untouched).
- [ ] On e-ink, a freshly-opened comic refreshes fully every page (no ghosting); changing the per-book Page Refresh Interval still overrides it; reopening keeps the override.

- [ ] **Step 7: Finish the branch**

Use the superpowers:finishing-a-development-branch skill — re-verify, push, open a PR.

---

## Self-review (done at plan time)

- **Spec coverage:** Contrast/Brightness sliders (Task 5), E-Ink Boost preset incl. grayscale (Task 5 + the `imageGrayscale` field from Task 1, composed in Task 2), CSS filter on page images (Task 2), live re-apply on change (Task 3), per-book persistence (Task 5 via `saveViewSettings`), fixed-layout-only controls + e-ink-only preset (Task 5 gates), full-refresh-per-page default for comics on e-ink with per-book override (Task 4). Out-of-scope items (true dithering, auto-contrast, per-series presets) untouched. **Deviation:** filter applied via `applyFixedlayoutStyles` CSS (not `applyImageStyle` DOM pass) and refresh seeded at config-default layer (not `openBook`) — both documented above as cleaner, behavior-equivalent.
- **Type consistency:** `imageContrast: number` / `imageBrightness: number` / `imageGrayscale: boolean` defined once in `BookLayout` (Task 1), defaulted in `DEFAULT_BOOK_LAYOUT` (Task 1), read by `composeImageFilter` (Task 2) and `applyFixedlayoutStyles` (Task 2), depended on in FoliateViewer (Task 3), and bound to the panel controls (Task 5) — same names throughout. `composeImageFilter({contrast,brightness,grayscale,invert})` signature matches its only call site. `comicViewSettingsDefaults(isEink)` defined and consumed in `bookService` (Task 4) with one signature.
- **Decisions to confirm during implementation (flagged inline):** the exact `saveViewSettings` arg shape used by neighboring ColorPanel effects (Task 5 Step 2); whether any object literal beyond `DEFAULT_BOOK_LAYOUT` must satisfy the new required `BookLayout` fields (Task 1 Step 3). Tested pure units (`composeImageFilter`, `comicViewSettingsDefaults`) are independent of these.
