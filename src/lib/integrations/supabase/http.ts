/**
 * Route-handler helpers for the Supabase integration. Server-only.
 */

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/server";
import {
  supabaseIntegrationConfig,
  type SupabaseIntegrationConfig,
} from "./config";
import type { SupabaseOAuthErrorCode } from "./oauth";
import type { StoreErrorCode } from "./store";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" } as const;

export function apiData<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status, headers: NO_STORE });
}

export function apiError(
  code: string,
  message: string,
  status: number,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: message, code },
    { status, headers: NO_STORE },
  );
}

export function unauthenticated(): NextResponse {
  return apiError(
    "UNAUTHENTICATED",
    "You must be signed in to do that.",
    401,
  );
}

export function integrationNotConfigured(): NextResponse {
  return apiError(
    "SUPABASE_INTEGRATION_NOT_CONFIGURED",
    "The Supabase integration is not configured on this deployment.",
    503,
  );
}

export type AuthOk = { ok: true; userId: string };
export type AuthFailure = { ok: false; response: NextResponse };
export type AuthResult = AuthOk | AuthFailure;

export function isAuthFailure(result: AuthResult): result is AuthFailure {
  return result.ok === false;
}

export async function requireIntegrationUser(): Promise<AuthResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, response: unauthenticated() };
  return { ok: true, userId: user.id };
}

export type ConfigOk = { ok: true; config: SupabaseIntegrationConfig };
export type ConfigFailure = { ok: false; response: NextResponse };
export type ConfigResult = ConfigOk | ConfigFailure;

export function isConfigFailure(result: ConfigResult): result is ConfigFailure {
  return result.ok === false;
}

export function requireIntegrationConfig(): ConfigResult {
  const result = supabaseIntegrationConfig();
  if (!result.ok) {
    return { ok: false, response: integrationNotConfigured() };
  }
  return result;
}

type FailureCode = StoreErrorCode | SupabaseOAuthErrorCode | "reconnect_required";

const FAILURE_MESSAGES: Record<FailureCode, string> = {
  store_unavailable: "The Supabase connection could not be read.",
  not_connected: "Connect Supabase first.",
  state_missing: "This Supabase connection request is no longer valid.",
  state_expired: "This Supabase connection request has expired.",
  state_invalid: "This Supabase connection request is not valid.",
  reconnect_required: "Reconnect Supabase to continue.",
  oauth_unavailable: "Supabase could not be reached. Try again.",
  oauth_invalid_response: "Supabase returned an unexpected response.",
  oauth_unauthorized: "Reconnect Supabase to continue.",
  oauth_insufficient_scope:
    "The Supabase connection is missing the required organization and project read scopes.",
  oauth_invalid_grant: "Reconnect Supabase to continue.",
  oauth_rate_limited: "Supabase is rate-limiting this request. Try again shortly.",
  oauth_failed: "Supabase rejected the request.",
};

export function integrationFailure(
  code: FailureCode,
  status?: number,
): NextResponse {
  const mappedStatus =
    status ??
    (code === "store_unavailable" || code === "state_invalid"
      ? 500
      : code === "not_connected" || code === "reconnect_required"
        ? 409
        : code === "state_missing" || code === "state_expired"
          ? 400
          : code === "oauth_rate_limited"
            ? 429
            : code === "oauth_insufficient_scope"
              ? 403
              : code === "oauth_invalid_response" ||
                  code === "oauth_unavailable" ||
                  code === "oauth_failed"
                ? 502
                : 401);

  return apiError(
    `SUPABASE_${code.toUpperCase()}`,
    FAILURE_MESSAGES[code],
    mappedStatus,
  );
}
