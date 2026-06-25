# Korean + Chinese on-device OCR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the on-device whole-page auto-translate feature from Japanese-only to Korean + Chinese (Simplified & Traditional), with a per-book source language that auto-detects from metadata and can be overridden.

**Architecture:** Detection (`comic-text-detector`) is reused unchanged. Add one shared `CtcRecognizer` (PaddleOCR PP-OCRv5 CTC) used for both Korean and Chinese, alongside the existing Japanese seq2seq `MangaOcrEngine`; `OcrPipeline` binds the right engine per language at load. The TS layer resolves each book's source language (detect from `book.primaryLanguage` + a remembered per-book override) and threads it through the already-generic backend.

**Tech Stack:** Rust (`ort`/ONNX Runtime, `ndarray`, `image`), TypeScript/React, vitest + jsdom, PaddleOCR models (Apache-2.0).

**Context (verified against current code):**
- `OcrEngine` trait: `recognize(&mut self, crop: &GrayImage) -> Result<String, String>` (`crates/manga-ocr/src/recognize.rs:18`). `argmax(&[f32]) -> usize` is reusable (`recognize.rs:7`). `MangaOcrEngine` (seq2seq) is the JA impl.
- `OcrPipeline` (`pipeline.rs`) holds `ja_engine: MangaOcrEngine`; `load(model_dir)` builds detector + ja engine; `run(image_bytes, source_lang)` hard-rejects `source_lang != "ja"` (`pipeline.rs:39`). Crops are **grayscale** (`luma`), so for a CTC recognizer BGR vs RGB is moot (R=G=B).
- `models.rs`: `ModelFile { name, url, sha256 }`, `ja_manifest()`, `verify_sha256`. Models hosted on the `models-ja-v1` GitHub release, SHA-pinned; cached under `app_data_dir/ocr-models/<lang>/`.
- `src-tauri/src/ocr.rs`: `ensure_ocr_models(lang)` / `ocr_models_present(lang)` guard `!= "ja"` and call `ja_manifest()`; `ocr_page_regions` is `#[cfg(target_os="android")]`, caches a single `static Mutex<Option<OcrPipeline>>` (never reloads), returns "unavailable" off-Android. The `onnx` cargo feature on `manga-ocr` is Android-only (`src-tauri/Cargo.toml`).
- TS: `OcrSourceLang = 'ja'|'ko'|'zh'` **already exists** (`services/ocr/types.ts:1`). `ensureOcrModels(lang: string)`/`ocrModelsPresent(lang: string)` are already generic (`services/ocr/modelDownload.ts`). `useAutoBubbleTranslate().run({ sourceLang, langs, ... })` is typed with `OcrSourceLang` (`hooks/useAutoBubbleTranslate.ts:36`). `AutoBubblePageTranslator.tsx:25` hardcodes `const OCR_SOURCE_LANG = 'ja'` and dispatches via the `manga-auto-translate` event from `MangaBubbleToggler.tsx`.
- `book.primaryLanguage` is an ISO-639-1 code from `getPrimaryLanguage(metadata.language)` (`utils/book.ts:178`). Per-book settings persist via `useReaderStore`'s `setViewSettings(bookKey, viewSettings)` (`store/readerStore.ts:332`); `ViewSettings` is a union of config interfaces (`types/book.ts:374`).
- Run Rust crate tests: `cd apps/readest-app && cargo test -p manga-ocr` (CTC/decode/manifest tests need no `onnx` feature; engine/pipeline E2E tests are `#[ignore]` + need `--features onnx` and `MANGA_OCR_MODEL_DIR`). Run TS tests: `pnpm test -- <path>`. Branch `feat/ocr-korean-chinese` exists.

## File Structure

| File | Responsibility |
|---|---|
| `crates/manga-ocr/src/ctc.rs` (create) | `ctc_greedy_decode(logits, t, c, dict)` — pure CTC greedy decode. |
| `crates/manga-ocr/src/preprocess.rs` (modify) | add `ctc_rec_pixels(img, input_h)` — resize-to-height, dynamic width, normalize. |
| `crates/manga-ocr/src/models.rs` (modify) | `ko_manifest()`, `zh_manifest()`, `CtcSpec`, `ctc_spec(lang)`, `manifest_for(lang)`. |
| `crates/manga-ocr/src/recognize.rs` (modify) | `CtcRecognizer` engine (onnx-gated) implementing `OcrEngine`. |
| `crates/manga-ocr/src/pipeline.rs` (modify) | `load(dir, lang)` binds engine per lang via `Box<dyn OcrEngine + Send>`; `run` drops the lang guard. |
| `crates/manga-ocr/src/lib.rs` (modify) | `pub mod ctc;`. |
| `src-tauri/src/ocr.rs` (modify) | `manifest_for` dispatch; lang-keyed pipeline cache (reload on lang change). |
| `src/services/ocr/sourceLang.ts` (create) | `detectOcrSourceLang`, `resolveOcrSourceLang`. |
| `src/types/book.ts` (modify) | `OcrConfig { ocrSourceLang? }` mixed into `ViewSettings`. |
| `src/app/reader/components/MangaBubbleToggler.tsx` (modify) | language menu + resolve + dispatch `{ bookKey, sourceLang }` + persist override. |
| `src/app/reader/components/annotator/AutoBubblePageTranslator.tsx` (modify) | consume `sourceLang` from the event; language-aware download prompt. |
| `src/__tests__/services/ocr/sourceLang.test.ts` (create) | resolution truth table. |

---

### Task 1: Model prep + recipe validation (spike — produces hosted artifacts)

This is one-time prep, not shipped code. It de-risks accuracy and produces the URLs + SHA-256 + `input_h` + IO tensor names that Tasks 2–5 hardcode. Mirrors how the JA models were validated before integration.

**Files:** none committed except this plan's "Recorded artifacts" note at the end of the task.

- [ ] **Step 1: Fetch the Chinese ONNX (turnkey) and extract its dict**

```bash
pip install -U "huggingface_hub[cli]" onnxruntime pillow numpy pyyaml
huggingface-cli download PaddlePaddle/PP-OCRv5_mobile_rec_onnx --local-dir /tmp/zh_rec
# Extract the character dict (ordered, one char per line) from inference.yml into dict.txt:
python3 - <<'PY'
import yaml
y = yaml.safe_load(open('/tmp/zh_rec/inference.yml'))
chars = y['PostProcess']['character_dict']           # ordered list as trained
open('/tmp/zh_rec/dict.txt','w').write('\n'.join(chars) + '\n')
print('zh dict chars:', len(chars), 'use_space_char:', y['PostProcess'].get('use_space_char'))
PY
```

- [ ] **Step 2: Produce the Korean ONNX** (self-convert for provenance; fall back to community if `paddle2onnx` is impractical)

```bash
pip install -U paddlepaddle paddle2onnx
huggingface-cli download PaddlePaddle/korean_PP-OCRv5_mobile_rec --local-dir /tmp/ko_paddle
paddle2onnx --model_dir /tmp/ko_paddle --model_filename inference.json \
  --params_filename inference.pdiparams --save_file /tmp/ko_rec/rec.onnx \
  --opset_version 17 --enable_onnx_checker True
python3 - <<'PY'
import yaml
y = yaml.safe_load(open('/tmp/ko_paddle/inference.yml'))
chars = y['PostProcess']['character_dict']
open('/tmp/ko_rec/dict.txt','w').write('\n'.join(chars) + '\n')
print('ko dict chars:', len(chars), 'use_space_char:', y['PostProcess'].get('use_space_char'))
PY
# Fallback (only if conversion fails): huggingface-cli download monkt/paddleocr-onnx --include 'languages/korean/*' --local-dir /tmp/ko_rec_fallback  (note: its config.json input height is 32, not 48)
```

- [ ] **Step 3: Confirm IO tensor names + input height, and validate CTC decode in Python on a real crop**

```bash
python3 - <<'PY'
import onnxruntime as ort, numpy as np, yaml
from PIL import Image
for name, recdir, ymlpath in [('zh','/tmp/zh_rec','/tmp/zh_rec/inference.yml'),
                              ('ko','/tmp/ko_rec','/tmp/ko_paddle/inference.yml')]:
    sess = ort.InferenceSession(f'{recdir}/rec.onnx' if name=='ko' else f'{recdir}/inference.onnx')
    inp, out = sess.get_inputs()[0], sess.get_outputs()[0]
    H = inp.shape[2] if isinstance(inp.shape[2], int) else 48
    dictlines = open(f'{recdir}/dict.txt').read().splitlines()
    vocab = ['<blank>'] + dictlines            # PaddleOCR: index 0 = blank
    img = Image.open(f'/tmp/{name}_line.png').convert('L')   # a real single-line bubble crop
    w,h = img.size; W = max(1, round(H * w / h))
    a = (np.asarray(img.resize((W,H)), np.float32)/255 - 0.5)/0.5
    x = np.stack([a,a,a])[None]                # [1,3,H,W], gray->3ch
    logits = sess.run([out.name], {inp.name: x})[0][0]   # [T,C]
    ids = logits.argmax(1); s=''; prev=-1
    for i in ids:
        if i!=prev and i!=0: s += vocab[i]
        prev=i
    print(name, 'input=',inp.name,'output=',out.name,'H=',H,'C=',logits.shape[1],'text=',s)
PY
```
Expected: prints plausible Korean / Chinese text. **Record `input` name, `output` name, `H`, and num-classes per language.** Also run a **multi-line bubble crop** through the same script — if a multi-line crop returns garbled output, note it: line-splitting becomes a fast-follow (Task 11 verifies on-device; not built here per YAGNI unless the gate fails).

- [ ] **Step 4: Host the models and pin checksums**

```bash
# The hosted filename must be exactly rec.onnx (the manifest in Task 4 expects it),
# so rename the ZH export before upload — gh's `file#label` only sets a display
# label, not the download filename.
cp /tmp/zh_rec/inference.onnx /tmp/zh_rec/rec.onnx
gh release create models-ko-v1 --repo julianshen/readest --title "Korean OCR models v1" \
  --notes "PP-OCRv5 Korean rec (Apache-2.0)" /tmp/ko_rec/rec.onnx /tmp/ko_rec/dict.txt
gh release create models-zh-v1 --repo julianshen/readest --title "Chinese OCR models v1" \
  --notes "PP-OCRv5 mobile rec, Simplified+Traditional+JP (Apache-2.0)" /tmp/zh_rec/rec.onnx /tmp/zh_rec/dict.txt
sha256sum /tmp/ko_rec/rec.onnx /tmp/ko_rec/dict.txt /tmp/zh_rec/rec.onnx /tmp/zh_rec/dict.txt
```
**Record the 4 SHA-256 values + the `input_h`/IO names** in the task's commit message; Tasks 4–5 use them.

- [ ] **Step 5: Commit** the recorded artifacts as a note.

```bash
git commit --allow-empty -m "chore(ocr): host KO/ZH PP-OCRv5 models (models-{ko,zh}-v1); record SHAs + input_h + IO names"
```

### Task 2: CTC greedy decode

**Files:** Create `crates/manga-ocr/src/ctc.rs`; Modify `crates/manga-ocr/src/lib.rs`.

- [ ] **Step 1: Write the failing test** — append to `ctc.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn dict() -> Vec<String> {
        // index 0 = blank; then a,b,c
        ["<blank>", "a", "b", "c"].iter().map(|s| s.to_string()).collect()
    }
    // logits row helper: one-hot at `idx` over `c` classes.
    fn row(idx: usize, c: usize) -> Vec<f32> { let mut v = vec![0.0; c]; v[idx] = 1.0; v }

    #[test]
    fn collapses_repeats_and_drops_blank() {
        let c = 4;
        // timesteps: a, a, blank, a, b, b  → "aab"
        let mut logits = Vec::new();
        for idx in [1usize, 1, 0, 1, 2, 2] { logits.extend(row(idx, c)); }
        assert_eq!(ctc_greedy_decode(&logits, 6, c, &dict()), "aab");
    }

    #[test]
    fn empty_timesteps_yield_empty() {
        assert_eq!(ctc_greedy_decode(&[], 0, 4, &dict()), "");
    }

    #[test]
    fn out_of_range_index_skipped() {
        // a single timestep whose argmax is index 3 (=c) but dict has no entry → skipped safely
        let c = 4;
        let logits = row(3, c);
        assert_eq!(ctc_greedy_decode(&logits, 1, c, &dict()), "c");
    }
}
```

- [ ] **Step 2: Run → fail.** `cd apps/readest-app && cargo test -p manga-ocr ctc`
Expected: FAIL (`ctc_greedy_decode` not found).

- [ ] **Step 3: Implement** — prepend to `ctc.rs`:

```rust
//! CTC greedy decode for PaddleOCR-style recognizers.
//! Convention: class index 0 is the CTC blank; `dict[0]` is its placeholder and
//! `dict[i]` (i>=1) is the i-th character of the model's dictionary.

/// Greedy-decode `[t, c]` row-major logits: argmax per timestep, collapse
/// consecutive duplicates, drop blank (index 0), map index→`dict`, concatenate.
pub fn ctc_greedy_decode(logits: &[f32], t: usize, c: usize, dict: &[String]) -> String {
    let mut out = String::new();
    let mut prev = usize::MAX;
    for ti in 0..t {
        let start = ti * c;
        let Some(slice) = logits.get(start..start + c) else { break };
        let idx = crate::recognize::argmax(slice);
        if idx != prev && idx != 0 {
            if let Some(ch) = dict.get(idx) {
                out.push_str(ch);
            }
        }
        prev = idx;
    }
    out
}
```

And add to `lib.rs` (keep modules alphabetical):

```rust
pub mod ctc;
```

- [ ] **Step 4: Run → pass.** `cargo test -p manga-ocr ctc` — Expected: PASS (3 tests).
- [ ] **Step 5: Commit** `feat(ocr): CTC greedy decode for PaddleOCR recognizers`.

### Task 3: CTC recognizer preprocessing

**Files:** Modify `crates/manga-ocr/src/preprocess.rs`.

- [ ] **Step 1: Write the failing test** — add inside the existing `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn ctc_rec_pixels_shape_dynamic_width_and_norm() {
        // 40x20 gray image, input_h=48 → out_w = round(48 * 40/20) = 96
        let img = GrayImage::from_pixel(40, 20, image::Luma([0u8]));
        let t = ctc_rec_pixels(&img, 48);
        assert_eq!(t.shape(), &[1, 3, 48, 96]);
        // pixel value 0 → (0 - 0.5)/0.5 = -1.0, all 3 channels identical
        assert!((t[[0, 0, 0, 0]] - (-1.0)).abs() < 1e-4);
        assert!((t[[0, 1, 10, 10]] - t[[0, 2, 10, 10]]).abs() < 1e-6);
    }

    #[test]
    fn ctc_rec_pixels_min_width_one() {
        // degenerate 1x1000 image must not produce zero width
        let img = GrayImage::from_pixel(1, 1000, image::Luma([255u8]));
        let t = ctc_rec_pixels(&img, 48);
        assert_eq!(t.shape()[3], 1);
        assert!((t[[0, 0, 0, 0]] - 1.0).abs() < 1e-4);
    }
```

- [ ] **Step 2: Run → fail.** `cargo test -p manga-ocr ctc_rec_pixels`
Expected: FAIL (`ctc_rec_pixels` not found).

- [ ] **Step 3: Implement** — add to `preprocess.rs` (after `manga_ocr_pixels`):

```rust
/// PaddleOCR CTC recognizer input: resize to height `input_h` keeping aspect
/// ratio (dynamic width), replicate gray→3ch (so BGR/RGB ordering is moot for a
/// grayscale crop), normalize (v/255 - 0.5)/0.5. Returns [1,3,input_h,W].
pub fn ctc_rec_pixels(img: &GrayImage, input_h: u32) -> Array4<f32> {
    let (w, h) = img.dimensions();
    let out_w = (((input_h as f32) * (w as f32) / (h.max(1) as f32)).round() as u32).max(1);
    let resized = image::imageops::resize(img, out_w, input_h, FilterType::Triangle);
    let mut tensor = Array4::<f32>::zeros([1, 3, input_h as usize, out_w as usize]);
    for y in 0..input_h as usize {
        for x in 0..out_w as usize {
            let v = resized.get_pixel(x as u32, y as u32).0[0] as f32 / 255.0;
            let norm = (v - 0.5) / 0.5;
            tensor[[0, 0, y, x]] = norm;
            tensor[[0, 1, y, x]] = norm;
            tensor[[0, 2, y, x]] = norm;
        }
    }
    tensor
}
```

- [ ] **Step 4: Run → pass.** `cargo test -p manga-ocr ctc_rec_pixels` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ocr): ctc_rec_pixels preprocessing (dynamic-width line image)`.

### Task 4: Model manifests + CTC spec + dispatch

**Files:** Modify `crates/manga-ocr/src/models.rs`. Use the **SHA-256 + `input_h` recorded in Task 1**.

- [ ] **Step 1: Write the failing test** — add to the `#[cfg(test)] mod tests` in `models.rs`:

```rust
    #[test]
    fn ko_zh_manifests_valid_and_share_detector() {
        for manifest in [ko_manifest(), zh_manifest()] {
            assert_eq!(manifest.len(), 3); // detector + rec.onnx + dict.txt
            for e in &manifest {
                assert_eq!(e.sha256.len(), 64, "{} sha len", e.name);
                assert!(e.url.starts_with("https://"), "{} url", e.name);
            }
        }
        // detector entry is byte-identical across langs (same hosted file/sha)
        assert_eq!(ko_manifest()[0].sha256, ja_manifest()[0].sha256);
        assert_eq!(zh_manifest()[0].sha256, ja_manifest()[0].sha256);
    }

    #[test]
    fn ctc_spec_and_manifest_for_dispatch() {
        assert!(ctc_spec("ko").is_some());
        assert!(ctc_spec("zh").is_some());
        assert!(ctc_spec("ja").is_none());
        assert!(manifest_for("ja").is_some());
        assert!(manifest_for("ko").is_some());
        assert!(manifest_for("zh").is_some());
        assert!(manifest_for("xx").is_none());
    }
```

- [ ] **Step 2: Run → fail.** `cargo test -p manga-ocr models` — Expected: FAIL (missing items).

- [ ] **Step 3: Implement** — add to `models.rs` (replace the `<SHA_*>` and confirm `input_h` from Task 1):

```rust
/// Per-language CTC recognizer spec: filenames in the cache dir + input height.
pub struct CtcSpec {
    pub rec_onnx: &'static str,
    pub dict: &'static str,
    pub input_h: u32,
}

/// CTC spec for ko/zh (PaddleOCR PP-OCRv5). None for non-CTC languages (ja).
pub fn ctc_spec(lang: &str) -> Option<CtcSpec> {
    match lang {
        // input_h = 48 for the official PP-OCRv5 export (Task 1 confirms; use 32
        // if the Korean model is the community monkt export).
        "ko" | "zh" => Some(CtcSpec { rec_onnx: "rec.onnx", dict: "dict.txt", input_h: 48 }),
        _ => None,
    }
}

const JA_DETECTOR_URL: &str =
    "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.onnx";
const JA_DETECTOR_SHA: &str = "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f";

/// Korean model files (detector shared from models-ja-v1 + PP-OCRv5 KO rec).
pub fn ko_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile { name: "comic-text-detector.onnx", url: JA_DETECTOR_URL, sha256: JA_DETECTOR_SHA },
        ModelFile {
            name: "rec.onnx",
            url: "https://github.com/julianshen/readest/releases/download/models-ko-v1/rec.onnx",
            sha256: "<SHA_KO_REC_FROM_TASK1>",
        },
        ModelFile {
            name: "dict.txt",
            url: "https://github.com/julianshen/readest/releases/download/models-ko-v1/dict.txt",
            sha256: "<SHA_KO_DICT_FROM_TASK1>",
        },
    ]
}

/// Chinese model files (detector shared + PP-OCRv5 mobile rec: Simplified+Traditional+JP).
pub fn zh_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile { name: "comic-text-detector.onnx", url: JA_DETECTOR_URL, sha256: JA_DETECTOR_SHA },
        ModelFile {
            name: "rec.onnx",
            url: "https://github.com/julianshen/readest/releases/download/models-zh-v1/rec.onnx",
            sha256: "<SHA_ZH_REC_FROM_TASK1>",
        },
        ModelFile {
            name: "dict.txt",
            url: "https://github.com/julianshen/readest/releases/download/models-zh-v1/dict.txt",
            sha256: "<SHA_ZH_DICT_FROM_TASK1>",
        },
    ]
}

/// Download manifest for a supported language; None if unsupported.
pub fn manifest_for(lang: &str) -> Option<Vec<ModelFile>> {
    match lang {
        "ja" => Some(ja_manifest()),
        "ko" => Some(ko_manifest()),
        "zh" => Some(zh_manifest()),
        _ => None,
    }
}
```

Also refactor the existing `ja_manifest()` detector entry to reuse `JA_DETECTOR_URL`/`JA_DETECTOR_SHA` so the shared-detector assertion holds (replace the inline detector `ModelFile` literal's `url`/`sha256` with the two consts).

- [ ] **Step 4: Run → pass.** `cargo test -p manga-ocr models` — Expected: PASS (existing + 2 new).
- [ ] **Step 5: Commit** `feat(ocr): ko/zh model manifests + ctc_spec + manifest_for`.

### Task 5: `CtcRecognizer` engine

**Files:** Modify `crates/manga-ocr/src/recognize.rs`. Onnx-gated; verified by the pipeline E2E (Task 6) + on-device gate. Use the IO names recorded in Task 1 (default `x` / first output).

- [ ] **Step 1: Implement** — add to `recognize.rs` (after `MangaOcrEngine`'s impl, all under `#[cfg(feature = "onnx")]`):

```rust
/// PaddleOCR PP-OCRv5 CTC recognizer (one ONNX session). Shared by ko/zh.
#[cfg(feature = "onnx")]
pub struct CtcRecognizer {
    session: ort::session::Session,
    dict: Vec<String>, // index 0 = CTC blank placeholder
    input_h: u32,
    input_name: String,
    output_name: String,
}

#[cfg(feature = "onnx")]
impl CtcRecognizer {
    /// Load the rec model + character dict. `input_h` comes from the model's config.
    pub fn load(rec_path: &Path, dict_path: &Path, input_h: u32) -> Result<Self, String> {
        let session = ort::session::Session::builder()
            .map_err(|e| format!("ort builder (rec): {e}"))?
            .commit_from_file(rec_path)
            .map_err(|e| format!("ort load rec: {e}"))?;
        // PaddleOCR convention: class 0 is blank; the dict file holds classes 1..N.
        let mut dict = vec!["<blank>".to_string()];
        let raw = std::fs::read_to_string(dict_path).map_err(|e| format!("read dict: {e}"))?;
        dict.extend(raw.lines().map(|l| l.to_string()));
        let input_name = session
            .inputs
            .first()
            .map(|i| i.name.clone())
            .ok_or("rec model has no inputs")?;
        let output_name = session
            .outputs
            .first()
            .map(|o| o.name.clone())
            .ok_or("rec model has no outputs")?;
        Ok(Self { session, dict, input_h, input_name, output_name })
    }
}

#[cfg(feature = "onnx")]
impl OcrEngine for CtcRecognizer {
    fn recognize(&mut self, crop: &GrayImage) -> Result<String, String> {
        use ort::value::TensorRef;
        let pixels = crate::preprocess::ctc_rec_pixels(crop, self.input_h);
        let tensor = TensorRef::from_array_view(pixels.view())
            .map_err(|e| format!("ort rec input: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs![self.input_name.as_str() => tensor])
            .map_err(|e| format!("ort rec run: {e}"))?;
        let (shape, data) = outputs[self.output_name.as_str()]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("ort rec extract: {e}"))?;
        if shape.len() < 3 {
            return Err(format!("rec output rank {} < 3 (shape {:?})", shape.len(), shape));
        }
        let (t, c) = (shape[1] as usize, shape[2] as usize);
        Ok(crate::ctc::ctc_greedy_decode(data, t, c, &self.dict))
    }
}
```

> Build note: if the `ort::inputs![expr => ...]` macro rejects a non-literal key, build the input list manually with `ort::inputs![(self.input_name.clone(), tensor.into())]` form, or the `vec![(Cow::from(self.input_name.as_str()), tensor.into())]` slice the macro expands to. The IO names were printed in Task 1.

- [ ] **Step 2: Build the crate with the feature to type-check** (no runtime models needed):
`cargo build -p manga-ocr --features onnx` — Expected: compiles clean.
- [ ] **Step 3: Commit** `feat(ocr): CtcRecognizer engine (PP-OCRv5 CTC) for ko/zh`.

### Task 6: Pipeline dispatch by language

**Files:** Modify `crates/manga-ocr/src/pipeline.rs`.

- [ ] **Step 1: Update the ignored E2E test + add a (non-onnx) dispatch test.** Replace the `mod tests` in `pipeline.rs` with:

```rust
#[cfg(all(feature = "onnx", test))]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn pipeline_detects_and_recognizes_sample_page() {
        let dir = std::path::PathBuf::from(
            std::env::var("MANGA_OCR_MODEL_DIR").expect("set MANGA_OCR_MODEL_DIR"),
        );
        let mut p = OcrPipeline::load(&dir, "ja").unwrap();
        p.conf_thresh = 0.12;
        let bytes =
            std::fs::read("tests-fixtures/manga_page_sample.png").expect("fixture not found");
        let regions = p.run(&bytes).unwrap();
        assert!(!regions.is_empty(), "expected at least one region");
        assert!(regions.iter().any(|r| r.original.contains("こんにち")));
        // unsupported language now fails at load:
        assert!(OcrPipeline::load(&dir, "xx").is_err());
    }
}
```

- [ ] **Step 2: Run → fail.** `cargo test -p manga-ocr --features onnx -- --ignored pipeline` (or just `cargo build`) — Expected: FAIL to compile (`load` arity, `run` arity).

- [ ] **Step 3: Implement** — replace the `OcrPipeline` struct + `load` + `run` signature in `pipeline.rs`:

```rust
#[cfg(feature = "onnx")]
pub struct OcrPipeline {
    detector: crate::detect::Detector,
    engine: Box<dyn crate::recognize::OcrEngine + Send>,
    pub conf_thresh: f32,
    pub nms_thresh: f32,
}

#[cfg(feature = "onnx")]
impl OcrPipeline {
    /// Load the shared detector + the recognition engine for `lang`
    /// (`ja` → manga-ocr seq2seq; `ko`/`zh` → PP-OCRv5 CTC).
    pub fn load(model_dir: &std::path::Path, lang: &str) -> Result<Self, String> {
        let detector = crate::detect::Detector::load(&model_dir.join("comic-text-detector.onnx"))?;
        let engine: Box<dyn crate::recognize::OcrEngine + Send> = match lang {
            "ja" => Box::new(crate::recognize::MangaOcrEngine::load(
                &model_dir.join("encoder_model.onnx"),
                &model_dir.join("decoder_model.onnx"),
                &model_dir.join("vocab.txt"),
            )?),
            "ko" | "zh" => {
                let spec = crate::models::ctc_spec(lang)
                    .ok_or_else(|| format!("no ctc spec for {lang}"))?;
                Box::new(crate::recognize::CtcRecognizer::load(
                    &model_dir.join(spec.rec_onnx),
                    &model_dir.join(spec.dict),
                    spec.input_h,
                )?)
            }
            other => return Err(format!("unsupported source language: {other}")),
        };
        Ok(Self { detector, engine, conf_thresh: 0.3, nms_thresh: 0.35 })
    }

    /// Detect text blocks, OCR each via the bound engine, return regions.
    pub fn run(&mut self, image_bytes: &[u8]) -> Result<Vec<crate::page::DetectedRegion>, String> {
        let dyn_img =
            image::load_from_memory(image_bytes).map_err(|e| format!("decode image: {e}"))?;
        let rgb = dyn_img.to_rgb8();
        let luma = dyn_img.to_luma8();
        let (img_w, img_h) = (rgb.width(), rgb.height());

        let boxes = self.detector.detect(&rgb, self.conf_thresh, self.nms_thresh)?;
        let mut regions = Vec::with_capacity(boxes.len());
        for (i, b) in boxes.into_iter().enumerate() {
            if b.w == 0 || b.h == 0 || b.x >= img_w || b.y >= img_h {
                continue;
            }
            let x = b.x.min(img_w.saturating_sub(1));
            let y = b.y.min(img_h.saturating_sub(1));
            let w = b.w.min(img_w - x);
            let h = b.h.min(img_h - y);
            if w == 0 || h == 0 {
                continue;
            }
            let crop = image::imageops::crop_imm(&luma, x, y, w, h).to_image();
            let text = self.engine.recognize(&crop)?;
            regions.push(crate::page::DetectedRegion { id: i as u32, bbox: b, original: text });
        }
        Ok(regions)
    }
}
```

Remove the now-unused `use crate::recognize::OcrEngine;` only if it becomes unused (the `Box<dyn ...>` path keeps it referenced via full path — delete the top `use` line to avoid an unused-import warning).

- [ ] **Step 4: Build.** `cargo build -p manga-ocr --features onnx` — Expected: compiles clean. `cargo test -p manga-ocr` (non-onnx unit tests still pass).
- [ ] **Step 5: Commit** `feat(ocr): bind recognition engine per language in OcrPipeline`.

### Task 7: Tauri commands — multi-language

**Files:** Modify `src-tauri/src/ocr.rs`.

- [ ] **Step 1: Implement** — three edits:

(a) Replace the body guard + manifest call in `ensure_ocr_models`:

```rust
    let manifest = manga_ocr::models::manifest_for(&lang)
        .ok_or_else(|| format!("unsupported OCR language: {lang}"))?;
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ocr-models")
        .join(&lang);
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    for f in manifest {
```
(delete the old `if lang != "ja" { return Err(...) }` block and the `for f in manga_ocr::models::ja_manifest()` line.)

(b) Replace `ocr_models_present`'s guard + manifest:

```rust
pub async fn ocr_models_present(app: tauri::AppHandle, lang: String) -> Result<bool, String> {
    let Some(manifest) = manga_ocr::models::manifest_for(&lang) else {
        return Ok(false);
    };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ocr-models")
        .join(&lang);
    Ok(manifest.iter().all(|f| {
        std::fs::metadata(dir.join(f.name))
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    }))
}
```

(c) Make the pipeline cache lang-aware (reload on language change). Change the static + the `ocr_page_regions` android block:

```rust
#[cfg(target_os = "android")]
static OCR_PIPELINE: std::sync::Mutex<Option<(String, manga_ocr::pipeline::OcrPipeline)>> =
    std::sync::Mutex::new(None);
```

```rust
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = OCR_PIPELINE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // (Re)load when empty or when the requested language differs from the
            // currently-loaded engine.
            if guard.as_ref().map(|(l, _)| l != &source_lang).unwrap_or(true) {
                let pipeline = manga_ocr::pipeline::OcrPipeline::load(&cache_dir, &source_lang)
                    .map_err(|e| format!("load OCR models (call ensure_ocr_models first?): {e}"))?;
                *guard = Some((source_lang.clone(), pipeline));
            }
            guard.as_mut().unwrap().1.run(&image_bytes)
        })
        .await
        .map_err(|e| format!("join: {e}"))?
```

- [ ] **Step 2: Verify formatting + lint** (src-tauri changed): `pnpm fmt:check` and `pnpm clippy:check`. Expected: clean. (Full `cargo build` of the android target isn't needed here; Task 11 builds the APK.)
- [ ] **Step 3: Commit** `feat(ocr): multi-language model download + lang-keyed pipeline cache`.

### Task 8: Source-language resolution (TS)

**Files:** Create `src/services/ocr/sourceLang.ts`, `src/__tests__/services/ocr/sourceLang.test.ts`.

- [ ] **Step 1: Write the failing test** (`sourceLang.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { detectOcrSourceLang, resolveOcrSourceLang } from '@/services/ocr/sourceLang';

describe('source language resolution', () => {
  it('detects ja/ko/zh from a primary language code, else null', () => {
    expect(detectOcrSourceLang('ja')).toBe('ja');
    expect(detectOcrSourceLang('ko')).toBe('ko');
    expect(detectOcrSourceLang('zh')).toBe('zh');
    expect(detectOcrSourceLang('zh-CN')).toBe('zh');
    expect(detectOcrSourceLang('zh-Hant')).toBe('zh');
    expect(detectOcrSourceLang('en')).toBeNull();
    expect(detectOcrSourceLang(undefined)).toBeNull();
  });

  it('prefers a remembered override over detection', () => {
    expect(resolveOcrSourceLang('ja', 'ko')).toBe('ko'); // override wins
    expect(resolveOcrSourceLang('en', 'zh')).toBe('zh'); // override even when undetectable
    expect(resolveOcrSourceLang('ko', undefined)).toBe('ko'); // falls back to detection
    expect(resolveOcrSourceLang('en', undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm test -- src/__tests__/services/ocr/sourceLang.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`sourceLang.ts`):

```ts
import type { OcrSourceLang } from '@/services/ocr/types';

/** Map a book's primary language (ISO-639-1, possibly region-tagged) to an OCR
 *  source language, or null when it isn't one we recognize. */
export const detectOcrSourceLang = (primaryLanguage?: string): OcrSourceLang | null => {
  const lang = (primaryLanguage ?? '').toLowerCase();
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  if (lang.startsWith('zh')) return 'zh';
  return null;
};

/** Remembered per-book override wins; otherwise detect from metadata. */
export const resolveOcrSourceLang = (
  primaryLanguage: string | undefined,
  remembered?: OcrSourceLang,
): OcrSourceLang | null => remembered ?? detectOcrSourceLang(primaryLanguage);
```

- [ ] **Step 4: Run → pass.** `pnpm test -- src/__tests__/services/ocr/sourceLang.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ocr): resolveOcrSourceLang (auto-detect + remembered override)`.

### Task 9: Per-book override config field

**Files:** Modify `src/types/book.ts`.

- [ ] **Step 1: Implement** — add an `OcrConfig` interface and mix it into `ViewSettings`:

```ts
// (near the other *Config interfaces, before `ViewSettings`)
export interface OcrConfig {
  // Remembered per-book OCR source language override for auto bubble translate.
  ocrSourceLang?: import('@/services/ocr/types').OcrSourceLang;
}
```

Add `OcrConfig` to the `ViewSettings extends (...)` list (e.g., after `TranslatorConfig`):

```ts
export interface ViewSettings
  extends BookLayout,
    BookStyle,
    BookFont,
    BookLanguage,
    ViewConfig,
    TTSConfig,
    TranslatorConfig,
    OcrConfig,
    ScreenConfig,
    ProofreadRulesConfig,
    AnnotatorConfig,
    ViewSettingsConfig {}
```

(The inline `import('...')` type avoids a runtime import from the `services` layer into `types`.)

- [ ] **Step 2: Type-check.** `pnpm lint` — Expected: clean (no usages yet; the field is optional).
- [ ] **Step 3: Commit** `feat(ocr): persist per-book ocrSourceLang in view settings`.

### Task 10: Picker UI + thread source language

**Files:** Modify `src/app/reader/components/MangaBubbleToggler.tsx`, `src/app/reader/components/annotator/AutoBubblePageTranslator.tsx`.

- [ ] **Step 1: Toggler — resolve, menu, dispatch with sourceLang, persist override.** Replace the `MangaBubbleToggler` body (keep imports; add the new ones). The ✨ button runs immediately when a language is resolvable; a `▾` button opens a 3-item menu that records the override and runs.

```tsx
import React, { useState } from 'react';
import { MdTranslate, MdAutoAwesome, MdArrowDropDown } from 'react-icons/md';

import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { isAIAssistantConfigured } from '@/services/ai/providers';
import { isImagePageBook } from '@/utils/book';
import { MANGA_AUTO_TRANSLATE_ENABLED } from '@/services/constants';
import { resolveOcrSourceLang } from '@/services/ocr/sourceLang';
import type { OcrSourceLang } from '@/services/ocr/types';
import { eventDispatcher } from '@/utils/event';

const OCR_LANGS: { code: OcrSourceLang; label: string }[] = [
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
];

const MangaBubbleToggler: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { getBookData } = useBookDataStore();
  const { setHoveredBookKey, getViewSettings, setViewSettings } = useReaderStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const bookData = getBookData(bookKey);

  const isImagePage =
    !!bookData?.book && isImagePageBook(bookData.book.format, !!bookData.isFixedLayout);
  if (!isImagePage) return null;

  const showRegion = isAIAssistantConfigured(settings.aiSettings);
  const showAuto = MANGA_AUTO_TRANSLATE_ENABLED && appService?.osPlatform === 'android';
  if (!showRegion && !showAuto) return null;

  const remembered = getViewSettings(bookKey)?.ocrSourceLang;
  const resolved = resolveOcrSourceLang(bookData?.book?.primaryLanguage, remembered);

  const runAuto = (lang: OcrSourceLang) => {
    setHoveredBookKey('');
    setMenuOpen(false);
    eventDispatcher.dispatch('manga-auto-translate', { bookKey, sourceLang: lang });
  };

  const pickLang = (lang: OcrSourceLang) => {
    const vs = getViewSettings(bookKey);
    if (vs) setViewSettings(bookKey, { ...vs, ocrSourceLang: lang });
    runAuto(lang);
  };

  const onAutoClick = () => {
    if (resolved) runAuto(resolved);
    else setMenuOpen((v) => !v); // undetected → force a choice
  };

  return (
    <>
      {showRegion && (
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
      )}
      {showAuto && (
        <div className='dropdown dropdown-end'>
          <div className='flex'>
            <button
              title={_('Auto-translate page')}
              aria-label={_('Auto-translate page')}
              className='btn btn-ghost h-8 min-h-8 w-8 p-0'
              onClick={onAutoClick}
            >
              <MdAutoAwesome size={18} className='fill-base-content' />
            </button>
            <button
              title={_('Change OCR language')}
              aria-label={_('Change OCR language')}
              className='btn btn-ghost h-8 min-h-8 w-4 p-0'
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MdArrowDropDown size={16} className='fill-base-content' />
            </button>
          </div>
          {menuOpen && (
            <ul className='dropdown-content menu bg-base-200 rounded-box z-50 w-40 p-1 shadow'>
              {OCR_LANGS.map(({ code, label }) => (
                <li key={code}>
                  <button
                    className={resolved === code ? 'font-bold' : ''}
                    onClick={() => pickLang(code)}
                  >
                    {_(label)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
};

export default MangaBubbleToggler;
```

- [ ] **Step 2: Translator — consume `sourceLang` from the event; language-aware prompt.** In `AutoBubblePageTranslator.tsx`:

Delete the `OCR_SOURCE_LANG` constant (lines 23-25). Add a ref + read the event's language. Replace the event handler and the `onAutoTranslate` signature so the language flows through:

```tsx
import type { OcrSourceLang } from '@/services/ocr/types';

const OCR_LANG_LABELS: Record<OcrSourceLang, string> = { ja: 'Japanese', ko: 'Korean', zh: 'Chinese' };
```

Change `onAutoTranslate` to take the language and use it everywhere `OCR_SOURCE_LANG` was used:

```tsx
  const onAutoTranslate = async (sourceLang: OcrSourceLang) => {
    setPopup(null);

    if (!modelsReady.current) {
      const present = await ocrModelsPresent(sourceLang).catch(() => false);
      if (present) {
        modelsReady.current = true;
      } else {
        const { ask } = await import('@tauri-apps/plugin-dialog');
        const langLabel = _(OCR_LANG_LABELS[sourceLang]);
        const ok = await ask(_('Download {{lang}} OCR models?', { lang: langLabel }));
        if (!ok) return;
        // ...unchanged progress wiring...
        try {
          await ensureOcrModels(sourceLang);
          modelsReady.current = true;
        } catch {
          // ...unchanged error toast...
          un();
          return;
        }
        un();
      }
    }
    // ...unchanged capture/geometry...
    try {
      await run({
        cacheKeyParts: { bookKey, sectionIndex: primary?.index ?? 0, target },
        imageBytes,
        geometry,
        sourceLang,
        langs: { source: sourceLang, target },
        translate: (input, o) => translate(input, o),
      });
    } /* ...unchanged... */
  };

  const runAutoRef = useRef<(lang: OcrSourceLang) => void>(() => {});
  runAutoRef.current = (lang: OcrSourceLang) => {
    void onAutoTranslate(lang);
  };

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail?.bookKey !== bookKey) return;
      runAutoRef.current((e.detail?.sourceLang as OcrSourceLang) ?? 'ja');
    };
    eventDispatcher.on('manga-auto-translate', handler);
    return () => eventDispatcher.off('manga-auto-translate', handler);
  }, [bookKey]);
```

Important: `modelsReady` must not stick across languages. Change it from a boolean ref to track the ready language: `const modelsReady = useRef<OcrSourceLang | null>(null);` then `if (modelsReady.current !== sourceLang) { ...check/download... modelsReady.current = sourceLang; }` (set it on both the `present` and post-download branches; replace the early `modelsReady.current = true` writes accordingly).

- [ ] **Step 3: Lint + i18n.** `pnpm lint` (clean). `pnpm run i18n:extract` then translate the new keys (`Korean`, `Chinese`, `Japanese`, `Download {{lang}} OCR models?`, `Change OCR language`) per `docs/i18n.md`; `pnpm check:translations`.
- [ ] **Step 4: Commit** `feat(ocr): source-language picker + thread lang through auto-translate`.

### Task 11: On-device gate (Korean + Chinese)

**Files:** none (verification). Per [[android-build-flow]] in `.agents/memory`.

- [ ] **Step 1:** Build + install the debug APK on the x86_64 emulator (`pnpm android:onnx` first, then `pnpm tauri android build --debug --target x86_64 --apk`, strip/sign/install per the memory's emulator workflow).
- [ ] **Step 2:** Import a real **Korean manhwa** (CBZ or fixed-layout EPUB whose `<dc:language>`/`<LanguageISO>` = `ko`) and a real **Chinese manhua** (`zh`). For each: open, confirm the ✨ button appears, tap it → confirm the auto-detected language (no picker needed), accept the model download (~13–17 MB), and verify markers + popup show plausible translated text.
- [ ] **Step 3:** Tap the `▾` menu → switch language → confirm it re-runs in the chosen language and the choice persists after reopening the book (override remembered).
- [ ] **Step 4:** Note multi-line bubble quality. If multi-line crops are garbled (the Task-1 risk), file a fast-follow for line-segmentation; single/short bubbles passing is the acceptance bar. Capture screenshots.

## Final verification
- `cargo test -p manga-ocr` (CTC/preprocess/manifest unit tests pass; E2E stays `#[ignore]`).
- `pnpm test` (no new failures; `sourceLang.test.ts` passes). `pnpm lint`. `pnpm fmt:check` + `pnpm clippy:check` (src-tauri changed). `pnpm check:translations`.
- On-device gate passed for Korean and Chinese (auto-detect + override + plausible translations).

## Self-review
- **Spec coverage:** `CtcRecognizer` (T5), shared KO+ZH via one engine + `ctc_spec` (T4/T5), per-language manifests + `models-{ko,zh}-v1` + shared detector (T1/T4), pipeline dispatch (T6), `ensure/present` multi-lang + lang-keyed cache (T7), `resolveOcrSourceLang` auto-detect+override (T8), per-book persistence (T9), picker UI + threading + language-aware prompt (T10), Android-only gate unchanged (T10), error handling — undetected→menu (T10), unsupported→Err (T6/T7), CTC blank/BGR/normalize/input_h gotchas (T1/T2/T3/T5), testing (T2/T3/T4/T8/T11), model prep (T1). All mapped.
- **Type consistency:** `OcrSourceLang` (existing) used in T8/T9/T10; `CtcSpec`/`ctc_spec`/`manifest_for` identical across T4→T5→T7; `OcrPipeline::load(dir, lang)` + `run(bytes)` consistent T6→T7; `ctc_greedy_decode(logits, t, c, dict)` consistent T2→T5; `ctc_rec_pixels(img, input_h)` consistent T3→T5.
- **Known spike (not a placeholder):** Task 1 produces the real SHA-256/`input_h`/IO names that Tasks 4–5 consume, and validates the CTC recipe (incl. multi-line) before integration — the same de-risk-first approach used for the Japanese models. The `<SHA_*_FROM_TASK1>` tokens are explicit hand-offs from T1, filled before T4 builds.
