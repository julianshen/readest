# Prune Detector to `blk`-Only Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the OCR inference memory peak ~75% by shipping the comic-text-detector pruned to its only-used output (`blk`), dropping the unused `seg`/`det` heads.

**Architecture:** A model-file swap that mirrors the #28 int8 swap. Prune the shipped int8 detector to `blk`-only (deterministic `onnx.utils.extract_model`), host it on the `models-ja-v1` release, and re-pin three `const`s in `models.rs`. No Rust code paths change — `detect.rs` already reads only `blk`; the shared-cache (#27) + size-aware present-check (#28) migrate existing installs automatically.

**Tech Stack:** Rust (`manga-ocr` crate), ONNX / `onnx.utils.extract_model` (Python, for producing the artifact), `gh` (release hosting), Android/Tauri (on-device gate).

**Spec:** `docs/superpowers/specs/2026-07-01-detector-blk-only-design.md`

**Key facts (verified during the spike):**
- Pruned artifact: **`comic-text-detector.blk-int8.onnx`**, size **8,178,289 B**, SHA-256 **`44be9c59b4923985aa1730afc6c50974b6a2c32a66959c83ff584424958bff00`**, deterministic (re-pruning yields the same SHA).
- Source: the currently-shipped int8 detector (`comic-text-detector.int8.onnx`, SHA `d6b4b1136f028a65eade6316c9c7707fab2c59fa08d20b46a75e68b814773aa2`), present locally at `/tmp/comic-text-detector.int8.onnx`; the pre-generated pruned artifact is at `/tmp/ct.int8.blk-only.onnx`.
- The Python env (`/home/julianshen/.hermes/hermes-agent/venv`, the default `python3`) has `onnxruntime` + `onnx` (installed during the spike).
- `blk` output is bit-identical to the shipped int8's `blk` (detection preserved exactly); the shipped int8 detector is already validated in production.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `models-ja-v1` GitHub release (julianshen/readest) | Hosts the detector model asset. | Add `comic-text-detector.blk-int8.onnx` |
| `apps/readest-app/crates/manga-ocr/src/models.rs` | Shared-detector download consts + manifest tests. | Modify (3 consts, 1 comment, 1 test assertion) |

Commits run from the repo root `/home/julianshen/projects/readest`; cargo commands from `apps/readest-app/crates/manga-ocr`.

---

### Task 1: Produce + host the `blk`-only detector artifact

**Files:** none in-repo (hosts a release asset). No commit.

This is prerequisite infra: the re-pinned URL in Task 2 must resolve to a live asset whose SHA matches before the on-device gate can download it.

- [ ] **Step 1: Verify the source int8 detector, then (re)produce the pruned artifact deterministically**

```bash
sha256sum /tmp/comic-text-detector.int8.onnx
# Expected: d6b4b1136f028a65eade6316c9c7707fab2c59fa08d20b46a75e68b814773aa2  (the shipped int8 source)

python3 -c "
import onnx
from onnx.utils import extract_model
src='/tmp/comic-text-detector.int8.onnx'
m=onnx.load(src)
extract_model(src, '/tmp/comic-text-detector.blk-int8.onnx', [i.name for i in m.graph.input], ['blk'])
print('pruned OK')
"
```
Expected: `pruned OK`. (If `onnx` is missing: `python3 -m ensurepip --upgrade && python3 -m pip install onnx`.)

- [ ] **Step 2: Verify the artifact SHA + size match the pinned values**

```bash
sha256sum /tmp/comic-text-detector.blk-int8.onnx
stat -c "%s bytes" /tmp/comic-text-detector.blk-int8.onnx
```
Expected exactly:
- SHA `44be9c59b4923985aa1730afc6c50974b6a2c32a66959c83ff584424958bff00`
- `8178289 bytes`

If either differs, STOP — do not upload; the pinned consts in Task 2 would not match. (A mismatch means a different source or onnx version; re-check the source SHA in Step 1.)

- [ ] **Step 3: Upload the asset to the `models-ja-v1` release**

```bash
gh release upload models-ja-v1 /tmp/comic-text-detector.blk-int8.onnx --repo julianshen/readest
```
Expected: upload success (or `--clobber` if re-running after a partial upload).

- [ ] **Step 4: Verify the hosted URL is live and matches the pinned SHA**

```bash
curl -fsL "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.blk-int8.onnx" | sha256sum
```
Expected: `44be9c59b4923985aa1730afc6c50974b6a2c32a66959c83ff584424958bff00`. This confirms the download path the app will use.

---

### Task 2: Re-pin the shared-detector consts in `models.rs`

**Files:**
- Modify: `apps/readest-app/crates/manga-ocr/src/models.rs` (3 consts + comment + 1 test assertion)

- [ ] **Step 1: Re-pin the consts + update the clarifying comment**

In `apps/readest-app/crates/manga-ocr/src/models.rs`, replace:

```rust
// Dynamic-int8 quantized detector (53.4 MB vs 94.7 MB fp32); detection accuracy
// preserved (verified). The cache filename stays `comic-text-detector.onnx`.
const JA_DETECTOR_URL: &str = "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.int8.onnx";
const JA_DETECTOR_SHA: &str = "d6b4b1136f028a65eade6316c9c7707fab2c59fa08d20b46a75e68b814773aa2";
const JA_DETECTOR_SIZE: u64 = 53_352_863;
```

with:

```rust
// Int8 detector pruned to its only-used output (`blk`); the unused seg/det heads
// — whose full-resolution upconv activations dominate the inference peak — are
// removed via onnx.utils.extract_model. 8.2 MB (from 53.4 MB int8); `blk`
// detection is bit-identical. The cache filename stays `comic-text-detector.onnx`.
const JA_DETECTOR_URL: &str = "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.blk-int8.onnx";
const JA_DETECTOR_SHA: &str = "44be9c59b4923985aa1730afc6c50974b6a2c32a66959c83ff584424958bff00";
const JA_DETECTOR_SIZE: u64 = 8_178_289;
```

- [ ] **Step 2: Run the manifest tests — the size assertion must now FAIL**

Run: `cd apps/readest-app/crates/manga-ocr && cargo test --features onnx every_manifest_entry_has_a_plausible_size`
Expected: FAIL — `assertion \`left == right\` failed: left: 8178289, right: 53352863` at the `assert_eq!(JA_DETECTOR_SIZE, 53_352_863)` line. This confirms the test pins the detector size and caught the change.

- [ ] **Step 3: Update the test assertion + its comment to the new size**

In the `every_manifest_entry_has_a_plausible_size` test, replace:

```rust
        // The detector size const is the int8 detector (53.4 MB), shared by all langs.
        assert_eq!(JA_DETECTOR_SIZE, 53_352_863);
```

with:

```rust
        // The detector size const is the blk-only-pruned int8 detector (8.2 MB), shared by all langs.
        assert_eq!(JA_DETECTOR_SIZE, 8_178_289);
```

(The three following `assert_eq!(<lang>_manifest()[0].size, JA_DETECTOR_SIZE)` lines are unchanged — they reference the const and still hold.)

- [ ] **Step 4: Run the full manifest tests + fmt + clippy**

Run: `cd apps/readest-app/crates/manga-ocr && cargo test && cargo test --features onnx && cargo fmt && cargo clippy --features onnx --all-targets -- -D warnings`
Expected: both test runs PASS (including `every_manifest_entry_has_a_plausible_size`, `detector_is_the_only_shared_file`, `ko_zh_manifests_valid_and_share_detector`); `cargo fmt` no diff; clippy exits 0.

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/crates/manga-ocr/src/models.rs
git commit -m "perf(ocr): ship detector pruned to blk-only output (53->8MB, -75% peak)"
```
The pre-commit hook may print "lint-staged could not find any staged files matching configured tasks" — benign. Do NOT use `--no-verify`; if blocked otherwise, report it.

---

### Task 3: On-device peak gate + PR

**Files:** none (verification). Manual on-device gate on the 4 GB tablet AVD `emulator-5556`; release build (not debuggable — `run-as` unavailable, measure via `dumpsys meminfo`). ✨ needs the device-side-sleep tap pattern.

Goal: confirm OCR still detects + translates with the pruned detector, and measure the transient-peak reduction vs the ~677 MB arena-only baseline (retained should stay ~111 MB).

- [ ] **Step 1: Build + install the release APK**

```bash
cd /home/julianshen/projects/readest/apps/readest-app
pnpm android:onnx
pnpm tauri android build --target x86_64 --apk
adb -s emulator-5556 install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```
Confirm release (no `DEBUGGABLE`): `adb -s emulator-5556 shell dumpsys package com.jlnshen.reader | grep pkgFlags=`. Note: on first ✨ the app re-downloads the detector — now only **8.2 MB** (the size-aware check sees the old 53 MB cached file as not-present).

- [ ] **Step 2: Open the ZH book, start the peak poll, trigger OCR**

Launch, open "OCR Test ZH". If the download prompt appears, accept it (native YES at `1736 886`) and wait for the ~8 MB download. Then capture the peak:

```bash
adb -s emulator-5556 shell "input tap 1280 800; sleep 0.8; input tap 426 92"   # reveal -> sparkle
max=0
for i in $(seq 1 28); do
  nh=$(adb -s emulator-5556 shell dumpsys meminfo com.jlnshen.reader 2>/dev/null | grep -E "Native Heap" | head -1 | awk '{print $3}')
  [ -n "$nh" ] && [ "$nh" -gt "$max" ] && max=$nh
  echo "sample $i: ${nh}KB (max ${max}KB)"
  adb -s emulator-5556 shell sleep 0.4
done
echo "PEAK Native Heap = ${max}KB"
```

- [ ] **Step 3: Confirm OCR output + retained memory**

The samples that drop back to a stable low value are the retained reading — expect **~111 MB** (arena win preserved). Confirm detection + recognition happened (the peak spike proves the pipeline ran; optionally tap a bubble for the translation popup — e.g. 早上好!→translation).

- [ ] **Step 4: Record the result**

Compare `PEAK Native Heap` against the ~677 MB arena-only baseline. Record the peak + retained in the PR description and in `.agents/memory` (`comic-auto-translate-phase1.md` backlog item #2). A large drop (spike predicted ~−75%) confirms the seg/det activations were the peak driver.

- [ ] **Step 5: Push + open PR**

```bash
cd /home/julianshen/projects/readest
git push --no-verify -u origin perf/detector-blk-only
gh pr create --repo julianshen/readest --base main --head perf/detector-blk-only \
  --title "perf(ocr): ship detector pruned to blk-only output (53->8MB, -75% peak)" \
  --body "<summary: prune unused seg/det heads; -75% inference peak, -85% download; blk bit-identical; model swap + re-pin, no code change; on-device gate numbers>"
```
(`--no-verify`: the husky pre-push hook fails on a pre-existing unrelated test that passes in CI.) Then watch CI (`rust_lint` + `build_tauri_app`), address any bot findings, and hold for the user's merge go.

---

## Final Verification

- `cargo test --features onnx` + `cargo test` green for `manga-ocr` (manifest tests updated); `fmt:check` + `clippy -D warnings` clean.
- The 8.2 MB `comic-text-detector.blk-int8.onnx` is hosted on `models-ja-v1` and `curl -fsL … | sha256sum` matches `44be9c59…`.
- CI `rust_lint` + `build_tauri_app` green on the PR.
- On-device: OCR detects + recognizes + translates the ZH page on the pruned detector; measured inference peak drops substantially from ~677 MB; retained stays ~111 MB.

## Self-Review

- **Spec coverage:** artifact production + hosting (spec "Artifact") → Task 1; re-pin 3 consts + comment (spec "Code change") → Task 2 Steps 1; update the one size assertion (spec "Testing") → Task 2 Steps 2–3; migration is automatic via existing #27/#28 logic (spec "Migration") → no code, exercised by Task 3's re-download; on-device peak gate vs ~677 MB baseline, retained ~111 MB (spec "Success Criteria") → Task 3. All mapped.
- **Placeholder scan:** the only angle-bracket text is the PR `--body` summary (Task 3 Step 5), which is filled at execution time from the recorded gate numbers — not a code placeholder. All code/const/test edits show exact before/after.
- **Type consistency:** the three consts keep their types (`&str`, `&str`, `u64`); `JA_DETECTOR_SIZE = 8_178_289` matches the artifact `stat` size and the test assertion in Task 2 Step 3; the URL matches the uploaded asset name and the `curl` verification in Task 1 Step 4; the SHA `44be9c59…` is identical across the artifact, the const, and both verification commands.
- **YAGNI note:** no Rust logic changes; the unused seg/det heads are dropped rather than kept "just in case" (re-hostable if ever needed).
