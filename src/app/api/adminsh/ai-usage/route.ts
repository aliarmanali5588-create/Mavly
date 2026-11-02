import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import {
  parseAdminConsolePeriod,
  type AdminAiUsagePayload,
} from "@/lib/admin/console";

export const dynamic = "force-dynamic";

/**
 * ═══ AI USAGE & COST — READ ═════════════════════════════════════════════════
 *
 * Two real sources, and the route keeps them distinguishable:
 *
 *   1. `project_runs` — one row per generation, with the tokens and the
 *      provider-reported cost the run actually recorded. This is the only place
 *      a cost figure comes from.
 *   2. `ai_usage_attempts` — per-attempt metering written by the credit engine
 *      (migration 31). Absent on a deployment that never enabled it, in which
 *      case `attemptsAvailable` is false and the UI says so instead of showing
 *      an empty table as if nothing had happened.
 *
 * ⚠️ NO COST IS COMPUTED HERE. The route does not multiply tokens by a price it
 * happens to know. `reported_cost_usd` is written only when the provider
 * reported a cost, and `cost_known` marks it; everything else is counted as
 * unknown. Zero and unknown are different answers and are never merged.
 */

interface RpcUsage {
  period: string;
  window: { start: string; end: string };
  summary: AdminAiUsagePayload["summary"];
  models: AdminAiUsagePayload["models"];
  modelTotal: number;
  attempts: AdminAiUsagePayload["attempts"];
  attemptsAvailable: boolean;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const params = request.nextUrl.searchParams;
  const period = parseAdminConsolePeriod(params.get("period"));
  const model = (params.get("model") ?? "").trim().slice(0, 120);
  const limit = boundedInteger(params.get("limit"), 50, 1, 100);
  const offset = boundedInteger(params.get("offset"), 0, 0, 100_000);

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_ai_usage", {
        p_period: period,
        p_model: model ? model : null,
        p_limit: limit,
        p_offset: offset,
      }),
      8_000
    );

    if (error) {
      const missing = error.code === "PGRST202" || error.code === "42883";
      return adminError(
        503,
        missing ? "AI_USAGE_SCHEMA_MISSING" : "AI_USAGE_UNAVAILABLE",
        missing
          ? "The AI usage aggregate is not installed. Apply supabase/migrations/50_admin_console_backend.sql."
          : "AI usage could not be read."
      );
    }

    const usage = (data as RpcUsage | null) ?? null;
    if (!usage) {
      return adminError(503, "AI_USAGE_UNAVAILABLE", "The AI usage aggregate returned no data.");
    }

    const payload: AdminAiUsagePayload = {
      period,
      window: usage.window,
      summary: usage.summary,
      models: Array.isArray(usage.models) ? usage.models : [],
      modelTotal: Number(usage.modelTotal) || 0,
      attempts: Array.isArray(usage.attempts) ? usage.attempts : [],
      attemptsAvailable: usage.attemptsAvailable === true,
    };

    return adminJson({ ok: true, data: payload });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "AI_USAGE_TIMEOUT", "The AI usage query timed out.");
    }
    return adminError(503, "AI_USAGE_UNAVAILABLE", "AI usage could not be read.");
  }
}
