import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import {
  apiData,
  apiError,
  githubFailure,
  isAuthFailure,
  isConfigFailure,
  requireGithubConfig,
  requireGithubUser,
} from "@/lib/integrations/github/http";
import { isSafeRepoName } from "@/lib/integrations/github/safety";
import {
  createRepositoryAndConnect,
  isGithubServiceFailure,
  listUserRepositories,
} from "@/lib/integrations/github/service";

/**
 * The repositories the caller's GitHub authorization can reach.
 *
 * ⚠️ THIS IS THE USER'S OWN LIST, SCOPED TO THE APP INSTALLATION. A GitHub
 * App user token cannot see repositories outside the installation selection,
 * so the route lists installations first and then each installation's
 * repositories. It is never widened beyond what GitHub reports.
 */
export async function GET() {
  const auth = await requireGithubUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireGithubConfig();
  if (isConfigFailure(config)) return config.response;

  const repositories = await listUserRepositories(auth.userId, config.config);
  if (isGithubServiceFailure(repositories)) {
    return githubFailure(repositories.code, {
      upstream: repositories.upstream,
      diagnostics: repositories.diagnostics,
    });
  }

  return apiData({
    repositories: repositories.data.repositories,
    repositorySelection: repositories.data.repositorySelection,
    installationUrl: repositories.data.installationUrl,
    installationSuspended: repositories.data.installationSuspended,
  });
}

/**
 * POST — create an empty repository on the authenticated user's account and
 * connect it to one of the caller's projects.
 *
 * ⚠️ ACCOUNT AND PROJECTS ARE BOTH PROVEN FIRST. The repository is created
 * with the caller's own GitHub token (no other account is reachable), and the
 * project id must be one the caller owns. Mavly never creates a placeholder
 * commit, file or branch; the repository stays empty until the first push.
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
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  if (!projectId) {
    return apiError("GITHUB_VALIDATION", "Choose a project to connect.", 400);
  }

  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return authorized.response;

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!isSafeRepoName(name)) {
    return apiError("GITHUB_VALIDATION", "Enter a valid repository name.", 400);
  }

  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  if (description.length > 350) {
    return apiError(
      "GITHUB_VALIDATION",
      "The description must be 350 characters or fewer.",
      400,
    );
  }

  const created = await createRepositoryAndConnect(
    {
      userId: auth.userId,
      projectId,
      name,
      private: record.private === true,
      description: description || null,
    },
    config.config,
  );
  if (isGithubServiceFailure(created)) {
    return githubFailure(created.code, {
      upstream: created.upstream,
      diagnostics: created.diagnostics,
    });
  }

  return apiData({
    connection: {
      repositoryFullName: created.data.repository_full_name,
      owner: created.data.owner_login,
      repository: created.data.repository_name,
      branch: created.data.branch,
      defaultBranch: created.data.default_branch,
      lastSyncedCommitSha: created.data.last_synced_commit_sha,
      lastPushedCommitSha: created.data.last_pushed_commit_sha,
      lastPushedAt: created.data.last_pushed_at,
      syncStatus: created.data.sync_status,
      firstPushPending: created.data.sync_message === "first_push_pending",
    },
  });
}
