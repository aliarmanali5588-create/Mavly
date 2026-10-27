# Android debug build image (`android-debug-v1`)

This directory is the reproducible definition of the image Mavly boots for
generated Android debug builds. It is **not** a general Android CI image: it is
the environment the existing worker contract expects
(`src/lib/android/build-worker.ts` → `src/lib/sandbox/vercel-sandbox.ts`).

## Contract the image must satisfy

| Requirement | Value / reason |
|---|---|
| Provider | Vercel Sandbox boots from a **Vercel Container Registry (VCR)** `linux/amd64` image. External registries are rejected by the application before a sandbox is created. |
| JDK | 17 (`JAVA_HOME=/opt/jdk`). AGP 8.7.3 and Kotlin 2.0.21 target 17. |
| Gradle | **8.9 on `PATH`**. Generated projects cannot ship a wrapper JAR (the Android contract refuses `.jar`), so the worker runs `gradle`, never `./gradlew`. |
| Android SDK | platform 35 (`ANDROID_HOME=/opt/android-sdk`), build-tools **35.0.0**, platform-tools. |
| `aapt` | On `PATH` (build-tools). The worker runs `aapt dump badging` to verify the APK package id. |
| Gradle cache | `GRADLE_USER_HOME=/home/mavly/.gradle` pre-populated with the pinned baseline graph. Runtime builds are `--offline` with **deny-all network**. |
| Default user | Non-root `mavly` (uid 1000), owning `/home/mavly` and `/vercel/sandbox`. The adapter uploads relative to `/vercel/sandbox` and runs detached commands with that cwd. |
| Global Gradle properties | `android.useAndroidX=true` in `$GRADLE_USER_HOME/gradle.properties`, because generated projects are not required to contain `gradle.properties`. |
| Secrets | None. No token, key, service-role value or project secret is copied into any layer. |
| Entrypoint | None required. Vercel Sandbox does not run `ENTRYPOINT`/`CMD`; the worker starts commands itself. |

Exact environment exported by the image:

```
JAVA_HOME=/opt/jdk
GRADLE_HOME=/opt/gradle/gradle-8.9
ANDROID_HOME=/opt/android-sdk
ANDROID_SDK_ROOT=/opt/android-sdk
HOME=/home/mavly
GRADLE_USER_HOME=/home/mavly/.gradle
PATH=<build-tools/35.0.0>:<platform-tools>:<cmdline-tools/latest/bin>:<gradle>/bin:<jdk>/bin:...
```

The worker additionally sets `CI=1` and
`GRADLE_OPTS=-Xmx2g -Dorg.gradle.daemon=false` at sandbox creation. It never
sets `ANDROID_HOME`, `GRADLE_USER_HOME` or `JAVA_HOME`, so the image is their
only source of truth.

## Files

| Path | Purpose |
|---|---|
| `Dockerfile` | The image. Base and every download are digest/checksum pinned. |
| `seed/` | A minimal Kotlin/Compose project using exactly the versions the planner emits. Built at **image build time** to warm the offline cache, then deleted. |
| `gradle-user-home.properties` | Installed into `$GRADLE_USER_HOME/gradle.properties`. |
| `pins.env.example` | Copy to `pins.env` and fill in every pin. Never commit `pins.env`. |
| `build.sh` | Validates pins and builds `linux/amd64` locally. |
| `verify.sh` | Version/layout checks + an **offline, `--network none`** seed build. |
| `publish.sh` | Tags/pushes to VCR and prints the manifest; does not authenticate. |

## What is cached — and what is not

The seed resolves the exact pinned graph:

- AGP `8.7.3`, Kotlin Android + Compose plugins `2.0.21`;
- `androidx.core:core-ktx:1.13.1`, `androidx.activity:activity-compose:1.9.3`,
  `androidx.lifecycle:lifecycle-runtime-ktx:2.8.7`;
- Compose BOM `2024.10.01` → `material3`, `ui`, `ui-tooling-preview`,
  `ui-tooling`;
- Android platform 35, build-tools 35.0.0, and AAPT2/Kotlin compiler artifacts.

**It does not cache arbitrary dependencies a model might invent.** The Android
contract only allowlists Maven repositories and forbids dynamic versions; it
does not restrict the dependency graph. If a generated project adds a library
outside this baseline, an offline build fails with `Could not resolve` /
`No cached version`. That is intentional: do not add runtime network access.

### Rebuilding the image with an extra dependency

1. Add the **exact pinned coordinate** to
   `infra/android-build/seed/app/build.gradle.kts`.
2. Rebuild with `./build.sh`; the seed build downloads and caches it.
3. Run `./verify.sh` (offline seed build must pass).
4. Publish with `./publish.sh`, take the new digest, and update
   `MAVLY_ANDROID_BUILD_IMAGE`.
5. Update `ANDROID_BUILD_TOOLCHAIN` only if the toolchain itself changed, not
   for a cache addition.

Bump the repository tag (for example `android-debug-v2`) so an operator can
tell images apart; the **digest** is what the application pins.

## Build, verify, publish (human-run)

```bash
cd infra/android-build
cp pins.env.example pins.env
# edit pins.env with reviewed digests/checksums

./build.sh          # local linux/amd64 build, no push
./verify.sh         # fails unless the offline seed build succeeds
```

Publish to VCR:

```bash
vercel login
vercel link                       # link this directory to the Vercel project
vercel vcr login docker

export VCR_IMAGE="vcr.vercel.com/<team>/<project>/android-build:android-debug-v1"
./publish.sh
```

`publish.sh` prints the registry manifest. Take its `sha256:...` digest, wait
for the VCR repository to report **Ready**, and configure:

```
MAVLY_ANDROID_BUILD_IMAGE=<team>/<project>/android-build@sha256:<digest>
```

Do **not** configure a tag. The application rejects anything without
`@sha256:` and also rejects an external registry host.

If `Sandbox.create()` returns `image_not_ready`, the registry is still preparing
the optimized `linux/amd64` image. Retry later; do not swap to a tag.

## Why the wrapper is not used

`src/lib/android/contract.ts` refuses `.jar` files, so a generated
`gradle-wrapper.jar` cannot exist and `./gradlew` cannot work. The image's
Gradle 8.9 is therefore the executor and is part of the pinned toolchain. The
contract still accepts `gradlew`/`gradlew.bat` *scripts* if a model emits them;
they are ignored by the fixed command and must not be relied on.

## Security notes

- The image runs generated, untrusted Gradle scripts. It runs only inside the
  provider microVM with deny-all network, no host mounts and no credentials.
- Do not add a network proxy, mirror credentials, Maven tokens or a
  `~/.gradle/gradle.properties` containing secrets.
- Do not set the artifact bucket, Supabase keys or Vercel tokens in the image.
  They belong to the worker environment, never the build environment.
- Do not install a signing key or release tooling. This image is debug-only.
