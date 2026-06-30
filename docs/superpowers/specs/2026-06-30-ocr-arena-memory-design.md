# OCR Arena-Disable Memory Optimization — Design

**Date:** 2026-06-30
**Status:** Approved (design); pending spec review
**Branch:** `perf/ocr-arena-memory`

## Goal

Cut the retained ~820 MB Native Heap held by the on-device OCR pipeline by disabling ONNX Runtime's CPU memory arena on every OCR session, then measure the actual on-device drop and decide whether a deeper fix (detector input-size reduction) is still warranted.

## Background

A release-build memory gate (2026-06-30, tablet emulator-5556) measured the OCR process at **~820 MB Native Heap / ~939 MB TOTAL PSS** with the pipeline loaded — essentially identical to the debug build, confirming the footprint is real native memory (not debug bloat). The breakdown is dominated by Native Heap (malloc); Java/Dalvik heap is ~5 MB.

The on-device OCR pipeline is cached for the process lifetime (`static Mutex<Option<(String, OcrPipeline)>>` in `src-tauri/src/ocr.rs`). All four ORT sessions — detector, manga-ocr encoder, manga-ocr decoder, and the PP-OCRv5 CTC recognizer — are currently built with bare defaults:

```rust
ort::session::Session::builder()?.commit_from_file(path)?
```

With defaults, ORT registers the CPU execution provider with its **memory arena enabled**. The arena pools activation buffers and never returns them to the OS while the session lives, so the cached pipeline retains hundreds of MB indefinitely after the first inference.

`ort` 2.0.0-rc.12 exposes a direct control: registering the CPU EP with `with_arena_allocator(false)` emits `DisableCpuMemArena`, so ORT frees activation buffers after each `run()` instead of pooling them. Disabling the arena is an allocation-strategy change only — model outputs are bit-identical, so there is no accuracy or behavior impact.

## Scope

Per the agreed "measure arena first, then decide" approach:

- **In scope:** disable the CPU memory arena on all four OCR sessions; measure the on-device Native Heap / PSS delta; report it.
- **Out of scope (deferred "then decide" follow-ups):** memory-pattern disable (`with_memory_pattern(false)`), detector input-size reduction (1024²→768²), thread-count / graph-optimization-level latency tuning, batch recognition, and the dual full-page decode (`to_rgb8` + `to_luma8`) in `pipeline.rs`.

The chosen knob set is **arena disable only** (not arena + memory-pattern), to isolate the arena's contribution to the measured 820 MB cleanly.

## Architecture

A single new module, `crates/manga-ocr/src/session.rs`, owns one helper: `build_session(path)`. This is the one place ORT session-construction policy lives. The four model-load sites call the helper instead of inlining the builder, so the memory policy is centralized and trivially tunable for the follow-up decision.

The change is purely in how sessions are *constructed*. Detection, recognition, decode, cropping, and all data flow are untouched. Because the arena is an allocation strategy rather than a compute path, every model output is identical to today's.

### Component: `build_session`

```rust
// crates/manga-ocr/src/session.rs
#[cfg(feature = "onnx")]
pub(crate) fn build_session(path: &std::path::Path) -> Result<ort::session::Session, String> {
    use ort::ep::CPUExecutionProvider;
    ort::session::Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        // Disable the CPU memory arena: ORT frees activation buffers after each
        // run instead of pooling + retaining them. Trades a little per-run alloc
        // churn for hundreds of MB less retained Native Heap on the cached
        // pipeline. No effect on outputs.
        .with_execution_providers([CPUExecutionProvider::default()
            .with_arena_allocator(false)
            .build()])
        .map_err(|e| format!("ort cpu ep: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("ort load model: {e}"))
}
```

Declared in `lib.rs` as `pub mod session;` (the helper itself is `pub(crate)` and gated on the `onnx` feature, matching the crate's existing pattern of feature-gating ORT-using items inside otherwise-unconditional modules).

API note (verified against the vendored `ort-2.0.0-rc.12` source): `ort::ep::CPUExecutionProvider` is an alias of `ep::CPU`; `CPU::register` calls `DisableCpuMemArena` when `use_arena == false`; `SessionBuilder::with_execution_providers` accepts `impl AsRef<[ExecutionProviderDispatch]>`, so an array literal of one built EP is valid.

### Call sites (4)

Each replaces an inline `Session::builder()?…commit_from_file(path)?` with `crate::session::build_session(path)?`:

1. `detect.rs` — `Detector::load` (detector session)
2. `recognize.rs` — `MangaOcrEngine::load` (encoder session)
3. `recognize.rs` — `MangaOcrEngine::load` (decoder session)
4. `recognize.rs` — `CtcRecognizer::load` (CTC rec session)

`CtcRecognizer::load` reads `session.inputs()` / `session.outputs()` metadata after construction; that logic is unchanged and still runs against the session returned by the helper.

## Data Flow & Error Handling

Data flow is unchanged. `build_session` returns `Result<ort::session::Session, String>`, matching the crate's existing `format!`-string error convention, so the four call sites keep their `?` operators and surrounding error context with no signature changes.

## Testing

- **Regression:** `cargo test -p manga-ocr` and `cargo test -p manga-ocr --features onnx` must stay green. The pure-logic tests (NMS decode, CTC decode, argmax, greedy decode, manifests, preprocess) are unaffected; the change only touches session construction.
- **E2E exercise:** the existing `#[ignore]` test `pipeline::tests::pipeline_detects_and_recognizes_sample_page` now routes session construction through `build_session`; run locally when models are available (optional, not part of CI).
- **Helper round-trip test:** a unit test (`build_session_loads_and_runs_with_arena_disabled` in `session.rs`) builds a session via `build_session` against the embedded `add_one.onnx` fixture and asserts it loads + runs correctly (`y = x + 1`). This proves the arena-disabled session is functional and outputs are unaffected. It does *not* assert the arena flag itself — that setting isn't observable from Rust without instrumenting the ORT C API — so the **on-device memory measurement (below) remains the real verification of the memory win**.
- `cargo fmt --check` and `cargo clippy` (CI `rust_lint`) must pass.

## Verification / Measurement Plan

This is the point of the change. On tablet emulator-5556 (4 GB), using the release build path (debug bloat already ruled out):

1. Build a signed release x86_64/universal APK; install (fresh, since the prior build's signer differs).
2. Import the ZH test CBZ (`/sdcard/Download/zh-manhua.cbz`), open it, trigger ✨, accept the model download.
3. Once OCR has run, read `adb shell dumpsys meminfo com.jlnshen.reader` — record **Native Heap PSS** and **TOTAL PSS**, multiple stable reads.
4. Compare against the baseline: **~820 MB Native Heap / ~939 MB TOTAL PSS**.
5. Confirm OCR still detects + recognizes (markers + translation appear) — no functional regression.

Report the delta. Then decide whether detector input-size reduction (768², a separate riskier PR) is still needed to reach a phone-safe footprint.

## Trade-offs

Disabling the arena adds per-run `malloc`/`free` churn, which costs some inference latency. This is not measurable on the software-CPU emulator (SwiftShader) and is accepted in exchange for the memory reduction; it can be revisited on real arm64 hardware if latency regresses. The memory win is the objective here.

## Success Criteria

- `cargo test -p manga-ocr --features onnx`, `fmt:check`, and `clippy` pass; CI green.
- OCR still works end-to-end on the release build (ZH gate: markers + translation).
- A measured, reported Native Heap / PSS delta vs the ~820 MB / ~939 MB baseline, sufficient to decide on the input-size follow-up.
