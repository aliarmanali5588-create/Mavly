import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import {
  parseAdminGenerationFilter,
  type AdminGenerationDetail,
  type AdminGenerationSummary,
} from "@/lib/admin/console";
import type { AdminGenerationPage } from "@/lib/admin/types";

export const dynamic = "force-dynamic";

/**
 * ═══ GENERATION MONITOR — LIST + SUMMARY ════════════════════════════════════
 *
 * The list is `admin_generation_stream` (migration 28, extended by 50 to accept
 * the `cancelled` filter the monitor exposes). The counters are
 * `admin_generation_summary`, which reads the same `project_runs` rows, so the
 * cards and the table can never disagree about the backlog.
 *
 * ⚠️ `?detail=<runId>` returns one run's full operational detail instead of a
 * page. It is the same authorization path and the same table; the console opens
 * a detail drawer from a row and must not be able to read a run the list would
 * not show it.
 */

interface RpcSummary {
  queued: number;
  running: number;
  retryWait: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  staleLeases: number;
  deadLettered: number;
  oldestQueuedAt: string | null;
  lastHeartbeatAt: string | null;
  lastCompletedAt: string | null;
  avgDurationSeconds: number | string | null;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const params = request.nextUrl.searchParams;

  // ── One run's detail ──────────────────────────────────────────────────────
  const detailId = (params.get("detail") ?? "").trim();
  if (detailId !== "") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(detailId)) {
      return adminError(400, "INVALID_RUN_ID", "That is not a valid run id.");
    }
    try {
      const { data, error } = await withTimeout(
        auth.supabase.rpc("admin_generation_detail", { p_run_id: detailId }),
        8_000
      );
      if (error) {
        const missing = error.code === "PGRST202" || error.code === "42883";
        return adminError(
          503,
          missing ? "GENERATION_SCHEMA_MISSING" : "GENERATION_DETAIL_UNAVAILABLE",
          missing
            ? "The generation detail function is not installed. Apply supabase/migrations/50_admin_console_backend.sql."
            : "That run could not be read."
        );
      }
      if (!data) {
        return adminError(404, "RUN_NOT_FOUND", "That run does not exist.");
      }
      return adminJson({ ok: true, data: data as AdminGenerationDetail });
    } catch (error) {
      if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
        return adminError(504, "GENERATION_DETAIL_TIMEOUT", "The run detail query timed out.");
      }
      return adminError(503, "GENERATION_DETAIL_UNAVAILABLE", "That run could not be read.");
    }
  }

  // ── Page + counters ───────────────────────────────────────────────────────
  const status = parseAdminGenerationFilter(params.get("status"));
  const search = (params.get("q") ?? "").trim().slice(0, 120);
  const limit = boundedInteger(params.get("limit"), 10, 1, 50);
  const offset = boundedInteger(params.get("offset"), 0, 0, 100_000);

  try {
    const [pageResult, summaryResult] = await Promise.all([
      withTimeout(
        auth.supabase.rpc("admin_generation_stream", {
          p_status: status,
          p_search: search ? search : null,
          p_limit: limit,
          p_offset: offset,
        }),
        8_000
      ),
      withTimeout(auth.supabase.rpc("admin_generation_summary"), 8_000),
    ]);

    if (pageResult.error) {
      const missing = pageResult.error.code === "PGRST202" || pageResult.error.code === "42883";
      return adminError(
        503,
        missing ? "GENERATION_SCHEMA_MISSING" : "GENERATIONS_UNAVAILABLE",
        missing
          ? "The generation stream is not installed. Apply supabase/migrations/50_admin_console_backend.sql."
          : "The generation stream could not be read."
      );
    }

    const page = (pageResult.data as AdminGenerationPage | null) ?? {
      rows: [],
      total: 0,
      limit,
      offset,
      status,
      search: search || null,
    };

    /**
     * ⚠️ A MISSING SUMMARY IS NOT ZERO JOBS. If the counter function is absent
     * the cards report `null` and the UI shows "unavailable"; substituting zeros
     * would claim an empty queue that may not be empty.
     */
    const rawSummary = (summaryResult.error ? null : summaryResult.data) as RpcSummary | null;
    const summary: AdminGenerationSummary | null = rawSummary
      ? {
          queued: num(rawSummary.queued),
          running: num(rawSummary.running),
          retryWait: num(rawSummary.retryWait),
          completed: num(rawSummary.completed),
          failed: num(rawSummary.failed),
          cancelled: num(rawSummary.cancelled),
          interrupted: num(rawSummary.interrupted),
          staleLeases: num(rawSummary.staleLeases),
          deadLettered: num(rawSummary.deadLettered),
          oldestQueuedAt: rawSummary.oldestQueuedAt ?? null,
          lastHeartbeatAt: rawSummary.lastHeartbeatAt ?? null,
          lastCompletedAt: rawSummary.lastCompletedAt ?? null,
          avgDurationSeconds:
            rawSummary.avgDurationSeconds === null
              ? null
              : Number(rawSummary.avgDurationSeconds),
        }
      : null;

    return adminJson({
      ok: true,
      data: {
        page: {
          rows: Array.isArray(page.rows) ? page.rows : [],
          total: num(page.total),
          limit,
          offset,
          status,
          search: search || null,
        },
        summary,
        summaryAvailable: summary !== null,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "GENERATIONS_TIMEOUT", "The generation stream timed out.");
    }
    return adminError(503, "GENERATIONS_UNAVAILABLE", "The generation stream could not be read.");
  }
}
