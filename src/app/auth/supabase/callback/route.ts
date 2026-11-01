import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/supabase/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeReturnTo } from "@/lib/integrations/github/crypto";
import { completeSupabaseOAuth } from "@/lib/integrations/supabase/service";

const DEFAULT_RETURN = "/dashboard";

function redirectWith(
  request: NextRequest,
  path: string,
  values: Record<string, string>,
): NextResponse {
  const url = new URL(safeReturnTo(path) ?? DEFAULT_RETURN, request.nextUrl.origin);
  for (const [key, value] of Object.entries(values)) {
    url.searchParams.set(key, value);
  }
  const response = NextResponse.redirect(url, 303);
  response.headers.set(
    "cache-control",
    "private, no-store, no-cache, must-revalidate, max-age=0",
  );
  return response;
}

function failure(request: NextRequest, path: string, reason: string): NextResponse {
  return redirectWith(request, path, { supabase: "error", reason });
}

/**
 * The Supabase Management API OAuth callback.
 *
 * ⚠️ THE MAVLY SESSION IS VERIFIED HERE even though this path is outside `/api/`.
 * The state row is consumed atomically and must belong to that same user, so a
 * callback URL cannot be replayed or attached to another account.
 *
 * ⚠️ NO TOKEN IS RETURNED TO THE BROWSER. The token pair is stored server-side as
 * a `pending_selection` row; the redirect carries only the project list the user
 * needs to choose from, and even that is re-derived server-side on selection.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    const login = new URL("/login", request.nextUrl.origin);
    login.searchParams.set("error", "session_expired");
    const response = NextResponse.redirect(login, 303);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    return response;
  }

  const state = request.nextUrl.searchParams.get("state");
  if (!state || state.length > 256) {
    return failure(request, DEFAULT_RETURN, "invalid_state");
  }

  const client = await createSupabaseServerClient();
  if (!client) {
    return failure(request, DEFAULT_RETURN, "not_configured");
  }

  const completed = await completeSupabaseOAuth({
    client,
    userId: user.id,
    state,
    code: request.nextUrl.searchParams.get("code"),
    error: request.nextUrl.searchParams.get("error"),
  });

  if (completed.ok === false) {
    /**
     * ⚠️ THE REASON IS A CODE, NOT A MESSAGE. An error string from the upstream
     * exchange could carry detail that does not belong in a URL.
     */
    return failure(request, DEFAULT_RETURN, completed.code.toLowerCase());
  }

  const { returnTo, projectId } = completed.data;

  /**
   * ⚠️ NO PROJECT LIST IN THE URL. The redirect carries only the outcome and the
   * Mavly project id. The picker fetches its options from the authenticated
   * endpoint, so customer project refs and names never enter browser history,
   * access logs or referrer headers.
   */
  return redirectWith(request, returnTo, {
    supabase: "select",
    ...(projectId ? { project: projectId } : {}),
  });
}
