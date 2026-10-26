/**
 * ═══ BOUNDED AI REPAIR (VERIFICATION ONLY) ══════════════════════════════════
 *
 * A failed build or runtime may be repairable in source. This module lets the
 * configured generation provider propose complete replacement files for a
 * SMALL, EXISTING subset of the snapshot, under hard bounds:
 *
 *   · at most two attempts ever, one by default;
 *   · at most five files per attempt, only paths that already exist;
 *   · package manifests and lockfiles are never editable here;
 *   · a 90 s provider timeout and 8k output tokens;
 *   · diagnostics are already redacted by the sandbox policy;
 *   · the result is a NEW immutable snapshot — the user's project is never
 *     rewritten by verification.
 *
 * ⚠️ THE MODEL'S OUTPUT IS UNTRUSTED DATA. It is parsed, path-checked, size-
 * checked and only then merged into the original file set. Nothing here runs
 * generated code; the repaired snapshot is built again inside the same
 * provider-isolated sandbox class, and `passed` still requires runtime health.
 *
 * ⚠️ COST IS REPORTED, NEVER GUESSED. The provider's own per-call cost is used
 * when present; otherwise the repair records `costKnown = false` and no price.
 */

import { isChatCompletionFailure, chatCompletion } from "@/lib/ai/provider";
import { resolveModel } from "@/lib/ai/models";
import { sanitizeProjectPath } from "@/lib/ai/agent";
import { reportedCostOf } from "@/lib/observability/cost";

import {
  REPAIR_MAX_CONTEXT_BYTES,
  REPAIR_MAX_CONTEXT_FILES,
  REPAIR_MAX_FILES,
  REPAIR_MAX_OUTPUT_TOKENS,
  REPAIR_AI_TIMEOUT_MS,
  REPAIR_MAX_DIAGNOSTIC_CHARS,
  VERIFICATION_HARD_MAX_REPAIRS,
  isRepairableErrorClass,
  type VerificationErrorClass,
} from "./state";
import {
  VERIFICATION_MAX_FILE_BYTES,
  VERIFICATION_MAX_FILES,
  isSecretPath,
  MARKER_DIRECTORY,
} from "./policy";

export interface RepairFile {
  path: string;
  content: string;
}

export interface RepairReplacement {
  path: string;
  content: string;
}

export interface RepairContext {
  files: RepairFile[];
  bytes: number;
  truncated: boolean;
}

/** Manifests are never editable: a repair changes source, not dependencies. */
const LOCKFILE_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

const DIAGNOSTIC_PATH =
  /\b((?:app|src|components|pages|lib|utils|styles|public)\/[A-Za-z0-9_./@-]+\.(?:[cm]?[jt]sx?|css|scss|json))\b/g;

const PRIORITY_BASENAMES = [
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "tsconfig.json",
  "postcss.config.js",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "tailwind.config.js",
];

export function isRepairEditablePath(path: string): boolean {
  const safe = sanitizeProjectPath(path);
  if (!safe || safe !== path) return false;
  if (safe.split("/").some((segment) => segment === MARKER_DIRECTORY)) return false;
  if (isSecretPath(safe)) return false;
  const base = safe.split("/").pop()?.toLowerCase() ?? "";
  return !LOCKFILE_BASENAMES.has(base);
}

/** Replacements are only accepted for files that already exist and may change. */
export function editableRepairPaths(files: readonly RepairFile[]): string[] {
  return files
    .map((file) => file.path)
    .filter((path) => isRepairEditablePath(path));
}

/**
 * Choose a bounded context. Paths named in the diagnostics come first so the
 * model sees the failing file even when the snapshot is large; configuration
 * and the remaining source fill the rest of the budget.
 */
export function selectRepairContext(
  files: readonly RepairFile[],
  diagnostics: readonly string[],
): RepairContext {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const ordered: RepairFile[] = [];
  const seen = new Set<string>();

  const add = (path: string): boolean => {
    if (seen.has(path)) return true;
    const file = byPath.get(path);
    if (!file) return false;
    const bytes = Buffer.byteLength(file.content, "utf8");
    const used = ordered.reduce(
      (total, entry) => total + Buffer.byteLength(entry.content, "utf8"),
      0,
    );
    if (ordered.length >= REPAIR_MAX_CONTEXT_FILES) return false;
    if (used + bytes > REPAIR_MAX_CONTEXT_BYTES) return false;
    ordered.push(file);
    seen.add(path);
    return true;
  };

  const diagnosticText = diagnostics.join("\n").slice(0, REPAIR_MAX_DIAGNOSTIC_CHARS * 2);
  for (const match of diagnosticText.matchAll(DIAGNOSTIC_PATH)) {
    add(match[1]);
  }

  for (const basename of PRIORITY_BASENAMES) {
    for (const file of files) {
      if (file.path.split("/").pop() === basename) add(file.path);
    }
  }

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    add(file.path);
  }

  const bytes = ordered.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "utf8"),
    0,
  );

  return {
    files: ordered,
    bytes,
    truncated: ordered.length < files.length,
  };
}

/** Only allowlisted failure classes may ask a model for source changes. */
export function repairAllowedFor(
  errorClass: VerificationErrorClass | null,
  attempts: number,
  maxRepairs: number,
): boolean {
  if (!isRepairableErrorClass(errorClass)) return false;
  if (!Number.isFinite(attempts) || attempts < 0) return false;
  if (!Number.isFinite(maxRepairs)) return false;
  // A count, not a threshold: 1.9 must not authorize a second attempt.
  const budget = Math.max(
    0,
    Math.min(VERIFICATION_HARD_MAX_REPAIRS, Math.trunc(maxRepairs)),
  );
  return attempts < budget;
}

export interface RepairPromptInput {
  errorClass: VerificationErrorClass;
  summary: string | null;
  diagnostics: readonly string[];
  context: RepairContext;
}

const SYSTEM_PROMPT = [
  "You repair a small generated Next.js App Router project that failed a verification build or runtime check.",
  'Return ONLY JSON of the form {"files":[{"path":"app/page.tsx","content":"...complete file..."}]}.',
  "Rules:",
  "- Replace complete files; never return diffs or partial snippets.",
  "- Only use paths present in the provided file list.",
  "- Never edit package.json, lockfiles, environment files, or keys.",
  "- Do not add files, delete files, add dependencies, or weaken checks.",
  "- Make the smallest change that addresses the reported error.",
  "- The content must be the exact file body, with no markdown fences or commentary.",
].join("\n");

export function buildRepairMessages(input: RepairPromptInput): {
  role: "system" | "user";
  content: string;
}[] {
  const diagnostics = input.diagnostics
    .join("\n")
    .slice(0, REPAIR_MAX_DIAGNOSTIC_CHARS);
  const files = input.context.files
    .map(
      (file) =>
        `<file path="${file.path}">\n${file.content}\n</file>`,
    )
    .join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Failure class: ${input.errorClass}`,
        `Summary: ${(input.summary ?? "No summary was recorded.").slice(0, 400)}`,
        "Diagnostics (redacted, tail):",
        diagnostics || "(none)",
        input.context.truncated
          ? "The file list is truncated; only the files shown may be edited."
          : "The file list is complete.",
        "Files:",
        files,
      ].join("\n"),
    },
  ];
}

export type RepairParseResult =
  | { ok: true; files: RepairReplacement[] }
  | { ok: false; reason: string };

function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Parse the model's JSON and enforce every bound before a single byte can be
 * merged or uploaded. `reason` is an allowlisted token, never model text.
 */
export function parseRepairResponse(
  raw: string,
  allowedPaths: readonly string[],
): RepairParseResult {
  const body = stripCodeFences(raw);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, reason: "invalid_json" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const list = (parsed as { files?: unknown })?.files;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, reason: "no_files" };
  }
  if (list.length > REPAIR_MAX_FILES) {
    return { ok: false, reason: "too_many_files" };
  }

  const allowed = new Set(allowedPaths);
  const seen = new Set<string>();
  const files: RepairReplacement[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: "invalid_entry" };
    }
    const path = (entry as { path?: unknown }).path;
    const content = (entry as { content?: unknown }).content;
    if (typeof path !== "string" || typeof content !== "string") {
      return { ok: false, reason: "invalid_entry" };
    }
    if (!isRepairEditablePath(path) || !allowed.has(path)) {
      return { ok: false, reason: "path_not_allowed" };
    }
    if (content.length === 0) return { ok: false, reason: "empty_file" };
    if (Buffer.byteLength(content, "utf8") > VERIFICATION_MAX_FILE_BYTES) {
      return { ok: false, reason: "file_too_large" };
    }
    if (seen.has(path)) return { ok: false, reason: "duplicate_path" };
    seen.add(path);
    files.push({ path, content });
  }

  return { ok: true, files };
}

/** Merge replacements into the original set, preserving every other file. */
export function applyRepair(
  files: readonly RepairFile[],
  replacements: readonly RepairReplacement[],
): RepairFile[] {
  const byPath = new Map(replacements.map((file) => [file.path, file.content]));
  return files.map((file) => ({
    path: file.path,
    content: byPath.get(file.path) ?? file.content,
  }));
}

/** The merged set must still fit the same verification upload bounds. */
export function mergedRepairWithinBounds(files: readonly RepairFile[]): boolean {
  if (files.length === 0 || files.length > VERIFICATION_MAX_FILES) return false;
  let total = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > VERIFICATION_MAX_FILE_BYTES) return false;
    total += bytes;
    if (total > 1_500_000) return false;
  }
  return true;
}

// ── Provider call ──────────────────────────────────────────────────────────

export interface RepairGenerationInput {
  errorClass: VerificationErrorClass;
  summary: string | null;
  diagnostics: readonly string[];
  context: RepairContext;
  allowedPaths: readonly string[];
  signal?: AbortSignal;
}

export interface RepairGenerationResult {
  ok: boolean;
  files: RepairReplacement[];
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  costKnown: boolean;
  reason: string | null;
}

const EMPTY_GENERATION: RepairGenerationResult = {
  ok: false,
  files: [],
  model: null,
  promptTokens: null,
  completionTokens: null,
  costUsd: null,
  costKnown: false,
  reason: "unavailable",
};

/**
 * Ask the configured provider for a repair. A missing key, a provider error,
 * an invalid shape or a policy violation are all the same to the caller: the
 * repair did not happen and the original failure stands.
 */
export async function generateRepair(
  input: RepairGenerationInput,
): Promise<RepairGenerationResult> {
  const model = resolveModel(undefined, "repair");
  const result = await chatCompletion(
    model,
    buildRepairMessages({
      errorClass: input.errorClass,
      summary: input.summary,
      diagnostics: input.diagnostics,
      context: input.context,
    }),
    {
      timeoutMs: REPAIR_AI_TIMEOUT_MS,
      maxTokens: REPAIR_MAX_OUTPUT_TOKENS,
      temperature: 0,
      signal: input.signal,
    },
  );

  if (isChatCompletionFailure(result)) {
    return {
      ...EMPTY_GENERATION,
      model: result.metadata.model ?? model.id,
      reason: "provider_failed",
    };
  }

  const parsed = parseRepairResponse(result.content, input.allowedPaths);
  const cost = reportedCostOf([{ costUsd: result.metadata.usage.costUsd }]);
  if (parsed.ok === false) {
    return {
      ok: false,
      files: [],
      model: result.metadata.model ?? result.model ?? model.id,
      promptTokens: result.metadata.usage.promptTokens,
      completionTokens: result.metadata.usage.completionTokens,
      costUsd: cost.costUsd,
      costKnown: cost.known,
      reason: parsed.reason,
    };
  }

  return {
    ok: true,
    files: parsed.files,
    model: result.metadata.model ?? result.model ?? model.id,
    promptTokens: result.metadata.usage.promptTokens,
    completionTokens: result.metadata.usage.completionTokens,
    costUsd: cost.costUsd,
    costKnown: cost.known,
    reason: null,
  };
}
