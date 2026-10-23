import type { NextRequest } from "next/server";
import { apiData, apiError, integrationFailure, isAuthFailure, isConfigFailure, requireIntegrationConfig, requireIntegrationUser } from "@/lib/integrations/supabase/http";
import { pkceChallenge, randomToken, safeReturnTo, sha256Base64Url } from "@/lib/integrations/supabase/crypto";
import { buildAuthorizeUrl } from "@/lib/integrations/supabase/oauth";
import { createOAuthState, isStoreFailure } from "@/lib/integrations/supabase/store";

/**
 * Start the Supabase OAuth flow.
 *
 * The state and PKCE verifier are generated server-side and stored as a
 * single-use row. The browser only receives the authorize URL.
 */
export async function POST(request: NextRequest) {
  const auth = await requireIntegrationUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireIntegrationConfig();
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
  if (isStoreFailure(saved)) {
    return saved.code === "store_unavailable"
      ? integrationFailure("store_unavailable")
      : apiError(
          "SUPABASE_INTEGRATION_UNAVAILABLE",
          "The Supabase connection could not be started.",
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
