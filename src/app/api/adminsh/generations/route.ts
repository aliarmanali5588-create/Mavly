import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import type { AdminGenerationFilter, AdminGenerationPage } from "@/lib/admin/types";

export const dynamic = "force-dynamic";

const FILTERS: readonly AdminGenerationFilter[] = [
  "all",
  "completed",
  "running",
  "queued",
  "failed",
];

function parseFilter(value: string | null): AdminGenerationFilter {
  const normalized = (value ?? "").trim().toLowerCase();
  return FILTERS.includes(normalized as AdminGenerationFilter)
    ? (normalized as AdminGenerationFilter)
    : "all";
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const params = request.nextUrl.searchParams;
  const status = parseFilter(params.get("status"));
  const search = (params.get("q") ?? "").trim().slice(0, 120);
  const limit = boundedInteger(params.get("limit"), 10, 1, 50);
  const offset = boundedInteger(params.get("offset"), 0, 0, 100_000);

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_generation_stream", {
        p_status: status,
        p_search: search ? search : null,
        p_limit: limit,
        p_offset: offset,
      }),
      8_000
    );
    if (error) {
      return adminError(
        503,
        "GENERATIONS_UNAVAILABLE",
        "The generation stream is not available. Apply supabase/migrations/28_admin_overview.sql."
      );
    }
    const page = (data as AdminGenerationPage | null) ?? {
      rows: [],
      total: 0,
      limit,
      offset,
      status,
      search: search || null,
    };
    return adminJson({ ok: true, data: page });
  } catch {
    return adminError(504, "GENERATIONS_TIMEOUT", "The generation stream timed out.");
  }
}
