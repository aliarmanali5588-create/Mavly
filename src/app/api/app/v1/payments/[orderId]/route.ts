/**
 * GET /api/app/v1/payments/{orderId}
 *
 * Reads the recorded state of an order the caller's project created. The order
 * id is validated before it reaches a database function.
 */

import type { NextRequest } from "next/server";

import { paymentStatus } from "@/lib/integrations/payments/gateway";
import { paymentResponse } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params;
  const result = await paymentStatus({
    authorization: request.headers.get("authorization"),
    orderId,
  });
  return paymentResponse(result);
}
