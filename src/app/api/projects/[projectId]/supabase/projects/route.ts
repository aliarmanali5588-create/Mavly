import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  listSelectableProjects,
  openSupabaseSelection,
} from "@/lib/integrations/supabase/service";

/**
 * The projects the stored Supabase token can see, for the selection picker.
 *
 * ⚠️ THIS EXISTS SO THE CALLBACK URL CARRIES NO PROJECT DATA. The previous flow
 * base64-encoded every project ref and name into a query parameter on the
 * redirect, which put customer project names into browser history, server access
 * logs and referrer headers. The list is now derived server-side from the
 * encrypted token row on demand.
 *
 * ⚠️ IT ALSO OPENS THE SELECTION SESSION. The picker needs both the options and
 * the single-use authorization to choose one, so they are issued together: the
 * list is derived from the token, and the session id is what the subsequent
 * `select` call must present. Neither is a project ref in a URL.
 *
 * ⚠️ OWNERSHIP IS CHECKED TWICE. `authorizeProjectRequest` verifies the Mavly
 * session and that the caller owns this project; the token read behind it is an
 * owner-checked RPC. Neither layer is load-bearing on its own.
 *
 * ⚠️ THE RESPONSE CONTAINS NO TOKEN AND NO KEY. Refs, names, organization slugs
 * and an opaque selection id only.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return authorized.response;

  const client = await createSupabaseServerClient();
  if (!client) {
    return Response.json(
      { error: { code: "BACKEND_NOT_CONFIGURED", message: "The backend is not configured." } },
      { status: 503 },
    );
  }

  const result = await listSelectableProjects({
    client,
    userId: authorized.team.userId,
    projectId,
  });
  if (result.ok === false) {
    return Response.json(
      { error: { code: result.code, message: result.message } },
      { status: result.status },
    );
  }

  /**
   * ⚠️ A FAILED SESSION IS NOT A FAILED LIST, BUT IT IS STILL A FAILED PICKER. A
   * selection without a session cannot be authorized, so the caller is told the
   * session is missing rather than being handed a list it cannot act on.
   */
  const selection = await openSupabaseSelection({ client, projectId });
  if (selection.ok === false) {
    return Response.json(
      { error: { code: selection.code, message: selection.message } },
      { status: selection.status },
    );
  }

  return Response.json(
    {
      data: {
        projects: result.data.projects,
        selectionId: selection.data.selectionId,
        selectionExpiresAt: selection.data.expiresAt,
      },
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
