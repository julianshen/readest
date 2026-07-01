# Prune the Detector to its Only-Used Output (`blk`) — Design

**Date:** 2026-07-01
**Status:** Approved (design); pending spec review
**Branch:** `perf/detector-blk-only`

## Goal

Cut the on-device OCR inference memory peak by ~75% by shipping a comic-text-detector model with its unused `seg` and `det` output heads pruned away. The Rust pipeline reads only the `blk` output; the other two heads are dead compute whose full-resolution upconv activations dominate the peak.

## Background

The OCR peak-memory work established: #29 (arena disable) cut the *retained* Native Heap −86% (820→111 MB); what remained was a *transient inference peak* (~677 MB Native Heap on-device, arena-only). A spike measured where that peak comes from.

The detector ONNX (`comic-text-detector`) has three outputs: `blk` (text-block boxes — the only one the Rust code reads, `detect.rs:126`), `seg` (`[1,1,1024,1024]` segmentation), and `det` (`[1,2,1024,1024]` detection map). The `seg`/`det` heads run full-resolution upconv layers whose activations dominate the forward-pass peak — and nothing in the codebase consumes them (verified: the only detector-output read is `outputs["blk"]`).

Spike measurements (desktop ORT 1.26; absolute values run higher than Android ORT 1.20, but the relative reduction is the signal):

| Detector | Download | `blk` detection (real manga) | Peak RSS |
| --- | --- | --- | --- |
| int8 full (shipped, #28) | 53.4 MB | max_conf 0.975 / 89 boxes | 1055 MB |
| **int8, pruned to `blk`-only** | **8.2 MB** | **0.976 / 88 (bit-identical branch)** | **266 MB (−75%)** |

Pruning is a pure graph edit: `blk`'s output is unchanged, so detection is preserved exactly. No quantization, calibration, or model retraining. Rejected alternatives during the spike: static-int8 quantization (full-model kills detection; mixed-precision preserved accuracy but cut the peak only ~7% with QOperator, or *increased* it with QDQ) and memory-pattern disable (no peak change, PR #30 closed).

## Scope

- **In scope:** produce the `blk`-only-pruned int8 detector, host it, re-pin the shared-detector consts in `models.rs`, and gate the on-device peak reduction.
- **Out of scope:** any Rust code change (the pipeline already reads only `blk`), and the deferred detector input-size reduction (no longer needed if this hits the peak target).

## Architecture

The change mirrors the #28 int8 swap: it re-pins three `const`s and re-hosts one model file. No code paths change.

### Artifact

Generated deterministically from the shipped int8 detector:

```python
import onnx
from onnx.utils import extract_model
m = onnx.load("comic-text-detector.int8.onnx")
extract_model("comic-text-detector.int8.onnx", "comic-text-detector.blk-int8.onnx",
              [i.name for i in m.graph.input], ["blk"])
```

- Output: `comic-text-detector.blk-int8.onnx`
- Size: **8,178,289 bytes**
- SHA-256: **`44be9c59b4923985aa1730afc6c50974b6a2c32a66959c83ff584424958bff00`**
- Reproducible: re-running `extract_model` yields the identical SHA (deterministic).
- Input `images [1,3,1024,1024]` and output `blk [1,64512,7]` are unchanged (same names/shapes the Rust decoder expects).

Hosted on the existing `models-ja-v1` GitHub release (where the current detector lives), as a new asset.

### Code change (`crates/manga-ocr/src/models.rs`)

Re-pin the three shared-detector consts:

| const | new value |
| --- | --- |
| `JA_DETECTOR_URL` | `https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.blk-int8.onnx` |
| `JA_DETECTOR_SHA` | `44be9c59b4923985aa1730afc6c50974b6a2c32a66959c83ff584424958bff00` |
| `JA_DETECTOR_SIZE` | `8_178_289` |

The cache filename stays `comic-text-detector.onnx` (via `DETECTOR_FILE`). Because the detector is the shared file (`is_shared()`, #27), the ja/ko/zh manifests all pick up the new values through these consts. The clarifying comment above the consts is updated to describe the blk-only prune.

## Data Flow, Migration & Error Handling

Runtime data flow is unchanged: `Detector::detect` feeds `images` and reads `outputs["blk"]`; the pruned model still produces `blk` with the same shape. `seg`/`det` simply no longer exist in the graph (they were never read).

Migration is automatic on existing installs: the new SHA/size make `ocr_models_present` (the #28 size-aware check, `m.len() == f.size`) report the cached 53 MB detector as not-present, so the frontend runs `ensure_ocr_models`, which SHA-fails the stale file and re-downloads the 8 MB blk-only detector into the shared cache (`ocr-models/shared/`, #27), cleaning up the orphan. No new error paths.

## Testing

- **Manifest tests (`models.rs`):** the existing tests (`sha256.len()==64`, `url.starts_with("https://")`, detector-is-the-only-shared-file, `every_manifest_entry_has_a_plausible_size`) still hold with the new values. Update the detector-size assertion in `every_manifest_entry_has_a_plausible_size` (and `JA_DETECTOR_SIZE`) to `8_178_289`. `cargo test -p manga-ocr` green.
- **No new accuracy unit test:** the pruned `blk` is bit-identical to the shipped int8's `blk` (verified in the spike), and that detector is already validated in production — there is no new detection behavior to test in Rust. The provenance/reproducibility of the artifact (deterministic `extract_model` SHA) is the guarantee.
- **On-device gate (the peak verification):** release build on emulator-5556; rapid-poll Native Heap through ZH OCR to capture the transient peak vs the ~677 MB arena-only baseline; confirm retained stays ~111 MB and OCR still detects + translates.

## Success Criteria

- `cargo test -p manga-ocr` green with the re-pinned consts; `fmt`/`clippy` clean; CI green.
- The 8.2 MB blk-only detector is hosted and downloads/migrates correctly on-device.
- On-device: OCR still detects + recognizes + translates the ZH page; the measured inference peak drops substantially from the ~677 MB baseline (target: a large reduction consistent with the spike's −75%), retained stays ~111 MB.
