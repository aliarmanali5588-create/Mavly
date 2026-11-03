import { billingError, billingJson, requireBillingUser } from "../_shared";
import { readBillingEntitlements } from "@/lib/billing/entitlements";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireBillingUser();
  if (!auth.ok) return auth.response;
  const result = await readBillingEntitlements(auth.supabase);
  if (!result.ok) return billingError(503, (result as { ok: false; code: string }).code, (result as { ok: false; error: string }).error);
  return billingJson({ ok: true, data: result.data });
}
