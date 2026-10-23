"use client";

/**
 * ═══ THE BROWSER'S GITHUB CLIENT ═══════════════════════════════════════════
 *
 * One typed function per operation, each mapped to a same-origin
 * `/api/integrations/github/*` route.
 *
 * ⚠️ NO CREDENTIAL EVER TRAVELS THROUGH HERE. The browser asks the server to
 * start an authorization and receives a URL; the token itself is created,
 * encrypted and stored on the server. There is no field in this module for a
 * personal access token, and there never should be one.
 *
 * ⚠️ KEEP THIS FILE FREE OF `process.env` READS AND SERVER-ONLY IMPORTS. It
 * is imported by client components.
 */

export interface GithubUpstreamDetails {
  status: number;
  message: string | null;
  acceptedPermissions: string | null;
  /** The fixed GitHub REST route that failed, e.g. `POST /user/repos`. */
  operation: string;
}

export interface GithubApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  status?: number;
  conflict?: unknown;
  details?: GithubUpstreamDetails;
}

export interface GithubRepositorySummary {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  ownerType: string;
  defaultBranch: string | null;
  private: boolean;
  updatedAt: string | null;
}

export interface GithubBranchSummary {
  name: string;
  sha: string;
  protected: boolean;
}

export interface GithubBranchList {
  branches: GithubBranchSummary[];
  /** True when GitHub says the repository has never received a commit. */
  empty: boolean;
  defaultBranch: string | null;
}

export interface GithubOrganizationSummary {
  id: number;
  login: string;
}

export interface GithubConnectionSummary {
  repositoryFullName: string;
  owner: string;
  repository: string;
  branch: string;
  defaultBranch: string;
  lastSyncedCommitSha: string | null;
  lastPushedCommitSha: string | null;
  lastPushedAt: string | null;
  syncStatus: string;
  /** True when the connection is to an empty repository awaiting its first push. */
  firstPushPending: boolean;
}

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  organizations: GithubOrganizationSummary[];
  connection: GithubConnectionSummary | null;
}

export interface GithubImportPlan {
  added: string[];
  modified: string[];
  removed: string[];
  unchanged: string[];
  excluded: { path: string; reason: string }[];
  remoteCommitSha: string;
  diverged: boolean;
  /** Present only when the import actually ran. */
  recoverySnapshotId?: string;
  written?: string[];
}

export interface GithubPushResult {
  commitSha: string;
  commitUrl: string;
  changedPaths: string[];
  unchanged: boolean;
  branch: string;
  repositoryFullName: string;
}

async function request<T>(
  url: string,
  init?: RequestInit,
): Promise<GithubApiResponse<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const payload = (await response.json()) as GithubApiResponse<T> & {
      conflict?: unknown;
    };

    if (payload?.ok === false) {
      return {
        ok: false,
        error: payload.error,
        code: payload.code,
        status: response.status,
        conflict: payload.conflict,
        details: payload.details,
      };
    }
    return { ok: true, data: payload.data as T };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: "UNKNOWN",
    };
  }
}

const API = "/api/integrations/github";

export const githubApi = {
  /** POST …/start — the URL the browser is sent to in order to authorize. */
  start: (returnTo?: string): Promise<GithubApiResponse<{ authorizationUrl: string }>> =>
    request(`${API}/start`, {
      method: "POST",
      body: JSON.stringify(returnTo ? { returnTo } : {}),
    }),

  /** GET …/status — the account, and the project's repository connection. */
  status: (projectId?: string): Promise<GithubApiResponse<GithubStatus>> =>
    request(`${API}/status${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),

  /** GET …/repositories — the repositories this authorization can reach. */
  repositories: (): Promise<GithubApiResponse<{ repositories: GithubRepositorySummary[] }>> =>
    request(`${API}/repositories`),

  /**
   * POST …/repositories — create an empty repository on the authenticated
   * account and connect it to this project.
   *
   * The repository is created with the caller's GitHub token. No branch,
   * commit or file is created: the first real push does that.
   */
  createRepository: (
    projectId: string,
    body: {
      name: string;
      private: boolean;
      description?: string;
    },
  ): Promise<GithubApiResponse<{ connection: GithubConnectionSummary }>> =>
    request(`${API}/repositories`, {
      method: "POST",
      body: JSON.stringify({ projectId, ...body }),
    }),

  /**
   * DELETE …/status — disconnect the GitHub ACCOUNT.
   *
   * The token is revoked at GitHub and the stored connection is deleted. The
   * project's source and its recovery points are not touched.
   */
  disconnectAccount: (): Promise<GithubApiResponse<{ disconnected: boolean }>> =>
    request(`${API}/status`, { method: "DELETE" }),

  /** GET …/branches — the branches of one repository. */
  branches: (
    owner: string,
    repo: string,
  ): Promise<GithubApiResponse<GithubBranchList>> =>
    request(
      `${API}/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
    ),

  /** POST …/projects/{id}/connection — connect a repository and a branch. */
  connect: (
    projectId: string,
    body: { repositoryId: number; owner: string; repository: string; branch: string },
  ): Promise<GithubApiResponse<{ connection: GithubConnectionSummary }>> =>
    request(`${API}/projects/${encodeURIComponent(projectId)}/connection`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** DELETE …/projects/{id}/connection — detach the repository. */
  disconnect: (projectId: string): Promise<GithubApiResponse<{ disconnected: boolean }>> =>
    request(`${API}/projects/${encodeURIComponent(projectId)}/connection`, {
      method: "DELETE",
    }),

  /** POST …/projects/{id}/push — publish the project's source. */
  push: (
    projectId: string,
    body: { message?: string; allowRemoteAdvance?: boolean } = {},
  ): Promise<GithubApiResponse<GithubPushResult>> =>
    request(`${API}/projects/${encodeURIComponent(projectId)}/push`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /**
   * POST …/projects/{id}/import — import the branch's source.
   *
   * ⚠️ WITHOUT `confirm` THIS CHANGES NOTHING: it answers the plan. With it,
   * the project's source is replaced — after the current state has been saved
   * as a recovery point.
   */
  import: (
    projectId: string,
    confirm = false,
  ): Promise<GithubApiResponse<GithubImportPlan>> =>
    request(`${API}/projects/${encodeURIComponent(projectId)}/import`, {
      method: "POST",
      body: JSON.stringify({ confirm }),
    }),
};
