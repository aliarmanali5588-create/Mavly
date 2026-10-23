import type { NextRequest } from "next/server";

import {
  apiData,
  apiError,
  isAuthFailure,
  isConfigFailure,
  requireGithubConfig,
  requireGithubUser,
} from "@/lib/integrations/github/http";
import {
  pkceChallenge,
  randomToken,
  safeReturnTo,
  sha256Base64Url,
} from "@/lib/integrations/github/crypto";
import { buildAuthorizeUrl } from "@/lib/integrations/github/oauth";
import { createOAuthState, isGithubStoreFailure } from "@/lib/integrations/github/store";

/**
 * Start the GitHub authorization.
 *
 * ⚠️ THE STATE AND THE PKCE VERIFIER ARE GENERATED SERVER-SIDE and stored as a
 * single-use row. The browser only ever receives the authorization URL, so it
 * never holds a credential and never holds a verifier.
 */
export async function POST(request: NextRequest) {
  const auth = await requireGithubUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireGithubConfig();
  if (isConfigFailure(config)) return config.response;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const requestedReturn =
    body && typeof body === "object"
      ? (body as { returnTo?: unknown }).returnTo
      : undefined;
  const returnTo = safeReturnTo(requestedReturn) ?? "/dashboard";

  const state = randomToken(32);
  const codeVerifier = randomToken(48);
  const stateHash = sha256Base64Url(state);

  const saved = await createOAuthState(
    auth.userId,
    stateHash,
    codeVerifier,
    returnTo,
    config.config,
  );
  if (isGithubStoreFailure(saved)) {
    return apiError(
      "GITHUB_STORE_UNAVAILABLE",
      "The GitHub connection could not be started.",
      500,
    );
  }

  return apiData({
    authorizationUrl: buildAuthorizeUrl(
      config.config,
      state,
      pkceChallenge(codeVerifier),
    ),
  });
}
