# syntax=docker/dockerfile:1.7
# ═══════════════════════════════════════════════════════════════════════════
# Mavly Android DEBUG build image — toolchain `android-debug-v1`
# ═══════════════════════════════════════════════════════════════════════════
#
# This image is the ONLY environment in which Mavly compiles generated Android
# source. It is booted by the Vercel Sandbox adapter
# (`src/lib/sandbox/vercel-sandbox.ts`) and runs the fixed command:
#
#   gradle :app:assembleDebug --no-daemon --offline --stacktrace --console=plain
#
# Contract with the application (do not change one side alone):
#   · `gradle` (8.9) MUST be on PATH. Generated projects cannot ship a Gradle
#     wrapper JAR (the Android contract refuses `.jar`), so the image provides
#     the distribution and the build never calls `./gradlew`.
#   · `aapt` MUST be on PATH (build-tools/35.0.0). The worker calls
#     `aapt dump badging` to bind the APK package id to its SHA-256.
#   · JDK 17, Android platform 35, build-tools 35.0.0 and platform-tools.
#   · GRADLE_USER_HOME is pre-populated with the pinned baseline dependency
#     graph. Builds run `--offline` with deny-all network, so a cache miss MUST
#     fail — never add runtime network access to hide it.
#   · The default (non-root) user owns /vercel/sandbox and GRADLE_USER_HOME.
#     The adapter uploads the snapshot relative to /vercel/sandbox and runs
#     detached commands with cwd /vercel/sandbox.
#   · No credentials, tokens or project secrets are ever installed.
#
# ⚠️ ALL PINS ARE REQUIRED. `build.sh` refuses to run without a digest-pinned
#    base image and a SHA-256 for every downloaded archive. Nothing here uses
#    a `latest` tag or an unverified download.
# ═══════════════════════════════════════════════════════════════════════════

ARG BASE_IMAGE

FROM ${BASE_IMAGE}

ARG GRADLE_VERSION=8.9
ARG GRADLE_SHA256
ARG JDK_URL
ARG JDK_SHA256
ARG CMDLINE_TOOLS_URL
ARG CMDLINE_TOOLS_SHA256

ARG ANDROID_PLATFORM=35
ARG ANDROID_BUILD_TOOLS=35.0.0

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    JAVA_HOME=/opt/jdk \
    GRADLE_HOME=/opt/gradle/gradle-${GRADLE_VERSION} \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    HOME=/home/mavly \
    GRADLE_USER_HOME=/home/mavly/.gradle

# Only stable base utilities come from apt. The base digest is the primary
# reproducibility pin; the published image digest is the artifact of record.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      fontconfig \
      git \
      jq \
      libstdc++6 \
      unzip \
      xz-utils \
      zip \
      zlib1g; \
    rm -rf /var/lib/apt/lists/*

# ── JDK 17 (Temurin tarball, checksum-verified) ─────────────────────────────
RUN set -eux; \
    test -n "${JDK_URL:-}"; \
    test -n "${JDK_SHA256:-}"; \
    test "${#JDK_SHA256}" -eq 64; \
    curl -fsSL "${JDK_URL}" -o /tmp/jdk.tar.gz; \
    echo "${JDK_SHA256}  /tmp/jdk.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/jdk; \
    tar -xzf /tmp/jdk.tar.gz -C /opt/jdk --strip-components=1; \
    rm -f /tmp/jdk.tar.gz; \
    "${JAVA_HOME}/bin/java" -version 2>&1 | grep -q 'version "17'

# ── Gradle 8.9 (official distribution, checksum-verified) ───────────────────
RUN set -eux; \
    test -n "${GRADLE_SHA256:-}"; \
    test "${#GRADLE_SHA256}" -eq 64; \
    curl -fsSL \
      "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
      -o /tmp/gradle.zip; \
    echo "${GRADLE_SHA256}  /tmp/gradle.zip" | sha256sum -c -; \
    mkdir -p /opt/gradle; \
    unzip -q /tmp/gradle.zip -d /opt/gradle; \
    rm -f /tmp/gradle.zip; \
    test -x "${GRADLE_HOME}/bin/gradle"

# ── Android SDK: platform, build-tools (aapt), platform-tools ───────────────
RUN set -eux; \
    test -n "${CMDLINE_TOOLS_URL:-}"; \
    test -n "${CMDLINE_TOOLS_SHA256:-}"; \
    test "${#CMDLINE_TOOLS_SHA256}" -eq 64; \
    mkdir -p "${ANDROID_HOME}/cmdline-tools"; \
    curl -fsSL "${CMDLINE_TOOLS_URL}" -o /tmp/cmdline-tools.zip; \
    echo "${CMDLINE_TOOLS_SHA256}  /tmp/cmdline-tools.zip" | sha256sum -c -; \
    unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools; \
    mv /tmp/cmdline-tools/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest"; \
    rm -rf /tmp/cmdline-tools /tmp/cmdline-tools.zip; \
    yes | "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" \
      --sdk_root="${ANDROID_HOME}" --licenses > /dev/null; \
    "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" \
      --sdk_root="${ANDROID_HOME}" \
      "platforms;android-${ANDROID_PLATFORM}" \
      "build-tools;${ANDROID_BUILD_TOOLS}" \
      "platform-tools"; \
    test -x "${ANDROID_HOME}/build-tools/${ANDROID_BUILD_TOOLS}/aapt"; \
    test -d "${ANDROID_HOME}/platforms/android-${ANDROID_PLATFORM}"

# `aapt` is invoked by bare name, so build-tools must be on PATH.
ENV PATH="${ANDROID_HOME}/build-tools/${ANDROID_BUILD_TOOLS}:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/cmdline-tools/latest/bin:${GRADLE_HOME}/bin:${JAVA_HOME}/bin:${PATH}"

# ── Non-root build user and sandbox working directory ───────────────────────
# The pinned base must not already define UID/GID 1000 (a minimal Ubuntu image
# does not). If it does, `groupadd`/`useradd` fail here rather than producing an
# image whose default user is unexpected.
RUN set -eux; \
    groupadd --gid 1000 mavly; \
    useradd --uid 1000 --gid 1000 --create-home --home-dir /home/mavly \
      --shell /bin/bash mavly; \
    mkdir -p /home/mavly/.gradle /home/mavly/.android /vercel/sandbox; \
    chown -R mavly:mavly /home/mavly /vercel/sandbox

# A generated project may omit `gradle.properties`; AGP still needs AndroidX.
# Gradle merges $GRADLE_USER_HOME/gradle.properties into project properties.
COPY --chown=mavly:mavly gradle-user-home.properties /home/mavly/.gradle/gradle.properties

# ── Warm the offline dependency cache with the pinned baseline graph ────────
# This seed mirrors the exact versions the planner is instructed to emit. A
# successful seed build here is what makes `--offline` viable at runtime.
COPY --chown=mavly:mavly seed /opt/android-seed

USER mavly
WORKDIR /home/mavly

RUN set -eux; \
    cd /opt/android-seed; \
    gradle :app:assembleDebug --no-daemon --stacktrace --console=plain; \
    test -f app/build/outputs/apk/debug/app-debug.apk; \
    aapt dump badging app/build/outputs/apk/debug/app-debug.apk | grep -q "^package: name='com.mavly.seed'"; \
    test -d "${GRADLE_USER_HOME}/caches/modules-2"

# Keep the cache, remove the seed project and transient daemon state.
USER root
RUN set -eux; \
    rm -rf /opt/android-seed; \
    rm -rf /home/mavly/.gradle/daemon /home/mavly/.gradle/workers; \
    chown -R mavly:mavly /home/mavly/.gradle

# ── Provenance labels ───────────────────────────────────────────────────────
LABEL org.opencontainers.image.title="mavly-android-build" \
      org.opencontainers.image.description="Isolated Android debug build toolchain for Mavly (JDK 17, Gradle 8.9, SDK 35, aapt)" \
      com.mavly.android.toolchain="android-debug-v1|jdk17|gradle8.9|agp8.7.3|kotlin2.0.21|sdk35" \
      com.mavly.android.variant="debug" \
      com.mavly.android.gradle="8.9" \
      com.mavly.android.agp="8.7.3" \
      com.mavly.android.kotlin="2.0.21" \
      com.mavly.android.compile-sdk="35" \
      com.mavly.android.build-tools="35.0.0" \
      com.mavly.android.offline-cache="android-debug-v1-baseline"

USER mavly
WORKDIR /vercel/sandbox
