import { NextResponse } from "next/server";
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
import { connectRepository, isGithubServiceFailure } from "@/lib/integrations/github/service";
import {
  deleteRepositoryConnection,
  getRepositoryConnection,
  isGithubStoreFailure,
} from "@/lib/integrations/github/store";

/**
 * The project's connected repository.
 *
 * ⚠️ EVERY OPHERE VERIFIES, IN THIS ORDER: a verified Mavly session, the
 * project's ownership row, and then the connection itself. A repository id or
 * a project id from the browser is never proof of anything.
 */
async function authorize(projectId: string) {
  const auth = await requireGithubUser();
  if (isAuthFailure(auth)) return { response: auth.response };

  const config = requireGithubConfig();
  if (isConfigFailure(config)) return { response: config.response };

  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return { response: authorized.response };

  return { userId: auth.userId, config: config.config };
}

/** GET — the connection this project has, if any. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorize(projectId);
  if ("response" in auth) return auth.response;

  const stored = await getRepositoryConnection(projectId);
  if (isGithubStoreFailure(stored)) {
    return apiError(
      "GITHUB_STORE_UNAVAILABLE",
      "The GitHub connection could not be read.",
      500,
    );
  }
  if (!stored.data) return apiData({ connection: null });

  return apiData({
    connection: {
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
    },
  });
}

/**
 * POST — connect a repository and a branch to this project.
 *
 * ⚠️ THE REPOSITORY MUST BE ONE THE CALLER'S OWN AUTHORIZATION CAN REACH. The
 * service looks the id up in that list; an id the authorization cannot see is
 * refused, whatever the browser sent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorize(projectId);
  if ("response" in auth) return auth.response;

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

  const repositoryId = Number(record.repositoryId);
  const owner = typeof record.owner === "string" ? record.owner : "";
  const repo = typeof record.repository === "string" ? record.repository : "";
  const branch = typeof record.branch === "string" ? record.branch : "";

  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    return apiError("GITHUB_VALIDATION", "Choose a repository to connect.", 400);
  }
  if (!owner || !repo || !branch) {
    return apiError("GITHUB_VALIDATION", "Choose a repository and a branch.", 400);
  }

  const connected = await connectRepository(
    { userId: auth.userId, projectId, repositoryId, owner, repo, branch },
    auth.config,
  );
  if (isGithubServiceFailure(connected)) return githubFailure(connected.code);

  return apiData({
    connection: {
      repositoryFullName: connected.data.repository_full_name,
      owner: connected.data.owner_login,
      repository: connected.data.repository_name,
      branch: connected.data.branch,
      defaultBranch: connected.data.default_branch,
      lastSyncedCommitSha: connected.data.last_synced_commit_sha,
      lastPushedCommitSha: connected.data.last_pushed_commit_sha,
      lastPushedAt: connected.data.last_pushed_at,
      syncStatus: connected.data.sync_status,
      firstPushPending: connected.data.sync_message === "first_push_pending",
    },
  });
}

/**
 * DELETE — detach the repository.
 *
 * ⚠️ NOTHING IS DELETED ON GITHUB AND NOTHING IS DELETED LOCALLY. The
 * project's source stays exactly where it is; only the link is removed.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorize(projectId);
  if ("response" in auth) return auth.response;

  const deleted = await deleteRepositoryConnection(projectId);
  if (isGithubStoreFailure(deleted)) {
    return apiError(
      "GITHUB_STORE_UNAVAILABLE",
      "The GitHub connection could not be removed.",
      500,
    );
  }
  return NextResponse.json(
    { ok: true, data: { disconnected: true } },
    { headers: { "cache-control": "private, no-store, max-age=0" } },
  );
}
