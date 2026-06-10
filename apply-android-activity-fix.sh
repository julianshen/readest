#!/bin/bash
# patch-main-activity: Apply #3297 fix (onWindowFocusChanged + invalidate)
# to the Tauri-generated MainActivity.kt.
#
# Run from repo root after `npx tauri android init`.

set -euo pipefail

MAIN="apps/readest-app/src-tauri/gen/android/app/src/main/java/com/jlnshen/reader/MainActivity.kt"

cd "$(dirname "$0")"

[ -f "$MAIN" ] || { echo "File not found: $MAIN"; exit 1; }
grep -q "firstFocus" "$MAIN" && { echo "✓ Already applied"; exit 0; }

# Add 'firstFocus' field after the TauriActivity class declaration line
sed -i '/^class MainActivity : TauriActivity/a\    private var firstFocus = true' "$MAIN"

# Add onWindowFocusChanged override before the class closing brace
sed -i '/^}$/i\    override fun onWindowFocusChanged(hasFocus: Boolean) {\
        super.onWindowFocusChanged(hasFocus)\
        if (hasFocus \&\& firstFocus) {\
            firstFocus = false\
            wv?.post { wv?.invalidate() }\
        }\
    }\
' "$MAIN"

echo "✓ Applied #3297 fix"
