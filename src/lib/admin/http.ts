import { NextResponse } from "next/server";

import { createSupabaseServerClient, getRequestUser } from "@/lib/supabase/server";

/**
 * Shared guard for `/api/adminsh/*`.
 *
 * Authority is `public.current_user_admin_status()` evaluated for the caller's
 * own verified session — never a header, body, cookie or client flag. The same
 * database check enforces the fixed eight-hour admin grant.
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
  | { ok: true; supabase: ServerSupabase; user: { id: string; email: string | null } }
  | { ok: false; response: NextResponse }
> {
  const user = await getRequestUser();
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
    const { data, error } = await supabase.rpc("current_user_admin_status");
    if (error) {
      return {
        ok: false,
        response: adminError(
          503,
          "ADMIN_SCHEMA_MISSING",
          "The admin authentication schema is not installed. Apply supabase/migrations/55_admin_authentication.sql."
        ),
      };
    }
    if (data === "expired") {
      return {
        ok: false,
        response: adminError(401, "ADMIN_SESSION_EXPIRED", "Your admin session expired. Sign in again."),
      };
    }
    if (data === "needs_login") {
      return {
        ok: false,
        response: adminError(401, "ADMIN_AUTHENTICATION_REQUIRED", "Admin authentication required."),
      };
    }
    if (data !== "active") {
      return {
        ok: false,
        response: adminError(403, "FORBIDDEN", "This account is not authorized to access the Mavly Admin Panel."),
      };
    }
  } catch {
    return {
      ok: false,
      response: adminError(503, "ADMIN_CHECK_UNAVAILABLE", "The admin check could not be completed."),
    };
  }

  return {
    ok: true,
    supabase,
    /**
     * The verified caller. Routes that record an audit trail need to know WHO
     * acted; this is the Auth-server-verified identity, never a header or body.
     */
    user: { id: user.id, email: user.email ?? null },
  };
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
