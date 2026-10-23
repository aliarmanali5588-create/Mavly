import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
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
 */
export async function POST(request: NextRequest) {
  const origin = request.nextUrl.origin;

  const clearedCookies: CookieToSet[] = [];

  const supabase = createSupabaseRequestClient(request, (cookies) => {
    clearedCookies.push(...cookies);
  });

  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch {
      // Even if the Auth server cannot be reached, the cookies queued above
      // are cleared on the response below.
    }
  }

  // Back to the public marketing page: signing out should not land the visitor
  // on a page that immediately asks them to sign in again.
  const response = NextResponse.redirect(new URL("/", origin), 303);

  for (const { name, value, options } of clearedCookies) {
    response.cookies.set(name, value, options);
  }

  response.headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  return response;
}
