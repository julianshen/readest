# Korean + Chinese on-device OCR for comic auto-translate (design)

**Goal:** Extend the on-device whole-page auto-translate feature from **Japanese-only** to **Korean and Chinese (Simplified + Traditional)**, with a per-book source-language that auto-detects from metadata and can be overridden. Detection is reused unchanged; only recognition becomes multi-language.

**Scope:** Korean (manhwa) + Chinese (manhua, Simplified and Traditional) recognition, plus the source-language resolution/picker. **Out of scope (tracked as separate Phase 1c sub-projects):** desktop OCR (blocked on the `ort` desktop build story), perf (int8/KV-cache), model fine-tuning, and any new translation providers. This is the third increment of the comic auto-translate initiative (Phase 1 stub → 1b real Japanese → **1c KO/ZH**).

## Background (verified against current code)

- **Recognition is the only language-specific stage.** `comic-text-detector` (`crates/manga-ocr/src/detect.rs`) is language-agnostic — it returns text-block bounding boxes with zero language knowledge. Recognition (`recognize.rs`) is Japanese-specific.
- **The seam exists but is hardcoded.** `OcrEngine` trait (`recognize.rs:18-20`) defines `recognize(&mut self, crop: &GrayImage) -> Result<String, String>`. `OcrPipeline` (`pipeline.rs`) holds a single `ja_engine: MangaOcrEngine` and `run(image, source_lang)` does `if source_lang != "ja" { return Err(...) }` (`pipeline.rs:39-41`).
- **Source language is hardcoded to `'ja'`** in `AutoBubblePageTranslator.tsx:25` (`const OCR_SOURCE_LANG = 'ja'`), passed to `ocrModelsPresent`/`ensureOcrModels`/`run`/translate-`langs`. The three Rust entry points (`ensure_ocr_models`, `ocr_models_present`, `ocr_page_regions` in `src-tauri/src/ocr.rs`) already accept `lang: String` but guard `!= "ja"`.
- **Models download on first use.** `models.rs:ja_manifest()` lists 4 files pinned by SHA-256, hosted on the `models-ja-v1` GitHub release, cached under `app_data_dir/ocr-models/<lang>/` (the per-language dir already keys on lang). `ocr.rs` streams each file to `.part` with incremental SHA-256 then atomically renames.
- **Book language metadata already exists.** `book.primaryLanguage` is computed by `getPrimaryLanguage(metadata.language)` (`utils/book.ts:178`), which normalizes EPUB `<dc:language>` and ComicInfo `<LanguageISO>` to an ISO 639-1 code. Per-book settings persist via `BookConfig.viewSettings` (`types/book.ts:433`, `ViewSettings` at `:374`).
- **OCR is Android-only this phase.** The ✨ button (`MangaBubbleToggler.tsx`) and the `<AutoBubblePageTranslator>` mount (`BooksGrid.tsx`) gate on `appService.osPlatform === 'android'`; `ocr_page_regions` is `#[cfg(target_os = "android")]` and returns "unavailable" elsewhere. The `onnx` cargo feature on `manga-ocr` is enabled only for Android (`src-tauri/Cargo.toml`).

### Model decision (from the research spike, all sources Apache-2.0)

| Lang | Model | Size | ONNX source | Decode |
|---|---|---|---|---|
| **ZH** (Simplified + Traditional + JP) | `PaddlePaddle/PP-OCRv5_mobile_rec_onnx` (`inference.onnx` + dict from `inference.yml`) | ~16.5 MB | **Official, turnkey** | CTC |
| **KO** | `korean_PP-OCRv5_mobile_rec` self-converted via `paddle2onnx` (community `monkt/paddleocr-onnx` as fallback) | ~13.4 MB | Self-convert (opset 17, dynamic shape) | CTC |
| **JA** | existing `manga-ocr` (unchanged) | — | unchanged | seq2seq |

- **One Chinese model covers Simplified + Traditional** (18,383-char unified dict) — no third model.
- **Both KO and ZH are PP-OCRv5 CTC** → a single shared `CtcRecognizer`, not two structs.
- **No unified ja+ko+zh model:** PP-OCRv5's unified rec excludes Korean, and VLM recognizers both regress on vertical Japanese and are undeployable on a phone. Per-language recognition (our existing architecture) is correct.

## Design

### 1. Recognition engine — `CtcRecognizer` (new)

One engine, shared by KO and ZH (identical PP-OCRv5 CTC code; only the loaded artifacts differ). Implements the existing `OcrEngine` trait, so `pipeline.rs` consumes it uniformly.

```rust
pub struct CtcRecognizer {
    session: ort::session::Session,
    dict: Vec<String>,   // index 0 reserved for CTC blank
    input_h: u32,        // 48 (official v5) or 32 (community KO) — from the manifest, never hardcoded
}
impl OcrEngine for CtcRecognizer {
    fn recognize(&mut self, crop: &GrayImage) -> Result<String, String> { /* preprocess → forward → CTC decode */ }
}
```

- **Preprocess** (new fn in `preprocess.rs`): the recognizer wants a color line image. From the detector crop: resize keeping aspect ratio to height `input_h` (bilinear), convert to **BGR** (PaddleOCR trained on OpenCV BGR — no RGB swap), normalize `(x/255 − 0.5)/0.5`, lay out CHW, right-zero-pad width. Width is dynamic (driven like the existing decoder's dynamic seq-len).
- **CTC greedy decode** (new `ctc.rs`, or a function beside the existing detok): logits `[1,T,C]` → argmax per timestep (**reuse existing `argmax`**) → collapse consecutive duplicates → drop blank (index 0) → map index→char via `dict` → concatenate (no spaces for CJK). Honor the **blank-offset**: network index `i` ↔ `dict[i]` with `dict[0] = "<blank>"` placeholder (equivalently `dict_file[i-1]`).
- Reuses the `ort` session/`TensorRef`/`try_extract_tensor` patterns from `MangaOcrEngine`. Does **not** touch the Japanese seq2seq path.

### 2. Model manifests (`models.rs`)

Add `ko_manifest()` and `zh_manifest()` mirroring `ja_manifest()`. The detector file is shared across languages (same SHA). Each recognition manifest records the rec `.onnx`, the dict file, **and the model's input height** (so preprocess reads it rather than hardcoding). New GitHub releases `models-ko-v1` and `models-zh-v1` on `julianshen/readest`, SHA-256 pinned.

`ModelFile` gains the per-model `input_h` where needed (or a small `RecModelSpec { files, dict_name, input_h }`); the JA manifest is unaffected.

### 3. Pipeline dispatch (`pipeline.rs`, `ocr.rs`)

- `OcrPipeline::load(model_dir, lang)` constructs the detector (shared) plus **only the requested language's engine**: `ja` → `MangaOcrEngine`, `ko`/`zh` → `CtcRecognizer` (from that lang's manifest). It does not load all three.
- `run(image, lang)` dispatches to the loaded engine; an unsupported lang returns `Err` (kept as a guard).
- `ensure_ocr_models` / `ocr_models_present` (`ocr.rs`): replace the `!= "ja"` guards with validation against the supported set `{ja, ko, zh}` and dispatch to the right manifest. The streamed-download, SHA-verify, and per-language cache-dir logic is otherwise unchanged.
- The lazy `static Mutex<OcrPipeline>` becomes keyed by language (a small map or "reload when the requested lang differs from the loaded one"), so switching books/languages reloads the right engine.

### 4. Source-language resolution (`services/ocr/sourceLang.ts`, new)

```ts
export type OcrSourceLang = 'ja' | 'ko' | 'zh';
// remembered per-book override → else map book.primaryLanguage → else null (unknown)
export const resolveOcrSourceLang = (book: Book, remembered?: OcrSourceLang): OcrSourceLang | null
```

- Mapping: `ja→ja`, `ko→ko`, any `zh*` (`zh`, `zh-CN`, `zh-TW`, `zh-Hans`, `zh-Hant`) → `zh`; anything else → `null`.
- The override persists in `BookConfig.viewSettings` via a new optional field `ocrSourceLang?: OcrSourceLang` (a new small `OcrConfig` mixed into `ViewSettings`, consistent with the other config groups).

### 5. Picker UI + threading (`MangaBubbleToggler.tsx`, `AutoBubblePageTranslator.tsx`)

- Replace `const OCR_SOURCE_LANG = 'ja'` with the resolved language; thread it into `ocrModelsPresent(lang)`, `ensureOcrModels(lang)`, `run({ sourceLang })`, and the translate `langs.source`.
- The ✨ button gains a compact **language menu** (Japanese / Korean / Chinese):
  - Auto-detect confident → run silently in the detected language.
  - Unknown (`null`) → the menu opens instead of running (no silent wrong-language OCR).
  - User picks/changes → writes the per-book override, then runs.
- The model-download confirm + the in-flight spinner name the chosen language.
- The Android-only gate is unchanged (desktop is sub-project B).

## Data flow

`book.primaryLanguage` (or remembered override) → `resolveOcrSourceLang` → ✨ tap → `ensureOcrModels(lang)` (downloads the KO/ZH set on first use) → `ocr_page_regions(bytes, lang)` → Rust dispatch (ja seq2seq / ko·zh CTC) → `DetectedRegion[]` → existing TS batch-translate (`source: lang`) → overlay markers + `BubbleTranslationPopup`. Identical to the JA path except the engine and the model set.

## Error handling

- **Undetected language** → ✨ opens the picker rather than guessing.
- **Unsupported lang at the Rust boundary** → `Err` (defensive; UI shouldn't allow it).
- **Model download failure** → existing per-file SHA-verify + `.part` atomic-rename error path, reused unchanged; the language name appears in the message.
- **Domain mismatch (the real risk):** every model is document/scene-trained, not comic-trained. **Acceptance bar = plausible translations on typical *printed* manhwa/manhua bubbles**, not stylized SFX or vertical-art lettering. Detector-crop tightness is the quality lever; fine-tuning is a future sub-project.

## Testing

- **Rust unit:** CTC decode (argmax → collapse dupes → drop blank → dict map, including the blank off-by-one); `ko_manifest`/`zh_manifest` validity (4 fields, https URLs, 64-hex SHA, plausible `input_h`); pipeline dispatch (ja→seq2seq, ko/zh→ctc, unsupported→`Err`). Real-model E2E stays `#[ignore]` (needs a local `MODEL_DIR`).
- **TS unit:** `resolveOcrSourceLang` truth table (metadata `ja`/`ko`/`zh`/`zh-CN`/unknown; override precedence over metadata); the picker writes the per-book override to config.
- **On-device gate (make-or-break):** a real Korean manhwa **and** a real Chinese (Simplified) manhua on the emulator → ✨ → download → detect → CTC recognize → translate → markers + popup, in the correct language. Capture screenshots.

## Model prep (one-time, before/with implementation)

Mirror the `models-ja-v1` process: fetch `PP-OCRv5_mobile_rec_onnx` (ZH, turnkey) and convert the Korean PP-OCRv5 rec via `paddle2onnx --opset_version 17` with dynamic shape (community `monkt` ONNX as fallback), extract each dict from the model's `inference.yml`/`config.json`, record each model's input height, compute SHA-256, and upload to `models-ko-v1` / `models-zh-v1` releases. Pin those SHAs in `models.rs`.

## Risks / unknowns

1. **Korean ONNX provenance.** Self-converting the official model needs a one-time `paddle2onnx` toolchain; if that's impractical, re-host the community `monkt/paddleocr-onnx` (Apache-2.0) and pin its SHA + its input height (32, not 48).
2. **Comic-bubble accuracy.** Document-trained models on stylized bubbles — mitigated by tight detector crops and a realistic acceptance bar; not fully solvable without fine-tuning.
3. **Per-model preprocess params.** Input height (and any width cap) differ between the official v5 (48) and community KO (32) artifacts — must come from the manifest, asserted by a unit test, never hardcoded.
