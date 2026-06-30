# OCR Memory-Pattern Disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trim the transient OCR inference memory peak by also disabling ONNX Runtime's memory-pattern planner in the shared `build_session` helper, on top of the already-shipped CPU-arena disable.

**Architecture:** Add one builder call — `.with_memory_pattern(false)` — to the existing `build_session` helper (`crates/manga-ocr/src/session.rs`). All four OCR sessions already route through it, so there are no call-site changes. Memory-pattern is an allocation-strategy setting, so model outputs are bit-identical (no accuracy/behavior change). The existing round-trip test is a regression guard that stays green; it gets renamed knob-agnostic since it now covers both allocator knobs.

**Tech Stack:** Rust, `ort` 2.0.0-rc.12 (ONNX Runtime), the GTK-free `manga-ocr` crate. The `onnx` cargo feature gates all `ort`-using code; the crate builds + tests locally with `--features onnx` (binaries cached).

**Spec:** `docs/superpowers/specs/2026-06-30-ocr-mem-pattern-design.md`

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `apps/readest-app/crates/manga-ocr/src/session.rs` | The single place ORT session-construction policy lives: `build_session(path)` + its round-trip test. | Modify (add one builder call; extend doc comment; rename the test) |

No other files change — the four call sites (in `detect.rs` / `recognize.rs`) already call `build_session` and are untouched.

All commands run from the crate root `apps/readest-app/crates/manga-ocr` unless stated; commits run from the repo root `/home/julianshen/projects/readest`.

---

### Task 1: Add memory-pattern disable to `build_session`

**Files:**
- Modify: `apps/readest-app/crates/manga-ocr/src/session.rs` (helper body + doc comment + test name/comment)

This is a behavior-preserving config change, so the round-trip test stays green throughout — it guards against the new builder call breaking session load/run/output. There is no new failing test to write.

- [ ] **Step 1: Rename the round-trip test knob-agnostic (it now covers both knobs)**

In `apps/readest-app/crates/manga-ocr/src/session.rs`, in the `tests` module, replace:

```rust
    #[test]
    fn build_session_loads_and_runs_with_arena_disabled() {
        // A session built with the CPU memory arena disabled must still load and
        // run a model correctly (outputs are unaffected by the allocation
        // strategy). Uses the embedded add_one fixture (y = x + 1).
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests-fixtures/add_one.onnx");
```

with:

```rust
    #[test]
    fn build_session_loads_and_runs() {
        // A session built with the low-memory allocator settings (arena +
        // memory-pattern disabled) must still load and run a model correctly
        // (outputs are unaffected by the allocation strategy). Uses the embedded
        // add_one fixture (y = x + 1).
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests-fixtures/add_one.onnx");
```

- [ ] **Step 2: Run the renamed test to confirm it still passes (green baseline)**

Run: `cd apps/readest-app/crates/manga-ocr && cargo test --features onnx build_session_loads_and_runs`
Expected: PASS (`test session::tests::build_session_loads_and_runs ... ok`, 1 passed). This confirms the rename is clean before the behavior-preserving code change.

- [ ] **Step 3: Add the memory-pattern disable + extend the doc comment**

In the same file, replace the doc comment + helper body. Replace this block:

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
pub(crate) fn build_session(path: &std::path::Path) -> Result<ort::session::Session, String> {
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

with:

```rust
/// Build an `ort` Session for an OCR model with low-memory allocator settings.
///
/// By default ORT registers the CPU execution provider with a memory arena that
/// pools activation buffers and never returns them to the OS while the session
/// lives. The OCR pipeline is cached for the whole process, so that arena
/// retains hundreds of MB after the first inference. Registering the CPU EP with
/// `with_arena_allocator(false)` emits `DisableCpuMemArena`, so ORT frees
/// activation buffers after each `run()` instead, dropping the retained heap.
/// `with_memory_pattern(false)` additionally stops ORT pre-reserving one
/// contiguous activation block for the (static-shape) graph, trimming the
/// transient inference peak. Both are allocation-strategy changes only — model
/// outputs are identical.
#[cfg(feature = "onnx")]
pub(crate) fn build_session(path: &std::path::Path) -> Result<ort::session::Session, String> {
    use ort::ep::CPUExecutionProvider;
    ort::session::Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .with_execution_providers([CPUExecutionProvider::default()
            .with_arena_allocator(false)
            .build()])
        .map_err(|e| format!("ort cpu ep: {e}"))?
        .with_memory_pattern(false)
        .map_err(|e| format!("ort mem pattern: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("ort load model {}: {e}", path.display()))
}
```

The new builder call: `SessionBuilder::with_memory_pattern(enable: bool) -> BuilderResult` (verified in `ort-2.0.0-rc.12`'s `impl_options.rs`), chained with `?`/`map_err` exactly like the EP call.

- [ ] **Step 4: Run the test again to confirm the session still loads + runs (output unchanged)**

Run: `cd apps/readest-app/crates/manga-ocr && cargo test --features onnx build_session_loads_and_runs`
Expected: PASS (1 passed). This proves the new builder call compiles against rc.12 and the configured session still loads + runs + produces the correct output (`y = x + 1`).

- [ ] **Step 5: Full crate test, format, lint**

Run: `cd apps/readest-app/crates/manga-ocr && cargo test && cargo test --features onnx && cargo fmt && cargo clippy --features onnx --all-targets -- -D warnings`
Expected: both test runs PASS (the onnx run includes `build_session_loads_and_runs`; no `#[ignore]` tests run); `cargo fmt` leaves no diff; clippy exits 0 with no warnings.

- [ ] **Step 6: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/crates/manga-ocr/src/session.rs
git commit -m "perf(ocr): disable ORT memory pattern to trim the inference peak"
```

The pre-commit hook may print "lint-staged could not find any staged files matching configured tasks" — benign, the commit succeeds. Do NOT use `--no-verify` for a normal commit; if it's blocked for another reason, report it.

---

### Task 2: On-device peak gate (release build)

**Files:** none (verification only). Manual on-device gate. Per `.agents/memory`: 4 GB tablet AVD `emulator-5556`; release builds are not debuggable so `run-as` is unavailable — measure via `dumpsys meminfo`. The ✨ trigger needs the device-side-sleep tap pattern.

Goal: confirm OCR still works on the release build and measure the **transient inference peak** delta vs the arena-only baseline (~650 MB Native Heap / ~767 MB TOTAL PSS), with the retained number confirmed still ~111 MB.

- [ ] **Step 1: Build + install the release APK**

```bash
cd /home/julianshen/projects/readest/apps/readest-app
pnpm android:onnx
pnpm tauri android build --target x86_64 --apk
adb -s emulator-5556 install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

`install -r` preserves data (the cached ZH models from the prior gate) since both APKs share the keystore.properties signer. Confirm release (no `DEBUGGABLE`): `adb -s emulator-5556 shell dumpsys package com.jlnshen.reader | grep pkgFlags=`.

- [ ] **Step 2: Open the ZH book and start the high-water-mark poll, then trigger OCR**

Launch the app, open "OCR Test ZH". Start a rapid Native-Heap poll in the background to catch the transient peak (the high-water mark during inference), then trigger ✨:

```bash
# background: sample Native Heap ~every 0.5s for ~25s, keep the max
( max=0; for i in $(seq 1 50); do
    nh=$(adb -s emulator-5556 shell dumpsys meminfo com.jlnshen.reader 2>/dev/null | grep -E "Native Heap" | head -1 | awk '{print $3}')
    [ -n "$nh" ] && [ "$nh" -gt "$max" ] && max=$nh && echo "peak so far: ${max}KB"
    adb -s emulator-5556 shell sleep 0.5
  done; echo "PEAK Native Heap = ${max}KB" ) &
# trigger ✨ (reveal -> sparkle), models cached so OCR runs directly
adb -s emulator-5556 shell "input tap 1280 800; sleep 0.8; input tap 426 92"
wait
```

(If the toolbar was already visible, ✨ is at native `426 92` on the tablet; the reveal tap is `1280 800`.)

- [ ] **Step 3: Record the peak + confirm retained**

Note the `PEAK Native Heap` from Step 2. Then, a few seconds after inference completes, take the retained reading:

```bash
adb -s emulator-5556 shell dumpsys meminfo com.jlnshen.reader | grep -E "Native Heap|^\s*TOTAL "
```

Expected: retained Native Heap ~111 MB (the arena win is preserved). Record both the captured peak and the retained number.

- [ ] **Step 4: Confirm OCR still works (no functional regression)**

Verify detection + recognition still occur (the peak spike proves the pipeline ran; optionally tap a bubble to surface the translation). OCR output must be unchanged from before.

- [ ] **Step 5: Record the result + decide next**

Compare the captured peak against the arena-only baseline (~650 MB Native Heap / ~767 MB TOTAL PSS). Note the delta in the PR description and in `.agents/memory` (`comic-auto-translate-phase1.md` backlog item #2). If the peak drop is meaningful, the work is done; if negligible, that confirms the peak is intrinsic to the model and only the deferred detector input-size re-export would move it.

---

## Final Verification

- `cargo test --features onnx` and `cargo test` both pass for `manga-ocr`; `build_session_loads_and_runs` green.
- `cargo fmt --check` clean; `cargo clippy --features onnx --all-targets -- -D warnings` clean.
- CI `rust_lint` + `build_tauri_app` green on the PR.
- On-device: OCR still works on the release build; transient-peak delta measured + recorded vs the ~650 MB / ~767 MB baseline; retained confirmed still ~111 MB.

## Self-Review

- **Spec coverage:** `with_memory_pattern(false)` added to `build_session` → Task 1 Step 3; all 4 sessions inherit it (no call-site changes) → covered by the unchanged call sites; round-trip test renamed knob-agnostic → Task 1 Step 1; outputs-unchanged → Task 1 Steps 4–5 (test stays green) + the allocation-strategy reasoning; on-device transient-peak measurement vs baseline, retained ~111 MB preserved → Task 2. All spec sections mapped.
- **Placeholder scan:** none — every code step shows the full before/after block; every command has an expected result.
- **Type consistency:** `build_session(path: &std::path::Path) -> Result<ort::session::Session, String>` signature unchanged; the only new call is `.with_memory_pattern(false)` (returns `BuilderResult`, chained with `?`). The test name `build_session_loads_and_runs` is used consistently in Steps 1, 2, 4, 5.
- **YAGNI note:** a single builder call; no new abstraction, no call-site churn. Detector input-size re-export stays deferred per the spec.
