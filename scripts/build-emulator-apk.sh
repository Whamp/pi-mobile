#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-$HOME/Android/jdk}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export GRADLE_USER_HOME="$PWD/android/.cache/gradle"
scripts/build-apk.sh
android/gradlew --no-daemon --init-script "$PWD/android/emulator.init.gradle" -p android assembleDebug
cp android/app/build/outputs/apk/debug/app-debug.apk /workspace/badlogic-torture/apk/p2w-debug-x86_64-emulator.apk
sha256sum /workspace/badlogic-torture/apk/p2w-debug-x86_64-emulator.apk
