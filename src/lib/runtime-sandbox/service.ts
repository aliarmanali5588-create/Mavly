/**
 * ═══ LIVE RUNTIME SANDBOX SERVICE ══════════════════════════════════════════
 *
 * One bounded lifecycle: authoritative files → isolated E2B sandbox → npm
 * install (no lifecycle scripts) → fixed Vite dev server → server-side readiness
 * → durable `ready`. Stop, expiry and cleanup are idempotent.
 *
 * ⚠️ THE SANDBOX IS NOT A SOURCE OF TRUTH. It is populated from
 * `project_files`; nothing it produces is ever written back to them. A failed
 * sandbox records a truthful failure and is destroyed; it does not change the
 * generation run, its checkpoints, its images or a credit settlement.
 *
 * ⚠️ NO GENERATED CODE RUNS ON A MAVLY HOST. Every command executes inside the
 * provider microVM, and the readiness request is an HTTPS request to the
 * provider's own preview host.
 *
 * ⚠️ DEPENDENCY INJECTION IS THE TEST SEAM. Routes pass the caller's Supabase
 * client; tests pass an in-memory store, a mocked provider and a fake probe.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { emitRuntimeSandboxEvent } from "@/lib/observability/events";

import {
  isProjectInRuntimeCohort,
  runtimeSandboxConfig,
  runtimeProblemSummary,
  type RuntimeSandboxConfig,
} from "./config";
import {
  appendTerminalOutput,
  buildCommand,
  detectRuntimeProject,
  devServerCommand,
  nextDevServerCommand,
  installCommand,
  isReadyStatus,
  previewUrlFromProvider,
  sanitizeTerminalOutput,
  type RuntimeCommand,
} from "./policy";
import {
  planProjectSync,
  sourceHashForFiles,
  syncMissingRequiredFiles,
  RUNTIME_DEV_LOG,
  RUNTIME_PROJECT_DIR,
  type SyncSourceFile,
} from "./paths";

/** Re-exported so callers keep one import; the implementation is pure. */
export { sourceHashForFiles };
import { createRuntimeSandboxProvider } from "./provider";
import {
  createSupabaseRuntimeStore,
  isRuntimeStoreFailure,
  type RuntimeSandboxStore,
  type RuntimeStoreResult,
} from "./store";
import {
  canTransitionRuntimeState,
  isActiveRuntimeState,
  isRuntimeProviderOk,
  runtimeCapabilityReasonMessage,
  type RuntimeCheck,
  type RuntimeProjectSupport,
  type RuntimeSandboxProvider,
  type RuntimeSandboxRecord,
  type RuntimeSandboxState,
  type RuntimeSandboxStatus,
  type RuntimeSandboxView,
} from "./types";
import { runtimeChecksFor } from "./evidence";

export type RuntimeFileLoader = (
  client: SupabaseClient,
  projectId: string,
) => Promise<RuntimeStoreResult<readonly SyncSourceFile[]>>;

export interface ReadinessProbeResult {
  status: number;
}

export type ReadinessProbe = (url: string) => Promise<ReadinessProbeResult | null>;

export interface RuntimeServiceDeps {
  config?: RuntimeSandboxConfig;
  store?: RuntimeSandboxStore;
  provider?: RuntimeSandboxProvider | null;
  loader?: RuntimeFileLoader;
  probe?: ReadinessProbe;
  now?: () => number;
  /** Test seam for the readiness poll interval. */
  pollIntervalMs?: number;
}

export type RuntimeFailureCode =
  | "RUNTIME_SANDBOX_NOT_CONFIGURED"
  | "RUNTIME_SANDBOX_UNSUPPORTED"
  | "RUNTIME_SANDBOX_BUSY"
  | "RUNTIME_SANDBOX_FAILED"
  | "MIGRATION_REQUIRED"
  | "FORBIDDEN";

export interface RuntimeStartOutcome {
  ok: boolean;
  code: RuntimeFailureCode | null;
  message: string | null;
  outcome: "started" | "reused" | "busy" | "stopped" | "already_stopped" | "failed";
  status: RuntimeSandboxStatus | null;
}

async function defaultFileLoader(
  client: SupabaseClient,
  projectId: string,
): Promise<RuntimeStoreResult<readonly SyncSourceFile[]>> {
  const { listFiles } = await import("@/lib/mavly/store");
  const files = await listFiles(projectId, client);
  if (files.ok === false) {
    return { ok: false, error: files.error, code: files.code };
  }
  return {
    ok: true,
    data: files.data.map((file) => ({ path: file.path, content: file.content })),
  };
}

async function defaultProbe(url: string): Promise<ReadinessProbeResult | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      // A redirect must not turn a validated provider host into an arbitrary URL.
      redirect: "error",
      cache: "no-store",
      headers: { accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(8_000),
    });
    return { status: response.status };
  } catch {
    return null;
  }
}

function toView(record: RuntimeSandboxRecord): RuntimeSandboxView {
  return {
    id: record.id,
    state: record.state,
    framework: record.framework,
    port: record.port,
    previewUrl: record.previewUrl,
    failureCode: record.failureCode,
    failureReason: record.failureReason,
    logs: record.logs,
    checks: runtimeChecksFor(record),
    installMs: record.installMs,
    startupMs: record.startupMs,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastActivityAt: record.lastActivityAt,
    expiresAt: record.expiresAt,
  };
}

export function runtimeSessionView(record: RuntimeSandboxRecord | null): RuntimeSandboxView | null {
  return record ? toView(record) : null;
}

function capabilityOf(input: {
  config: RuntimeSandboxConfig;
  projectId: string;
  projectType: "website" | "android" | null;
  schemaVersion: number | null;
}): RuntimeSandboxStatus["capability"] {
  const unavailable = (reason: string, provider: "e2b" | null = null) => ({
    available: false,
    reason,
    message: runtimeCapabilityReasonMessage(reason),
    provider,
    framework: null,
  });

  if (input.projectType === "android") return unavailable("unsupported_project_type");
  if (!input.config.requested) return unavailable("disabled");
  if (!input.config.ready) {
    return {
      available: false,
      reason: "misconfigured",
      message: runtimeProblemSummary(input.config),
      provider: null,
      framework: null,
    };
  }
  if (!isProjectInRuntimeCohort(input.projectId, input.config)) {
    return unavailable("project_not_enabled", "e2b");
  }
  if (input.schemaVersion === null) return unavailable("migration_required", "e2b");
  return {
    available: true,
    reason: null,
    message: null,
    provider: "e2b",
    framework: "react_vite",
  };
}

interface ServiceContext {
  client: SupabaseClient;
  projectId: string;
  config: RuntimeSandboxConfig;
  store: RuntimeSandboxStore;
  provider: RuntimeSandboxProvider | null;
  loadFiles: RuntimeFileLoader;
  probe: ReadinessProbe;
  now: () => number;
  pollIntervalMs: number;
}

async function contextFor(
  input: { client: SupabaseClient; projectId: string },
  deps: RuntimeServiceDeps,
): Promise<ServiceContext> {
  const config = deps.config ?? runtimeSandboxConfig();
  const provider =
    deps.provider !== undefined
      ? deps.provider
      : await createRuntimeSandboxProvider(config);
  return {
    client: input.client,
    projectId: input.projectId,
    config,
    store: deps.store ?? createSupabaseRuntimeStore(input.client),
    provider,
    loadFiles: deps.loader ?? defaultFileLoader,
    probe: deps.probe ?? defaultProbe,
    now: deps.now ?? (() => Date.now()),
    pollIntervalMs: deps.pollIntervalMs ?? 1_000,
  };
}

function failure(
  code: RuntimeFailureCode,
  message: string,
  status: RuntimeSandboxStatus | null = null,
  outcome: RuntimeStartOutcome["outcome"] = "failed",
): RuntimeStartOutcome {
  return { ok: false, code, message, outcome, status };
}

async function persistFailure(
  ctx: ServiceContext,
  record: RuntimeSandboxRecord,
  failureCode: string,
  reason: string,
  logs: string,
  diagnostics: Record<string, unknown> = {},
): Promise<RuntimeSandboxRecord | null> {
  const updated = await ctx.store.update({
    id: record.id,
    state: "failed",
    failureCode,
    failureReason: reason.slice(0, 300),
    logs: sanitizeTerminalOutput(logs),
    diagnostics: { ...record.diagnostics, ...diagnostics, failedAt: new Date(ctx.now()).toISOString() },
  });

  /**
   * Cleanup is bounded and never overwrites the outcome: a provider that will
   * not delete the sandbox leaves a `cleanup_incomplete` diagnostic, and the
   * expiry sweep is the fallback.
   */
  if (record.sandboxId && ctx.provider) {
    const killed = await ctx.provider.destroy(record.sandboxId);
    if (!isRuntimeProviderOk(killed)) {
      await ctx.store.update({
        id: record.id,
        diagnostics: { ...diagnostics, cleanupIncomplete: true },
      });
    }
  }

  emitRuntimeSandboxEvent("sandbox.start_failed", {
    projectId: ctx.projectId,
    runtimeSandboxId: record.id,
    status: "failed",
    errorClass: failureCode,
  });

  return isRuntimeStoreFailure(updated) ? record : updated.data;
}

async function transition(
  ctx: ServiceContext,
  record: RuntimeSandboxRecord,
  state: RuntimeSandboxState,
): Promise<RuntimeSandboxRecord | null> {
  if (!canTransitionRuntimeState(record.state, state)) {
    console.warn(
      `[runtime-sandbox] refused transition ${record.state} -> ${state} for ${record.id}`,
    );
    return null;
  }
  const updated = await ctx.store.update({ id: record.id, state });
  return isRuntimeStoreFailure(updated) ? null : updated.data;
}

function devPidOf(record: RuntimeSandboxRecord): number | null {
  const value = record.diagnostics.devPid;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

async function runCommand(
  ctx: ServiceContext,
  record: RuntimeSandboxRecord,
  command: RuntimeCommand,
  timeoutMs: number,
): Promise<{
  exitCode: number | null;
  logs: string;
  /** The provider reported a timeout, not a normal non-zero exit. */
  timedOut: boolean;
  /** The command never produced an exit status at all. */
  providerError: boolean;
} | null> {
  if (!record.sandboxId || !ctx.provider) return null;
  const result = await ctx.provider.run(record.sandboxId, {
    ...command,
    timeoutMs,
  });
  if (!isRuntimeProviderOk(result)) {
    return {
      exitCode: null,
      logs: `The provider could not run ${command.command}: ${result.error.message}`,
      timedOut: result.error.code === "timeout",
      providerError: true,
    };
  }
  const logs = sanitizeTerminalOutput(`${result.value.stdout}\n${result.value.stderr}`);
  emitRuntimeSandboxEvent(
    result.value.exitCode === 0 ? "sandbox.install.completed" : "sandbox.command.failed",
    {
      projectId: ctx.projectId,
      runtimeSandboxId: record.id,
      status: result.value.exitCode === 0 ? "completed" : "failed",
      commandMs: result.value.durationMs,
      exitCode: result.value.exitCode ?? -1,
    },
  );
  return {
    exitCode: result.value.exitCode,
    logs,
    timedOut: false,
    providerError: false,
  };
}

async function refreshStoredLogs(
  ctx: ServiceContext,
  record: RuntimeSandboxRecord,
  extra = "",
): Promise<string> {
  let text = extra;
  if (record.sandboxId && ctx.provider) {
    const read = await ctx.provider.readText(record.sandboxId, RUNTIME_DEV_LOG, 32_768);
    if (isRuntimeProviderOk(read) && read.value) text = `${text}\n${read.value}`;
  }
  return sanitizeTerminalOutput(text);
}

/**
 * GET status. It never creates a sandbox. An active row whose provider sandbox
 * is gone (provider expiry) is reconciled to `expired` here, so the workspace
 * cannot keep showing a dead preview as live.
 */
export async function getRuntimeSandboxStatus(input: {
  client: SupabaseClient;
  projectId: string;
  projectType: "website" | "android" | null;
  deps?: RuntimeServiceDeps;
}): Promise<RuntimeSandboxStatus> {
  const ctx = await contextFor(input, input.deps ?? {});
  const config = ctx.config;

  let schemaVersion: number | null = null;
  if (config.requested) {
    schemaVersion = await ctx.store.schemaVersion();
  }
  const capability = capabilityOf({
    config,
    projectId: ctx.projectId,
    projectType: input.projectType,
    schemaVersion,
  });

  let support: RuntimeProjectSupport = {
    supported: false,
    framework: null,
    reason: null,
    detail: null,
    entryHtml: null,
    hasLockfile: false,
    hasViteConfig: false,
    scriptWarnings: [],
  };
  if (input.projectType !== "android" && (capability.available || config.requested)) {
    const files = await ctx.loadFiles(ctx.client, ctx.projectId);
    if (!isRuntimeStoreFailure(files)) {
      support = detectRuntimeProject(files.data);
    } else {
      support = {
        ...support,
        detail: "Mavly could not read this project's saved files.",
      };
    }
  }

  let record: RuntimeSandboxRecord | null = null;
  if (capability.available || config.requested) {
    const latest = await ctx.store.latest(ctx.projectId);
    if (isRuntimeStoreFailure(latest) && latest.code === "MIGRATION_REQUIRED") {
      return {
        capability: {
          ...capability,
          available: false,
          reason: "migration_required",
          message: runtimeCapabilityReasonMessage("migration_required"),
          provider: "e2b",
        },
        support: {
          supported: support.supported,
          reason: support.reason,
          detail: support.detail,
        },
        session: null,
        pending: false,
      };
    }
    if (!isRuntimeStoreFailure(latest)) record = latest.data;
  }

  if (record && isActiveRuntimeState(record.state)) {
    const expired = record.expiresAt ? Date.parse(record.expiresAt) <= ctx.now() : false;
    if (expired) {
      const finalized = await ctx.store.update({
        id: record.id,
        state: "expired",
        failureCode: record.failureCode ?? "EXPIRED",
        failureReason: record.failureReason ?? "The sandbox reached its lifetime limit.",
      });
      if (!isRuntimeStoreFailure(finalized)) record = finalized.data;
      if (record.sandboxId && ctx.provider) {
        await ctx.provider.destroy(record.sandboxId);
      }
      emitRuntimeSandboxEvent("sandbox.expired", {
        projectId: ctx.projectId,
        runtimeSandboxId: record.id,
        status: "expired",
        reason: "lifetime",
      });
    } else if (record.sandboxId && ctx.provider) {
      const running = await ctx.provider.isRunning(record.sandboxId);
      /**
       * A provider `not_found` is expired, not "unknown". Otherwise the
       * workspace would keep offering a ready preview whose sandbox is gone.
       */
      const gone = isRuntimeProviderOk(running)
        ? running.value === false
        : running.error.code === "not_found";
      if (gone) {
        const finalized = await ctx.store.update({
          id: record.id,
          state: "expired",
          failureCode: "PROVIDER_EXPIRED",
          failureReason: "The provider sandbox is no longer running.",
        });
        if (!isRuntimeStoreFailure(finalized)) record = finalized.data;
        emitRuntimeSandboxEvent("sandbox.expired", {
          projectId: ctx.projectId,
          runtimeSandboxId: record.id,
          status: "expired",
          reason: "provider",
        });
      }
    }
  }

  return {
    capability,
    support: {
      supported: support.supported,
      reason: support.reason,
      detail: support.detail,
    },
    session: record ? toView(record) : null,
    pending: !!record && isActiveRuntimeState(record.state) && record.state !== "ready",
  };
}

/**
 * Start or reconnect. A ready session with the same source hash is REUSED; it
 * never creates a second sandbox or re-runs install. Concurrent requests are
 * serialized by the database's advisory lock plus the partial unique index.
 */
export async function startRuntimeSandbox(input: {
  client: SupabaseClient;
  projectId: string;
  runId?: string | null;
  projectType: "website" | "android" | null;
  deps?: RuntimeServiceDeps;
}): Promise<RuntimeStartOutcome> {
  const ctx = await contextFor(input, input.deps ?? {});

  const status = await getRuntimeSandboxStatus({
    client: input.client,
    projectId: input.projectId,
    projectType: input.projectType,
    deps: {
      config: ctx.config,
      store: ctx.store,
      provider: ctx.provider,
      loader: ctx.loadFiles,
      probe: ctx.probe,
      now: ctx.now,
      pollIntervalMs: ctx.pollIntervalMs,
    },
  });
  if (!status.capability.available) {
    const code: RuntimeFailureCode =
      status.capability.reason === "migration_required"
        ? "MIGRATION_REQUIRED"
        : "RUNTIME_SANDBOX_NOT_CONFIGURED";
    return failure(code, status.capability.message ?? "Live runtime previews are unavailable.", status, "failed");
  }
  if (!status.support.supported) {
    return failure(
      "RUNTIME_SANDBOX_UNSUPPORTED",
      status.support.detail ?? "Live runtime previews support React + Vite projects only.",
      status,
      "failed",
    );
  }
  if (!ctx.provider) {
    return failure(
      "RUNTIME_SANDBOX_NOT_CONFIGURED",
      "The runtime provider is not configured.",
      status,
      "failed",
    );
  }

  const files = await ctx.loadFiles(ctx.client, input.projectId);
  if (files.ok === false) {
    return failure("RUNTIME_SANDBOX_FAILED", files.error, status, "failed");
  }
  const support = detectRuntimeProject(files.data);
  if (!support.supported) {
    return failure(
      "RUNTIME_SANDBOX_UNSUPPORTED",
      support.detail ?? "Live runtime previews support React + Vite projects only.",
      status,
      "failed",
    );
  }
  const sourceHash = sourceHashForFiles(files.data);
  const existing = status.session
    ? await ctx.store.latest(input.projectId)
    : null;
  const activeRecord = existing && existing.ok === true ? existing.data : null;

  if (activeRecord && isActiveRuntimeState(activeRecord.state)) {
    if (
      activeRecord.state === "ready" &&
      activeRecord.sourceHash === sourceHash &&
      activeRecord.previewUrl
    ) {
      /** Reuse must also renew the provider lifetime, not only the DB expiry. */
      if (activeRecord.sandboxId) {
        await ctx.provider.setLifetime(
          activeRecord.sandboxId,
          ctx.config.maxLifetimeSeconds * 1000,
        );
      }
      const touched = await ctx.store.update({
        id: activeRecord.id,
        extendSeconds: ctx.config.idleSeconds,
      });
      return {
        ok: true,
        code: null,
        message: null,
        outcome: "reused",
        status: {
          ...status,
          session: touched.ok === true ? toView(touched.data) : status.session,
          pending: false,
        },
      };
    }
    const ageMs = Date.parse(activeRecord.createdAt) || 0;
    const staleStart = ctx.now() - ageMs > 3 * 60_000;
    if (!staleStart) {
      return failure(
        "RUNTIME_SANDBOX_BUSY",
        "A live sandbox is already being prepared for this project.",
        { ...status, pending: true },
        "busy",
      );
    }
    // A stuck start is abandoned explicitly, never silently duplicated.
    if (activeRecord.sandboxId) {
      await ctx.provider.destroy(activeRecord.sandboxId);
    }
    await ctx.store.update({
      id: activeRecord.id,
      state: "failed",
      failureCode: "STALE_START",
      failureReason: "The previous sandbox start did not complete and was abandoned.",
    });
  }

  const begun = await ctx.store.begin({
    projectId: input.projectId,
    runId: input.runId ?? null,
    provider: "e2b",
    framework: support.framework ?? "react_vite",
    sourceHash,
    maxLifetimeSeconds: ctx.config.maxLifetimeSeconds,
    maxActivePerUser: ctx.config.maxActivePerUser,
  });
  if (begun.ok === false) {
    const code: RuntimeFailureCode =
      begun.code === "MIGRATION_REQUIRED"
        ? "MIGRATION_REQUIRED"
        : begun.code === "RUNTIME_SANDBOX_BUSY"
          ? "RUNTIME_SANDBOX_BUSY"
          : begun.code === "FORBIDDEN"
            ? "FORBIDDEN"
            : "RUNTIME_SANDBOX_FAILED";
    return failure(code, begun.error, status, code === "RUNTIME_SANDBOX_BUSY" ? "busy" : "failed");
  }
  if (!begun.data.created) {
    const current = begun.data.record;
    const reuse =
      current.state === "ready" &&
      current.sourceHash === sourceHash &&
      !!current.previewUrl;
    return {
      ok: reuse,
      code: reuse ? null : "RUNTIME_SANDBOX_BUSY",
      message: reuse ? null : "A live sandbox is already being prepared for this project.",
      outcome: reuse ? "reused" : "busy",
      status: {
        ...status,
        session: toView(current),
        pending: !reuse && isActiveRuntimeState(current.state),
      },
    };
  }

  let record = begun.data.record;
  emitRuntimeSandboxEvent("sandbox.created", {
    projectId: ctx.projectId,
    runtimeSandboxId: record.id,
    status: "created",
    provider: "e2b",
  });

  const created = await ctx.provider.create({
    template: ctx.config.template,
    timeoutMs: ctx.config.maxLifetimeSeconds * 1000,
    metadata: { mavly: "runtime-preview", purpose: "preview" },
  });
  if (!isRuntimeProviderOk(created)) {
    const failed = await persistFailure(
      ctx,
      record,
      created.error.code === "rate_limited" ? "PROVIDER_RATE_LIMITED" : "PROVIDER_CREATE_FAILED",
      created.error.message,
      "",
    );
    return failure(
      "RUNTIME_SANDBOX_FAILED",
      "The isolated runtime could not be created.",
      { ...status, session: runtimeSessionView(failed), pending: false },
    );
  }
  record = { ...record, sandboxId: created.value.sandboxId };

  /**
   * Persist the provider reference immediately. A crash before the next stage
   * must leave a row the expiry sweep can find, instead of an orphan sandbox
   * nothing can delete.
   */
  const bridged = await ctx.store.update({
    id: record.id,
    sandboxId: record.sandboxId,
    extendSeconds: 60,
  });
  if (isRuntimeStoreFailure(bridged)) {
    await ctx.provider.destroy(record.sandboxId as string);
    return failure("RUNTIME_SANDBOX_FAILED", bridged.error, status);
  }

  const syncing = await transition(ctx, record, "syncing");
  if (!syncing) {
    await persistFailure(ctx, record, "STATE_REJECTED", "The sandbox could not enter syncing.", "");
    return failure("RUNTIME_SANDBOX_FAILED", "The sandbox lifecycle was rejected.", status);
  }
  record = { ...syncing, sandboxId: created.value.sandboxId };

  const plan = planProjectSync(files.data, {
    maxFiles: ctx.config.maxFiles,
    maxFileBytes: ctx.config.maxFileBytes,
    maxTotalBytes: ctx.config.maxTotalBytes,
  }, record.syncedPaths);
  const missing = syncMissingRequiredFiles(
    plan,
    (support.framework ?? "react_vite") === "nextjs" ? ["package.json"] : ["package.json", "index.html"],
  );
  if (missing.length > 0) {
    const failed = await persistFailure(
      ctx,
      record,
      "SYNC_INCOMPLETE",
      `These required files could not be materialized: ${missing.join(", ")}.`,
      "",
    );
    return failure(
      "RUNTIME_SANDBOX_FAILED",
      `The runtime is missing ${missing.join(", ")}.`,
      { ...status, session: runtimeSessionView(failed), pending: false },
    );
  }

  if (plan.files.length > 0) {
    const written = await ctx.provider.writeFiles(
      record.sandboxId as string,
      RUNTIME_PROJECT_DIR,
      plan.files,
    );
    if (!isRuntimeProviderOk(written)) {
      const failed = await persistFailure(
        ctx,
        record,
        "SYNC_FAILED",
        written.error.message,
        "",
      );
      return failure(
        "RUNTIME_SANDBOX_FAILED",
        "The project files could not be copied into the runtime.",
        { ...status, session: runtimeSessionView(failed), pending: false },
      );
    }
  }
  if (plan.removed.length > 0) {
    await ctx.provider.removeFiles(record.sandboxId as string, RUNTIME_PROJECT_DIR, plan.removed);
  }

  const syncLogs = sanitizeTerminalOutput(
    `Synced ${plan.files.length} file(s), ${plan.bytes} bytes. Removed ${plan.removed.length} stale path(s).`,
  );
  const synced = await ctx.store.update({
    id: record.id,
    sandboxId: record.sandboxId,
    syncedPaths: plan.files.map((file) => file.path),
    logs: syncLogs,
    diagnostics: {
      ...record.diagnostics,
      entryHtml: support.entryHtml,
      hasLockfile: support.hasLockfile,
      hasViteConfig: support.hasViteConfig,
      scriptWarnings: support.scriptWarnings,
      skippedFiles: plan.skipped.slice(0, 40),
      egressRestricted: false,
    },
  });
  if (isRuntimeStoreFailure(synced)) {
    return failure("RUNTIME_SANDBOX_FAILED", synced.error, status);
  }
  record = synced.data;
  emitRuntimeSandboxEvent("sandbox.sync.completed", {
    projectId: ctx.projectId,
    runtimeSandboxId: record.id,
    status: "synced",
    fileCount: plan.files.length,
    fileBytes: plan.bytes,
  });

  const installing = await transition(ctx, record, "installing");
  if (!installing) return failure("RUNTIME_SANDBOX_FAILED", "The lifecycle was rejected.", status);
  record = installing;

  const installStarted = ctx.now();
  const install = await runCommand(
    ctx,
    record,
    installCommand({ hasLockfile: support.hasLockfile }),
    ctx.config.installTimeoutMs,
  );
  if (!install || install.exitCode !== 0) {
    const timedOut = install?.timedOut === true;
    const providerError = install?.providerError === true;
    const failed = await persistFailure(
      ctx,
      record,
      timedOut ? "INSTALL_TIMEOUT" : providerError ? "PROVIDER_COMMAND_FAILED" : "INSTALL_FAILED",
      timedOut
        ? "Dependency installation did not finish within its limit."
        : providerError
          ? "The provider did not report a result for dependency installation."
          : "Dependency installation failed.",
      appendTerminalOutput("", install?.logs ?? ""),
      { installExitCode: install?.exitCode ?? null },
    );
    return failure(
      "RUNTIME_SANDBOX_FAILED",
      "Dependency installation failed in the isolated runtime.",
      { ...status, session: runtimeSessionView(failed), pending: false },
    );
  }
  const installMs = ctx.now() - installStarted;

  /**
   * Egress is denied after install. The dev server serves inbound traffic and
   * has no legitimate need to reach the internet; if the provider will not
   * apply the restriction, the sandbox still runs and records the weaker
   * guarantee instead of pretending it was applied.
   */
  const egress = await ctx.provider.denyEgress(record.sandboxId as string);
  const egressRestricted = isRuntimeProviderOk(egress);

  const starting = await transition(ctx, record, "starting");
  if (!starting) return failure("RUNTIME_SANDBOX_FAILED", "The lifecycle was rejected.", status);
  record = starting;

  const devCommand =
    (support.framework ?? "react_vite") === "nextjs"
      ? nextDevServerCommand({ port: ctx.config.port })
      : devServerCommand({ port: ctx.config.port });
  const started = await ctx.provider.startBackground(
    record.sandboxId as string,
    { ...devCommand, timeoutMs: 0 },
    RUNTIME_DEV_LOG,
  );
  if (!isRuntimeProviderOk(started)) {
    const failed = await persistFailure(
      ctx,
      record,
      "DEV_SERVER_START_FAILED",
      started.error.message,
      install.logs,
      { installMs, egressRestricted },
    );
    return failure(
      "RUNTIME_SANDBOX_FAILED",
      "The development server could not be started.",
      { ...status, session: runtimeSessionView(failed), pending: false },
    );
  }

  const devPid = started.value.pid;
  emitRuntimeSandboxEvent("sandbox.server.started", {
    projectId: ctx.projectId,
    runtimeSandboxId: record.id,
    status: "started",
    runtimePort: ctx.config.port,
  });

  const host = await ctx.provider.previewHost(record.sandboxId as string, ctx.config.port);
  const previewUrl = isRuntimeProviderOk(host)
    ? previewUrlFromProvider(host.value)
    : null;
  if (!previewUrl) {
    const failed = await persistFailure(
      ctx,
      record,
      "PREVIEW_HOST_INVALID",
      "The provider returned a preview host Mavly will not embed.",
      install.logs,
      { installMs, devPid, egressRestricted },
    );
    return failure(
      "RUNTIME_SANDBOX_FAILED",
      "The runtime preview address could not be validated.",
      { ...status, session: runtimeSessionView(failed), pending: false },
    );
  }

  const startupStarted = ctx.now();
  let logs = install.logs;
  let ready = false;
  let lastStatus: number | null = null;
  let exitObserved = false;

  while (ctx.now() - startupStarted < ctx.config.startupTimeoutMs) {
    // A process that exited immediately is a failure, not a slow start.
    const processes = await ctx.provider.listProcesses(record.sandboxId as string);
    if (isRuntimeProviderOk(processes)) {
      const alive = processes.value.some((process) => process.pid === devPid);
      if (!alive) {
        exitObserved = true;
        break;
      }
    }
    const probed = await ctx.probe(previewUrl);
    if (probed) {
      lastStatus = probed.status;
      if (isReadyStatus(probed.status)) {
        ready = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, ctx.pollIntervalMs));
  }

  logs = await refreshStoredLogs(ctx, record, logs);

  if (!ready) {
    const failed = await persistFailure(
      ctx,
      record,
      exitObserved ? "DEV_SERVER_EXITED" : "STARTUP_TIMEOUT",
      exitObserved
        ? "The development server exited before it became ready."
        : lastStatus
          ? `The development server answered HTTP ${lastStatus} instead of a ready page.`
          : "The development server did not become ready within its limit.",
      logs,
      { installMs, devPid, egressRestricted, healthHttpStatus: lastStatus },
    );
    return failure(
      "RUNTIME_SANDBOX_FAILED",
      exitObserved
        ? "The development server exited before it was ready."
        : "The development server did not become ready in time.",
      { ...status, session: runtimeSessionView(failed), pending: false },
    );
  }

  const startupMs = ctx.now() - startupStarted;
  const finished = await ctx.store.update({
    id: record.id,
    state: "ready",
    sandboxId: record.sandboxId,
    port: ctx.config.port,
    previewUrl,
    logs,
    installMs,
    startupMs,
    syncedPaths: plan.files.map((file) => file.path),
    extendSeconds: ctx.config.idleSeconds,
    diagnostics: {
      ...record.diagnostics,
      devPid,
      installMs,
      startupMs,
      egressRestricted,
      healthHttpStatus: lastStatus,
      readyAt: new Date(ctx.now()).toISOString(),
      scriptWarnings: support.scriptWarnings,
    },
  });
  if (isRuntimeStoreFailure(finished)) {
    return failure("RUNTIME_SANDBOX_FAILED", finished.error, status);
  }

  emitRuntimeSandboxEvent("sandbox.ready", {
    projectId: ctx.projectId,
    runtimeSandboxId: record.id,
    status: "ready",
    runtimePort: ctx.config.port,
    durationMs: startupMs,
  });

  return {
    ok: true,
    code: null,
    message: null,
    outcome: "started",
    status: {
      ...status,
      capability: { ...status.capability, available: true },
      support: { supported: true, reason: null, detail: null },
      session: toView(finished.data),
      pending: false,
    },
  };
}

/**
 * Owner-requested stop. It kills the fixed dev-server process, destroys the
 * provider sandbox and finalizes the row. A second stop is a confirmed no-op.
 */
export async function stopRuntimeSandbox(input: {
  client: SupabaseClient;
  projectId: string;
  deps?: RuntimeServiceDeps;
}): Promise<RuntimeStartOutcome> {
  const ctx = await contextFor(input, input.deps ?? {});
  const latest = await ctx.store.latest(input.projectId);
  if (latest.ok === false) {
    return failure("RUNTIME_SANDBOX_FAILED", latest.error);
  }
  const record = latest.data;
  if (!record) {
    return {
      ok: true,
      code: null,
      message: null,
      outcome: "already_stopped",
      status: null,
    };
  }
  if (!isActiveRuntimeState(record.state)) {
    return {
      ok: true,
      code: null,
      message: null,
      outcome: "already_stopped",
      status: null,
    };
  }

  const stopping = await ctx.store.stop(input.projectId, record.id);
  const current = stopping.ok === true && stopping.data ? stopping.data : record;

  if (current.sandboxId && ctx.provider) {
    const devPid = devPidOf(current);
    if (devPid) {
      await ctx.provider.killProcess(current.sandboxId, devPid);
    }
    await ctx.provider.destroy(current.sandboxId);
  }

  const finalized = await ctx.store.update({
    id: current.id,
    state: "stopped",
    diagnostics: {
      ...current.diagnostics,
      stoppedBy: "owner",
      stoppedAt: new Date(ctx.now()).toISOString(),
    },
  });

  emitRuntimeSandboxEvent("sandbox.stopped", {
    projectId: ctx.projectId,
    runtimeSandboxId: current.id,
    status: "stopped",
  });

  return {
    ok: true,
    code: null,
    message: null,
    outcome: "stopped",
    status: {
      capability: {
        available: ctx.config.ready,
        reason: ctx.config.ready ? null : "disabled",
        message: ctx.config.ready ? null : runtimeProblemSummary(ctx.config),
        provider: ctx.config.ready ? "e2b" : null,
    framework: "react_vite",
      },
      support: { supported: true, reason: null, detail: null },
      session: runtimeSessionView(finalized.ok === true ? finalized.data : current),
      pending: false,
    },
  };
}

/**
 * Refresh the bounded terminal log for an owner-visible session. Reading logs
 * never starts, restarts or installs anything.
 */
export async function refreshRuntimeLogs(input: {
  client: SupabaseClient;
  projectId: string;
  deps?: RuntimeServiceDeps;
}): Promise<{ ok: boolean; logs: string; error: string | null }> {
  const ctx = await contextFor(input, input.deps ?? {});
  const latest = await ctx.store.latest(input.projectId);
  if (latest.ok === false) return { ok: false, logs: "", error: latest.error };
  const record = latest.data;
  if (!record) return { ok: true, logs: "", error: null };
  if (!record.sandboxId || !ctx.provider || !isActiveRuntimeState(record.state)) {
    return { ok: true, logs: record.logs, error: null };
  }
  const logs = await refreshStoredLogs(ctx, record);
  const updated = await ctx.store.update({ id: record.id, logs, extendSeconds: ctx.config.idleSeconds });
  return { ok: true, logs: updated.ok === true ? updated.data.logs : logs, error: null };
}

/**
 * Run one bounded production build inside an existing ready sandbox. This is an
 * approved QA operation, never a browser-supplied command.
 */
export async function runRuntimeBuildCheck(input: {
  client: SupabaseClient;
  projectId: string;
  deps?: RuntimeServiceDeps;
}): Promise<RuntimeCheck> {
  const ctx = await contextFor(input, input.deps ?? {});
  if (!ctx.config.qaBuild) {
    return {
      id: "build",
      label: "Production build",
      status: "unavailable",
      detail: "Approved QA builds are not enabled for this deployment.",
    };
  }
  if (!ctx.config.ready) {
    return {
      id: "build",
      label: "Production build",
      status: "unavailable",
      detail: runtimeProblemSummary(ctx.config),
    };
  }
  if (!isProjectInRuntimeCohort(input.projectId, ctx.config)) {
    return {
      id: "build",
      label: "Production build",
      status: "unavailable",
      detail: "Live runtime previews are restricted by this deployment's project list.",
    };
  }
  const latest = await ctx.store.latest(input.projectId);
  const record = latest.ok === true ? latest.data : null;
  if (!record || record.state !== "ready" || !record.sandboxId || !ctx.provider) {
    return {
      id: "build",
      label: "Production build",
      status: "unavailable",
      detail: "A ready runtime sandbox is required before a build can run.",
    };
  }

  const result = await ctx.provider.run(record.sandboxId, {
    ...buildCommand(record.framework === "nextjs" ? "nextjs" : undefined),
    timeoutMs: Math.min(ctx.config.installTimeoutMs, 240_000),
  });
  if (!isRuntimeProviderOk(result)) {
    return {
      id: "build",
      label: "Production build",
      status: "unavailable",
      detail: result.error.message,
    };
  }
  const passed = result.value.exitCode === 0;
  const logs = appendTerminalOutput(record.logs, `${result.value.stdout}\n${result.value.stderr}`);
  await ctx.store.update({
    id: record.id,
    logs,
    diagnostics: {
      ...record.diagnostics,
      build: {
        exitCode: result.value.exitCode,
        durationMs: result.value.durationMs,
        at: new Date(ctx.now()).toISOString(),
      },
    },
  });
  return {
    id: "build",
    label: "Production build",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "The isolated sandbox built the project successfully."
      : `The isolated sandbox build exited with code ${result.value.exitCode ?? "unknown"}.`,
  };
}

/**
 * Bounded service-role sweep used by the durable worker. It marks expired rows
 * and destroys their provider sandboxes. A failure on one sandbox never stops
 * the sweep and never affects generation.
 */
export async function sweepExpiredRuntimeSandboxes(input: {
  client: SupabaseClient;
  deps?: RuntimeServiceDeps;
  limit?: number;
}): Promise<{ expired: number; destroyed: number; error: string | null }> {
  const config = input.deps?.config ?? runtimeSandboxConfig();
  const provider =
    input.deps?.provider !== undefined
      ? input.deps.provider
      : await createRuntimeSandboxProvider(config);

  const { expireRuntimeSandboxes } = await import("./store");
  const expired = await expireRuntimeSandboxes(input.client, input.limit ?? 10);
  if (expired.ok === false) {
    return { expired: 0, destroyed: 0, error: expired.error };
  }
  let destroyed = 0;
  for (const row of expired.data) {
    if (!row.sandboxId || !provider) continue;
    const killed = await provider.destroy(row.sandboxId);
    if (isRuntimeProviderOk(killed)) destroyed += 1;
    emitRuntimeSandboxEvent("sandbox.expired", {
      projectId: row.projectId,
      runtimeSandboxId: row.id,
      status: "expired",
      reason: "sweep",
    });
  }
  return { expired: expired.data.length, destroyed, error: null };
}

/** Read one project's stored runtime record for orchestration evidence. */
export async function readRuntimeSandboxRecord(
  client: SupabaseClient,
  projectId: string,
  deps: RuntimeServiceDeps = {},
): Promise<RuntimeSandboxRecord | null> {
  const store = deps.store ?? createSupabaseRuntimeStore(client);
  const latest = await store.latest(projectId);
  if (isRuntimeStoreFailure(latest)) return null;
  return latest.data;
}

