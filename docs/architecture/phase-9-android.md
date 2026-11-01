# Phase 9 — Native Android source generation and isolated debug builds

Status: **implemented — external build verification pending.** Source generation is active;
isolated debug builds and private artifacts are implemented but OFF by default until the
operator pins a toolchain image, applies migration 26 and configures the private bucket.

This phase adds a real, bounded native Android path to the existing Mavly generation
system. It does not add a second queue, model, billing system or mobile builder backend.

## What is implemented

- `public.projects.project_type` (`website` | `android`, migration 22) and idempotent
  Android project creation (`clientRequestId`, migration 25) are reused.
- An Android prompt runs through the same durable run/lease/checkpoint/snapshot/memory
  pipeline as a website prompt. Only the generation profile changes.
- The profile is **Kotlin 2.0.21 + Jetpack Compose (Material 3) + Gradle Kotlin DSL**:
  - Gradle 8.9, Android Gradle Plugin 8.7.3, JDK 17;
  - `compileSdk = 35`, `targetSdk = 35`, `minSdk = 26`;
  - pinned AndroidX/Compose versions, no dynamic versions or custom Maven URLs.
- The application id is derived server-side from the owned project id:
  `com.mavly.<project-alphanumerics>`. The planner is told the exact package and the
  Compose entry-point path, so a completed create run has a predictable layout.
- The complete resulting source is re-validated before the run can be reported as
  completed. A failure preserves completed batches and the run baseline, exactly like a
  website contract failure.
- No Gradle wrapper JAR or vendored distribution is generated: both are binaries and the
  contract refuses them. The build uses Gradle 8.9 from its pinned image; a downloaded
  source tree needs an external Gradle 8.9 + JDK 17 installation.
- Durable debug builds (`26_android_builds.sql`) run only for an explicit project cohort,
  compile an immutable snapshot in a Vercel Sandbox with **deny-all network**, validate the
  APK, and store it privately with a short-lived owner-authorized download. Release
  signing, AABs, store publishing and emulator/device verification are not implemented.

## Source contract

`src/lib/android/contract.ts` is pure and re-validates untrusted output:

| Area | Rule |
|---|---|
| Required files | `settings.gradle.kts`, root `build.gradle.kts`, `app/build.gradle.kts`, `app/src/main/AndroidManifest.xml`, `README.md`, and a Compose `MainActivity.kt` at the package path |
| Paths | Relative, `/`-separated, no `..`, no `:`/control characters, no `build/`, `.gradle/`, `.idea/`, `.git/`, `node_modules/` |
| File types | Kotlin, Java, XML, Gradle, properties, Markdown/JSON/TOML/YAML text only |
| Refused files | APK/AAB/JAR/AAR/SO/DEX, keystores/signing material, images and other binaries, `.env*`, `local.properties`, `google-services.json`, credential-shaped files |
| Manifest | Exactly one `<manifest>` (bounded size); valid package; matching Gradle namespace/applicationId; a single exported MAIN/LAUNCHER `MainActivity`; no `debuggable`, no cleartext traffic, no restricted permissions |
| Gradle | `com.android.application`, Kotlin Android and Compose compiler plugins; `buildFeatures { compose = true }`; Compose dependencies; valid SDK levels; no signing configuration, process/environment access, dynamic versions, `mavenLocal()`, `flatDir` or non-allowlisted Maven URLs |
| Content | No NUL/binary content and no high-confidence private-key, cloud, GitHub, OpenAI or JWT credential shape |
| Compose entry point | `class MainActivity` extending an Android activity and calling `setContent` |
| Size | 80 files, 256 KiB per file, 1.5 MB total (the same generation bounds) |

The allowed Maven prefixes are `dl.google.com/dl/android/maven2`,
`repo.maven.apache.org/maven2` and `plugins.gradle.org/m2`, all over HTTPS.

## Isolated debug build engine

`26_android_builds.sql` and `src/lib/android/build-worker.ts` implement:

1. **Snapshot binding.** A build request validates the current source, computes a SHA-256,
   reuses a ready snapshot with the same hash or creates one, and passes its id/hash to
   `create_android_build`. The worker re-hashes the snapshot files and fails on any
   mismatch. Later project edits cannot change the queued input.
2. **Durable lifecycle.** One active build per project, 2 per user, 4 global. A 22-minute
   deadline, a 300-second fenced lease, attempt budget 2, crash recovery, deliberate
   cancellation and orphan-sandbox cleanup are all enforced by migration-26 RPCs. Builds
   share the existing generation-worker tick and are advanced only when the generation
   queue is empty; a busy generation queue delays builds but never competes for a run.
3. **Isolation.** `MAVLY_ANDROID_BUILD_IMAGE` must be a **Vercel Container
   Registry (VCR)** image pinned by `@sha256:`; the provider's Sandbox `image`
   field accepts only its own registry, not an arbitrary external one. An
   external registry host (Docker Hub, GHCR, ECR, `localhost`, an `https://` URL)
   is rejected by `build-config.ts` before a sandbox is created, and a tag is
   rejected as unpinned. The reproducible definition is
   [`infra/android-build/`](../../infra/android-build/README.md): JDK 17, Gradle
   8.9 on `PATH`, Android platform 35, build-tools 35.0.0, `aapt`, and a warmed
   `GRADLE_USER_HOME`. The build runs exactly
   `gradle :app:assembleDebug --no-daemon --offline --stacktrace --console=plain`
   with **deny-all network**, 2 vCPUs (configurable 1–4; 2048 MB per vCPU), no
   secrets and no host mounts. There is no local fallback.
4. **Artifact verification.** Gradle must exit `0`, `aapt dump badging` must report the
   expected application id, the APK must exist within 100 MB, and `fflate` must accept it
   without traversal, duplicate/oversized entries, unsupported compression or a
   zip-bomb-sized expansion. The APK must contain `AndroidManifest.xml` and `classes.dex`.
   SHA-256, size, package id and toolchain are recorded.
5. **Private publication.** The APK is uploaded to the private `android-artifacts` bucket
   at `<project>/<build>/<sha256>.apk` using the confined service client. The owner-facing
   API returns only a 5-minute signed URL and safe metadata. Artifacts expire after 7 days
   and are deleted by the worker; expired/deleted states are reported truthfully.
6. **Fenced terminal write.** `succeeded` is possible only with complete artifact metadata;
   a stale worker cannot publish after losing its lease. A failed cleanup never overwrites
   the build result and is retried by the cleanup sweep.

## Build image contract

The image is operator-built from [`infra/android-build/`](../../infra/android-build/README.md);
the repository does not publish one. The application assumes exactly this layout:

| Aspect | Contract |
|---|---|
| Registry | Vercel Container Registry, `linux/amd64`, repository status `Ready`. External registries and tags are refused. |
| Base | Digest-pinned by the operator. Every tool archive is SHA-256 verified at image-build time. |
| JDK | 17 at `/opt/jdk` (`JAVA_HOME`). |
| Gradle | 8.9 at `/opt/gradle/gradle-8.9`, on `PATH`. The generated project cannot ship a wrapper JAR (`.jar` is refused), so the fixed command calls `gradle`, never `./gradlew`. |
| Android SDK | `/opt/android-sdk`: platform 35, build-tools 35.0.0, platform-tools, accepted licenses. |
| `aapt` | On `PATH` via build-tools; the worker's package check calls it by bare name. |
| Cache | `GRADLE_USER_HOME=/home/mavly/.gradle`, warmed at image-build time by a seed build of the pinned baseline. Gradle must be able to write there at runtime. |
| Global properties | `android.useAndroidX=true` in `$GRADLE_USER_HOME/gradle.properties`, because generated projects are not required to contain `gradle.properties`. |
| User / cwd | Non-root `mavly` (uid 1000) owning `/home/mavly` and `/vercel/sandbox`. The adapter uploads relative to `/vercel/sandbox` and runs detached commands there. |
| Network | Image build uses network; the runtime sandbox is **deny-all** and Gradle is `--offline`. |
| Secrets | None. No token, key or project secret is installed in any layer. |
| Entrypoint | None required; Vercel Sandbox does not run `ENTRYPOINT`/`CMD`. |

### Cache scope and failure mode

The seed warms AGP 8.7.3, Kotlin/Compose plugins 2.0.21, core-ktx 1.13.1,
activity-compose 1.9.3, lifecycle-runtime-ktx 2.8.7, Compose BOM 2024.10.01 and its
baseline artifacts. It does **not** warm arbitrary dependencies a model might add.
A cache miss fails truthfully with `Could not resolve` / `No cached version`; the
worker does not add network access to hide it. Supporting a new approved dependency
means adding its exact coordinate to the seed, rebuilding, re-verifying, republishing
and changing the digest.

A successful seed build at image-build time is not proof that an arbitrary generated
project compiles, and it is not a device test.

### Provider plan and session lifetime

The worker requests a 24-hour sandbox session with a 22-minute build deadline. Vercel
documents a 45-minute sandbox maximum on Hobby and 24 hours on Pro/Enterprise, so a plan
that rejects the requested timeout fails as `sandbox_create_failed`/`provider_error`
(retried within the 2-attempt budget) rather than degrading to a local build. This has not
been exercised against a live account; it is an operator acceptance step.

## What is deliberately not implemented

- **Release signing / AAB.** No keystore, signing password, Play credential or release AAB
  exists. The source contract refuses signing material and the API has no release endpoint.
- **Google Play / App Store publishing.** No store credential management or upload.
- **Emulator/device verification.** No emulator, device farm, install or runtime check.
  A successful Gradle build is not evidence that the app renders or behaves correctly.
- **Bounded AI repair for Gradle.** The Phase 4 repair flow is Next.js-specific. Android
  has no repair path; do not reuse Next.js diagnostics or silently edit the project. A
  future repair must consume bounded, redacted Gradle diagnostics and create an immutable
  snapshot.
- **Public artifact URLs.** None. A signed URL is short-lived and owner-authorized.

## Enforcing the build configuration

The engine is off unless every prerequisite is present:

```
MAVLY_ANDROID_BUILD_ENABLED=1
MAVLY_ANDROID_BUILD_PROJECTS=<explicit cohort>
MAVLY_ANDROID_BUILD_IMAGE=<vcr-image>@sha256:...
MAVLY_ANDROID_ARTIFACT_BUCKET=android-artifacts
MAVLY_ANDROID_BUILD_VCPUS=2
# Vercel Sandbox credentials + SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL
# The active AWS worker must be running; Render and legacy Cloudflare remain disabled.
```

A tag-only image, an external registry, a non-numeric vCPU value, a missing bucket,
missing credentials, an empty build cohort or missing worker credentials is reported as not ready;
`POST …/mobile/builds` fails closed and no row/log/artifact is fabricated. Before
migration 26 is applied, `GET …/mobile/builds` returns `503 MIGRATION_REQUIRED`; once it
is applied, that request returns the persisted builds plus the exact capability,
including the reason builds are unavailable. The private bucket is created by migration
26; a non-default bucket is allowed but surfaced as a `non_default_bucket` warning
because Mavly cannot inspect its policy from the environment.

**Presence is not proof.** Admission checks that credential values exist and that the
image is a syntactically valid digest-pinned VCR reference. It does not call Vercel, does
not verify the digest exists or is `Ready`, does not inspect the bucket policy, and does
not prove the AWS worker is running. Confirm operation in the AWS systemd/journal logs.

### Durable worker

Android builds are advanced by the ordinary generation-worker tick: generation claims
come first, and only an otherwise-empty tick advances **either** verification **or** one
Android build. The AWS process invokes the worker directly; there is no public HTTP
endpoint or bearer-secret authentication. The tick is bounded to one claim per invocation.
Leases are fenced and concurrency caps (1/project, 2/user, 4/global) are enforced in SQL.

The AWS process polls the durable queue continuously, waiting five seconds after an empty
tick; no manual tick or project-specific worker configuration is required. Multiple AWS
instances remain claim-safe but consume the small global caps. Render is preserved but
disabled as a future fallback, and the legacy Cloudflare Cron is disabled while AWS is
active. Disabling the Android flag leaves DB-only recovery/retention running, but stopping
the worker stops recovery too, so active builds must be cancelled or allowed to finish
first.

### Enforced bounds

| Bound | Value |
|---|---|
| Concurrent builds | 1 per project, 2 per user, 4 global |
| Build deadline | 22 minutes |
| Lease | 300 seconds, fenced |
| Source upload | 80 files / 256 KiB each / 1.5 MB total |
| Artifact | 100 MB max, APK debug only |
| Build log | 32 KiB excerpt, tail-only, sanitized |
| Retry | 2 attempts for provider/storage failures; source/build failures are terminal |
| Artifact retention | 7 days, then deleted by the worker |
| Repair | Not implemented for Android |

## Rejected execution risks

- The build image is operator-controlled and digest-pinned. Generated source cannot choose
  an image, command, repository or toolchain version.
- `--offline` plus deny-all network means a cache miss fails; the build never downloads an
  unapproved dependency. Supply-chain risk shifts to the operator's pinned image/cache.
- Generated Gradle scripts are untrusted code. They execute only inside the microVM;
  process/environment execution patterns and non-allowlisted repositories are rejected by
  the contract, but sandbox isolation is the final boundary.
- APK bytes are untrusted data. They are never installed or opened on Mavly; only ZIP
  metadata and SHA-256 are inspected before private storage.

## Security boundaries

- Android source remains untrusted data. It is validated and stored as text; it is never
  imported or executed on a Mavly host.
- No project secret, Mavly credential or provider token is injected into generated source
  or the build environment.
- The build contract refuses credential-shaped, binary, signing and environment files.
- The generated app has no backend credential and no release signing material.
- The Next.js verification sandbox is **not** enqueued for Android runs, so a project is
  never “verified” by the wrong runtime.
- Build rows are owner SELECT only; all writes are service-role RPCs. Authenticated
  readers never receive the bucket, object path, sandbox id or lease.
- The artifact download first proves project ownership through RLS, then uses the
  service-role client only to sign the server-recorded object key. There is no
  client-supplied path/URL and no permanent public link.
- Existing session, ownership, RLS and project-scope checks are unchanged.

## Rollout

1. Apply migrations 22, 25 and 26 (additive; 20 before 26). Do not apply to production
   without explicit authorization.
2. Build, verify and publish the pinned toolchain image from `infra/android-build/` in a
   disposable Vercel account, including an offline Gradle cache hit and `aapt`.
3. Create/confirm the private artifact bucket and lifecycle policy.
4. Deploy the active AWS worker and confirm a real worker tick.
5. Set `MAVLY_ANDROID_BUILD_ENABLED` and the same small `MAVLY_ANDROID_BUILD_PROJECTS`
   cohort.
6. Run the human acceptance checklist in `docs/runbooks/android.md`.
7. Only then expand the cohort.

Disabling the flag/cohort stops new claims and hides build availability; it does not delete
existing builds, snapshots or artifacts. Existing artifacts remain downloadable by their
owner while unexpired. See `docs/runbooks/android.md`.
