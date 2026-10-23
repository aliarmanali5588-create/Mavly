import { apiData, apiError, integrationFailure, isAuthFailure, isConfigFailure, requireIntegrationConfig, requireIntegrationUser } from "@/lib/integrations/supabase/http";
import { decryptSecret } from "@/lib/integrations/supabase/crypto";
import { isOAuthFailure, revokeRefreshToken } from "@/lib/integrations/supabase/oauth";
import { deleteConnection, getConnection, isStoreFailure } from "@/lib/integrations/supabase/store";

/**
 * Revoke the Supabase grant, then remove the local encrypted connection.
 *
 * If revocation cannot be confirmed, the local row is kept so the user can
 * retry. Reporting a successful disconnect while leaving an active token
 * behind would be false.
 */
export async function POST() {
  const auth = await requireIntegrationUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireIntegrationConfig();
  if (isConfigFailure(config)) return config.response;

  const stored = await getConnection(auth.userId);
  if (isStoreFailure(stored)) return integrationFailure(stored.code);
  if (!stored.data) return apiData({ connected: false });

  const refreshToken = decryptSecret(
    config.config,
    stored.data.refresh_token_ciphertext,
    `supabase-refresh-token:${auth.userId}`,
  );
  if (!refreshToken) {
    const removed = await deleteConnection(auth.userId);
    if (isStoreFailure(removed)) return integrationFailure(removed.code);
    return apiData({ connected: false, revoked: false });
  }

  const revoked = await revokeRefreshToken(config.config, refreshToken);
  if (isOAuthFailure(revoked)) {
    if (revoked.code === "oauth_invalid_grant") {
      const alreadyInactive = await deleteConnection(auth.userId);
      if (isStoreFailure(alreadyInactive)) {
        return integrationFailure(alreadyInactive.code);
      }
      return apiData({ connected: false, revoked: false });
    }
    return apiError(
      "SUPABASE_REVOKE_FAILED",
      "Supabase access could not be revoked. Try disconnecting again.",
      502,
    );
  }

  const removed = await deleteConnection(auth.userId);
  if (isStoreFailure(removed)) return integrationFailure(removed.code);

  return apiData({ connected: false, revoked: true });
}
