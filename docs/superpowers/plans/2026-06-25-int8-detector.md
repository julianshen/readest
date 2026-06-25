# int8 detector model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point the OCR detector download at the dynamic-int8-quantized `comic-text-detector.int8.onnx` (53.4 MB) instead of the fp32 model (94.7 MB), preserving detection accuracy.

**Architecture:** A two-value change to the shared detector consts in `models.rs` (`JA_DETECTOR_URL` + `JA_DETECTOR_SHA`); all three language manifests read those consts, so ja/ko/zh switch together. The cache filename and the Rust/ort load path are unchanged (ort runs int8 ONNX transparently). The quantized model is already hosted + accuracy-verified.

**Tech Stack:** Rust (`manga-ocr` crate). No new deps, no new code paths.

**Context (verified):**
- `crates/manga-ocr/src/models.rs:29-31`:
  ```rust
  const JA_DETECTOR_URL: &str =
      "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.onnx";
  const JA_DETECTOR_SHA: &str = "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f";
  ```
- The int8 model is hosted at `.../models-ja-v1/comic-text-detector.int8.onnx` (53,352,863 B, URL returns 200), SHA-256 `d6b4b1136f028a65eade6316c9c7707fab2c59fa08d20b46a75e68b814773aa2` (from the int8 spike, 2026-06-25).
- Existing tests `ja_manifest_has_four_valid_entries`, `ko_zh_manifests_valid_and_share_detector`, `detector_is_the_only_shared_file` assert field shapes + the shared-detector invariant — all hold across this value change.
- Run crate tests: `cd apps/readest-app && cargo test -p manga-ocr`. Branch `perf/int8-detector` exists (this plan + the spec are committed on it).

## File Structure

| File | Change |
|---|---|
| `crates/manga-ocr/src/models.rs` (modify) | `JA_DETECTOR_URL` + `JA_DETECTOR_SHA` → the int8 asset. |

---

### Task 1: Point the detector consts at the int8 model

**Files:** Modify `crates/manga-ocr/src/models.rs:29-31`.

- [ ] **Step 1: Edit the consts.** Replace:

```rust
const JA_DETECTOR_URL: &str =
    "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.onnx";
const JA_DETECTOR_SHA: &str = "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f";
```

with:

```rust
// Dynamic-int8 quantized detector (53.4 MB vs 94.7 MB fp32); detection accuracy
// preserved (verified). The cache filename stays `comic-text-detector.onnx`.
const JA_DETECTOR_URL: &str = "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.int8.onnx";
const JA_DETECTOR_SHA: &str = "d6b4b1136f028a65eade6316c9c7707fab2c59fa08d20b46a75e68b814773aa2";
```

- [ ] **Step 2: Run the crate tests** — confirm the existing manifest tests still pass (they check `sha256.len()==64`, `url.starts_with("https://")`, and the shared-detector invariant — all hold for the new values):

Run: `cd apps/readest-app && cargo test -p manga-ocr models`
Expected: PASS (4 tests: `verify_sha256_known_vectors`, `ja_manifest_has_four_valid_entries`, `ko_zh_manifests_valid_and_share_detector`, `ctc_spec_and_manifest_for_dispatch`).

- [ ] **Step 3: Sanity-check the URL + SHA are live** (not part of the build, but confirm the pinned values match the hosted asset):

Run: `curl -sL "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.int8.onnx" | sha256sum`
Expected: `d6b4b1136f028a65eade6316c9c7707fab2c59fa08d20b46a75e68b814773aa2`

- [ ] **Step 4: Format + commit.** `cargo fmt -p manga-ocr`, then:

```bash
git add crates/manga-ocr/src/models.rs
git commit -m "perf(ocr): use int8-quantized detector (94.7MB -> 53.4MB)"
```

### Task 2: On-device gate (int8 detector downloads + OCR works)

**Files:** none (verification). Per [[android-build-flow]] in `.agents/memory`; use the **4 GB tablet AVD (emulator-5556)** + the state-aware toolbar reveal (see [[comic-auto-translate-phase1]]).

- [ ] **Step 1:** `pnpm android:onnx`, build the debug x86_64 APK, strip/sign/install on emulator-5556 (uninstall first → empty cache).
- [ ] **Step 2:** Import + open the ZH test CBZ → ✨ → auto-detect → accept the download.
- [ ] **Step 3:** Verify the **int8** detector landed (smaller!): `adb -s emulator-5556 shell run-as com.jlnshen.reader stat -c %s ocr-models/shared/comic-text-detector.onnx` → **≈ 53,352,863 B** (the int8 size, NOT ~94 MB). This confirms the new URL/SHA are in effect.
- [ ] **Step 4:** Confirm OCR still works end-to-end with the int8 detector — markers appear on the bubbles and a tap shows the translation (e.g. `你好!`→ translation). This proves the int8 ONNX runs on Android ORT and detection still fires on a real device.
- [ ] **Step 5:** Capture the `stat` size + a screenshot. Note any deviation.

## Final verification
- `cargo test -p manga-ocr` (all pass; the manifest tests cover the new values' shape). On-device: int8 detector (~53 MB) downloads to `ocr-models/shared/`, OCR detect+recognize+translate works.

## Self-review
- **Spec coverage:** const swap (T1), the migration/compat behavior is inherited from #27 (no new code — covered by the spec's reasoning + the on-device fresh-install gate, T2), on-device int8-on-ORT verification (T2). Accuracy was verified in the spike (pre-plan). All mapped.
- **Placeholder scan:** none — the URL + SHA are the real hosted values.
- **Type consistency:** only two `&'static str` const values change; no signatures touched. The existing tests assert the invariants that still hold.
- **YAGNI note:** no new unit test is added — asserting a specific URL string would be a brittle config-mirror; the value change is verified by the existing shape tests + the on-device gate (the meaningful check: does the int8 model download + run on a device).
