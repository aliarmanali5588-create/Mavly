import type { NextRequest } from "next/server";
import { apiData, apiError, integrationFailure, isAuthFailure, isConfigFailure, requireIntegrationConfig, requireIntegrationUser } from "@/lib/integrations/supabase/http";
import { isOAuthFailure, listProjects } from "@/lib/integrations/supabase/oauth";
import { getAccessToken, isAccessTokenFailure } from "@/lib/integrations/supabase/service";
import { isStoreFailure, saveSelectedProject } from "@/lib/integrations/supabase/store";

/**
 * Persist a selected external Supabase project after confirming that the
 * authorized connection actually returns it. Names and organization metadata
 * come from Supabase, never from the request body.
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
  const projectRef =
    body && typeof body === "object"
      ? (body as { projectRef?: unknown }).projectRef
      : undefined;

  if (
    typeof projectRef !== "string" ||
    projectRef.length === 0 ||
    projectRef.length > 64 ||
    !/^[a-z0-9]+$/i.test(projectRef)
  ) {
    return apiError(
      "VALIDATION",
      "Choose a Supabase project from the available list.",
      400,
    );
  }

  const token = await getAccessToken(auth.userId, config.config);
  if (isAccessTokenFailure(token)) return integrationFailure(token.code);

  const projects = await listProjects(config.config, token.accessToken);
  if (isOAuthFailure(projects)) return integrationFailure(projects.code);

  const project = projects.data.find((item) => item.ref === projectRef);
  if (!project) {
    return apiError(
      "SUPABASE_PROJECT_NOT_FOUND",
      "That Supabase project is not available through this connection.",
      404,
    );
  }

  const saved = await saveSelectedProject(auth.userId, {
    ref: project.ref,
    name: project.name,
    organizationId: project.organizationId,
    organizationSlug: project.organizationSlug,
  });
  if (isStoreFailure(saved)) return integrationFailure(saved.code);

  return apiData(saved.data.summary);
}
