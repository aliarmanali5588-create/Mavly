import { apiData, integrationFailure, isAuthFailure, isConfigFailure, requireIntegrationConfig, requireIntegrationUser } from "@/lib/integrations/supabase/http";
import { getConnection, isStoreFailure, summarizeConnection } from "@/lib/integrations/supabase/store";

/**
 * The caller's connection state. Never returns token ciphertext.
 */
export async function GET() {
  const auth = await requireIntegrationUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireIntegrationConfig();
  if (isConfigFailure(config)) return config.response;

  const stored = await getConnection(auth.userId);
  if (isStoreFailure(stored)) return integrationFailure(stored.code);

  return apiData(summarizeConnection(stored.data));
}
