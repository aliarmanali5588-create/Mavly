/**
 * ═══ THE SOURCE-CONTROL SERVICE ════════════════════════════════════════════
 *
 * Everything that talks to GitHub's Git database API lives here, so the route
 * handlers and the UI never speak Git and never see a token.
 *
 * ⚠️ A PUSH IS ONE COHERENT COMMIT. The implementation creates blobs, builds
 * ONE tree on top of the branch's current tree, creates ONE commit with the
 * branch's head as its parent, and then moves the branch reference with
 * `force: false`. A collection of independent file updates is not a commit,
 * and a push that is not a fast-forward is refused rather than forced.
 *
 * ⚠️ THE BRANCH'S HEAD IS CHECKED BEFORE ANYTHING IS WRITTEN. If the branch
 * moved since Mavly last saw it, the push stops and reports the conflict: the
 * user decides whether to commit on top of the new head (an explicit,
 * separately confirmed action) or to import first. History is never rewritten.
 *
 * ⚠️ FILES MAVLY DID NOT PUSH ARE NEVER DELETED. A repository may contain
 * files Mavly has never seen (a README, a licence, another tool's output).
 * Only the paths Mavly pushed itself, and no longer has, are removed.
 */

import { createHash } from "node:crypto";

import {
  githubApi,
  isGithubFailure,
  type GithubErrorCode,
  type GithubResult,
} from "./oauth";
import {
  isSafeBranchName,
  isSafeOwner,
  isSafeRepoName,
  isSafeProjectPath,
} from "./safety";

export interface GitFile {
  path: string;
  content: string;
}

export interface RemoteTreeEntry {
  path: string;
  sha: string;
  size: number;
}

export interface BranchHead {
  /** The commit the branch points at. */
  sha: string;
  /** The tree of that commit — the base of the next commit. */
  treeSha: string;
}

export interface PushResult {
  /** The new commit's SHA. */
  commitSha: string;
  /** The tree the commit points at. */
  treeSha: string;
  /** The paths the commit changed. */
  changedPaths: string[];
  /**
   * The paths Mavly manages on this branch: everything it has ever pushed and
   * not yet removed. ONLY these may be deleted by a later push.
   */
  managedPaths: string[];
  /** True when the branch was already exactly this source. */
  unchanged: boolean;
  /** The commit's page on GitHub. */
  commitUrl: string;
}

export interface PushConflict {
  /** The commit the branch points at now. */
  remoteHead: string;
  /** The commit Mavly last saw. */
  expectedHead: string;
  /** The paths that changed on the branch since then. */
  changedPaths: string[];
}

export type PushOutcome =
  | { ok: true; data: PushResult }
  | { ok: false; code: GithubErrorCode; conflict?: PushConflict };

/**
 * The git object id of a blob's content.
 *
 * ⚠️ GIT'S FORMAT, NOT SHA-256 OF THE TEXT: `sha1("blob " + length + "\0" +
 * content)`. This is what lets Mavly notice that a file on the branch is
 * already exactly what it has locally, and skip creating a blob for it.
 *
 * It is an OPTIMISATION, never a correctness dependency: a repository that
 * does not use SHA-1 object ids simply never matches, and every file is
 * created again.
 */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${bytes.length}\u0000`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function repoPath(owner: string, repo: string): string | null {
  if (!isSafeOwner(owner) || !isSafeRepoName(repo)) return null;
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** The commit a branch points at, and that commit's tree. */
export async function getBranchHead(
  accessToken: string,
  owner: string,
  repo: string,
  branch: string,
  options: { allowEmptyRepository?: boolean } = {},
): Promise<GithubResult<BranchHead | null>> {
  const base = repoPath(owner, repo);
  if (!base || !isSafeBranchName(branch)) return { ok: false, code: "github_not_found" };

  const ref = await githubApi(
    `${base}/git/ref/heads/${encodeURIComponent(branch)}`,
    accessToken,
  );
  if (isGithubFailure(ref)) {
    // A branch that does not exist is an empty answer, not a failure.
    if (ref.code === "github_not_found") return { ok: true, data: null };
    /**
     * GitHub answers a ref lookup in a repository with no commits with 409
     * "Git Repository is empty." That is expected for the first push, and only
     * there: a caller must have proved the repository is empty before asking
     * for this interpretation.
     */
    if (options.allowEmptyRepository && ref.code === "github_conflict") {
      return { ok: true, data: null };
    }
    return ref;
  }

  const refObject = (ref.data as { object?: { sha?: unknown } })?.object;
  const sha = typeof refObject?.sha === "string" ? refObject.sha : null;
  if (!sha) return { ok: false, code: "github_invalid_response" };

  const commit = await githubApi(`${base}/git/commits/${encodeURIComponent(sha)}`, accessToken);
  if (isGithubFailure(commit)) return commit;

  const tree = (commit.data as { tree?: { sha?: unknown } })?.tree;
  const treeSha = typeof tree?.sha === "string" ? tree.sha : null;
  if (!treeSha) return { ok: false, code: "github_invalid_response" };

  return { ok: true, data: { sha, treeSha } };
}

/** Every file in a tree, recursively. */
export async function readTree(
  accessToken: string,
  owner: string,
  repo: string,
  treeSha: string,
): Promise<GithubResult<RemoteTreeEntry[]>> {
  const base = repoPath(owner, repo);
  if (!base || !/^[A-Za-z0-9]{7,64}$/.test(treeSha)) {
    return { ok: false, code: "github_not_found" };
  }

  const result = await githubApi(
    `${base}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    accessToken,
  );
  if (isGithubFailure(result)) return result;

  const tree = (result.data as { tree?: unknown })?.tree;
  if (!Array.isArray(tree)) return { ok: false, code: "github_invalid_response" };

  const entries: RemoteTreeEntry[] = [];
  for (const item of tree) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type !== "blob") continue;
    const path = typeof row.path === "string" ? row.path : null;
    const sha = typeof row.sha === "string" ? row.sha : null;
    if (!path || !sha || !isSafeProjectPath(path)) continue;
    entries.push({
      path,
      sha,
      size: typeof row.size === "number" ? row.size : 0,
    });
  }
  return { ok: true, data: entries };
}

/** The content of one blob, as text. */
export async function readBlob(
  accessToken: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<GithubResult<string>> {
  const base = repoPath(owner, repo);
  if (!base || !/^[A-Za-z0-9]{7,64}$/.test(sha)) {
    return { ok: false, code: "github_not_found" };
  }

  const result = await githubApi(`${base}/git/blobs/${encodeURIComponent(sha)}`, accessToken);
  if (isGithubFailure(result)) return result;

  const row = result.data as { content?: unknown; encoding?: unknown };
  if (typeof row.content !== "string") return { ok: false, code: "github_invalid_response" };

  if (row.encoding === "base64") {
    try {
      return { ok: true, data: Buffer.from(row.content, "base64").toString("utf8") };
    } catch {
      return { ok: false, code: "github_invalid_response" };
    }
  }
  return { ok: true, data: row.content };
}

/** Create one blob. */
async function createBlob(
  accessToken: string,
  owner: string,
  repo: string,
  content: string,
): Promise<GithubResult<string>> {
  const base = repoPath(owner, repo);
  if (!base) return { ok: false, code: "github_not_found" };

  const result = await githubApi(`${base}/git/blobs`, accessToken, {
    method: "POST",
    body: {
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    },
  });
  if (isGithubFailure(result)) return result;

  const sha = (result.data as { sha?: unknown })?.sha;
  if (typeof sha !== "string" || !sha) return { ok: false, code: "github_invalid_response" };
  return { ok: true, data: sha };
}

export interface PushInput {
  accessToken: string;
  owner: string;
  repo: string;
  branch: string;
  /** The complete source of the project. */
  files: readonly GitFile[];
  /** The commit message. */
  message: string;
  /** The commit Mavly last saw on this branch, when it knows one. */
  expectedHeadSha?: string | null;
  /** The paths Mavly pushed before and no longer has. */
  deletePaths?: readonly string[];
  /**
   * The branch moved and the user has confirmed, separately, that Mavly may
   * commit on top of the new head. History is still not rewritten: the commit
   * is a normal child of the current head.
   */
  allowRemoteAdvance?: boolean;
  /**
   * The branch does not exist because the repository has never had a commit.
   * Create the first commit and ref instead of failing.
   *
   * ⚠️ CALLERS MUST PROVE THE REPOSITORY IS EMPTY. This is never set just
   * because the branch name is missing from a non-empty repository.
   */
  createInitialBranch?: boolean;
}

/**
 * Publish the project's source to a branch as ONE commit.
 */
export async function pushSource(input: PushInput): Promise<PushOutcome> {
  const base = repoPath(input.owner, input.repo);
  if (!base || !isSafeBranchName(input.branch)) {
    return { ok: false, code: "github_not_found" };
  }

  const head = await getBranchHead(
    input.accessToken,
    input.owner,
    input.repo,
    input.branch,
    { allowEmptyRepository: input.createInitialBranch === true },
  );
  if (isGithubFailure(head)) return head;

  const initial = !head.data && input.createInitialBranch === true;
  if (!head.data && !initial) return { ok: false, code: "github_not_found" };

  /**
   * ⚠️ THE CONFLICT CHECK. The branch moved since Mavly last synced it. The
   * push is stopped: the user is told what happened and asked to confirm, and
   * only then does Mavly commit on top of the new head.
   */
  if (
    head.data &&
    input.expectedHeadSha &&
    input.expectedHeadSha !== head.data.sha &&
    !input.allowRemoteAdvance
  ) {
    const tree = await readTree(input.accessToken, input.owner, input.repo, head.data.treeSha);
    const changedPaths = isGithubFailure(tree)
      ? []
      : tree.data.map((entry) => entry.path);
    return {
      ok: false,
      code: "github_conflict",
      conflict: {
        remoteHead: head.data.sha,
        expectedHead: input.expectedHeadSha,
        changedPaths,
      },
    };
  }

  const remoteTree = head.data
    ? await readTree(
        input.accessToken,
        input.owner,
        input.repo,
        head.data.treeSha,
      )
    : null;
  let remoteEntries: RemoteTreeEntry[] = [];
  if (remoteTree) {
    if (isGithubFailure(remoteTree)) return remoteTree;
    remoteEntries = remoteTree.data;
  }

  const remoteByPath = new Map(
    remoteEntries.map((entry): [string, string] => [entry.path, entry.sha]),
  );

  type TreeEntry = {
    path: string;
    mode: "100644";
    type: "blob";
    sha: string | null;
  };
  const treeEntries: TreeEntry[] = [];
  const changedPaths: string[] = [];
  /** The paths this commit removes. */
  const deletedNow: string[] = [];

  for (const file of input.files) {
    const localSha = gitBlobSha(file.content);
    if (remoteByPath.get(file.path) === localSha) continue;

    const blob = await createBlob(input.accessToken, input.owner, input.repo, file.content);
    if (isGithubFailure(blob)) return blob;

    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.data });
    changedPaths.push(file.path);
  }

  /**
   * ⚠️ ONLY PATHS MAVLY ITSELF PUSHED ARE DELETED. A file the user wrote in
   * the repository by hand is left alone.
   */
  for (const path of input.deletePaths ?? []) {
    if (!isSafeProjectPath(path)) continue;
    if (!remoteByPath.has(path)) continue;
    if (input.files.some((file) => file.path === path)) continue;
    treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    changedPaths.push(path);
    deletedNow.push(path);
  }

  /**
   * ⭐ THE MANAGED SET. Everything Mavly has pushed to this branch and not yet
   * removed. It is the ONLY set a later push may delete from — a file the user
   * wrote in the repository by hand is never in it.
   */
  const managed = new Set<string>([
    ...(input.deletePaths ?? []),
    ...input.files.map((file) => file.path),
  ]);
  for (const path of deletedNow) managed.delete(path);

  if (treeEntries.length === 0) {
    if (!head.data) {
      // An initial branch needs at least one file. Never fabricate an empty
      // commit just to make a ref exist.
      return { ok: false, code: "github_failed" };
    }
    return {
      ok: true,
      data: {
        commitSha: head.data.sha,
        treeSha: head.data.treeSha,
        changedPaths: [],
        managedPaths: [...managed],
        unchanged: true,
        commitUrl: `https://github.com/${input.owner}/${input.repo}/commit/${head.data.sha}`,
      },
    };
  }

  const tree = await githubApi(`${base}/git/trees`, input.accessToken, {
    method: "POST",
    body: {
      ...(head.data ? { base_tree: head.data.treeSha } : {}),
      tree: treeEntries,
    },
  });
  if (isGithubFailure(tree)) return tree;

  const newTreeSha = (tree.data as { sha?: unknown })?.sha;
  if (typeof newTreeSha !== "string" || !newTreeSha) {
    return { ok: false, code: "github_invalid_response" };
  }

  const commit = await githubApi(`${base}/git/commits`, input.accessToken, {
    method: "POST",
    body: {
      message: input.message.slice(0, 500),
      tree: newTreeSha,
      parents: head.data ? [head.data.sha] : [],
    },
  });
  if (isGithubFailure(commit)) return commit;

  const newCommitSha = (commit.data as { sha?: unknown })?.sha;
  if (typeof newCommitSha !== "string" || !newCommitSha) {
    return { ok: false, code: "github_invalid_response" };
  }

  /**
   * ⚠️ `force: false`. A reference update that is not a fast-forward is
   * refused by GitHub, and that refusal is the conflict we report. Mavly never
   * rewrites a shared branch's history.
   */
  const update = head.data
    ? await githubApi(
        `${base}/git/refs/heads/${encodeURIComponent(input.branch)}`,
        input.accessToken,
        { method: "PATCH", body: { sha: newCommitSha, force: false } },
      )
    : await githubApi(`${base}/git/refs`, input.accessToken, {
        method: "POST",
        body: { ref: `refs/heads/${input.branch}`, sha: newCommitSha },
      });
  if (isGithubFailure(update)) {
    if (update.code === "github_conflict") {
      return {
        ok: false,
        code: "github_conflict",
        conflict: {
          remoteHead: head.data?.sha ?? "",
          expectedHead: input.expectedHeadSha ?? head.data?.sha ?? "",
          changedPaths: [],
        },
      };
    }
    return update;
  }

  /**
   * ⭐ THE FIRST BRANCH IS NOT REPORTED UNTIL GITHUB CAN READ IT BACK. The ref
   * creation call succeeding is a strong signal, but the user is told the
   * branch exists only after a fresh read confirms this exact commit. If the
   * read fails, the operation is a failure — never a success with an
   * unverifiable branch.
   */
  if (!head.data) {
    const confirmed = await getBranchHead(
      input.accessToken,
      input.owner,
      input.repo,
      input.branch,
    );
    if (isGithubFailure(confirmed)) return confirmed;
    if (!confirmed.data || confirmed.data.sha !== newCommitSha) {
      return { ok: false, code: "github_invalid_response" };
    }
  }

  return {
    ok: true,
    data: {
      commitSha: newCommitSha,
      treeSha: newTreeSha,
      changedPaths,
      managedPaths: [...managed],
      unchanged: false,
      commitUrl: `https://github.com/${input.owner}/${input.repo}/commit/${newCommitSha}`,
    },
  };
}
