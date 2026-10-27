/**
 * Catch-all `/api/vcaas/<path>` — Mavly's local builder API.
 *
 * Authentication, path classification and project ownership run first, in that
 * order. Only a verified owner reaches a handler. Implemented paths read and
 * write Supabase through the caller's RLS-scoped client and calls FreeModel for
 * website/code generation. Anything else answers the explicit `BACKEND_NOT_CONFIGURED`
 * 503 rather than pretending it worked.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  checkRequestIdentity,
  classifyVcaasRequest,
  type ScopeDenial,
} from "@/lib/vcaas-scope";
import { handleMavlyVcaasRequest } from "@/lib/mavly/api";
import {
  authFailed,
  backendNotConfigured,
  checkProjectAccess,
  resolveVcaasContext,
} from "../_shared";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Every refusal this route mints, in the app's `{ ok, error, code }` envelope. */
function scopeDenial(denial: ScopeDenial): NextResponse {
  return NextResponse.json(
    { ok: false, error: denial.message, code: denial.code },
    {
      status: denial.status,
      headers: { "cache-control": "private, no-store, max-age=0" },
    },
  );
}

async function handleRequest(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params;
    const method = req.method;

    // 1. A verified session, or 401. Never inferred from the presence of a cookie.
    const auth = await resolveVcaasContext();
    if (authFailed(auth)) return auth.response;

    // 2. The allowlist still decides whether the shape is a known, vetted path.
    const scope = classifyVcaasRequest(method, path);
    if (scope.kind === "deny") return scopeDenial(scope);

    const url = new URL(req.url);

    const contentLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
      return NextResponse.json(
        { ok: false, error: "That request is too large.", code: "VALIDATION", data: null },
        { status: 413, headers: { "cache-control": "private, no-store, max-age=0" } },
      );
    }

    // Parse the body once. Identity checks use it, and implemented handlers
    // receive the same parsed value.
    let parsedBody: unknown;
    if (method !== "GET" && method !== "HEAD") {
      try {
        const text = await req.text();
        if (text.length > 2_000_000) {
          return NextResponse.json(
            { ok: false, error: "That request is too large.", code: "VALIDATION", data: null },
            { status: 413, headers: { "cache-control": "private, no-store, max-age=0" } },
          );
        }
        if (text) {
          try {
            parsedBody = JSON.parse(text);
          } catch {
            // Not JSON: identity checks below treat a non-object as no project id.
          }
        }
      } catch {
        // No body.
      }
    }

    // 3. A body/query project id must agree with the path, and any project it
    // names must belong to this caller.
    const identity = checkRequestIdentity(scope, path, url.searchParams, parsedBody);
    if (identity.kind === "deny") return scopeDenial(identity);
    if (identity.kind === "authorize") {
      const denial = await checkProjectAccess(auth.team, identity.projectId);
      if (denial) return denial;
    }
    if (scope.kind === "project") {
      const denial = await checkProjectAccess(auth.team, scope.projectId);
      if (denial) return denial;
    }

    // 4. Authenticated and authorized. Implemented paths handle the request;
    // the rest are still explicitly unavailable.
    const handled = await handleMavlyVcaasRequest({
      method,
      segments: path,
      scope,
      userId: auth.team.userId,
      body: parsedBody,
      query: url.searchParams,
    });
    if (handled) return handled;

    return backendNotConfigured();
  } catch (error) {
    console.error(`[vcaas] ${req.method} request failed:`, error);
    return NextResponse.json(
      { ok: false, error: "Internal server error", code: "UNKNOWN", data: null },
      { status: 500 }
    );
  }
}

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const DELETE = handleRequest;
export const PATCH = handleRequest;
