#!/usr/bin/env bash
# Publish a verified image to Vercel Container Registry (VCR) and print the
# immutable digest to put in MAVLY_ANDROID_BUILD_IMAGE.
#
# Prerequisites (run by the human operator, never by this script):
#   vercel login
#   vercel link                     # link this directory to the Vercel project
#   vercel vcr login docker         # authenticates the local Docker client
#
# No credential is read, written or echoed here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-mavly-android-build:android-debug-v1}"

die() {
  echo "error: $*" >&2
  exit 1
}

: "${VCR_IMAGE:?set VCR_IMAGE to vcr.vercel.com/<team>/<project>/<repository>:<tag>}"

printf '%s' "$VCR_IMAGE" | grep -Eq '^vcr\.vercel\.com/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*:[^@]+$' \
  || die "VCR_IMAGE must look like vcr.vercel.com/<team>/<project>/<repository>:<tag>"

command -v docker >/dev/null 2>&1 || die "docker is not installed"

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || die "${IMAGE} does not exist locally; run ./build.sh first"

echo "Tagging ${IMAGE} -> ${VCR_IMAGE}"
docker tag "${IMAGE}" "${VCR_IMAGE}"

echo "Pushing ${VCR_IMAGE}"
docker push "${VCR_IMAGE}"

echo
echo "Registry manifest:"
docker buildx imagetools inspect "${VCR_IMAGE}" || true

echo
cat <<'EOF'
Resolve the digest above (sha256:...) and configure:

  MAVLY_ANDROID_BUILD_IMAGE=<team>/<project>/<repository>@sha256:<digest>

Do not configure a tag. The application rejects a tag as unpinned, and a tag
can point at different bytes tomorrow. Wait for VCR to report the repository as
`Ready` (linux/amd64) before creating a sandbox from it.
EOF
