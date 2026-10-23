import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import {
  apiData,
  githubFailure,
  isAuthFailure,
  isConfigFailure,
  requireGithubConfig,
  requireGithubUser,
} from "@/lib/integrations/github/http";
import { importProjectSource, isGithubServiceFailure } from "@/lib/integrations/github/service";

/**
 * Import a branch's source over the project.
 *
 * ⚠️ TWO STEPS. Without `confirm`, this answers the PLAN — what would be
 * added, changed and removed — and changes nothing. With `confirm`, the
 * project's current source is captured as a recovery point first, and only
 * then are the files written.
 *
 * ⚠️ AN IMPORT NEVER STARTS THE AGENT AND NEVER PUBLISHES. It only writes
 * files, so importing a repository cannot deploy anything.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const auth = await requireGithubUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireGithubConfig();
  if (isConfigFailure(config)) return config.response;

  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return authorized.response;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const imported = await importProjectSource(
    { userId: auth.userId, projectId, confirm: record.confirm === true },
    config.config,
  );

  if (isGithubServiceFailure(imported)) return githubFailure(imported.code);

  return apiData(imported.data);
}
