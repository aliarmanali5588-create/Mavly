import { apiData, integrationFailure, isAuthFailure, isConfigFailure, requireIntegrationConfig, requireIntegrationUser } from "@/lib/integrations/supabase/http";
import { isOAuthFailure, listOrganizations } from "@/lib/integrations/supabase/oauth";
import { getAccessToken, isAccessTokenFailure } from "@/lib/integrations/supabase/service";

export async function GET() {
  const auth = await requireIntegrationUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireIntegrationConfig();
  if (isConfigFailure(config)) return config.response;

  const token = await getAccessToken(auth.userId, config.config);
  if (isAccessTokenFailure(token)) return integrationFailure(token.code);

  const organizations = await listOrganizations(
    config.config,
    token.accessToken,
  );
  if (isOAuthFailure(organizations)) return integrationFailure(organizations.code);

  return apiData({ organizations: organizations.data });
}
