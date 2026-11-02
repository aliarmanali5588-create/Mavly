import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE } from "@/lib/auth/oauth-url";
import { isSupabaseAuthCookieName } from "@/lib/auth/session-cookies";
import {
  createSupabaseRequestClient,
  type CookieToSet,
} from "@/lib/supabase/server";

/**
 * Signs the current user out.
 *
 * POST only: a GET sign-out can be triggered by any third-party page, so the
 * endpoint refuses to act on a safe method. The client sends the request and
 * follows the redirect.
 *
 * ⚠️ THE CLEARED COOKIES ARE APPLIED TO THE RESPONSE WE RETURN. `signOut()`
 * queues the removal of the session cookies; they are attached explicitly so
 * the browser really forgets the session (see the same note in the callback).
 *
 * ⚠️ SIGNING OUT MUST ALSO WORK WHEN THE AUTH SERVER DOES NOT ANSWER. The
 * normal path is a global sign-out, which revokes the refresh token server-side
 * and removes the local session. If that cannot complete (network failure, or a
 * session the client can no longer refresh), a local sign-out is attempted; if
 * the client still cannot queue the removals, the Supabase auth cookies are
 * expired directly. Otherwise a visitor with a dead session would be unable to
 * sign out at all — and the new root redirect would keep sending them to the
 * builder.
 */
export async function POST(request: NextRequest) {
  const origin = request.nextUrl.origin;

  const clearedCookies: CookieToSet[] = [];

  // Collected before signing out: the direct-clear fallback below can only name
  // cookies that were on the incoming request.
  const authCookieNames = request.cookies
    .getAll()
    .map(({ name }) => name)
    .filter(isSupabaseAuthCookieName);

  const supabase = createSupabaseRequestClient(request, (cookies) => {
    clearedCookies.push(...cookies);
  });

  if (supabase) {
    // Revoke the caller's separate admin grant before removing the Supabase
    // session. The RPC derives the current Auth UUID/session_id and cannot
    // revoke another administrator's session. Older deployments without the
    // additive admin-auth migration fall through to the normal sign-out path.
    try {
      await supabase.rpc("revoke_current_admin_session");
    } catch {
      // Local cookie removal must still complete if the optional RPC is absent.
    }

    try {
      await supabase.auth.signOut();
    } catch {
      // Fall through: the local removals below still sign this browser out.
    }

    if (clearedCookies.length === 0) {
      try {
        // No Auth-server round trip. Removes the stored session even when the
        // server is unreachable or the stored refresh token is already dead.
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // The direct cookie clear below is the last resort.
      }
    }
  }

  // Back to the public marketing page: signing out should not land the visitor
  // on a page that immediately asks them to sign in again.
  const response = NextResponse.redirect(new URL("/", origin), 303);

  for (const { name, value, options } of clearedCookies) {
    response.cookies.set(name, value, options);
  }

  // A session the client could not refresh cannot be removed by it either;
  // expiring the cookies it lives in is the only way out.
  if (clearedCookies.length === 0) {
    for (const name of authCookieNames) {
      response.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
  }

  // The one-time OAuth flow cookies are not part of the session.
  response.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  response.cookies.set(OAUTH_NEXT_COOKIE, "", { path: "/", maxAge: 0 });

  response.headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  return response;
}
