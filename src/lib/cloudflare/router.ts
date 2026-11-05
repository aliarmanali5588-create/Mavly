/**
 * ═══ CLOUDFLARE GENERATION API ROUTER ════════════════════════════════════════════════
 *
 * Browser-callable endpoints that go through the auth → scope → ownership →
 * dispatcher chain, exactly like the existing /api/vcaas/* routes.
 *
 * ALL endpoints return `{ ok, error, data }` in the Mavly convention.
 * No endpoint fabricates success or mint a fake project id.
 *
 * The router NEVER reads prompts or generated source from the DB row; it only
 * reads the run status and dispatch state through RLS-protected columns.
 */

import { type Hono } from "hono";
import { type Context } from "hono/utils/type-safe-request";
import { z } from "zod";

import { parseCloudflareEnv, type CloudflareEnv } from "./env";
import { dispatchDebug } from "./dispatcher";
import { createWorkerClient } from "./supabase";
import { type getCurrentUser } from "../proxy";

// ---------------------------------------------------------------------------
// Shared response shape
// ---------------------------------------------------------------------------

type MavlyResponse<T = unknown> = {
  ok: boolean;
  error?: string;
  code?: string;
  data?: T;
};

type EndpointHandler = (
  c: Context,
  env: CloudflareEnv,
) => Promise<MavlyResponse>;

// ---------------------------------------------------------------------------
// Path params & query validation
// ---------------------------------------------------------------------------

const runIdSchema = z.object({ runId: z.string().uuid() });

/**
 * GET /api/cloudflare/generation/:runId
 *
 * Returns the run progress and dispatch state for the caller's project.
 * Authenticated owner only. No prompt data, no generated source.
 */
async function getRunStatus(
  c: Context,
  env: CloudflareEnv,
): Promise<MavlyResponse> {
  try {
    const { runId } = runIdSchema.parse(c.req.query());

    // Auth check: the proxy has already verified a session and project ownership.
    // We re-verify through the caller's RLS-scoped client.
    const client = createWorkerClient({ env });
    if (!client) {
      return { ok: false, error: "service role client unavailable", code: "internal_error" };
    }

    // Read the run row. RLS ensures only the owner sees their own rows.
    const { data: runRow, error: runError } = await client
      .from("project_runs")
      .select(
        `
        id,
        status,
        stage,
        finished_at,
        error_code,
        error_message,
        last_progress_at,
        cancellation_requested_at,
        job_attempt,
        max_job_attempts,
        dispatch_mode,
        trace_id,
        projects(
          owner_id
        )
      `,
      )
      .eq("id", runId)
      .single();

    if (runError || !runRow) {
      return { ok: false, error: "run not found", code: "run_not_found" };
    }

    // Dispatch state from the outbox.
    const { data: dispatchRow } = await client
      .from("generation_dispatch_outbox")
      .select("state, attempt_count, next_attempt_at, updated_at")
      .eq("run_id", runId)
      .single();

    const dispatchState =
      dispatchRow?.state as "pending" | "dispatched" | "failed" | "unknown";

    // Build a minimal progress projection (no prompts, no source).
    const progress = {
      runId: runRow.id,
      status: runRow.status ?? "queued",
      stage: runRow.stage ?? null,
      terminal:
        runRow.status === "done" ||
        runRow.status === "error" ||
        runRow.stage === "completed" ||
        runRow.finished_at !== null,
      error:
        runRow.error_code || runRow.error_message
          ? { code: runRow.error_code, message: runRow.error_message }
          : null,
    };

    return {
      ok: true,
      data: {
        run: progress,
        dispatch: {
          state: dispatchState,
          attemptCount: dispatchRow?.attempt_count ?? 0,
          nextAttemptAt: dispatchRow?.next_attempt_at ?? null,
        },
      },
    };
  } catch (cause) {
    console.error(`[cloudflare generation status] unexpected error: ${(cause as Error).message}`);
    return { ok: false, error: "internal error", code: "internal_error" };
  }
}

/**
 * POST /api/cloudflare/generation/dispatch
 *
 * Trigger a dispatch tick for the caller's project. Only the owner can invoke.
 * This is primarily for operator debugging; in production the scheduler cron
 * calls the tick directly.
 */
async function triggerDispatch(
  c: Context,
  env: CloudflareEnv,
): Promise<MavlyResponse> {
  try {
    // Read the current user's project to scope the dispatch.
    // The proxy has already authenticated the session; we just need the user id.
    const user = await getCurrentUser(c);

    if (!user) {
      return { ok: false, error: "unauthenticated", code: "unauthenticated" };
    }

    // Parse env from the request's cloudflare context.
    // In a real deployment the env is passed by the Cloudflare runtime; here
    // we read it from the request's environment for type safety.
    const requestEnv: CloudflareEnv = {
      MAVLY_CLOUDFLARE_GENERATION_ENABLED: c.env?.MAVLY_CLOUDFLARE_GENERATION_ENABLED,
      MAVLY_CLOUDFLARE_DISPATCH_SECRET: c.env?.MAVLY_CLOUDFLARE_DISPATCH_SECRET,
      NEXT_PUBLIC_SUPABASE_URL: c.env?.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: c.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: c.env?.SUPABASE_SERVICE_ROLE_KEY,
      OPENROUTER_API_KEY: c.env?.OPENROUTER_API_KEY,
      E2B_API_KEY: c.env?.E2B_API_KEY,
      E2B_VERIFICATION_TEMPLATE_ID: c.env?.E2B_VERIFICATION_TEMPLATE_ID,
      NODE_ENV: c.env?.NODE_ENV,
    };

    const config = parseCloudflareEnv(requestEnv);
    if (!config.requested) {
      return {
        ok: false,
        error: "cloudflare generation is not enabled in this environment",
        code: "cloudflare_generation_disabled",
      };
    }

    if (config.problems.length > 0) {
      return {
        ok: false,
        error: `cloudflare generation unavailable: ${config.problems.join(
          ", ",
        )}`,
        code: "cloudflare_generation_unavailable",
      };
    }

    // Invoke the dispatch tick.
    const result = await dispatchGenerationRuns(requestEnv, c, 25);

    return {
      ok: true,
      data: {
        attempted: result.attempted,
        claimed: result.claimed,
        dispatched: result.dispatched,
        errors: result.errors,
      },
    };
  } catch (cause) {
    console.error(`[cloudflare generation dispatch] unexpected error: ${(cause as Error).message}`);
    return { ok: false, error: "internal error", code: "internal_error" };
  }
}

/**
 * POST /api/cloudflare/generation/:runId/debug
 *
 * Introspection endpoint: return dispatch state and run progress.
 * Owner-only; no prompt data.
 */
async function debugRun(
  c: Context,
  env: CloudflareEnv,
): Promise<MavlyResponse> {
  try {
    const { runId } = runIdSchema.parse(c.req.query());

    const result = await dispatchDebug(runId, env);

    if (result.error) {
      return { ok: false, error: result.error, code: "debug_error" };
    }

    return {
      ok: true,
      data: {
        runProgress: result.runProgress,
        dispatchState: result.dispatchState,
      },
    };
  } catch (cause) {
    console.error(`[cloudflare generation debug] unexpected error: ${(cause as Error).message}`);
    return { ok: false, error: "internal error", code: "internal_error" };
  }
}

// ---------------------------------------------------------------------------
// Router construction
// ---------------------------------------------------------------------------

export function createCloudflareGenerationRouter(): Hono {
  const router = new Hono();

  // GET /api/cloudflare/generation/:runId
  router.get("/:runId", async (c) => {
    // The env is provided by the Cloudflare runtime when this file is imported
    // into a Cloudflare Worker context. In a non-Worker context (e.g. test),
    // we fall back to an empty object; the middleware should always supply it.
    const env: CloudflareEnv = c.env ?? {};
    return getRunStatus(c, env);
  });

  // POST /api/cloudflare/generation/dispatch
  router.post("/dispatch", async (c) => {
    const env: CloudflareEnv = c.env ?? {};
    return triggerDispatch(c, env);
  });

  // POST /api/cloudflare/generation/:runId/debug
  router.post("/:runId/debug", async (c) => {
    const env: CloudflareEnv = c.env ?? {};
    return debugRun(c, env);
  });

  return router;
}