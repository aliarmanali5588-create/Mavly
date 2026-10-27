#!/usr/bin/env bash
# Verify a built image against the application's build contract.
#
# Checks run inside the image, as the default (non-root) user, and the final
# seed build runs with `--network none` + `--offline` — the same network policy
# the worker applies. This does not publish anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-mavly-android-build:android-debug-v1}"

die() {
  echo "error: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "docker is not installed"

echo "== Toolchain versions and layout (${IMAGE}) =="
docker run --rm --platform linux/amd64 "${IMAGE}" sh -euc '
  echo "java:    $(java -version 2>&1 | head -n1)"
  echo "gradle:  $(gradle --version | awk "/^Gradle / {print \$2; exit}")"
  echo "aapt:    $(command -v aapt)"
  echo "sdk:     ${ANDROID_HOME}"
  echo "user:    $(id -un)"
  echo "home:    ${HOME}"
  echo "gradle-home: ${GRADLE_USER_HOME}"
  echo "cwd:     $(pwd)"

  java -version 2>&1 | grep -q "version \"17"
  gradle --version | grep -q "^Gradle 8.9$"
  test -f "${ANDROID_HOME}/platforms/android-35/android.jar"
  test -x "${ANDROID_HOME}/build-tools/35.0.0/aapt"
  test -d "${GRADLE_USER_HOME}/caches/modules-2"
  test -w "${GRADLE_USER_HOME}"
  test -w /vercel/sandbox
  test "$(id -u)" -ne 0
  test "$(pwd)" = "/vercel/sandbox"
'

echo
echo "== Offline seed build (deny-all network, --offline) =="
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
cp -R "${ROOT}/seed" "${TMP}/seed"

docker run --rm --platform linux/amd64 --network none \
  -v "${TMP}/seed:/seed:ro" \
  "${IMAGE}" sh -euc '
    cp -R /seed /tmp/seed
    cd /tmp/seed
    gradle :app:assembleDebug --no-daemon --offline --stacktrace --console=plain
    test -f app/build/outputs/apk/debug/app-debug.apk
    aapt dump badging app/build/outputs/apk/debug/app-debug.apk | grep -q "com.mavly.seed"
    echo "offline seed APK: $(wc -c < app/build/outputs/apk/debug/app-debug.apk) bytes"
  '

echo
echo "PASS: ${IMAGE} satisfies the Android debug build contract."
echo "The APK above was built and discarded inside the verification container;"
echo "this does not prove a real generated project will build."
