/**
 * ═══ WHAT IS THIS `/api/vcaas/...` REQUEST ALLOWED TO TOUCH? ════════════════
 *
 * The catch-all proxy forwards an arbitrary upstream-relative path with one
 * account-wide Totalum key. That makes "which endpoints are project-scoped?"
 * a security question, not a routing detail: a path we fail to classify must be
 * REFUSED, never forwarded on the assumption that it is harmless.
 *
 * This module is pure (no Next, no Supabase, no env) so the classification is
 * unit-tested directly. It is the single source of truth for:
 *
 *   · which roots are ACCOUNT-level and explicitly allowlisted;
 *   · how a project id is read from `/projects/{id}/...` (and the few dedicated
 *     project roots: `upload`, `source-code`, `env`);
 *   · whether a body/query `projectId` conflicts with the path, or names a
 *     project that still needs an ownership check (domain attach/purchase).
 *
 * ⚠️ KEEP THE ALLOWLIST IN STEP WITH `src/lib/vcaas.ts`. A newly catalogued
 * account endpoint that is not listed here answers 404 until it is added —
 * that is deliberate (fail closed), and the test file exercises the boundary.
 */

import { isRoutableProjectSlug } from "@/lib/project-slug";

export interface ScopeDenial {
  status: number;
  code: string;
  message: string;
}

export type VcaasScope =
  /** `/projects/{id}/...`, `upload/{id}`, `source-code/{id}`, `env/{id}`. */
  | { kind: "project"; projectId: string }
  /** Creation paths, whose response must be registered in `public.projects`. */
  | { kind: "create"; mode: "create" | "launch" }
  /** Explicitly allowlisted account-level read/operation. */
  | {
      kind: "account";
      resource:
        | "project-list"
        | "credit-limits-at-limit"
        | "credit-costs"
        | "usage"
        | "webhooks"
        | "project-groups"
        | "domains"
        | "figma-validate";
    }
  | ({ kind: "deny" } & ScopeDenial);

function deny(status: number, code: string, message: string): VcaasScope {
  return { kind: "deny", status, code, message };
}

const READ_METHODS = new Set(["GET"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The catch-all's authorization classification.
 *
 * `segments` are the decoded segments of `/api/vcaas/<segments...>`, exactly as
 * the route builds them. Never infer a project id by searching the whole URL;
 * the position is part of each endpoint's contract.
 */
export function classifyVcaasRequest(method: string, segments: readonly string[]): VcaasScope {
  const verb = method.toUpperCase();
  const [root, second, third] = segments;

  if (!root) return deny(404, "NOT_FOUND", "Not found");

  switch (root) {
    case "projects": {
      if (segments.length === 1) {
        if (verb === "GET") return { kind: "account", resource: "project-list" };
        if (verb === "POST") return { kind: "create", mode: "create" };
        return deny(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }

      /**
       * ⚠️ LITERAL SEGMENTS UNDER `/projects`. These are method-specific on
       * purpose: `POST /projects/launch` is the launch action, while
       * `GET /projects/launch` is an ordinary project read whose id happens to
       * be "launch" and MUST go through the ownership check.
       */
      if (segments.length === 2 && second === "launch") {
        return verb === "POST"
          ? { kind: "create", mode: "launch" }
          : { kind: "project", projectId: second };
      }

      if (segments.length === 3 && second === "credit-limits" && third === "at-limit") {
        return verb === "GET"
          ? { kind: "account", resource: "credit-limits-at-limit" }
          : deny(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }

      if (!isRoutableProjectSlug(second)) return deny(400, "VALIDATION", "Invalid project");
      return { kind: "project", projectId: second };
    }

    /**
     * These have dedicated internal routes (`/api/vcaas/upload/...` etc.), but
     * the catch-all still reaches them at the upstream level. Classify them the
     * same way rather than leaving a second, unguarded door.
     */
    case "upload":
    case "source-code":
    case "env": {
      if (segments.length !== 2 || !isRoutableProjectSlug(second)) {
        return deny(404, "NOT_FOUND", "Not found");
      }
      return { kind: "project", projectId: second };
    }

    /** `git-diff` is served only by its dedicated, URL-validated route. */
    case "git-diff":
      return deny(404, "NOT_FOUND", "Not found");

    case "credit-costs":
      return segments.length === 1 && verb === "GET"
        ? { kind: "account", resource: "credit-costs" }
        : deny(404, "NOT_FOUND", "Not found");

    case "usage":
      return segments.length === 1 && verb === "GET"
        ? { kind: "account", resource: "usage" }
        : deny(404, "NOT_FOUND", "Not found");

    case "webhooks":
      return (segments.length === 1 || segments.length === 2) && MUTATING_METHODS.has(verb)
        ? { kind: "account", resource: "webhooks" }
        : segments.length <= 2 && READ_METHODS.has(verb)
          ? { kind: "account", resource: "webhooks" }
          : deny(404, "NOT_FOUND", "Not found");

    case "project-groups":
      return segments.length <= 2 && (READ_METHODS.has(verb) || MUTATING_METHODS.has(verb))
        ? { kind: "account", resource: "project-groups" }
        : deny(404, "NOT_FOUND", "Not found");

    case "domains":
      return READ_METHODS.has(verb) || MUTATING_METHODS.has(verb)
        ? { kind: "account", resource: "domains" }
        : deny(404, "NOT_FOUND", "Not found");

    case "figma":
      return segments.length === 2 && second === "validate" && verb === "POST"
        ? { kind: "account", resource: "figma-validate" }
        : deny(404, "NOT_FOUND", "Not found");

    default:
      /**
       * ⚠️ AN UNKNOWN ROOT IS NOT "PROBABLY FINE". A future project-scoped
       * endpoint added to the catalog but not here is refused until somebody
       * classifies it, instead of silently re-opening the F-1 hole.
       */
      return deny(404, "NOT_FOUND", "Not found");
  }
}

// ─────────────────────────── body / query identity ──────────────────────────

function bodyRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * The `projectId` a request carries outside its path, if any.
 *
 * `present` distinguishes "absent" from "malformed"; an empty string is
 * malformed on purpose (it cannot be a legitimate project id).
 */
function carriedProjectId(value: Record<string, unknown> | null): {
  present: boolean;
  value?: string;
} {
  if (!value || !("projectId" in value)) return { present: false };
  const raw = value.projectId;
  return { present: true, value: typeof raw === "string" && raw.trim() ? raw : undefined };
}

export type IdentityCheck =
  | { kind: "allow" }
  /** Account-level path whose body names a project (domain purchase/attach). */
  | { kind: "authorize"; projectId: string }
  | ({ kind: "deny" } & ScopeDenial);

export function checkRequestIdentity(
  scope: VcaasScope,
  segments: readonly string[],
  query: URLSearchParams,
  body: unknown,
): IdentityCheck {
  const record = bodyRecord(body);
  const fromBody = carriedProjectId(record);

  /**
   * ⚠️ DUPLICATE QUERY VALUES ARE REFUSED. `URLSearchParams.get()` returns the
   * first and the forwarded URL keeps both; if upstream reads the last, the
   * check would have guarded a different project than the one acted on.
   */
  const allQueryIds = query.getAll("projectId");
  if (allQueryIds.length > 1) {
    return { kind: "deny", status: 400, code: "CONFLICTING_PROJECT", message: "Conflicting project identifiers" };
  }
  const fromQuery = allQueryIds[0] ?? null;

  // A present-but-unusable projectId is never "absent"; refuse it.
  if (fromBody.present && !fromBody.value) {
    return { kind: "deny", status: 400, code: "VALIDATION", message: "Invalid project" };
  }
  if (fromQuery !== null && !isRoutableProjectSlug(fromQuery)) {
    return { kind: "deny", status: 400, code: "VALIDATION", message: "Invalid project" };
  }

  if (scope.kind === "project") {
    /**
     * ⚠️ CONFLICTING IDS ARE REFUSED, NOT RESOLVED. The path is canonical for
     * every project route; a body/query id that disagrees is either a client
     * bug or an attempt to make one check guard a different resource.
     */
    if (fromBody.value && fromBody.value !== scope.projectId) {
      return { kind: "deny", status: 400, code: "CONFLICTING_PROJECT", message: "Conflicting project identifiers" };
    }
    if (fromQuery && fromQuery !== scope.projectId) {
      return { kind: "deny", status: 400, code: "CONFLICTING_PROJECT", message: "Conflicting project identifiers" };
    }
    return { kind: "allow" };
  }

  if (scope.kind === "create") {
    // The requested slug is not the canonical one — registration uses the
    // response. Only reject a structurally impossible value here.
    if (fromBody.value && !isRoutableProjectSlug(fromBody.value)) {
      return { kind: "deny", status: 400, code: "VALIDATION", message: "Invalid project" };
    }
    if (fromQuery) {
      return { kind: "deny", status: 400, code: "CONFLICTING_PROJECT", message: "Conflicting project identifiers" };
    }
    return { kind: "allow" };
  }

  if (scope.kind === "deny") return { kind: "deny", ...scope };

  // ── account-level ──────────────────────────────────────────────────────
  if (scope.resource === "domains" && fromBody.value) {
    const attaching =
      (segments.length === 2 && segments[1] === "purchase") ||
      (segments.length === 3 && segments[2] === "attach");
    if (attaching) {
      if (!isRoutableProjectSlug(fromBody.value)) {
        return { kind: "deny", status: 400, code: "VALIDATION", message: "Invalid project" };
      }
      return { kind: "authorize", projectId: fromBody.value };
    }
  }

  /**
   * Every other account endpoint has no vetted contract for a project id in the
   * body or query. Refuse rather than guess which project it means.
   */
  if (fromBody.value || fromQuery) {
    return { kind: "deny", status: 400, code: "AMBIGUOUS_PROJECT", message: "Ambiguous project scope" };
  }
  return { kind: "allow" };
}

// ───────────────────────────── list filtering ───────────────────────────────

/**
 * Narrow an account-wide project listing to the caller's ownership rows.
 *
 * ⚠️ THE LIST IS ACCOUNT-WIDE. The Totalum key is one account's key, so without
 * this every signed-in user sees every project id in the deployment. Filtering
 * (rather than trusting the upstream list) is what makes the dashboard's
 * listing agree with `enforceProjectScope`.
 */
export function filterProjectList(data: unknown, owned: ReadonlySet<string>): unknown {
  if (!Array.isArray(data)) return data;
  return data.filter((row) => {
    if (!row || typeof row !== "object") return false;
    const id = (row as { projectId?: unknown }).projectId;
    return typeof id === "string" && owned.has(id);
  });
}

/** `GET /projects/credit-limits/at-limit` — same account-wide project leak. */
export function filterAtLimitAnswer(data: unknown, owned: ReadonlySet<string>): unknown {
  if (!data || typeof data !== "object") return data;
  const answer = data as { projects?: unknown };
  if (!Array.isArray(answer.projects)) return data;
  return {
    ...answer,
    projects: answer.projects.filter((row) => {
      if (!row || typeof row !== "object") return false;
      const id = (row as { projectId?: unknown }).projectId;
      return typeof id === "string" && owned.has(id);
    }),
  };
}

/** `GET /usage` (account) — keep the per-project breakdown to owned projects. */
export function filterAccountUsage(data: unknown, owned: ReadonlySet<string>): unknown {
  if (!data || typeof data !== "object") return data;
  const answer = data as { byProject?: unknown };
  if (!Array.isArray(answer.byProject)) return data;
  return {
    ...answer,
    byProject: answer.byProject.filter((row) => {
      if (!row || typeof row !== "object") return false;
      const id = (row as { projectId?: unknown }).projectId;
      return typeof id === "string" && owned.has(id);
    }),
  };
}
