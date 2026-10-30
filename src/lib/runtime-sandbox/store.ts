/**
 * ═══ RUNTIME SANDBOX STORE (migration 34) ══════════════════════════════════
 *
 * Typed wrappers around the lifecycle RPCs. The caller supplies the client:
 *
 *   · the authenticated routes use the caller's own RLS-scoped client, so the
 *     RPCs' ownership check and the row policies are the boundary;
 *   · the worker's bounded expiry sweep uses the confined service-role client.
 *
 * ⚠️ NO PROVIDER KEY APPEARS HERE. This module moves already-sanitized rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isRuntimeFramework,
  type RuntimeFramework,
  isRuntimeSandboxState,
  type RuntimeSandboxRecord,
  type RuntimeSandboxState,
} from "./types";
import { previewHostFromUrl } from "./policy";

export type RuntimeStoreFailure = { ok: false; error: string; code?: string };
export type RuntimeStoreResult<T> = { ok: true; data: T } | RuntimeStoreFailure;

export function isRuntimeStoreFailure<T>(
  result: RuntimeStoreResult<T>,
): result is RuntimeStoreFailure {
  return result.ok === false;
}

export const RUNTIME_ROW_COLUMNS = [
  "id",
  "project_id",
  "run_id",
  "provider",
  "provider_sandbox_id",
  "framework",
  "state",
  "source_hash",
  "synced_paths",
  "port",
  "preview_url",
  "failure_code",
  "failure_reason",
  "logs",
  "diagnostics",
  "install_ms",
  "startup_ms",
  "command_count",
  "max_lifetime_seconds",
  "created_at",
  "updated_at",
  "last_activity_at",
  "expires_at",
  "stopped_at",
].join(",");

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 1000)
    : [];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse one RPC row (camelCase) into the server-side record. */
export function normalizeRuntimeSandboxRecord(value: unknown): RuntimeSandboxRecord | null {
  const row = recordOf(value);
  if (!row) return null;
  if (typeof row.id !== "string" || typeof row.projectId !== "string") return null;
  if (!isRuntimeSandboxState(row.state)) return null;
  if (!isRuntimeFramework(row.framework)) return null;
  /**
   * ⚠️ A STORED PREVIEW URL IS RE-VALIDATED ON READ. The owner can call the
   * update RPC directly, so a forged row must never turn into an iframe target:
   * only a canonical `https://<label>.e2b.app` URL survives normalization.
   */
  const storedPreviewUrl = stringOrNull(row.previewUrl);
  const previewUrl = previewHostFromUrl(storedPreviewUrl) ? storedPreviewUrl : null;

  return {
    id: row.id,
    projectId: row.projectId,
    runId: stringOrNull(row.runId),
    provider: "e2b",
    sandboxId: stringOrNull(row.sandboxId),
    framework: row.framework,
    state: row.state,
    sourceHash: stringOrNull(row.sourceHash),
    syncedPaths: stringArray(row.syncedPaths),
    port: numberOrNull(row.port),
    previewUrl,
    failureCode: stringOrNull(row.failureCode),
    failureReason: stringOrNull(row.failureReason),
    logs: typeof row.logs === "string" ? row.logs.slice(-16_384) : "",
    diagnostics: recordOf(row.diagnostics) ?? {},
    installMs: numberOrNull(row.installMs),
    startupMs: numberOrNull(row.startupMs),
    commandCount: numberOrNull(row.commandCount) ?? 0,
    maxLifetimeSeconds: numberOrNull(row.maxLifetimeSeconds) ?? 1800,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    lastActivityAt: typeof row.lastActivityAt === "string" ? row.lastActivityAt : "",
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : "",
    stoppedAt: stringOrNull(row.stoppedAt),
  };
}

/** Parse a snake_case table row, used by the owner-visible read. */
export function normalizeRuntimeSandboxRow(value: unknown): RuntimeSandboxRecord | null {
  const row = recordOf(value);
  if (!row) return null;
  return normalizeRuntimeSandboxRecord({
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    sandboxId: row.provider_sandbox_id,
    framework: row.framework,
    state: row.state,
    sourceHash: row.source_hash,
    syncedPaths: row.synced_paths,
    port: row.port,
    previewUrl: row.preview_url,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    logs: row.logs,
    diagnostics: row.diagnostics,
    installMs: row.install_ms,
    startupMs: row.startup_ms,
    commandCount: row.command_count,
    maxLifetimeSeconds: row.max_lifetime_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    stoppedAt: row.stopped_at,
  });
}

function isMissingFunction(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  return (
    /function .*does not exist|Could not find the function/i.test(error.message ?? "") ||
    error.code === "PGRST202" ||
    error.code === "42883"
  );
}

function mapRpcFailure(scope: string, error: { message?: string; code?: string }): RuntimeStoreFailure {
  const message = error.message ?? `${scope} failed`;
  if (isMissingFunction(error)) {
    return {
      ok: false,
      error:
        "Live runtime previews need database migration 34. Apply supabase/migrations/34_runtime_sandboxes.sql.",
      code: "MIGRATION_REQUIRED",
    };
  }
  if (error.code === "42501" || /PROJECT_FORBIDDEN/i.test(message)) {
    return { ok: false, error: "You don't have access to this project.", code: "FORBIDDEN" };
  }
  if (/RUNTIME_SANDBOX_QUOTA/i.test(message)) {
    return {
      ok: false,
      error: "You already have the maximum number of live sandboxes running.",
      code: "RUNTIME_SANDBOX_BUSY",
    };
  }
  if (/RUNTIME_SANDBOX_TERMINAL|RUNTIME_(?:STATE_TRANSITION|STATE|PORT|PREVIEW|SOURCE|SANDBOX_ID)_INVALID|RUNTIME_PROJECT_TYPE_UNSUPPORTED/i.test(message)) {
    return {
      ok: false,
      error: "The runtime sandbox rejected an invalid lifecycle update.",
      code: "RUNTIME_SANDBOX_INVALID",
    };
  }
  return { ok: false, error: message, code: error.code };
}

export async function runtimeSandboxSchemaVersion(
  client: SupabaseClient,
): Promise<number | null> {
  const { data, error } = await client.rpc("runtime_sandbox_schema_version");
  if (error) {
    if (isMissingFunction(error)) return null;
    console.error("[runtime-sandbox] schema check:", error.message);
    return null;
  }
  const version = typeof data === "number" ? data : Number(data);
  return Number.isInteger(version) ? version : 0;
}

/** The owner-visible latest session for one project (RLS applies). */
export async function latestRuntimeSandbox(
  client: SupabaseClient,
  projectId: string,
): Promise<RuntimeStoreResult<RuntimeSandboxRecord | null>> {
  const { data, error } = await client
    .from("project_runtime_sandboxes")
    .select(RUNTIME_ROW_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingFunction(error) || /does not exist/i.test(error.message ?? "")) {
      return {
        ok: false,
        error:
          "Live runtime previews need database migration 34. Apply supabase/migrations/34_runtime_sandboxes.sql.",
        code: "MIGRATION_REQUIRED",
      };
    }
    return { ok: false, error: error.message, code: error.code };
  }
  return { ok: true, data: normalizeRuntimeSandboxRow(data) };
}

export interface BeginRuntimeSandboxInput {
  projectId: string;
  runId: string | null;
  provider: "e2b";
  framework: RuntimeFramework;
  sourceHash: string | null;
  maxLifetimeSeconds: number;
  maxActivePerUser: number;
}

export interface BeginRuntimeSandboxAnswer {
  created: boolean;
  record: RuntimeSandboxRecord;
}

export async function beginRuntimeSandbox(
  client: SupabaseClient,
  input: BeginRuntimeSandboxInput,
): Promise<RuntimeStoreResult<BeginRuntimeSandboxAnswer>> {
  const { data, error } = await client.rpc("begin_runtime_sandbox", {
    p_project_id: input.projectId,
    p_run_id: input.runId,
    p_provider: input.provider,
    p_framework: input.framework,
    p_source_hash: input.sourceHash,
    p_max_lifetime_seconds: input.maxLifetimeSeconds,
    p_max_active_per_user: input.maxActivePerUser,
  });
  if (error) return mapRpcFailure("begin runtime sandbox", error);

  const answer = recordOf(data);
  const record = normalizeRuntimeSandboxRecord(answer?.sandbox);
  if (!answer || !record) {
    return {
      ok: false,
      error: "The runtime sandbox store returned an unexpected record.",
      code: "UNKNOWN",
    };
  }
  return { ok: true, data: { created: answer.created === true, record } };
}

export interface UpdateRuntimeSandboxInput {
  id: string;
  state?: RuntimeSandboxState;
  sandboxId?: string | null;
  port?: number | null;
  previewUrl?: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
  logs?: string | null;
  diagnostics?: Record<string, unknown> | null;
  syncedPaths?: string[] | null;
  installMs?: number | null;
  startupMs?: number | null;
  extendSeconds?: number | null;
}

export async function updateRuntimeSandbox(
  client: SupabaseClient,
  input: UpdateRuntimeSandboxInput,
): Promise<RuntimeStoreResult<RuntimeSandboxRecord>> {
  const { data, error } = await client.rpc("update_runtime_sandbox", {
    p_id: input.id,
    p_state: input.state ?? null,
    p_sandbox_id: input.sandboxId ?? null,
    p_port: input.port ?? null,
    p_preview_url: input.previewUrl ?? null,
    p_failure_code: input.failureCode ?? null,
    p_failure_reason: input.failureReason ?? null,
    p_logs: input.logs ?? null,
    p_diagnostics: input.diagnostics ?? null,
    p_synced_paths: input.syncedPaths ?? null,
    p_install_ms: input.installMs ?? null,
    p_startup_ms: input.startupMs ?? null,
    p_extend_seconds: input.extendSeconds ?? null,
  });
  if (error) return mapRpcFailure("update runtime sandbox", error);

  const record = normalizeRuntimeSandboxRecord(data);
  if (!record) {
    return {
      ok: false,
      error: "The runtime sandbox no longer exists.",
      code: "NOT_FOUND",
    };
  }
  return { ok: true, data: record };
}

export async function stopRuntimeSandbox(
  client: SupabaseClient,
  projectId: string,
  id: string,
): Promise<RuntimeStoreResult<RuntimeSandboxRecord | null>> {
  const { data, error } = await client.rpc("stop_runtime_sandbox", {
    p_project_id: projectId,
    p_id: id,
  });
  if (error) return mapRpcFailure("stop runtime sandbox", error);
  return { ok: true, data: normalizeRuntimeSandboxRecord(data) };
}

export interface ExpiredRuntimeSandbox {
  id: string;
  projectId: string;
  sandboxId: string | null;
}

export async function expireRuntimeSandboxes(
  client: SupabaseClient,
  limit = 20,
): Promise<RuntimeStoreResult<ExpiredRuntimeSandbox[]>> {
  const { data, error } = await client.rpc("expire_runtime_sandboxes", {
    p_limit: limit,
  });
  if (error) return mapRpcFailure("expire runtime sandboxes", error);
  if (!Array.isArray(data)) return { ok: true, data: [] };
  return {
    ok: true,
    data: data
      .map((entry) => {
        const row = recordOf(entry);
        if (!row || typeof row.id !== "string" || typeof row.projectId !== "string") return null;
        return {
          id: row.id,
          projectId: row.projectId,
          sandboxId: stringOrNull(row.sandboxId),
        };
      })
      .filter((entry): entry is ExpiredRuntimeSandbox => entry !== null),
  };
}

/**
 * The interface the service depends on. Production builds it from one client;
 * tests supply an in-memory implementation so no Supabase or provider call is
 * needed.
 */
export interface RuntimeSandboxStore {
  schemaVersion(): Promise<number | null>;
  latest(projectId: string): Promise<RuntimeStoreResult<RuntimeSandboxRecord | null>>;
  begin(input: BeginRuntimeSandboxInput): Promise<RuntimeStoreResult<BeginRuntimeSandboxAnswer>>;
  update(input: UpdateRuntimeSandboxInput): Promise<RuntimeStoreResult<RuntimeSandboxRecord>>;
  stop(projectId: string, id: string): Promise<RuntimeStoreResult<RuntimeSandboxRecord | null>>;
}

export function createSupabaseRuntimeStore(client: SupabaseClient): RuntimeSandboxStore {
  return {
    schemaVersion: () => runtimeSandboxSchemaVersion(client),
    latest: (projectId) => latestRuntimeSandbox(client, projectId),
    begin: (input) => beginRuntimeSandbox(client, input),
    update: (input) => updateRuntimeSandbox(client, input),
    stop: (projectId, id) => stopRuntimeSandbox(client, projectId, id),
  };
}
