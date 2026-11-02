/**
 * ═══ SERVER-SIDE BACKEND CONTEXT RESOLVER ═══════════════════════════════════
 *
 * The one place a server process asks "which backend is selected for this
 * project". It calls the service-role RPC from migration 48 and validates the
 * shape before anything downstream trusts it.
 *
 * ⚠️ SERVICE ROLE ONLY, AND THAT IS THE POINT. The authoritative context must not
 * be reachable from a browser session, because a caller that can read it can also
 * be tempted to pass it back in. Every consumer here is a server process: the
 * generation worker, the orchestration engine, the data gateway.
 *
 * ⚠️ NO FALLBACK. If the RPC fails, the answer is a failure, never "assume
 * managed Neon". A guessed provider is worse than a stopped run: it writes code
 * against the wrong database and reports success.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildBackendAgentContext,
  detectStaleBackendContext,
  isBackendContextProvider,
  type BackendAgentContext,
  type BackendContextRow,
} from "./context";

export type BackendContextFailureCode =
  | "migration_required"
  | "unavailable"
  | "conflict"
  | "not_found"
  | "error";

export type BackendContextResult =
  | { ok: true; row: BackendContextRow; context: BackendAgentContext }
  | { ok: false; code: BackendContextFailureCode; message: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapError(error: { code?: string; message?: string } | null): {
  code: BackendContextFailureCode;
  message: string;
} {
  const code = error?.code ?? "unknown";
  const message = error?.message ?? "";

  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return {
      code: "migration_required",
      message:
        "Backend selection storage is not installed. Apply supabase/migrations/48_backend_selection_authority.sql.",
    };
  }
  /**
   * ⚠️ P0001 FROM THIS RPC IS ALWAYS A CONFLICT, NOT A POLICY REFUSAL. The only
   * P0001 it raises is "multiple active backends", which means the one-active
   * index is missing. Reporting it as a generic error would hide a real
   * integrity problem.
   */
  if (code === "P0001") {
    return {
      code: "conflict",
      message: "This project has more than one active backend, which must be resolved before it can be used.",
    };
  }
  if (code === "P0002") {
    return { code: "not_found", message: "The project was not found." };
  }
  if (code === "42501") {
    return { code: "unavailable", message: "The backend context is not available." };
  }
  if (code === "PGRST000" || code === "08000" || code === "08003") {
    return { code: "unavailable", message: "The backend context service is unavailable." };
  }
  console.error(`[backend-context] read failed (${code})`);
  return { code: "error", message: "The backend selection could not be read." };
}

function rowFrom(value: unknown): BackendContextRow | null {
  const record = recordOf(Array.isArray(value) ? value[0] : value);
  if (!record) return null;

  if (!isBackendContextProvider(record.backend_provider)) return null;
  if (typeof record.backend_status !== "string") return null;
  if (typeof record.backend_active !== "boolean") return null;
  /**
   * ⚠️ `bigint` MAY ARRIVE AS A STRING. PostgREST serializes int8 as a string to
   * avoid the JSON precision limit, so a strict `typeof === "number"` check would
   * reject every real row. It is parsed and bounded instead.
   */
  const epoch =
    typeof record.selection_epoch === "number"
      ? record.selection_epoch
      : typeof record.selection_epoch === "string"
        ? Number.parseInt(record.selection_epoch, 10)
        : Number.NaN;
  if (!Number.isFinite(epoch) || epoch < 0) return null;

  return {
    backend_provider: record.backend_provider,
    backend_status: record.backend_status,
    backend_active: record.backend_active,
    selection_epoch: epoch,
    managed_ready: record.managed_ready === true,
    supabase_ready: record.supabase_ready === true,
    supabase_project_ref:
      typeof record.supabase_project_ref === "string" ? record.supabase_project_ref : null,
    data_model: record.data_model ?? null,
    gateway_origin: typeof record.gateway_origin === "string" ? record.gateway_origin : null,
  };
}

/**
 * Read the authoritative backend context for one project.
 *
 * ⚠️ `client` MUST BE A SERVICE-ROLE CLIENT. The RPC refuses anything else, so a
 * caller that passes an owner session gets a clean failure rather than a silent
 * downgrade.
 */
export async function resolveBackendContext(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<BackendContextResult> {
  const { data, error } = await input.client.rpc("read_backend_context", {
    p_project_id: input.projectId,
  });
  if (error) {
    const mapped = mapError(error);
    return { ok: false, code: mapped.code, message: mapped.message };
  }

  const row = rowFrom(data);
  if (!row) {
    /**
     * A malformed row is not "no backend". Treating it as `none` would tell an
     * agent to ask the user for a backend on a project that has one.
     */
    return {
      ok: false,
      code: "error",
      message: "The backend selection could not be read.",
    };
  }

  return { ok: true, row, context: buildBackendAgentContext(row) };
}

/**
 * Re-read the context and compare it to what a run started under.
 *
 * Called at safe checkpoints by the generation worker. A stale answer means the
 * backend changed mid-run and the run must stop rather than continue against a
 * provider the user no longer selected.
 */
export async function verifyBackendContextUnchanged(input: {
  client: SupabaseClient;
  projectId: string;
  startedEpoch: number;
  startedProvider: BackendContextRow["backend_provider"];
}): Promise<
  | { ok: true; context: BackendAgentContext }
  | { ok: false; code: BackendContextFailureCode; message: string }
  | { ok: false; code: "stale"; message: string }
> {
  const current = await resolveBackendContext({
    client: input.client,
    projectId: input.projectId,
  });
  if (current.ok === false) {
    return { ok: false, code: current.code, message: current.message };
  }

  const staleness = detectStaleBackendContext({
    startedEpoch: input.startedEpoch,
    currentEpoch: current.row.selection_epoch,
    startedProvider: input.startedProvider,
    currentProvider: current.row.backend_provider,
  });

  if (staleness.stale) {
    return { ok: false, code: "stale", message: staleness.message };
  }
  return { ok: true, context: current.context };
}
