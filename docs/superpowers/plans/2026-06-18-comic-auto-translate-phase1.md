# Comic Auto-Translate — Phase 1a Implementation Plan (ONNX spike + frontend-against-stub)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk the on-device ONNX runtime and build the complete auto-translate UI against a deterministic backend stub, so the real detector + manga-ocr can be dropped in later without UI rework.

**Architecture:** Two independent tracks. **Track A** stands up ONNX Runtime (`ort`) in the Tauri Rust backend and proves it runs a trivial model on desktop, then Android. **Track B** adds a real-but-stubbed `ocr_page_regions` Tauri command returning fake regions, and builds the frontend (toggle → call command → translate via existing `useTranslator` → overlay markers → tap → existing `BubbleTranslationPopup`), feature-flagged so it ships dark.

**Tech Stack:** Rust + Tauri v2 (`ort` 2.x ONNX Runtime, `image`, `serde`); TypeScript/React (vitest, `@tauri-apps/api`); reuses `utils/pageCapture.ts`, `hooks/useTranslator.ts`, `BubbleTranslationPopup`, `eventDispatcher`.

**Context the implementer needs (verified facts about this repo):**
- readest currently has **no** ML runtime. Rust deps live in `apps/readest-app/src-tauri/Cargo.toml`. Commands are registered in `apps/readest-app/src-tauri/src/lib.rs` via `tauri::generate_handler![...]` (around line 270); app state is managed in the `setup` closure (around line 395). Commands return `Result<T, String>`; errors use `.map_err(|e| format!("...: {}", e))?`. Rust tests are `#[cfg(test)] mod tests { ... }` in the same file, run with `pnpm test:rust` (`cargo test -p Readest --lib`). Rust format/lint gates: `pnpm fmt:check`, `pnpm clippy:check`.
- TS unit tests use **vitest** (`pnpm test -- <path>`), jsdom. Tauri IPC is `invoke` from `@tauri-apps/api/core` and `listen` from `@tauri-apps/api/event`.
- Comics are `IMAGE_BOOK_FORMATS` (`src/types/book.ts`, currently `{'CBZ'}`). The existing manual feature is `MangaBubbleToggler.tsx` (header), `MangaBubbleTranslator.tsx` (orchestrator), `RegionSelectOverlay.tsx`, `BubbleTranslationPopup.tsx`, with the load-bearing coordinate math in `src/utils/pageCapture.ts` (`computeNaturalCropRect`, `captureRegionToBlob`).
- The comic page `<img>` lives inside a foliate iframe; `MangaBubbleTranslator.onSelect` shows how to reach it: `getView(bookKey).renderer.getContents()` → the content whose iframe rect contains a point → `doc.querySelector('img')` and the iframe element + its CSS `transform` matrix scale.
- Run all commands from `apps/readest-app/`. Branch already created: `feat/manga-auto-translate`.

---

## TRACK A — ONNX Runtime spike (gating)

> Track A's purpose is **discovery + proof**. The `ort` API code below targets `ort` 2.x; if the pinned version's API differs, adapt the call sites — the **gates** (compiles; test passes; selftest returns the expected tensor on desktop and on the Android emulator) are what matter.

### Task A1: Add `ort` and prove the desktop build

**Files:**
- Modify: `apps/readest-app/src-tauri/Cargo.toml` (dependencies section, ~line 27–102)

- [ ] **Step 1: Add the dependency**

In `Cargo.toml`, under `[dependencies]`, add:

```toml
# ONNX Runtime for on-device inference (comic OCR). `download-binaries` fetches
# a prebuilt ORT for desktop targets; Android linking is handled in Task A4.
ort = { version = "2.0.0-rc.10", default-features = false, features = ["ndarray", "download-binaries"] }
ndarray = "0.16"
```

- [ ] **Step 2: Verify it builds (desktop)**

Run: `cd apps/readest-app && pnpm tauri build --no-bundle` (or `cargo build -p Readest --lib` from `src-tauri/`)
Expected: compiles successfully; `ort` and `ndarray` resolve and link. If `ort 2.0.0-rc.10` is unavailable, pin to the latest `2.x` shown by `cargo search ort` and re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/readest-app/src-tauri/Cargo.toml apps/readest-app/src-tauri/Cargo.lock
git commit -m "build(ocr): add ort + ndarray for on-device ONNX inference"
```

### Task A2: Tiny ONNX fixture + Rust inference unit test (desktop proof)

**Files:**
- Create: `apps/readest-app/src-tauri/tests-fixtures/add_one.onnx` (generated once, checked in)
- Create: `apps/readest-app/src-tauri/src/manga_ocr/mod.rs`
- Create: `apps/readest-app/src-tauri/src/manga_ocr/runtime.rs`
- Modify: `apps/readest-app/src-tauri/src/lib.rs` (add `mod manga_ocr;` near the other `mod` declarations)

- [ ] **Step 1: Generate the fixture model**

A one-time helper (requires `pip install onnx`). Run from `apps/readest-app/src-tauri/`:

```bash
mkdir -p tests-fixtures
python3 - <<'PY'
import onnx
from onnx import helper, TensorProto
# y = x + 1.0  (input "x": float32[N], output "y": float32[N])
x = helper.make_tensor_value_info("x", TensorProto.FLOAT, [None])
y = helper.make_tensor_value_info("y", TensorProto.FLOAT, [None])
one = helper.make_tensor("one", TensorProto.FLOAT, [1], [1.0])
node = helper.make_node("Add", ["x", "one"], ["y"])
graph = helper.make_graph([node], "add_one", [x], [y], [one])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
model.ir_version = 9
onnx.checker.check_model(model)
onnx.save(model, "tests-fixtures/add_one.onnx")
print("wrote tests-fixtures/add_one.onnx")
PY
```

Expected: prints `wrote tests-fixtures/add_one.onnx`.

- [ ] **Step 2: Write the failing test**

Create `apps/readest-app/src-tauri/src/manga_ocr/runtime.rs`:

```rust
//! Thin wrapper over ONNX Runtime (`ort`). Track A proves the runtime works;
//! Track B/Phase 1b build real models on top of these primitives.

use ndarray::Array1;
use ort::session::Session;

/// Build an `ort` Session from ONNX bytes (CPU execution provider).
pub fn session_from_bytes(model: &[u8]) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .commit_from_memory(model)
        .map_err(|e| format!("ort load model: {e}"))
}

/// Run the `add_one` fixture: input "x" -> output "y" = x + 1. Returns y.
pub fn run_add_one(session: &mut Session, x: Vec<f32>) -> Result<Vec<f32>, String> {
    let input = Array1::from_vec(x);
    let outputs = session
        .run(ort::inputs!["x" => input.view()].map_err(|e| format!("ort inputs: {e}"))?)
        .map_err(|e| format!("ort run: {e}"))?;
    let y = outputs["y"]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("ort extract: {e}"))?;
    Ok(y.1.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADD_ONE: &[u8] = include_bytes!("../../tests-fixtures/add_one.onnx");

    #[test]
    fn runs_a_trivial_onnx_model_on_cpu() {
        let mut session = session_from_bytes(ADD_ONE).expect("load fixture");
        let y = run_add_one(&mut session, vec![1.0, 2.0, 3.0]).expect("run");
        assert_eq!(y, vec![2.0, 3.0, 4.0]);
    }
}
```

Create `apps/readest-app/src-tauri/src/manga_ocr/mod.rs`:

```rust
//! On-device comic OCR. Phase 1a: runtime spike + a stubbed page command.
pub mod runtime;
```

Add `mod manga_ocr;` to `apps/readest-app/src-tauri/src/lib.rs` alongside the other top-level `mod` declarations (e.g., next to `mod ai;`).

- [ ] **Step 3: Run the test to verify it fails first, then passes**

Run: `cd apps/readest-app && pnpm test:rust`
Expected initially: if `ort::inputs!`/extraction API differs from your pinned `ort`, you'll get a compile error — adjust the two call sites to the pinned API until the test **compiles and passes** with `assert_eq!(y, vec![2.0, 3.0, 4.0])`. This passing test is the desktop proof gate.

- [ ] **Step 4: Format, lint, commit**

```bash
cd apps/readest-app && pnpm fmt:check && pnpm clippy:check && pnpm test:rust
git add apps/readest-app/src-tauri/src/manga_ocr apps/readest-app/src-tauri/tests-fixtures apps/readest-app/src-tauri/src/lib.rs
git commit -m "feat(ocr): run a trivial ONNX model via ort on desktop (spike)"
```

### Task A3: `ocr_runtime_selftest` Tauri command

**Files:**
- Modify: `apps/readest-app/src-tauri/src/manga_ocr/mod.rs`
- Modify: `apps/readest-app/src-tauri/src/lib.rs` (`generate_handler!` list, ~line 270)

- [ ] **Step 1: Add the command**

Append to `apps/readest-app/src-tauri/src/manga_ocr/mod.rs`:

```rust
use crate::manga_ocr::runtime::{run_add_one, session_from_bytes};

const ADD_ONE: &[u8] = include_bytes!("../../tests-fixtures/add_one.onnx");

/// Smoke-tests the ONNX runtime end to end from the JS layer.
/// Returns `[2.0, 3.0, 4.0]` when the runtime is healthy.
#[tauri::command]
pub async fn ocr_runtime_selftest() -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut session = session_from_bytes(ADD_ONE)?;
        run_add_one(&mut session, vec![1.0, 2.0, 3.0])
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}
```

- [ ] **Step 2: Register it**

In `apps/readest-app/src-tauri/src/lib.rs`, add to the `tauri::generate_handler![...]` list (next to the `ai::*` commands):

```rust
manga_ocr::ocr_runtime_selftest,
```

- [ ] **Step 3: Verify build + lint**

Run: `cd apps/readest-app && pnpm fmt:check && pnpm clippy:check && cargo build -p Readest --lib` (from `src-tauri/`)
Expected: compiles; command registered.

- [ ] **Step 4: Commit**

```bash
git add apps/readest-app/src-tauri/src/manga_ocr/mod.rs apps/readest-app/src-tauri/src/lib.rs
git commit -m "feat(ocr): expose ocr_runtime_selftest tauri command"
```

### Task A4: Android build + on-device selftest (THE gate)

> This is the spike's make-or-break. `ort`'s `download-binaries` covers desktop, **not** Android. You must provide the ONNX Runtime Android native libs (`libonnxruntime.so` for `arm64-v8a`/`x86_64`) so the Rust lib links and loads at runtime. Recommended: use `ort`'s `load-dynamic` feature and ship the prebuilt `onnxruntime-android` `.so` in the APK `jniLibs`, OR consume the official `onnxruntime-android` AAR. Treat this task as iterative; the gate is the on-device call returning `[2,3,4]`.

**Files:**
- Modify: `apps/readest-app/src-tauri/Cargo.toml` (per-target `ort` feature, if needed)
- Add: prebuilt `libonnxruntime.so` under the Android `jniLibs` for each ABI (path discovered during the task)

- [ ] **Step 1: Switch Android to dynamic loading (if static download fails)**

If `pnpm tauri android build --debug --target x86_64 --apk` fails to find ORT for Android, change the dep to load the lib at runtime:

```toml
ort = { version = "2.0.0-rc.10", default-features = false, features = ["ndarray", "load-dynamic"] }
```
and add the matching `download-binaries` only for desktop via a target table, e.g.:
```toml
[target.'cfg(not(target_os = "android"))'.dependencies]
ort = { version = "2.0.0-rc.10", default-features = false, features = ["ndarray", "download-binaries"] }
```
(Keep the base dep without `download-binaries` so Android uses `load-dynamic`.)

- [ ] **Step 2: Place the ONNX Runtime Android `.so`**

Download the official `onnxruntime-android` AAR (Maven: `com.microsoft.onnxruntime:onnxruntime-android`), extract `jni/<abi>/libonnxruntime.so`, and copy into the app's `jniLibs/<abi>/` (the same place `libreadestlib.so` lands — confirm the exact gen path during the build). Document the version + source in a comment/README next to it.

- [ ] **Step 3: Build, install, and run the selftest on the emulator**

Build the x86_64 debug APK per the project's emulator flow (strip/sign/install — see `.agents/memory/android-build-flow.md`). Then, from a dev build, invoke the command and log it. Add a temporary dev-only call (remove before commit) in a reachable spot, e.g. a `useEffect` that runs once:

```ts
import { invoke } from '@tauri-apps/api/core';
invoke<number[]>('ocr_runtime_selftest').then((r) => console.log('[ocr selftest]', r));
```

Verify in `adb logcat | grep "ocr selftest"`:
Expected: `[ocr selftest] [2, 3, 4]` — **this is the gate proving ONNX Runtime works on Android.**

- [ ] **Step 4: Remove the temporary call; commit the working Android linkage**

```bash
git add apps/readest-app/src-tauri/Cargo.toml <jniLibs path>
git commit -m "build(ocr): link ONNX Runtime on Android; selftest passes on-device"
```

> **Track A exit criteria:** `ocr_runtime_selftest` returns `[2,3,4]` on desktop (unit test) AND on the Android emulator (logcat). If Android linking proves infeasible with `ort`, STOP and escalate — the on-device decision needs revisiting before Phase 1b.

---

## TRACK B — Backend stub + frontend (against the real stub command)

### Task B1: Rust `DetectedRegion` contract + stubbed `ocr_page_regions`

**Files:**
- Create: `apps/readest-app/src-tauri/src/manga_ocr/page.rs`
- Modify: `apps/readest-app/src-tauri/src/manga_ocr/mod.rs` (`pub mod page;`)
- Modify: `apps/readest-app/src-tauri/src/lib.rs` (`generate_handler!`)

- [ ] **Step 1: Write the failing test + types**

Create `apps/readest-app/src-tauri/src/manga_ocr/page.rs`:

```rust
//! `ocr_page_regions`: detect + OCR a comic page into translatable regions.
//! Phase 1a ships a deterministic STUB so the frontend can integrate against a
//! real IPC command; Phase 1b replaces `detect_and_ocr` with the real pipeline.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BBox {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRegion {
    pub id: u32,
    pub bbox: BBox,
    pub original: String,
}

/// Decode the page just enough to know its size, then return deterministic
/// placeholder regions positioned relative to the real image dimensions, so
/// the frontend overlay can be exercised with correct coordinate mapping.
pub fn detect_and_ocr(image_bytes: &[u8], _source_lang: &str) -> Result<Vec<DetectedRegion>, String> {
    let img = image::load_from_memory(image_bytes).map_err(|e| format!("decode image: {e}"))?;
    let (w, h) = (img.width(), img.height());
    Ok(vec![
        DetectedRegion {
            id: 0,
            bbox: BBox { x: w / 10, y: h / 10, w: w / 4, h: h / 8 },
            original: "サンプル".to_string(),
        },
        DetectedRegion {
            id: 1,
            bbox: BBox { x: w / 2, y: h / 2, w: w / 4, h: h / 8 },
            original: "テスト".to_string(),
        },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_regions_scaled_to_image_size() {
        // 100x80 white PNG
        let mut buf = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(100, 80, image::Rgb([255, 255, 255]))
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let regions = detect_and_ocr(buf.get_ref(), "ja").unwrap();
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].bbox, BBox { x: 10, y: 8, w: 25, h: 10 });
        assert_eq!(regions[0].original, "サンプル");
    }

    #[test]
    fn errors_on_undecodable_bytes() {
        assert!(detect_and_ocr(&[0, 1, 2, 3], "ja").is_err());
    }
}
```

- [ ] **Step 2: Run the test (fails to compile → passes)**

Run: `cd apps/readest-app && pnpm test:rust`
Expected: passes once `pub mod page;` is added (next step) — confirms deterministic, size-relative stub output.

- [ ] **Step 3: Add the command + module wiring**

Append the command to `page.rs`:

```rust
#[tauri::command]
pub async fn ocr_page_regions(
    image_bytes: Vec<u8>,
    source_lang: String,
) -> Result<Vec<DetectedRegion>, String> {
    tauri::async_runtime::spawn_blocking(move || detect_and_ocr(&image_bytes, &source_lang))
        .await
        .map_err(|e| format!("join: {e}"))?
}
```

In `manga_ocr/mod.rs` add `pub mod page;`. In `lib.rs` `generate_handler!`, add `manga_ocr::page::ocr_page_regions,`.

- [ ] **Step 4: Verify + commit**

```bash
cd apps/readest-app && pnpm fmt:check && pnpm clippy:check && pnpm test:rust
git add apps/readest-app/src-tauri/src/manga_ocr apps/readest-app/src-tauri/src/lib.rs
git commit -m "feat(ocr): stubbed ocr_page_regions command returning size-relative regions"
```

### Task B2: TS contract + backend adapter

**Files:**
- Create: `apps/readest-app/src/services/ocr/types.ts`
- Create: `apps/readest-app/src/services/ocr/ocrBackend.ts`
- Test: `apps/readest-app/src/__tests__/services/ocr/ocrBackend.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/services/ocr/ocrBackend.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { ocrPageRegions } from '@/services/ocr/ocrBackend';

afterEach(() => invoke.mockReset());

describe('ocrPageRegions', () => {
  it('calls the ocr_page_regions command with bytes as a number array and the source lang', async () => {
    invoke.mockResolvedValue([{ id: 0, bbox: { x: 1, y: 2, w: 3, h: 4 }, original: 'あ' }]);
    const out = await ocrPageRegions(new Uint8Array([7, 8, 9]), 'ja');
    expect(invoke).toHaveBeenCalledWith('ocr_page_regions', {
      imageBytes: [7, 8, 9],
      sourceLang: 'ja',
    });
    expect(out).toEqual([{ id: 0, bbox: { x: 1, y: 2, w: 3, h: 4 }, original: 'あ' }]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/services/ocr/ocrBackend.test.ts`
Expected: FAIL — `Cannot find module '@/services/ocr/ocrBackend'`.

- [ ] **Step 3: Implement**

Create `apps/readest-app/src/services/ocr/types.ts`:

```ts
export type OcrSourceLang = 'ja' | 'ko' | 'zh';

export interface OcrBBox {
  x: number;
  y: number;
  w: number;
  h: number;
} // image pixels

export interface DetectedRegion {
  id: number;
  bbox: OcrBBox;
  original: string;
}

// A region after the TS layer has translated `original`.
export interface TranslatedRegion extends DetectedRegion {
  translation: string;
}
```

Create `apps/readest-app/src/services/ocr/ocrBackend.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';
import type { DetectedRegion, OcrSourceLang } from './types';

// Detect + OCR a comic page in the Rust backend. Returns image-pixel boxes +
// the original (untranslated) text per region.
export const ocrPageRegions = (
  imageBytes: Uint8Array,
  sourceLang: OcrSourceLang,
): Promise<DetectedRegion[]> =>
  invoke<DetectedRegion[]>('ocr_page_regions', {
    imageBytes: Array.from(imageBytes),
    sourceLang,
  });
```

- [ ] **Step 4: Run + commit**

```bash
cd apps/readest-app && pnpm test -- src/__tests__/services/ocr/ocrBackend.test.ts && pnpm lint
git add apps/readest-app/src/services/ocr apps/readest-app/src/__tests__/services/ocr
git commit -m "feat(ocr): TS contract + ocr_page_regions backend adapter"
```

### Task B3: Inverse coordinate mapping (image px → viewport rect)

> The forward map (drag → source px) is `computeNaturalCropRect` in `utils/pageCapture.ts`. Overlay markers need the inverse: a detector box in image pixels → a viewport rectangle, using the same iframe geometry.

**Files:**
- Create: `apps/readest-app/src/utils/bubbleOverlay.ts`
- Test: `apps/readest-app/src/__tests__/utils/bubbleOverlay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/utils/bubbleOverlay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapImageBBoxToViewport, type OverlayGeometry } from '@/utils/bubbleOverlay';

// Image is 1000x1500 natural; rendered at half scale inside an iframe that the
// fixed-layout renderer also CSS-scales by 0.5; iframe sits at viewport (100,50).
const geom: OverlayGeometry = {
  frameLeft: 100,
  frameTop: 50,
  frameScaleX: 0.5,
  frameScaleY: 0.5,
  imgLeft: 0, // image's iframe-local offset
  imgTop: 0,
  imgWidth: 500, // rendered (iframe-local) image width
  imgHeight: 750,
  naturalWidth: 1000,
  naturalHeight: 1500,
};

describe('mapImageBBoxToViewport', () => {
  it('maps an image-pixel box to a viewport rect via the iframe geometry', () => {
    // box at natural (200,300) size 100x150 -> iframe-local (100,150) size 50x75
    // -> viewport: left = 100 + 100*0.5 = 150; top = 50 + 150*0.5 = 125; w=25; h=37.5
    expect(mapImageBBoxToViewport({ x: 200, y: 300, w: 100, h: 150 }, geom)).toEqual({
      left: 150,
      top: 125,
      width: 25,
      height: 37.5,
    });
  });

  it('is the inverse of the rendered-to-natural ratio at the origin', () => {
    expect(mapImageBBoxToViewport({ x: 0, y: 0, w: 0, h: 0 }, geom)).toEqual({
      left: 100,
      top: 50,
      width: 0,
      height: 0,
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/utils/bubbleOverlay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/readest-app/src/utils/bubbleOverlay.ts`:

```ts
import type { OcrBBox } from '@/services/ocr/types';

// Geometry of the rendered comic page, gathered the same way
// MangaBubbleTranslator.onSelect does (iframe rect + CSS transform scale,
// image bounding rect in iframe-local coords, image natural size).
export interface OverlayGeometry {
  frameLeft: number;
  frameTop: number;
  frameScaleX: number;
  frameScaleY: number;
  imgLeft: number;
  imgTop: number;
  imgWidth: number; // rendered (iframe-local) px
  imgHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Inverse of computeNaturalCropRect: image-pixel bbox -> viewport rect.
export const mapImageBBoxToViewport = (bbox: OcrBBox, g: OverlayGeometry): ViewportRect => {
  const kx = g.imgWidth / g.naturalWidth; // natural px -> iframe-local px
  const ky = g.imgHeight / g.naturalHeight;
  const localLeft = g.imgLeft + bbox.x * kx;
  const localTop = g.imgTop + bbox.y * ky;
  return {
    left: g.frameLeft + localLeft * g.frameScaleX,
    top: g.frameTop + localTop * g.frameScaleY,
    width: bbox.w * kx * g.frameScaleX,
    height: bbox.h * ky * g.frameScaleY,
  };
};
```

- [ ] **Step 4: Run + commit**

```bash
cd apps/readest-app && pnpm test -- src/__tests__/utils/bubbleOverlay.test.ts && pnpm lint
git add apps/readest-app/src/utils/bubbleOverlay.ts apps/readest-app/src/__tests__/utils/bubbleOverlay.test.ts
git commit -m "feat(ocr): inverse coordinate mapping for bubble overlay markers"
```

### Task B4: Page-translate orchestration (pure core + cache)

> Keep the testable logic pure: a function that, given detected regions and a translate fn, returns translated regions, plus a per-page cache keyed by (bookKey, sectionIndex). The React hook (Task B6) is a thin shell around this.

**Files:**
- Create: `apps/readest-app/src/services/ocr/translatePage.ts`
- Test: `apps/readest-app/src/__tests__/services/ocr/translatePage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/services/ocr/translatePage.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { translateRegions, pageCacheKey } from '@/services/ocr/translatePage';
import type { DetectedRegion } from '@/services/ocr/types';

const regions: DetectedRegion[] = [
  { id: 0, bbox: { x: 0, y: 0, w: 1, h: 1 }, original: 'あ' },
  { id: 1, bbox: { x: 2, y: 2, w: 1, h: 1 }, original: '   ' }, // blank
];

describe('translateRegions', () => {
  it('translates non-blank originals in one batch, preserving order/ids', async () => {
    const translate = vi.fn().mockResolvedValue(['A']);
    const out = await translateRegions(regions, translate, { source: 'ja', target: 'en' });
    expect(translate).toHaveBeenCalledWith(['あ'], { source: 'ja', target: 'en' });
    expect(out).toEqual([
      { id: 0, bbox: { x: 0, y: 0, w: 1, h: 1 }, original: 'あ', translation: 'A' },
      { id: 1, bbox: { x: 2, y: 2, w: 1, h: 1 }, original: '   ', translation: '' },
    ]);
  });

  it('falls back to the original text when translation fails', async () => {
    const translate = vi.fn().mockRejectedValue(new Error('net'));
    const out = await translateRegions(regions, translate, { source: 'ja', target: 'en' });
    expect(out[0].translation).toBe('あ');
  });
});

describe('pageCacheKey', () => {
  it('is stable per book + section + target language', () => {
    expect(pageCacheKey('book#1', 3, 'en')).toBe('book#1::3::en');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/services/ocr/translatePage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/readest-app/src/services/ocr/translatePage.ts`:

```ts
import type { DetectedRegion, TranslatedRegion } from './types';

export type BatchTranslate = (
  input: string[],
  options: { source: string; target: string },
) => Promise<string[]>;

export const pageCacheKey = (bookKey: string, sectionIndex: number, target: string): string =>
  `${bookKey}::${sectionIndex}::${target}`;

// Translate a page's detected regions in one batch. Blank originals are kept
// as-is; on failure each region falls back to showing its original text so the
// overlay still renders something useful.
export const translateRegions = async (
  regions: DetectedRegion[],
  translate: BatchTranslate,
  langs: { source: string; target: string },
): Promise<TranslatedRegion[]> => {
  const indices = regions
    .map((r, i) => (r.original.trim() ? i : -1))
    .filter((i) => i >= 0);
  let translations: string[] = [];
  try {
    if (indices.length) {
      translations = await translate(
        indices.map((i) => regions[i]!.original),
        langs,
      );
    }
  } catch {
    translations = indices.map((i) => regions[i]!.original); // fallback to source
  }
  const byIndex = new Map(indices.map((i, k) => [i, translations[k] ?? regions[i]!.original]));
  return regions.map((r, i) => ({ ...r, translation: byIndex.get(i) ?? '' }));
};
```

- [ ] **Step 4: Run + commit**

```bash
cd apps/readest-app && pnpm test -- src/__tests__/services/ocr/translatePage.test.ts && pnpm lint
git add apps/readest-app/src/services/ocr/translatePage.ts apps/readest-app/src/__tests__/services/ocr/translatePage.test.ts
git commit -m "feat(ocr): pure page-translation core + cache key"
```

### Task B5: `AutoBubbleOverlay` markers component

> Renders a marker per translated region at its mapped viewport rect; clicking sets the active region (parent shows the existing popup). Test the marker placement/rendering with jsdom.

**Files:**
- Create: `apps/readest-app/src/app/reader/components/annotator/AutoBubbleOverlay.tsx`
- Test: `apps/readest-app/src/__tests__/components/AutoBubbleOverlay.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/components/AutoBubbleOverlay.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AutoBubbleOverlay from '@/app/reader/components/annotator/AutoBubbleOverlay';
import type { ViewportRect } from '@/utils/bubbleOverlay';

const markers: { id: number; rect: ViewportRect; translation: string }[] = [
  { id: 0, rect: { left: 10, top: 20, width: 30, height: 40 }, translation: 'Hello' },
  { id: 1, rect: { left: 50, top: 60, width: 30, height: 40 }, translation: 'Bye' },
];

describe('AutoBubbleOverlay', () => {
  it('renders one marker per region positioned at its viewport rect', () => {
    render(<AutoBubbleOverlay markers={markers} onActivate={vi.fn()} />);
    const buttons = screen.getAllByRole('button', { name: /translation/i });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveStyle({ left: '10px', top: '20px' });
  });

  it('calls onActivate with the region id when a marker is tapped', () => {
    const onActivate = vi.fn();
    render(<AutoBubbleOverlay markers={markers} onActivate={onActivate} />);
    fireEvent.click(screen.getAllByRole('button', { name: /translation/i })[1]!);
    expect(onActivate).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/components/AutoBubbleOverlay.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/readest-app/src/app/reader/components/annotator/AutoBubbleOverlay.tsx`:

```tsx
import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { ViewportRect } from '@/utils/bubbleOverlay';

export interface BubbleMarker {
  id: number;
  rect: ViewportRect;
  translation: string;
}

interface Props {
  markers: BubbleMarker[];
  onActivate: (id: number) => void;
}

// A transparent, click-through layer with one tappable marker per detected
// bubble. The layer itself ignores pointer events; only the markers capture taps
// so reading/pinch still work between bubbles.
const AutoBubbleOverlay = ({ markers, onActivate }: Props) => {
  const _ = useTranslation();
  return (
    <div className='pointer-events-none fixed inset-0 z-40'>
      {markers.map((m) => (
        <button
          key={m.id}
          aria-label={_('Show translation')}
          onClick={() => onActivate(m.id)}
          className='pointer-events-auto absolute rounded-sm border border-blue-500/70 bg-blue-500/10'
          style={{ left: m.rect.left, top: m.rect.top, width: m.rect.width, height: m.rect.height }}
        />
      ))}
    </div>
  );
};

export default AutoBubbleOverlay;
```

- [ ] **Step 4: Run + commit**

```bash
cd apps/readest-app && pnpm test -- src/__tests__/components/AutoBubbleOverlay.test.tsx && pnpm lint
git add apps/readest-app/src/app/reader/components/annotator/AutoBubbleOverlay.tsx apps/readest-app/src/__tests__/components/AutoBubbleOverlay.test.tsx
git commit -m "feat(ocr): AutoBubbleOverlay markers component"
```

### Task B6: Orchestration hook + toggle wiring (behind a feature flag)

> Ties it together: a flag-gated control that, when enabled on a comic page, fetches page bytes via `section.loadImage()`, calls `ocrPageRegions`, translates via `useTranslator`, maps boxes to viewport rects (gathering geometry like `MangaBubbleTranslator.onSelect`), renders `AutoBubbleOverlay`, and shows the existing `BubbleTranslationPopup` for the active region. Ships dark behind the flag until Phase 1b.

**Files:**
- Create: `apps/readest-app/src/app/reader/hooks/useAutoBubbleTranslate.ts`
- Modify: `apps/readest-app/src/app/reader/components/annotator/MangaBubbleTranslator.tsx` (mount the overlay + active-region popup; add the "Auto-translate page" path)
- Modify: `apps/readest-app/src/app/reader/components/MangaBubbleToggler.tsx` (offer "Auto-translate page" when the flag is on; loosen the AI-key gate for the auto path since OCR is on-device + translation can be keyless)
- Create: `apps/readest-app/src/services/constants.ts` flag — add `AUTO_BUBBLE_TRANSLATE_ENABLED = false` (or reuse the existing feature-flag mechanism if one exists; grep `process.env.NEXT_PUBLIC_` flags first and follow that pattern)
- Test: `apps/readest-app/src/__tests__/hooks/useAutoBubbleTranslate.test.ts`

- [ ] **Step 1: Write the failing test (hook core: regions → markers)**

The DOM-geometry gathering is integration-only; unit-test the pure transform the hook uses. Create `apps/readest-app/src/__tests__/hooks/useAutoBubbleTranslate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { regionsToMarkers } from '@/app/reader/hooks/useAutoBubbleTranslate';
import type { OverlayGeometry } from '@/utils/bubbleOverlay';
import type { TranslatedRegion } from '@/services/ocr/types';

const geom: OverlayGeometry = {
  frameLeft: 0, frameTop: 0, frameScaleX: 1, frameScaleY: 1,
  imgLeft: 0, imgTop: 0, imgWidth: 100, imgHeight: 100,
  naturalWidth: 100, naturalHeight: 100,
};

describe('regionsToMarkers', () => {
  it('maps translated regions to positioned markers (1:1 geometry)', () => {
    const regions: TranslatedRegion[] = [
      { id: 5, bbox: { x: 10, y: 20, w: 30, h: 40 }, original: 'あ', translation: 'A' },
    ];
    expect(regionsToMarkers(regions, geom)).toEqual([
      { id: 5, rect: { left: 10, top: 20, width: 30, height: 40 }, translation: 'A' },
    ]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/hooks/useAutoBubbleTranslate.test.ts`
Expected: FAIL — `regionsToMarkers` not exported.

- [ ] **Step 3: Implement the hook**

Create `apps/readest-app/src/app/reader/hooks/useAutoBubbleTranslate.ts`. Export the pure `regionsToMarkers` and the hook. Gather geometry exactly like `MangaBubbleTranslator.onSelect` (reuse that code path — extract a shared `getActivePageGeometry(bookKey)` helper if it reduces duplication):

```ts
import { useCallback, useRef, useState } from 'react';
import { mapImageBBoxToViewport, type OverlayGeometry } from '@/utils/bubbleOverlay';
import type { BubbleMarker } from '@/app/reader/components/annotator/AutoBubbleOverlay';
import type { TranslatedRegion } from '@/services/ocr/types';
import { ocrPageRegions } from '@/services/ocr/ocrBackend';
import { translateRegions, pageCacheKey } from '@/services/ocr/translatePage';

export const regionsToMarkers = (
  regions: TranslatedRegion[],
  geom: OverlayGeometry,
): BubbleMarker[] =>
  regions.map((r) => ({
    id: r.id,
    rect: mapImageBBoxToViewport(r.bbox, geom),
    translation: r.translation,
  }));

// The hook: run(bytes, geometry, sourceLang, langs, translate) -> markers,
// cached per page key. (DOM geometry + section.loadImage are provided by the
// caller in MangaBubbleTranslator so this stays testable.)
export const useAutoBubbleTranslate = () => {
  const cache = useRef(new Map<string, TranslatedRegion[]>());
  const [markers, setMarkers] = useState<BubbleMarker[]>([]);
  const [regions, setRegions] = useState<TranslatedRegion[]>([]);

  const run = useCallback(
    async (args: {
      cacheKeyParts: { bookKey: string; sectionIndex: number; target: string };
      imageBytes: Uint8Array;
      geometry: OverlayGeometry;
      sourceLang: 'ja' | 'ko' | 'zh';
      langs: { source: string; target: string };
      translate: (input: string[], o: { source: string; target: string }) => Promise<string[]>;
    }) => {
      const key = pageCacheKey(
        args.cacheKeyParts.bookKey,
        args.cacheKeyParts.sectionIndex,
        args.cacheKeyParts.target,
      );
      let translated = cache.current.get(key);
      if (!translated) {
        const detected = await ocrPageRegions(args.imageBytes, args.sourceLang);
        translated = await translateRegions(detected, args.translate, args.langs);
        cache.current.set(key, translated);
      }
      setRegions(translated);
      setMarkers(regionsToMarkers(translated, args.geometry));
    },
    [],
  );

  return { markers, regions, run, clear: () => { setMarkers([]); setRegions([]); } };
};
```

- [ ] **Step 4: Run the hook test**

Run: `cd apps/readest-app && pnpm test -- src/__tests__/hooks/useAutoBubbleTranslate.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire UI behind the flag (no new test; manual gate)**

- Add the flag (follow the repo's existing `NEXT_PUBLIC_` flag pattern; default off).
- In `MangaBubbleToggler.tsx`: when the flag is on and the book is a comic, show an "Auto-translate page" action (a second item, or replace the single button with a small menu: Auto / Region). The auto path does NOT require `isAIAssistantConfigured` (OCR is on-device; translation uses the configured translator). It dispatches a new event, e.g. `eventDispatcher.dispatch('manga-auto-translate', { bookKey })`.
- In `MangaBubbleTranslator.tsx`: on `'manga-auto-translate'`, gather the active page geometry + `section.loadImage()` bytes (via the foliate book section for the primary index), call `useAutoBubbleTranslate().run(...)` with `useTranslator().translate` and the comic's source language (default `'ja'`), render `<AutoBubbleOverlay markers={markers} onActivate={...} />`, and on activate open the existing `<BubbleTranslationPopup>` populated from the matching region's `original`/`translation`.

- [ ] **Step 6: Full gates + commit**

```bash
cd apps/readest-app && pnpm lint && pnpm test && pnpm check:translations
git add -A
git commit -m "feat(ocr): flag-gated auto-translate page wiring (stub backend)"
```

- [ ] **Step 7: Manual integration gate (emulator)**

With the flag on, build/install the x86_64 debug APK, open a CBZ, trigger "Auto-translate page". Expect two markers at the stub's size-relative positions; tapping one opens the popup showing `サンプル`/`テスト` translated by the configured translator. This proves the **entire UI path** end-to-end against the real (stub) command, ready to swap in the Phase 1b pipeline.

---

## Self-review

**Spec coverage (Phase 1 scope):** ONNX runtime on-device ✓ (A1–A4); Tauri command boundary returning `DetectedRegion[]` ✓ (B1–B2); translation reuses existing translators ✓ (B4, B6); tap-to-reveal popup reuse ✓ (B5–B6); coordinate mapping reuse/inverse ✓ (B3); per-page cache ✓ (B4); CBZ gating + flag ✓ (B6). Deferred to Phase 1b (documented): real comic-text-detector + manga-ocr, model download manager, source-language picker UI, webtoon-strip downscaling.

**Placeholder scan:** the only intentionally-iterative work is Task A4 (Android ONNX linking) and the Step-5 UI wiring in B6 — both are framed with explicit gates and reference exact existing code to copy, not vague "handle it" instructions. The `ort` API specifics are flagged as version-dependent with a concrete pass/fail gate.

**Type consistency:** `DetectedRegion { id, bbox{x,y,w,h}, original }` is identical in Rust (`page.rs`, camelCase serde) and TS (`types.ts`); `TranslatedRegion` extends it with `translation`; `OverlayGeometry`/`ViewportRect`/`BubbleMarker` names are used consistently across B3/B5/B6; `ocrPageRegions(Uint8Array, OcrSourceLang)` matches the command's `(image_bytes: Vec<u8>, source_lang: String)`.
</content>
