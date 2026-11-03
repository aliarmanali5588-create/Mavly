import type { NextRequest } from "next/server";

import { adminError, adminJson, boundedInteger, requireAdmin, withTimeout } from "@/lib/admin/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const search = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
  const status = (request.nextUrl.searchParams.get("status") ?? "all").trim().toLowerCase();
  const limit = boundedInteger(request.nextUrl.searchParams.get("limit"), 50, 1, 100);
  const offset = boundedInteger(request.nextUrl.searchParams.get("offset"), 0, 0, 100_000);
  try {
    const { data, error } = await withTimeout(auth.supabase.rpc("admin_billing_overview", {
      p_limit: limit,
      p_offset: offset,
      p_search: search || null,
      p_status: status,
    }), 8_000);
    if (error) return adminError(503, "BILLING_SCHEMA_MISSING", "Platform billing is not installed. Apply migrations 57_platform_billing.sql and 59_inr_billing_and_ai_costs.sql.");
    return adminJson({ ok: true, data: data ?? null });
  } catch (error) {
    return adminError(error instanceof Error && error.message === "ADMIN_TIMEOUT" ? 504 : 503, "BILLING_UNAVAILABLE", "Platform billing data could not be loaded.");
  }
}
