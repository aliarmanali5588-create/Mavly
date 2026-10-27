/**
 * ═══ ONE ANDROID BUILD TICK ═════════════════════════════════════════════════
 *
 * A build is durable work advanced by ordinary generation-worker ticks:
 *
 *   queued → create sandbox → upload immutable snapshot → start Gradle
 *   running → reconnect → read exit marker → validate APK → upload → complete
 *
 * ⚠️ THE WORKER COMPILES THE SNAPSHOT ROW, NOT LIVE PROJECT FILES. The source
 * hash is re-verified before upload and the contract is re-validated.
 *
 * ⚠️ NO GENERATED CODE RUNS ON A MAVLY HOST. Every command runs inside the
 * provider microVM with no network, no project credentials and no host mounts.
 *
 * ⚠️ A LOST LEASE NEVER PUBLISHES. Every stage note, the artifact upload gate
 * and the terminal write are fenced by the lease token.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSnapshot, isSnapshotFailure } from "@/lib/mavly/snapshots";
import { androidPackageForProject } from "@/lib/android/contract";
import { emitAndroidBuildEvent } from "@/lib/observability/android-build";
import {
  isSandboxOk,
  type SandboxAdapter,
  type SandboxSession,
} from "@/lib/sandbox/adapter";
import { createVercelSandboxAdapter } from "@/lib/sandbox/vercel-sandbox";

import { createAndroidArtifactStore } from "./artifact-store";
import {
  ANDROID_ARTIFACT_COPY,
  ANDROID_ARTIFACT_FILE_NAME,
  ANDROID_ARTIFACT_PATH,
  ANDROID_BUILD_EXIT_MARKER,
  ANDROID_BUILD_TAIL,
  ANDROID_ARTIFACT_CONTENT_TYPE,
  ANDROID_LOG_EXCERPT_MAX_CHARS,
  ANDROID_LOG_TAIL_MAX_BYTES,
  androidAaptCommand,
  androidArtifactSizeCommand,
  androidBuildNetworkPolicy,
  androidBuildScript,
  androidLogTailScript,
  artifactExpiryIso,
  artifactObjectPath,
  buildDiagnostics,
  buildEnvironment,
  buildLogExcerpt,
  parseAaptPackage,
  parseArtifactSize,
  parseBuildExit,
  prepareAndroidBuildSource,
  validateApkArchive,
  type AndroidBuildBundle,
} from "./build-policy";
import {
  ANDROID_ARTIFACT_MAX_BYTES,
  ANDROID_ARTIFACT_RETENTION_DAYS,
  ANDROID_BUILD_SESSION_TIMEOUT_MS,
  ANDROID_BUILD_STAGE_TIMEOUT_MS,
  androidBuildConfig,
  type AndroidBuildConfig,
} from "./build-config";
import {
  claimAndroidBuild,
  claimAndroidBuildCleanup,
  claimExpiredAndroidArtifacts,
  completeAndroidBuild,
  getAndroidBuildFull,
  isAndroidBuildStoreFailure,
  markAndroidArtifactDeleted,
  markAndroidBuildCleanup,
  noteAndroidBuildStage,
  recoverExpiredAndroidBuilds,
  releaseAndroidBuild,
  renewAndroidBuildLease,
  retryAndroidBuild,
  androidBuildSchemaVersion,
} from "./build-store";
import {
  type AndroidBuildErrorClass,
  type AndroidBuildRecord,
  type AndroidBuildStatus,
} from "./build-state";

const LEASE_SECONDS = 300;
const RETRY_AFTER_SECONDS = 15;

export type AndroidBuildTickStatus =
  | "empty"
  | "started"
  | "waiting"
  | "completed"
  | "failed"
  | "retry"
  | "cancelled"
  | "cleaned"
  | "unavailable"
  | "error";

export interface AndroidBuildTickSummary {
  status: AndroidBuildTickStatus;
  buildId?: string;
  projectId?: string;
  outcome?: string;
  reason?: string;
  recovered?: number;
  cleaned?: number;
}

export interface AndroidBuildTickOptions {
  client: SupabaseClient;
  workerId: string;
  config?: AndroidBuildConfig;
  adapter?: SandboxAdapter | null;
}

interface BuildContext {
  client: SupabaseClient;
  adapter: SandboxAdapter;
  config: AndroidBuildConfig;
  workerId: string;
  startedAtMs: number;
}

/** Work that needs only the service client: recovery and artifact retention. */
interface TickBase {
  client: SupabaseClient;
  workerId: string;
}

function terminalStatusFor(
  errorClass: AndroidBuildErrorClass,
): Exclude<AndroidBuildStatus, "queued" | "running"> {
  if (errorClass === "timeout") return "timed_out";
  if (errorClass === "configuration_error") return "configuration_error";
  if (
    errorClass === "sandbox_create_failed" ||
    errorClass === "sandbox_not_found" ||
    errorClass === "upload_failed" ||
    errorClass === "artifact_storage_failed" ||
    errorClass === "provider_error" ||
    errorClass === "internal_error"
  ) {
    return "infrastructure_error";
  }
  return "failed";
}

function retryableClass(errorClass: AndroidBuildErrorClass): boolean {
  return (
    errorClass === "sandbox_create_failed" ||
    errorClass === "sandbox_not_found" ||
    errorClass === "upload_failed" ||
    errorClass === "artifact_storage_failed" ||
    errorClass === "provider_error" ||
    errorClass === "internal_error"
  );
}

export async function runAndroidBuildTick(
  options: AndroidBuildTickOptions,
): Promise<AndroidBuildTickSummary> {
  const config = options.config ?? androidBuildConfig();

  // Schema and the DB-only retention/recovery work do not depend on provider
  // configuration. Running them first means a build left `running` by a worker
  // that disappeared is still recovered after an operator disables builds, so
  // the workspace cannot poll a dead row forever.
  const schema = await androidBuildSchemaVersion(options.client);
  if (schema === null) {
    emitAndroidBuildEvent("android_build.unavailable", { reason: "schema_outdated" });
    return { status: "unavailable", reason: "schema_outdated" };
  }

  const base: TickBase = { client: options.client, workerId: options.workerId };
  const recovered = await recoverSafely(base);
  const expired = await expireArtifactsSafely(base);

  if (!config.requested) {
    emitAndroidBuildEvent("android_build.unavailable", { reason: "disabled" });
    return { status: "unavailable", reason: "disabled", recovered, cleaned: expired };
  }
  if (!config.ready) {
    emitAndroidBuildEvent("android_build.unavailable", {
      reason: `config:${config.problems[0] ?? "not_ready"}`.slice(0, 80),
    });
    return { status: "unavailable", reason: "not_ready", recovered, cleaned: expired };
  }

  const adapter =
    options.adapter ??
    (config.provider === "vercel" ? createVercelSandboxAdapter(config.credentials) : null);
  if (!adapter) {
    emitAndroidBuildEvent("android_build.unavailable", { reason: "provider_unavailable" });
    return {
      status: "unavailable",
      reason: "provider_unavailable",
      recovered,
      cleaned: expired,
    };
  }

  const context: BuildContext = {
    client: options.client,
    adapter,
    config,
    workerId: options.workerId,
    startedAtMs: Date.now(),
  };

  const cleaned = await cleanOrphansSafely(context);

  const claim = await claimAndroidBuild(
    context.client,
    context.workerId,
    LEASE_SECONDS,
    context.config.cohort,
  );
  if (isAndroidBuildStoreFailure(claim)) {
    emitAndroidBuildEvent("android_build.error", {
      workerId: context.workerId,
      reason: claim.code,
    });
    return {
      status: "error",
      reason: claim.code.toLowerCase(),
      recovered,
      cleaned: cleaned + expired,
    };
  }
  if (!claim.data) {
    return { status: "empty", recovered, cleaned: cleaned + expired };
  }

  const build = claim.data.build;
  if (!build.lease_token) {
    return {
      status: "error",
      reason: "missing_lease",
      recovered,
      cleaned: cleaned + expired,
    };
  }
  emitAndroidBuildEvent("android_build.claimed", {
    buildId: build.id,
    projectId: build.project_id,
    workerId: context.workerId,
    attempt: build.attempt,
    maxAttempts: build.max_attempts,
  });

  const outcome = await advanceBuild(context, build);
  return {
    ...outcome,
    recovered,
    cleaned: cleaned + expired,
  };
}

async function advanceBuild(
  context: BuildContext,
  claim: AndroidBuildRecord,
): Promise<AndroidBuildTickSummary> {
  if (!claim.lease_token) {
    return { status: "error", buildId: claim.id, reason: "missing_lease" };
  }
  const lease = claim.lease_token;

  const latest = await getAndroidBuildFull(context.client, claim.project_id, claim.id);
  if (isAndroidBuildStoreFailure(latest)) {
    return { status: "error", buildId: claim.id, reason: "store_unavailable" };
  }
  if (!latest.data || latest.data.finished_at) {
    return { status: "empty", buildId: claim.id };
  }
  const build = latest.data;

  if (build.cancel_requested_at) {
    const cleared = await destroyBuildSandbox(context.adapter, build.sandbox_id);
    const result = await completeAndroidBuild(context.client, {
      buildId: build.id,
      leaseToken: lease,
      status: "cancelled",
      errorClass: "cancelled",
      summary: "The Android build was cancelled.",
      cleanupComplete: cleared,
    });
    emitCompletion(context, build, "cancelled", "cancelled");
    return { status: result === "completed" ? "cancelled" : "error", buildId: build.id, projectId: build.project_id };
  }

  const now = Date.now();
  if (build.deadline_at && Date.parse(build.deadline_at) <= now) {
    return finishFailure(context, build, lease, {
      errorClass: "timeout",
      summary: "The Android build passed its hard deadline and was stopped.",
      diagnostics: [],
      logExcerpt: null,
      logTruncated: false,
    });
  }

  const snapshot = await getSnapshot(build.project_id, build.snapshot_id, context.client);
  if (isSnapshotFailure(snapshot)) {
    return finishFailure(context, build, lease, {
      errorClass: "source_invalid",
      summary: "The Android build snapshot could not be loaded.",
      diagnostics: [snapshot.code],
      logExcerpt: null,
      logTruncated: false,
    });
  }
  const prepared = prepareAndroidBuildSource(
    snapshot.data.files,
    build.source_hash,
    androidPackageForProject(build.project_id),
  );
  if (prepared.ok === false) {
    return finishFailure(context, build, lease, {
      errorClass: prepared.errorClass,
      summary: prepared.summary,
      diagnostics: prepared.diagnostics,
      logExcerpt: null,
      logTruncated: false,
    });
  }
  const bundle = prepared.bundle;

  if (!build.sandbox_id) {
    return startBuild(context, build, lease, bundle);
  }
  return continueBuild(context, build, lease, bundle);
}

/** The same row with the sandbox this attempt created, for truthful cleanup. */
function trackedSandbox(build: AndroidBuildRecord, sandboxId: string): AndroidBuildRecord {
  return { ...build, sandbox_id: build.sandbox_id ?? sandboxId };
}

async function startBuild(
  context: BuildContext,
  build: AndroidBuildRecord,
  lease: string,
  bundle: AndroidBuildBundle,
): Promise<AndroidBuildTickSummary> {
  const created = await context.adapter.create({
    image: context.config.image!,
    timeoutMs: ANDROID_BUILD_SESSION_TIMEOUT_MS,
    env: buildEnvironment(),
    network: androidBuildNetworkPolicy(),
    purpose: "android-build",
    vcpus: context.config.vcpus,
  });
  if (!isSandboxOk(created)) {
    return finishFailure(context, build, lease, {
      errorClass: "sandbox_create_failed",
      summary: "The isolated Android build environment could not be created.",
      diagnostics: [created.error.code],
      logExcerpt: null,
      logTruncated: false,
    });
  }
  const session = created.value;

  // Persist the sandbox reference before any upload, so a crash cannot orphan it.
  const notedPrepare = await noteAndroidBuildStage(context.client, {
    buildId: build.id,
    leaseToken: lease,
    stage: "preparing",
    sandboxId: session.id,
  });
  if (!notedPrepare) {
    await context.adapter.destroy(session);
    return { status: "error", buildId: build.id, reason: "lease_lost" };
  }

  const notedUpload = await noteAndroidBuildStage(context.client, {
    buildId: build.id,
    leaseToken: lease,
    stage: "uploading",
    sandboxId: session.id,
  });
  if (!notedUpload) {
    // `notedPrepare` already persisted this sandbox id, so a recovered worker
    // may reattach to it. Leave cleanup to that holder or the cleanup sweep.
    return { status: "error", buildId: build.id, reason: "lease_lost" };
  }

  const uploaded = await context.adapter.upload(
    session,
    bundle.files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content, "utf8"),
    })),
  );
  if (!isSandboxOk(uploaded)) {
    // Pass the persisted sandbox id: `finishFailure` must destroy it and report
    // `cleanupComplete` truthfully instead of assuming a manual destroy worked.
    return finishFailure(context, trackedSandbox(build, session.id), lease, {
      errorClass: "upload_failed",
      summary: "The immutable Android source snapshot could not be uploaded.",
      diagnostics: [uploaded.error.code],
      logExcerpt: null,
      logTruncated: false,
    }, true);
  }

  const notedBuild = await noteAndroidBuildStage(context.client, {
    buildId: build.id,
    leaseToken: lease,
    stage: "building",
    sandboxId: session.id,
  });
  if (!notedBuild) {
    // The sandbox id is already durable, so leave the microVM for whoever holds
    // the current lease (or the cleanup sweep). Destroying it here could break a
    // build that a recovered worker has already reattached to.
    return { status: "error", buildId: build.id, reason: "lease_lost" };
  }

  const started = await context.adapter.startDetached(session, androidBuildScript());
  if (!isSandboxOk(started)) {
    return finishFailure(context, trackedSandbox(build, session.id), lease, {
      errorClass: "provider_error",
      summary: "The isolated Android build could not be started.",
      diagnostics: [started.error.code],
      logExcerpt: null,
      logTruncated: false,
    }, true);
  }

  await releaseAndroidBuild(context.client, build.id, lease);
  emitAndroidBuildEvent("android_build.stage", {
    buildId: build.id,
    projectId: build.project_id,
    workerId: context.workerId,
    stage: "building",
    attempt: build.attempt,
  });
  return { status: "started", buildId: build.id, projectId: build.project_id, outcome: "building" };
}

async function continueBuild(
  context: BuildContext,
  build: AndroidBuildRecord,
  lease: string,
  bundle: AndroidBuildBundle,
): Promise<AndroidBuildTickSummary> {
  if (!build.sandbox_id) {
    return finishFailure(context, build, lease, {
      errorClass: "sandbox_not_found",
      summary: "The Android build sandbox reference is missing.",
      diagnostics: [],
      logExcerpt: null,
      logTruncated: false,
    });
  }

  const reconnected = await context.adapter.reconnect(build.sandbox_id);
  if (!isSandboxOk(reconnected)) {
    return finishFailure(context, build, lease, {
      errorClass: reconnected.error.code === "not_found" ? "sandbox_not_found" : "provider_error",
      summary: "The isolated Android build environment is no longer available.",
      diagnostics: [reconnected.error.code],
      logExcerpt: null,
      logTruncated: false,
    });
  }
  const session = reconnected.value;

  if (build.stage === "preparing" || build.stage === "uploading") {
    const uploaded = await context.adapter.upload(
      session,
      bundle.files.map((file) => ({
        path: file.path,
        content: Buffer.from(file.content, "utf8"),
      })),
    );
    if (!isSandboxOk(uploaded)) {
      return finishFailure(context, build, lease, {
        errorClass: "upload_failed",
        summary: "The immutable Android source snapshot could not be uploaded.",
        diagnostics: [uploaded.error.code],
        logExcerpt: null,
        logTruncated: false,
      });
    }
    const notedBuild = await noteAndroidBuildStage(context.client, {
      buildId: build.id,
      leaseToken: lease,
      stage: "building",
      sandboxId: session.id,
    });
    if (!notedBuild) {
      return { status: "error", buildId: build.id, reason: "lease_lost" };
    }
    const started = await context.adapter.startDetached(session, androidBuildScript());
    if (!isSandboxOk(started)) {
      return finishFailure(context, build, lease, {
        errorClass: "provider_error",
        summary: "The isolated Android build could not be started.",
        diagnostics: [started.error.code],
        logExcerpt: null,
        logTruncated: false,
      });
    }
    await releaseAndroidBuild(context.client, build.id, lease);
    return { status: "started", buildId: build.id, projectId: build.project_id, outcome: "building" };
  }

  if (
    build.stage === "validating_artifact" ||
    build.stage === "uploading_artifact" ||
    build.stage === "finalizing"
  ) {
    return validateAndPublishArtifact(
      context,
      build,
      lease,
      session,
      bundle,
      await readLog(context.adapter, session),
    );
  }

  const exitObserved = await context.adapter.exec(session, "sh", [
    "-c",
    `cat ${ANDROID_BUILD_EXIT_MARKER} 2>/dev/null`,
  ]);
  const exitRaw = isSandboxOk(exitObserved) ? exitObserved.value.stdout : "";
  const exitCode = parseBuildExit(exitRaw);

  if (exitCode === null) {
    const now = Date.now();
    const stageStarted = build.stage_started_at ? Date.parse(build.stage_started_at) : NaN;
    const stageExpired =
      Number.isFinite(stageStarted) && now - stageStarted > ANDROID_BUILD_STAGE_TIMEOUT_MS;
    const deadlineExpired = build.deadline_at ? Date.parse(build.deadline_at) <= now : false;
    if (stageExpired || deadlineExpired) {
      return finishFailure(
        context,
        build,
        lease,
        {
          errorClass: "timeout",
          summary: "The Android build exceeded its execution limit and was stopped.",
          diagnostics: [],
          logExcerpt: await readLog(context.adapter, session),
          logTruncated: true,
        },
        // A stage timeout may be infrastructure slowness; the hard deadline may not.
        !deadlineExpired && build.attempt < build.max_attempts,
      );
    }
    await releaseAndroidBuild(context.client, build.id, lease);
    return { status: "waiting", buildId: build.id, projectId: build.project_id, outcome: "building" };
  }

  const log = await readLog(context.adapter, session);
  if (exitCode !== 0) {
    const diagnostics = buildDiagnostics(log);
    return finishFailure(context, build, lease, {
      errorClass: "build_failed",
      summary: diagnostics.summary ?? "Gradle could not build the Android app.",
      diagnostics: diagnostics.lines,
      logExcerpt: buildLogExcerpt(log),
      logTruncated: diagnostics.truncated,
    });
  }

  return validateAndPublishArtifact(context, build, lease, session, bundle, log);
}

async function validateAndPublishArtifact(
  context: BuildContext,
  build: AndroidBuildRecord,
  lease: string,
  session: SandboxSession,
  bundle: AndroidBuildBundle,
  log: string | null,
): Promise<AndroidBuildTickSummary> {
  const notedValidate = await noteAndroidBuildStage(context.client, {
    buildId: build.id,
    leaseToken: lease,
    stage: "validating_artifact",
    sandboxId: session.id,
  });
  if (!notedValidate) {
    return { status: "error", buildId: build.id, reason: "lease_lost" };
  }

  const artifactSizeProbe = androidArtifactSizeCommand();
  const sized = await context.adapter.exec(
    session,
    artifactSizeProbe.cmd,
    artifactSizeProbe.args,
  );
  if (!isSandboxOk(sized)) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_missing",
      summary: "The expected debug APK could not be inspected.",
      diagnostics: [sized.error.code],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
  }
  /**
   * `readFile` buffers the provider file before it enforces `maxBytes`, so an
   * oversized APK is refused from its reported size instead of being loaded
   * into worker memory first.
   */
  const artifactSize = parseArtifactSize(sized.value.stdout);
  if (artifactSize === null) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_missing",
      summary: "Gradle exited successfully but produced no APK at the expected path.",
      diagnostics: [ANDROID_ARTIFACT_PATH],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
  }
  if (artifactSize > ANDROID_ARTIFACT_MAX_BYTES) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_invalid",
      summary: "The debug APK exceeds the artifact size limit.",
      diagnostics: [`limit ${ANDROID_ARTIFACT_MAX_BYTES} bytes`],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
  }

  const artifact = await context.adapter.readFile(
    session,
    ANDROID_ARTIFACT_PATH,
    ANDROID_ARTIFACT_MAX_BYTES,
  );
  if (!isSandboxOk(artifact)) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_missing",
      summary: "The expected debug APK could not be read.",
      diagnostics: [artifact.error.code],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
  }
  if (!artifact.value) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_missing",
      summary: "Gradle exited successfully but produced no APK at the expected path.",
      diagnostics: [ANDROID_ARTIFACT_PATH],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
  }

  const archive = validateApkArchive(artifact.value);
  if (archive.ok === false) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_invalid",
      summary: archive.summary,
      diagnostics: [],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
  }

  /**
   * Inspect a copy written from the exact bytes that will be uploaded. This
   * binds the aapt package id to the artifact checksum instead of trusting a
   * path a background build process could still be rewriting.
   */
  const copied = await context.adapter.upload(session, [
    { path: ANDROID_ARTIFACT_COPY, content: artifact.value },
  ]);
  if (!isSandboxOk(copied)) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_invalid",
      summary: "The verified APK could not be prepared for package inspection.",
      diagnostics: [copied.error.code],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
  }
  const aapt = androidAaptCommand(ANDROID_ARTIFACT_COPY);
  const badging = await context.adapter.exec(session, aapt.cmd, aapt.args);
  const badgingText = isSandboxOk(badging) ? badging.value.stdout : "";
  const parsed = parseAaptPackage(badgingText);
  if (!parsed.applicationId) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_invalid",
      summary: "The built APK package identity could not be verified.",
      diagnostics: [],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
  }
  if (parsed.applicationId !== bundle.applicationId) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_package_mismatch",
      summary: "The built APK package does not match the generated application id.",
      diagnostics: [`expected ${bundle.applicationId}`],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
  }

  const latest = await getAndroidBuildFull(context.client, build.project_id, build.id);
  if (isAndroidBuildStoreFailure(latest)) {
    return { status: "error", buildId: build.id, reason: "store_unavailable" };
  }
  if (latest.data?.cancel_requested_at) {
    const cleared = await destroyBuildSandbox(context.adapter, session.id);
    await completeAndroidBuild(context.client, {
      buildId: build.id,
      leaseToken: lease,
      status: "cancelled",
      errorClass: "cancelled",
      summary: "The Android build was cancelled.",
      cleanupComplete: cleared,
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    });
    return { status: "cancelled", buildId: build.id, projectId: build.project_id };
  }

  const objectPath = artifactObjectPath(build.project_id, build.id, archive.sha256);
  const bucket = context.config.artifactBucket;
  const store = createAndroidArtifactStore(context.client, bucket);

  const renewed = await renewAndroidBuildLease(context.client, build.id, lease, LEASE_SECONDS);
  if (!renewed) {
    return { status: "error", buildId: build.id, reason: "lease_lost" };
  }
  const notedUpload = await noteAndroidBuildStage(context.client, {
    buildId: build.id,
    leaseToken: lease,
    stage: "uploading_artifact",
    sandboxId: session.id,
  });
  if (!notedUpload) {
    return { status: "error", buildId: build.id, reason: "lease_lost" };
  }

  const uploaded = await store.upload({
    path: objectPath,
    bytes: artifact.value,
    contentType: ANDROID_ARTIFACT_CONTENT_TYPE,
  });
  if (uploaded.ok === false) {
    return finishFailure(context, build, lease, {
      errorClass: "artifact_storage_failed",
      summary: "The verified APK could not be stored privately.",
      diagnostics: [uploaded.code],
      logExcerpt: buildLogExcerpt(log),
      logTruncated: false,
    }, true);
  }

  const notedFinal = await noteAndroidBuildStage(context.client, {
    buildId: build.id,
    leaseToken: lease,
    stage: "finalizing",
    sandboxId: session.id,
  });
  if (!notedFinal) {
    await discardUnpublishedArtifact(context, build, store, objectPath);
    return { status: "error", buildId: build.id, reason: "lease_lost" };
  }

  const cleared = await destroyBuildSandbox(context.adapter, session.id);
  const result = await completeAndroidBuild(context.client, {
    buildId: build.id,
    leaseToken: lease,
    status: "succeeded",
    cleanupComplete: cleared,
    logExcerpt: buildLogExcerpt(log),
    logTruncated: false,
    artifact: {
      bucket,
      path: objectPath,
      fileName: ANDROID_ARTIFACT_FILE_NAME,
      contentType: ANDROID_ARTIFACT_CONTENT_TYPE,
      sizeBytes: archive.sizeBytes,
      sha256: archive.sha256,
      applicationId: parsed.applicationId,
      packageName: parsed.applicationId,
      expiresAt: artifactExpiryIso(ANDROID_ARTIFACT_RETENTION_DAYS),
    },
  });

  if (result !== "completed") {
    // A lost/already-settled lease means this worker did not publish. Drop the
    // object it just uploaded so private Storage holds no orphan copy. The
    // helper refuses to remove bytes a current lease holder may still publish.
    await discardUnpublishedArtifact(context, build, store, objectPath);
  }

  emitCompletion(
    context,
    build,
    result === "completed" ? "succeeded" : result === "cancelled" ? "cancelled" : "not_published",
    result,
  );
  return {
    status:
      result === "completed" ? "completed" : result === "cancelled" ? "cancelled" : "error",
    buildId: build.id,
    projectId: build.project_id,
    outcome: result === "cancelled" ? "cancelled" : "succeeded",
  };
}

/**
 * Remove an uploaded object only when no durable row references it as a live
 * artifact. A stale worker and the current lease holder can derive the same
 * object path from the same snapshot hash, so the row is re-read first.
 */
async function discardUnpublishedArtifact(
  context: BuildContext,
  build: AndroidBuildRecord,
  store: ReturnType<typeof createAndroidArtifactStore>,
  objectPath: string,
): Promise<void> {
  const latest = await getAndroidBuildFull(context.client, build.project_id, build.id);
  if (isAndroidBuildStoreFailure(latest) || !latest.data) {
    // Cannot prove the object is unpublished; leave it for retention cleanup
    // rather than risk deleting a live artifact.
    emitAndroidBuildEvent("android_build.error", {
      buildId: build.id,
      projectId: build.project_id,
      workerId: context.workerId,
      reason: "artifact_orphan_unverified",
    });
    return;
  }
  const row = latest.data;
  if (row.status === "succeeded" && row.artifact_path === objectPath) return;

  /**
   * Only remove bytes that cannot still be published. A different worker may
   * hold the current lease and is allowed to publish this exact object path
   * (the path is derived from the snapshot hash, so it would be the same file).
   * Removing it then could leave a `succeeded` row pointing at a missing
   * object. A terminal row, a requeued build, or a row with a pending
   * cancellation (whose success is settled as cancelled) is safe to clean.
   */
  const terminal = row.finished_at !== null;
  const requeued = row.status === "queued";
  const cancelPending = row.cancel_requested_at !== null;
  if (!terminal && !requeued && !cancelPending) {
    emitAndroidBuildEvent("android_build.lease_lost", {
      buildId: build.id,
      projectId: build.project_id,
      workerId: context.workerId,
      reason: "artifact_still_publishable",
    });
    return;
  }

  const removed = await store.remove(objectPath);
  if (!removed.ok) {
    emitAndroidBuildEvent("android_build.error", {
      buildId: build.id,
      projectId: build.project_id,
      workerId: context.workerId,
      reason: "artifact_orphan_cleanup_failed",
    });
  }
}

interface FailureInput {
  errorClass: AndroidBuildErrorClass;
  summary: string;
  diagnostics: string[];
  logExcerpt: string | null;
  logTruncated: boolean;
}

async function finishFailure(
  context: BuildContext,
  build: AndroidBuildRecord,
  lease: string,
  failure: FailureInput,
  forceRetryable = false,
): Promise<AndroidBuildTickSummary> {
  const cleared = await destroyBuildSandbox(context.adapter, build.sandbox_id);
  const retryable = forceRetryable || retryableClass(failure.errorClass);

  if (retryable && cleared && build.attempt < build.max_attempts) {
    const retried = await retryAndroidBuild(context.client, {
      buildId: build.id,
      leaseToken: lease,
      errorClass: failure.errorClass,
      summary: failure.summary,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
      sandboxCleared: cleared,
    });
    if (retried === "retry") {
      emitAndroidBuildEvent("android_build.retry", {
        buildId: build.id,
        projectId: build.project_id,
        workerId: context.workerId,
        attempt: build.attempt,
        maxAttempts: build.max_attempts,
        errorClass: failure.errorClass,
      });
      return {
        status: "retry",
        buildId: build.id,
        projectId: build.project_id,
        outcome: failure.errorClass,
      };
    }
    if (retried === "cancelled") {
      // `retry_android_build` settled the row as cancelled under its lock.
      emitCompletion(context, build, "cancelled", "cancelled");
      return {
        status: "cancelled",
        buildId: build.id,
        projectId: build.project_id,
        outcome: "cancelled",
      };
    }
  }

  const status = terminalStatusFor(failure.errorClass);
  const result = await completeAndroidBuild(context.client, {
    buildId: build.id,
    leaseToken: lease,
    status,
    errorClass: failure.errorClass,
    summary: failure.summary,
    diagnostics: failure.diagnostics.slice(0, 80),
    logExcerpt: failure.logExcerpt,
    logTruncated: failure.logTruncated,
    cleanupComplete: cleared,
  });
  const cancelled = result === "cancelled";
  emitCompletion(
    context,
    build,
    cancelled ? "cancelled" : status,
    cancelled ? "cancelled" : failure.errorClass,
  );
  return {
    status: result === "completed" ? "failed" : cancelled ? "cancelled" : "error",
    buildId: build.id,
    projectId: build.project_id,
    outcome: cancelled ? "cancelled" : failure.errorClass,
  };
}

async function readLog(adapter: SandboxAdapter, session: SandboxSession): Promise<string | null> {
  const tail = await adapter.exec(session, "sh", ["-c", androidLogTailScript()]);
  if (!isSandboxOk(tail)) return null;
  const read = await adapter.readFile(session, ANDROID_BUILD_TAIL, ANDROID_LOG_TAIL_MAX_BYTES);
  if (isSandboxOk(read) && read.value) return read.value.toString("utf8");
  const fallback = await adapter.exec(session, "sh", [
    "-c",
    `tail -c ${ANDROID_LOG_EXCERPT_MAX_CHARS} .mavly/build.log 2>/dev/null`,
  ]);
  return isSandboxOk(fallback) ? fallback.value.stdout : null;
}

async function destroyBuildSandbox(
  adapter: SandboxAdapter,
  sandboxId: string | null,
): Promise<boolean> {
  if (!sandboxId) return true;
  const session = await adapter.reconnect(sandboxId);
  if (!isSandboxOk(session)) {
    return session.error.code === "not_found";
  }
  const destroyed = await adapter.destroy(session.value);
  if (!isSandboxOk(destroyed)) return false;
  return destroyed.value === "deleted" || destroyed.value === "absent";
}

function emitCompletion(
  context: BuildContext,
  build: AndroidBuildRecord,
  status: string,
  outcome: string,
): void {
  emitAndroidBuildEvent("android_build.completed", {
    buildId: build.id,
    projectId: build.project_id,
    workerId: context.workerId,
    status,
    outcome,
    attempt: build.attempt,
    maxAttempts: build.max_attempts,
    durationMs: Math.max(0, Date.now() - context.startedAtMs),
  });
}

async function recoverSafely(context: TickBase): Promise<number> {
  const recovered = await recoverExpiredAndroidBuilds(context.client, 5);
  if (isAndroidBuildStoreFailure(recovered)) {
    emitAndroidBuildEvent("android_build.error", {
      workerId: context.workerId,
      reason: "recovery_failed",
    });
    return 0;
  }
  for (const entry of recovered.data) {
    emitAndroidBuildEvent("android_build.recovered", {
      buildId: entry.buildId,
      projectId: entry.projectId,
      workerId: context.workerId,
      outcome: entry.outcome,
    });
  }
  return recovered.data.length;
}

async function cleanOrphansSafely(context: BuildContext): Promise<number> {
  const claims = await claimAndroidBuildCleanup(context.client, 2);
  let cleaned = 0;
  for (const claim of claims) {
    const cleared = await destroyBuildSandbox(context.adapter, claim.sandboxId);
    await markAndroidBuildCleanup(context.client, claim.buildId, claim.cleanupToken, cleared);
    emitAndroidBuildEvent("android_build.cleanup", {
      buildId: claim.buildId,
      projectId: claim.projectId,
      workerId: context.workerId,
      outcome: cleared ? "cleared" : "failed",
    });
    if (cleared) cleaned += 1;
  }
  return cleaned;
}

async function expireArtifactsSafely(context: TickBase): Promise<number> {
  const claims = await claimExpiredAndroidArtifacts(context.client, 2);
  let expired = 0;
  for (const claim of claims) {
    const store = createAndroidArtifactStore(context.client, claim.bucket);
    const removed = await store.remove(claim.path);
    await markAndroidArtifactDeleted(context.client, claim.buildId, removed.ok);
    emitAndroidBuildEvent("android_build.artifact_expired", {
      buildId: claim.buildId,
      projectId: claim.projectId,
      workerId: context.workerId,
      outcome: removed.ok ? "deleted" : "failed",
    });
    if (removed.ok) expired += 1;
  }
  return expired;
}
