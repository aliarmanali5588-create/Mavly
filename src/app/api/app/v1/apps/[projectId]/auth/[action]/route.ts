/**
 * POST /api/app/v1/apps/{projectId}/auth/{signup|login|logout}
 * GET  /api/app/v1/apps/{projectId}/auth/session
 *
 * Authentication for the generated application's END USERS. It is unrelated to
 * a Mavly session: this route never reads a Supabase cookie and never writes to
 * a Mavly table. Credentials live in the customer's Neon database.
 */

import type { NextRequest } from "next/server";

import { handleAuth } from "@/lib/app-data/auth-service";

import {
  badRequest,
  optionsResponse,
  readBody,
  requestOrigin,
  sessionTokenFromRequest,
  toResponse,
} from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; action: string }> };

async function run(request: NextRequest, params: Params["params"]) {
  const { projectId, action } = await params;
  const isPost = request.method === "POST";
  const body = isPost ? await readBody(request) : { ok: true as const, body: null };
  if (body.ok === false) return badRequest(body.status, "invalid_body");

  const result = await handleAuth({
    projectId,
    action,
    method: request.method,
    origin: requestOrigin(request),
    body: body.body,
    sessionToken: sessionTokenFromRequest(request, projectId),
  });
  return toResponse(result, projectId, requestOrigin(request));
}

export async function GET(request: NextRequest, { params }: Params) {
  return run(request, params);
}

export async function POST(request: NextRequest, { params }: Params) {
  return run(request, params);
}

export async function OPTIONS(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  return optionsResponse(projectId, requestOrigin(request));
}
