/**
 * Shared response/body handling for the public generated-app API.
 *
 * These routes have NO user session. They are exempted from the proxy's session
 * gate only because they authenticate themselves (project API key or provider
 * signature), so every response is `no-store` and never echoes an internal
 * exception or credential.
 */

import { NextResponse } from "next/server";

import type { PaymentResult } from "@/lib/integrations/payments/types";

export const NO_STORE = { "cache-control": "private, no-store, max-age=0" } as const;

export const MAX_GATEWAY_BODY_BYTES = 32_000;

export type BodyRead =
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse };

export async function readJsonBody(
  request: Request,
  maxBytes = MAX_GATEWAY_BODY_BYTES,
): Promise<BodyRead> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: validation("That request is too large.", 413) };
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: validation("Could not read the request body.", 400) };
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, response: validation("That request is too large.", 413) };
  }
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: validation("The request body must be JSON.", 400) };
  }
}

export function validation(error: string, status = 400): NextResponse {
  return NextResponse.json(
    { ok: false, error, code: "VALIDATION", data: null },
    { status, headers: NO_STORE },
  );
}

export function paymentResponse<T>(result: PaymentResult<T>): NextResponse {
  if (result.ok === false) {
    const headers: Record<string, string> = { ...NO_STORE };
    if (result.retryAfterSeconds) headers["retry-after"] = String(result.retryAfterSeconds);
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code, data: null },
      { status: result.status, headers },
    );
  }
  return NextResponse.json({ ok: true, data: result.data }, { headers: NO_STORE });
}
