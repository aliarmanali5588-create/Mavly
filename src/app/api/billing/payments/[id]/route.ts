import type { NextRequest } from "next/server";

import { readOwnedPayment } from "@/lib/billing/store";
import { billingError, billingJson, requireBillingUser } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireBillingUser();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const result = await readOwnedPayment(auth.supabase, auth.user.id, id);
  if (result.error) return billingError(503, "BILLING_UNAVAILABLE", "The payment could not be read.");
  if (!result.data) return billingError(404, "PAYMENT_NOT_FOUND", "That payment could not be found.");
  return billingJson({ ok: true, data: result.data });
}
