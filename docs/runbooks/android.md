# Android runbook

## Current capability

| Capability | State |
|---|---|
| Android project creation | Available (authenticated, idempotent with `clientRequestId`) |
| Kotlin/Compose source generation | Available through the existing Groq pipeline |
| Source validation | Available (`src/lib/android/contract.ts`) |
| Download source ZIP | Available through the authorized source-code route |
| APK/AAB build | **Not configured** |
| Build logs | **Not available** (no build runs) |
| Artifact download | **Not available** (no artifact exists) |
| Emulator/device preview | **Not available** |
| Release signing | **Not configured**; generated source must not contain signing material |
| Google Play / App Store publishing | **Not implemented** |

## Operator checks

1. Confirm `GROQ_API_KEY` is present in the server runtime if Android generation is
   expected to work. Without it, agent start answers `503 BACKEND_NOT_CONFIGURED`.
2. Apply migrations 22 and 25. Without migration 22, project type selection fails; without
   25, Android creation retries are not idempotent.
3. Do not enable or advertise builds, artifacts or store publishing. The API reports
   `ANDROID_BUILD_NOT_CONFIGURED`; treat any dashboard copy that claims otherwise as a bug.

## User-visible behaviour

- The dashboard creates the Android project and immediately starts source generation.
- The Android workspace polls `agent/status`, shows the run stage, updates the source tree
  when a run finishes, and offers **Download source**.
- The workspace displays: “Kotlin/Compose source only — no APK/AAB build”. This is
  intentional and must not be replaced with a fake build progress or artifact link.
- A run that fails the Android source contract is reported as failed. Completed batches
  are retained and can be restored from the run's baseline; the project is not a
  successful build.

## Failure triage

| Symptom | Meaning | Action |
|---|---|---|
| `ANDROID_BUILD_NOT_CONFIGURED` | No isolated build executor | Expected; do not retry as if it were transient |
| `GENERATION_CONTRACT_INVALID` | Generated source breaks the profile | Inspect the run message; retry with a narrower prompt |
| `GENERATION_UNSAFE_PATH` | Binary/secret/signing/build-output path | Treat as a model or policy regression; inspect the run |
| `BACKEND_NOT_CONFIGURED` | Groq key missing | Configure `GROQ_API_KEY` server-side |
| `ANDROID_HOSTING_NOT_CONFIGURED` | Static website publish attempted on Android | Expected; Android hosting is not implemented |

## Security notes

- Never add a keystore, signing password, Play service-account JSON or provider token to a
  generated Android project.
- Never run Gradle on a Mavly host. A future build must run in an isolated provider
  microVM with a pinned image and restricted egress.
- Never stream an artifact from a destroyed sandbox or mint a public URL. Artifact
  delivery requires real private storage and owner-authorized short-lived links.

## Human acceptance checklist (source slice)

Run these as the human developer; agents must not run them under `AGENTS.md`.

1. Apply migrations 22 and 25 (additive). Do not apply to production without authorization.
2. Set `GROQ_API_KEY` in `.env.local`; start `npm run dev`.
3. Create an Android project from the dashboard with a prompt. Confirm the project opens at
   `/project/{id}` and generation starts.
4. Confirm the run produces `settings.gradle.kts`, root and app Gradle files,
   `AndroidManifest.xml`, `MainActivity.kt` at `com/mavly/<slug>/`, and `README.md`.
5. Confirm the package/namespace/applicationId agree and the manifest has one exported
   MAIN/LAUNCHER `MainActivity`.
6. Edit a Kotlin file in the workspace and save; confirm it reloads. Try saving an
   `app/release.apk` or `.env` path and confirm `400 VALIDATION`.
7. Download the source ZIP; confirm it contains no APK/AAB/keystore.
8. `POST …/mobile/builds` must return `503 ANDROID_BUILD_NOT_CONFIGURED`;
   `GET …/mobile/builds` must return `builds: []` and `build.available: false`.
9. Create/update a website project and confirm the website workspace, preview and
   snapshots still behave as before.
10. Run `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` and a manual
    smoke test; record the actual results. None of this is claimed by the agent.

## Enabling builds later

Do not flip an environment flag: no build executor exists to enable. Implement the five
items in `docs/architecture/phase-9-android.md` (pinned image, durable queue, build policy,
artifact storage, verification evidence), then update the capability contract and this
runbook together.
