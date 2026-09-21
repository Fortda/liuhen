#!/usr/bin/env bash
# Unix counterpart of package.ps1 — used by the optional CI job.
# Never packs OmniDatabase. Signs with the debug keystore unless
# OMNI_ANDROID_STORE_FILE is set.
set -euo pipefail

ANDROID_ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ANDROID_ROOT/.." && pwd)"
DIST_DIR="$REPO/dist"

version="${OMNI_VERSION:-}"
if [[ -z "$version" ]]; then
  version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$REPO/omniplayer/src-tauri/tauri.conf.json")"
fi
version="${version:-0.1.4}"

IFS='.' read -r major minor patch extra <<<"${version}.0.0"
version_code="${OMNI_VERSION_CODE:-$(( ${major:-0} * 10000 + ${minor:-0} * 100 + ${patch:-0} ))}"

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -n "$sdk" ]]; then
  printf 'sdk.dir=%s\n' "$sdk" > "$ANDROID_ROOT/local.properties"
fi

gradle_cmd=""
if [[ -f "$ANDROID_ROOT/gradlew" ]]; then
  chmod +x "$ANDROID_ROOT/gradlew" || true
  gradle_cmd="$ANDROID_ROOT/gradlew"
elif command -v gradle >/dev/null 2>&1; then
  gradle_cmd="gradle"
else
  echo "No ./gradlew and no gradle on PATH. CI should use gradle/actions/setup-gradle." >&2
  exit 1
fi

mkdir -p "$HOME/.android"
if [[ -z "${OMNI_ANDROID_STORE_FILE:-}" && ! -f "$HOME/.android/debug.keystore" ]]; then
  keytool -genkeypair -v \
    -keystore "$HOME/.android/debug.keystore" -storepass android \
    -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi

(
  cd "$ANDROID_ROOT"
  "$gradle_cmd" :app:assembleRelease --no-daemon \
    "-PomniVersion=$version" "-PomniVersionCode=$version_code"
)

built="$ANDROID_ROOT/app/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$built" ]]; then
  echo "APK missing after build: $built" >&2
  exit 1
fi

if unzip -l "$built" | grep -qi OmniDatabase; then
  echo "Refusing APK: it contains OmniDatabase paths." >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
out="$DIST_DIR/Liuhen-$version-android.apk"
cp -f "$built" "$out"
ls -lh "$out"
echo "Sideload APK (debug-signed unless OMNI_ANDROID_STORE_FILE is set)."
echo "Almost unusable. Data stays on the phone. Do not upload traces."
