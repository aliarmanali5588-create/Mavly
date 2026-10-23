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
import { getAccount, isGithubServiceFailure } from "@/lib/integrations/github/service";
import { revokeAccessToken } from "@/lib/integrations/github/oauth";
import {
  deleteConnection,
  getRepositoryConnection,
  isGithubStoreFailure,
  readTokens,
} from "@/lib/integrations/github/store";
import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";

/**
 * The caller's GitHub connection, and the project's repository connection.
 *
 * ⚠️ NEVER RETURNS A TOKEN. The answer is a login, a list of organizations and
 * a summary of the connection.
 */
export async function GET(request: NextRequest) {
  const auth = await requireGithubUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireGithubConfig();
  if (isConfigFailure(config)) return config.response;

  const projectId = request.nextUrl.searchParams.get("projectId");

  let connection: {
    repositoryFullName: string;
    owner: string;
    repository: string;
    branch: string;
    defaultBranch: string;
    lastSyncedCommitSha: string | null;
    lastPushedCommitSha: string | null;
    lastPushedAt: string | null;
    syncStatus: string;
    firstPushPending: boolean;
  } | null = null;

  if (projectId) {
    /**
     * ⚠️ THE PROJECT IS AUTHORIZED FIRST. A repository connection is only ever
     * read for a project the caller owns.
     */
    const authorized = await authorizeProjectRequest(projectId);
    if ("response" in authorized) return authorized.response;

    const stored = await getRepositoryConnection(projectId);
    if (isGithubStoreFailure(stored)) {
      return apiError(
        "GITHUB_STORE_UNAVAILABLE",
        "The GitHub connection could not be read.",
        500,
      );
    }
    if (stored.data) {
      connection = {
        repositoryFullName: stored.data.repository_full_name,
        owner: stored.data.owner_login,
        repository: stored.data.repository_name,
        branch: stored.data.branch,
        defaultBranch: stored.data.default_branch,
        lastSyncedCommitSha: stored.data.last_synced_commit_sha,
        lastPushedCommitSha: stored.data.last_pushed_commit_sha,
        lastPushedAt: stored.data.last_pushed_at,
        syncStatus: stored.data.sync_status,
        firstPushPending: stored.data.sync_message === "first_push_pending",
      };
    }
  }

  const account = await getAccount(auth.userId, config.config);
  if (isGithubServiceFailure(account)) {
    if (account.code === "github_not_connected") {
      return apiData({ connected: false, login: null, organizations: [], connection });
    }
    return githubFailure(account.code);
  }

  return apiData({
    connected: true,
    login: account.data.login,
    organizations: account.data.organizations,
    connection,
  });
}

/**
 * DELETE — disconnect the GitHub ACCOUNT.
 *
 * ⚠️ THE TOKEN IS REVOKED AT GITHUB, not just forgotten here. The connection
 * row is deleted whatever GitHub answers: the user must be able to detach even
 * when GitHub is unreachable.
 *
 * ⚠️ NOTHING LOCAL IS TOUCHED. The project's source and its recovery points
 * stay exactly where they are.
 */
export async function DELETE() {
  const auth = await requireGithubUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireGithubConfig();
  if (isConfigFailure(config)) return config.response;

  const stored = await readTokens(auth.userId, config.config);
  if (!isGithubStoreFailure(stored)) {
    await revokeAccessToken(config.config, stored.data.accessToken);
  }

  const deleted = await deleteConnection(auth.userId);
  if (isGithubStoreFailure(deleted)) {
    return apiError(
      "GITHUB_STORE_UNAVAILABLE",
      "The GitHub connection could not be removed.",
      500,
    );
  }
  return apiData({ disconnected: true });
}
