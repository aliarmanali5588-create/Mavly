import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";

import {
  androidBuildConfig,
  androidBuildProblemMessage,
  isProjectInAndroidBuildCohort,
  parseAndroidBuildConfig,
} from "../src/lib/android/build-config";
import {
  ANDROID_BUILD_COMMAND,
  androidArtifactSizeCommand,
  androidBuildNetworkPolicy,
  androidBuildScript,
  artifactExpiryIso,
  artifactObjectPath,
  buildDiagnostics,
  parseAaptPackage,
  parseArtifactSize,
  parseBuildExit,
  prepareAndroidBuildSource,
  validateApkArchive,
} from "../src/lib/android/build-policy";
import { createAndroidArtifactStore } from "../src/lib/android/artifact-store";
import { hashSource } from "../src/lib/mavly/source-hash";
import {
  effectiveArtifactState,
  toAndroidBuildView,
  type AndroidBuildRecord,
} from "../src/lib/android/build-state";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const MIGRATION = read("supabase/migrations/26_android_builds.sql");
const API = read("src/lib/mavly/api.ts");
const WORKER = read("src/lib/generation/worker.ts");
const ANDROID_WORKER = read("src/lib/android/build-worker.ts");
const BUILD_STORE = read("src/lib/android/build-store.ts");
const BUILD_CONFIG = read("src/lib/android/build-config.ts");
const DASHBOARD = read("src/components/builder/BuilderDashboard.tsx");
const CAPABILITY = read("src/lib/android/capability.ts");

const SHA = "a".repeat(64);
const IMAGE = `registry.invalid/mavly/android-builder@sha256:${SHA}`;

function enabledEnv(): Record<string, string> {
  return {
    MAVLY_ANDROID_BUILD_ENABLED: "1",
    MAVLY_ANDROID_BUILD_PROJECTS: "demo-app, other-app",
    MAVLY_ANDROID_BUILD_IMAGE: IMAGE,
    MAVLY_ANDROID_ARTIFACT_BUCKET: "android-artifacts",
    MAVLY_ANDROID_BUILD_VCPUS: "2",
    VERCEL_TOKEN: "token",
    VERCEL_TEAM_ID: "team",
    VERCEL_PROJECT_ID: "project",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-with-enough-length",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  };
}

function sampleApk(): Buffer {
  return Buffer.from(
    zipSync({
      "AndroidManifest.xml": strToU8("<manifest package=\"com.mavly.demo\" />"),
      "classes.dex": strToU8("dex\n035"),
    }),
  );
}

function record(overrides: Partial<AndroidBuildRecord> = {}): AndroidBuildRecord {
  const now = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "demo-app",
    user_id: "22222222-2222-4222-8222-222222222222",
    snapshot_id: "33333333-3333-4333-8333-333333333333",
    source_hash: SHA,
    status: "succeeded",
    stage: "succeeded",
    attempt: 1,
    max_attempts: 2,
    toolchain: "android-debug-v1",
    build_variant: "debug",
    lease_token: null,
    lease_expires_at: null,
    worker_id: null,
    sandbox_id: null,
    deadline_at: now,
    next_attempt_at: null,
    stage_started_at: now,
    cleanup_complete: true,
    cleanup_claimed_at: null,
    cleanup_token: null,
    artifact_state: "available",
    artifact_bucket: "android-artifacts",
    artifact_path: `demo-app/11111111-1111-4111-8111-111111111111/${SHA}.apk`,
    artifact_file_name: "app-debug.apk",
    artifact_content_type: "application/vnd.android.package-archive",
    artifact_size_bytes: 1024,
    artifact_sha256: SHA,
    application_id: "com.mavly.demoapp",
    package_name: "com.mavly.demoapp",
    artifact_expires_at: new Date(Date.now() + 60_000).toISOString(),
    diagnostics: [],
    log_excerpt: "BUILD SUCCESSFUL",
    log_truncated: false,
    error_class: null,
    error_summary: null,
    cancel_requested_at: null,
    correlation_id: null,
    idempotency_key: null,
    created_at: now,
    started_at: now,
    finished_at: now,
    updated_at: now,
    ...overrides,
  };
}

test("Android build config is all-or-nothing and requires a digest-pinned image", () => {
  const disabled = parseAndroidBuildConfig({});
  assert.equal(disabled.requested, false);
  assert.equal(disabled.ready, false);
  assert.ok(disabled.problems.includes("disabled"));
  assert.equal(androidBuildConfig().ready, false);

  const tagged = parseAndroidBuildConfig({
    ...enabledEnv(),
    MAVLY_ANDROID_BUILD_IMAGE: "registry.invalid/mavly/android-builder:latest",
  });
  assert.equal(tagged.ready, false);
  assert.ok(tagged.problems.includes("image_not_pinned"));

  const missingCohort = parseAndroidBuildConfig({
    ...enabledEnv(),
    MAVLY_ANDROID_BUILD_PROJECTS: "",
  });
  assert.equal(missingCohort.ready, false);
  assert.ok(missingCohort.problems.includes("missing_cohort"));

  const badVcpus = parseAndroidBuildConfig({
    ...enabledEnv(),
    MAVLY_ANDROID_BUILD_VCPUS: "9",
  });
  assert.equal(badVcpus.ready, false);
  assert.ok(badVcpus.problems.includes("invalid_vcpus"));

  const badBucket = parseAndroidBuildConfig({
    ...enabledEnv(),
    MAVLY_ANDROID_ARTIFACT_BUCKET: "Not A Bucket",
  });
  assert.equal(badBucket.ready, false);
  assert.ok(badBucket.problems.includes("invalid_bucket"));

  const ready = parseAndroidBuildConfig(enabledEnv());
  assert.equal(ready.ready, true);
  assert.equal(ready.provider, "vercel");
  assert.equal(ready.vcpus, 2);
  assert.equal(ready.artifactBucket, "android-artifacts");
  assert.equal(isProjectInAndroidBuildCohort("demo-app", ready), true);
  assert.equal(isProjectInAndroidBuildCohort("outside", ready), false);
  assert.match(androidBuildProblemMessage("image_not_pinned"), /Vercel Container Registry/);
  assert.match(androidBuildProblemMessage("image_not_pinned"), /sha256/);
});

test("the build command is fixed, offline and contains no caller input", () => {
  assert.match(ANDROID_BUILD_COMMAND, /:app:assembleDebug/);
  assert.match(ANDROID_BUILD_COMMAND, /--offline/);
  assert.match(ANDROID_BUILD_COMMAND, /--no-daemon/);
  assert.doesNotMatch(ANDROID_BUILD_COMMAND, /\$\{|\$[A-Z]/);

  const script = androidBuildScript();
  assert.match(script, /app\/build\/outputs\/apk\/debug\/app-debug\.apk|assembleDebug/);
  assert.match(script, /build\.exit/);
  assert.match(script, /exit 0/);

  const network = androidBuildNetworkPolicy();
  assert.equal(network.mode, "deny-all");
  assert.deepEqual(network.allowedHosts, []);
});

test("APK archive validation requires a real ZIP with manifest and dex", () => {
  const valid = validateApkArchive(sampleApk());
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.sha256.length, 64);
    assert.ok(valid.sizeBytes > 0);
    assert.ok(valid.entries >= 2);
  }

  assert.equal(validateApkArchive(Buffer.alloc(0)).ok, false);

  const missingDex = Buffer.from(
    zipSync({ "AndroidManifest.xml": strToU8("<manifest />") }),
  );
  assert.equal(validateApkArchive(missingDex).ok, false);

  const traversal = Buffer.from(
    zipSync({
      "AndroidManifest.xml": strToU8("<manifest />"),
      "classes.dex": strToU8("dex"),
      "../escape.txt": strToU8("bad"),
    }),
  );
  assert.equal(validateApkArchive(traversal).ok, false);
});

test("an oversized APK is refused from its reported size before the bytes are read", () => {
  const command = androidArtifactSizeCommand();
  assert.equal(command.cmd, "sh");
  assert.match(command.args[1], /wc -c </);
  assert.throws(() => androidArtifactSizeCommand("/tmp/other.apk"), /INVALID_ARTIFACT_PATH/);

  assert.equal(parseArtifactSize("1048576"), 1048576);
  assert.equal(parseArtifactSize(" 42\n"), 42);
  assert.equal(parseArtifactSize("0"), null);
  assert.equal(parseArtifactSize("-1"), null);
  assert.equal(parseArtifactSize("12.5"), null);
  assert.equal(parseArtifactSize(null), null);

  const probeAt = ANDROID_WORKER.indexOf("androidArtifactSizeCommand()");
  const readAt = ANDROID_WORKER.indexOf("ANDROID_ARTIFACT_MAX_BYTES,\n  );", probeAt);
  assert.ok(probeAt > 0, "size probe present");
  assert.ok(readAt > probeAt, "probe must precede the buffered read");
  assert.match(ANDROID_WORKER, /artifactSize > ANDROID_ARTIFACT_MAX_BYTES/);
});

test("aapt output, exit markers and logs are parsed and redacted", () => {
  const parsed = parseAaptPackage(
    "package: name='com.mavly.demoapp' versionCode='1' versionName='1.0'",
  );
  assert.equal(parsed.applicationId, "com.mavly.demoapp");
  assert.equal(parseAaptPackage("garbage").applicationId, null);
  assert.equal(parseBuildExit("0"), 0);
  assert.equal(parseBuildExit("1"), 1);
  assert.equal(parseBuildExit("not-a-code"), null);

  const diagnostics = buildDiagnostics(
    "error: https://user:pass@example.test/x\nAuthorization: Bearer abcdefghijklmnop\nFAILURE: Build failed",
  );
  assert.ok(diagnostics.lines.some((line) => line.includes("Build failed")));
  assert.ok(diagnostics.lines.every((line) => !line.includes("user:pass")));
  assert.ok(diagnostics.lines.every((line) => !line.includes("abcdefghijklmnop")));
});

test("artifact keys are server-derived and expiry is bounded", () => {
  const buildId = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    artifactObjectPath("demo-app", buildId, SHA),
    `demo-app/${buildId}/${SHA}.apk`,
  );
  const expires = artifactExpiryIso(7, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(expires, "2026-01-08T00:00:00.000Z");
});

test("an expired artifact is never reported as available", () => {
  const live = toAndroidBuildView(record());
  assert.equal(live.artifact?.type, "apk");
  assert.equal(live.artifactState, "available");

  const expired = record({
    artifact_expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
  const view = toAndroidBuildView(expired);
  assert.equal(view.artifact, null);
  assert.equal(view.artifactState, "expired");
  assert.equal(effectiveArtifactState(expired), "expired");
});

test("migration 26 installs a durable, fenced, owner-safe build lifecycle", () => {
  assert.match(MIGRATION, /create table if not exists public\.project_android_builds/);
  assert.match(MIGRATION, /create unique index if not exists project_android_builds_active_project_idx/);
  assert.match(MIGRATION, /where status in \('queued', 'running'\)/);
  assert.match(MIGRATION, /enable row level security/);
  assert.match(MIGRATION, /revoke all on public\.project_android_builds from anon, authenticated/);
  assert.match(MIGRATION, /grant select \([\s\S]*?\) on public\.project_android_builds to authenticated/);
  assert.doesNotMatch(MIGRATION, /grant (?:update|insert|delete)[\s\S]*?project_android_builds to authenticated/);

  for (const fn of [
    "create_android_build",
    "claim_android_build",
    "renew_android_build_lease",
    "release_android_build",
    "complete_android_build",
    "retry_android_build",
    "recover_expired_android_builds",
    "cancel_android_build",
    "claim_android_build_cleanup",
    "mark_android_build_cleanup",
    "claim_expired_android_artifacts",
    "mark_android_artifact_deleted",
    "android_build_schema_version",
  ]) {
    assert.match(MIGRATION, new RegExp(`function public\\.${fn}`), fn);
  }
  assert.match(MIGRATION, /select 26;/);
  assert.match(MIGRATION, /insert into storage\.buckets/);
  assert.match(MIGRATION, /'android-artifacts'[\s\S]*?false/);
  assert.match(MIGRATION, /p_status = 'succeeded'[\s\S]*?INVALID_ARTIFACT_SHA/);
});

test("the worker advances Android builds and the API authorizes downloads", () => {
  assert.match(WORKER, /runAndroidBuildTick/);
  assert.match(WORKER, /runAndroidBuildSafely/);
  assert.match(ANDROID_WORKER, /prepareAndroidBuildSource/);
  assert.match(ANDROID_WORKER, /validateApkArchive/);
  assert.match(ANDROID_WORKER, /renewAndroidBuildLease/);
  assert.match(ANDROID_WORKER, /completeAndroidBuild/);

  assert.match(API, /createAndroidBuild\(/);
  assert.match(API, /androidBuildSnapshot/);
  assert.match(API, /getAndroidBuildForOwner/);
  assert.match(API, /getAndroidBuildFull/);
  assert.match(API, /createSupabaseWorkerClient\(\)/);
  assert.match(API, /store\.sign\(full\.data\.artifact_path, 300\)/);
  assert.doesNotMatch(API, /ANDROID_GENERATION_NOT_CONFIGURED/);
});

test("a build is bound to a snapshot hash, not live project files", () => {
  const files = [{ path: "settings.gradle.kts", content: 'rootProject.name = "demo"' }];
  const hash = hashSource(files);

  const mismatch = prepareAndroidBuildSource(files, "b".repeat(64), "com.mavly.demo");
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.errorClass, "snapshot_mismatch");
    assert.doesNotMatch(mismatch.summary, new RegExp(hash));
  }

  // The hash matches, so the source itself is checked and rejected as invalid.
  const invalid = prepareAndroidBuildSource(files, hash, "com.mavly.demo");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.errorClass, "source_invalid");
});

test("attempt accounting allows exactly max_attempts and a cancellation never requeues", () => {
  assert.match(MIGRATION, /attempt integer not null default 0/);
  assert.match(MIGRATION, /alter column attempt set default 0/);
  assert.match(MIGRATION, /c_max_attempts constant integer := 2/);
  assert.match(
    MIGRATION,
    /attempt = case when v_mode = 'new' then b\.attempt \+ 1 else b\.attempt end/,
  );
  assert.match(MIGRATION, /if v_row\.attempt >= v_row\.max_attempts then/);

  // Cancellation wins over a retry, inside the row lock.
  assert.match(
    MIGRATION,
    /if v_row\.cancel_requested_at is not null then[\s\S]*?status = 'cancelled'[\s\S]*?return jsonb_build_object\('status', 'cancelled'/,
  );
  // ...and over a success that is being finalized while the artifact uploads.
  assert.match(
    MIGRATION,
    /if p_status = 'succeeded' and v_row\.cancel_requested_at is not null then[\s\S]*?status = 'cancelled'/,
  );
  assert.match(BUILD_STORE, /status === "cancelled"/);
  assert.match(ANDROID_WORKER, /if \(retried === "cancelled"\)/);
  assert.match(ANDROID_WORKER, /result === "cancelled" \? "cancelled" : "error"/);
});

test("a requested cancellation is settled even when builds are disabled or no lease remains", () => {
  // Recovery selects cancellation independently of an expired lease/deadline.
  assert.match(
    MIGRATION,
    /where b\.finished_at is null\s+and \(\s+b\.cancel_requested_at is not null\s+or b\.deadline_at <= now\(\)/,
  );
  // The cancel branch wins and leaves a surviving sandbox to the cleanup sweep.
  assert.match(
    MIGRATION,
    /if v_row\.cancel_requested_at is not null then[\s\S]*?status = 'cancelled'[\s\S]*?cleanup_complete = \(b\.sandbox_id is null\)[\s\S]*?v_outcome := 'cancelled'/,
  );
  assert.match(
    MIGRATION,
    /b\.finished_at is not null[\s\S]*?b\.sandbox_id is not null[\s\S]*?b\.cleanup_complete = false/,
  );
  // A cancel-requested row is never claimed or reattached while it settles.
  assert.match(
    MIGRATION,
    /where b\.finished_at is null\s+and b\.cancel_requested_at is null\s+and b\.deadline_at > now\(\)/,
  );
  // The tick recovers before the provider/flag gate can short-circuit it.
  assert.match(ANDROID_WORKER, /recoverSafely\(base\)/);
});

test("a stale worker cannot publish an artifact and never leaves an orphan object", () => {
  // Terminal writes are fenced by the lease token.
  assert.match(
    MIGRATION,
    /v_row\.lease_token is null or v_row\.lease_token <> p_lease_token[\s\S]*?lease_lost/,
  );
  // `succeeded` requires complete, consistent artifact metadata in SQL.
  assert.match(MIGRATION, /if p_status = 'succeeded' then[\s\S]*?INVALID_ARTIFACT_BUCKET/);
  assert.match(MIGRATION, /INVALID_ARTIFACT_PATH/);
  assert.match(MIGRATION, /INVALID_ARTIFACT_SHA/);
  assert.match(MIGRATION, /INVALID_ARTIFACT_SIZE/);
  assert.match(MIGRATION, /INVALID_ARTIFACT_EXPIRY/);
  assert.match(MIGRATION, /return jsonb_build_object\('status', 'already_terminal'/);

  // The worker drops an upload the durable row did not publish.
  assert.match(ANDROID_WORKER, /discardUnpublishedArtifact/);
  assert.match(
    ANDROID_WORKER,
    /row\.status === "succeeded" && row\.artifact_path === objectPath/,
  );
  assert.match(ANDROID_WORKER, /const terminal = row\.finished_at !== null/);
  assert.match(ANDROID_WORKER, /const requeued = row\.status === "queued"/);
  assert.match(ANDROID_WORKER, /if \(!terminal && !requeued\)/);
  assert.match(ANDROID_WORKER, /await store\.remove\(objectPath\)/);
});

test("DB-only recovery runs before provider configuration can short-circuit it", () => {
  const recoverAt = ANDROID_WORKER.indexOf(
    "const recovered = await recoverSafely(base)",
  );
  const disabledAt = ANDROID_WORKER.indexOf("if (!config.requested)");
  assert.ok(recoverAt > 0, "recovery call present");
  assert.ok(disabledAt > 0, "disabled guard present");
  assert.ok(recoverAt < disabledAt, "recovery must precede the config gate");

  assert.match(
    ANDROID_WORKER,
    /const expired = await expireArtifactsSafely\(base\)/,
  );
  assert.match(
    WORKER,
    /const tick = await runAndroidBuildTick\(\{ client, workerId, config \}\)/,
  );
  assert.doesNotMatch(WORKER, /if \(!config\.requested\) return null/);
});

test("artifact retention retries transient delete failures and requires a real key", () => {
  assert.match(
    MIGRATION,
    /b\.artifact_state = 'delete_failed'[\s\S]*?interval '30 minutes'/,
  );
  assert.match(
    MIGRATION,
    /b\.artifact_bucket is not null[\s\S]*?b\.artifact_path is not null/,
  );
  assert.match(
    ANDROID_WORKER,
    /markAndroidArtifactDeleted\(context\.client, claim\.buildId, removed\.ok\)/,
  );
  assert.match(BUILD_STORE, /typeof entry\.bucket === "string"/);
  assert.match(BUILD_STORE, /typeof entry\.path === "string"/);
});

test("artifact storage refuses unsafe keys and clamps signed URL lifetime", async () => {
  const calls = {
    upload: [] as Array<{ path: string; options: unknown }>,
    sign: [] as Array<{ path: string; expires: number }>,
    remove: [] as Array<{ path: string }>,
  };
  const client = {
    storage: {
      from: () => ({
        upload: async (path: string, _bytes: Buffer, options: unknown) => {
          calls.upload.push({ path, options });
          return { error: null };
        },
        createSignedUrl: async (path: string, expires: number) => {
          calls.sign.push({ path, expires });
          return { data: { signedUrl: "https://storage.invalid/object" }, error: null };
        },
        remove: async (paths: string[]) => {
          calls.remove.push({ path: paths[0] });
          return { error: null };
        },
      }),
    },
  } as unknown as Parameters<typeof createAndroidArtifactStore>[0];

  const store = createAndroidArtifactStore(client, "android-artifacts");
  const buildId = "11111111-1111-4111-8111-111111111111";
  const contentType = "application/vnd.android.package-archive";

  for (const path of [
    "../escape.apk",
    "/absolute.apk",
    "demo-app/not-a-build/abc.apk",
    `demo-app/${buildId}/not-a-sha.apk`,
    `demo-app/${buildId}/${SHA}.zip`,
  ]) {
    const uploaded = await store.upload({ path, bytes: Buffer.from("apk"), contentType });
    assert.equal(uploaded.ok, false, path);
  }
  assert.equal(calls.upload.length, 0);

  const good = `demo-app/${buildId}/${SHA}.apk`;
  const uploaded = await store.upload({ path: good, bytes: Buffer.from("apk"), contentType });
  assert.equal(uploaded.ok, true);
  assert.equal(calls.upload.length, 1);
  assert.match(JSON.stringify(calls.upload[0].options), /"upsert":true/);

  const long = await store.sign(good, 999_999);
  assert.equal(long.ok, true);
  assert.equal(calls.sign[0].expires, 900);
  const short = await store.sign(good, 1);
  assert.equal(short.ok, true);
  assert.equal(calls.sign[1].expires, 60);

  const removed = await store.remove(good);
  assert.equal(removed.ok, true);
  assert.equal(calls.remove.length, 1);
});

test("owner download is authorized before the service client and refuses anything unpublished", () => {
  const ownedAt = API.indexOf("getAndroidBuildForOwner(supabase, projectId, buildId)");
  const serviceAt = API.indexOf("createSupabaseWorkerClient()", ownedAt);
  assert.ok(ownedAt > 0, "owner read present");
  assert.ok(serviceAt > ownedAt, "service client must come after the owner read");

  assert.match(API, /view\.status !== "succeeded"[\s\S]*?ANDROID_BUILD_NOT_READY/);
  assert.match(API, /full\.data\.artifact_state !== "available"/);
  assert.match(API, /Date\.parse\(full\.data\.artifact_expires_at\) <= Date\.now\(\)/);
  assert.match(API, /ANDROID_ARTIFACT_EXPIRED/);
  assert.match(API, /store\.sign\(full\.data\.artifact_path, 300\)/);
  assert.doesNotMatch(API, /getPublicUrl/);
});

test("non-available artifact states never expose a download", () => {
  for (const state of [
    "none",
    "expiring",
    "expired",
    "delete_failed",
    "failed",
  ] as const) {
    const view = toAndroidBuildView(record({ artifact_state: state }));
    assert.equal(view.artifact, null, state);
    assert.equal(view.artifactState, state, state);
  }
  assert.equal(toAndroidBuildView(record({ artifact_state: "available" })).artifactState, "available");
});

test("build creation is owner-scoped, idempotent and bounded", () => {
  assert.match(MIGRATION, /v_owner <> v_user[\s\S]*?FORBIDDEN/);
  assert.match(MIGRATION, /s\.user_id = v_user/);
  assert.match(MIGRATION, /p\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(MIGRATION, /pg_advisory_xact_lock\(hashtextextended\('android_build:' \|\| p_project_id/);
  assert.match(MIGRATION, /project_android_builds_idempotency_idx/);
  assert.match(
    MIGRATION,
    /where b\.project_id = p_project_id and b\.idempotency_key = v_key/,
  );
  assert.match(MIGRATION, /'status', 'existing'/);
  assert.match(MIGRATION, /c_project_limit constant integer := 1/);
  assert.match(MIGRATION, /c_user_limit constant integer := 2/);
  assert.match(MIGRATION, /c_global_limit constant integer := 4/);
  assert.match(MIGRATION, /b\.project_id = p_project_id and b\.status in \('queued', 'running'\)/);
});

test("the build API ignores client-supplied snapshot, hash, image and package", () => {
  const start = API.slice(
    API.indexOf("async function androidBuildStartResponse"),
    API.indexOf("async function androidBuildArtifactResponse"),
  );
  assert.ok(start.length > 0);
  assert.match(start, /androidBuildSnapshot\(userId, projectId\)/);
  assert.doesNotMatch(
    start,
    /record\.(snapshotId|snapshot_id|sourceHash|source_hash|image|applicationId|packageName)/,
  );
});

test("Android builds are isolated from Next.js verification and never release products", () => {
  assert.doesNotMatch(ANDROID_WORKER, /next build|next start/);
  assert.match(ANDROID_WORKER, /androidBuildScript\(\)/);
  assert.match(ANDROID_WORKER, /androidBuildNetworkPolicy\(\)/);
  assert.match(MIGRATION, /build_variant text not null default 'debug' check \(build_variant = 'debug'\)/);
  assert.match(MIGRATION, /array\['application\/vnd\.android\.package-archive'\]/);
  assert.match(MIGRATION, /grant all on public\.project_android_builds to service_role/);
  assert.match(API, /release signing\/publishing is not configured/);
  assert.match(CAPABILITY, /no APK can be produced or downloaded|Isolated debug builds are OFF/);
  assert.match(CAPABILITY, /releaseSigning: false/);
  assert.match(CAPABILITY, /googlePlayPublish: false/);
  assert.match(BUILD_CONFIG, /Vercel Container Registry/);
  assert.match(DASHBOARD, /Debug APK builds are available only where an operator enables them/);
});
