/**
 * ═══ PACKAGE MANIFEST VALIDATION ════════════════════════════════════════════
 *
 * Everything here treats `package.json` as untrusted generated text. Parsing is
 * cheap and total: malformed input returns a diagnostic, never an exception.
 *
 * Only the fields verification needs are read. Dependency ranges are not
 * resolved here; npm does that inside the isolated sandbox.
 */

import {
  DEFAULT_NODE_IMAGE,
  type RuntimeFailureCode,
  type SourceFile,
} from "./profile";

export const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
export const MAX_LOCKFILE_BYTES = 5 * 1024 * 1024;

export interface PackageManifest {
  name: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: Record<string, string>;
  packageManager: string | null;
  workspaces: unknown;
}

export type ManifestFailure =
  | {
      ok: false;
      code: "invalid_manifest" | "invalid_lockfile";
      summary: string;
      diagnostics: string[];
    }
  | { ok: false; code: "unsupported_runtime"; summary: string; diagnostics: string[] };

type ManifestResult =
  | { ok: true; manifest: PackageManifest }
  | ManifestFailure;

function failure(
  code: "invalid_manifest" | "invalid_lockfile" | "unsupported_runtime",
  summary: string,
  diagnostics: string[] = [],
): ManifestFailure {
  return { ok: false, code, summary, diagnostics };
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") return null;
    record[key] = entry;
  }
  return record;
}

/** Parse the root package.json from validated project files. */
export function parsePackageManifest(files: readonly SourceFile[]): ManifestResult {
  const file = files.find((entry) => entry.path === "package.json");
  if (!file) {
    return failure(
      "unsupported_runtime",
      "This project has no package.json, so there is nothing to build.",
    );
  }
  if (Buffer.byteLength(file.content, "utf8") > MAX_PACKAGE_JSON_BYTES) {
    return failure(
      "invalid_manifest",
      `package.json is larger than ${MAX_PACKAGE_JSON_BYTES} bytes.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return failure("invalid_manifest", "package.json is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failure("invalid_manifest", "package.json must contain a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const scripts = stringRecord(record.scripts) ?? {};
  const dependencies = stringRecord(record.dependencies) ?? {};
  const devDependencies = stringRecord(record.devDependencies) ?? {};
  const engines = stringRecord(record.engines) ?? {};

  if (record.scripts !== undefined && stringRecord(record.scripts) === null) {
    return failure("invalid_manifest", "package.json scripts must be string values.");
  }
  if (record.dependencies !== undefined && stringRecord(record.dependencies) === null) {
    return failure("invalid_manifest", "package.json dependencies must be string values.");
  }
  if (record.devDependencies !== undefined && stringRecord(record.devDependencies) === null) {
    return failure("invalid_manifest", "package.json devDependencies must be string values.");
  }

  const packageManager =
    typeof record.packageManager === "string" ? record.packageManager.trim() : null;

  return {
    ok: true,
    manifest: {
      name: typeof record.name === "string" ? record.name.slice(0, 200) : null,
      scripts,
      dependencies,
      devDependencies,
      engines,
      packageManager: packageManager || null,
      workspaces: record.workspaces,
    },
  };
}

export type NodeImageSelection =
  | { ok: true; nodeImage: string }
  | {
      ok: false;
      code: RuntimeFailureCode;
      summary: string;
      diagnostics: string[];
    };

const MANAGED_NODE_IMAGES = [
  { major: 22, image: DEFAULT_NODE_IMAGE },
  { major: 24, image: "vercel/sandbox/node:24" },
  { major: 26, image: "vercel/sandbox/node:26" },
] as const;

/**
 * Pick the managed Node image that can satisfy `engines.node`.
 *
 * This is deliberately conservative. If the declaration cannot be satisfied by
 * a managed image (for example an exact Node 20 requirement), verification is
 * unsupported rather than silently run on the wrong runtime.
 */
export function nodeImageForEngines(
  engines: Record<string, string>,
): NodeImageSelection | null {
  const raw = engines.node?.trim();
  if (!raw) return null;

  // Only the first `||` alternative is considered; that is the narrowest
  // supported reading and never widens what we are willing to run.
  const clause = raw.split("||")[0].trim();
  if (!clause) return null;

  const first = Number(clause.match(/\d+/)?.[0]);
  if (!Number.isFinite(first)) return null;

  const lowerBound = clause.startsWith(">=") || clause.startsWith(">");
  if (lowerBound) {
    const minimum = clause.startsWith(">") && !clause.startsWith(">=") ? first + 1 : first;
    const match = MANAGED_NODE_IMAGES.find((candidate) => candidate.major >= minimum);
    if (match) return { ok: true, nodeImage: match.image };
    return {
      ok: false,
      code: "unsupported_runtime",
      summary: `engines.node "${raw}" requires Node newer than the managed runtime.`,
      diagnostics: ["Supported Node images: 22, 24, 26."],
    };
  }

  const exact = MANAGED_NODE_IMAGES.find((candidate) => candidate.major === first);
  if (exact) return { ok: true, nodeImage: exact.image };

  return {
    ok: false,
    code: "unsupported_runtime",
    summary: `engines.node "${raw}" cannot be satisfied by a managed Node image.`,
    diagnostics: ["Supported Node images: 22, 24, 26."],
  };
}

/** The root npm lockfile, when one exists and is structurally plausible. */
export function readNpmLockfile(
  files: readonly SourceFile[],
): { ok: true; present: boolean } | ManifestFailure {
  const file = files.find((entry) => entry.path === "package-lock.json");
  if (!file) return { ok: true, present: false };
  if (Buffer.byteLength(file.content, "utf8") > MAX_LOCKFILE_BYTES) {
    return failure("invalid_lockfile", "package-lock.json is larger than the verification limit.");
  }
  try {
    const parsed = JSON.parse(file.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return failure("invalid_lockfile", "package-lock.json must contain a JSON object.");
    }
    const version = (parsed as Record<string, unknown>).lockfileVersion;
    if (typeof version !== "number" || !Number.isFinite(version)) {
      return failure("invalid_lockfile", "package-lock.json has no numeric lockfileVersion.");
    }
  } catch {
    return failure("invalid_lockfile", "package-lock.json is not valid JSON.");
  }
  return { ok: true, present: true };
}
