#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-$HOME/Android/jdk}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export GRADLE_USER_HOME="$PWD/android/.cache/gradle"
export PATCHELF="${PATCHELF:-$HOME/Android/host-tools/bin/patchelf}"
npm run build
node scripts/prepare-runtime.mjs
node scripts/package-android.mjs
android/gradlew --no-daemon -p android assembleDebug
mkdir -p /workspace/badlogic-torture/apk
cp android/app/build/outputs/apk/debug/app-debug.apk /workspace/badlogic-torture/apk/p2w-debug.apk
sha256sum /workspace/badlogic-torture/apk/p2w-debug.apk
