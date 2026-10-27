# Phase 9 — Native Android source generation

Status: **source generation implemented; isolated builds and artifacts are not configured.**

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
  contract refuses them. A future build must use Gradle 8.9 from its pinned image; a
  downloaded source tree needs an external Gradle 8.9 + JDK 17 installation.

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

## What is deliberately not implemented

### Isolated Android build

No Android build executor exists. The verification sandbox adapter can accept a custom
Vercel Sandbox image, but this deployment has **no operator-pinned Android toolchain image
digest**, and the existing Phase 3/4 verification state machine is Next.js-specific
(`next build`, loopback `next start`, HTTP health check). Reusing it for Gradle would
report a Next.js result for an Android project.

Therefore:

- no APK or AAB is built, signed, installed or run;
- no emulator, device farm or preview is available;
- no build log or build row is fabricated;
- `GET …/mobile/builds` returns an empty history plus an explicit
  `build.status = "not_configured"` capability;
- `POST …/mobile/builds` returns `503 ANDROID_BUILD_NOT_CONFIGURED`;
- artifact/log URLs return `404 ANDROID_BUILD_NOT_FOUND`.

### Artifact storage and release signing

There is no private artifact bucket, retention job, short-lived download URL or release
keystore. Generated projects contain no keystore and no signing configuration; the
contract refuses them. No Google Play or App Store publishing exists.

### Bounded AI repair

The Phase 4 bounded repair is tied to build/runtime/health failures. There is no Android
build stage, so an Android run has no repairable build failure and no repair path is
invoked. Do not reuse the Next.js repair flow for Gradle output; a future Android repair
must consume only bounded, redacted Gradle diagnostics and produce an immutable snapshot,
never edit the user's project.

## Required work before enabling a build

1. **Pinned toolchain image.** Publish a Vercel Sandbox-compatible image by digest with
   JDK 17, Gradle 8.9, Android SDK 35, accepted licenses and no secrets baked in. Treat the
   image digest as configuration, never a tag.
2. **Durable build queue.** Add an additive migration with fenced leases, bounded attempts,
   recovery and cancellation, following the Phase 3/4 pattern. The existing generation
   worker may advance it, but it must not block generation claims.
3. **Build policy.** Upload only the validated snapshot, run only fixed Gradle tasks
   (`assembleDebug` first), restrict egress to the Gradle/Google/Maven hosts, bound logs
   and time, and destroy the microVM on every terminal path. Debug output only; release
   signing is a separate product and security decision.
4. **Artifact storage.** A private bucket, checksum verification, retention deletion, and
   an owner-authorized short-lived download route. The provider sandbox must be destroyed
   after upload.
5. **Verification evidence.** A build exit `0` is evidence that Gradle succeeded, not that
   the app rendered correctly. Device/emulator testing, store publishing and release
   signing need separate claims and controls.

Until all five exist and are verified, the capability must remain `not_configured`.

### Required bounds (design only, not active)

These are the minimum limits a future executor must enforce; they are deliberately not
configurable without review:

| Bound | Proposed value |
|---|---|
| Concurrent builds | 1 per project, 2 per user, 4 global |
| Build deadline | 20 minutes, with a fenced lease and retry |
| Source upload | The existing 80 files / 256 KiB each / 1.5 MB total |
| Artifact size | 200 MB per debug APK |
| Build log | 256 KiB persisted, tail-only, redacted |
| Retry attempts | 1 provider retry for infrastructure only; no blind source retry |
| Artifact retention | 7 days, then deleted with the sandbox |
| Repair attempts | 0 until a debug build executor exists, then at most 1 |

No build is enabled by these numbers; they are the acceptance contract for the future
migration and worker.

## Security boundaries

- Android source remains untrusted data. It is validated and stored as text; it is never
  imported or executed on a Mavly host.
- No project secret, Mavly credential or provider token is injected into generated source.
- The build contract refuses credential-shaped, binary, signing and environment files.
- The generated app has no backend credential and no release signing material.
- The Next.js verification sandbox is **not** enqueued for Android runs, so a project is
  never “verified” by the wrong runtime.
- Existing session, ownership, RLS and project-scope checks are unchanged.

## Rollout

No migration is required for this source-generation slice; migration 22 and 25 already
exist. The path is active for persisted Android projects. Because it uses the same Groq
configuration as websites, it is unavailable when `GROQ_API_KEY` is absent, and the API
answers truthfully rather than creating unbuildable source.

Builds/artifacts remain disabled until the work above is implemented and verified. See
`docs/runbooks/android.md`.
