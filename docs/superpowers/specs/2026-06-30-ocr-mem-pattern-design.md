# OCR Memory-Pattern Disable — Design

**Date:** 2026-06-30
**Status:** Approved (design); pending spec review
**Branch:** `perf/ocr-mem-pattern`

## Goal

Reduce the transient OCR inference memory peak (~650–767 MB measured) by also disabling ONNX Runtime's memory-pattern planner on every OCR session, on top of the CPU-arena disable already shipped (`a7c1cbb3`, PR #29). Measure the on-device peak drop, and pursue the deferred detector input-size re-export only if this isn't enough.

## Background

The arena-disable PR (#29) cut the OCR pipeline's **retained** Native Heap from ~820 MB to ~111 MB (−86%) by stopping ORT from pooling activation buffers. What remains is a **transient peak** during active inference: a snapshot caught ~650 MB Native Heap / ~767 MB TOTAL PSS while the detector runs, freed immediately afterward.

The detector graph has a static 1024² input (verified: input `[1,3,1024,1024]`; outputs `blk [1,64512,7]`, `seg [1,1,1024,1024]`, `det [1,2,1024,1024]` are all 1024²-derived). For static-shape graphs ORT's **memory-pattern** optimization pre-computes the activation layout and reserves one contiguous block sized for the whole forward pass. Disabling it (`with_memory_pattern(false)`) makes ORT allocate tensors on demand and free them as they die, so the high-water mark can be just the concurrently-live set rather than the full pre-plan.

The cheaper alternative to a detector re-export (which the fixed 1024² input would otherwise require) is to try this config knob first. Like the arena setting, memory-pattern is an allocation-strategy choice — **model outputs are bit-identical, so there is no accuracy or behavior impact**.

## Scope

- **In scope:** add `with_memory_pattern(false)` to the existing `build_session` helper; measure the on-device transient-peak delta; report it.
- **Out of scope (deferred):** the detector input-size reduction (1024²→768²), which requires re-exporting the model from its PyTorch source — pursued only if memory-pattern disable doesn't reduce the peak enough. Also still deferred: thread/opt-level latency tuning, batch recognition, dual full-page decode.

## Architecture

A one-line addition to the existing `build_session` helper (`crates/manga-ocr/src/session.rs`, shipped in #29). All four OCR sessions (detector, manga-ocr encoder/decoder, PP-OCRv5 CTC rec) already route through `build_session`, so there are **no call-site changes**. The memory policy stays centralized in the one helper.

### The change

`build_session` currently registers the arena-disabled CPU EP then commits. Insert the memory-pattern disable between them:

```rust
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

API note (verified against vendored `ort-2.0.0-rc.12`): `SessionBuilder::with_memory_pattern(enable: bool) -> BuilderResult` (in `impl_options.rs`), chaining with `?`/`map_err` exactly like the EP call.

The doc comment on `build_session` will be extended to mention both knobs (arena off → lower retained; memory-pattern off → lower transient peak).

## Data Flow & Error Handling

Unchanged. The helper still returns `Result<ort::session::Session, String>` with the `format!`-string convention; the new stage adds one `"ort mem pattern: {e}"` error arm.

## Testing

- **Regression:** `cargo test -p manga-ocr` and `cargo test -p manga-ocr --features onnx` stay green. The existing round-trip test now exercises both knobs (arena + memory-pattern off) and still asserts `y = x + 1`, proving outputs are unaffected. Since it now covers more than the arena, rename it from `build_session_loads_and_runs_with_arena_disabled` to the knob-agnostic `build_session_loads_and_runs` (it verifies the configured session loads + runs correctly, whatever the allocation knobs).
- `cargo fmt --check` clean; `cargo clippy --features onnx --all-targets -- -D warnings` clean.

## Verification / Measurement Plan

The point of the change is the **transient peak**, which is harder to capture than the stable retained number. On tablet emulator-5556 (release build):

1. Build + install the release APK (update-install preserves the cached ZH models).
2. Open the ZH test book, trigger ✨.
3. **Rapid-poll** `adb shell dumpsys meminfo` Native Heap roughly every 0.5 s through the inference window to catch the high-water mark.
4. Confirm the **retained** number afterward stays ~111 MB (no regression of the arena win).
5. Compare the captured peak against the arena-only baseline (~650 MB Native Heap / ~767 MB TOTAL PSS).
6. Confirm OCR still detects + recognizes (no functional regression).

Report the peak delta → decide whether the detector input-size re-export is still warranted.

## Trade-offs

Like arena-disable, disabling memory-pattern can cost a little inference latency (more allocations per run), not measurable on the software-CPU emulator; accepted for any peak-memory reduction. If the measured peak drop is negligible, that is itself the useful result — it tells us the peak is intrinsic to the model and only the input-size re-export would move it.

## Success Criteria

- `cargo test -p manga-ocr --features onnx`, `fmt:check`, `clippy` pass; CI green.
- OCR still works end-to-end on the release build (ZH gate).
- A measured, reported transient-peak delta vs the ~650 MB / ~767 MB arena-only baseline, with the retained number confirmed still ~111 MB — enough to decide on the input-size follow-up.
