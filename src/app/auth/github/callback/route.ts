import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/supabase/server";
import { githubIntegrationConfig } from "@/lib/integrations/github/config";
import {
  decryptSecret,
  safeReturnTo,
  sha256Base64Url,
} from "@/lib/integrations/github/crypto";
import {
  exchangeAuthorizationCode,
  getViewer,
  isGithubFailure,
  revokeAccessToken,
} from "@/lib/integrations/github/oauth";
import {
  consumeOAuthState,
  getConnection,
  isGithubStoreFailure,
  saveConnection,
} from "@/lib/integrations/github/store";

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
  return redirectWith(request, path, { github: "error", reason });
}

/**
 * The GitHub OAuth callback.
 *
 * ⚠️ THE MAVLY SESSION IS VERIFIED HERE even though this path is outside
 * `/api/`. The state row is consumed atomically and must belong to that same
 * user, so a callback URL cannot be replayed or attached to another account.
 *
 * ⚠️ THE TOKEN IS ENCRYPTED BEFORE IT IS STORED, and it is never returned to
 * the browser. The redirect tells the user that the connection succeeded and
 * nothing else.
 */
export async function GET(request: NextRequest) {
  const config = githubIntegrationConfig();
  if (!config.ok) {
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
  if (isGithubStoreFailure(consumed)) {
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
  if (isGithubFailure(exchanged)) {
    return failure(request, returnTo, "exchange_failed");
  }

  /**
   * The account the token acts as. A token that cannot read its own profile is
   * not usable for anything here, so it is not stored.
   */
  const viewer = await getViewer(exchanged.data.accessToken);
  const account = viewer.ok ? { id: viewer.data.id, login: viewer.data.login } : null;

  const previous = await getConnection(user.id);
  const previousToken =
    !isGithubStoreFailure(previous) && previous.data
      ? decryptSecret(
          config.config.clientId,
          config.config.encryptionKey,
          previous.data.access_token_ciphertext,
          `github-access-token:${user.id}`,
        )
      : null;

  const saved = await saveConnection(user.id, exchanged.data, account, config.config);
  if (isGithubStoreFailure(saved)) {
    return failure(request, returnTo, "storage_failed");
  }

  // Best effort: revoke the token this connection replaces. The new connection
  // is already stored, so a failure here is never reported as a failure.
  if (previousToken && previousToken !== exchanged.data.accessToken) {
    await revokeAccessToken(config.config, previousToken);
  }

  return redirectWith(request, returnTo, { github: "connected" });
}
