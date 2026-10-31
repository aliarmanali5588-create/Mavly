/**
 * ═══ WEBSITE CHANGE CLASSIFICATION AND SCOPE ENFORCEMENT ════════════════════
 *
 * The model chooses WHAT to build. This module decides whether the plan is
 * allowed to leave the project's approved scope. It is the backend-level guard,
 * not a prompt suggestion:
 *
 *   · `.mavly/**` is server-owned and can never be written or deleted by a model;
 *   · a simple edit cannot rewrite half the project;
 *   · a deletion must be requested, not incidental;
 *   · core entry points, API routes and auth/session code are protected from a
 *     silent removal;
 *   · a genuinely broad change needs the user to ask for it.
 *
 * It is PURE and has no Supabase/provider import, so it can run before anything
 * is persisted and a unit test can prove it without a database.
 *
 * ⚠️ Android generation does not use this module. Its source contract and path
 * policy are separate and must stay unchanged.
 */

import { isAgentControlPath } from "./rules";

export type ChangeClass = "simple" | "medium" | "major";

export interface ChangeClassificationInput {
  mode: "create" | "update";
  prompt: string;
  /** Files outside `.mavly` that the project already has. */
  existingFileCount: number;
}

const MAJOR_TERMS = [
  "redesign",
  "rebrand",
  "overhaul",
  "rewrite",
  "re-architect",
  "rearchitect",
  "migrate",
  "migration",
  "new architecture",
  "from scratch",
  "authentication",
  "auth",
  "login",
  "signup",
  "oauth",
  "database",
  "postgres",
  "supabase",
  "payment",
  "razorpay",
  "stripe",
  "checkout",
  "admin dashboard",
  "roles",
  "permissions",
  "multi-tenant",
  "multi tenant",
] as const;

const STRUCTURAL_TERMS = [
  "new page",
  "add a page",
  "add page",
  "new section",
  "add a section",
  "add section",
  "new route",
  "add a route",
  "new api",
  "endpoint",
  "backend",
  "component",
  "dashboard",
  "filter",
  "search",
  "cart",
  "upload",
  "integration",
  "localization",
  "internationalization",
  "animation",
  "responsive",
] as const;

/**
 * ⚠️ AUTHORIZATION IS EXPLICIT PERMISSION, NOT AN ACTION WORD. "Redesign the
 * hero" is a real request (and classifies as a major change), but it does not
 * authorize deleting unrelated files. Only sentences that grant broad latitude
 * ("authorize", "full refactor", "across the whole project") do.
 */
const AUTHORIZATION_PATTERNS =
  /(?:^|[^a-z])(?:i\s+)?authori[sz]e|approved\s+to|you\s+may\s+(?:change|edit|modify|refactor|replace)|feel\s+free\s+to|across\s+the\s+(?:whole|entire)\s+project|full\s+refactor|refactor\s+the\s+(?:project|codebase)|go\s+ahead\s+and\s+(?:change|refactor|rewrite)/i;

const DELETION_PATTERN = /\b(?:delete|remove|drop|rename|replace|clean\s*up|no\s+longer\s+(?:need|want|use)|get\s+rid\s+of)\b/i;

const API_TERMS =
  /\b(?:api|route|endpoint|server|backend|auth|login|logout|session|database|data|save|saved|submit|form|email|payment|checkout|order|upload)\b/i;

const ENGINE_TERMS =
  /\b(?:package|dependency|dependencies|install|library|npm|font|animation|chart|icon)\b/i;

/** The user explicitly asked for a broad change. */
export function hasBroadAuthorization(prompt: string): boolean {
  return AUTHORIZATION_PATTERNS.test(prompt);
}

/** Whole-token match so "auth" does not match "author" and "search" not "research". */
function containsTerm(lowerPrompt: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`).test(lowerPrompt);
}

/**
 * A deterministic classification used by the prompts, the work log and the
 * scope caps. It is conservative: an ambiguous update is `medium`, never
 * `simple`.
 */
export function classifyChange(input: ChangeClassificationInput): ChangeClass {
  if (input.mode === "create") return "major";

  const prompt = input.prompt.trim();
  const lower = prompt.toLowerCase();
  if (hasBroadAuthorization(prompt)) return "major";

  const majorTerms = MAJOR_TERMS.filter((term) => containsTerm(lower, term));
  const structuralTerms = STRUCTURAL_TERMS.filter((term) => containsTerm(lower, term));

  if (
    majorTerms.length > 0 ||
    majorTerms.length + structuralTerms.length >= 3 ||
    prompt.length >= 700 ||
    input.existingFileCount >= 35
  ) {
    return "major";
  }

  if (
    prompt.length <= 280 &&
    input.existingFileCount <= 8 &&
    structuralTerms.length === 0
  ) {
    return "simple";
  }

  return "medium";
}

export interface ScopeViolation {
  code: string;
  path?: string;
  message: string;
}

export interface ScopeValidationInput {
  mode: "create" | "update";
  prompt: string;
  changeClass: ChangeClass;
  plannedPaths: readonly string[];
  deletedPaths: readonly string[];
  existingPaths: readonly string[];
  /** Entry points that keep the website runnable and previewable. */
  requiredPaths: readonly string[];
}

export type ScopeValidation =
  | { ok: true }
  | { ok: false; violations: ScopeViolation[]; summary: string };

const SIMPLE_MAX_FILES = 8;
const MEDIUM_MAX_FILES = 24;
const BROAD_MAX_FILES = 60;

function limitsFor(changeClass: ChangeClass, broad: boolean): number {
  if (broad) return BROAD_MAX_FILES;
  if (changeClass === "simple") return SIMPLE_MAX_FILES;
  if (changeClass === "medium") return MEDIUM_MAX_FILES;
  return 80;
}

/** Path segments that identify a file only together with its full path. */
const GENERIC_SEGMENTS = new Set([
  "app",
  "src",
  "lib",
  "pages",
  "page",
  "index",
  "layout",
  "components",
  "component",
  "public",
  "styles",
  "style",
  "api",
  "route",
  "tsx",
  "ts",
  "js",
  "jsx",
  "css",
  "md",
  "html",
]);

/** The prompt names this file specifically enough to authorize deleting it. */
function mentionsPath(prompt: string, path: string): boolean {
  const lower = prompt.toLowerCase();
  const full = path.toLowerCase();
  if (lower.includes(full)) return true;
  const distinctive = path
    .toLowerCase()
    .split("/")
    .map((segment) => segment.replace(/\.[^.]+$/, ""))
    .filter((segment) => segment.length >= 3 && !GENERIC_SEGMENTS.has(segment));
  /**
   * ⚠️ A GENERIC BASENAME IS NOT AUTHORIZATION. "Delete the page" must not
   * authorize removing `app/page.tsx` or every `page.tsx`; a distinctive
   * directory ("about" in app/about/page.tsx, "hero" in components/Hero.tsx) is
   * what identifies one file.
   */
  return distinctive.some((segment) => containsTerm(lower, segment));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isProtectedFromSilentEdit(path: string): boolean {
  return (
    path === "package.json" ||
    path.startsWith("app/api/") ||
    path.startsWith("src/app/api/") ||
    /(?:^|\/)middleware\.(?:ts|js|tsx|jsx)$/.test(path) ||
    /(?:^|\/)next\.config\.(?:js|cjs|mjs|ts)$/.test(path) ||
    /(?:^|\/)(?:lib|src\/lib)\/(?:auth|supabase|db|database|managed-backend)\//.test(path) ||
    path.startsWith("supabase/")
  );
}

function editAllowedForSimple(path: string, prompt: string): boolean {
  if (!isProtectedFromSilentEdit(path)) return true;
  if (path === "package.json") return ENGINE_TERMS.test(prompt);
  return API_TERMS.test(prompt);
}

function deletionRequested(prompt: string, path: string): boolean {
  if (!mentionsPath(prompt, path)) return false;
  return DELETION_PATTERN.test(prompt);
}

/**
 * Validate one planned manifest before anything is written.
 *
 * ⚠️ THIS RUNS BEFORE `onManifest`, SO A REFUSED PLAN LEAVES THE PROJECT
 * UNTOUCHED. The message names the exact reason and tells the user how to
 * authorize the change explicitly.
 */
export function validateWebsiteScope(input: ScopeValidationInput): ScopeValidation {
  const violations: ScopeViolation[] = [];
  const broad = hasBroadAuthorization(input.prompt);
  const planned = [...new Set(input.plannedPaths)];
  const deleted = [...new Set(input.deletedPaths)];
  const required = new Set(input.requiredPaths);

  for (const path of planned) {
    if (isAgentControlPath(path)) {
      violations.push({
        code: "control_file_write",
        path,
        message: `${path} is a Mavly control file and cannot be written by an agent.`,
      });
    }
  }

  for (const path of deleted) {
    if (isAgentControlPath(path)) {
      violations.push({
        code: "control_file_delete",
        path,
        message: `${path} is a Mavly control file and cannot be deleted.`,
      });
      continue;
    }
    if (required.has(path) && !deletionRequested(input.prompt, path)) {
      violations.push({
        code: "protected_file_delete",
        path,
        message: `${path} is required for the website to run or preview and was not explicitly authorized for deletion.`,
      });
      continue;
    }
    if (
      !broad &&
      !deletionRequested(input.prompt, path) &&
      (input.changeClass === "simple" || input.changeClass === "medium")
    ) {
      violations.push({
        code: "unrelated_delete",
        path,
        message: `Deleting ${path} was not requested by the user.`,
      });
    }
  }

  if (input.mode === "update" && input.changeClass === "simple" && !broad) {
    for (const path of planned) {
      if (!editAllowedForSimple(path, input.prompt)) {
        violations.push({
          code: "protected_file_edit",
          path,
          message: `${path} is a protected API/auth/configuration file; a simple edit must not change it unless the user asks for that change.`,
        });
      }
    }
  }

  const maxFiles = limitsFor(input.changeClass, broad);
  if (planned.length + deleted.length > maxFiles) {
    violations.push({
      code: "scope_too_large",
      message: `The plan changes ${planned.length + deleted.length} paths; a ${input.changeClass} change is limited to ${maxFiles}. Ask explicitly if this is intended to be a larger change.`,
    });
  }

  if (violations.length === 0) return { ok: true };

  const summary = violations
    .slice(0, 4)
    .map((violation) => violation.message)
    .join(" ");
  return {
    ok: false,
    violations,
    summary: `${summary} Nothing was changed. If you want this broader change, ask for it explicitly (for example: "authorize a full refactor of ...").`,
  };
}
