/**
 * POST /api/integrations/webhooks/razorpay/{webhookToken}
 *
 * Public by necessity: Razorpay has no Mavly session. The token identifies one
 * project's integration; the signed raw body is the authentication. The route
 * limits the body, verifies the signature before parsing, and deduplicates by
 * the SHA-256 of the signed body (the event-id header is unsigned).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { handleRazorpayWebhook } from "@/lib/integrations/payments/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BYTES = 256 * 1024;

const HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

function answer(status: number, code: string | null): NextResponse {
  return new NextResponse(JSON.stringify(code ? { ok: false, code } : { ok: true }), {
    status,
    headers: HEADERS,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return answer(415, "UNSUPPORTED_CONTENT_TYPE");
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return answer(413, "PAYLOAD_TOO_LARGE");
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return answer(400, "INVALID_REQUEST");
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
    return answer(413, "PAYLOAD_TOO_LARGE");
  }

  const { token } = await params;
  const result = await handleRazorpayWebhook({
    token,
    rawBody,
    signature: request.headers.get("x-razorpay-signature"),
    eventId: request.headers.get("x-razorpay-event-id"),
  });

  if (result.ok) return answer(result.status, null);
  if (result.status === 400) return answer(400, "INVALID_REQUEST");
  if (result.status === 401) return answer(401, "INVALID_SIGNATURE");
  if (result.status === 404) return answer(404, "NOT_FOUND");
  if (result.status === 503) return answer(503, "UNAVAILABLE");
  return answer(500, "PROCESSING_FAILED");
}
