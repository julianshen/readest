# OCR Arena-Disable Memory Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the retained ~820 MB Native Heap of the on-device OCR pipeline by registering the ONNX Runtime CPU execution provider with the memory arena disabled on every OCR session.

**Architecture:** Add one `build_session(path)` helper (new `session.rs`) that builds an `ort` Session with `CPUExecutionProvider::default().with_arena_allocator(false)` (emits `DisableCpuMemArena`), and route all four OCR session loads through it. Outputs are bit-identical — the arena is an allocation strategy, not a compute path — so there is no accuracy or behavior change.

**Tech Stack:** Rust, `ort` 2.0.0-rc.12 (ONNX Runtime), the GTK-free `manga-ocr` crate (`apps/readest-app/crates/manga-ocr`). The `onnx` cargo feature gates all `ort`-using code.

**Spec:** `docs/superpowers/specs/2026-06-30-ocr-arena-memory-design.md`

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `apps/readest-app/crates/manga-ocr/src/session.rs` | The single place ORT session-construction policy lives: `build_session(path)`. | **Create** |
| `apps/readest-app/crates/manga-ocr/src/lib.rs` | Crate module list. | Modify (add `pub mod session;`) |
| `apps/readest-app/crates/manga-ocr/src/detect.rs` | `Detector::load` — detector session. | Modify (1 call site) |
| `apps/readest-app/crates/manga-ocr/src/recognize.rs` | `MangaOcrEngine::load` (encoder + decoder) and `CtcRecognizer::load` (rec) sessions. | Modify (3 call sites) |

All work runs from the app directory `apps/readest-app` unless a command says otherwise. The crate root is `apps/readest-app/crates/manga-ocr`.

---

### Task 1: `build_session` helper (arena disabled)

**Files:**
- Create: `apps/readest-app/crates/manga-ocr/src/session.rs`
- Modify: `apps/readest-app/crates/manga-ocr/src/lib.rs` (add module declaration)
- Test: in `apps/readest-app/crates/manga-ocr/src/session.rs` (uses the embedded `tests-fixtures/add_one.onnx`)

Notes for the implementer:
- The fixture `add_one.onnx` is a trivial `y = x + 1` model already in the crate (`tests-fixtures/add_one.onnx`); `crate::runtime::run_add_one(&mut session, x)` runs it and returns `x + 1`. Both are `pub` and gated on `feature = "onnx"`.
- `ort::ep::CPUExecutionProvider` is rc.12's alias of `ep::CPU`. `CPU::register` calls `DisableCpuMemArena` when `use_arena == false`. `SessionBuilder::with_execution_providers` takes `impl AsRef<[ExecutionProviderDispatch]>`, so a one-element array literal is valid.
- The whole module is `onnx`-gated. In a non-`onnx` build `session.rs` is an empty module — that is valid Rust and intentional, not a mistake.

- [ ] **Step 1: Create `session.rs` with the failing test only**

Create `apps/readest-app/crates/manga-ocr/src/session.rs` with exactly this (the helper is intentionally absent so the test fails to compile):

```rust
//! ORT session construction policy for the OCR models. Centralizes the
//! execution-provider configuration so every session is built the same way.

#[cfg(all(test, feature = "onnx"))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn build_session_loads_and_runs_with_arena_disabled() {
        // A session built with the CPU memory arena disabled must still load and
        // run a model correctly (outputs are unaffected by the allocation
        // strategy). Uses the embedded add_one fixture (y = x + 1).
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests-fixtures/add_one.onnx");
        let mut session = build_session(&fixture).expect("build_session should load the fixture");
        let y = crate::runtime::run_add_one(&mut session, vec![1.0, 2.0, 3.0]).expect("run");
        assert_eq!(y, vec![2.0, 3.0, 4.0]);
    }
}
```

Then add the module declaration to `apps/readest-app/crates/manga-ocr/src/lib.rs`. The current module list is:

```rust
pub mod ctc;
pub mod detect;
pub mod lines;
pub mod models;
pub mod page;
pub mod pipeline;
pub mod preprocess;
pub mod recognize;
pub mod runtime;
pub mod tokenizer;
```

Insert `pub mod session;` in alphabetical position (after `recognize;`, before `tokenizer;`) so the list reads:

```rust
pub mod ctc;
pub mod detect;
pub mod lines;
pub mod models;
pub mod page;
pub mod pipeline;
pub mod preprocess;
pub mod recognize;
pub mod runtime;
pub mod session;
pub mod tokenizer;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/readest-app/crates/manga-ocr && cargo test --features onnx build_session_loads_and_runs_with_arena_disabled`
Expected: FAIL — compile error `cannot find function 'build_session' in this scope`.

- [ ] **Step 3: Implement `build_session`**

Add this above the `tests` module in `apps/readest-app/crates/manga-ocr/src/session.rs`:

```rust
/// Build an `ort` Session for an OCR model with the CPU memory arena disabled.
///
/// By default ORT registers the CPU execution provider with a memory arena that
/// pools activation buffers and never returns them to the OS while the session
/// lives. The OCR pipeline is cached for the whole process, so that arena
/// retains hundreds of MB after the first inference. Registering the CPU EP with
/// `with_arena_allocator(false)` emits `DisableCpuMemArena`, so ORT frees
/// activation buffers after each `run()` instead. This is an allocation-strategy
/// change only — model outputs are identical.
#[cfg(feature = "onnx")]
pub(crate) fn build_session(
    path: &std::path::Path,
) -> Result<ort::session::Session, String> {
    use ort::ep::CPUExecutionProvider;
    ort::session::Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .with_execution_providers([CPUExecutionProvider::default()
            .with_arena_allocator(false)
            .build()])
        .map_err(|e| format!("ort cpu ep: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("ort load model {}: {e}", path.display()))
}
```

(The load error includes `path.display()` — strictly more informative than the per-call-site hardcoded strings it replaces in Task 2.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/readest-app/crates/manga-ocr && cargo test --features onnx build_session_loads_and_runs_with_arena_disabled`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/crates/manga-ocr/src/session.rs apps/readest-app/crates/manga-ocr/src/lib.rs
git commit -m "perf(ocr): add build_session helper that disables the CPU mem arena"
```

---

### Task 2: Route all four OCR sessions through `build_session`

**Files:**
- Modify: `apps/readest-app/crates/manga-ocr/src/detect.rs` (`Detector::load`, 1 site)
- Modify: `apps/readest-app/crates/manga-ocr/src/recognize.rs` (`MangaOcrEngine::load` encoder + decoder, `CtcRecognizer::load` rec — 3 sites)

This task has no new test; correctness is "every existing test still passes and the crate still builds with `onnx`." The four edits are mechanical replacements of the inline `Session::builder()…commit_from_file()` with the helper.

- [ ] **Step 1: Replace the detector session in `detect.rs`**

In `apps/readest-app/crates/manga-ocr/src/detect.rs`, `Detector::load`, replace:

```rust
        let session = ort::session::Session::builder()
            .map_err(|e| format!("ort builder: {e}"))?
            .commit_from_file(path)
            .map_err(|e| format!("ort load model: {e}"))?;
        Ok(Self { session })
```

with:

```rust
        let session = crate::session::build_session(path)?;
        Ok(Self { session })
```

- [ ] **Step 2: Replace the encoder + decoder sessions in `recognize.rs`**

In `apps/readest-app/crates/manga-ocr/src/recognize.rs`, `MangaOcrEngine::load`, replace:

```rust
        let encoder = ort::session::Session::builder()
            .map_err(|e| format!("ort builder (encoder): {e}"))?
            .commit_from_file(encoder_path)
            .map_err(|e| format!("ort load encoder: {e}"))?;
        let decoder = ort::session::Session::builder()
            .map_err(|e| format!("ort builder (decoder): {e}"))?
            .commit_from_file(decoder_path)
            .map_err(|e| format!("ort load decoder: {e}"))?;
```

with:

```rust
        let encoder = crate::session::build_session(encoder_path)?;
        let decoder = crate::session::build_session(decoder_path)?;
```

- [ ] **Step 3: Replace the CTC rec session in `recognize.rs`**

In `apps/readest-app/crates/manga-ocr/src/recognize.rs`, `CtcRecognizer::load`, replace:

```rust
        let session = ort::session::Session::builder()
            .map_err(|e| format!("ort builder (rec): {e}"))?
            .commit_from_file(rec_path)
            .map_err(|e| format!("ort load rec: {e}"))?;
```

with:

```rust
        let session = crate::session::build_session(rec_path)?;
```

- [ ] **Step 4: Verify the whole crate builds and tests pass (both feature modes)**

Run: `cd apps/readest-app/crates/manga-ocr && cargo test && cargo test --features onnx`
Expected: PASS in both. The onnx run includes `build_session_loads_and_runs_with_arena_disabled` and the existing `runtime` tests; the non-onnx run covers the pure-logic tests. No `#[ignore]` test is expected to run (those need real models).

- [ ] **Step 5: Format + lint**

Run: `cd apps/readest-app/crates/manga-ocr && cargo fmt && cargo clippy --features onnx --all-targets -- -D warnings`
Expected: no diff from `cargo fmt`, and clippy exits 0 with no warnings.

- [ ] **Step 6: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/crates/manga-ocr/src/detect.rs apps/readest-app/crates/manga-ocr/src/recognize.rs
git commit -m "perf(ocr): build all OCR sessions with the arena disabled"
```

---

### Task 3: On-device memory gate (release build)

**Files:** none (verification only). This is a manual on-device gate, not code. Per `.agents/memory` notes: use the **4 GB tablet AVD (emulator-5556)**; release builds are **not** debuggable so `run-as` is unavailable — measure via `dumpsys meminfo` only. The ✨ trigger needs the device-side-sleep tap pattern.

Goal: confirm OCR still works end-to-end on a release build and measure the Native Heap / TOTAL PSS delta against the baseline (~820 MB Native Heap / ~939 MB TOTAL PSS).

- [ ] **Step 1: Build + install a signed release APK**

```bash
cd /home/julianshen/projects/readest/apps/readest-app
pnpm android:onnx
pnpm tauri android build --target x86_64 --apk
adb -s emulator-5556 uninstall com.jlnshen.reader
adb -s emulator-5556 install src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

Confirm the install is a release build (no `DEBUGGABLE`): `adb -s emulator-5556 shell dumpsys package com.jlnshen.reader | grep pkgFlags=` → must NOT contain `DEBUGGABLE`.

- [ ] **Step 2: Import + open the ZH test book, run OCR**

Launch the app, import `/sdcard/Download/zh-manhua.cbz` (Import Books → Downloads → `zh-manhua.cbz`), open it. Reveal the toolbar and tap ✨ with the one-shot device-sleep pattern, then accept the download:

```bash
adb -s emulator-5556 shell "input tap 1280 800; sleep 0.8; input tap 426 92; sleep 1.2"   # reveal -> sparkle
adb -s emulator-5556 shell "input tap 1736 886"                                            # YES (download)
```

Wait for the model download + inference (Native Heap jumps when the pipeline loads).

- [ ] **Step 3: Measure memory**

```bash
adb -s emulator-5556 shell dumpsys meminfo com.jlnshen.reader | grep -E "Native Heap|^\s*TOTAL "
```

Take 2–3 stable reads. Record **Native Heap PSS** and **TOTAL PSS**.

- [ ] **Step 4: Confirm OCR still works (no functional regression)**

Verify detection + recognition still produce markers/translation on the ZH page (tap a bubble → translation popup), i.e. the arena-disabled sessions detect and recognize exactly as before.

- [ ] **Step 5: Record the result + decide next**

Compare against the baseline (~820 MB Native Heap / ~939 MB TOTAL PSS). Note the delta. If the drop is sufficient for a phone-safe footprint, the work is done; otherwise the measured number informs whether to pursue detector input-size reduction (768², a separate riskier PR). Capture the numbers in the PR description and in `.agents/memory` (`comic-auto-translate-phase1.md` backlog item #2).

---

## Final Verification

- `cargo test --features onnx` and `cargo test` both pass for `manga-ocr`.
- `cargo fmt --check` clean; `cargo clippy --features onnx --all-targets -- -D warnings` clean.
- CI `rust_lint` + `build_tauri_app` green on the PR.
- On-device: OCR still detects+recognizes on the release build; Native Heap / PSS delta measured and recorded vs the ~820 MB / ~939 MB baseline.

## Self-Review

- **Spec coverage:** helper with `with_arena_allocator(false)` → Task 1; applied to all 4 sessions → Task 2 (detector, encoder, decoder, rec); arena-only knob (no memory-pattern) → Task 1 helper has only `with_arena_allocator(false)`; new `session.rs` module → Task 1; outputs-unchanged claim → exercised by the add_one round-trip test (Task 1) + existing tests (Task 2); on-device measurement vs baseline → Task 3. All spec sections mapped.
- **Placeholder scan:** none — every code step shows complete code; every command has an expected result.
- **Type consistency:** `build_session(path: &std::path::Path) -> Result<ort::session::Session, String>` defined in Task 1 and called identically (`crate::session::build_session(<path>)?`) at all four sites in Task 2. `crate::runtime::run_add_one` used in the Task 1 test matches its real `pub fn run_add_one(session: &mut Session, x: Vec<f32>) -> Result<Vec<f32>, String>` signature.
- **YAGNI note:** no new abstraction beyond the single helper; memory-pattern disable and input-size reduction are deliberately deferred per the spec's "measure first" scope.
