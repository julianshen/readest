# Manga Bubble Translation (Region OCR + Translate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a fixed-layout comic (CBZ), let the reader tap a header "Translate region" button, drag a rectangle over a speech bubble, and get an AI transcription + translation in a popup anchored at the region.

**Architecture:** App-only (no foliate changes). A header button (CBZ + AI-configured) dispatches a `manga-bubble-mode` event. A per-book `MangaBubbleTranslator` listens, shows a full-cell drag overlay, and on release: crops the dragged region from the page `<img>` at natural resolution to a JPEG blob, calls a new `bubbleTranslationService.translateRegion` (one multimodal `generateText` call — transcribe + translate), and renders the result in an anchored popup. Vision works through the existing `getAIProvider().getModel()` (a standard `ai` SDK `LanguageModel`) — the SDK passes image content parts uniformly, so **no provider changes**; vision support depends on the user's model. Pure cores (prompt build, error mapping, output parse, crop math, cache key) are TDD'd; the DOM glue (drag, canvas, popup) is verified manually/on-device.

**Tech Stack:** `apps/readest-app` (Next.js + React, `ai` SDK v6, vitest/jsdom). Reuses the selected-text AI actions stack (`getAIProvider`/`isAIAssistantConfigured`, `SelectionAIPopup`/`getPopupPosition` conventions, `eventDispatcher`).

---

## Background: verified integration points (current code)

- **AI providers:** `getAIProvider(aiSettings)` and `isAIAssistantConfigured(aiSettings)` in `src/services/ai/providers/index.ts`. Each provider's `getModel(): LanguageModel` returns a standard `ai` model. `AISettings` in `src/services/ai/types.ts` (stored at `settings.aiSettings`).
- **Selected-text AI analog:** `src/services/ai/selectionAIService.ts` — `getModelOrThrow(aiSettings)` throws `NOT_CONFIGURED`; uses `streamText`. Test: `src/__tests__/services/ai/selectionAIService.test.ts` (mocks `ai` + `@/services/ai/providers`). Popup: `src/app/reader/components/annotator/SelectionAIPopup.tsx` (spinner→result→error, `not-eink:` modifiers for e-ink). `getPopupPosition` in `src/utils/sel.ts:340`.
- **Target language:** translation should target the book/app language via `resolveAnswerLanguageName(mode, bookDoc, uiLangCode)` in `src/services/ai/answerLanguage.ts` (returns a human name like "Japanese"). The translator's target is the language the user reads in; reuse `aiSettings.answerLanguage` (default `'book'`) — actually for *translation into the reader's language*, use `'app'` semantics. **Decision:** target = `resolveAnswerLanguageName('app', bookDoc, uiLangCode)` (the UI language), since bubble translation translates *into* the language the user reads the UI in.
- **Iframe + page image:** for the current page, `view.renderer.getContents()` → `{ index, doc }[]`; the page image is `doc.querySelector('img')`; the iframe element is `doc.defaultView.frameElement as HTMLIFrameElement` (pattern at `FoliateViewer.tsx:406-407`). The iframe carries a CSS `matrix(sx,0,0,sy,..)` transform (same math as `getRangeRectInWebview`, `sel.ts:104`).
- **Header:** `HeaderBar.tsx` — togglers rendered ~line 222 after `<TranslationToggler bookKey={bookKey} />`; `bookData = useBookDataStore().getBookData(bookKey)`, `settings = useSettingsStore()`. `bookData.isFixedLayout` + `bookData.book.format`.
- **Reader mount point:** `Annotator` is rendered per book at `BooksGrid.tsx:269`; the new orchestrator renders right after it.
- **Events:** `eventDispatcher.dispatch(name, detail)` / `.on(name, cb)` / `.off(name, cb)` in `src/utils/event.ts`.
- **`IMAGE_BOOK_FORMATS`** = `{ 'CBZ' }` (`src/types/book.ts`).

---

## File Structure

- **`src/services/ai/bubbleTranslationService.ts`** (create) — `translateRegion` + `BubbleErrorCodes`.
- **`src/__tests__/services/ai/bubbleTranslationService.test.ts`** (create).
- **`src/utils/pageCapture.ts`** (create) — pure `computeNaturalCropRect`, `regionCacheKey`; thin `captureRegionToBlob`.
- **`src/__tests__/utils/page-capture.test.ts`** (create).
- **`src/app/reader/components/annotator/RegionSelectOverlay.tsx`** (create).
- **`src/app/reader/components/annotator/BubbleTranslationPopup.tsx`** (create).
- **`src/app/reader/components/annotator/MangaBubbleTranslator.tsx`** (create) — orchestrator.
- **`src/app/reader/components/MangaBubbleToggler.tsx`** (create) — header button.
- **`src/app/reader/components/HeaderBar.tsx`** (modify) — render the toggler.
- **`src/app/reader/components/BooksGrid.tsx`** (modify) — render the orchestrator.
- **`public/locales/*`** — new strings ×33.

---

## Task 1: `bubbleTranslationService` (multimodal transcribe + translate)

**Files:**
- Create: `src/services/ai/bubbleTranslationService.ts`
- Test: `src/__tests__/services/ai/bubbleTranslationService.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/services/ai/bubbleTranslationService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateTextMock = vi.fn();
vi.mock('ai', () => ({ generateText: (args: unknown) => generateTextMock(args) }));
const getAIProviderMock = vi.fn();
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: (s: unknown) => getAIProviderMock(s),
}));

import {
  translateRegion,
  BubbleErrorCodes,
  parseRegionResult,
} from '@/services/ai/bubbleTranslationService';
import type { AISettings } from '@/services/ai/types';

const settings = { enabled: true, provider: 'openai', openaiApiKey: 'k' } as unknown as AISettings;
const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

describe('parseRegionResult', () => {
  it('splits TRANSCRIPTION/TRANSLATION blocks', () => {
    expect(parseRegionResult('TRANSCRIPTION: こんにちは\nTRANSLATION: Hello')).toEqual({
      transcription: 'こんにちは',
      translation: 'Hello',
    });
  });
  it('maps NO_TEXT to empty fields', () => {
    expect(parseRegionResult('TRANSCRIPTION: NO_TEXT\nTRANSLATION: NO_TEXT')).toEqual({
      transcription: '',
      translation: '',
    });
  });
});

describe('translateRegion', () => {
  beforeEach(() => {
    getAIProviderMock.mockReset().mockReturnValue({ getModel: () => ({}) });
    generateTextMock
      .mockReset()
      .mockResolvedValue({ text: 'TRANSCRIPTION: やあ\nTRANSLATION: Hi' });
  });

  it('pins the target language in the system prompt and sends an image part', async () => {
    const out = await translateRegion({ imageBlob: blob, targetLang: 'English', aiSettings: settings });
    expect(out).toEqual({ transcription: 'やあ', translation: 'Hi' });
    const call = generateTextMock.mock.calls[0]![0];
    expect(call.system).toMatch(/English/);
    const parts = call.messages[0].content;
    expect(parts.some((p: { type: string }) => p.type === 'image')).toBe(true);
    expect(call.temperature).toBeLessThanOrEqual(0.3);
  });

  it('throws NOT_CONFIGURED before any call when provider is unavailable', async () => {
    getAIProviderMock.mockImplementation(() => {
      throw new Error('no key');
    });
    await expect(
      translateRegion({ imageBlob: blob, targetLang: 'English', aiSettings: settings }),
    ).rejects.toThrow(BubbleErrorCodes.NOT_CONFIGURED);
  });

  it('maps provider vision errors to VISION_UNSUPPORTED', async () => {
    generateTextMock.mockRejectedValue(new Error('model does not support image input'));
    await expect(
      translateRegion({ imageBlob: blob, targetLang: 'English', aiSettings: settings }),
    ).rejects.toThrow(BubbleErrorCodes.VISION_UNSUPPORTED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/services/ai/bubbleTranslationService.test.ts --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/ai/bubbleTranslationService.ts`:

```ts
import { generateText, type LanguageModel } from 'ai';

import { getAIProvider } from '@/services/ai/providers';
import type { AISettings } from '@/services/ai/types';

export const BubbleErrorCodes = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  VISION_UNSUPPORTED: 'VISION_UNSUPPORTED',
  FAILED: 'FAILED',
} as const;

export interface RegionResult {
  transcription: string;
  translation: string;
}

export interface TranslateRegionArgs {
  imageBlob: Blob;
  targetLang: string; // human-readable language name, e.g. "English"
  aiSettings: AISettings;
}

const getModelOrThrow = (aiSettings: AISettings): LanguageModel => {
  try {
    return getAIProvider(aiSettings).getModel();
  } catch {
    throw new Error(BubbleErrorCodes.NOT_CONFIGURED);
  }
};

const systemPromptFor = (targetLang: string): string =>
  [
    'You read text from a manga/comic image region and translate it.',
    `Transcribe the original text exactly, then translate it into ${targetLang}.`,
    'Respond in EXACTLY this format, nothing else:',
    'TRANSCRIPTION: <original text on one or more lines, or NO_TEXT>',
    'TRANSLATION: <translation, or NO_TEXT>',
    'If the region contains no readable text, use NO_TEXT for both.',
  ].join('\n');

// Exported for unit testing.
export const parseRegionResult = (text: string): RegionResult => {
  const grab = (label: string): string => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`);
    const raw = text.match(re)?.[1]?.trim() ?? '';
    return raw === 'NO_TEXT' ? '' : raw;
  };
  return { transcription: grab('TRANSCRIPTION'), translation: grab('TRANSLATION') };
};

const isVisionError = (message: string): boolean =>
  /image|vision|multimodal|not support|unsupported|content type/i.test(message);

export const translateRegion = async ({
  imageBlob,
  targetLang,
  aiSettings,
}: TranslateRegionArgs): Promise<RegionResult> => {
  const model = getModelOrThrow(aiSettings); // fail fast before any I/O
  const image = new Uint8Array(await imageBlob.arrayBuffer());
  try {
    const { text } = await generateText({
      model,
      temperature: 0.2,
      system: systemPromptFor(targetLang),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe and translate the text in this image.' },
            { type: 'image', image },
          ],
        },
      ],
    });
    return parseRegionResult(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === BubbleErrorCodes.NOT_CONFIGURED) throw error;
    if (isVisionError(message)) throw new Error(BubbleErrorCodes.VISION_UNSUPPORTED);
    throw new Error(BubbleErrorCodes.FAILED);
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/services/ai/bubbleTranslationService.test.ts --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/services/ai/bubbleTranslationService.ts apps/readest-app/src/__tests__/services/ai/bubbleTranslationService.test.ts && \
  git commit -m "feat(ai): bubbleTranslationService — multimodal transcribe + translate a region"
```

---

## Task 2: `pageCapture` — pure crop math + cache key + thin blob capture

**Files:**
- Create: `src/utils/pageCapture.ts`
- Test: `src/__tests__/utils/page-capture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/utils/page-capture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { computeNaturalCropRect, regionCacheKey } from '@/utils/pageCapture';

const rect = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe('computeNaturalCropRect', () => {
  it('maps a screen rect through frame offset/scale to natural image pixels', () => {
    // frame at (100,50) in viewport, scale 1; img fills 0..400 x 0..600 in-frame;
    // natural 800x1200 → 2x. Drag screen (200,150)-(300,350) → in-frame (100,100)-(200,300)
    // → natural (200,200)-(400,600): sx200 sy200 sw200 sh400.
    const out = computeNaturalCropRect({
      screenRect: rect(200, 150, 300, 350),
      frameRect: rect(100, 50, 500, 650),
      frameScaleX: 1,
      frameScaleY: 1,
      imgRect: rect(0, 0, 400, 600),
      naturalWidth: 800,
      naturalHeight: 1200,
      maxEdge: 4096,
    });
    expect(out).toEqual({ sx: 200, sy: 200, sw: 200, sh: 400, outW: 200, outH: 400 });
  });

  it('caps the long edge at maxEdge, preserving aspect', () => {
    const out = computeNaturalCropRect({
      screenRect: rect(0, 0, 100, 200),
      frameRect: rect(0, 0, 100, 200),
      frameScaleX: 1,
      frameScaleY: 1,
      imgRect: rect(0, 0, 100, 200),
      naturalWidth: 2000,
      naturalHeight: 4000,
      maxEdge: 1000,
    });
    // sw=2000 sh=4000 → long edge 4000 capped to 1000 (k=0.25): outW=500 outH=1000
    expect(out).toMatchObject({ sw: 2000, sh: 4000, outW: 500, outH: 1000 });
  });

  it('clamps the crop to the image bounds', () => {
    const out = computeNaturalCropRect({
      screenRect: rect(-50, -50, 50, 50),
      frameRect: rect(0, 0, 100, 100),
      frameScaleX: 1,
      frameScaleY: 1,
      imgRect: rect(0, 0, 100, 100),
      naturalWidth: 100,
      naturalHeight: 100,
      maxEdge: 4096,
    });
    expect(out).toMatchObject({ sx: 0, sy: 0, sw: 50, sh: 50 });
  });

  it('returns null for a degenerate (too small) region', () => {
    const out = computeNaturalCropRect({
      screenRect: rect(10, 10, 12, 12),
      frameRect: rect(0, 0, 100, 100),
      frameScaleX: 1,
      frameScaleY: 1,
      imgRect: rect(0, 0, 100, 100),
      naturalWidth: 100,
      naturalHeight: 100,
      maxEdge: 4096,
    });
    expect(out).toBeNull();
  });
});

describe('regionCacheKey', () => {
  it('snaps near-identical rects (same 8px cell) to one key', () => {
    expect(regionCacheKey(3, rect(9, 17, 89, 113), 'English')).toBe(
      regionCacheKey(3, rect(11, 15, 87, 111), 'English'),
    );
  });
  it('keys differ by section index and target language', () => {
    expect(regionCacheKey(3, rect(9, 17, 89, 113), 'English')).not.toBe(
      regionCacheKey(4, rect(9, 17, 89, 113), 'English'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/page-capture.test.ts --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/pageCapture.ts`:

```ts
export interface CropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CropGeometry {
  screenRect: CropRect; // drag rect in viewport coords
  frameRect: CropRect; // iframe element rect in viewport coords
  frameScaleX: number;
  frameScaleY: number;
  imgRect: CropRect; // page <img> rect in iframe-local coords
  naturalWidth: number;
  naturalHeight: number;
  maxEdge: number;
}

export interface CropResult {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  outW: number;
  outH: number;
}

const MIN_NATURAL_EDGE = 8;

// Pure geometry: map a viewport drag rect to a source-pixel crop on the page
// image, clamped to image bounds and capped at maxEdge on the long side.
export const computeNaturalCropRect = (g: CropGeometry): CropResult | null => {
  const localLeft = (g.screenRect.left - g.frameRect.left) / g.frameScaleX;
  const localTop = (g.screenRect.top - g.frameRect.top) / g.frameScaleY;
  const localRight = (g.screenRect.right - g.frameRect.left) / g.frameScaleX;
  const localBottom = (g.screenRect.bottom - g.frameRect.top) / g.frameScaleY;

  const clampedLeft = Math.max(localLeft, g.imgRect.left);
  const clampedTop = Math.max(localTop, g.imgRect.top);
  const clampedRight = Math.min(localRight, g.imgRect.right);
  const clampedBottom = Math.min(localBottom, g.imgRect.bottom);
  if (clampedRight <= clampedLeft || clampedBottom <= clampedTop) return null;

  const kx = g.naturalWidth / (g.imgRect.right - g.imgRect.left);
  const ky = g.naturalHeight / (g.imgRect.bottom - g.imgRect.top);
  const sx = (clampedLeft - g.imgRect.left) * kx;
  const sy = (clampedTop - g.imgRect.top) * ky;
  const sw = (clampedRight - clampedLeft) * kx;
  const sh = (clampedBottom - clampedTop) * ky;
  if (sw < MIN_NATURAL_EDGE || sh < MIN_NATURAL_EDGE) return null;

  const longEdge = Math.max(sw, sh);
  const k = longEdge > g.maxEdge ? g.maxEdge / longEdge : 1;
  return {
    sx: Math.round(sx),
    sy: Math.round(sy),
    sw: Math.round(sw),
    sh: Math.round(sh),
    outW: Math.round(sw * k),
    outH: Math.round(sh * k),
  };
};

const snap = (n: number, grid = 8): number => Math.round(n / grid) * grid;

export const regionCacheKey = (sectionIndex: number, rect: CropRect, targetLang: string): string =>
  `${sectionIndex}:${snap(rect.left)},${snap(rect.top)},${snap(rect.right - rect.left)},${snap(
    rect.bottom - rect.top,
  )}:${targetLang}`;

// Thin DOM glue (not unit-tested): crop the page image to a JPEG blob.
export const captureRegionToBlob = async (
  img: HTMLImageElement,
  crop: CropResult,
): Promise<Blob | null> => {
  const canvas = document.createElement('canvas');
  canvas.width = crop.outW;
  canvas.height = crop.outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.outW, crop.outH);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/page-capture.test.ts --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/utils/pageCapture.ts apps/readest-app/src/__tests__/utils/page-capture.test.ts && \
  git commit -m "feat(reader): pageCapture — pure crop-rect math, cache key, region→blob"
```

---

## Task 3: `RegionSelectOverlay` (drag rectangle)

**Files:**
- Create: `src/app/reader/components/annotator/RegionSelectOverlay.tsx`

No unit test (pointer/DOM); manual-verified.

- [ ] **Step 1: Write the component**

Create `src/app/reader/components/annotator/RegionSelectOverlay.tsx`:

```tsx
import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';

import type { CropRect } from '@/utils/pageCapture';

const MIN_DRAG = 24;

interface Props {
  onSelect: (rect: CropRect) => void;
  onCancel: () => void;
}

// Full-cell overlay: drag a rectangle; on pointer-up >= MIN_DRAG px emit it,
// else cancel. Esc cancels. Rect coords are viewport (clientX/Y) based.
const RegionSelectOverlay: React.FC<Props> = ({ onSelect, onCancel }) => {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const rectOf = () => {
    if (!start || !cur) return null;
    return {
      left: Math.min(start.x, cur.x),
      top: Math.min(start.y, cur.y),
      right: Math.max(start.x, cur.x),
      bottom: Math.max(start.y, cur.y),
    };
  };
  const box = rectOf();

  return (
    <div
      ref={ref}
      className='fixed inset-0 z-50 cursor-crosshair touch-none bg-black/10'
      data-setting-id='reader.manga-bubble-overlay'
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        setStart({ x: e.clientX, y: e.clientY });
        setCur({ x: e.clientX, y: e.clientY });
      }}
      onPointerMove={(e) => start && setCur({ x: e.clientX, y: e.clientY })}
      onPointerUp={() => {
        const r = rectOf();
        if (r && r.right - r.left >= MIN_DRAG && r.bottom - r.top >= MIN_DRAG) onSelect(r);
        else onCancel();
      }}
    >
      {box && (
        <div
          className={clsx(
            'pointer-events-none absolute border-2 border-dashed border-blue-500 bg-blue-500/10',
            'eink-bordered',
          )}
          style={{
            left: box.left,
            top: box.top,
            width: box.right - box.left,
            height: box.bottom - box.top,
          }}
        />
      )}
    </div>
  );
};

export default RegionSelectOverlay;
```

- [ ] **Step 2: Lint**

Run: `cd apps/readest-app && pnpm lint`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/reader/components/annotator/RegionSelectOverlay.tsx && \
  git commit -m "feat(reader): RegionSelectOverlay drag-rectangle component (e-ink safe)"
```

---

## Task 4: `BubbleTranslationPopup` (anchored result popup)

**Files:**
- Create: `src/app/reader/components/annotator/BubbleTranslationPopup.tsx`

No unit test (presentational); manual-verified. Mirror `SelectionAIPopup` conventions (read it first for the Popup/position props and e-ink classes).

- [ ] **Step 1: Write the component**

Create `src/app/reader/components/annotator/BubbleTranslationPopup.tsx`:

```tsx
import clsx from 'clsx';
import React, { useState } from 'react';
import { MdContentCopy, MdClose } from 'react-icons/md';

import { useTranslation } from '@/hooks/useTranslation';
import { BubbleErrorCodes } from '@/services/ai/bubbleTranslationService';

interface Props {
  loading: boolean;
  transcription: string;
  translation: string;
  error: string | null; // a BubbleErrorCodes value or null
  position: { x: number; y: number };
  width: number;
  onDismiss: () => void;
}

const BubbleTranslationPopup: React.FC<Props> = ({
  loading,
  transcription,
  translation,
  error,
  position,
  width,
  onDismiss,
}) => {
  const _ = useTranslation();
  const [showOriginal, setShowOriginal] = useState(false);

  const errorText =
    error === BubbleErrorCodes.NOT_CONFIGURED
      ? _('Configure an AI provider in Settings → AI Assistant first.')
      : error === BubbleErrorCodes.VISION_UNSUPPORTED
        ? _("This model can't read images — choose a vision-capable model in Settings → AI Assistant.")
        : error
          ? _('Translation failed. Please try again.')
          : null;

  const noText = !loading && !error && !translation && !transcription;

  return (
    <div
      className={clsx(
        'bg-base-100 eink-bordered absolute z-50 rounded-lg p-3 shadow-lg',
        'not-eink:border not-eink:border-base-300',
      )}
      style={{ left: position.x, top: position.y, width }}
      data-setting-id='reader.manga-bubble-popup'
    >
      <div className='mb-1 flex items-center justify-between'>
        <span className='text-base-content/60 text-xs'>{_('Bubble Translation')}</span>
        <button className='btn btn-ghost btn-xs btn-circle' aria-label={_('Close')} onClick={onDismiss}>
          <MdClose size={14} />
        </button>
      </div>

      {loading && <div className='loading loading-dots loading-sm' />}
      {errorText && <div className='text-error text-sm'>{errorText}</div>}
      {noText && <div className='text-base-content/70 text-sm'>{_('No text detected in this region')}</div>}

      {!loading && !error && translation && (
        <>
          <p className='text-sm leading-relaxed'>{translation}</p>
          <div className='mt-2 flex items-center gap-3'>
            <button
              className='btn btn-ghost btn-xs gap-1'
              onClick={() => navigator.clipboard?.writeText(translation)}
            >
              <MdContentCopy size={13} /> {_('Copy')}
            </button>
            {transcription && (
              <button className='btn btn-ghost btn-xs' onClick={() => setShowOriginal((v) => !v)}>
                {showOriginal ? _('Hide original') : _('Show original')}
              </button>
            )}
          </div>
          {showOriginal && transcription && (
            <p className='text-base-content/70 mt-2 border-t border-base-300 pt-2 text-xs'>
              {transcription}
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default BubbleTranslationPopup;
```

- [ ] **Step 2: Lint**

Run: `cd apps/readest-app && pnpm lint`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/reader/components/annotator/BubbleTranslationPopup.tsx && \
  git commit -m "feat(reader): BubbleTranslationPopup (translation + collapsible original + errors)"
```

---

## Task 5: `MangaBubbleTranslator` orchestrator + header button + wiring

**Files:**
- Create: `src/app/reader/components/annotator/MangaBubbleTranslator.tsx`
- Create: `src/app/reader/components/MangaBubbleToggler.tsx`
- Modify: `src/app/reader/components/HeaderBar.tsx`
- Modify: `src/app/reader/components/BooksGrid.tsx`

No unit test (DOM orchestration); covered by Task 1/2 unit tests + manual/on-device.

- [ ] **Step 1: Orchestrator**

Create `src/app/reader/components/annotator/MangaBubbleTranslator.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react';

import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { getLocale } from '@/utils/misc';
import { getLanguageName } from '@/utils/lang';
import {
  computeNaturalCropRect,
  captureRegionToBlob,
  regionCacheKey,
  type CropRect,
} from '@/utils/pageCapture';
import {
  translateRegion,
  BubbleErrorCodes,
  type RegionResult,
} from '@/services/ai/bubbleTranslationService';
import RegionSelectOverlay from './RegionSelectOverlay';
import BubbleTranslationPopup from './BubbleTranslationPopup';

const MAX_EDGE = 1536;
const POPUP_WIDTH = 280;

const MangaBubbleTranslator: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { settings } = useSettingsStore();
  const { getView } = useReaderStore();
  useEnv();

  const [selecting, setSelecting] = useState(false);
  const [popup, setPopup] = useState<{
    loading: boolean;
    result: RegionResult;
    error: string | null;
    position: { x: number; y: number };
  } | null>(null);
  const cacheRef = useRef(new Map<string, RegionResult>());

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail?.bookKey !== bookKey) return;
      setPopup(null);
      setSelecting(true);
    };
    eventDispatcher.on('manga-bubble-mode', handler);
    return () => eventDispatcher.off('manga-bubble-mode', handler);
  }, [bookKey]);

  const onSelect = async (screenRect: CropRect) => {
    setSelecting(false);
    const view = getView(bookKey);
    const contents = view?.renderer?.getContents?.() ?? [];
    const primary = contents[0];
    const doc = primary?.doc as Document | undefined;
    const img = doc?.querySelector('img') as HTMLImageElement | null;
    const iframe = doc?.defaultView?.frameElement as HTMLIFrameElement | null;
    if (!img || !iframe || !doc) return;

    const frameRect = iframe.getBoundingClientRect();
    const m = getComputedStyle(iframe).transform.match(/matrix\((.+)\)/);
    const parts = m?.[1]?.split(/\s*,\s*/).map(parseFloat) ?? [];
    const frameScaleX = Number.isFinite(parts[0]) ? parts[0]! : 1;
    const frameScaleY = Number.isFinite(parts[3]) ? parts[3]! : 1;
    const imgRect = img.getBoundingClientRect(); // iframe-local

    const crop = computeNaturalCropRect({
      screenRect,
      frameRect,
      frameScaleX,
      frameScaleY,
      imgRect,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      maxEdge: MAX_EDGE,
    });
    if (!crop) return;

    const targetLang = getLocale(); // UI language code; resolved to a name below
    const position = {
      x: Math.min(screenRect.left, window.innerWidth - POPUP_WIDTH - 8),
      y: screenRect.bottom + 6,
    };
    const key = regionCacheKey(primary!.index ?? 0, screenRect, targetLang);
    const cached = cacheRef.current.get(key);
    if (cached) {
      setPopup({ loading: false, result: cached, error: null, position });
      return;
    }

    setPopup({ loading: true, result: { transcription: '', translation: '' }, error: null, position });
    try {
      const blob = await captureRegionToBlob(img, crop);
      if (!blob) throw new Error(BubbleErrorCodes.FAILED);
      const result = await translateRegion({
        imageBlob: blob,
        targetLang: getLanguageName(getLocale()),
        aiSettings: settings.aiSettings,
      });
      cacheRef.current.set(key, result);
      setPopup({ loading: false, result, error: null, position });
    } catch (error) {
      const code = error instanceof Error ? error.message : BubbleErrorCodes.FAILED;
      setPopup({ loading: false, result: { transcription: '', translation: '' }, error: code, position });
    }
  };

  return (
    <>
      {selecting && (
        <RegionSelectOverlay onSelect={onSelect} onCancel={() => setSelecting(false)} />
      )}
      {popup && (
        <BubbleTranslationPopup
          loading={popup.loading}
          transcription={popup.result.transcription}
          translation={popup.result.translation}
          error={popup.error}
          position={popup.position}
          width={POPUP_WIDTH}
          onDismiss={() => setPopup(null)}
        />
      )}
    </>
  );
};

export default MangaBubbleTranslator;
```

NOTE: `getLocale()` (`@/utils/misc:35`) returns the current UI locale code and `getLanguageName(code)` (`@/utils/lang:130`) maps it to a human name — together they give the target language (translate INTO what the user reads).

- [ ] **Step 2: Header toggler**

Create `src/app/reader/components/MangaBubbleToggler.tsx`:

```tsx
import React from 'react';
import { MdTranslate } from 'react-icons/md';

import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { isAIAssistantConfigured } from '@/services/ai/providers';
import { IMAGE_BOOK_FORMATS } from '@/types/book';
import { eventDispatcher } from '@/utils/event';

// Fixed-layout comic (CBZ) + AI-configured: enter region-translate mode.
const MangaBubbleToggler: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { settings } = useSettingsStore();
  const { getBookData } = useBookDataStore();
  const { setHoveredBookKey } = useReaderStore();
  const bookData = getBookData(bookKey);

  const isComic = !!bookData?.book && IMAGE_BOOK_FORMATS.has(bookData.book.format);
  if (!isComic || !isAIAssistantConfigured(settings.aiSettings)) return null;

  return (
    <button
      title={_('Translate Region')}
      aria-label={_('Translate Region')}
      className='btn btn-ghost h-8 min-h-8 w-8 p-0'
      onClick={() => {
        setHoveredBookKey('');
        eventDispatcher.dispatch('manga-bubble-mode', { bookKey });
      }}
    >
      <MdTranslate size={18} className='fill-base-content' />
    </button>
  );
};

export default MangaBubbleToggler;
```

- [ ] **Step 3: Render the toggler in HeaderBar**

In `HeaderBar.tsx`, import and render it right after `<TranslationToggler bookKey={bookKey} />` (~line 223):

```tsx
import MangaBubbleToggler from './MangaBubbleToggler';
```
```tsx
            <TranslationToggler bookKey={bookKey} />
            <MangaBubbleToggler bookKey={bookKey} />
```

- [ ] **Step 4: Render the orchestrator in BooksGrid**

In `BooksGrid.tsx`, import and render right after `<Annotator bookKey={bookKey} contentInsets={contentInsets} />` (line 269):

```tsx
import MangaBubbleTranslator from './annotator/MangaBubbleTranslator';
```
```tsx
      <Annotator bookKey={bookKey} contentInsets={contentInsets} />
      <MangaBubbleTranslator bookKey={bookKey} />
```

- [ ] **Step 5: Lint + tests**

Run: `cd apps/readest-app && pnpm lint && pnpm test -- src/__tests__/services/ai/bubbleTranslationService.test.ts src/__tests__/utils/page-capture.test.ts --run`
Expected: lint exit 0; tests PASS. (Resolve the `getLocale`/target-language detail flagged in Step 1 so lint is clean.)

- [ ] **Step 6: Commit**

```bash
cd /home/julianshen/projects/readest && \
  git add apps/readest-app/src/app/reader/components/annotator/MangaBubbleTranslator.tsx \
          apps/readest-app/src/app/reader/components/MangaBubbleToggler.tsx \
          apps/readest-app/src/app/reader/components/HeaderBar.tsx \
          apps/readest-app/src/app/reader/components/BooksGrid.tsx && \
  git commit -m "feat(reader): wire manga bubble translation (header button + overlay + popup orchestration)"
```

---

## Task 6: i18n

**Files:**
- Modify: `public/locales/*/translation.json`

- [ ] **Step 1: Extract**

Run: `cd apps/readest-app && pnpm run i18n:extract`
New keys: `Translate Region`, `Bubble Translation`, `No text detected in this region`, `Show original`, `Hide original`, `This model can't read images — choose a vision-capable model in Settings → AI Assistant.`, and `Translation failed. Please try again.` (plus any reused ones already present like `Copy`, `Close`, the NOT_CONFIGURED string if new).

- [ ] **Step 2: Translate every locale**

Use the **i18n** skill (run from `apps/readest-app`). Translate every new `__STRING_NOT_TRANSLATED__` across all 33 locales.

- [ ] **Step 3: Verify**

Run: `cd apps/readest-app && grep -rl "__STRING_NOT_TRANSLATED__" public/locales/ | head` and `pnpm check:translations`
Expected: none remaining; check passes.

- [ ] **Step 4: Commit**

```bash
cd /home/julianshen/projects/readest && git add apps/readest-app/public/locales && \
  git commit -m "i18n: translate manga bubble translation strings"
```

---

## Task 7: Full verification, PR

- [ ] **Step 1: Full gate**

```bash
cd /home/julianshen/projects/readest/apps/readest-app
pnpm test && pnpm lint && pnpm build-web && pnpm check:all
```

Expected: all green.

- [ ] **Step 2: Final review + branch finish**

Dispatch a final code reviewer over the branch, then **superpowers:finishing-a-development-branch** (option 2: push + PR). Respond to bot comments; CI green before merge. App-only — no submodule repin.

---

## Notes / guardrails

- **No foliate / provider changes:** multimodal `generateText` works through the existing `getModel()`; vision support is the user's model's responsibility, surfaced as `VISION_UNSUPPORTED`.
- **CBZ only:** the toggler is gated on `IMAGE_BOOK_FORMATS` + `isAIAssistantConfigured`; PDF/EPUB never see it.
- **Privacy:** the cropped region is sent to the configured AI provider — this is inherent to the feature; the button title conveys it. (A one-time notice is a phase-2 nicety, not in this plan.)
- **Capture coords:** `RegionSelectOverlay` uses viewport (`clientX/Y`); `computeNaturalCropRect` maps viewport → iframe-local (inverse of the `getRangeRectInWebview` transform) → natural pixels. Single-page assumption (`contents[0]`); spreads/parallel are out of scope for v1 (use the primary content).
- **Manual gate (the real test):** a Japanese CBZ page + a vision model (e.g. Gemini Flash via OpenRouter) — translation accuracy, popup anchoring, cancel (Esc/tap-out), e-ink rectangle. Out of scope: auto bubble detection, inline overlay, persistent cache, on-device OCR.
