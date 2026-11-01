import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseOAuthConfig } from "@/lib/integrations/supabase/config";
import {
  SUPABASE_ACTIONS,
  executeBrokerAction,
} from "@/lib/integrations/supabase/broker";

/**
 * ═══ THE SUPABASE ACTION BROKER ENDPOINT ════════════════════════════════════
 *
 * The single server-side door between Mavly (UI or agent) and a customer's
 * Supabase project.
 *
 * ⚠️ THE REQUEST NAMES AN ACTION AND A PROJECT. It cannot name a host, a path, a
 * method or a header. `executeBrokerAction` re-runs the full authorization
 * decision against the live stored connection, so an approval cannot outlive a
 * revocation and a stale `approved: true` cannot authorize a different statement.
 *
 * ⚠️ THE RESPONSE NEVER CONTAINS A TOKEN. It contains the action's result or a
 * refusal code.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return authorized.response;

  const config = supabaseOAuthConfig();
  if (!config.ok) {
    return Response.json(
      {
        error: {
          code: "SUPABASE_OAUTH_NOT_CONFIGURED",
          message: "Supabase OAuth is not configured on this deployment.",
        },
      },
      { status: 503 },
    );
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const client = await createSupabaseServerClient();
  if (!client) {
    return Response.json(
      { error: { code: "BACKEND_NOT_CONFIGURED", message: "The backend is not configured." } },
      { status: 503 },
    );
  }

  const result = await executeBrokerAction({
    client,
    userId: authorized.team.userId,
    projectId,
    config: config.config,
    action: payload.action,
    projectRef: payload.projectRef,
    statement: payload.statement,
    /**
     * ⚠️ APPROVAL IS A BOOLEAN, NOT A TOKEN. It is only ever consulted for a
     * statement the broker itself classified as destructive, and the statement is
     * re-classified on this call, so approving one statement cannot approve
     * another.
     */
    approved: payload.approved === true,
  });

  if (result.ok === false) {
    const status =
      result.code === "approval_required"
        ? 409
        : result.code === "not_connected" || result.code === "token_expired" || result.code === "token_revoked"
          ? 409
          : result.code === "project_not_authorized" || result.code === "scope_missing"
            ? 403
            : result.code === "statement_blocked"
              ? 422
              : result.code === "upstream_failed"
                ? 502
                : 400;

    return Response.json(
      {
        error: {
          code: result.code,
          message: result.message,
          retryableWithApproval: result.code === "approval_required",
        },
      },
      { status },
    );
  }

  return Response.json(
    { data: { action: result.action, result: result.data } },
    { headers: { "cache-control": "private, no-store" } },
  );
}

/** The action list, so a client never has to hardcode it. */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return authorized.response;

  return Response.json(
    { data: { actions: SUPABASE_ACTIONS } },
    { headers: { "cache-control": "private, no-store" } },
  );
}
