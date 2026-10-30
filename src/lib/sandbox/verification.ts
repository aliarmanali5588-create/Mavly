/**
 * ═══ ONE VERIFICATION TICK: RECOVER, CLEAN, CLAIM, ADVANCE ══════════════════
 *
 * A verification is its own durable, leased work item, advanced by ordinary
 * worker ticks. Nothing here waits for a build inside an HTTP request:
 *
 *   new       preparing → upload → start install (detached) → release
 *   continue  reconnect → read the stage marker → start the next stage,
 *             stay pending, or write the terminal result
 *   runtime   build exit 0 → start `next start` (detached) → poll a
 *             sandbox-local health request → only then `passed`
 *   repair    a repairable failure → destroy → bounded AI repair → a NEW
 *             immutable snapshot → requeue; the project is never edited
 *
 * ⚠️ A PASSING BUILD IS NOT A PASSING RUNTIME. `passed` requires build,
 * runtime and a 2xx/3xx sandbox-local response. No public preview URL is ever
 * minted: the provider's `domain()` is unauthenticated and there is no proxy.
 *
 * ⚠️ THE SANDBOX REFERENCE IS PERSISTED BEFORE ANY UNTRUSTED COMMAND RUNS.
 * Recovery can therefore always tell "there is a live microVM for this row"
 * from "nothing was created", and never starts a second one for the same row.
 *
 * ⚠️ CLEANUP DOES NOT DECIDE THE OUTCOME. The sandbox is destroyed before the
 * terminal write; a cleanup failure sets `cleanup_complete = false` and leaves
 * the build result intact for the durable orphan queue.
 *
 * ⚠️ NO GENERATED CODE RUNS OUTSIDE THE PROVIDER. There is no local fallback:
 * a misconfigured adapter yields a typed failure, never a build on Mavly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { isAiConfigured } from "@/lib/ai/provider";
import { createSnapshot, getSnapshot, hashSource, isSnapshotFailure } from "@/lib/mavly/snapshots";
import { emitVerificationEvent } from "@/lib/observability/events";

import {
  isSandboxOk,
  sandboxIdSafe,
  type SandboxAdapter,
  type SandboxError,
  type SandboxSession,
} from "./adapter";
import { verificationSandboxConfig, type VerificationSandboxConfig } from "./config";
import {
  BUILD_EXIT_MARKER,
  BUILD_LOG_MARKER,
  INSTALL_EXIT_MARKER,
  INSTALL_LOG_MARKER,
  RUNTIME_EXIT_MARKER,
  RUNTIME_LOG_MARKER,
  classifyRuntimeStartFailure,
  classifyStageFailure,
  detachedRuntimeScript,
  detachedStageScript,
  encodeVerificationFiles,
  isHealthyHttpStatus,
  parseHealthOutput,
  prepareVerification,
  runtimeHealthCommand,
  sanitizeDiagnostics,
  summarizeDiagnostics,
  verificationNetworkPolicy,
  verificationStageEnv,
  type VerificationBundle,
} from "./policy";
import { sandboxAdapterFor } from "./provider";
import {
  applyRepair,
  editableRepairPaths,
  generateRepair,
  mergedRepairWithinBounds,
  repairAllowedFor,
  selectRepairContext,
} from "./repair";
import {
  VERIFICATION_BUILD_TIMEOUT_MS,
  VERIFICATION_HEALTH_REQUEST_TIMEOUT_MS,
  VERIFICATION_INSTALL_TIMEOUT_MS,
  VERIFICATION_RUNTIME_TIMEOUT_MS,
  VERIFICATION_SESSION_TIMEOUT_MS,
  isTerminalStage,
  type VerificationErrorClass,
  type VerificationStage,
} from "./state";
import {
  beginVerificationRepair,
  claimVerification,
  claimVerificationCleanup,
  clearVerificationSandbox,
  completeVerification,
  finishVerificationRepair,
  markVerificationCleanup,
  noteVerificationStage,
  recoverVerificationLeases,
  releaseVerification,
  renewVerificationLease,
  verificationSchemaVersion,
  type TerminalVerificationStage,
  type VerificationRecord,
} from "./store";

/** The schema marker migration 19 installs. */
export const VERIFICATION_SCHEMA_VERSION = 19;

/**
 * One verification tick never spends more than this. The remaining invocation
 * budget is reserved for orchestration and the generation worker.
 */
const TICK_BUDGET_MS = 200_000;
/** A cleanup needs headroom for its own provider call. */
const CLEANUP_BUDGET_MS = 40_000;
/** Poll the stage marker at least this long before declaring a timeout. */
const STAGE_TIMEOUT_GRACE_MS = 30_000;

const PENDING_MARKER = "__mavly_pending__";

export type VerificationTickStatus =
  | "empty"
  | "advanced"
  | "completed"
  | "cleanup"
  | "unavailable"
  | "error";

export interface VerificationTickResult {
  status: VerificationTickStatus;
  verificationId?: string;
  outcome?: TerminalVerificationStage;
  reason?: string;
  recovered?: number;
  cleaned?: number;
}

export interface VerificationTickOptions {
  client: SupabaseClient;
  workerId: string;
  config?: VerificationSandboxConfig;
  /** Injectable for tests and for a provider selected outside configuration. */
  adapter?: SandboxAdapter | null;
  now?: () => number;
}

export async function runVerificationTick(
  options: VerificationTickOptions,
): Promise<VerificationTickResult> {
  const startedAtMs = (options.now ?? Date.now)();
  const now = options.now ?? Date.now;
  const remaining = (): number => TICK_BUDGET_MS - (now() - startedAtMs);

  const config = options.config ?? verificationSandboxConfig();
  if (!config.requested) {
    return { status: "unavailable", reason: "disabled" };
  }
  if (!config.ready || !config.provider) {
    return unavailable(options.workerId, config.problems[0] ?? "misconfigured");
  }

  const adapter = options.adapter ?? sandboxAdapterFor(config);
  if (!adapter) return unavailable(options.workerId, "provider_not_available");

  /**
   * ⚠️ PREFLIGHT BEFORE ANY CLAIM. A worker against a database without
   * migration 17 must not claim work it cannot finish or write a status.
   */
  const schema = await verificationSchemaVersion(options.client);
  if (schema === null || schema < VERIFICATION_SCHEMA_VERSION) {
    return unavailable(options.workerId, "schema_outdated");
  }

  const recovered = await recoverExpired(options);
  const cleaned = remaining() > CLEANUP_BUDGET_MS
    ? await cleanupOrphans(options, adapter, remaining)
    : 0;

  if (remaining() < 30_000) {
    return {
      status: cleaned > 0 ? "cleanup" : "empty",
      recovered,
      cleaned,
    };
  }

  const claim = await claimVerification(
    options.client,
    options.workerId,
    config.cohort,
  );
  if (!claim.ok) {
    emitVerificationEvent("verification.error", {
      workerId: options.workerId,
      reason: "claim_failed",
    });
    return { status: "error", reason: "claim_failed", recovered, cleaned };
  }
  if (claim.status === "empty") {
    return {
      status: cleaned > 0 ? "cleanup" : "empty",
      recovered,
      cleaned,
    };
  }

  const record = claim.verification;
  emitVerificationEvent("verification.claimed", {
    traceId: record.correlationId,
    runId: record.runId,
    projectId: record.projectId,
    verificationId: record.id,
    snapshotId: record.snapshotId,
    workerId: options.workerId,
    provider: record.provider ?? adapter.provider,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    stage: record.stage,
    status: claim.mode,
  });

  const result =
    claim.mode === "new"
      ? await startVerification(options, adapter, record)
      : await continueVerification(options, adapter, record);

  return { ...result, recovered, cleaned };
}

function unavailable(workerId: string, reason: string): VerificationTickResult {
  emitVerificationEvent("verification.unavailable", {
    workerId,
    reason: reason.slice(0, 80),
  });
  return { status: "unavailable", reason };
}

// ── Recovery and orphan cleanup ─────────────────────────────────────────────

async function recoverExpired(options: VerificationTickOptions): Promise<number> {
  const recovered = await recoverVerificationLeases(options.client, 5);
  if (!recovered.ok) {
    emitVerificationEvent("verification.error", {
      workerId: options.workerId,
      reason: "recovery_failed",
    });
    return 0;
  }

  for (const entry of recovered.recovered) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    emitVerificationEvent("verification.recovered", {
      verificationId: typeof row.verificationId === "string" ? row.verificationId : null,
      workerId: options.workerId,
      status: typeof row.outcome === "string" ? row.outcome : null,
    });
  }

  return recovered.recovered.length;
}

async function cleanupOrphans(
  options: VerificationTickOptions,
  adapter: SandboxAdapter,
  remaining: () => number,
): Promise<number> {
  const claimed = await claimVerificationCleanup(options.client, 2);
  if (!claimed.ok) {
    emitVerificationEvent("verification.error", {
      workerId: options.workerId,
      reason: "cleanup_claim_failed",
    });
    return 0;
  }

  let cleaned = 0;
  for (const candidate of claimed.candidates) {
    if (remaining() < CLEANUP_BUDGET_MS) break;
    if (candidate.provider && candidate.provider !== adapter.provider) {
      emitVerificationEvent("verification.cleanup", {
        verificationId: candidate.verificationId,
        workerId: options.workerId,
        provider: adapter.provider,
        attempt: candidate.cleanupAttempts,
        status: "failed",
        reason: "provider_mismatch",
      });
      continue;
    }

    const destroyed = await adapter.destroy({
      id: candidate.sandboxId,
      provider: adapter.provider,
    });
    const confirmed = destroyed.ok;
    await markVerificationCleanup(
      options.client,
      candidate.verificationId,
      confirmed,
    );
    if (confirmed) cleaned += 1;

    emitVerificationEvent("verification.cleanup", {
      verificationId: candidate.verificationId,
      workerId: options.workerId,
      provider: adapter.provider,
      attempt: candidate.cleanupAttempts,
      status: confirmed ? "confirmed" : "failed",
      cleanupComplete: confirmed,
    });
  }

  return cleaned;
}

// ── New verification ────────────────────────────────────────────────────────

async function startVerification(
  options: VerificationTickOptions,
  adapter: SandboxAdapter,
  record: VerificationRecord,
): Promise<VerificationTickResult> {
  const leaseToken = record.leaseToken;
  if (!leaseToken) return missingLease(record);

  const resolved = await resolveBundle(options.client, record);
  if (resolved.ok === false) {
    return finalize(options, adapter, record, {
      stage: resolved.stage,
      errorClass: resolved.errorClass,
      summary: resolved.summary,
      rawDiagnostics: resolved.diagnostics.join("\n"),
      exitCode: null,
      session: null,
    });
  }
  const bundle = resolved.bundle;

  const created = await adapter.create({
    image: bundle.plan.nodeImage,
    timeoutMs: VERIFICATION_SESSION_TIMEOUT_MS,
    env: verificationStageEnv(),
    network: verificationNetworkPolicy(),
  });
  if (!isSandboxOk(created)) {
    const mapped = mapSandboxFailure(created.error, "sandbox_create_failed");
    return finalize(options, adapter, record, {
      ...mapped,
      summary: "The isolated sandbox could not be created.",
      exitCode: null,
      session: null,
    });
  }

  const session = created.value;
  if (!sandboxIdSafe(session.id)) {
    const discarded = await adapter.destroy(session);
    emitVerificationEvent("verification.cleanup", {
      traceId: record.correlationId,
      verificationId: record.id,
      workerId: options.workerId,
      provider: adapter.provider,
      status: discarded.ok ? "confirmed" : "failed",
      cleanupComplete: discarded.ok,
    });
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The sandbox provider returned an unusable sandbox reference.",
      exitCode: null,
      session: null,
      sandboxAbsent: true,
    });
  }

  // The reference must be durable before the first untrusted byte is uploaded.
  const renewed = await renew(options.client, record);
  if (renewed === "lost") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The verification lease was lost before the upload.",
      exitCode: null,
      session,
      leaseLost: true,
    });
  }
  if (renewed === "error") {
    await adapter.destroy(session);
    emitVerificationEvent("verification.error", {
      traceId: record.correlationId,
      verificationId: record.id,
      workerId: options.workerId,
      reason: "lease_renew_failed",
    });
    return { status: "error", verificationId: record.id, reason: "lease_renew_failed" };
  }

  const prepared = await noteStage(options.client, record, "preparing", session.id);
  if (prepared !== "noted") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The sandbox could not be attached to the verification.",
      exitCode: null,
      session,
      leaseLost: prepared === "lost",
    });
  }
  /** The row now records the sandbox; terminal writes must see that reference. */
  const owned = withSandbox(record, session.id);

  const uploaded = await adapter.upload(session, encodeVerificationFiles(bundle.files));
  if (!isSandboxOk(uploaded)) {
    const mapped = mapSandboxFailure(uploaded.error, "upload_failed");
    return finalize(options, adapter, owned, {
      ...mapped,
      summary: "The project files could not be uploaded to the isolated sandbox.",
      exitCode: null,
      session,
    });
  }

  const renewedAgain = await renew(options.client, owned);
  if (renewedAgain === "lost") {
    return finalize(options, adapter, owned, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The verification lease was lost before install started.",
      exitCode: null,
      session,
      leaseLost: true,
    });
  }

  const installing = await noteStage(options.client, owned, "installing");
  if (installing !== "noted") {
    return finalize(options, adapter, owned, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The install stage could not be recorded.",
      exitCode: null,
      session,
      leaseLost: installing === "lost",
    });
  }

  const started = await adapter.startDetached(
    session,
    detachedStageScript("install", bundle.plan),
  );
  if (!isSandboxOk(started)) {
    const mapped = mapSandboxFailure(started.error, "provider_error");
    return finalize(options, adapter, owned, {
      ...mapped,
      summary: "The isolated sandbox could not start dependency installation.",
      exitCode: null,
      session,
    });
  }

  emitVerificationEvent("verification.stage", {
    traceId: record.correlationId,
    runId: record.runId,
    projectId: record.projectId,
    verificationId: record.id,
    workerId: options.workerId,
    provider: adapter.provider,
    stage: "installing",
    status: "started",
  });

  await pause(options.client, owned);
  return { status: "advanced", verificationId: record.id, reason: "installing" };
}

// ── Continuation of a detached stage ────────────────────────────────────────

async function continueVerification(
  options: VerificationTickOptions,
  adapter: SandboxAdapter,
  record: VerificationRecord,
): Promise<VerificationTickResult> {
  const sandboxId = record.sandboxId;
  if (!sandboxId || !sandboxIdSafe(sandboxId)) {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The verification has no usable sandbox reference.",
      exitCode: null,
      session: null,
    });
  }

  const opened = await adapter.reconnect(sandboxId);
  if (!isSandboxOk(opened)) {
    if (opened.error.code === "not_found") {
      return finalize(options, adapter, record, {
        stage: "infrastructure_error",
        errorClass: "sandbox_not_found",
        summary:
          "The sandbox was gone before a result was recorded. Its build outcome is unknown.",
        exitCode: null,
        session: null,
        sandboxAbsent: true,
      });
    }
    await pause(options.client, record);
    emitVerificationEvent("verification.error", {
      traceId: record.correlationId,
      verificationId: record.id,
      workerId: options.workerId,
      reason: "reconnect_failed",
    });
    return { status: "advanced", verificationId: record.id, reason: "reconnect_failed" };
  }
  const session = opened.value;

  /**
   * ⚠️ A SANDBOX IN `preparing` IS AMBIGUOUS. The previous tick may have died
   * between create and upload, or between upload and the install note. Never
   * start a second install in an unknown state; stop it and clean it up.
   */
  if (record.stage === "preparing") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary:
        "The verification was interrupted before dependency installation was confirmed started.",
      exitCode: null,
      session,
    });
  }

  const resolved = await resolveBundle(options.client, record);
  if (resolved.ok === false) {
    return finalize(options, adapter, record, {
      stage: resolved.stage,
      errorClass: resolved.errorClass,
      summary: resolved.summary,
      rawDiagnostics: resolved.diagnostics.join("\n"),
      exitCode: null,
      session,
    });
  }
  const bundle = resolved.bundle;

  if (record.stage === "installing") {
    return pollInstall(options, adapter, record, session, bundle);
  }
  if (record.stage === "building") {
    return pollBuild(options, adapter, record, session, bundle);
  }
  if (record.stage === "runtime_starting" || record.stage === "health_checking") {
    return pollRuntime(options, adapter, record, session, bundle);
  }

  // A terminal stage is never claimed by the SQL function; this is defensive.
  return finalize(options, adapter, record, {
    stage: "infrastructure_error",
    errorClass: "internal_error",
    summary: "The verification is in an unexpected stage.",
    exitCode: null,
    session,
  });
}

async function pollInstall(
  options: VerificationTickOptions,
  adapter: SandboxAdapter,
  record: VerificationRecord,
  session: SandboxSession,
  bundle: VerificationBundle,
): Promise<VerificationTickResult> {
  const marker = await readExitMarker(adapter, session, INSTALL_EXIT_MARKER);
  if (!marker.ok) {
    return pauseAfterPollFailure(options, record, "install_marker_unreadable");
  }
  if (marker.kind === "corrupt") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The dependency-install result could not be read.",
      exitCode: null,
      session,
    });
  }

  if (marker.kind === "pending") {
    if (!stageTimedOut(record, VERIFICATION_INSTALL_TIMEOUT_MS, options.now)) {
      await pause(options.client, record);
      return { status: "advanced", verificationId: record.id, reason: "installing" };
    }

    const log = await readStageLog(adapter, session, INSTALL_LOG_MARKER);
    return finalize(options, adapter, record, {
      stage: "timed_out",
      errorClass: "timeout",
      summary: "Dependency installation exceeded its time limit.",
      rawDiagnostics: log,
      exitCode: null,
      session,
    });
  }

  if (marker.exitCode !== 0) {
    const log = await readStageLog(adapter, session, INSTALL_LOG_MARKER);
    const sanitized = sanitizeDiagnostics(log);
    return finalize(options, adapter, record, {
      stage: "failed",
      errorClass: classifyStageFailure("install", sanitized),
      summary: `Dependency installation failed (exit ${marker.exitCode}).`,
      rawDiagnostics: log,
      exitCode: marker.exitCode,
      session,
    });
  }

  // Install succeeded. Record the stage before starting, so a crash between
  // these two writes can never lead to a second install command.
  const renewed = await renew(options.client, record);
  if (renewed === "lost") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The verification lease was lost before the build started.",
      exitCode: null,
      session,
      leaseLost: true,
    });
  }

  const building = await noteStage(options.client, record, "building");
  if (building !== "noted") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The build stage could not be recorded.",
      exitCode: null,
      session,
      leaseLost: building === "lost",
    });
  }

  const started = await adapter.startDetached(
    session,
    detachedStageScript("build", bundle.plan),
  );
  if (!isSandboxOk(started)) {
    const mapped = mapSandboxFailure(started.error, "provider_error");
    return finalize(options, adapter, record, {
      ...mapped,
      summary: "The isolated sandbox could not start the production build.",
      exitCode: null,
      session,
    });
  }

  emitVerificationEvent("verification.stage", {
    traceId: record.correlationId,
    runId: record.runId,
    projectId: record.projectId,
    verificationId: record.id,
    workerId: options.workerId,
    provider: adapter.provider,
    stage: "building",
    status: "started",
  });

  await pause(options.client, record);
  return { status: "advanced", verificationId: record.id, reason: "building" };
}

async function pollBuild(
  options: VerificationTickOptions,
  adapter: SandboxAdapter,
  record: VerificationRecord,
  session: SandboxSession,
  bundle: VerificationBundle,
): Promise<VerificationTickResult> {
  const marker = await readExitMarker(adapter, session, BUILD_EXIT_MARKER);
  if (!marker.ok) {
    return pauseAfterPollFailure(options, record, "build_marker_unreadable");
  }
  if (marker.kind === "corrupt") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The production-build result could not be read.",
      exitCode: null,
      session,
    });
  }

  if (marker.kind === "pending") {
    if (!stageTimedOut(record, VERIFICATION_BUILD_TIMEOUT_MS, options.now)) {
      await pause(options.client, record);
      return { status: "advanced", verificationId: record.id, reason: "building" };
    }

    const log = await readStageLog(adapter, session, BUILD_LOG_MARKER);
    return finalize(options, adapter, record, {
      stage: "timed_out",
      errorClass: "timeout",
      summary: "The production build exceeded its time limit.",
      rawDiagnostics: log,
      exitCode: null,
      session,
    });
  }

  if (marker.exitCode !== 0) {
    const log = await readStageLog(adapter, session, BUILD_LOG_MARKER);
    const sanitized = sanitizeDiagnostics(log);
    return finalizeRepairable(options, adapter, record, session, bundle, {
      stage: "failed",
      errorClass: classifyStageFailure("build", sanitized),
      summary: `The production build failed (exit ${marker.exitCode}).`,
      rawDiagnostics: log,
      exitCode: marker.exitCode,
      session,
      buildPassed: false,
      runtimeProfile: bundle.plan.profile,
      runtimePort: bundle.plan.runtimePort,
    });
  }

  // ⚠️ A PASSING BUILD IS NOT A PASSING RUNTIME. Start the validated runtime
  // and leave the row non-terminal until a sandbox-local health check answers.
  return startRuntime(options, adapter, record, session, bundle);
}

// ── Runtime launch and health ───────────────────────────────────────────────

async function startRuntime(
  options: VerificationTickOptions,
  adapter: SandboxAdapter,
  record: VerificationRecord,
  session: SandboxSession,
  bundle: VerificationBundle,
): Promise<VerificationTickResult> {
  const renewed = await renew(options.client, record);
  if (renewed === "lost") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The verification lease was lost before the runtime started.",
      exitCode: null,
      session,
      leaseLost: true,
      buildPassed: true,
      runtimeProfile: bundle.plan.profile,
      runtimePort: bundle.plan.runtimePort,
    });
  }

  const starting = await noteStage(options.client, record, "runtime_starting");
  if (starting !== "noted") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The runtime stage could not be recorded.",
      exitCode: null,
      session,
      leaseLost: starting === "lost",
      buildPassed: true,
      runtimeProfile: bundle.plan.profile,
      runtimePort: bundle.plan.runtimePort,
    });
  }

  const started = await adapter.startDetached(
    session,
    detachedRuntimeScript(bundle.plan),
  );
  if (!isSandboxOk(started)) {
    const mapped = mapSandboxFailure(started.error, "provider_error");
    return finalize(options, adapter, record, {
      ...mapped,
      summary: "The isolated sandbox could not start the production runtime.",
      exitCode: null,
      session,
      buildPassed: true,
      runtimeProfile: bundle.plan.profile,
      runtimePort: bundle.plan.runtimePort,
    });
  }

  emitVerificationEvent("verification.runtime", {
    traceId: record.correlationId,
    runId: record.runId,
    projectId: record.projectId,
    verificationId: record.id,
    workerId: options.workerId,
    provider: adapter.provider,
    stage: "runtime_starting",
    status: "started",
    runtimePort: bundle.plan.runtimePort,
  });

  await pause(options.client, record);
  return { status: "advanced", verificationId: record.id, reason: "runtime_starting" };
}

async function pollRuntime(
  options: VerificationTickOptions,
  adapter: SandboxAdapter,
  record: VerificationRecord,
  session: SandboxSession,
  bundle: VerificationBundle,
): Promise<VerificationTickResult> {
  const command = runtimeHealthCommand(bundle.plan, VERIFICATION_HEALTH_REQUEST_TIMEOUT_MS);
  const health = await adapter.exec(session, command.cmd, command.args);
  if (!health.ok) {
    return pauseAfterPollFailure(options, record, "health_check_unreadable");
  }

  const observation = parseHealthOutput(health.value.stdout);
  if (observation.kind === "status") {
    if (isHealthyHttpStatus(observation.status)) {
      // Record the health stage only when it succeeded; a failure is terminal.
      await noteStage(options.client, record, "health_checking");
      emitVerificationEvent("verification.health", {
        traceId: record.correlationId,
        runId: record.runId,
        projectId: record.projectId,
        verificationId: record.id,
        workerId: options.workerId,
        provider: adapter.provider,
        stage: "health_checking",
        status: "healthy",
        runtimePort: bundle.plan.runtimePort,
        healthHttpStatus: observation.status,
      });
      return finalize(options, adapter, record, {
        stage: "passed",
        errorClass: null,
        summary:
          "The production build passed and the runtime answered a local health check.",
        exitCode: 0,
        session,
        buildPassed: true,
        runtimeStarted: true,
        healthPassed: true,
        healthChecked: true,
        healthHttpStatus: observation.status,
        runtimeProfile: bundle.plan.profile,
        runtimePort: bundle.plan.runtimePort,
      });
    }

    const log = await readStageLog(adapter, session, RUNTIME_LOG_MARKER);
    return finalizeRepairable(options, adapter, record, session, bundle, {
      stage: "failed",
      errorClass: "health_check_failed",
      summary: `The runtime answered the health check with HTTP ${observation.status}.`,
      rawDiagnostics: log,
      exitCode: null,
      session,
      buildPassed: true,
      runtimeStarted: true,
      healthPassed: false,
      healthChecked: true,
      healthHttpStatus: observation.status,
      runtimeProfile: bundle.plan.profile,
      runtimePort: bundle.plan.runtimePort,
    });
  }

  // No usable answer yet. A runtime that already exited is a real failure; a
  // missing response before the deadline is still an in-progress startup.
  const marker = await readExitMarker(adapter, session, RUNTIME_EXIT_MARKER);
  if (!marker.ok) {
    return pauseAfterPollFailure(options, record, "runtime_marker_unreadable");
  }
  if (marker.kind === "corrupt") {
    return finalize(options, adapter, record, {
      stage: "infrastructure_error",
      errorClass: "internal_error",
      summary: "The runtime result could not be read.",
      exitCode: null,
      session,
      buildPassed: true,
      runtimeProfile: bundle.plan.profile,
      runtimePort: bundle.plan.runtimePort,
    });
  }
  if (marker.kind === "exit") {
    const log = await readStageLog(adapter, session, RUNTIME_LOG_MARKER);
    const sanitized = sanitizeDiagnostics(log);
    if (marker.exitCode !== 0) {
      return finalizeRepairable(options, adapter, record, session, bundle, {
        stage: "failed",
        errorClass: classifyRuntimeStartFailure(sanitized),
        summary: `The production runtime exited before serving (exit ${marker.exitCode}).`,
        rawDiagnostics: log,
        exitCode: null,
        session,
        buildPassed: true,
        runtimeStarted: false,
        healthPassed: false,
        healthChecked: true,
        runtimeExitCode: marker.exitCode,
        runtimeProfile: bundle.plan.profile,
        runtimePort: bundle.plan.runtimePort,
      });
    }
    return finalizeRepairable(options, adapter, record, session, bundle, {
      stage: "failed",
      errorClass: "runtime_exited",
      summary: "The production runtime exited before answering a health check.",
      rawDiagnostics: log,
      exitCode: null,
      session,
      buildPassed: true,
      runtimeStarted: false,
      healthPassed: false,
      healthChecked: true,
      runtimeExitCode: 0,
      runtimeProfile: bundle.plan.profile,
      runtimePort: bundle.plan.runtimePort,
    });
  }

  if (!stageTimedOut(record, VERIFICATION_RUNTIME_TIMEOUT_MS, options.now)) {
    await pause(options.client, record);
    return { status: "advanced", verificationId: record.id, reason: "runtime_starting" };
  }

  const log = await readStageLog(adapter, session, RUNTIME_LOG_MARKER);
  return finalize(options, adapter, record, {
    stage: "timed_out",
    errorClass: "timeout",
    summary: "The production runtime did not become ready within its time limit.",
    rawDiagnostics: log,
    exitCode: null,
    session,
    buildPassed: true,
    runtimeStarted: false,
    healthPassed: false,
    healthChecked: true,
    runtimeProfile: bundle.plan.profile,
    runtimePort: bundle.plan.runtimePort,
  });
}

// ── Reading stage markers ───────────────────────────────────────────────────

type MarkerRead =
  | { ok: true; kind: "pending" }
  | { ok: true; kind: "exit"; exitCode: number }
  | { ok: true; kind: "corrupt" }
  | { ok: false };

/**
 * The detached script writes its exit status to a file because the provider
 * cannot reattach to a detached command. A missing file is "still running".
 */
async function readExitMarker(
  adapter: SandboxAdapter,
  session: SandboxSession,
  marker: string,
): Promise<MarkerRead> {
  const result = await adapter.exec(session, "sh", [
    "-c",
    `if [ -f ${marker} ]; then cat ${marker}; else printf '%s' '${PENDING_MARKER}'; fi`,
  ]);
  if (!result.ok) return { ok: false };

  const value = result.value.stdout.trim();
  if (!value || value === PENDING_MARKER) return { ok: true, kind: "pending" };
  if (!/^-?\d{1,3}$/.test(value)) return { ok: true, kind: "corrupt" };
  return { ok: true, kind: "exit", exitCode: Number.parseInt(value, 10) };
}

async function readStageLog(
  adapter: SandboxAdapter,
  session: SandboxSession,
  marker: string,
): Promise<string> {
  const result = await adapter.exec(session, "sh", [
    "-c",
    `tail -c 6000 ${marker} 2>/dev/null || true`,
  ]);
  if (!result.ok) return "";
  return result.value.stdout;
}

async function pauseAfterPollFailure(
  options: VerificationTickOptions,
  record: VerificationRecord,
  reason: string,
): Promise<VerificationTickResult> {
  await pause(options.client, record);
  emitVerificationEvent("verification.error", {
    traceId: record.correlationId,
    verificationId: record.id,
    workerId: options.workerId,
    reason,
  });
  return { status: "advanced", verificationId: record.id, reason };
}

// ── Terminal write ──────────────────────────────────────────────────────────

interface FinalizeInput {
  stage: TerminalVerificationStage;
  errorClass: VerificationErrorClass | null;
  summary: string | null;
  rawDiagnostics?: string | null;
  exitCode: number | null;
  session: SandboxSession | null;
  /** The provider already reported the sandbox absent; no delete is needed. */
  sandboxAbsent?: boolean;
  /** Another owner or a cancellation won the row; only cleanup is recorded. */
  leaseLost?: boolean;
  // ── Phase 4: what actually succeeded, kept separate from the outcome ──
  buildPassed?: boolean | null;
  runtimeStarted?: boolean | null;
  healthPassed?: boolean | null;
  healthChecked?: boolean;
  runtimeExitCode?: number | null;
  healthHttpStatus?: number | null;
  runtimePort?: number | null;
  runtimeProfile?: string | null;
}

async function finalize(
  options: VerificationTickOptions,
  adapter: SandboxAdapter,
  record: VerificationRecord,
  input: FinalizeInput,
): Promise<VerificationTickResult> {
  const leaseToken = record.leaseToken;
  if (!leaseToken) return missingLease(record);

  const sanitized = sanitizeDiagnostics(input.rawDiagnostics);
  const summary = (input.summary ?? summarizeDiagnostics(sanitized))?.slice(0, 400) ?? null;

  /**
   * Renew before cleanup: deletion is a provider round trip and the terminal
   * write must still be fenced to this tick.
   */
  let leaseLost = input.leaseLost === true;
  if (!leaseLost) {
    const renewed = await renew(options.client, record);
    if (renewed === "lost") leaseLost = true;
  }

  const { cleanupComplete, error: cleanupError } = await destroyForTerminal(
    adapter,
    record,
    input.session,
    input.sandboxAbsent === true,
  );

  emitVerificationEvent("verification.cleanup", {
    traceId: record.correlationId,
    runId: record.runId,
    projectId: record.projectId,
    verificationId: record.id,
    workerId: options.workerId,
    provider: adapter.provider,
    status: cleanupComplete ? "confirmed" : "failed",
    cleanupComplete,
    reason: cleanupError?.code,
  });

  if (leaseLost) {
    if (record.sandboxId) {
      await markVerificationCleanup(options.client, record.id, cleanupComplete);
    }
    emitVerificationEvent("verification.lease_lost", {
      traceId: record.correlationId,
      runId: record.runId,
      verificationId: record.id,
      workerId: options.workerId,
      stage: input.stage,
      cleanupComplete,
    });
    return { status: "advanced", verificationId: record.id, reason: "lease_lost" };
  }

  const completed = await completeVerification(options.client, {
    verificationId: record.id,
    leaseToken,
    status: input.stage,
    exitCode: input.exitCode,
    errorClass: input.errorClass,
    summary,
    diagnostics: sanitized.lines,
    diagnosticsTruncated: sanitized.truncated,
    partial: false,
    cleanupComplete,
    buildPassed: input.buildPassed ?? null,
    runtimeStarted: input.runtimeStarted ?? null,
    healthPassed: input.healthPassed ?? null,
    healthChecked: input.healthChecked ?? false,
    runtimeExitCode: input.runtimeExitCode ?? null,
    healthHttpStatus: input.healthHttpStatus ?? null,
    runtimePort: input.runtimePort ?? null,
    runtimeProfile: input.runtimeProfile ?? null,
  });

  if (!completed.ok) {
    emitVerificationEvent("verification.error", {
      traceId: record.correlationId,
      verificationId: record.id,
      workerId: options.workerId,
      reason: "complete_failed",
    });
    return { status: "error", verificationId: record.id, reason: "complete_failed" };
  }

  if (completed.status === "not_found") {
    return { status: "error", verificationId: record.id, reason: "not_found" };
  }

  if (completed.status === "lease_lost") {
    if (record.sandboxId) {
      await markVerificationCleanup(options.client, record.id, cleanupComplete);
    }
    emitVerificationEvent("verification.lease_lost", {
      traceId: record.correlationId,
      runId: record.runId,
      verificationId: record.id,
      workerId: options.workerId,
      stage: input.stage,
      cleanupComplete,
    });
    return { status: "advanced", verificationId: record.id, reason: "lease_lost" };
  }

  /**
   * A duplicate completion must report the outcome the database already holds,
   * not the one this tick happened to compute. The public status already reads
   * the row; the worker response should not disagree with it.
   */
  let outcome: TerminalVerificationStage = input.stage;
  if (completed.status === "already_terminal") {
    const stored = completed.verification.stage;
    if (isTerminalStage(stored)) outcome = stored as TerminalVerificationStage;

    if (record.sandboxId) {
      // A cancellation or another attempt finished first. The sandbox this tick
      // destroyed is still evidence for the cleanup queue.
      await markVerificationCleanup(options.client, record.id, cleanupComplete);
    }
  }

  emitVerificationEvent("verification.completed", {
    traceId: record.correlationId,
    runId: record.runId,
    projectId: record.projectId,
    verificationId: record.id,
    snapshotId: record.effectiveSnapshotId ?? record.snapshotId,
    workerId: options.workerId,
    provider: adapter.provider,
    stage: outcome,
    status: completed.status,
    exitCode: input.exitCode,
    errorClass: input.errorClass,
    durationMs: durationMs(record, options.now),
    cleanupComplete,
  });

  return {
    status: "completed",
    verificationId: record.id,
    outcome,
  };
}

const REPAIR_REJECTION_REASONS = new Set([
  "invalid_json",
  "no_files",
  "too_many_files",
  "invalid_entry",
  "path_not_allowed",
  "empty_file",
  "file_too_large",
  "duplicate_path",
  "unchanged",
]);

/**
 * A failure a bounded AI repair may try to fix.
 *
 * ⚠️ CLEANUP BEFORE A SECOND SANDBOX. The failed sandbox is destroyed under the
 * current lease, and its reference is cleared only after the provider confirms
 * it is gone. A repair never runs beside the sandbox it is replacing.
 *
 * ⚠️ THE PROJECT IS NEVER REWRITTEN. A successful repair is stored as a new
 * immutable `repair` snapshot and the verification is requeued to build that
 * snapshot. If any step fails, the ORIGINAL outcome is written unchanged.
 */
async function finalizeRepairable(
  options: VerificationTickOptions,
  adapter: SandboxAdapter,
  record: VerificationRecord,
  session: SandboxSession | null,
  bundle: VerificationBundle,
  input: FinalizeInput,
): Promise<VerificationTickResult> {
  const errorClass = input.errorClass;
  if (!errorClass) return finalize(options, adapter, record, input);

  const config = options.config ?? verificationSandboxConfig();
  const persistedBudget = record.repairMaxAttempts > 0 ? record.repairMaxAttempts : 0;
  const maxRepairs =
    config.repairEnabled && isAiConfigured()
      ? Math.min(config.maxRepairs, persistedBudget)
      : 0;

  if (
    !record.leaseToken ||
    !repairAllowedFor(errorClass, record.repairAttempts, maxRepairs)
  ) {
    return finalize(options, adapter, record, input);
  }
  const leaseToken = record.leaseToken;

  const renewed = await renew(options.client, record);
  if (renewed === "lost") {
    return finalize(options, adapter, record, { ...input, leaseLost: true });
  }

  const destroyed = await destroyForTerminal(adapter, record, session, false);
  emitVerificationEvent("verification.cleanup", {
    traceId: record.correlationId,
    runId: record.runId,
    projectId: record.projectId,
    verificationId: record.id,
    workerId: options.workerId,
    provider: adapter.provider,
    status: destroyed.cleanupComplete ? "confirmed" : "failed",
    cleanupComplete: destroyed.cleanupComplete,
    reason: destroyed.error?.code,
  });
  if (record.sandboxId) {
    await markVerificationCleanup(options.client, record.id, destroyed.cleanupComplete);
  }
  if (!destroyed.cleanupComplete) {
    // Two sandboxes must never be live for one verification. Leave the original
    // attempt to the durable orphan queue and report the failure truthfully.
    return finalize(options, adapter, record, { ...input, session: null });
  }

  const cleared = await clearVerificationSandbox(
    options.client,
    record.id,
    leaseToken,
    true,
  );
  const detached: VerificationRecord = { ...record, sandboxId: null };
  if (!cleared.ok || cleared.status !== "cleared") {
    return finalize(options, adapter, detached, {
      ...input,
      session: null,
      sandboxAbsent: true,
    });
  }

  const begun = await beginVerificationRepair(
    options.client,
    record.id,
    leaseToken,
    maxRepairs,
  );
  if (!begun.ok || begun.status !== "begun" || !begun.attempt) {
    if (begun.ok) {
      emitVerificationEvent("verification.repair", {
        traceId: record.correlationId,
        runId: record.runId,
        projectId: record.projectId,
        verificationId: record.id,
        workerId: options.workerId,
        stage: "repairing",
        status: begun.status,
        repairAttempt: record.repairAttempts,
        errorClass,
      });
    }
    return finalize(options, adapter, detached, {
      ...input,
      session: null,
      sandboxAbsent: true,
    });
  }

  const attempt = begun.attempt;
  const sanitized = sanitizeDiagnostics(input.rawDiagnostics);
  const context = selectRepairContext(bundle.files, sanitized.lines);
  /**
   * Only files the model actually saw may be replaced. The context is bounded,
   * so a truncated context also narrows the editable set; a file that was not
   * shown is never replaced blind.
   */
  const allowedPaths = editableRepairPaths(context.files);

  // A fresh lease covers the bounded provider call (~90 s).
  const beforeAi = await renew(options.client, detached);
  if (beforeAi === "lost") {
    return { status: "advanced", verificationId: record.id, reason: "lease_lost" };
  }

  const generated = await generateRepair({
    errorClass,
    summary: input.summary,
    diagnostics: sanitized.lines,
    context,
    allowedPaths,
  });

  const reject = async (
    outcome: "failed" | "rejected",
    reason: string,
  ): Promise<VerificationTickResult> => {
    const finished = await finishVerificationRepair(options.client, {
      verificationId: record.id,
      leaseToken,
      attempt,
      status: outcome,
      errorClass,
      summary: `AI repair ${outcome} (${reason}).`.slice(0, 400),
      model: generated.model,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
      costUsd: generated.costUsd,
      costKnown: generated.costKnown,
    });
    emitVerificationEvent("verification.repair", {
      traceId: record.correlationId,
      runId: record.runId,
      projectId: record.projectId,
      verificationId: record.id,
      workerId: options.workerId,
      stage: "repairing",
      status: finished.ok ? finished.status : outcome,
      repairAttempt: attempt,
      errorClass,
      reason,
      model: generated.model,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
      costUsd: generated.costUsd,
      costKnown: generated.costKnown,
    });

    if (!finished.ok) {
      // The repair row is still `requested`; recovery fails it closed rather
      // than letting two ticks reason about an unknown write.
      return { status: "advanced", verificationId: record.id, reason: "repair_finish_failed" };
    }
    if (finished.status !== "failed" && finished.status !== "rejected") {
      return {
        status: "advanced",
        verificationId: record.id,
        reason: finished.status === "lease_lost" ? "lease_lost" : "repair_not_requested",
      };
    }
    return finalize(options, adapter, detached, {
      ...input,
      summary: `${input.summary ?? "Verification failed."} AI repair did not produce a usable snapshot.`.slice(0, 400),
      session: null,
      sandboxAbsent: true,
    });
  };

  if (!generated.ok) {
    const reason = generated.reason ?? "unavailable";
    return reject(
      REPAIR_REJECTION_REASONS.has(reason) ? "rejected" : "failed",
      reason,
    );
  }

  const merged = applyRepair(bundle.files, generated.files);
  if (!mergedRepairWithinBounds(merged)) {
    return reject("rejected", "out_of_bounds");
  }

  const repairedHash = hashSource(merged);
  if (
    !repairedHash ||
    repairedHash === (record.effectiveSourceHash ?? record.sourceHash)
  ) {
    return reject("rejected", "unchanged");
  }

  const prepared = prepareVerification(merged, repairedHash);
  if (prepared.ok === false) {
    return reject("rejected", "validation_failed");
  }

  const snapshot = await createSnapshot(
    {
      userId: record.userId,
      projectId: record.projectId,
      kind: "repair",
      description: `AI repair attempt ${attempt} for verification ${record.id}`.slice(0, 500),
      files: prepared.bundle.files,
      runId: record.runId,
      changedPaths: generated.files.map((file) => file.path),
    },
    options.client,
  );
  if (!snapshot.ok) {
    return reject("failed", "snapshot_failed");
  }

  const beforeFinish = await renew(options.client, detached);
  if (beforeFinish === "lost") {
    return { status: "advanced", verificationId: record.id, reason: "lease_lost" };
  }

  const finished = await finishVerificationRepair(options.client, {
    verificationId: record.id,
    leaseToken,
    attempt,
    status: "applied",
    repairedSnapshotId: snapshot.data.id,
    repairedHash: snapshot.data.sourceHash,
    errorClass: null,
    summary: `AI repair attempt ${attempt} produced a new immutable snapshot.`.slice(0, 400),
    model: generated.model,
    promptTokens: generated.promptTokens,
    completionTokens: generated.completionTokens,
    costUsd: generated.costUsd,
    costKnown: generated.costKnown,
  });

  emitVerificationEvent("verification.repair", {
    traceId: record.correlationId,
    runId: record.runId,
    projectId: record.projectId,
    verificationId: record.id,
    snapshotId: snapshot.data.id,
    workerId: options.workerId,
    stage: "repairing",
    status: finished.ok ? finished.status : "applied",
    repairAttempt: attempt,
    model: generated.model,
    promptTokens: generated.promptTokens,
    completionTokens: generated.completionTokens,
    costUsd: generated.costUsd,
    costKnown: generated.costKnown,
  });

  if (!finished.ok || finished.status !== "applied") {
    // The attempt is either terminal elsewhere or will be failed closed by
    // recovery. The snapshot stays immutable and addressable for audit.
    return {
      status: "advanced",
      verificationId: record.id,
      reason: finished.ok ? finished.status : "repair_not_applied",
    };
  }

  return { status: "advanced", verificationId: record.id, reason: "repair_applied" };
}

async function destroyForTerminal(
  adapter: SandboxAdapter,
  record: VerificationRecord,
  session: SandboxSession | null,
  alreadyAbsent: boolean,
): Promise<{ cleanupComplete: boolean; error: SandboxError | null }> {
  if (alreadyAbsent) return { cleanupComplete: true, error: null };
  /**
   * A session can exist without a persisted reference when the row could not be
   * attached; it is destroyed either way. Only the persisted reference can be
   * queued for later cleanup, so the absence of both means nothing to clean.
   */
  if (!session && !record.sandboxId) return { cleanupComplete: true, error: null };

  let target = session;
  if (!target && record.sandboxId) {
    const opened = await adapter.reconnect(record.sandboxId);
    if (!isSandboxOk(opened)) {
      return {
        cleanupComplete: opened.error.code === "not_found",
        error: opened.error.code === "not_found" ? null : opened.error,
      };
    }
    target = opened.value;
  }
  if (!target) return { cleanupComplete: true, error: null };

  const destroyed = await adapter.destroy(target);
  if (!isSandboxOk(destroyed)) {
    return { cleanupComplete: false, error: destroyed.error };
  }
  return { cleanupComplete: true, error: null };
}

function mapSandboxFailure(
  error: SandboxError,
  fallback: VerificationErrorClass,
): { stage: TerminalVerificationStage; errorClass: VerificationErrorClass } {
  if (error.code === "timeout") {
    return { stage: "timed_out", errorClass: "timeout" };
  }
  if (
    error.code === "not_configured" ||
    error.code === "not_implemented" ||
    error.code === "invalid_input"
  ) {
    return { stage: "configuration_error", errorClass: "configuration_error" };
  }
  if (error.code === "not_found") {
    return { stage: "infrastructure_error", errorClass: "sandbox_not_found" };
  }
  return { stage: "infrastructure_error", errorClass: fallback };
}

// ── Bundle resolution ───────────────────────────────────────────────────────

type BundleResolution =
  | { ok: true; bundle: VerificationBundle }
  | {
      ok: false;
      stage: Extract<VerificationStage, "unsupported_runtime" | "failed" | "configuration_error">;
      errorClass: VerificationErrorClass;
      summary: string;
      diagnostics: string[];
    };

/**
 * Re-read the immutable snapshot and re-validate it on every tick that touches
 * it. A row whose content no longer hashes to the enqueued value is never run.
 */
async function resolveBundle(
  client: SupabaseClient,
  record: VerificationRecord,
): Promise<BundleResolution> {
  const snapshotId = record.effectiveSnapshotId ?? record.snapshotId;
  const expectedHash = record.effectiveSourceHash ?? record.sourceHash;
  const snapshot = await getSnapshot(record.projectId, snapshotId, client);
  if (isSnapshotFailure(snapshot)) {
    return {
      ok: false,
      stage: "configuration_error",
      errorClass: "validation_failed",
      summary: "The snapshot for this verification is no longer available.",
      diagnostics: [],
    };
  }

  const value = snapshot.data;
  if (value.runId !== record.runId) {
    return {
      ok: false,
      stage: "configuration_error",
      errorClass: "snapshot_mismatch",
      summary: "The snapshot does not belong to this run, so it was not verified.",
      diagnostics: [],
    };
  }
  if (value.status !== "ready") {
    return {
      ok: false,
      stage: "configuration_error",
      errorClass: "validation_failed",
      summary: "The snapshot is not in a ready state, so it was not verified.",
      diagnostics: [],
    };
  }

  const prepared = prepareVerification(value.files, expectedHash);
  if (prepared.ok === false) {
    return {
      ok: false,
      stage: prepared.stage,
      errorClass: prepared.errorClass,
      summary: prepared.summary,
      diagnostics: prepared.diagnostics,
    };
  }
  return { ok: true, bundle: prepared.bundle };
}

// ── Small helpers ───────────────────────────────────────────────────────────

type StageNote = "noted" | "lost" | "error";

function withSandbox(
  record: VerificationRecord,
  sandboxId: string,
): VerificationRecord {
  return { ...record, sandboxId };
}

async function noteStage(
  client: SupabaseClient,
  record: VerificationRecord,
  status: "preparing" | "installing" | "building" | "runtime_starting" | "health_checking",
  sandboxId?: string,
): Promise<StageNote> {
  if (!record.leaseToken) return "error";
  const noted = await noteVerificationStage(client, {
    verificationId: record.id,
    leaseToken: record.leaseToken,
    status,
    sandboxId: sandboxId ?? null,
  });
  if (!noted.ok) return "error";
  return noted.status === "lost" ? "lost" : "noted";
}

async function renew(
  client: SupabaseClient,
  record: VerificationRecord,
): Promise<"ok" | "lost" | "error"> {
  if (!record.leaseToken) return "error";
  const renewed = await renewVerificationLease(client, record.id, record.leaseToken);
  if (!renewed.ok) return "error";
  return renewed.status === "renewed" ? "ok" : "lost";
}

async function pause(
  client: SupabaseClient,
  record: VerificationRecord,
): Promise<void> {
  if (!record.leaseToken) return;
  const released = await releaseVerification(client, record.id, record.leaseToken);
  if (!released.ok) {
    emitVerificationEvent("verification.error", {
      traceId: record.correlationId,
      verificationId: record.id,
      reason: "release_failed",
    });
  }
}

function missingLease(record: VerificationRecord): VerificationTickResult {
  emitVerificationEvent("verification.error", {
    verificationId: record.id,
    reason: "missing_lease",
  });
  return { status: "error", verificationId: record.id, reason: "missing_lease" };
}

function stageTimedOut(
  record: VerificationRecord,
  limitMs: number,
  now?: () => number,
): boolean {
  const base = record.stageStartedAt ?? record.startedAt ?? record.enqueuedAt;
  if (!base) return false;
  const started = Date.parse(base);
  if (!Number.isFinite(started)) return false;
  return (now ?? Date.now)() - started > limitMs + STAGE_TIMEOUT_GRACE_MS;
}

function durationMs(record: VerificationRecord, now?: () => number): number | null {
  const base = record.startedAt ?? record.enqueuedAt;
  if (!base) return null;
  const started = Date.parse(base);
  if (!Number.isFinite(started)) return null;
  return Math.max(0, (now ?? Date.now)() - started);
}
