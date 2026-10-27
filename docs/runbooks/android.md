# Android runbook

## Current capability

| Capability | State |
|---|---|
| Android project creation | Available (authenticated, idempotent with `clientRequestId`) |
| Kotlin/Compose source generation | Available through the existing Groq pipeline |
| Source validation | Available (`src/lib/android/contract.ts`) |
| Download source ZIP | Available through the authorized source-code route |
| Debug APK build | **Implemented, off by default** (migration 26 + explicit cohort + pinned image) |
| Build status/history/log excerpt | Available when the build engine is configured |
| Private APK download | Available when a real build succeeded; 5-minute signed URL |
| Emulator/device preview | **Not available** |
| Release signing / AAB | **Not configured**; generated source must not contain signing material |
| Google Play / App Store publishing | **Not implemented** |

A build is `succeeded` only after Gradle exits `0`, the APK package id/size/ZIP structure and
SHA-256 are verified, and the fenced completion writes the artifact metadata. A build is
not an install, a device run or a store release.

## Required configuration

```
MAVLY_ANDROID_BUILD_ENABLED=1
MAVLY_ANDROID_BUILD_PROJECTS=<explicit project ids, comma/semicolon separated>
MAVLY_ANDROID_BUILD_IMAGE=<vcr-image>@sha256:...
MAVLY_ANDROID_ARTIFACT_BUCKET=android-artifacts
MAVLY_ANDROID_BUILD_VCPUS=2
# Vercel Sandbox credentials (OIDC token, or token + team + project)
# SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL
# MAVLY_GENERATION_WORKER_ENABLED + its secret/cohort and a scheduler
```

The image must be a Vercel Container Registry (VCR) image and contain JDK 17, Gradle 8.9,
Android SDK/build-tools 35, `aapt`, accepted SDK licenses and a pre-populated Gradle cache
for the pinned dependencies. The provider's Sandbox `image` field accepts only VCR images,
not arbitrary external registries. The build runs with
`--offline` and **deny-all network**; a cache miss fails the build truthfully. Tags are not
accepted as pins. The migration creates the default private `android-artifacts` bucket; a
different bucket must be created by the operator with the same private policy.

## Migration and rollout order

1. Apply `22_project_type.sql`.
2. Apply `25_project_creation_idempotency.sql`.
3. Apply `26_android_builds.sql` (after 20 and 25). It is additive and installs schema
   marker 26, the durable build table/RPCs and the private bucket.
4. Enable the generation worker and confirm one empty tick succeeds.
5. Add a small `MAVLY_ANDROID_BUILD_PROJECTS` cohort and the same projects in the worker
   cohort if they also use worker-dispatched generation.
6. Run the acceptance checklist below before widening the cohort.

Do not apply migrations to production without explicit authorization.

## Build lifecycle

```
queued → preparing → uploading → building → validating_artifact → uploading_artifact → finalizing → succeeded
                                                                                         ↘ failed / timed_out / cancelled / infrastructure_error
```

- One active build per project; 2 per user; 4 global.
- 22-minute hard deadline; 300-second fenced lease; 2 attempts for provider/storage
  failures. Source/build/artifact-policy failures are terminal.
- A worker crash with a live sandbox is reattached on a later tick; a lost lease cannot
  publish. Expired/terminal sandboxes and expired APKs are cleaned by the worker.
- Cancellation is real: a queued build is marked cancelled; a running build is stopped by
  destroying its microVM on the next worker tick. A build that already succeeded is
  terminal. A requested cancellation is also settled by the DB-only recovery pass when
  builds are disabled or the row holds no expired lease, so it cannot stay active forever.
- The build input is an immutable snapshot. Editing project files after queueing cannot
  change the running build.

## Failure triage

| Symptom | Meaning | Action |
|---|---|---|
| `ANDROID_BUILD_NOT_CONFIGURED` | Flag/cohort/image/credentials/bucket/worker missing | Fix configuration; do not retry as transient |
| `MIGRATION_REQUIRED` | Migration 26 not applied | Apply it after 20/25 |
| `ANDROID_BUILD_INVALID` / `source_invalid` | Snapshot fails the contract or hash | Inspect the run/build diagnostic; regenerate source |
| `build_failed` | Gradle exited non-zero (usually source or offline cache) | Inspect the redacted log; fix source or image cache |
| `artifact_missing` / `artifact_invalid` | Build exited 0 but no valid APK | Treat as a toolchain/source failure; inspect log |
| `artifact_package_mismatch` | APK package differs from the generated application id | Regenerate source; do not bypass |
| `artifact_storage_failed` | Private upload failed | Check bucket/permissions; bounded retry runs |
| `sandbox_create_failed` / `provider_error` | Provider/credential failure | Check Vercel credentials/status; bounded retry runs |
| `timed_out` | Hard deadline or stage timeout | Inspect image/cache size; retry or narrow source |
| `cancelled` | Owner cancelled | Expected |
| `ANDROID_ARTIFACT_EXPIRED` / `UNAVAILABLE` | Retention passed or object unavailable | Start a new build; old object is not restored |

## Security notes

- Generated Android source and Gradle scripts are untrusted; they run only inside the
  provider microVM, never on a Mavly host.
- No project secret, Mavly credential, signing key or service-role key is uploaded into the
  sandbox. The build environment contains only `CI` and Gradle memory options.
- Build output is never installed, opened or executed on Mavly.
- APK/AAB binaries are never stored in Postgres or `project_files`. Object keys are
  server-derived; the browser receives only a short-lived signed URL and safe metadata.
- Never mint a permanent public artifact URL or download from a destroyed sandbox.
- The Next.js verification sandbox is not used for Android; do not equate a source
  generation, a Gradle exit or an APK with a verified runtime.

## Human acceptance checklist (disposable environment)

Run these as the human developer; agents must not run them under `AGENTS.md`.

1. Apply migrations 22, 25 and 26 in a disposable Supabase project.
2. Publish the pinned toolchain image to the Vercel Container Registry (VCR); verify it has
   `java -version` (17), `gradle --version` (8.9), `sdkmanager --list` (SDK 35), `aapt`, and
   the offline Gradle cache.
3. Set `GROQ_API_KEY`, Vercel Sandbox credentials, `SUPABASE_SERVICE_ROLE_KEY`,
   `NEXT_PUBLIC_SUPABASE_URL`, the generation-worker variables, and the Android build
   variables above.
4. `npm install`; `npm run dev`; create an Android project from the dashboard and generate
   source. Confirm the source contract passes.
5. Edit/save a Kotlin file; reload and confirm persistence. Try an `.env`, `.apk` or
   keystore path and confirm `400 VALIDATION`.
6. Start a debug build. Confirm `GET …/mobile/builds` shows real `queued`/`running` states,
   attempt, stage and toolchain from the server.
7. Confirm the worker built the recorded snapshot: edit a file immediately after queueing
   and verify the running build still reports the original snapshot hash.
8. Confirm the APK exists, its package id matches, and its size/SHA-256 are shown. Download
   it through the signed URL before it expires and verify the checksum locally.
9. Use a second account: confirm it cannot read the build, cancel it, or download the APK.
10. Force a failing source; confirm a real `failed` state with a redacted log, no artifact,
    and no false success.
11. Cancel a queued and a running build; confirm the microVM is destroyed and no artifact
    is published.
12. Let an APK expire (or shorten retention in a test environment); confirm the download
    returns `410` and the object is removed.
13. Create/update a website project and confirm preview, snapshots and verification are
    unchanged. Confirm full-stack hosting and billing are untouched.
14. Run `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` and a manual smoke
    test; record actual results. None of this is claimed by the agent.

## Rollback

1. Set `MAVLY_ANDROID_BUILD_ENABLED` false (or remove the cohort). New builds fail closed;
   existing source, snapshots and unexpired artifacts are preserved.
2. Let active builds reach terminal or cancel them as owner **before** pausing the
   scheduler; a paused worker performs no recovery, so a `running` row would stay
   `running` until a tick resumes.
3. If the migration must be removed, delete the migration-26 functions/table and the
   private bucket only after no worker is running. Do not delete projects, snapshots or
   source files.
4. Website and full-stack paths do not depend on the Android build table or flag.
