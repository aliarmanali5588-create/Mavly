import { NextResponse } from "next/server";

import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * Shared guard for `/api/adminsh/*`.
 *
 * Authority is `public.current_user_is_admin()` evaluated for the caller's own
 * session — never a header, body, cookie or client flag. A signed-in non-admin
 * receives the same 404 as a missing page (no account enumeration), while a
 * missing allowlist migration fails closed with an explicit configuration error.
 */

export const ADMIN_NO_STORE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
} as const;

type ServerSupabase = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

export function adminJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: ADMIN_NO_STORE_HEADERS });
}

export function adminError(status: number, code: string, error: string): NextResponse {
  return adminJson({ ok: false, code, error, data: null }, status);
}

export async function requireAdmin(): Promise<
  { ok: true; supabase: ServerSupabase } | { ok: false; response: NextResponse }
> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, response: adminError(401, "UNAUTHENTICATED", "Sign in required.") };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      ok: false,
      response: adminError(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured on this deployment."),
    };
  }

  try {
    const { data, error } = await supabase.rpc("current_user_is_admin");
    if (error) {
      return {
        ok: false,
        response: adminError(
          503,
          "ADMIN_SCHEMA_MISSING",
          "The admin allowlist schema is not installed. Apply supabase/migrations/18_admin_allowlist.sql."
        ),
      };
    }
    if (data !== true) {
      return { ok: false, response: adminError(404, "NOT_FOUND", "Not found") };
    }
  } catch {
    return {
      ok: false,
      response: adminError(503, "ADMIN_CHECK_UNAVAILABLE", "The admin check could not be completed."),
    };
  }

  return { ok: true, supabase };
}

/** Bound a database call so a stuck aggregate cannot hold the request open. */
export async function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ADMIN_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Clamp an integer query parameter without throwing on junk input. */
export function boundedInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = value === null ? NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
