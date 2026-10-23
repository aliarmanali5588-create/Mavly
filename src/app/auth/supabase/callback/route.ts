import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/supabase/server";
import { supabaseIntegrationConfig } from "@/lib/integrations/supabase/config";
import { decryptSecret, safeReturnTo, sha256Base64Url } from "@/lib/integrations/supabase/crypto";
import { exchangeAuthorizationCode, isOAuthFailure, revokeRefreshToken } from "@/lib/integrations/supabase/oauth";
import {
  consumeOAuthState,
  getConnection,
  isStoreFailure,
  saveNewConnection,
} from "@/lib/integrations/supabase/store";

const DEFAULT_RETURN = "/dashboard";

function redirectWith(
  request: NextRequest,
  path: string,
  values: Record<string, string>,
): NextResponse {
  const url = new URL(
    safeReturnTo(path) ?? DEFAULT_RETURN,
    request.nextUrl.origin,
  );
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
 * Supabase OAuth callback.
 *
 * The Mavly session is verified here even though this path is outside `/api/`.
 * The state row is consumed atomically and must belong to that same user, so a
 * callback URL cannot be replayed or attached to another account.
 */
export async function GET(request: NextRequest) {
  const config = supabaseIntegrationConfig();
  if ("reason" in config) {
    return failure(request, DEFAULT_RETURN, "not_configured");
  }

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

  const consumed = await consumeOAuthState(
    user.id,
    sha256Base64Url(state),
    config.config,
  );
  if (isStoreFailure(consumed)) {
    return failure(request, DEFAULT_RETURN, consumed.code);
  }

  const returnTo = safeReturnTo(consumed.data.returnTo) ?? DEFAULT_RETURN;

  if (request.nextUrl.searchParams.get("error")) {
    return failure(request, returnTo, "access_denied");
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 4096) {
    return failure(request, returnTo, "missing_code");
  }

  const exchanged = await exchangeAuthorizationCode(
    config.config,
    code,
    consumed.data.codeVerifier,
  );
  if (isOAuthFailure(exchanged)) {
    return failure(request, returnTo, "exchange_failed");
  }

  const previous = await getConnection(user.id);
  const previousRefresh =
    !isStoreFailure(previous) && previous.data
      ? decryptSecret(
          config.config,
          previous.data.refresh_token_ciphertext,
          `supabase-refresh-token:${user.id}`,
        )
      : null;

  const saved = await saveNewConnection(
    user.id,
    exchanged.data,
    config.config,
  );
  if (isStoreFailure(saved)) {
    await revokeRefreshToken(config.config, exchanged.data.refreshToken);
    return failure(request, returnTo, "storage_failed");
  }

  // Best effort: revoke the grant this connection replaces. Never block or
  // report failure for it — the new connection is already stored.
  if (previousRefresh && previousRefresh !== exchanged.data.refreshToken) {
    await revokeRefreshToken(config.config, previousRefresh);
  }

  return redirectWith(request, returnTo, { supabase: "connected" });
}
