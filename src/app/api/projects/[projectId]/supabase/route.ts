import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  disconnectSupabase,
  readSupabaseStatus,
  refreshConnection,
  selectSupabaseProject,
} from "@/lib/integrations/supabase/service";

/**
 * The owner-facing Supabase connection surface for one Mavly project.
 *
 *   GET    → connection metadata (never a token)
 *   POST   → { action: "select" | "refresh" | "disconnect" }
 *
 * ⚠️ EVERY METHOD RE-CHECKS PROJECT OWNERSHIP. `authorizeProjectRequest` verifies
 * the Mavly session and that the caller owns the project; the RPCs behind these
 * calls verify it again against `auth.uid()`, so neither layer is load-bearing on
 * its own.
 */
function errorResponse(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status });
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return authorized.response;

  const client = await createSupabaseServerClient();
  if (!client) {
    return errorResponse("BACKEND_NOT_CONFIGURED", "The backend is not configured.", 503);
  }

  const status = await readSupabaseStatus({ client, projectId });
  if (status.ok === false) return errorResponse(status.code, status.message, status.status);

  return Response.json(
    { data: status.data },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return authorized.response;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const action =
    body && typeof body === "object" ? (body as { action?: unknown }).action : null;

  const client = await createSupabaseServerClient();
  if (!client) {
    return errorResponse("BACKEND_NOT_CONFIGURED", "The backend is not configured.", 503);
  }

  if (action === "select") {
    const result = await selectSupabaseProject({
      client,
      userId: authorized.team.userId,
      projectId,
      supabaseProjectRef:
        body && typeof body === "object"
          ? (body as { supabaseProjectRef?: unknown }).supabaseProjectRef
          : undefined,
    });
    if (result.ok === false) return errorResponse(result.code, result.message, result.status);
    return Response.json({ data: result.data }, { headers: { "cache-control": "private, no-store" } });
  }

  if (action === "refresh") {
    const result = await refreshConnection({
      client,
      userId: authorized.team.userId,
      projectId,
    });
    if (result.ok === false) return errorResponse(result.code, result.message, result.status);
    return Response.json({ data: result.data }, { headers: { "cache-control": "private, no-store" } });
  }

  if (action === "disconnect") {
    const result = await disconnectSupabase({ client, projectId });
    if (result.ok === false) return errorResponse(result.code, result.message, result.status);
    return Response.json({ data: result.data }, { headers: { "cache-control": "private, no-store" } });
  }

  return errorResponse(
    "INVALID_ACTION",
    "Use one of: select, refresh, disconnect.",
    400,
  );
}
