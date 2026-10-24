/**
 * ═══ THE GITHUB SERVICE ═════════════════════════════════════════════════════
 *
 * The layer between the routes and GitHub. It owns the decisions:
 *
 *   · which token is used (and when it must be refreshed);
 *   · which files may be pushed or imported (the inclusion policy);
 *   · what a push or an import does to the project's source;
 *   · what the project↔repository connection remembers.
 *
 * ⚠️ NO ROUTE HANDLER SEES A TOKEN, AND NO SERVICE FUNCTION BUILDS A URL FROM
 * A CLIENT-SUPPLIED VALUE. Repository identifiers arrive here from a stored row
 * or from a list the user's own token produced, and they are validated before
 * they are used.
 */

import { isStoreFailure, listFiles, writeFiles } from "@/lib/mavly/store";
import { createSnapshot, diffPaths, diffSource, isSnapshotFailure } from "@/lib/mavly/snapshots";
import type { GithubIntegrationConfig } from "./config";
import {
  getBranchHead,
  pushSource,
  readBlobFile,
  readTree,
  type GitFile,
  type PushConflict,
  type PushOutcome as GitPushOutcome,
} from "./git";
import {
  createRepository,
  getRepositoryState,
  getViewer,
  isGithubFailure,
  listBranches,
  listOrganizations,
  listRepositories,
  listUserInstallations,
  refreshAccessToken,
  type GithubBranch,
  type GithubOrganization,
  type GithubRepository,
  type GithubRepositorySelection,
  type GithubUpstreamError,
  type GithubUserInstallation,
} from "./oauth";
import {
  applyFilePolicy,
  isExcludedPath,
  isSafeBranchName,
  isSafeOwner,
  isSafeRepoName,
  isSafeProjectPath,
  MAX_GITHUB_FILES,
  MAX_GITHUB_FILE_BYTES,
  TOO_MANY_FILES_REASON,
} from "./safety";
import {
  getRepositoryConnection,
  isGithubStoreFailure,
  readTokens,
  saveRepositoryConnection,
  updateConnectionTokens,
  updateRepositorySync,
  type GithubRepositoryConnectionRow,
} from "./store";

export type GithubServiceError =
  | "github_unavailable"
  | "github_unauthorized"
  | "github_forbidden"
  | "github_not_found"
  | "github_rate_limited"
  | "github_conflict"
  | "github_invalid_response"
  | "github_failed"
  | "github_not_connected"
  | "github_not_configured"
  | "github_no_write_permission"
  | "github_app_not_installed"
  | "github_installation_suspended"
  | "github_installation_permissions_stale"
  | "github_empty_repository"
  | "github_repository_exists"
  | "github_sso_required"
  | "github_policy_blocked"
  | "github_abuse_blocked"
  | "github_email_unverified"
  | "github_tree_truncated"
  | "github_import_too_large"
  | "github_too_many_files"
  | "store_unavailable"
  | "project_not_connected";

export interface GithubInstallationDiagnostics {
  installationId: number | null;
  installationUrl: string | null;
  appId: number | null;
  appSlug: string | null;
  clientId: string | null;
  repositorySelection: GithubRepositorySelection;
  permissions: Record<string, string> | null;
  suspended: boolean;
}

export type GithubServiceResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: GithubServiceError;
      conflict?: PushConflict;
      upstream?: GithubUpstreamError;
      diagnostics?: GithubInstallationDiagnostics;
    };

export function isGithubServiceFailure<T>(
  result: GithubServiceResult<T>,
): result is Extract<GithubServiceResult<T>, { ok: false }> {
  return result.ok === false;
}

function isPushSourceFailure(
  result: GitPushOutcome,
): result is Extract<GitPushOutcome, { ok: false }> {
  return result.ok === false;
}

export interface GithubAccount {
  connected: boolean;
  login: string | null;
  organizations: GithubOrganization[];
}

/**
 * The account the user's token acts as, and the organizations it can see.
 */
export async function getAccount(
  userId: string,
  config: GithubIntegrationConfig,
): Promise<GithubServiceResult<GithubAccount>> {
  const token = await resolveToken(userId, config);
  if (isGithubServiceFailure(token)) return { ok: false, code: token.code };

  const viewer = await getViewer(token.data);
  if (isGithubFailure(viewer)) return viewer;

  const organizations = await listOrganizations(token.data);
  return {
    ok: true,
    data: {
      connected: true,
      login: viewer.data.login,
      organizations: organizations.ok ? organizations.data : [],
    },
  };
}

export interface GithubRepositoryList {
  repositories: GithubRepository[];
  repositorySelection: GithubRepositorySelection;
  installationUrl: string | null;
  installationSuspended: boolean;
}

function installationSettingsUrl(installation: GithubUserInstallation): string {
  if (installation.targetType.toLowerCase() === "organization" && installation.targetLogin) {
    return `https://github.com/organizations/${encodeURIComponent(installation.targetLogin)}/settings/installations/${installation.id}`;
  }
  return `https://github.com/settings/installations/${installation.id}`;
}

function personalInstallation(
  installations: GithubUserInstallation[],
): GithubUserInstallation | null {
  return (
    installations.find(
      (installation) => installation.targetType.toLowerCase() === "user",
    ) ?? null
  );
}

/** The repositories the App installation actually reaches. */
export async function listUserRepositories(
  userId: string,
  config: GithubIntegrationConfig,
): Promise<GithubServiceResult<GithubRepositoryList>> {
  const token = await resolveToken(userId, config);
  if (isGithubServiceFailure(token)) return { ok: false, code: token.code };

  const access = await listRepositories(token.data);
  if (isGithubFailure(access)) return access;
  if (access.data.installations.length === 0) {
    return { ok: false, code: "github_app_not_installed" };
  }

  const personal = personalInstallation(access.data.installations);
  if (personal?.suspended) {
    return {
      ok: false,
      code: "github_installation_suspended",
      diagnostics: installationDiagnostics(personal),
    };
  }

  const installation = personal ?? access.data.installations[0] ?? null;
  return {
    ok: true,
    data: {
      repositories: access.data.repositories,
      repositorySelection: installation?.repositorySelection ?? null,
      installationUrl: installation ? installationSettingsUrl(installation) : null,
      installationSuspended: installation?.suspended === true,
    },
  };
}

export interface RepositoryBranchList {
  branches: GithubBranch[];
  /**
   * True only when GitHub says the repository has no commits. An empty branch
   * list alone is not enough: a token can see a repository whose branches it
   * cannot enumerate.
   */
  empty: boolean;
  /** GitHub's default branch, when it reports one. */
  defaultBranch: string | null;
}

/** The branches of one repository, as the user's authorization sees them. */
export async function listRepositoryBranches(
  userId: string,
  config: GithubIntegrationConfig,
  owner: string,
  repo: string,
): Promise<GithubServiceResult<RepositoryBranchList>> {
  const token = await resolveToken(userId, config);
  if (isGithubServiceFailure(token)) return { ok: false, code: token.code };

  const branches = await listBranches(token.data, owner, repo);
  /**
   * ⚠️ GITHUB ANSWERS A BRANCH LIST FOR AN EMPTY REPOSITORY WITH 409
   * "Git Repository is empty." That is not a broken request — it is one of the
   * two signals this function needs. Only the repository metadata decides
   * whether the connection may use the first-push workflow; a 409 here just
   * means there are no names to enumerate yet.
   */
  if (isGithubFailure(branches) && branches.code !== "github_conflict") {
    return branches;
  }

  /**
   * ⚠️ AN EMPTY BRANCH LIST IS NOT PROOF THAT THE REPOSITORY IS EMPTY. Ask
   * GitHub for the repository metadata as well. Only a repository with no
   * pushes and no branches is offered the first-push workflow; anything else
   * with no branches stays a visible, non-connectable state.
   */
  if (!isGithubFailure(branches) && branches.data.length > 0) {
    return {
      ok: true,
      data: { branches: branches.data, empty: false, defaultBranch: null },
    };
  }

  const state = await getRepositoryState(token.data, owner, repo);
  if (isGithubFailure(state)) return state;

  return {
    ok: true,
    data: {
      branches: isGithubFailure(branches) ? [] : branches.data,
      empty: state.data.empty,
      defaultBranch: state.data.defaultBranch,
    },
  };
}

/**
 * Connect a repository and a branch to a project.
 *
 * ⚠️ THE REPOSITORY IS LOOKED UP IN THE USER'S OWN LIST FIRST. A repository id
 * sent by the browser is not enough: the authorization must actually reach
 * that repository, or the connection is refused.
 */
export async function connectRepository(
  input: {
    userId: string;
    projectId: string;
    repositoryId: number;
    owner: string;
    repo: string;
    branch: string;
  },
  config: GithubIntegrationConfig,
): Promise<GithubServiceResult<GithubRepositoryConnectionRow>> {
  if (!isSafeOwner(input.owner) || !isSafeRepoName(input.repo)) {
    return { ok: false, code: "github_not_found" };
  }
  const branchName = input.branch.trim();
  if (!isSafeBranchName(branchName)) {
    return { ok: false, code: "github_not_found" };
  }

  const repositories = await listUserRepositories(input.userId, config);
  if (isGithubServiceFailure(repositories)) {
    return {
      ok: false,
      code: repositories.code,
      upstream: repositories.upstream,
      diagnostics: repositories.diagnostics,
    };
  }

  const repository = repositories.data.repositories.find(
    (entry) => entry.id === input.repositoryId,
  );
  if (!repository) {
    // The id does not match anything this authorization can reach.
    return { ok: false, code: "github_not_found" };
  }
  if (repository.owner !== input.owner || repository.name !== input.repo) {
    return { ok: false, code: "github_not_found" };
  }

  const repositoryBranches = await listRepositoryBranches(
    input.userId,
    config,
    repository.owner,
    repository.name,
  );
  if (isGithubServiceFailure(repositoryBranches)) {
    return { ok: false, code: repositoryBranches.code };
  }

  return persistRepositoryConnection({
    userId: input.userId,
    projectId: input.projectId,
    repository,
    branchName,
    branchList: repositoryBranches.data,
  });
}

export interface CreateRepositoryConnectionInput {
  userId: string;
  projectId: string;
  name: string;
  private: boolean;
  description?: string | null;
}

function allowsRepositoryCreation(permissions: Record<string, string>): boolean {
  const writes = (level: string | undefined): boolean =>
    level === "write" || level === "admin";
  return (
    writes(permissions.administration) ||
    writes(permissions.repository_creation)
  );
}

function installationDiagnostics(
  installation: GithubUserInstallation | null,
): GithubInstallationDiagnostics {
  return {
    installationId: installation?.id ?? null,
    installationUrl: installation ? installationSettingsUrl(installation) : null,
    appId: installation?.appId ?? null,
    appSlug: installation?.appSlug ?? null,
    clientId: installation?.clientId ?? null,
    repositorySelection: installation?.repositorySelection ?? null,
    permissions: installation?.permissions ?? null,
    suspended: installation?.suspended === true,
  };
}

interface RepositoryCreationDiagnosis {
  code: GithubServiceError;
  diagnostics: GithubInstallationDiagnostics;
}

/**
 * ⚠️ A 403 IS NOT PROOF THAT THE APP LACKS THE PERMISSION. The installation
 * row tells us which App is actually running and which permissions GitHub has
 * approved for it. If GitHub still refuses after the permission is present,
 * the original error is kept rather than replaced with a misleading one.
 */
async function diagnoseRepositoryCreationDenial(
  accessToken: string,
): Promise<RepositoryCreationDiagnosis | null> {
  const viewer = await getViewer(accessToken);
  if (isGithubFailure(viewer)) return null;

  const installations = await listUserInstallations(accessToken);
  if (isGithubFailure(installations)) return null;

  const personal = installations.data.find(
    (installation) =>
      installation.targetType.toLowerCase() === "user" &&
      installation.targetId === viewer.data.id,
  );
  const candidate = personal ?? installations.data[0] ?? null;
  const diagnostics = installationDiagnostics(candidate);

  if (!personal) {
    return { code: "github_app_not_installed", diagnostics };
  }
  if (personal.suspended) {
    return { code: "github_installation_suspended", diagnostics };
  }
  if (personal.permissions && !allowsRepositoryCreation(personal.permissions)) {
    return { code: "github_installation_permissions_stale", diagnostics };
  }
  return { code: "github_no_write_permission", diagnostics };
}

/**
 * ⭐ CREATE A REPOSITORY AND CONNECT IT, IN ONE JOURNEY.
 *
 * GitHub creates an empty repository on the authenticated user's account. The
 * branch state is then read BACK from GitHub:
 *
 *   · empty  → the connection remembers `main` as the intended first branch,
 *              with `first_push_pending`; no branch, commit or file is created.
 *   · non-empty (for example if GitHub initialized it) → the actual default
 *              branch is used, and the connection is an ordinary one.
 *
 * ⚠️ NOTHING HERE FABRICATES A REF. A branch only exists after the user's
 * first real push, and that push verifies the ref with GitHub before reporting
 * success.
 */
export async function createRepositoryAndConnect(
  input: CreateRepositoryConnectionInput,
  config: GithubIntegrationConfig,
): Promise<GithubServiceResult<GithubRepositoryConnectionRow>> {
  const name = input.name.trim();
  if (!isSafeRepoName(name)) {
    return { ok: false, code: "github_not_found" };
  }

  const token = await resolveToken(input.userId, config);
  if (isGithubServiceFailure(token)) {
    return { ok: false, code: token.code, upstream: token.upstream };
  }

  const created = await createRepository(token.data, {
    name,
    private: input.private === true,
    description: input.description,
  });
  if (isGithubFailure(created)) {
    if (created.code === "github_no_write_permission") {
      const diagnosis = await diagnoseRepositoryCreationDenial(token.data);
      if (diagnosis) {
        return {
          ok: false,
          code: diagnosis.code,
          upstream: created.upstream,
          diagnostics: diagnosis.diagnostics,
        };
      }
    }
    return { ok: false, code: created.code, upstream: created.upstream };
  }

  const repository = created.data;
  const repositoryBranches = await listRepositoryBranches(
    input.userId,
    config,
    repository.owner,
    repository.name,
  );
  if (isGithubServiceFailure(repositoryBranches)) {
    return {
      ok: false,
      code: repositoryBranches.code,
      upstream: repositoryBranches.upstream,
    };
  }

  /**
   * ⚠️ THE BRANCH IS WHATEVER GITHUB NOW SAYS IT IS. A newly created,
   * uninitialized repository is empty and gets the intended `main`; a
   * repository GitHub reports as non-empty gets its real default branch. We
   * never assume emptiness from our own request.
   */
  let branchName = "main";
  if (!repositoryBranches.data.empty) {
    const preferred =
      repository.defaultBranch ?? repositoryBranches.data.defaultBranch;
    branchName =
      repositoryBranches.data.branches.find((branch) => branch.name === preferred)?.name ??
      repositoryBranches.data.branches[0]?.name ??
      "";
    if (!branchName) return { ok: false, code: "github_failed" };
  }

  return persistRepositoryConnection({
    userId: input.userId,
    projectId: input.projectId,
    repository,
    branchName,
    branchList: repositoryBranches.data,
  });
}

async function persistRepositoryConnection(input: {
  userId: string;
  projectId: string;
  repository: GithubRepository;
  branchName: string;
  branchList: RepositoryBranchList;
}): Promise<GithubServiceResult<GithubRepositoryConnectionRow>> {
  const branchName = input.branchName.trim();
  if (!isSafeBranchName(branchName)) {
    return { ok: false, code: "github_not_found" };
  }

  /**
   * ⭐ AN EMPTY REPOSITORY HAS NO BRANCH TO SELECT, BUT IT STILL HAS A VALID
   * CONNECTION STRATEGY. Git cannot create a branch without a commit, so the
   * selected name is the intended branch and the first successful push creates
   * it. A repository that reports no branches without being empty is not
   * silently given the same treatment.
   */
  const existingBranch = input.branchList.branches.find(
    (entry) => entry.name === branchName,
  );
  if (!existingBranch && !input.branchList.empty) {
    return { ok: false, code: "github_not_found" };
  }

  const saved = await saveRepositoryConnection({
    projectId: input.projectId,
    userId: input.userId,
    repositoryId: input.repository.id,
    ownerLogin: input.repository.owner,
    ownerType: input.repository.ownerType,
    repositoryName: input.repository.name,
    repositoryFullName: input.repository.fullName,
    defaultBranch:
      input.repository.defaultBranch ??
      input.branchList.defaultBranch ??
      branchName,
    branch: branchName,
  });
  if (isGithubStoreFailure(saved)) return { ok: false, code: "store_unavailable" };

  const synced = await updateRepositorySync(input.projectId, {
    lastSyncedCommitSha: existingBranch?.sha ?? null,
    syncStatus: "connected",
    syncMessage: existingBranch ? null : "first_push_pending",
  });
  if (isGithubStoreFailure(synced)) return { ok: false, code: "store_unavailable" };

  const connection = await getRepositoryConnection(input.projectId);
  if (isGithubStoreFailure(connection) || !connection.data) {
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: connection.data };
}

export interface PushOutcome {
  commitSha: string;
  commitUrl: string;
  changedPaths: string[];
  unchanged: boolean;
  branch: string;
  repositoryFullName: string;
}

/**
 * Publish the project's source to the connected branch as ONE commit.
 *
 * ⚠️ NOTHING IS PUSHED AUTOMATICALLY. This is called when the user asks for
 * it, and it reports what GitHub actually did: the commit SHA comes from
 * GitHub's answer to the reference update, not from Mavly's own arithmetic.
 */
export async function pushProjectSource(
  input: {
    userId: string;
    projectId: string;
    message: string;
    /** The user confirmed committing on top of a branch that moved. */
    allowRemoteAdvance?: boolean;
  },
  config: GithubIntegrationConfig,
): Promise<GithubServiceResult<PushOutcome>> {
  const connection = await getRepositoryConnection(input.projectId);
  if (isGithubStoreFailure(connection)) return { ok: false, code: "store_unavailable" };
  if (!connection.data) return { ok: false, code: "project_not_connected" };

  const token = await resolveToken(input.userId, config);
  if (isGithubServiceFailure(token)) return { ok: false, code: token.code };

  const files = await listFiles(input.projectId);
  if (isStoreFailure(files)) return { ok: false, code: "store_unavailable" };

  const policy = applyFilePolicy(
    files.data.map((file) => ({ path: file.path, content: file.content })),
  );
  if (policy.excluded.some((file) => file.reason === TOO_MANY_FILES_REASON)) {
    return { ok: false, code: "github_too_many_files" };
  }

  /**
   * ⭐ THE FIRST PUSH OF AN EMPTY REPOSITORY CREATES THE INTENDED BRANCH.
   * The connection persisted the branch name, but Git has no ref for it yet.
   * Re-read GitHub's state here so a branch deleted from a non-empty repository
   * is never recreated implicitly.
   */
  let createInitialBranch = false;
  if (!connection.data.last_synced_commit_sha) {
    const repositoryState = await getRepositoryState(
      token.data,
      connection.data.owner_login,
      connection.data.repository_name,
    );
    if (isGithubFailure(repositoryState)) return repositoryState;
    createInitialBranch = repositoryState.data.empty;
  }
  if (createInitialBranch && policy.included.length === 0) {
    return { ok: false, code: "github_failed" };
  }

  const result = await pushSource({
    accessToken: token.data,
    owner: connection.data.owner_login,
    repo: connection.data.repository_name,
    branch: connection.data.branch,
    files: policy.included,
    message: input.message,
    expectedHeadSha: connection.data.last_synced_commit_sha,
    deletePaths: lastPushedPaths(connection.data),
    allowRemoteAdvance: input.allowRemoteAdvance,
    createInitialBranch,
  });

  if (isPushSourceFailure(result)) {
    if (result.code === "github_conflict") {
      await updateRepositorySync(input.projectId, {
        syncStatus: "conflict",
        syncMessage: "The branch moved on GitHub.",
      });
    }
    return { ok: false, code: result.code, conflict: result.conflict };
  }

  await updateRepositorySync(input.projectId, {
    lastSyncedCommitSha: result.data.commitSha,
    lastPushedCommitSha: result.data.unchanged ? connection.data.last_pushed_commit_sha : result.data.commitSha,
    lastPushedAt: result.data.unchanged ? connection.data.last_pushed_at : new Date().toISOString(),
    /**
     * ⭐ THE MANAGED SET, NOT THE CHANGED PATHS. The paths this commit changed
     * are not the paths Mavly owns on the branch: a file that was pushed two
     * commits ago and not touched since is still Mavly's, and only a file in
     * this set may be removed by a later push.
     */
    lastPushedPaths: result.data.managedPaths,
    syncStatus: "connected",
    syncMessage: null,
  });

  return {
    ok: true,
    data: {
      commitSha: result.data.commitSha,
      commitUrl: result.data.commitUrl,
      changedPaths: result.data.changedPaths,
      unchanged: result.data.unchanged,
      branch: connection.data.branch,
      repositoryFullName: connection.data.repository_full_name,
    },
  };
}

export interface ImportPlan {
  /** The files the branch has that the project does not. */
  added: string[];
  /** The files both have, with different content. */
  modified: string[];
  /** The files the project has that the branch does not. */
  removed: string[];
  /** The files that are the same on both sides. */
  unchanged: string[];
  /** The files the policy refused. */
  excluded: { path: string; reason: string }[];
  /** The commit the branch points at. */
  remoteCommitSha: string;
  /** True when the two sides differ at all. */
  diverged: boolean;
}

export interface ImportOutcome extends ImportPlan {
  /** The recovery point holding the project's source before the import. */
  recoverySnapshotId: string;
  /** The files that were actually written. */
  written: string[];
}

/**
 * Import a branch's source over the project.
 *
 * ⚠️ TWO STEPS, AND THE FIRST ONE CHANGES NOTHING. Without `confirm`, this
 * returns the plan — what would be added, changed and removed — so the user
 * can see the conflict before anything is replaced. With it, the project's
 * current source is captured as a recovery point FIRST, so the import is
 * reversible.
 *
 * ⚠️ AN IMPORT NEVER RUNS THE AGENT AND NEVER DEPLOYS. It only writes files.
 */
export async function importProjectSource(
  input: { userId: string; projectId: string; confirm?: boolean },
  config: GithubIntegrationConfig,
): Promise<GithubServiceResult<ImportPlan | ImportOutcome>> {
  const connection = await getRepositoryConnection(input.projectId);
  if (isGithubStoreFailure(connection)) return { ok: false, code: "store_unavailable" };
  if (!connection.data) return { ok: false, code: "project_not_connected" };

  const token = await resolveToken(input.userId, config);
  if (isGithubServiceFailure(token)) return { ok: false, code: token.code };

  const head = await getBranchHead(
    token.data,
    connection.data.owner_login,
    connection.data.repository_name,
    connection.data.branch,
  );
  if (isGithubFailure(head)) return head;
  if (!head.data) return { ok: false, code: "github_not_found" };

  const tree = await readTree(
    token.data,
    connection.data.owner_login,
    connection.data.repository_name,
    head.data.treeSha,
  );
  if (isGithubFailure(tree)) {
    return tree.code === "github_tree_truncated"
      ? { ok: false, code: "github_import_too_large" }
      : tree;
  }

  /**
   * ⚠️ NO EARLY BREAK. The old loop stopped at MAX_GITHUB_FILES while reading,
   * so a repository with more files was imported PARTIALLY and reported as a
   * successful import. Exclusions are now explicit, and a repository that is
   * genuinely too large fails before the project is touched.
   */
  const safeEntries = tree.data.filter((entry) => isSafeProjectPath(entry.path));
  const preExcluded: { path: string; reason: string }[] = safeEntries
    .filter((entry) => isExcludedPath(entry.path))
    .map((entry) => ({ path: entry.path, reason: "excluded by policy" }));
  const eligible = safeEntries
    .filter((entry) => !isExcludedPath(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (eligible.length > MAX_GITHUB_FILES) {
    return { ok: false, code: "github_import_too_large" };
  }

  const remoteFiles: GitFile[] = [];
  for (const entry of eligible) {
    if (entry.size > MAX_GITHUB_FILE_BYTES) {
      preExcluded.push({ path: entry.path, reason: "file is too large" });
      continue;
    }
    const blob = await readBlobFile(
      token.data,
      connection.data.owner_login,
      connection.data.repository_name,
      entry.sha,
    );
    if (isGithubFailure(blob)) {
      preExcluded.push({ path: entry.path, reason: "could not be read from GitHub" });
      continue;
    }
    if (blob.data.binary) {
      preExcluded.push({ path: entry.path, reason: "binary files are not supported" });
      continue;
    }
    remoteFiles.push({ path: entry.path, content: blob.data.content });
  }

  const policy = applyFilePolicy(remoteFiles);
  policy.excluded.unshift(...preExcluded);

  const local = await listFiles(input.projectId);
  if (isStoreFailure(local)) return { ok: false, code: "store_unavailable" };
  const localFiles: GitFile[] = local.data.map((file) => ({
    path: file.path,
    content: file.content,
  }));

  const diff = diffSource(localFiles, policy.included);
  const unchanged = policy.included
    .filter((file) => !diff.added.includes(file.path) && !diff.modified.includes(file.path))
    .map((file) => file.path);

  const plan: ImportPlan = {
    added: diff.added,
    modified: diff.modified,
    removed: diff.removed,
    unchanged,
    excluded: policy.excluded,
    remoteCommitSha: head.data.sha,
    diverged: !diff.unchanged,
  };

  if (!input.confirm) return { ok: true, data: plan };

  /**
   * ⭐ THE RECOVERY POINT, BEFORE ANY FILE IS WRITTEN. The user's unsaved work
   * is captured, so the import can be undone.
   */
  const snapshot = await createSnapshot({
    userId: input.userId,
    projectId: input.projectId,
    kind: "import",
    description: `Before importing ${connection.data.repository_full_name} (${connection.data.branch})`,
    files: localFiles,
    changedPaths: diffPaths(diff),
  });
  if (isSnapshotFailure(snapshot)) return { ok: false, code: "store_unavailable" };

  const remotePaths = new Set(policy.included.map((file) => file.path));
  const removedPaths = localFiles
    .map((file) => file.path)
    .filter((path) => !remotePaths.has(path));

  const written = await writeFiles(
    input.userId,
    input.projectId,
    policy.included,
    removedPaths,
  );
  if (isStoreFailure(written)) return { ok: false, code: "store_unavailable" };

  await updateRepositorySync(input.projectId, {
    lastSyncedCommitSha: head.data.sha,
    syncStatus: "connected",
    syncMessage: null,
  });

  return {
    ok: true,
    data: {
      ...plan,
      recoverySnapshotId: snapshot.data.id,
      written: policy.included.map((file) => file.path),
    },
  };
}

/* ─────────────────────────────── internals ─────────────────────────────── */

function lastPushedPaths(
  row: GithubRepositoryConnectionRow,
): string[] {
  if (!Array.isArray(row.last_pushed_paths)) return [];
  return row.last_pushed_paths.filter(
    (entry): entry is string => typeof entry === "string",
  );
}

/**
 * The access token to use, refreshed when it has expired.
 *
 * ⚠️ A REFRESHED TOKEN IS STORED BACK, ENCRYPTED, BEFORE IT IS USED. A token
 * that GitHub has expired is not a usable credential, and a connection that
 * silently stopped working would be reported as "GitHub is broken".
 */
async function resolveToken(
  userId: string,
  config: GithubIntegrationConfig,
): Promise<GithubServiceResult<string>> {
  const stored = await readTokens(userId, config);
  if (isGithubStoreFailure(stored)) {
    if (stored.code === "not_connected") return { ok: false, code: "github_not_connected" };
    return { ok: false, code: "store_unavailable" };
  }

  const expiresAt = stored.data.expiresAt;
  const expired = !!expiresAt && Date.parse(expiresAt) <= Date.now() + 60_000;
  if (!expired) return { ok: true, data: stored.data.accessToken };

  if (!stored.data.refreshToken) {
    return { ok: false, code: "github_unauthorized" };
  }

  const refreshed = await refreshAccessToken(config, stored.data.refreshToken);
  if (isGithubFailure(refreshed)) return refreshed;

  const saved = await updateConnectionTokens(userId, refreshed.data, config);
  if (isGithubStoreFailure(saved)) return { ok: false, code: "store_unavailable" };

  return { ok: true, data: refreshed.data.accessToken };
}
