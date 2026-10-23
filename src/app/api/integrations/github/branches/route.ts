import type { NextRequest } from "next/server";

import {
  apiData,
  apiError,
  githubFailure,
  isAuthFailure,
  isConfigFailure,
  requireGithubConfig,
  requireGithubUser,
} from "@/lib/integrations/github/http";
import { isGithubServiceFailure, listRepositoryBranches } from "@/lib/integrations/github/service";
import { isSafeOwner, isSafeRepoName } from "@/lib/integrations/github/safety";

/**
 * The branches of one repository, as the caller's authorization sees them.
 *
 * ⚠️ THE OWNER AND THE REPOSITORY NAME ARE VALIDATED BEFORE THEY ARE USED.
 * They are put into a URL path, and an unvalidated value in a path is how a
 * request ends up somewhere it was never meant to go.
 */
export async function GET(request: NextRequest) {
  const auth = await requireGithubUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireGithubConfig();
  if (isConfigFailure(config)) return config.response;

  const owner = request.nextUrl.searchParams.get("owner") ?? "";
  const repo = request.nextUrl.searchParams.get("repo") ?? "";

  if (!isSafeOwner(owner) || !isSafeRepoName(repo)) {
    return apiError(
      "GITHUB_NOT_FOUND",
      "That repository could not be found.",
      404,
    );
  }

  const branches = await listRepositoryBranches(auth.userId, config.config, owner, repo);
  if (isGithubServiceFailure(branches)) return githubFailure(branches.code);

  return apiData({
    branches: branches.data.branches,
    empty: branches.data.empty,
    defaultBranch: branches.data.defaultBranch,
  });
}
