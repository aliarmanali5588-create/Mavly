/**
 * ═══ THE FILE-INCLUSION POLICY ═════════════════════════════════════════════
 *
 * One place decides what may leave the project, what may come back into it,
 * and what may never be written at all. It is deliberately stricter than a
 * `.gitignore`: a `.gitignore` is a file in the repository, it is not a
 * security control, and a generated project can contain anything.
 *
 * ⚠️ THE RULES, IN ORDER OF WHY THEY EXIST:
 *
 *   1. Secrets and environment files are never pushed, never imported and
 *      never restored from an unsafe source. `.env*` (except the example),
 *      private keys, certificates and credential files are refused.
 *   2. Dependency directories, build output and caches are never pushed: they
 *      are regenerated, they are huge, and they carry absolute paths from the
 *      machine that built them.
 *   3. Every path is validated before it is used as a path: no traversal, no
 *      absolute paths, no control characters, no reserved names.
 *   4. Sizes are bounded, so one enormous file cannot fill the database or
 *      the GitHub API's patience.
 *
 * ⚠️ THE PROJECT'S OWN FILES ARE ALREADY SAFE. `sanitizeProjectPath` refuses
 * `.env*` and dependency directories before anything is written to
 * `project_files`, so a snapshot of a project cannot contain a secret in the
 * first place. This policy is the second line of defence, and the only one
 * that applies to files arriving FROM GitHub.
 */

/** Directories that are never pushed and never imported. */
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  ".cache",
  ".output",
  ".svelte-kit",
  "node_modules",
  "bower_components",
  "coverage",
  "dist",
  "build",
  "out",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Exact file names that are never pushed and never imported. */
const EXCLUDED_FILE_NAMES = new Set([
  ".ds_store",
  ".env",
  ".envrc",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "npm-debug.log",
  "yarn-error.log",
  "pnpm-debug.log",
]);

/** File suffixes that are never pushed and never imported. */
const EXCLUDED_EXTENSIONS = new Set([
  ".key",
  ".p12",
  ".pfx",
  ".pem",
  ".crt",
  ".cer",
  ".keystore",
  ".jks",
  ".log",
]);

/** The largest file that may be pushed or imported. */
export const MAX_GITHUB_FILE_BYTES = 256 * 1024;
/** The largest total payload of one push or one import. */
export const MAX_GITHUB_TOTAL_BYTES = 1_500_000;
/**
 * The largest number of files in one push or one import.
 *
 * ⚠️ THIS IS AN EXPLICIT LIMIT, NOT A SILENT TRUNCATION POINT. An import that
 * exceeds it fails before writing anything, and a push refuses to send a
 * partial commit; neither moves the first N files and reports success.
 */
export const MAX_GITHUB_FILES = 2_000;
/** The exclusion reason callers use to refuse a partial push or import. */
export const TOO_MANY_FILES_REASON = "too many files to move at once";

/**
 * Is this path one Mavly refuses to move at all?
 *
 * ⚠️ `.env.example` IS ALLOWED. It is the file that documents which variables
 * a project needs, and it holds no secret by definition.
 */
export function isExcludedPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return true;

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (EXCLUDED_DIRECTORIES.has(lower)) return true;
  }

  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  if (EXCLUDED_FILE_NAMES.has(base)) return true;
  if (base.startsWith(".env.") && base !== ".env.example") return true;
  if (base.endsWith(".tsbuildinfo")) return true;

  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const extension = base.slice(dot);
    if (EXCLUDED_EXTENSIONS.has(extension)) return true;
  }

  return false;
}

/**
 * Is this a path that is safe to WRITE — no traversal, no absolute path, no
 * control characters, nothing empty?
 *
 * ⚠️ This is a validation, not a filter: a path that fails it is refused
 * outright rather than quietly rewritten.
 */
export function isSafeProjectPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const value = path.trim();
  if (!value || value.length > 512) return false;
  if (value.includes("\0") || /[\u0000-\u001f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("~")) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes("\\")) return false;

  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return true;
}

/** A repository owner (a user or an organization login). */
export function isSafeOwner(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const owner = value.trim();
  if (!owner || owner.length > 100) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner);
}

/** A repository name. */
export function isSafeRepoName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.trim();
  if (!name || name.length > 120) return false;
  if (name === "." || name === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * A branch name.
 *
 * ⚠️ Git's own rules, loosely: no control characters, no spaces at the ends,
 * no `..`, no leading/trailing `/`, no `@{`. A branch name is put into a URL
 * path, so it is encoded — but it is also put into a ref, and Git refuses
 * some shapes outright.
 */
export function isSafeBranchName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const branch = value.trim();
  if (!branch || branch.length > 255) return false;
  if (/[\u0000-\u001f ~^:?*\[\\]/.test(branch)) return false;
  if (branch.includes("..") || branch.includes("//")) return false;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".lock")) return false;
  if (branch.startsWith("-") || branch.startsWith(".")) return false;
  if (branch.includes("@{")) return false;
  return true;
}

/**
 * Does this file's CONTENT look like a credential?
 *
 * ⚠️ A HEURISTIC, NOT A SCANNER. It catches the shapes that must never be
 * published — a private key block, a GitHub token, a Slack token — and it is
 * used to REFUSE a push, never to rewrite a file. A false positive costs the
 * user one file; a false negative would publish a secret.
 */
export function looksLikeSecret(content: string): boolean {
  const patterns: RegExp[] = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
    /\bsk-[A-Za-z0-9]{20,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ];
  return patterns.some((pattern) => pattern.test(content));
}

/** The outcome of applying the policy to a set of files. */
export interface PolicyResult<T> {
  included: T[];
  /** The paths that were refused, with the reason. */
  excluded: { path: string; reason: string }[];
}

/**
 * Apply the inclusion policy to a set of files.
 *
 * ⚠️ A FILE THAT LOOKS LIKE A SECRET IS REFUSED, NOT SENT. The user is told
 * which file and why; nothing about its content is logged.
 */
export function applyFilePolicy<T extends { path: string; content: string }>(
  files: readonly T[],
): PolicyResult<T> {
  const included: T[] = [];
  const excluded: { path: string; reason: string }[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (!isSafeProjectPath(file.path)) {
      excluded.push({ path: file.path, reason: "unsafe path" });
      continue;
    }
    if (isExcludedPath(file.path)) {
      excluded.push({ path: file.path, reason: "excluded by policy" });
      continue;
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_GITHUB_FILE_BYTES) {
      excluded.push({ path: file.path, reason: "file is too large" });
      continue;
    }
    if (totalBytes + bytes > MAX_GITHUB_TOTAL_BYTES) {
      excluded.push({ path: file.path, reason: "the project is too large" });
      continue;
    }
    if (looksLikeSecret(file.content)) {
      excluded.push({ path: file.path, reason: "this file looks like it contains a secret" });
      continue;
    }

    totalBytes += bytes;
    included.push(file);
  }

  if (included.length > MAX_GITHUB_FILES) {
    const overflow = included.slice(MAX_GITHUB_FILES);
    for (const file of overflow) {
      excluded.push({ path: file.path, reason: TOO_MANY_FILES_REASON });
    }
    included.length = MAX_GITHUB_FILES;
  }

  return { included, excluded };
}
