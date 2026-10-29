/**
 * ═══ RUNTIME FILE POLICY — SERVER-SIDE, DETERMINISTIC ═════════════════════
 *
 * Server-only: it uses `node:crypto` for the source hash and `Buffer` for byte
 * sizes. Nothing here is imported by the workspace component.
 *
 * Which persisted files may be materialized in an untrusted sandbox, and what a
 * sync is allowed to remove. There is ONE source of truth for project files
 * (`project_files`); the sandbox is a disposable working copy.
 *
 * ⚠️ PATH SAFETY IS NOT DECORATION. A generated path is data from a model. It is
 * validated here (relative, POSIX, no traversal, no absolute paths, no
 * backslashes, no NUL bytes) BEFORE it is joined with the sandbox project
 * directory. The E2B adapter validates again and never accepts an absolute path
 * from its caller.
 */

import { createHash } from "node:crypto";

export const RUNTIME_PROJECT_DIR = "/home/user/project";
export const RUNTIME_LOG_DIR = "/home/user/runtime";
export const RUNTIME_DEV_LOG = "/home/user/runtime/dev.log";
export const RUNTIME_INSTALL_LOG = "/home/user/runtime/install.log";

/** Directories and files that must never enter the runtime. */
const EXCLUDED_PATTERNS: readonly RegExp[] = [
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.next(\/|$)/i,
  /(^|\/)\.turbo(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)build(\/|$)/i,
  /(^|\/)coverage(\/|$)/i,
  /(^|\/)\.cache(\/|$)/i,
  /(^|\/)\.vercel(\/|$)/i,
  /(^|\/)\.DS_Store$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.gitignore$/i,
  /\.(pem|key|p12|pfx|keystore|jks|apk|aab|so|dll|dylib|exe|bin)$/i,
];

export type PathRejection =
  | "empty"
  | "absolute"
  | "traversal"
  | "backslash"
  | "nul_byte"
  | "excluded"
  | "too_long"
  | "unsafe_character";

export function projectPathRejection(
  raw: unknown,
  maxLength = 240,
): PathRejection | null {
  if (typeof raw !== "string") return "unsafe_character";
  const path = raw.trim();
  if (!path) return "empty";
  if (path.length > maxLength) return "too_long";
  if (path.includes("\0")) return "nul_byte";
  if (path.includes("\\")) return "backslash";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "absolute";
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) return "traversal";
  if (segments.some((segment) => segment === "")) return "unsafe_character";
  if (!/^[A-Za-z0-9._~@+\-/]+$/.test(path)) return "unsafe_character";
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(path)) return "excluded";
  }
  return null;
}

export function isSafeProjectPath(raw: unknown): raw is string {
  return projectPathRejection(raw) === null;
}

/** Join a validated relative path onto the project directory. */
export function sandboxPathFor(relativePath: string): string {
  if (projectPathRejection(relativePath) !== null) {
    throw new Error("Unsafe sandbox path");
  }
  return `${RUNTIME_PROJECT_DIR}/${relativePath}`;
}

export interface SyncSourceFile {
  path: string;
  content: string;
}

/**
 * The content hash of one source state. Sorted path+content so it is stable
 * across orderings, and identical to the hash the runtime session stores. Used
 * to decide reuse AND to reject stale runtime evidence for a newer run.
 */
export function sourceHashForFiles(files: readonly SyncSourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.content);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

export interface SkippedFile {
  path: string;
  reason: PathRejection | "too_large" | "binary" | "duplicate";
}

export interface RuntimeSyncPlan {
  files: SyncSourceFile[];
  skipped: SkippedFile[];
  /** Previously synced paths that are no longer authoritative. */
  removed: string[];
  bytes: number;
}

export interface SyncLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

/**
 * Plan one materialization. It never throws and never silently drops a file:
 * every exclusion is reported, and the caller decides whether the project is
 * still runnable (a skipped `package.json` is a failure, a skipped README is not).
 */
export function planProjectSync(
  files: readonly SyncSourceFile[],
  limits: SyncLimits,
  previousPaths: readonly string[] = [],
): RuntimeSyncPlan {
  const planned: SyncSourceFile[] = [];
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;

  for (const file of files) {
    const rejection = projectPathRejection(file.path);
    if (rejection) {
      skipped.push({ path: String(file.path).slice(0, 200), reason: rejection });
      continue;
    }
    if (seen.has(file.path)) {
      skipped.push({ path: file.path, reason: "duplicate" });
      continue;
    }
    if (typeof file.content !== "string") {
      skipped.push({ path: file.path, reason: "binary" });
      continue;
    }
    if (file.content.includes("\0")) {
      skipped.push({ path: file.path, reason: "binary" });
      continue;
    }
    const size = Buffer.byteLength(file.content, "utf8");
    if (size > limits.maxFileBytes) {
      skipped.push({ path: file.path, reason: "too_large" });
      continue;
    }
    if (planned.length >= limits.maxFiles) {
      skipped.push({ path: file.path, reason: "too_large" });
      continue;
    }
    if (bytes + size > limits.maxTotalBytes) {
      skipped.push({ path: file.path, reason: "too_large" });
      continue;
    }
    seen.add(file.path);
    planned.push({ path: file.path, content: file.content });
    bytes += size;
  }

  const authoritative = new Set(planned.map((file) => file.path));
  const removed = previousPaths.filter(
    (path) => isSafeProjectPath(path) && !authoritative.has(path),
  );

  return { files: planned, skipped, removed, bytes };
}

/**
 * A sync is only usable when the files the runtime needs survived the limits.
 * This is what turns "package.json was 3 MB" into a specific failure instead of
 * a Vite error nobody can act on.
 */
export function syncMissingRequiredFiles(
  plan: RuntimeSyncPlan,
  required: readonly string[] = ["package.json", "index.html"],
): string[] {
  const present = new Set(plan.files.map((file) => file.path));
  return required.filter((path) => !present.has(path));
}
