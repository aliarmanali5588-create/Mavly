import type { NextRequest } from "next/server";

import { adminError, adminJson, requireAdmin } from "@/lib/admin/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const body = (await request.json().catch(() => null)) as { userId?: unknown; countryCode?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const countryCode = typeof body?.countryCode === "string" ? body.countryCode.trim().toUpperCase() : "";
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^[A-Z]{2}$/.test(countryCode)) return adminError(400, "INVALID_REQUEST", "A valid userId and ISO countryCode are required.");
  const { data, error } = await auth.supabase.rpc("admin_set_billing_profile", { p_user_id: userId, p_country_code: countryCode, p_source: "operator" });
  if (error) return adminError(503, "BILLING_PROFILE_FAILED", "The billing profile could not be verified.");
  return adminJson({ ok: true, data });
}
