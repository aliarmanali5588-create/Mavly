# Android runbook

## Current capability

| Capability | State |
|---|---|
| Android project creation | Available (authenticated, idempotent with `clientRequestId`) |
| Kotlin/Compose source generation | Available through the existing OpenRouter pipeline |
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

```bash
# Android build engine
MAVLY_ANDROID_BUILD_ENABLED=1
MAVLY_ANDROID_BUILD_PROJECTS=<explicit project ids, comma/semicolon separated>
MAVLY_ANDROID_BUILD_IMAGE=<team>/<project>/android-build@sha256:<64 hex>
MAVLY_ANDROID_ARTIFACT_BUCKET=android-artifacts
MAVLY_ANDROID_BUILD_VCPUS=2                # 1..4; 2048 MB per vCPU

# Vercel Sandbox authentication (one of these forms)
VERCEL_OIDC_TOKEN=<token>
# or:
VERCEL_TOKEN=<token>
VERCEL_TEAM_ID=<team id>
VERCEL_PROJECT_ID=<project id>

# Worker and database (required; builds are not claimed without these)
SUPABASE_SERVICE_ROLE_KEY=<server-only service role key>
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
# Deploy the platform-wide Render Background Worker; no project worker settings are needed.
```

Semantics, all read by `src/lib/android/build-config.ts`:

| Variable | Required | Meaning |
|---|---|---|
| `MAVLY_ANDROID_BUILD_ENABLED` | yes | `1`/`true`/`yes`/`on`. Anything else is disabled. |
| `MAVLY_ANDROID_BUILD_PROJECTS` | yes | Explicit cohort, comma/semicolon separated. `*`, an empty value or an invalid slug fails closed. |
| `MAVLY_ANDROID_BUILD_IMAGE` | yes | VCR image with `@sha256:<64 hex>`. A tag is rejected; an external registry host is rejected. |
| `MAVLY_ANDROID_ARTIFACT_BUCKET` | no | Defaults to `android-artifacts`. A custom bucket is allowed but reported as an unverified assumption (`non_default_bucket`). |
| `MAVLY_ANDROID_BUILD_VCPUS` | no | Integer 1–4, default 2. Non-numeric values fail closed. |
| `VERCEL_OIDC_TOKEN` or the access-token triple | yes | Presence only is checked. Mavly does not probe the provider during admission; a rejected token surfaces as a typed provider error. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Worker and private storage only. Never `NEXT_PUBLIC_*`. |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Project URL. |
| Render Background Worker | yes | The worker advances build jobs when no generation job is ready. |

**Only a presence check happens at request time.** Nothing in the API proves that
the credentials work, that the image exists, that the bucket is private, or that the
worker is running. Confirm operation in the Render service logs.

**Provider plan.** The worker creates each sandbox with the 24-hour session timeout
in `ANDROID_BUILD_SESSION_TIMEOUT_MS` and a 22-minute build deadline. Vercel
documents a 45-minute sandbox maximum on Hobby and 24 hours on Pro/Enterprise, so a
plan that rejects the requested lifetime surfaces as `sandbox_create_failed` /
`provider_error`. This has not been exercised against a live account; confirm it in
the disposable environment before widening the cohort.

## Build image (`infra/android-build/`)

The image is defined in this repository and must be built, verified and published by
the operator. No image is published by this repository's tooling.

| Requirement | Value |
|---|---|
| Registry | Vercel Container Registry (VCR), `linux/amd64`, repository status **Ready** |
| JDK | 17 (`JAVA_HOME=/opt/jdk`) |
| Gradle | **8.9 on `PATH`** (`gradle`, never `./gradlew`) |
| Android SDK | platform 35, build-tools 35.0.0, platform-tools |
| `aapt` | On `PATH` from build-tools/35.0.0 |
| Cache | `GRADLE_USER_HOME=/home/mavly/.gradle`, warmed with the pinned baseline graph |
| User/cwd | non-root `mavly`, `/vercel/sandbox` writable |
| Network at runtime | **deny-all**; the build is `--offline` |

Build locally and verify (human-run; `infra/android-build/README.md` has the full
explanation):

```bash
cd infra/android-build
cp pins.env.example pins.env
# Fill in a digest-pinned BASE_IMAGE and a SHA-256 for the JDK, Gradle 8.9 and
# command-line-tools archives. Never commit pins.env.

./build.sh            # builds linux/amd64 locally; validates every pin
./verify.sh           # java 17, gradle 8.9, SDK 35, aapt, cache, then an
                      # offline seed build with --network none
```

Publish to VCR and obtain the digest:

```bash
vercel login
vercel link
vercel vcr login docker
export VCR_IMAGE="vcr.vercel.com/<team>/<project>/android-build:android-debug-v1"
./publish.sh
```

`publish.sh` prints the registry manifest. Use the returned digest:

```bash
MAVLY_ANDROID_BUILD_IMAGE=<team>/<project>/android-build@sha256:<digest>
```

Do not configure the tag. If `Sandbox.create()` reports `image_not_ready`, VCR is
still preparing the optimized image; retry later.

### Cache scope

The warmed cache covers only the pinned baseline the planner emits: AGP 8.7.3,
Kotlin/Compose plugins 2.0.21, core-ktx 1.13.1, activity-compose 1.9.3,
lifecycle-runtime-ktx 2.8.7 and Compose BOM 2024.10.01. A generated project that
adds another library fails offline with `Could not resolve` / `No cached version`.
That is the intended policy. To support an approved extra dependency, add its exact
pinned coordinate to `infra/android-build/seed/app/build.gradle.kts`, rebuild,
re-verify, republish and update the digest. Never enable network access in the
sandbox to paper over a cache miss.

## Durable worker

Android builds do not have their own worker. They are advanced by the Render
Background Worker through the existing `src/lib/generation/worker.ts` tick. The
worker process is trusted; there is no public worker route or worker-specific bearer
secret.

- **Ordering:** one invocation first recovers expired leases, then claims at most
  one generation job. Only when the generation queue is empty does it advance
  **either** verification **or** one Android build — never both. A busy generation
  queue delays builds; it never preempts a run.
- **Bounded work:** a tick performs one claim and returns. An Android build has a
  22-minute overall deadline, a 16-minute per-stage deadline, a 300-second fenced
  build lease (renewed while the tick runs) and 2 attempts for provider/storage
  failures. Concurrency is capped at 1 active build per project, 2 per user and 4
  globally, enforced in SQL.
- **Scheduling:** The Render Background Worker continuously polls, waiting five
  seconds after an empty tick. Multiple instances are safe (`FOR UPDATE SKIP
  LOCKED` and fenced leases prevent double claims) but consume the small global
  admission caps. The generation lease is 420 seconds (renewed every 120 s), and
  an Android build holds a shorter, separately fenced build lease.
- **Pause/drain:** disabling the Android flag stops new claims but the tick still
  runs DB-only recovery and retention. Stopping the worker entirely stops both,
  so cancel or finish active builds first; otherwise a `running` row stays
  `running` until a tick resumes.
- **Capability reporting:** `GET …/mobile/builds` reports the exact blocker when
  the engine is not available. A configured worker is not proof that the Render
  process is running.

## Private artifact bucket

Migration 26 installs `android-artifacts` as **private**, with a 100 MB object
limit and `application/vnd.android.package-archive`. Do not make it public.

- Writes/deletes use the confined service-role client
  (`src/lib/android/artifact-store.ts`). The authenticated role has no storage
  policy on the bucket.
- Reads: the API proves project ownership through RLS, then signs the
  **server-recorded** object key for 300 seconds. The browser never receives the
  bucket name, the object key or a permanent URL.
- Keys are server-derived: `<project-id>/<build-id>/<sha256>.apk`.
- Artifacts expire after 7 days; the worker marks them `expiring`, deletes the
  object, then records `expired` (or `delete_failed` for a bounded retry).
- A custom `MAVLY_ANDROID_ARTIFACT_BUCKET` must be created by the operator with
  the same private policy and limits. Mavly cannot inspect the policy from the
  environment, so the capability exposes a `non_default_bucket` warning. If the
  bucket is missing or the service role lacks access, the build fails with
  `artifact_storage_failed` (retryable) and no download is offered.

## Migration and rollout order

1. Apply `22_project_type.sql` (project type) if it is not already applied.
2. Apply `25_project_creation_idempotency.sql` (Android creation idempotency).
3. Apply `20_fullstack_hosting.sql` if it is not already applied (migration 26
   references `project_snapshots`/`projects` only, but the documented order is 20
   before 26).
4. Apply `26_android_builds.sql` (additive; schema marker 26, durable build
   table/RPCs and the private bucket).
5. Enable the generation worker and confirm one empty tick returns `200` with a
   real status (for example `empty`), not `503`.
6. Build/verify/publish the image and set its digest.
7. Add **one** disposable project only to `MAVLY_ANDROID_BUILD_PROJECTS`.
   Production generation dispatch is platform-wide and needs no matching worker cohort.
8. Run the acceptance checklist below before widening the cohort.

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
| `ANDROID_BUILD_NOT_CONFIGURED` | Flag/cohort/image/credentials/bucket/worker missing | Fix configuration; do not retry as transient. The API message names the first blocker. |
| `image_registry_unsupported` (capability) | Image is on Docker Hub/GHCR/another registry, or an `https://` URL | Push to VCR and use a team-scoped or `vcr.vercel.com/...` digest reference |
| `image_not_pinned` (capability) | Image reference has a tag, not `@sha256:` | Use the digest printed by `publish.sh` |
| `MIGRATION_REQUIRED` | Migration 26 not applied | Apply it after 20/25 |
| `ANDROID_BUILD_INVALID` / `source_invalid` | Snapshot fails the contract or hash | Inspect the run/build diagnostic; regenerate source |
| `build_failed` with `Could not resolve` / `No cached version` | Offline Gradle cache miss (dependency outside the baseline) | Either regenerate without the extra dependency, or add the exact coordinate to `infra/android-build/seed/app/build.gradle.kts`, rebuild/verify/republish and update the digest. Never remove `--offline`. |
| `build_failed` (other) | Gradle exited non-zero for source/compile reasons | Inspect the redacted log; fix source. Do not bypass the build. |
| `artifact_missing` / `artifact_invalid` | Build exited 0 but no valid APK | Treat as a toolchain/source failure; inspect log and image |
| `artifact_package_mismatch` | APK package differs from the generated application id | Regenerate source; do not bypass |
| `artifact_storage_failed` | Private upload failed | Confirm the bucket exists, is private and the service role can write. Bounded retry runs. |
| `sandbox_create_failed` / `provider_error` | Provider/credential/image failure | Check `VERCEL_OIDC_TOKEN` or the token triple, Vercel status, VCR repository `Ready` state. `image_not_ready` means retry after VCR preparation. Bounded retry runs. |
| `configuration_error` | A prerequisite was invalid at execution time | Fix configuration; the row is terminal, start a new build |
| `timed_out` | Hard deadline or stage timeout | Inspect image/cache size; retry or narrow source |
| `cancelled` | Owner cancelled | Expected |
| `ANDROID_ARTIFACT_EXPIRED` / `UNAVAILABLE` | Retention passed or object unavailable | Start a new build; old object is not restored |

### Troubleshooting detail

- **Cache miss after a model change.** A generated project may import a library that
  is not in the warmed baseline. The redacted log shows
  `Could not resolve <coordinate>` or `No cached version ... available for offline
  mode`. Confirm the coordinate is pinned, then rebuild the image with it. Do not
  weaken the network policy.
- **Provider unavailable or credentials rejected.** `sandbox_create_failed` and
  `provider_error` are retried within the 2-attempt budget. If both attempts fail, verify
  the token form
  (`VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN` + `VERCEL_TEAM_ID` +
  `VERCEL_PROJECT_ID`), the VCR repository's `Ready` state, and that the image
  digest exists. Mavly does not probe credentials at admission time.
- **Storage authorization.** `artifact_storage_failed` means the upload was
  refused. Confirm the bucket exists, is private, and the service-role key is the
  one for this Supabase project. The build row never fabricates a download.
- **Build never leaves `queued`.** Check that the Render Background Worker is deployed
  and running, and that the project is in `MAVLY_ANDROID_BUILD_PROJECTS`. Review its
  structured logs; there is no public worker HTTP response. A disabled Android flag
  still recovers DB-only state, but will not claim new builds.
- **Build stuck in `running`.** Stop the worker only after cancelling. A pause
  stops recovery too. On resume, recovery settles an expired lease and a
  cancel-requested row.

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

1. Apply migrations 22, 25, 20 (if absent) and 26 in a disposable Supabase project.
2. Build, verify and publish the image from `infra/android-build/` (see that
   README). `./verify.sh` must pass its offline seed build. Confirm
   `java -version` (17), `gradle --version` (8.9), platform 35, build-tools 35.0.0,
   `aapt`, and the warmed cache. Confirm the VCR repository is `Ready` and use its
   `@sha256:` digest.
3. Set `OPENROUTER_API_KEY`, Vercel Sandbox credentials, `SUPABASE_SERVICE_ROLE_KEY`,
   `NEXT_PUBLIC_SUPABASE_URL`, the generation-worker variables, and the Android
   build variables above.
4. Deploy the Render Background Worker from `render.yaml` and observe its start and
   repeated tick logs. Confirm it resumes polling after a Render redeploy.
5. `npm install`; `npm run dev`; create an Android project from the dashboard and
   generate source. Confirm the source contract passes.
6. Edit/save a Kotlin file; reload and confirm persistence. Try an `.env`, `.apk`
   or keystore path and confirm `400 VALIDATION`.
7. Start a debug build. Confirm `GET …/mobile/builds` shows real
   `queued`/`running` states, attempt, stage and toolchain from the server.
8. Confirm the worker built the recorded snapshot: edit a file immediately after
   queueing and verify the running build still reports the original snapshot hash.
9. Confirm the APK exists, its package id matches, and its size/SHA-256 are shown.
   Download it through the signed URL before it expires and verify the checksum
   locally.
10. Use a second account: confirm it cannot read the build, cancel it, or download
    the APK.
11. Force a failing source; confirm a real `failed` state with a redacted log, no
    artifact, and no false success.
12. Cancel a queued and a running build; confirm the microVM is destroyed and no
    artifact is published.
13. Let an APK expire (or shorten retention in a test environment); confirm the
    download returns `410` and the object is removed.
14. Create/update a website project and confirm preview, snapshots and
    verification are unchanged. Confirm full-stack hosting and billing are
    untouched.
15. Run `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` and a
    manual smoke test; record actual results. None of this is claimed by the
    agent.

## Rollback

1. Set `MAVLY_ANDROID_BUILD_ENABLED` false (or remove the cohort). New builds fail closed;
   existing source, snapshots and unexpired artifacts are preserved.
2. Let active builds reach terminal or cancel them as owner **before** pausing the
   worker; a paused worker performs no recovery, so a `running` row would stay
   `running` until a tick resumes.
3. If the migration must be removed, delete the migration-26 functions/table and the
   private bucket only after no worker is running. Do not delete projects, snapshots or
   source files.
4. Website and full-stack paths do not depend on the Android build table or flag.
