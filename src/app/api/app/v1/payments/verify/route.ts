/**
 * POST /api/app/v1/payments/verify
 *
 * Verifies the Razorpay Checkout callback signature over `order_id|payment_id`
 * and then reads the payment back from Razorpay before recording `paid`.
 * A redirect or a browser-supplied claim can never call this successfully
 * without a real signature.
 */

import type { NextRequest, NextResponse } from "next/server";

import { verifyPayment } from "@/lib/integrations/payments/gateway";
import { paymentResponse, readJsonBody } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const read = await readJsonBody(request);
  if (!read.ok) return (read as { response: NextResponse }).response;

  const result = await verifyPayment({
    authorization: request.headers.get("authorization"),
    body: read.body,
  });
  return paymentResponse(result);
}
