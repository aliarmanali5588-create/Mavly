#!/usr/bin/env bash
# Build the Mavly Android debug-build image locally (linux/amd64).
#
# Every pin is required. Nothing is downloaded without a SHA-256, and the base
# image must carry an immutable @sha256 digest. This script never logs in,
# pushes, or touches a cloud project.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

die() {
  echo "error: $*" >&2
  exit 1
}

sha_ok() {
  printf '%s' "$1" | grep -Eq '^[a-fA-F0-9]{64}$'
}

# Optional: load a local, uncommitted pins file.
if [[ -f "${PINS_FILE:-pins.env}" ]]; then
  # shellcheck disable=SC1090
  set -a
  . "${PINS_FILE:-pins.env}"
  set +a
fi

: "${BASE_IMAGE:?set BASE_IMAGE to a digest-pinned base, e.g. ubuntu:24.04@sha256:<64 hex>}"
: "${JDK_URL:?set JDK_URL to an immutable Temurin 17 linux/x64 tarball URL}"
: "${JDK_SHA256:?set JDK_SHA256 to the official SHA-256 of JDK_URL}"
: "${GRADLE_SHA256:?set GRADLE_SHA256 to the official SHA-256 of gradle-8.9-bin.zip}"
: "${CMDLINE_TOOLS_URL:?set CMDLINE_TOOLS_URL to a versioned commandlinetools-linux-<build>_latest.zip}"
: "${CMDLINE_TOOLS_SHA256:?set CMDLINE_TOOLS_SHA256 to the SHA-256 of CMDLINE_TOOLS_URL}"

printf '%s' "$BASE_IMAGE" | grep -Eq '@sha256:[a-fA-F0-9]{64}$' \
  || die "BASE_IMAGE must be pinned by @sha256:<64 hex> (tags are mutable)"

sha_ok "$JDK_SHA256" || die "JDK_SHA256 must be 64 hex characters"
sha_ok "$GRADLE_SHA256" || die "GRADLE_SHA256 must be 64 hex characters"
sha_ok "$CMDLINE_TOOLS_SHA256" || die "CMDLINE_TOOLS_SHA256 must be 64 hex characters"

printf '%s' "$JDK_URL" | grep -Eq '^https://' || die "JDK_URL must be https"
printf '%s' "$CMDLINE_TOOLS_URL" | grep -Eq '^https://' || die "CMDLINE_TOOLS_URL must be https"

IMAGE="${IMAGE:-mavly-android-build:android-debug-v1}"

command -v docker >/dev/null 2>&1 || die "docker is not installed"

echo "Building ${IMAGE} from ${BASE_IMAGE}"
echo "  JDK:            ${JDK_URL##*/} (sha256 ${JDK_SHA256:0:12}…)"
echo "  Gradle:         8.9 (sha256 ${GRADLE_SHA256:0:12}…)"
echo "  cmdline-tools:  ${CMDLINE_TOOLS_URL##*/} (sha256 ${CMDLINE_TOOLS_SHA256:0:12}…)"

docker buildx build \
  --platform linux/amd64 \
  --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
  --build-arg "GRADLE_VERSION=8.9" \
  --build-arg "GRADLE_SHA256=${GRADLE_SHA256}" \
  --build-arg "JDK_URL=${JDK_URL}" \
  --build-arg "JDK_SHA256=${JDK_SHA256}" \
  --build-arg "CMDLINE_TOOLS_URL=${CMDLINE_TOOLS_URL}" \
  --build-arg "CMDLINE_TOOLS_SHA256=${CMDLINE_TOOLS_SHA256}" \
  --tag "${IMAGE}" \
  --load \
  "${ROOT}"

echo
echo "Built ${IMAGE}"
echo "Next: ./verify.sh    (version, aapt, cache and offline seed build checks)"
