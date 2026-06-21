# Comic Auto-Translate Phase 1b — Real Japanese OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 1 stub with real on-device Japanese bubble detection + OCR (`comic-text-detector` + `manga-ocr`, ONNX via `ort`), behind an `OcrEngine` trait, with models downloaded on first use. Android-only this iteration.

**Architecture:** All detection + recognition lives in the GTK-free `manga-ocr` Rust crate (testable without the Tauri/GTK toolchain). `detect_and_ocr(image, source_lang)` = detect text blocks → recognize each crop with the JP engine → return `Vec<DetectedRegion>` (the exact contract Phase 1 already wired). Model download + progress live in `src-tauri/src/ocr.rs`. The frontend reuses the Phase 1 loop, adding only a first-use download confirm + progress.

**Tech Stack:** Rust (`ort`, `image`, `ndarray`, `tokenizers`, `sha2`, `reqwest`), the `onnx` cargo feature (Android), vitest/React for the small frontend addition.

**Context the implementer needs (verified facts):**
- Phase 1 shipped (PR #20). The crate is `apps/readest-app/crates/manga-ocr` with `src/{lib,page,runtime}.rs`; ONNX is behind the default-OFF `onnx` cargo feature (Android enables it via `src-tauri/Cargo.toml` target-dep; desktop tests use `cargo test -p manga-ocr --features onnx`). `runtime.rs` shows the working `ort` patterns: `Session::builder()?.commit_from_memory(bytes)`, `TensorRef::from_array_view(view)`, `session.run(ort::inputs![...])`, `outputs["y"].try_extract_tensor::<f32>()?.1.to_vec()`.
- `page.rs::detect_and_ocr(image_bytes: &[u8], source_lang: &str) -> Result<Vec<DetectedRegion>, String>` is the stub to replace. `DetectedRegion { id: u32, bbox: BBox{x,y,w,h: u32}, original: String }` (serde camelCase) — DO NOT change this type; the frontend depends on it.
- Tauri commands are in `src-tauri/src/ocr.rs`, registered in `src-tauri/src/lib.rs` `generate_handler![...]`. Commands return `Result<T,String>`, run via `tauri::async_runtime::spawn_blocking`. Tauri event emit: `app_handle.emit("event-name", payload)?` (serde payload).
- Models (mirror these to a `models-ja-v1` GitHub release on `julianshen/readest` as the first manual step): `comic-text-detector.onnx` (94.7 MB, from `mayocream/comic-text-detector-onnx`), `encoder_model.onnx` (22.4 MB) + `decoder_model.onnx` (118 MB) + `vocab.txt` (from `l0wgear/manga-ocr-2025-onnx`).
- Run all commands from `apps/readest-app/`. Branch already created: `feat/manga-ocr-phase1b`.
- Tests: `cargo test -p manga-ocr --features onnx` (Rust), `pnpm test -- <path>` (TS). Verification gates: `pnpm lint`, `pnpm fmt:check`, `pnpm clippy:check`, `pnpm test:rust`.

## Prep + spike findings (done 2026-06-20)

**Models mirrored** to GitHub release `models-ja-v1` on `julianshen/readest` (download base `https://github.com/julianshen/readest/releases/download/models-ja-v1/`). Download URL + SHA verify confirmed working. **Real SHA-256 (use these in Task B1 `ja_manifest`):**
- `comic-text-detector.onnx` (94,669,756 B) — `1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f`
- `encoder_model.onnx` (22,356,885 B) — `f87668ae0f62d6f032dac6b213e8c0fea84cd15895ac8cab624cc9a2f49d4a27`
- `decoder_model.onnx` (118,053,454 B) — `6b1fb216d542c4b2a4fa5b9d7ae3522081eb85fb959d2cecd28055af956a8a5e`
- `vocab.txt` (24,072 B) — `344fbb6b8bf18c57839e924e2c9365434697e0227fac00b88bb4899b78aa594d`

**Task A1 — ONNX I/O (resolved, supersedes the inspector-bin spike):**
- `encoder_model.onnx`: IN `pixel_values` f32 `[N,C,H,W]` → OUT `last_hidden_state` f32 `[N,197,192]`. (ViT, 224² ⇒ 196 patches +1 CLS = 197; hidden 192.)
- `decoder_model.onnx`: IN `input_ids` **i64** `[N,seq]`, `encoder_hidden_states` f32 `[N,enc,192]` → OUT `logits` f32 `[N,seq,6144]`. Greedy = argmax over the 6144-wide last step; vocab size 6144. No KV-cache input → recompute each step.
- `comic-text-detector.onnx`: IN `images` f32 `[1,3,1024,1024]` → OUT `blk` f32 `[1,64512,7]` (YOLO-style: 64512 anchors × `[cx,cy,w,h,conf,cls0,cls1]`), `seg` f32 `[1,1,1024,1024]`, `det` f32 `[1,2,1024,1024]` (masks).

**Task A2 — detector post-processing recipe:** use the `blk` YOLO output for text-block boxes (the seg/det masks are for lettering/removal, not needed for our box list). Recipe = decode `blk` (`cx,cy,w,h`→xyxy), filter by `conf`, class-agnostic NMS, then map 1024² coords back through the letterbox to original-image px. Mirror `dmMaze/comic-text-detector/inference.py::postprocess_yolo` for thresholds (conf≈0.4, nms≈0.35) — confirm/tune against a fixture in Task B6. So Tasks A1/A2 are DONE; start at B1.

## File Structure

| File | Responsibility |
|---|---|
| `crates/manga-ocr/Cargo.toml` (modify) | Add `tokenizers`, `sha2` deps (behind/with the `onnx` feature where they need ndarray/ort). |
| `crates/manga-ocr/src/models.rs` (create) | Model manifest: filenames, release URLs, expected SHA-256; cache-path helpers; pure `verify_sha256(bytes, hex) -> bool`. |
| `crates/manga-ocr/src/preprocess.rs` (create) | Pure image→tensor: manga-ocr 224² grayscale→RGB normalize; detector 1024² letterbox. Returns `ndarray` arrays. |
| `crates/manga-ocr/src/tokenizer.rs` (create) | WordPiece detok from `vocab.txt`: ids→string (strip specials, join `##`). |
| `crates/manga-ocr/src/recognize.rs` (create) | `OcrEngine` trait; `MangaOcrEngine` (encoder+decoder sessions + vocab): preprocess→encode→greedy-decode→detok. |
| `crates/manga-ocr/src/detect.rs` (create) | `Detector` (detector session): run + post-process raw outputs → `Vec<BBox>` text blocks. |
| `crates/manga-ocr/src/page.rs` (modify) | `detect_and_ocr` orchestration (real, `#[cfg(feature="onnx")]`); non-onnx path returns a clean error. Keep `BBox`/`DetectedRegion`. |
| `crates/manga-ocr/src/lib.rs` (modify) | Wire new modules. |
| `crates/manga-ocr/tests-fixtures/` | tiny `enc_dec.onnx` (greedy-loop fixture), small `vocab.txt`, `detector_mask.npy`-equivalent fixture, `sample_crop.png`. |
| `src-tauri/src/ocr.rs` (modify) | `ensure_ocr_models("ja")` (reqwest download → sha verify → atomic write → `ocr-model-download` progress events); `ocr_page_regions` loads cached sessions (cached in Tauri state). |
| `src-tauri/Cargo.toml` (modify) | Ensure `manga-ocr` Android dep has the model features; `sha2`/`reqwest` already present in src-tauri. |
| `src/services/ocr/modelDownload.ts` (create) | `ensureOcrModels(lang)` invoke + `onOcrModelProgress` listener. |
| `src/app/reader/components/annotator/AutoBubblePageTranslator.tsx` (modify) | Before `run()`: ensure models (confirm if absent) + show progress. |
| `public/locales/*` (modify) | New strings. |

---

## PHASE A — Spikes (resolve the empirical unknowns first)

### Task A1: Discover ONNX I/O for all three models

**Files:**
- Create: `crates/manga-ocr/src/bin/inspect_onnx.rs` (throwaway helper; deleted at end of phase)

- [ ] **Step 1: Write an inspector that prints input/output names, shapes, dtypes**

```rust
// cargo run -p manga-ocr --features onnx --bin inspect_onnx -- <model.onnx>
use ort::session::Session;
fn main() {
    let path = std::env::args().nth(1).expect("model path");
    let s = Session::builder().unwrap().commit_from_file(&path).unwrap();
    println!("== {path} ==");
    for i in &s.inputs { println!("IN  {} {:?}", i.name, i.input_type); }
    for o in &s.outputs { println!("OUT {} {:?}", o.name, o.output_type); }
}
```

- [ ] **Step 2: Run it on the three real models (downloaded once to /tmp) and record results**

Run: `cargo run -p manga-ocr --features onnx --bin inspect_onnx -- /tmp/encoder_model.onnx` (then decoder, then detector).
Expected: concrete tensor names/shapes. **Record them in a comment block at the top of `recognize.rs`/`detect.rs`** (e.g. encoder in `pixel_values [N,3,224,224]` → out `last_hidden_state`; decoder in `input_ids`,`encoder_hidden_states` → out `logits`; detector in `images [N,3,1024,1024]` → out `{blk, mask, lines}`). These names parameterize Tasks B5, B7, C.

- [ ] **Step 3: Commit the recorded findings** (the inspector bin stays until Phase B is done, then is removed in Task B8).

```bash
git add crates/manga-ocr/src/bin/inspect_onnx.rs crates/manga-ocr/src/recognize.rs
git commit -m "spike(ocr): record encoder/decoder/detector ONNX I/O"
```

### Task A2: Spike detector post-processing

**Files:** scratch notebook/notes (record in `detect.rs` header comment)

- [ ] **Step 1:** Using the real detector on a fixture manga page (via the inspector or a scratch test), determine how raw outputs map to text-block boxes. Reference `dmMaze/comic-text-detector/inference.py` (`TextBlock` grouping, the seg-mask + bbox decode, confidence threshold, NMS). Record the exact decode recipe (threshold, how blocks are formed) as a comment in `detect.rs`. This recipe is implemented + unit-tested in Task B7.

---

## PHASE B — Crate core (pure + model logic, TDD)

### Task B1: Model manifest + SHA-256 verify

**Files:**
- Create: `crates/manga-ocr/src/models.rs`
- Test: same file `#[cfg(test)]`
- Modify: `crates/manga-ocr/src/lib.rs` (`pub mod models;`)

- [ ] **Step 1: Failing test**

```rust
#[test]
fn verifies_sha256() {
    // sha256 of "abc"
    let want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    assert!(verify_sha256(b"abc", want));
    assert!(!verify_sha256(b"abd", want));
}
#[test]
fn manifest_lists_ja_files() {
    let m = ja_manifest();
    assert_eq!(m.len(), 4); // detector, encoder, decoder, vocab
    assert!(m.iter().all(|f| !f.sha256.is_empty() && f.url.starts_with("https://")));
}
```

- [ ] **Step 2: Run → fail.** Run: `cargo test -p manga-ocr models`. Expected: FAIL (unresolved).

- [ ] **Step 3: Implement**

```rust
use sha2::{Digest, Sha256};

pub struct ModelFile { pub name: &'static str, pub url: &'static str, pub sha256: &'static str }

pub fn verify_sha256(bytes: &[u8], hex: &str) -> bool {
    let mut h = Sha256::new();
    h.update(bytes);
    let got = h.finalize();
    hex::encode(got).eq_ignore_ascii_case(hex)
}

// URLs + hashes filled in after the models are mirrored to the release (manual prep step).
pub fn ja_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile { name: "comic-text-detector.onnx", url: "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.onnx", sha256: "<DETECTOR_SHA>" },
        ModelFile { name: "encoder_model.onnx", url: "<...>/encoder_model.onnx", sha256: "<ENCODER_SHA>" },
        ModelFile { name: "decoder_model.onnx", url: "<...>/decoder_model.onnx", sha256: "<DECODER_SHA>" },
        ModelFile { name: "vocab.txt", url: "<...>/vocab.txt", sha256: "<VOCAB_SHA>" },
    ]
}
```

Add to `Cargo.toml`: `sha2 = "0.10"`, `hex = "0.4"` (both pure, no feature gate). The `<..._SHA>` placeholders are filled from `sha256sum` of the mirrored files during the manual prep step (recorded in the PR description).

- [ ] **Step 4: Run → pass.** Run: `cargo test -p manga-ocr models`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(ocr): JP model manifest + sha256 verify"`

### Task B2: manga-ocr preprocessing

**Files:** Create `crates/manga-ocr/src/preprocess.rs`; modify `lib.rs`.

- [ ] **Step 1: Failing test** — feed a known 2×2 gray image, assert the normalized tensor values + shape `[1,3,224,224]`.

```rust
#[test]
fn manga_ocr_preprocess_shape_and_norm() {
    let img = image::GrayImage::from_raw(2, 2, vec![0, 255, 0, 255]).unwrap();
    let t = manga_ocr_pixels(&img); // ndarray Array4<f32>
    assert_eq!(t.shape(), &[1, 3, 224, 224]);
    // normalize (x/255 - 0.5)/0.5 → 0 maps to -1.0, 255 maps to 1.0
    assert!((t[[0,0,0,0]] - -1.0).abs() < 1e-4);
}
```

- [ ] **Step 2: Run → fail.** `cargo test -p manga-ocr preprocess`.
- [ ] **Step 3: Implement** `manga_ocr_pixels(&GrayImage) -> Array4<f32>`: resize to 224×224 (bilinear via `image`), replicate gray→3ch, normalize `(v/255 - mean)/std` with mean=std=0.5 (confirm against `preprocessor_config.json` from A1; adjust constants if it differs). Also `detector_pixels(&RgbImage) -> (Array4<f32>, Letterbox)` resizing/letterboxing to 1024² (record scale+pad for un-projecting boxes). `ndarray` is already a crate dep under the `onnx` feature — gate these `#[cfg(feature="onnx")]` since they return ndarray, OR add ndarray unconditionally (preferred: add `ndarray` as a normal dep so preprocessing is testable without onnx).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ocr): image preprocessing for detector + manga-ocr"`

### Task B3: WordPiece detokenization

**Files:** Create `crates/manga-ocr/src/tokenizer.rs`; add fixture `tests-fixtures/mini_vocab.txt`.

- [ ] **Step 1: Failing test** with a tiny vocab (`[CLS] [SEP] [PAD] こ ん ##にちは` style) asserting ids→"こんにちは" and that specials are stripped.

```rust
#[test]
fn detok_joins_wordpiece_strips_specials() {
    let d = Detokenizer::from_vocab_str("[PAD]\n[CLS]\n[SEP]\nこんにち\n##は\n");
    // ids: 1=[CLS], 3=こんにち, 4=##は, 2=[SEP]
    assert_eq!(d.decode(&[1, 3, 4, 2]), "こんにちは");
}
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `Detokenizer` (load `vocab.txt` line→id; `decode(ids)` skips special ids, joins, removes `##`). Prefer the `tokenizers` crate if it loads the manga-ocr vocab cleanly; else a 30-line hand-rolled map (simplest, fully testable). Decide during impl; either is fine.
- [ ] **Step 4: Run → pass.** **Step 5: Commit.** `git commit -m "feat(ocr): WordPiece detokenizer"`

### Task B4: Greedy decode loop (driven by a tiny fixture ONNX)

**Files:** modify `recognize.rs`; add `tests-fixtures/enc_dec_toy.onnx` (a hand-built toy encoder-decoder: decoder emits a fixed id sequence then EOS, so the loop is deterministic).

- [ ] **Step 1: Failing test** — `greedy_decode` with the toy model returns the known id sequence and stops at EOS within max_len.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `greedy_decode(decoder: &mut Session, enc_hidden: &Array, bos, eos, max_len) -> Vec<u32>`: loop building `input_ids`, run decoder with the I/O names from A1, argmax last-step logits, append, break on EOS/max_len. (Build `enc_dec_toy.onnx` with a tiny Python/onnx script committed under `tests-fixtures/build_toy.py` for reproducibility.)
- [ ] **Step 4: Run → pass.** **Step 5: Commit.** `git commit -m "feat(ocr): greedy autoregressive decode loop"`

### Task B5: MangaOcrEngine + OcrEngine trait

**Files:** modify `recognize.rs`, `lib.rs`. `#[cfg(feature="onnx")]` for the session-bearing parts.

- [ ] **Step 1: Failing (integration-style, `#[ignore]`) test** — `MangaOcrEngine::load(real paths)`, `recognize(sample_crop.png)` returns the expected JP string (fixture crop committed; expected text recorded). Gated `#[ignore]` so the default suite doesn't need the 140 MB models.
- [ ] **Step 2: Run → fail** (or ignored). Run the ignored test manually with models present: `cargo test -p manga-ocr --features onnx -- --ignored recognize_sample`.
- [ ] **Step 3: Implement** `trait OcrEngine { fn recognize(&self, crop: &GrayImage) -> Result<String,String>; }` and `MangaOcrEngine { encoder: Session, decoder: Session, detok: Detokenizer, bos, eos }` using B2+B3+B4. `load()` builds sessions from file paths.
- [ ] **Step 4: Run → pass** (ignored test, models present). **Step 5: Commit.** `git commit -m "feat(ocr): MangaOcrEngine + OcrEngine trait"`

### Task B6: Detector run + post-processing

**Files:** Create `detect.rs`; fixtures for synthetic raw outputs.

- [ ] **Step 1: Failing test** — `blocks_from_raw(mask, boxes, threshold, letterbox)` on synthetic raw tensors returns the expected `Vec<BBox>` in original-image pixels (covers thresholding, NMS/merge, un-letterboxing). Pure, no model.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the post-processing recipe recorded in A2, plus `Detector { session }` with `detect(&RgbImage) -> Vec<BBox>` (`#[cfg(feature="onnx")]` for the session part; the pure `blocks_from_raw` is always testable).
- [ ] **Step 4: Run → pass.** **Step 5: Commit.** `git commit -m "feat(ocr): comic-text-detector run + block post-processing"`

### Task B7: Wire detect_and_ocr (replace stub)

**Files:** modify `page.rs`, `lib.rs`. Remove the spike bin.

- [ ] **Step 1: Failing (`#[ignore]`) end-to-end test** — `detect_and_ocr(real_manga_page_bytes, "ja")` returns ≥1 region whose `original` contains the expected JP substring.
- [ ] **Step 2: Run → fail/ignored.**
- [ ] **Step 3: Implement** real `detect_and_ocr` `#[cfg(feature="onnx")]`: decode image → `Detector::detect` → for each block crop → `engine_for("ja").recognize` → `DetectedRegion`. `engine_for(lang)` matches `"ja"` → `MangaOcrEngine` (the KO/ZH seam); unknown lang → error. The `#[cfg(not(feature="onnx"))]` `detect_and_ocr` returns `Err("On-device OCR isn't available on this platform yet")`. Engines/detector are created once and passed in (caller caches them). Delete `src/bin/inspect_onnx.rs`.
- [ ] **Step 4: Run → pass** (ignored, models present); `cargo test -p manga-ocr` (no feature) still compiles + passes. **Step 5: Commit.** `git commit -m "feat(ocr): real detect_and_ocr pipeline (replaces stub)"`

---

## PHASE C — Tauri: download + serve

### Task C1: ensure_ocr_models command (download + verify + progress)

**Files:** modify `src-tauri/src/ocr.rs`, `src-tauri/src/lib.rs` (register command).

- [ ] **Step 1:** Implement `#[tauri::command] async fn ensure_ocr_models(app: AppHandle, lang: String) -> Result<(),String>`: resolve cache dir (`app.path().app_data_dir()?/"ocr-models"/lang`); for each `ModelFile` in `ja_manifest()`, if missing-or-bad-sha, stream-download via `reqwest`, emit `ocr-model-download {file, received, total}` per chunk, `verify_sha256`, write to `*.part` then rename. Errors clean up partials.
- [ ] **Step 2:** Manual verify on Android (no unit test for network I/O): emit-and-listen smoke in Task D. Compile gate: `cargo check -p Readest` equivalent via the Android build (desktop can't build the Tauri lib — see Phase 1 notes). Register in `generate_handler!`.
- [ ] **Step 3: Commit.** `git commit -m "feat(ocr): ensure_ocr_models download + sha + progress events"`

### Task C2: ocr_page_regions loads real models from cache

**Files:** modify `src-tauri/src/ocr.rs`.

- [ ] **Step 1:** Change `ocr_page_regions` to resolve the cache dir, build (and cache in a `tauri::State<Mutex<Option<Engines>>>`) the `Detector` + `MangaOcrEngine` from the cached files on first call, then run `detect_and_ocr`. If models are absent, return an error instructing to call `ensure_ocr_models` first (the frontend guarantees ordering).
- [ ] **Step 2:** Compile via Android build. **Step 3: Commit.** `git commit -m "feat(ocr): serve real models in ocr_page_regions with session cache"`

---

## PHASE D — Frontend first-use UX + i18n + gate

### Task D1: model-download service + wire into the auto path

**Files:** Create `src/services/ocr/modelDownload.ts`; modify `AutoBubblePageTranslator.tsx`; tests for the service.

- [ ] **Step 1: Failing test** — `ensureOcrModels` invokes `ensure_ocr_models` with `{ lang }`; `onOcrModelProgress` subscribes to the event and forwards `{received,total}`. (Mock `invoke`/`listen` like the existing ocrBackend test.)
- [ ] **Step 2: Run → fail.** `pnpm test -- src/__tests__/services/ocr/modelDownload.test.ts`
- [ ] **Step 3: Implement** the service; in `AutoBubblePageTranslator.onAutoTranslate`, before `run()`: if a `models-ready` flag isn't set, show a confirm ("Download Japanese OCR models · ~235 MB?"), call `ensureOcrModels('ja')` with a progress toast/bar, then proceed. Cache the ready-state so it only prompts once.
- [ ] **Step 4: Run → pass.** **Step 5: Commit.** `git commit -m "feat(ocr): first-use model download UX"`

### Task D2: i18n

- [ ] Run `pnpm run i18n:extract`; translate the new strings (`Download Japanese OCR models`, `Downloading OCR models…`, the size confirm, error) across all locales (see the i18n skill); `pnpm check:translations` → ✅. Commit.

### Task D3: On-device manual gate + opt-in integration

- [ ] Mirror the models to the `models-ja-v1` release (manual prep, also fills the SHAs in B1). Build the Android debug APK with the flag on (per the android-build-flow memory), open a real Japanese manga CBZ, tap ✨ → confirm the download flow, then verify real bubbles are detected, recognized (correct JP), translated, tap-to-reveal works. Capture screenshots. Run the `#[ignore]` integration tests with models present.

---

## Final verification (before finishing the branch)
- `cargo test -p manga-ocr` (no feature) + `--features onnx` (incl. `--ignored` with models) green.
- `pnpm lint`, `pnpm fmt:check`, `pnpm clippy:check` (CI), `pnpm test` green; `pnpm check:translations` ✅.
- Android build green; on-device gate passed (screenshots).
- Desktop default build still has **no `ort-sys`** (the Phase 1 invariant): `cargo tree -p manga-ocr | grep ort` empty.

## Self-review notes
- Spec coverage: detection (B6, A2), recognition (B2–B5), trait+routing (B5,B7), delivery (B1,C1,D1), platform-gate (B7), testing (B-tasks + D3) — all mapped.
- Type consistency: `DetectedRegion`/`BBox` unchanged; `OcrEngine::recognize(&GrayImage)->Result<String,String>` used identically in B5/B7; `ModelFile`/`ja_manifest` consistent across B1/C1.
- Known deferrals (not placeholders): real model SHAs (filled at the prep step), exact tensor names (A1 output) — both explicitly produced before the tasks that consume them.
