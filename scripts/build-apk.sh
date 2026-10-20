#!/usr/bin/env bash
# Builds the Bolsillo APK (android/app/build/outputs/apk/release/bolsillo-<version>.apk).
# Needs a JDK 17+ and the Android SDK (ANDROID_HOME). Signs with $BOLSILLO_KEYSTORE if set,
# otherwise with the debug key (fine for installing it yourself).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
[ -d "$ANDROID_HOME" ] || { echo "Android SDK missing (ANDROID_HOME)"; exit 1; }
[ -f "$here/android/app/src/main/jniLibs/arm64-v8a/libproot.so" ] || "$here/scripts/fetch-proot.sh"
echo "sdk.dir=$ANDROID_HOME" > "$here/android/local.properties"
cd "$here/android"
./gradlew --no-daemon -q assembleRelease
version=$(sed -n "s/.*versionName '\(.*\)'.*/\1/p" app/build.gradle)
out="app/build/outputs/apk/release/bolsillo-$version.apk"
cp app/build/outputs/apk/release/app-release.apk "$out"
echo "✓ APK ready: android/$out ($(du -h "$out" | cut -f1))"
