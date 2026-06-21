#!/usr/bin/env bash
# Populate gen/android jniLibs with libonnxruntime.so for each Android ABI.
#
# The manga-ocr crate loads ONNX Runtime dynamically on Android (ort
# `load-dynamic`), so `libonnxruntime.so` must ship in the APK's lib/<abi>/.
# `gen/android` is gitignored, so this is NOT committed — run this before
# `pnpm tauri android build` (CI release workflows run it too) to (re)create the
# files reproducibly from the official ONNX Runtime Android AAR. Pinned to 1.20.0
# to match the crate's `api-20` feature.
set -euo pipefail

ORT_VER="${ORT_VER:-1.20.0}"
ABIS=("arm64-v8a" "x86_64")  # real devices + emulator; add x86/armeabi-v7a if needed

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JNILIBS="$SCRIPT_DIR/../src-tauri/gen/android/app/src/main/jniLibs"
CACHE="${ORT_AAR_CACHE:-${TMPDIR:-/tmp}/onnxruntime-android-${ORT_VER}.aar}"
URL="https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/${ORT_VER}/onnxruntime-android-${ORT_VER}.aar"

if [ ! -f "$CACHE" ]; then
  echo "Downloading ONNX Runtime Android ${ORT_VER} AAR..."
  curl -fsSL -o "$CACHE" "$URL"
fi

for abi in "${ABIS[@]}"; do
  dest="$JNILIBS/$abi/libonnxruntime.so"
  mkdir -p "$JNILIBS/$abi"
  if [ -f "$dest" ]; then
    echo "✓ $abi already present"
    continue
  fi
  echo "Extracting $abi/libonnxruntime.so..."
  # unzip to a temp path then move (the AAR stores it under jni/<abi>/)
  tmp="$(mktemp -d)"
  unzip -q -o "$CACHE" "jni/$abi/libonnxruntime.so" -d "$tmp"
  mv "$tmp/jni/$abi/libonnxruntime.so" "$dest"
  rm -rf "$tmp"
  echo "✓ $abi -> $dest ($(du -h "$dest" | cut -f1))"
done

echo "Done. jniLibs ready for: ${ABIS[*]}"
