import type { SupabaseClient } from "@supabase/supabase-js";

import type { BillingEntitlements } from "./types";

export type EntitlementFailure = {
  ok: false;
  code: "ENTITLEMENT_UNAVAILABLE" | "PLAN_REQUIRED" | "PROJECT_LIMIT_REACHED";
  error: string;
};

export async function readBillingEntitlements(
  client: SupabaseClient,
): Promise<{ ok: true; data: BillingEntitlements } | EntitlementFailure> {
  const { data, error } = await client.rpc("billing_user_entitlements");
  if (error || !data || typeof data !== "object") {
    return {
      ok: false,
      code: "ENTITLEMENT_UNAVAILABLE",
      error: "Billing entitlements are not available on this deployment.",
    };
  }
  const row = data as Record<string, unknown>;
  return {
    ok: true,
    data: {
      planId: typeof row.planId === "string" ? row.planId : "free",
      projectLimit: typeof row.projectLimit === "number" ? row.projectLimit : null,
      monthlyCredits: Number(row.monthlyCredits) || 0,
      purchasedCredits: Number(row.purchasedCredits) || 0,
      availableCredits: Number(row.availableCredits) || 0,
      subscriptionStatus:
        typeof row.subscriptionStatus === "string" ? (row.subscriptionStatus as BillingEntitlements["subscriptionStatus"]) : null,
      currentPeriodEnd: typeof row.currentPeriodEnd === "string" ? row.currentPeriodEnd : null,
      features: row.features && typeof row.features === "object" ? (row.features as Record<string, boolean>) : {},
    },
  };
}

export async function requireProjectCreationEntitlement(client: SupabaseClient): Promise<
  { ok: true; data: BillingEntitlements } | EntitlementFailure
> {
  const result = await readBillingEntitlements(client);
  if (!result.ok) return result;
  if (result.data.projectLimit !== null && result.data.projectLimit <= 0) {
    return { ok: false, code: "PROJECT_LIMIT_REACHED", error: "Your plan cannot create another project." };
  }
  return result;
}
