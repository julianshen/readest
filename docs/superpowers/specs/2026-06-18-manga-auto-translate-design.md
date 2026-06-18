# Comic Auto-Translate (on-device bubble detection + OCR) — Design

**Status:** approved design, ready for implementation planning
**Date:** 2026-06-18

## Goal

Add an "Auto-translate page" mode for comics that automatically **detects speech
bubbles, OCRs the text, and translates it** — surfaced as tap-to-reveal popups —
without the reader manually drawing a box around every bubble. This generalizes
today's manual region-drag bubble translation into a whole-page, automatic flow.

## Drivers and constraints (decisions locked during brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Primary driver | **Best accuracy on Japanese vertical text** | manga uses vertical/furigana/dense text; a specialized OCR beats a general LLM here |
| Deployment | **Fully on-device** (Tauri/Rust backend) | matches the existing on-device ML direction; offline-capable detection + OCR |
| Source languages | **JP + Korean + Chinese** (manga + manhwa + manhua) | manga-ocr is JP-only, so KO/ZH need their own OCR |
| OCR strategy | **Best-per-language** behind one interface | manga-ocr (JP) + PaddleOCR recognition (KO/ZH) |
| Overlay UX | **Tap-to-reveal popup** | robust to imperfect detector boxes; reuses the existing popup |
| Translation step | **Reuse existing TS translators** (not a new on-device MT model) | driver is OCR accuracy; cloud MT quality is already strong; avoids 1–2 GB of MT models |

**Non-goals (v1):** offline machine translation; in-place "painted-over" overlay
(the immersive look — deferred as a stretch); languages beyond JP/KO/ZH;
per-region language auto-detection (whole-comic language is set per book).

## Architecture overview

Per comic page, the **Rust/Tauri backend does only the manga-specific vision ML
(detect + OCR)**; **translation and rendering stay in the existing TypeScript
layer**. The backend returns original text + boxes; the web layer translates and
draws markers. This reuses 100% of the existing translation code and keeps the
Rust side focused.

```text
page image ─► [1 Detect] ─► [2 Route] ─► [3 OCR] ─► returns [{id, bbox, original}]
              comic-text-      by book      JP → manga-ocr
              detector (ONNX)  language     KO/ZH → PaddleOCR rec (ONNX)
                                            behind one OcrEngine trait

TS layer: originals ─► [4 Translate] (existing useTranslator) ─► markers + popups
```

1. **Detect** — `comic-text-detector` (ONNX) returns text-region boxes; handles
   vertical manga + horizontal manhwa/manhua. This is the piece manga-ocr never
   provided.
2. **Route** — each region goes to an OCR engine by the comic's source language
   (a per-book setting, defaulted from metadata). Whole-comic language, not
   per-region guessing.
3. **OCR** — `manga-ocr` (JP), `PaddleOCR` recognition (KO/ZH), behind one
   pluggable `OcrEngine` trait.
4. **Translate** — recognized text flows into the existing translator pipeline
   (configured provider + `translateTargetLang`). No new translation model.

## Rust backend and the Rust↔TS boundary

Location (as implemented in Phase 1): the GTK-free `apps/readest-app/crates/manga-ocr`
crate, with the Tauri command wrappers in `apps/readest-app/src-tauri/src/ocr.rs`.
*(This design originally proposed a `src-tauri/src/manga_ocr/` module; execution moved
the logic into a standalone crate so it's unit-testable without the GTK desktop
toolchain. The path references throughout this doc predate that pivot.)*

**Tauri commands:**
```
ocr_page_regions(image_bytes: Vec<u8>, source_lang: Lang) -> Vec<DetectedRegion>
ensure_ocr_models(source_lang: Lang) -> ModelStatus    // triggers lazy download
ocr_models_status(source_lang: Lang) -> ModelStatus    // downloaded? size? progress
```
`DetectedRegion = { id: u32, bbox: { x, y, w, h } /* image px */, original: String }`.
Download progress is streamed to the UI via Tauri events (same pattern as the
nightly-updater).

**Core abstractions:**
```rust
trait OcrEngine { fn recognize(&self, region: &RgbImage) -> Result<String>; }
//   MangaOcrEngine         (JP)    — manga-ocr ONNX
//   PaddleOcrEngine{ lang } (KO/ZH) — PaddleOCR rec ONNX

struct TextDetector { /* comic-text-detector ONNX */ }
    fn detect(&self, page: &RgbImage) -> Vec<BBox>;

// orchestrator: detect → for each box { crop → engine_for(lang).recognize } → collect
```

**Model manager:** a registry mapping `lang → [model files, URLs, sha256]`;
`ensure_ocr_models` downloads missing files into the app data dir, verifies
hashes, and built ONNX `Session`s are **cached** (not rebuilt per call).
Inference runs on a blocking worker (off the UI thread). `ort` selects NNAPI on
Android / CoreML on Apple / CPU elsewhere, falling back to CPU on init failure.

**Runtime:** one inference stack — **ONNX Runtime via the `ort` crate**. All
three model families (comic-text-detector, manga-ocr, PaddleOCR rec) export to
ONNX, so they share one runtime with hardware acceleration. Candle was rejected:
it would mean hand-porting each architecture (including the encoder-decoder
decode loop) — far more work and risk.

**Models are downloaded on first use** into app data, **not bundled** in the
APK (each language's models fetched lazily; ~150–500 MB total only if all three
languages are used). Size is shown before download.

**Image source:** page bytes come from foliate's existing `section.loadImage()`
(raw `Blob`) — no new decoding path.

## Frontend integration & UX

**The control.** Evolve today's `MangaBubbleToggler` (header, CBZ/CB7-only) into
one comic-translation control with two paths feeding the **same
`BubbleTranslationPopup`**:
- **Auto-translate page** (new, default) — runs the on-device pipeline on the
  visible page.
- **Translate region** (existing, fallback) — manual drag for a missed bubble.

The auto path does **OCR on-device + translate via the existing translators**,
so it works with a **keyless provider (Google)** — it does *not* require the AI
vision key the manual cloud path needs. Auto-translate is therefore more widely
usable than today's feature.

**Flow on enable / page change** (mirrors how `useTextTranslation` hooks
`load`/relocate):
1. Page bytes via `section.loadImage()` → `ensure_ocr_models(sourceLang)`
   (download UI if first use) → `ocr_page_regions(bytes, sourceLang)`.
2. Batch-translate the `original` strings through `useTranslator`
   (target = `translateTargetLang`, source = comic language).
3. Render an **overlay layer** above the page with one subtle marker per `bbox`;
   tap → popup with original + translation.
4. Cache `[{bbox, original, translation}]` per (book, section); re-run only on
   cache miss.

**Coordinate mapping.** The detector returns **image-pixel** boxes; the page is
rendered scaled by the fixed-layout/webtoon renderer. The overlay maps
image-px → rendered-px using the page's natural size and current scale — the
**same mapping `RegionSelectOverlay` already does** for drag coordinates, reused
rather than reinvented.

**Source language.** A per-comic source-language setting (JP/KO/ZH), defaulted
from `book.primaryLanguage` when present, else a small picker (defaults to JP).
It both routes OCR and sets the translator's source.

**Scope/gating.** Image formats (CBZ/CB7) only; shown when a translator is
configured. Works in both paged and webtoon modes (a tall webtoon strip is
detected on a downscaled copy — see Performance).

## Error handling (degrade gracefully, never block reading)

- **Model download fails / offline on first use** → toast with retry; auto stays
  off, manual region path (cloud) still works.
- **Zero regions detected** → "no text found" hint + offer manual region.
- **Per-region OCR failure** → skip that region (resilient, `allSettled`-style);
  don't fail the page.
- **Translation failure** → reuse existing translator error handling; popup shows
  the original alone.
- **ONNX/NNAPI init failure** → fall back to CPU execution provider; if still
  failing, disable auto mode with a clear message.
- **Unsupported source language** (e.g., an English comic) → auto-translate isn't
  offered.

## Performance

- ONNX `Session`s built once and cached; inference on a blocking worker.
- Per-page cache (TS + optional disk by image hash) → revisits instant.
- **Webtoon tall strips:** detect on a downscaled copy (detectors use a fixed
  input size anyway), map boxes back to full-res for cropping.
- Rough budget: detect (~hundreds ms) + N×OCR; a 5–15-bubble page ≈ 1–3 s on a
  phone CPU for an explicit action, then cached. Next-page background pre-OCR is
  a v2 optimization.

## Testing

- **Rust unit tests** per unit with tiny checked-in fixture images: detector
  (boxes within tolerance), each `OcrEngine` (known crop → expected text), model
  manager (download/verify/cache against a local file/mock), orchestrator
  (fixture page → expected regions).
- **TS tests:** the image-px → rendered-px mapping (pure fn), the orchestration
  hook (mock the Tauri command; assert translate + marker render), cache
  hit/miss.
- Model *accuracy* is not CI-tested (too heavy) — validated by a **manual
  on-device gate** on real manga/manhwa/manhua pages.

## Build phasing (each independently shippable)

1. **JP end-to-end:** `ort` integration + model manager + comic-text-detector +
   manga-ocr + the command + overlay/markers/popup + translation wiring. Manual
   gate on real manga.
2. **KO + ZH:** PaddleOCR engines behind the `OcrEngine` trait + source-language
   picker + manhwa/manhua detection validation.
3. **(Optional) polish:** next-page background pre-OCR, disk cache, and the
   immersive in-place overlay as a stretch.

## Open items to confirm during planning

- Exact model artifacts + licenses: comic-text-detector, manga-ocr-base,
  PaddleOCR KO/ZH recognition (and their ONNX exports / hosting location).
- `ort` build/linking for Android + iOS within the Tauri toolchain (native
  ONNX Runtime mobile libs, NNAPI/CoreML execution providers).
- Where downloaded models live and how they are versioned/garbage-collected.
