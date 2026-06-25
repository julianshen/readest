# int8 detector model (design)

**Goal:** Replace the fp32 `comic-text-detector.onnx` (94.7 MB) with a dynamic-int8-quantized version (53.4 MB), cutting the OCR model download by ~41 MB (~37% of the total OCR download) with detection accuracy preserved.

**Scope:** swap the detector model the app downloads. **Out of scope:** quantizing the recognition models (the spike showed dynamic int8 gives them *no* size benefit; static int8 is accuracy-risky + deferred), and any code-path change (ort runs int8 ONNX transparently).

## Background (verified by the int8 spike, 2026-06-25)

- **Dynamic int8** quantization (`onnxruntime.quantization.quantize_dynamic`, `QUInt8`) of the detector: **94.7 MB → 53.4 MB** (1.77×). The Conv backbone isn't dynamic-quantizable; the MatMul-type ops are. (The rec models got 0 reduction from dynamic int8 — hence detector-only.)
- **Accuracy preserved:** on a synthetic manga page, fp32 max box-confidence 0.627 (18 boxes > 0.3) vs **int8 0.551 (22 boxes > 0.3)** — comfortably above the 0.3 detect threshold. Recognition is untouched (rec models unchanged).
- The detector is **language-agnostic and shared** across ja/ko/zh (post-#27, stored once in `ocr-models/shared/`), referenced via the `JA_DETECTOR_URL` / `JA_DETECTOR_SHA` consts in `models.rs`.
- The quantized model is **already hosted**: `comic-text-detector.int8.onnx` on the `models-ja-v1` release (URL returns 200, 53,352,863 B), SHA-256 `d6b4b1136f028a65eade6316c9c7707fab2c59fa08d20b46a75e68b814773aa2`.

## Design

**One code change** in `crates/manga-ocr/src/models.rs`:
- `JA_DETECTOR_URL` → `https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.int8.onnx`
- `JA_DETECTOR_SHA` → `d6b4b1136f028a65eade6316c9c7707fab2c59fa08d20b46a75e68b814773aa2`

The local cache filename (`DETECTOR_FILE = "comic-text-detector.onnx"`) is **unchanged** — only the downloaded content + its pinned SHA change. All three manifests (ja/ko/zh) read the const, so they switch together. The Rust/ort load path is unchanged.

## Migration / compatibility (composes with #27)

Existing v0.13.0 users have a cached **fp32** detector (old SHA). After updating to a build with this change:
- `ocr_models_present` → cached fp32 SHA ≠ new int8 SHA → returns false → re-download the 53 MB int8 detector once.
- #27's **migrate-move** correctly does *not* migrate the fp32 copy (its bytes fail `verify_sha256` against the int8 SHA); the post-download **orphan cleanup** then removes the stale fp32 copy from the lang dir.

Net: existing users re-download the smaller detector once and end up with the int8 model in `shared/`, fp32 orphan cleaned.

## Error handling
Corrupt download → existing per-file SHA-verify + `.part` cleanup (unchanged). If the int8 ONNX failed to load on a device's ORT, `OcrPipeline::load` returns the existing "load OCR models" error — but the spike confirms it's a standard opset-11 ONNX that ort runs.

## Testing
- **Crate unit:** the existing `ja_manifest_has_four_valid_entries`, `ko_zh_manifests_valid_and_share_detector`, and `detector_is_the_only_shared_file` tests still pass (they check field shapes + the shared-detector invariant — both hold; only the URL/SHA *values* change). No new unit test needed: a value change is best verified by the on-device gate, not a brittle URL-string assertion.
- **On-device gate (Android tablet):** fresh install → ✨ → confirm the **int8** detector (~53 MB, not 94 MB) downloads to `ocr-models/shared/` (check `run-as ls -la` size) → OCR detect + recognize + translate still works (markers + translation). This is the one new variable: the int8 ONNX running on Android ORT.

## Risks
- int8 detection confidence is slightly lower (0.627 → 0.551 on synthetic) but well above threshold; real manga scores ~0.98 fp32, so the int8 margin is large. Low risk.
- int8-on-Android-ORT is the only unproven bit — covered by the on-device gate (and it's a standard opset-11 ONNX, same load-dynamic path already shipping).
