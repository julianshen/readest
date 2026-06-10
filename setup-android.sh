#!/bin/bash
set -euo pipefail

ANDROID_HOME="/home/julianshen/Android/Sdk"
CMDLINE_TOOLS_ZIP="/tmp/cmdline-tools.zip"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"

echo "=== 1. Creating Android SDK directory ==="
mkdir -p "$ANDROID_HOME/cmdline-tools"

echo "=== 2. Downloading commandline tools ==="
if [ ! -f "$CMDLINE_TOOLS_ZIP" ]; then
    curl -fSL "$CMDLINE_TOOLS_URL" -o "$CMDLINE_TOOLS_ZIP"
fi

echo "=== 3. Extracting ==="
unzip -qo "$CMDLINE_TOOLS_ZIP" -d /tmp/cmdline-tools-tmp
# Move to the correct location (latest/ dir is required by the tool)
mkdir -p "$ANDROID_HOME/cmdline-tools/latest"
mv /tmp/cmdline-tools-tmp/cmdline-tools/* "$ANDROID_HOME/cmdline-tools/latest/"
rm -rf /tmp/cmdline-tools-tmp

export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

echo "=== 4. Accepting licenses ==="
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true

echo "=== 5. Installing platform tools + build tools + platform 36 ==="
sdkmanager --sdk_root="$ANDROID_HOME" \
    "platform-tools" \
    "build-tools;36.0.0" \
    "platforms;android-36" \
    "ndk;27.0.12077973" 2>&1 | tail -20

echo "=== 6. Setting ANDROID_HOME ==="
echo "export ANDROID_HOME=$ANDROID_HOME" >> /home/julianshen/.bashrc
echo "export ANDROID_NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973" >> /home/julianshen/.bashrc
echo 'export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH' >> /home/julianshen/.bashrc

echo "=== 7. Setting local.properties ==="
mkdir -p /home/julianshen/projects/readest/apps/readest-app/src-tauri/gen/android
cat > /home/julianshen/projects/readest/apps/readest-app/src-tauri/gen/android/local.properties << EOF
sdk.dir=$ANDROID_HOME
ndk.dir=$ANDROID_HOME/ndk/27.0.12077973
EOF

echo "=== 8. Rust Android targets ==="
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android

echo "=== DONE ==="
echo "ANDROID_HOME=$ANDROID_HOME"
echo "ANDROID_NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973"
