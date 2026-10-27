import { NextResponse } from "next/server";

/**
 * Public configuration compatibility probe.
 *
 * The dashboard no longer calls this route. The response contract is retained
 * for existing callers and tests — `{ ok: true, data: { configured } }`.
 * `configured` describes the removed hosted builder key, not the local
 * OpenRouter/Supabase builder, so it stays `false`. That is truthful, exposes
 * no secret, and never implies the old upstream is connected.
 */
export function GET() {
  return NextResponse.json({
    ok: true,
    data: { configured: false },
  });
}
