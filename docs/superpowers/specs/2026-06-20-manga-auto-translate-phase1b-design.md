# Comic Auto-Translate Phase 1b — Real Japanese OCR (design)

> Successor to the Phase 1 scaffold (`2026-06-18-manga-auto-translate-design.md`, shipped dark in PR #20). Phase 1 proved the ONNX runtime + the full capture→overlay→translate→popup UI loop against a deterministic stub. **Phase 1b replaces the stub with the real Japanese detection + recognition models**, so a manga page's bubbles are actually found, read, and translated on-device.

**Goal:** On Android, tap "Auto-translate page" on a Japanese comic → real bubbles are detected, OCR'd with manga-ocr, translated by the existing translator stack, and shown as tap-to-reveal markers — no stub.

**Scope (this iteration):** Japanese only, end-to-end, behind an `OcrEngine` trait so Korean/Chinese (PaddleOCR) slot in later without rework. Models are **downloaded on first use**. Real OCR ships on **Android** (the proven `ort` path); desktop is deferred.

**Tech stack:** Rust (`ort` ONNX Runtime via the existing `onnx` cargo feature, `image`, `tokenizers`, `reqwest`, `sha2`); the `manga-ocr` crate + `src-tauri/src/ocr.rs`. Frontend unchanged from Phase 1 except the first-use model-download UX.

---

## Architecture

Per comic page, the **Rust `manga-ocr` crate does detection + recognition**; **translation and rendering stay in the existing TypeScript layer** (100% reused from Phase 1). The backend returns the same `Vec<DetectedRegion>{ id, bbox, original }` contract the stub returned, so `ocr_page_regions`, `useAutoBubbleTranslate`, the overlay, and the popup are untouched.

```text
page image (bytes from the TS canvas capture)
  → [1 Detect]    comic-text-detector.onnx (1024² input) → text-block boxes
  → [2 Recognize] for each block: crop → manga-ocr (ViT encoder → greedy decoder) → JP text
  → Vec<DetectedRegion>{ id, bbox(image px), original }      ← unchanged contract
  → (unchanged TS) translateRegions → markers → BubbleTranslationPopup
```

This **replaces** `crates/manga-ocr/src/page.rs::detect_and_ocr` (the 2-fixed-box stub). The Tauri command signature, IPC, and all TS are identical to Phase 1.

### Models (pinned, mirrored)

| Role | Source | File(s) | Size (fp32) |
|---|---|---|---|
| Detection | `mayocream/comic-text-detector-onnx` (Apache-2.0, trained on Manga109-s) | `comic-text-detector.onnx` | 94.7 MB |
| Recognition | `l0wgear/manga-ocr-2025-onnx` (VisionEncoderDecoder) | `encoder_model.onnx`, `decoder_model.onnx`, `vocab.txt` | 22.4 + 118 MB |

Both are **mirrored to a `models-ja-v1` GitHub release on `julianshen/readest`** (stable, controlled CDN) rather than fetched from third-party HF repos at runtime. fp32 to start; int8 quantization is a later perf lever, not in this iteration.

## On-device recognition (the crux)

`manga-ocr` is a vision encoder-decoder, so recognition is **autoregressive**. Per detected block:

1. **Preprocess** the crop the manga-ocr way: grayscale → RGB, resize to 224×224, normalize (mean/std 0.5) → `pixel_values` tensor. (Exact constants verified against `preprocessor_config.json` at implementation time.)
2. **Encode** once: `encoder_model.onnx(pixel_values)` → `encoder_hidden_states`.
3. **Greedy decode loop**: start `input_ids = [BOS]`; repeat `decoder_model.onnx(input_ids, encoder_hidden_states)` → next-token logits → `argmax` → append; stop at `EOS` or a max length (~300). This repo ships **no KV-cache decoder**, so each step recomputes full attention — simpler, acceptable to start; KV-cache is a later perf lever.
4. **Detokenize** the BERT-Japanese WordPiece ids from `vocab.txt` (via the `tokenizers` crate), stripping special tokens and joining `##` subwords → the recognized string.

**Detection** runs `comic-text-detector.onnx` directly via `ort` (consistent with recognition; the `comic-text-detector` Rust crate will be evaluated during planning but is not a dependency). Its raw outputs (segmentation mask + line/box tensors) are post-processed into **text-block** boxes — one block ≈ one bubble = one `DetectedRegion`. Block bboxes are returned in the captured image's pixel space, matching the existing `mapImageBBoxToViewport` contract.

**Tensor I/O names + detector post-processing are the two empirical unknowns**, both resolved the way Phase 1 verified ORT: load the model, inspect inputs/outputs, assert against a fixture. Flagged as the first plan tasks.

## Model delivery & first-use UX

- New Tauri command **`ensure_ocr_models(lang: "ja") -> Result<(), String>`**: checks the cache dir `<appdata>/ocr-models/ja/`; if files are missing, downloads each from the GitHub release via `reqwest`, **verifies SHA-256** against hashes baked into the binary (rejects corrupt/tampered files), writes atomically (temp → rename), and emits `ocr-model-download` progress events (`{ received, total }`) for a TS progress bar.
- `ocr_page_regions` loads sessions from the cache dir (lazily; sessions cached in Rust state across calls so the models aren't re-read per page).
- **First-use UX (TS):** tapping ✨ when models aren't cached shows a confirm dialog ("Download Japanese OCR models · ~235 MB?") → on accept, calls `ensure_ocr_models` and shows a progress bar → then runs the page. Cached permanently; subsequent uses and offline work with no network. Download failure → toast + retry; partial files are cleaned up.

## `OcrEngine` trait & platform scoping

```rust
trait OcrEngine { fn recognize(&self, crop: &image::GrayImage) -> Result<String, String>; }
```

- JP impl `MangaOcrEngine` holds the encoder + decoder `ort::Session`s and the tokenizer.
- Detection is language-agnostic and separate. `detect_and_ocr(image, source_lang)` = detect blocks → `engine_for(source_lang)` → recognize each crop → collect regions. That `match source_lang` is the **only** seam KO/ZH need (add `PaddleOcrEngine` impls later).
- **Platform scoping:** the real pipeline needs `ort`, which the Phase 1 `onnx` cargo feature enables **only on Android** (desktop release builds can't compile `ort-sys` — the macOS-x86_64 prebuilt gap + MSRV 1.88). So the real `detect_and_ocr` body is `#[cfg(feature = "onnx")]`; the `#[cfg(not(feature = "onnx"))]` path returns a clean `"On-device OCR isn't available on this platform yet"` error. **Real OCR ships on Android this iteration**; desktop real-OCR waits until the desktop ORT story is solved (separate follow-up).

## Testing strategy

OCR is model-driven, but greedy decoding is deterministic, so most of the logic is unit-testable without shipping the 235 MB models:

- **Deterministic unit tests (no large models):**
  - manga-ocr preprocessing (image → normalized tensor values).
  - WordPiece detokenization from a small fixture `vocab.txt` (special-token stripping, `##` joining).
  - detector post-processing (synthetic mask/box tensors → expected block boxes, incl. NMS/merge).
  - the greedy decode loop driven by a **tiny synthetic encoder-decoder ONNX fixture** (the Phase 1 `add_one.onnx` trick) — proves the loop stops on EOS and threads `input_ids`/`encoder_hidden_states` correctly.
- **Opt-in integration test** (`#[ignore]` by default, run manually / when models are cached): real models on a committed fixture manga crop → assert the recognized JP string. Deterministic, so stable when run.
- **On-device manual gate** (like Phase 1): a real Japanese manga page on the emulator → bubbles detected at sane boxes, recognized text is correct JP, translated, tap-to-reveal works.

## Risks / unknowns (resolved early in the plan)

1. **Tensor I/O names** for encoder/decoder/detector — verify by loading each ONNX (first plan task).
2. **Detector post-processing** — the mask→blocks logic is the least-documented piece; spike it against a fixture image early.
3. **On-device perf** — no-KV-cache greedy decode × N blocks could be slow on a phone; measure on-device, and if needed pursue KV-cache and/or int8 (explicitly out of scope here, noted as the next lever).
4. **manga-ocr preprocessing exactness** — wrong normalization silently wrecks accuracy; pin from `preprocessor_config.json` and cross-check against a known crop.

## Out of scope (explicit)

- Korean/Chinese OCR (PaddleOCR) — the trait seam is built, impls are a later iteration.
- Desktop real-OCR — blocked on the desktop ORT story; Android-only this iteration.
- int8 quantization / KV-cache decoder — perf levers for later, only if on-device measurement demands them.
- Source-language auto-detection — JP is assumed (the only engine); a per-book picker arrives with KO/ZH.
