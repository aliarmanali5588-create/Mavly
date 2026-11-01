import type { NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import { startSupabaseOAuth } from "@/lib/integrations/supabase/service";

/**
 * Start the Supabase Management API OAuth flow.
 *
 * ⚠️ THIS ROUTE LIVES UNDER THE PROJECT IT CONNECTS. The project id is a path
 * segment, so the ownership check and the state row's `mavly_project_id` are the
 * same value by construction. An earlier version sat at
 * `/api/integrations/supabase/start`, where `context.params.projectId` was
 * always undefined: the flow could not start at all.
 *
 * ⚠️ THE MAVLY SESSION AND THE PROJECT OWNERSHIP ARE BOTH CHECKED HERE. The state
 * row is written against the verified user id, so the callback can only complete
 * for the same person who started it.
 *
 * ⚠️ THE RESPONSE CARRIES A URL AND NOTHING ELSE. No state, no verifier, no
 * secret: the browser is only told where to send the user.
 *
 * ⚠️ THE SESSION CLIENT, NOT THE REQUEST CLIENT. This route only READS the
 * session; it does not sign anyone in or out, so there are no cookies to write
 * onto a response. `createSupabaseRequestClient` requires a request and a cookie
 * sink, and calling it with neither is a type error rather than a working call.
 */
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
  const returnTo =
    body && typeof body === "object"
      ? (body as { returnTo?: unknown }).returnTo
      : undefined;

  const client = await createSupabaseServerClient();
  if (!client) {
    return Response.json(
      { error: { code: "BACKEND_NOT_CONFIGURED", message: "The backend is not configured." } },
      { status: 503 },
    );
  }

  /**
   * `authorized.team.userId` is the id the ownership lookup already verified
   * against this project, so the state row cannot be written for a different
   * account than the one that owns it.
   */
  const started = await startSupabaseOAuth({
    client,
    userId: authorized.team.userId,
    projectId,
    returnTo,
  });

  if (started.ok === false) {
    return Response.json(
      { error: { code: started.code, message: started.message } },
      { status: started.status },
    );
  }

  return Response.json(
    { data: started.data },
    { headers: { "cache-control": "private, no-store" } },
  );
}
