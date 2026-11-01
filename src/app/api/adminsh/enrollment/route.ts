import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import {
  backfillEnrollments,
  readEnrollment,
  readEnrollmentCoverage,
  readEnrollmentHistory,
  setEnrollmentStatus,
  setStrictAuthorization,
} from "@/lib/managed-backend/enrollment-store";
import { isRoutableProjectSlug } from "@/lib/project-slug";

/**
 * ═══ ADMIN: MANAGED BACKEND ENROLLMENT ══════════════════════════════════════
 *
 * Authority is `requireAdmin()`, which evaluates `current_user_is_admin()` for
 * the CALLER's own session. There is no `isAdmin` parameter and no client flag:
 * a forged body cannot reach the mutation path.
 *
 * `GET  ?projectId=…`  → enrollment status + audit history
 * `POST { projectId, action, reason }` → approve | reject | suspend | revoke | resume
 *
 * ⚠️ THIS IS NOT A PUBLIC ENROLLMENT ENDPOINT. There is no unauthenticated path,
 * no "enroll me" action, and no way to widen a cohort from here. Revocation
 * stops future provisioning and never deletes a Neon project or customer data.
 */

export const dynamic = "force-dynamic";

const ACTIONS = ["approve", "reject", "suspend", "revoke", "resume"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * Migration 38 operations. These are migration/rollout controls, not per-project
 * enrollment actions, so they live behind their own action names and their own
 * guards. `backfill` defaults to a DRY RUN at both layers.
 */
const OPS = ["backfill", "coverage", "strict-on", "strict-off"] as const;
type Op = (typeof OPS)[number];

function parseAction(value: unknown): Action | null {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value)
    ? (value as Action)
    : null;
}

function parseOp(value: unknown): Op | null {
  return typeof value === "string" && (OPS as readonly string[]).includes(value)
    ? (value as Op)
    : null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  /**
   * `?op=coverage` is the migration-readiness read: it needs no project id and
   * it is the number an operator checks before enabling strict mode.
   */
  const op = parseOp(request.nextUrl.searchParams.get("op"));
  if (op === "coverage") {
    const coverage = await readEnrollmentCoverage(auth.supabase);
    if (coverage.ok === false) {
      return adminError(
        503,
        "ENROLLMENT_UNAVAILABLE",
        "The enrollment registry is not available. Apply supabase/migrations/37_managed_backend_enrollment.sql and 38_managed_backend_enrollment_hardening.sql.",
      );
    }
    return adminJson({ ok: true, data: coverage.data });
  }

  const projectId = (request.nextUrl.searchParams.get("projectId") ?? "")
    .trim()
    .toLowerCase();
  if (!projectId || !isRoutableProjectSlug(projectId)) {
    return adminError(400, "INVALID_PROJECT", "A valid projectId is required.");
  }

  /**
   * The admin route reads through the service-role-shaped path only when the
   * caller is an admin; `requireAdmin()` already proved that. The owner id is
   * resolved from `public.projects` by the RPCs themselves, so this route never
   * supplies one.
   */
  const enrollment = await readEnrollmentForAdmin(auth.supabase, projectId);
  if (enrollment.ok === false) {
    return adminError(
      503,
      "ENROLLMENT_UNAVAILABLE",
      "The enrollment registry is not available. Apply supabase/migrations/37_managed_backend_enrollment.sql.",
    );
  }

  const history = await readEnrollmentHistory({
    client: auth.supabase,
    projectId,
    limit: 50,
  });

  return adminJson({
    ok: true,
    data: {
      projectId,
      enrollment: enrollment.data,
      history: history.ok ? history.data : [],
    },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return adminError(400, "INVALID_BODY", "A JSON body is required.");
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  /**
   * ═══ MIGRATION 38 OPERATIONS ═══════════════════════════════════════════════
   *
   * These are checked BEFORE the project-id branch because they are not
   * project-scoped. Each one is admin-only (`requireAdmin()` above) and each one
   * is refused by its own RPC if the caller is not an administrator, so this
   * route is a thin, non-authoritative wrapper.
   *
   * ⚠️ `backfill` is a DRY RUN unless the body says `dryRun: false`. A mistyped
   * request reports counts and writes nothing.
   */
  const op = parseOp(record.op);
  if (op) {
    try {
      if (op === "backfill") {
        const result = await withTimeout(
          backfillEnrollments({
            client: auth.supabase,
            dryRun: record.dryRun !== false,
          }),
          20_000,
        );
        if (result.ok === false) {
          return adminError(
            503,
            "ENROLLMENT_UNAVAILABLE",
            "The enrollment registry is not available. Apply supabase/migrations/38_managed_backend_enrollment_hardening.sql.",
          );
        }
        return adminJson({ ok: true, data: result.data });
      }
      if (op === "coverage") {
        const result = await withTimeout(readEnrollmentCoverage(auth.supabase), 10_000);
        if (result.ok === false) {
          return adminError(503, "ENROLLMENT_UNAVAILABLE", "Coverage could not be read.");
        }
        return adminJson({ ok: true, data: result.data });
      }

      const enabled = op === "strict-on";
      const reason =
        typeof record.reason === "string" ? record.reason.trim().slice(0, 500) : null;
      const result = await withTimeout(
        setStrictAuthorization({ client: auth.supabase, enabled, reason }),
        10_000,
      );
      if (result.ok === false) {
        /**
         * The RPC refuses to enable while any live backend is uncovered. That is
         * a real, actionable refusal, not a server error, so it is reported as a
         * conflict with the coverage numbers attached.
         */
        if (enabled) {
          const coverage = await readEnrollmentCoverage(auth.supabase);
          return adminError(
            409,
            "STRICT_REFUSED",
            coverage.ok
              ? `Strict authorization refused: ${coverage.data.uncoveredBackends} live managed backend(s) have no enrollment row. Run the backfill first.`
              : "Strict authorization refused: coverage could not be verified.",
          );
        }
        return adminError(503, "ENROLLMENT_UNAVAILABLE", "Strict authorization could not be changed.");
      }
      return adminJson({ ok: true, data: result.data });
    } catch {
      return adminError(504, "ENROLLMENT_TIMEOUT", "The enrollment operation timed out.");
    }
  }

  const projectId = typeof record.projectId === "string"
    ? record.projectId.trim().toLowerCase()
    : "";
  if (!projectId || !isRoutableProjectSlug(projectId)) {
    return adminError(400, "INVALID_PROJECT", "A valid projectId is required.");
  }
  const action = parseAction(record.action);
  if (!action) {
    return adminError(400, "INVALID_ACTION", `action must be one of: ${ACTIONS.join(", ")}`);
  }
  const reason =
    typeof record.reason === "string" ? record.reason.trim().slice(0, 500) : null;

  try {
    const result = await withTimeout(
      setEnrollmentStatus({
        client: auth.supabase,
        projectId,
        action,
        reason,
      }),
      8_000,
    );
    if (result.ok === false) {
      /**
       * A forbidden code here means the RPC's own `current_user_is_admin()`
       * disagreed with this route's check. Report it as a refusal, never as a
       * success, and never retry with elevated privileges.
       */
      if (result.code === "forbidden") {
        return adminError(403, "FORBIDDEN", "This account cannot change enrollment.");
      }
      if (result.code === "conflict") {
        return adminError(
          409,
          "ENROLLMENT_CONFLICT",
          "That enrollment transition is not permitted in its current state.",
        );
      }
      return adminError(
        503,
        "ENROLLMENT_UNAVAILABLE",
        "The enrollment registry is not available. Apply supabase/migrations/37_managed_backend_enrollment.sql.",
      );
    }
    return adminJson({ ok: true, data: { projectId, action, ...result.data } });
  } catch {
    return adminError(504, "ENROLLMENT_TIMEOUT", "The enrollment action timed out.");
  }
}

/**
 * Admin reads need the enrollment row even when the caller is not the owner, so
 * this resolves the owner from `public.projects` first and then reads the
 * service-role projection. Both RPCs re-check their own preconditions.
 */
async function readEnrollmentForAdmin(
  supabase: Parameters<typeof readEnrollment>[0]["client"],
  projectId: string,
): Promise<{ ok: true; data: unknown } | { ok: false }> {
  const { data, error } = await supabase
    .from("projects")
    .select("user_id")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) return { ok: false };
  const userId = (data as { user_id?: string } | null)?.user_id;
  if (!userId) return { ok: false };

  const result = await readEnrollment({ client: supabase, projectId, userId });
  if (result.ok === false) return { ok: false };
  return { ok: true, data: result.data };
}
