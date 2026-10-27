/**
 * POST /api/app/v1/payments/orders
 *
 * Called by a published generated application's SERVER code with
 * `Authorization: Bearer <project API key>` (scope `integrations:*`). Creates a
 * Razorpay order through the project's own credentials, idempotently. Returns
 * only the publishable key id, order id, amount and currency — never a secret.
 */

import type { NextRequest, NextResponse } from "next/server";

import { createPaymentOrder } from "@/lib/integrations/payments/gateway";
import { paymentResponse, readJsonBody } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const read = await readJsonBody(request);
  if (!read.ok) return (read as { response: NextResponse }).response;

  const result = await createPaymentOrder({
    authorization: request.headers.get("authorization"),
    body: read.body,
  });
  return paymentResponse(result);
}
