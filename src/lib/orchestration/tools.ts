/**
 * ═══ THE SCOPED TOOL REGISTRY ═══════════════════════════════════════════════
 *
 * A role may only ask for a tool that its catalog entry allows, and every
 * argument is validated before the orchestrator sees it. There is no shell, no
 * filesystem path outside the project, no arbitrary URL, no database client and
 * no provider credential in this registry.
 *
 * ⚠️ NOTHING HERE EXECUTES GENERATED CODE. `run_project_checks` and
 * `inspect_preview` describe a request the EXISTING verification pipeline may
 * satisfy; when that pipeline is disabled the truthful result is
 * `unavailable`, never "passed".
 */

import { sanitizeProjectPath } from "@/lib/ai/agent";
import { VERIFICATION_MAX_FILE_BYTES } from "@/lib/sandbox/policy";

import type { AgentRole, ProjectFile } from "./contracts";
import { AGENT_TOOLS, ROLE_CATALOG, type AgentToolName } from "./roles";

export type ToolRejectionCode =
  | "tool_not_allowed"
  | "invalid_arguments"
  | "unsafe_path"
  | "secret_path"
  | "unknown_path"
  | "too_large"
  | "too_many_files"
  | "not_executable";

export interface ToolRejection {
  ok: false;
  code: ToolRejectionCode;
  reason: string;
}

export type ToolValidation =
  | { ok: true; tool: AgentToolName; args: Record<string, unknown> }
  | ToolRejection;

function reject(code: ToolRejectionCode, reason: string): ToolRejection {
  return { ok: false, code, reason };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isSecretPath(path: string): boolean {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (!base) return true;
  if (base === ".env.example") return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks|apk|aab|jar|aar)$/i.test(base)) return true;
  if (/^(id_rsa|id_ed25519|credentials|secrets?)\./i.test(base)) return true;
  return false;
}

function pathList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > 20) return null;
  const paths: string[] = [];
  for (const entry of value) {
    const path = sanitizeProjectPath(entry);
    if (!path) return null;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

const MAX_APPLY_FILES = 20;
const MAX_APPLY_BYTES = 1_500_000;

function validateApplyChanges(
  args: Record<string, unknown>,
  existingPaths: ReadonlySet<string>,
): ToolValidation {
  const rawFiles = args.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return reject("invalid_arguments", "apply_file_changes needs a non-empty files array.");
  }
  if (rawFiles.length > MAX_APPLY_FILES) {
    return reject(
      "too_many_files",
      `apply_file_changes accepts at most ${MAX_APPLY_FILES} files.`,
    );
  }

  const files: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of rawFiles) {
    const item = record(entry);
    // Check the secret shape before sanitizing: a generic path sanitizer rejects
    // `.env` as unsafe, but the caller deserves the more specific refusal.
    const intended =
      typeof item.path === "string"
        ? item.path.trim().replaceAll("\\", "/").replace(/^\.\//, "")
        : "";
    if (intended && isSecretPath(intended)) {
      return reject("secret_path", "A proposed path is a secret or binary artifact.");
    }
    const path = sanitizeProjectPath(item.path);
    if (!path) return reject("unsafe_path", "A proposed path is not a safe project path.");
    if (isSecretPath(path)) {
      return reject("secret_path", "A proposed path is a secret or binary artifact.");
    }
    if (seen.has(path)) {
      return reject("invalid_arguments", `The change list contains ${path} twice.`);
    }
    if (typeof item.content !== "string" || item.content.includes("\u0000")) {
      return reject("invalid_arguments", `The proposed content for ${path} is not text.`);
    }
    const bytes = Buffer.byteLength(item.content, "utf8");
    if (bytes > VERIFICATION_MAX_FILE_BYTES) {
      return reject("too_large", `${path} exceeds the per-file size limit.`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_APPLY_BYTES) {
      return reject("too_large", "The proposed change set exceeds the total size limit.");
    }
    seen.add(path);
    files.push({ path, content: item.content });
  }

  const rawDeleted = args.deletedPaths;
  const deletedPaths: string[] = [];
  if (rawDeleted !== undefined) {
    if (!Array.isArray(rawDeleted) || rawDeleted.length > MAX_APPLY_FILES) {
      return reject("invalid_arguments", "deletedPaths must be a bounded array.");
    }
    for (const entry of rawDeleted) {
      const path = sanitizeProjectPath(entry);
      if (!path) return reject("unsafe_path", "A deleted path is not a safe project path.");
      if (!existingPaths.has(path)) {
        return reject("unknown_path", `Only existing files may be deleted (${path}).`);
      }
      if (!deletedPaths.includes(path)) deletedPaths.push(path);
    }
  }

  return { ok: true, tool: "apply_file_changes", args: { files, deletedPaths } };
}

/**
 * Validate one role tool request. `files` is the current project source; it is
 * used only to prove a read/delete target exists, never to trust a model claim.
 */
export function validateToolRequest(input: {
  role: AgentRole;
  tool: unknown;
  args: unknown;
  files: readonly ProjectFile[];
}): ToolValidation {
  const tool = typeof input.tool === "string" ? input.tool : "";
  if (!(AGENT_TOOLS as readonly string[]).includes(tool)) {
    return reject("tool_not_allowed", "That tool is not registered.");
  }
  const name = tool as AgentToolName;
  if (!ROLE_CATALOG[input.role].tools.includes(name)) {
    return reject("tool_not_allowed", `${input.role} may not use ${name}.`);
  }

  const args = record(input.args);
  const existingPaths = new Set(input.files.map((file) => file.path));

  switch (name) {
    case "list_files":
      return { ok: true, tool: name, args: {} };
    case "read_files": {
      const paths = pathList(args.paths);
      if (!paths) return reject("invalid_arguments", "read_files needs up to 20 safe paths.");
      for (const path of paths) {
        if (isSecretPath(path)) return reject("secret_path", "A secret file may not be read.");
        if (!existingPaths.has(path)) {
          return reject("unknown_path", `The project has no file at ${path}.`);
        }
      }
      return { ok: true, tool: name, args: { paths } };
    }
    case "apply_file_changes":
      return validateApplyChanges(args, existingPaths);
    case "run_project_checks": {
      const profile = args.profile;
      if (profile !== "next-app-router" && profile !== "android-debug") {
        return reject(
          "invalid_arguments",
          "run_project_checks accepts only the fixed next-app-router or android-debug profiles.",
        );
      }
      return { ok: true, tool: name, args: { profile } };
    }
    case "read_execution_logs": {
      const source = args.source;
      if (source !== "verification" && source !== "run" && source !== "android-build") {
        return reject("invalid_arguments", "Unknown execution-log source.");
      }
      return { ok: true, tool: name, args: { source } };
    }
    case "inspect_preview":
      return { ok: true, tool: name, args: {} };
    case "request_deployment_approval": {
      const target = args.target;
      if (target !== "static" && target !== "fullstack") {
        return reject("invalid_arguments", "A deployment target must be static or fullstack.");
      }
      const snapshotId =
        typeof args.snapshotId === "string" && args.snapshotId.trim()
          ? args.snapshotId.trim()
          : null;
      if (snapshotId && !/^[0-9a-f-]{36}$/i.test(snapshotId)) {
        return reject("invalid_arguments", "The snapshot id is not valid.");
      }
      const note =
        typeof args.note === "string" ? args.note.trim().slice(0, 1_000) : null;
      return { ok: true, tool: name, args: { target, snapshotId, note } };
    }
    default:
      return reject("tool_not_allowed", "That tool is not registered.");
  }
}

/**
 * Tools that would require a real execution environment. A role may REQUEST
 * them, but this deployment cannot satisfy the request unless the existing
 * sandbox pipeline is configured — in which case the orchestrator reads the
 * recorded result instead of executing anything itself.
 */
export function toolCannotExecuteHere(tool: AgentToolName): string | null {
  switch (tool) {
    case "run_project_checks":
      return "Project checks run only inside the configured verification sandbox; this registry never executes a command itself.";
    case "inspect_preview":
      return "A public preview URL is not available; preview delivery stays with the existing workspace runtime.";
    default:
      return null;
  }
}
