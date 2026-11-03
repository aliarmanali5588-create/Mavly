import type { NextRequest } from "next/server";

import { readOwnedSubscription } from "@/lib/billing/store";
import { cancelDodoSubscription, dodoConfig } from "@/lib/billing/providers/dodo";
import { cancelRazorpaySubscription, razorpayConfig } from "@/lib/billing/providers/razorpay";
import { billingError, billingJson, recordOf, requireBillingUser } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireBillingUser();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const subscription = await readOwnedSubscription(auth.supabase, auth.user.id, id);
  if (subscription.error || !subscription.data) return billingError(404, "SUBSCRIPTION_NOT_FOUND", "That subscription could not be found.");
  const body = recordOf(await request.json().catch(() => null));
  const atPeriodEnd = body.atPeriodEnd !== false;
  try {
    if (subscription.data.provider === "razorpay") {
      const config = razorpayConfig();
      if (!config.configured) return billingError(503, "RAZORPAY_NOT_CONFIGURED", "Razorpay is not configured.");
      await cancelRazorpaySubscription(config, subscription.data.provider_subscription_id, atPeriodEnd);
    } else {
      const config = dodoConfig();
      if (!config.configured) return billingError(503, "DODO_NOT_CONFIGURED", "Dodo is not configured.");
      await cancelDodoSubscription(config, subscription.data.provider_subscription_id, atPeriodEnd);
    }
    return billingJson({ ok: true, data: { status: "pending_provider_confirmation", atPeriodEnd } });
  } catch {
    return billingError(502, "PROVIDER_REQUEST_FAILED", "The provider could not accept the cancellation request.");
  }
}
