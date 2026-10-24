/**
 * ═══ THE GITHUB CLIENT ═════════════════════════════════════════════════════
 *
 * Two jobs, in one place:
 *
 *   1. The OAuth handshake (authorize → code → token), with PKCE, for a GitHub
 *      App used with user-to-server tokens.
 *   2. The REST calls this integration needs: who the user is, which
 *      organizations they belong to, which repositories they can reach, and
 *      which branches a repository has.
 *
 * ⚠️ THE URLS ARE CONSTANTS. Nothing here accepts a client-supplied host, so
 * this is not an SSRF surface. A repository owner/name/branch is validated
 * (see `safety.ts`) before it is put into a path, and the path segment is
 * encoded.
 *
 * ⚠️ NO CREDENTIAL IS EVER LOGGED OR RETURNED. The `Authorization` header is
 * set on the request and never appears in an error, a log line or a response
 * body. Error responses from GitHub are summarised, not passed through.
 */

import {
  GITHUB_API_URL,
  GITHUB_AUTHORIZE_URL,
  GITHUB_TOKEN_URL,
  type GithubIntegrationConfig,
} from "./config";
import { isSafeBranchName, isSafeOwner, isSafeRepoName } from "./safety";

const TIMEOUT_MS = 20_000;
const USER_AGENT = "Mavly";

export type GithubErrorCode =
  | "github_unavailable"
  | "github_unauthorized"
  | "github_forbidden"
  | "github_not_found"
  | "github_rate_limited"
  | "github_conflict"
  | "github_invalid_response"
  | "github_failed"
  | "github_no_write_permission"
  | "github_empty_repository"
  | "github_repository_exists"
  | "github_sso_required"
  | "github_policy_blocked"
  | "github_abuse_blocked"
  | "github_email_unverified"
  | "github_tree_truncated";

export interface GithubUpstreamError {
  status: number;
  message: string | null;
  acceptedPermissions: string | null;
  operation: string;
}

export type GithubResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: GithubErrorCode; upstream?: GithubUpstreamError };

export function isGithubFailure<T>(
  result: GithubResult<T>,
): result is { ok: false; code: GithubErrorCode; upstream?: GithubUpstreamError } {
  return result.ok === false;
}

export interface GithubTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working, when GitHub says so. */
  expiresAt: string | null;
  /** The scopes GitHub granted, when it reports them. */
  scope: string | null;
}

function basicAuth(config: GithubIntegrationConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/**
 * Map a GitHub status code onto this integration's vocabulary.
 *
 * ⚠️ 422 IS A CONFLICT HERE, not a bad request: it is what the Git Data API
 * answers when a reference update is not a fast-forward, which is exactly the
 * "the branch moved under you" case.
 */
function mapStatus(status: number, body: string): GithubErrorCode {
  if (status === 401) return "github_unauthorized";
  if (status === 403) {
    if (/rate limit/i.test(body)) return "github_rate_limited";
    if (
      /resource not accessible by (integration|personal access token)|(need|must have) admin rights/i.test(
        body,
      )
    ) {
      return "github_no_write_permission";
    }
    if (/\bSAML\b|single sign-on|\bSSO\b/i.test(body)) return "github_sso_required";
    if (/verify your email/i.test(body)) return "github_email_unverified";
    if (
      /(repository creation|create repositories|create a repository)[^.]*(disabled|restricted|not allowed|forbidden)|disabled by your (organization|enterprise)/i.test(
        body,
      )
    ) {
      return "github_policy_blocked";
    }
    if (/\b(abuse|flagged|suspended|spam)\b/i.test(body)) return "github_abuse_blocked";
    return "github_forbidden";
  }
  if (status === 404) return "github_not_found";
  if (status === 409) return "github_conflict";
  if (status === 422) return "github_conflict";
  if (status === 429) return "github_rate_limited";
  return "github_failed";
}

function safeUpstreamText(value: string | null, max: number): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function nonEmptyString(value: unknown, max = 16_384): string | null {
  if (typeof value !== "string") return null;
  if (!value || value.length > max) return null;
  return value;
}

/* ───────────────────────────── OAuth ───────────────────────────── */

/**
 * The authorization URL.
 *
 * ⚠️ PKCE IS USED. The verifier never leaves the server; only its SHA-256
 * challenge travels to GitHub, so a stolen authorization code cannot be
 * exchanged by anyone else.
 */
export function buildAuthorizeUrl(
  config: GithubIntegrationConfig,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function parseTokenSet(body: unknown): GithubTokenSet | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const accessToken = nonEmptyString(value.access_token);
  if (!accessToken) return null;

  const expiresIn = typeof value.expires_in === "number" ? value.expires_in : null;
  const refreshToken = nonEmptyString(value.refresh_token, 4096);

  return {
    accessToken,
    refreshToken,
    expiresAt:
      expiresIn && Number.isFinite(expiresIn)
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null,
    scope: nonEmptyString(value.scope, 512),
  };
}

/** Exchange an authorization code for a user-to-server token. */
export async function exchangeAuthorizationCode(
  config: GithubIntegrationConfig,
  code: string,
  codeVerifier: string,
): Promise<GithubResult<GithubTokenSet>> {
  const response = await fetchWithTimeout(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!response) return { ok: false, code: "github_unavailable" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "github_invalid_response" };
  }

  if (!response.ok) {
    const error = (body as { error?: unknown })?.error;
    if (error === "incorrect_code_verifier" || error === "bad_verification_code") {
      return { ok: false, code: "github_unauthorized" };
    }
    return { ok: false, code: mapStatus(response.status, typeof error === "string" ? error : "") };
  }

  const tokens = parseTokenSet(body);
  return tokens ? { ok: true, data: tokens } : { ok: false, code: "github_invalid_response" };
}

/** Exchange a refresh token for a new access token. */
export async function refreshAccessToken(
  config: GithubIntegrationConfig,
  refreshToken: string,
): Promise<GithubResult<GithubTokenSet>> {
  const response = await fetchWithTimeout(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response) return { ok: false, code: "github_unavailable" };
  if (!response.ok) return { ok: false, code: mapStatus(response.status, "") };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "github_invalid_response" };
  }

  const tokens = parseTokenSet(body);
  return tokens ? { ok: true, data: tokens } : { ok: false, code: "github_invalid_response" };
}

/**
 * Revoke a token, so "disconnect" really ends the access.
 *
 * ⚠️ BEST EFFORT. The connection row is deleted whatever GitHub answers: the
 * user must be able to detach even when GitHub is unreachable.
 */
export async function revokeAccessToken(
  config: GithubIntegrationConfig,
  accessToken: string,
): Promise<boolean> {
  const response = await fetchWithTimeout(
    `https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: basicAuth(config),
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
  );
  return !!response && response.ok;
}

/* ───────────────────────────── REST ───────────────────────────── */

interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

/**
 * One authenticated call to the GitHub REST API.
 *
 * ⚠️ `redirect: "error"` and a timeout: a GitHub answer must never be able to
 * turn into an open request to somewhere else.
 */
async function githubApi(
  path: string,
  accessToken: string,
  options: ApiOptions = {},
): Promise<GithubResult<unknown>> {
  const response = await fetchWithTimeout(`${GITHUB_API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (!response) return { ok: false, code: "github_unavailable" };

  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const rawMessage = (body as { message?: unknown })?.message;
    const message = safeUpstreamText(
      typeof rawMessage === "string" ? rawMessage : null,
      500,
    );
    const acceptedPermissions = safeUpstreamText(
      response.headers.get("x-accepted-github-permissions"),
      300,
    );
    const route = path.split("?")[0] ?? path;

    return {
      ok: false,
      code: mapStatus(response.status, message ?? ""),
      upstream: {
        status: response.status,
        message,
        acceptedPermissions,
        operation: `${options.method ?? "GET"} ${route}`,
      },
    };
  }

  return { ok: true, data: body };
}

export interface GithubViewer {
  id: number;
  login: string;
  name: string | null;
}

export interface GithubOrganization {
  id: number;
  login: string;
}

export type GithubRepositorySelection = "all" | "selected" | null;

export interface GithubUserInstallation {
  id: number;
  targetId: number;
  targetType: string;
  targetLogin: string | null;
  repositorySelection: GithubRepositorySelection;
  permissions: Record<string, string> | null;
  appId: number | null;
  appSlug: string | null;
  clientId: string | null;
  suspended: boolean;
}

export interface GithubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  ownerType: string;
  /**
   * GitHub's configured default branch. An empty repository has no commits and
   * may not report one, so this is deliberately nullable rather than defaulted
   * to `main`.
   */
  defaultBranch: string | null;
  private: boolean;
  updatedAt: string | null;
}

export interface GithubRepositoryState {
  /** GitHub's configured default branch, when it reports one. */
  defaultBranch: string | null;
  /**
   * True only when GitHub's repository metadata says the repository has no
   * commits. Callers combine this with an empty branch list; neither signal is
   * used on its own.
   */
  empty: boolean;
}

export interface GithubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

/** Who the token acts as. */
export async function getViewer(accessToken: string): Promise<GithubResult<GithubViewer>> {
  const result = await githubApi("/user", accessToken);
  if (isGithubFailure(result)) return result;
  const row = result.data as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : null;
  const login = nonEmptyString(row.login, 200);
  if (id === null || !login) return { ok: false, code: "github_invalid_response" };
  return {
    ok: true,
    data: { id, login, name: nonEmptyString(row.name, 400) },
  };
}

/** The organizations the token's user belongs to. */
export async function listOrganizations(
  accessToken: string,
): Promise<GithubResult<GithubOrganization[]>> {
  const result = await githubApi("/user/orgs?per_page=100", accessToken);
  if (isGithubFailure(result)) return result;
  if (!Array.isArray(result.data)) return { ok: false, code: "github_invalid_response" };

  const organizations: GithubOrganization[] = [];
  for (const item of result.data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "number" ? row.id : null;
    const login = nonEmptyString(row.login, 200);
    if (id !== null && login) organizations.push({ id, login });
  }
  return { ok: true, data: organizations };
}

function parseInstallationPermissions(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const permissions: Record<string, string> = {};
  for (const [key, level] of Object.entries(value)) {
    if (
      /^[a-z][a-z0-9_]*$/.test(key) &&
      (level === "read" || level === "write" || level === "admin")
    ) {
      permissions[key] = level;
    }
  }
  return permissions;
}

function parseRepositorySelection(value: unknown): GithubRepositorySelection {
  return value === "all" || value === "selected" ? value : null;
}

function parseInstallation(item: unknown): GithubUserInstallation | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : null;
  const targetId = typeof row.target_id === "number" ? row.target_id : null;
  const targetType = nonEmptyString(row.target_type, 100);
  if (id === null || targetId === null || !targetType) return null;

  const account = row.account as Record<string, unknown> | undefined;
  return {
    id,
    targetId,
    targetType,
    targetLogin: nonEmptyString(account?.login, 200),
    repositorySelection: parseRepositorySelection(row.repository_selection),
    permissions: parseInstallationPermissions(row.permissions),
    appId: typeof row.app_id === "number" ? row.app_id : null,
    appSlug: nonEmptyString(row.app_slug, 200),
    clientId: nonEmptyString(row.client_id, 200),
    suspended: typeof row.suspended_at === "string",
  };
}

export async function listUserInstallations(
  accessToken: string,
): Promise<GithubResult<GithubUserInstallation[]>> {
  const perPage = 100;
  const installations: GithubUserInstallation[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await githubApi(
      `/user/installations?per_page=${perPage}&page=${page}`,
      accessToken,
    );
    if (isGithubFailure(result)) return result;
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
      return { ok: false, code: "github_invalid_response" };
    }

    const rows = (result.data as { installations?: unknown }).installations;
    if (!Array.isArray(rows)) return { ok: false, code: "github_invalid_response" };

    let parsed = 0;
    for (const item of rows) {
      const installation = parseInstallation(item);
      if (installation) {
        installations.push(installation);
        parsed += 1;
      }
    }

    if (rows.length > 0 && parsed === 0) {
      return { ok: false, code: "github_invalid_response" };
    }
    if (rows.length < perPage) break;
  }

  return { ok: true, data: installations };
}

/**
 * One repository row from GitHub, in the shape the integration uses.
 *
 * ⚠️ THIS IS SHARED BY THE LIST AND THE CREATE CALL. A created repository is
 * parsed from GitHub's answer exactly like one from `/user/repos`, so the
 * connection is never built from Mavly's assumptions about what was created.
 */
function parseRepository(item: unknown): GithubRepository | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : null;
  const name = nonEmptyString(row.name, 200);
  const fullName = nonEmptyString(row.full_name, 400);
  const owner = row.owner as Record<string, unknown> | undefined;
  const ownerLogin = nonEmptyString(owner?.login, 200);
  const defaultBranch = nonEmptyString(row.default_branch, 300);
  if (id === null || !name || !fullName || !ownerLogin) return null;
  if (!isSafeOwner(ownerLogin) || !isSafeRepoName(name)) return null;

  return {
    id,
    name,
    fullName,
    owner: ownerLogin,
    ownerType: owner?.type === "Organization" ? "Organization" : "User",
    defaultBranch,
    private: row.private === true,
    updatedAt: nonEmptyString(row.updated_at, 64),
  };
}

export interface GithubRepositoryAccess {
  repositories: GithubRepository[];
  installations: GithubUserInstallation[];
}

/**
 * The repositories the App installation can reach.
 *
 * ⚠️ `/user/repos` IS NOT THE RIGHT LIST FOR A GITHUB APP USER TOKEN. GitHub
 * limits the token to the intersection of the user's access and the App
 * installation, so the installation-scoped endpoint is the authoritative list.
 * It also lets Mavly distinguish "no repositories selected" from "no account".
 */
async function listInstallationRepositories(
  accessToken: string,
  installationId: number,
): Promise<GithubResult<GithubRepository[]>> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return { ok: false, code: "github_invalid_response" };
  }

  const perPage = 100;
  const repositories: GithubRepository[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await githubApi(
      `/user/installations/${installationId}/repositories?per_page=${perPage}&page=${page}`,
      accessToken,
    );
    if (isGithubFailure(result)) return result;
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
      return { ok: false, code: "github_invalid_response" };
    }

    const rows = (result.data as { repositories?: unknown }).repositories;
    if (!Array.isArray(rows)) return { ok: false, code: "github_invalid_response" };

    let parsed = 0;
    for (const item of rows) {
      const repository = parseRepository(item);
      if (repository) {
        repositories.push(repository);
        parsed += 1;
      }
    }
    if (rows.length > 0 && parsed === 0) {
      return { ok: false, code: "github_invalid_response" };
    }
    if (rows.length < perPage) break;
  }

  return { ok: true, data: repositories };
}

export async function listRepositories(
  accessToken: string,
): Promise<GithubResult<GithubRepositoryAccess>> {
  const installations = await listUserInstallations(accessToken);
  if (isGithubFailure(installations)) return installations;

  const byId = new Map<number, GithubRepository>();
  for (const installation of installations.data) {
    /**
     * A suspended installation cannot answer, and an enterprise installation
     * has no repositories of its own. Skipping them lets the service report the
     * suspension accurately instead of turning it into a generic 403.
     */
    if (installation.suspended) continue;
    if (installation.targetType.toLowerCase() === "enterprise") continue;

    const result = await listInstallationRepositories(accessToken, installation.id);
    if (isGithubFailure(result)) return result;
    for (const repository of result.data) {
      if (!byId.has(repository.id)) byId.set(repository.id, repository);
    }
  }

  const repositories = [...byId.values()].sort((left, right) => {
    const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    return updated || left.fullName.localeCompare(right.fullName);
  });
  return { ok: true, data: { repositories, installations: installations.data } };
}

export interface CreateRepositoryInput {
  name: string;
  private: boolean;
  /** GitHub's own limit is 350 characters. */
  description?: string | null;
}

/**
 * Create an EMPTY repository for the authenticated user.
 *
 * ⚠️ `auto_init: false` IS DELIBERATE. GitHub does not get to create a README,
 * a licence or a placeholder commit: the first push is the project's real
 * source, and an initialized repository would no longer be empty.
 *
 * ⚠️ THE ANSWER IS GITHUB'S REPOSITORY ROW, not a locally assembled object.
 * The caller then asks GitHub for the branch state before deciding whether
 * this is an empty-repository connection.
 */
export async function createRepository(
  accessToken: string,
  input: CreateRepositoryInput,
): Promise<GithubResult<GithubRepository>> {
  const name = input.name.trim();
  if (!isSafeRepoName(name)) return { ok: false, code: "github_failed" };

  const description = input.description?.trim() ?? "";
  if (description.length > 350) return { ok: false, code: "github_failed" };

  const result = await githubApi("/user/repos", accessToken, {
    method: "POST",
    body: {
      name,
      private: input.private === true,
      auto_init: false,
      ...(description ? { description } : {}),
    },
  });
  if (isGithubFailure(result)) {
    /**
     * ⚠️ GitHub answers a duplicate name with 422, which the generic mapper
     * treats as a Git conflict. On the create endpoint a 422 is a name that is
     * already taken (the name shape was validated above), and the user needs
     * to be told that rather than "the branch moved".
     */
    if (result.code === "github_conflict") {
      return {
        ok: false,
        code: "github_repository_exists",
        upstream: result.upstream,
      };
    }
    return result;
  }

  const repository = parseRepository(result.data);
  if (!repository) return { ok: false, code: "github_invalid_response" };
  return { ok: true, data: repository };
}

/**
 * Repository metadata used to distinguish a genuinely empty repository from a
 * repository whose branch list is merely empty to this token.
 *
 * ⚠️ GITHUB HAS NO `is_empty` FIELD. `size === 0` with no `pushed_at` means the
 * repository has never received a push. Callers only treat that as empty when
 * the authoritative branches response is also empty, so a transiently stale
 * size cannot invent an empty repository on its own.
 */
export async function getRepositoryState(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<GithubResult<GithubRepositoryState>> {
  if (!isSafeOwner(owner) || !isSafeRepoName(repo)) {
    return { ok: false, code: "github_not_found" };
  }

  const result = await githubApi(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    accessToken,
  );
  if (isGithubFailure(result)) return result;
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return { ok: false, code: "github_invalid_response" };
  }

  const row = result.data as Record<string, unknown>;
  const defaultBranch = nonEmptyString(row.default_branch, 300);
  const size = typeof row.size === "number" ? row.size : null;
  const pushedAt = row.pushed_at;

  return {
    ok: true,
    data: {
      defaultBranch,
      empty: size === 0 && (pushedAt === null || pushedAt === undefined),
    },
  };
}

/** The branches of one repository. */
export async function listBranches(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<GithubResult<GithubBranch[]>> {
  if (!isSafeOwner(owner) || !isSafeRepoName(repo)) {
    return { ok: false, code: "github_not_found" };
  }
  const result = await githubApi(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    accessToken,
  );
  if (isGithubFailure(result)) return result;
  if (!Array.isArray(result.data)) return { ok: false, code: "github_invalid_response" };

  const branches: GithubBranch[] = [];
  for (const item of result.data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = nonEmptyString(row.name, 300);
    const commit = row.commit as Record<string, unknown> | undefined;
    const sha = nonEmptyString(commit?.sha, 64);
    if (!name || !sha || !isSafeBranchName(name)) continue;
    branches.push({
      name,
      sha,
      protected: row.protected === true,
    });
  }
  return { ok: true, data: branches };
}

export { githubApi };
