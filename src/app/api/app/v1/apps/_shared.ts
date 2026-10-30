/**
 * Shared plumbing for `/api/app/v1/apps/*`.
 *
 * These routes are public (the proxy exempts `/api/app/v1/`) and authenticate
 * themselves: a project id identifies a READY managed backend, and the end
 * user's own session token authorizes user-scoped data. Nothing here reads a
 * Mavly session, and nothing here returns a database credential.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  SESSION_TOKEN_PATTERN,
  sessionTokenFromCookie,
} from "@/lib/app-data/auth";
import { corsHeaders, preflightHeaders } from "@/lib/app-data/cors";
import type { GatewayResponse } from "@/lib/app-data/context";

const MAX_BODY_CHARS = 32 * 1024;

const BASE_HEADERS: Record<string, string> = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function requestOrigin(request: NextRequest): string | null {
  return request.headers.get("origin");
}

/** `Authorization: Bearer <session token>` wins over the scoped cookie. */
export function sessionTokenFromRequest(
  request: NextRequest,
  projectId: string,
): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const bearer = match?.[1]?.trim() ?? "";
  if (SESSION_TOKEN_PATTERN.test(bearer)) return bearer;
  return sessionTokenFromCookie(request.headers.get("cookie"), projectId);
}

export async function readBody(
  request: NextRequest,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400 };
  }
  if (text.length > MAX_BODY_CHARS) return { ok: false, status: 413 };
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

export function toResponse(
  result: GatewayResponse,
  projectId: string,
  origin: string | null,
): NextResponse {
  const headers = {
    ...BASE_HEADERS,
    ...corsHeaders(projectId, origin),
  };
  const response = NextResponse.json(result.body, {
    status: result.status,
    headers,
  });
  for (const cookie of result.cookies ?? []) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

export function badRequest(status: number, code: string): NextResponse {
  return NextResponse.json(
    { ok: false, code, error: "The request could not be read." },
    { status, headers: BASE_HEADERS },
  );
}

export function optionsResponse(
  projectId: string,
  origin: string | null,
): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...BASE_HEADERS,
      ...preflightHeaders(projectId, origin),
    },
  });
}
