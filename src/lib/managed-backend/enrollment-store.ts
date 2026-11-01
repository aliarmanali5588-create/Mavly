import type { SupabaseClient } from "@supabase/supabase-js";

import type { EnrollmentMode, EnrollmentState } from "./enrollment";

/**
 * ═══ ENROLLMENT STORE — THE ONLY WAY TOUCHING THE REGISTRY ══════════════════
 *
 * Every function here calls a `security definer` RPC from migration 37. There is
 * no direct table access anywhere in the application: the tables are deny-by-
 * default with no policies, so a bug here cannot become a privilege escalation.
 *
 * The failure mapping mirrors `store.ts` so a missing migration is reported as
 * `migration_required` rather than a generic error.
 */

export type EnrollmentStoreFailureCode =
  | "unavailable"
  | "migration_required"
  | "forbidden"
  | "conflict"
  | "error";

export type EnrollmentStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: EnrollmentStoreFailureCode };

function mapError(
  operation: string,
  error: { code?: string } | null,
): EnrollmentStoreFailureCode {
  const code = error?.code ?? "unknown";
  console.error(`[managed-backend] enrollment ${operation} failed (${code})`);
  if (
    code === "42P01" ||
    code === "42883" ||
    code === "PGRST202" ||
    code === "PGRST205"
  ) {
    return "migration_required";
  }
  if (code === "42501") return "forbidden";
  if (code === "23505" || code === "P0001" || code === "22023") return "conflict";
  if (code === "PGRST000" || code === "08000" || code === "08003") {
    return "unavailable";
  }
  return "error";
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstRow(value: unknown): Record<string, unknown> | null {
  return recordOf(Array.isArray(value) ? value[0] : value);
}

export interface EnrollmentRow {
  status: EnrollmentState;
  cohort: EnrollmentMode | null;
  reasonCode: string;
  policyVersion: string;
  projectCreatedAt: string;
  userId: string | null;
  enrolledAt: string | null;
  lastAuthorizedAt: string | null;
}

function enrollmentRowFrom(value: unknown): EnrollmentRow | null {
  const record = firstRow(value);
  if (!record) return null;
  if (typeof record.status !== "string") return null;
  if (typeof record.project_created_at !== "string") return null;
  return {
    status: record.status as EnrollmentState,
    cohort: typeof record.cohort === "string" ? (record.cohort as EnrollmentMode) : null,
    reasonCode: typeof record.reason_code === "string" ? record.reason_code : "eligible",
    policyVersion:
      typeof record.policy_version === "string" ? record.policy_version : "1",
    projectCreatedAt: record.project_created_at,
    userId: typeof record.user_id === "string" ? record.user_id : null,
    enrolledAt: typeof record.enrolled_at === "string" ? record.enrolled_at : null,
    lastAuthorizedAt:
      typeof record.last_authorized_at === "string" ? record.last_authorized_at : null,
  };
}

/**
 * Read the enrollment for an owner's project. Service-role only: the worker has
 * no user session, and the owner-facing path uses the authenticated RPC below.
 */
export async function readEnrollment(input: {
  client: SupabaseClient;
  projectId: string;
  userId: string;
}): Promise<EnrollmentStoreResult<EnrollmentRow | null>> {
  const { data, error } = await input.client.rpc(
    "managed_backend_enrollment_lifecycle",
    { p_project_id: input.projectId, p_user_id: input.userId },
  );
  if (error) return { ok: false, code: mapError("read", error) };
  return { ok: true, data: enrollmentRowFrom(data) };
}

/** Owner-scoped read for the status surface. Never returns a salt or a note. */
export async function readOwnEnrollment(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<EnrollmentStoreResult<EnrollmentRow | null>> {
  const { data, error } = await input.client.rpc(
    "managed_backend_enrollment_status",
    { p_project_id: input.projectId },
  );
  if (error) return { ok: false, code: mapError("own_read", error) };
  return { ok: true, data: enrollmentRowFrom(data) };
}

export interface EnrollResult {
  status: EnrollmentState;
  changed: boolean;
  enrollmentId: string | null;
}

/**
 * Persist a policy decision. Idempotent by construction: the RPC returns the
 * existing row unchanged for an approved/revoked/suspended/rejected enrollment,
 * so calling this on every run cannot churn state or resurrect an operator
 * decision.
 */
export async function enrollManagedBackend(input: {
  client: SupabaseClient;
  projectId: string;
  userId: string;
  status: "pending" | "approved";
  reasonCode: string;
  cohort: EnrollmentMode | null;
  policyVersion: string;
  rolloutBucket: number | null;
  source?: "policy" | "legacy" | "migration";
}): Promise<EnrollmentStoreResult<EnrollResult>> {
  const { data, error } = await input.client.rpc("enroll_managed_backend", {
    p_project_id: input.projectId,
    p_user_id: input.userId,
    p_status: input.status,
    p_reason_code: input.reasonCode,
    p_cohort: input.cohort,
    p_policy_version: input.policyVersion,
    p_rollout_bucket: input.rolloutBucket,
    p_source: input.source ?? "policy",
  });
  if (error) return { ok: false, code: mapError("enroll", error) };
  const record = firstRow(data);
  if (!record || typeof record.enrollment_status !== "string") {
    return { ok: false, code: "error" };
  }
  return {
    ok: true,
    data: {
      status: record.enrollment_status as EnrollmentState,
      changed: record.changed === true,
      enrollmentId:
        typeof record.enrollment_id === "string" ? record.enrollment_id : null,
    },
  };
}

export interface ProvisioningAuthorization {
  authorized: boolean;
  /** Includes `not_enrolled_strict` (migration 38) as a denial reason. */
  reasonCode: string;
  enrollmentStatus: EnrollmentState | null;
  projectCreatedAt: string | null;
}

/**
 * ⚠️ THE EXECUTION-TIME GATE. Called before every provisioning and every
 * configuration. It reads live rows, so a revocation that landed after the run
 * was queued is observed here, and it stamps `last_authorized_at`.
 */
export async function authorizeProvisioningRpc(input: {
  client: SupabaseClient;
  projectId: string;
  userId: string;
}): Promise<EnrollmentStoreResult<ProvisioningAuthorization>> {
  const { data, error } = await input.client.rpc(
    "authorize_managed_backend_provisioning",
    { p_project_id: input.projectId, p_user_id: input.userId },
  );
  if (error) return { ok: false, code: mapError("authorize", error) };
  const record = firstRow(data);
  if (!record) return { ok: false, code: "error" };
  return {
    ok: true,
    data: {
      authorized: record.authorized === true,
      reasonCode:
        typeof record.reason_code === "string" ? record.reason_code : "enrollment_missing",
      enrollmentStatus:
        typeof record.enrollment_status === "string"
          ? (record.enrollment_status as EnrollmentState)
          : null,
      projectCreatedAt:
        typeof record.project_created_at === "string"
          ? record.project_created_at
          : null,
    },
  };
}

/** How many projects are mid-provisioning. Used by the capacity gate. */
export async function countActiveProvisions(
  client: SupabaseClient,
): Promise<EnrollmentStoreResult<number>> {
  const { data, error } = await client.rpc("count_active_managed_backend_provisions");
  if (error) return { ok: false, code: mapError("count", error) };
  return { ok: true, data: typeof data === "number" ? data : 0 };
}

export interface EnrollmentHistoryEntry {
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  cohort: string | null;
  reasonCode: string | null;
  detail: string | null;
  createdAt: string;
}

/** Admin-only audit history for one project. */
export async function readEnrollmentHistory(input: {
  client: SupabaseClient;
  projectId: string;
  limit?: number;
}): Promise<EnrollmentStoreResult<EnrollmentHistoryEntry[]>> {
  const { data, error } = await input.client.rpc(
    "managed_backend_enrollment_history",
    { p_project_id: input.projectId, p_limit: input.limit ?? 50 },
  );
  if (error) return { ok: false, code: mapError("history", error) };
  const rows = Array.isArray(data) ? data : [];
  return {
    ok: true,
    data: rows.flatMap((row) => {
      const record = recordOf(row);
      if (!record || typeof record.event !== "string") return [];
      return [
        {
          event: record.event,
          fromStatus:
            typeof record.from_status === "string" ? record.from_status : null,
          toStatus: typeof record.to_status === "string" ? record.to_status : null,
          cohort: typeof record.cohort === "string" ? record.cohort : null,
          reasonCode:
            typeof record.reason_code === "string" ? record.reason_code : null,
          detail: typeof record.detail === "string" ? record.detail : null,
          createdAt:
            typeof record.created_at === "string" ? record.created_at : "",
        },
      ];
    }),
  };
}

/**
 * Administrative action. Authority is `current_user_is_admin()` inside the RPC —
 * the caller's own `auth.uid()`, never a parameter — so this wrapper cannot be
 * used to escalate.
 */
export async function setEnrollmentStatus(input: {
  client: SupabaseClient;
  projectId: string;
  action: "approve" | "reject" | "suspend" | "revoke" | "resume";
  reason?: string | null;
}): Promise<EnrollmentStoreResult<EnrollResult>> {
  const { data, error } = await input.client.rpc("set_managed_backend_enrollment", {
    p_project_id: input.projectId,
    p_action: input.action,
    p_reason: input.reason ?? null,
  });
  if (error) return { ok: false, code: mapError("admin_set", error) };
  const record = firstRow(data);
  if (!record || typeof record.enrollment_status !== "string") {
    return { ok: false, code: "error" };
  }
  return {
    ok: true,
    data: {
      status: record.enrollment_status as EnrollmentState,
      changed: record.changed === true,
      enrollmentId:
        typeof record.enrollment_id === "string" ? record.enrollment_id : null,
    },
  };
}

/**
 * ═══ MIGRATION 38: BACKFILL, COVERAGE AND STRICT MODE ═══════════════════════
 *
 * These three calls are the operational half of strict authorization. They are
 * separate from the per-project enrollment path because they are one-off
 * migration operations, not per-run decisions.
 *
 * ⚠️ `backfillEnrollments` DEFAULTS TO A DRY RUN. The first call an operator
 * makes cannot change anything, so a mistyped command reports counts instead of
 * writing rows.
 */

export interface BackfillSummary {
  dryRun: boolean;
  scanned: number;
  eligible: number;
  alreadyEnrolled: number;
  skipped: number;
  rejected: number;
  inserted: number;
  promoted: number;
  rejectedReasons: Record<string, number>;
  rejectedSamples: Array<{
    projectId: string;
    projectCreatedAt: string | null;
    backendStatus: string | null;
    reason: string;
  }>;
  completedAt: string | null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function backfillSummaryFrom(value: unknown): BackfillSummary | null {
  const record = recordOf(value);
  if (!record) return null;

  const reasons: Record<string, number> = {};
  const rawReasons = recordOf(record.rejectedReasons);
  if (rawReasons) {
    for (const [key, count] of Object.entries(rawReasons)) {
      if (typeof count === "number" && Number.isFinite(count)) reasons[key] = count;
    }
  }

  const samples = Array.isArray(record.rejectedSamples) ? record.rejectedSamples : [];
  return {
    dryRun: record.dryRun !== false,
    scanned: numberField(record, "scanned"),
    eligible: numberField(record, "eligible"),
    alreadyEnrolled: numberField(record, "alreadyEnrolled"),
    skipped: numberField(record, "skipped"),
    rejected: numberField(record, "rejected"),
    inserted: numberField(record, "inserted"),
    promoted: numberField(record, "promoted"),
    rejectedReasons: reasons,
    rejectedSamples: samples.flatMap((entry) => {
      const sample = recordOf(entry);
      if (!sample || typeof sample.projectId !== "string") return [];
      return [
        {
          projectId: sample.projectId,
          projectCreatedAt:
            typeof sample.projectCreatedAt === "string" ? sample.projectCreatedAt : null,
          backendStatus:
            typeof sample.backendStatus === "string" ? sample.backendStatus : null,
          reason: typeof sample.reason === "string" ? sample.reason : "unknown",
        },
      ];
    }),
    completedAt: typeof record.completedAt === "string" ? record.completedAt : null,
  };
}

/**
 * Backfill existing managed backends into the enrollment registry.
 *
 * `dryRun` defaults to true at BOTH layers: this wrapper and the SQL default. A
 * caller has to ask twice to write anything.
 */
export async function backfillEnrollments(input: {
  client: SupabaseClient;
  dryRun?: boolean;
}): Promise<EnrollmentStoreResult<BackfillSummary>> {
  const { data, error } = await input.client.rpc("backfill_managed_backend_enrollments", {
    p_dry_run: input.dryRun !== false,
  });
  if (error) return { ok: false, code: mapError("backfill", error) };
  const summary = backfillSummaryFrom(data);
  if (!summary) return { ok: false, code: "error" };
  return { ok: true, data: summary };
}

export interface EnrollmentCoverage {
  totalBackends: number;
  liveBackends: number;
  coveredBackends: number;
  uncoveredBackends: number;
  orphanedBackends: number;
  approvedEnrollments: number;
  strictAuthorization: boolean;
  readyForStrict: boolean;
  uncoveredSamples: Array<{
    projectId: string;
    projectCreatedAt: string | null;
    backendStatus: string | null;
  }>;
}

export function coverageFrom(value: unknown): EnrollmentCoverage | null {
  const record = recordOf(value);
  if (!record) return null;
  const samples = Array.isArray(record.uncoveredSamples) ? record.uncoveredSamples : [];
  return {
    totalBackends: numberField(record, "totalBackends"),
    liveBackends: numberField(record, "liveBackends"),
    coveredBackends: numberField(record, "coveredBackends"),
    uncoveredBackends: numberField(record, "uncoveredBackends"),
    orphanedBackends: numberField(record, "orphanedBackends"),
    approvedEnrollments: numberField(record, "approvedEnrollments"),
    /**
     * ⚠️ ABSENT MEANS STRICT. If the field is missing the deployment is treated
     * as strict, which is the safe direction: it reports "not ready" rather than
     * claiming a compatibility path it cannot prove.
     */
    strictAuthorization: record.strictAuthorization !== false,
    readyForStrict: record.readyForStrict === true,
    uncoveredSamples: samples.flatMap((entry) => {
      const sample = recordOf(entry);
      if (!sample || typeof sample.projectId !== "string") return [];
      return [
        {
          projectId: sample.projectId,
          projectCreatedAt:
            typeof sample.projectCreatedAt === "string" ? sample.projectCreatedAt : null,
          backendStatus:
            typeof sample.backendStatus === "string" ? sample.backendStatus : null,
        },
      ];
    }),
  };
}

/** Coverage report. Admin-only inside the RPC. */
export async function readEnrollmentCoverage(
  client: SupabaseClient,
): Promise<EnrollmentStoreResult<EnrollmentCoverage>> {
  const { data, error } = await client.rpc("managed_backend_enrollment_coverage");
  if (error) return { ok: false, code: mapError("coverage", error) };
  const coverage = coverageFrom(data);
  if (!coverage) return { ok: false, code: "error" };
  return { ok: true, data: coverage };
}

/**
 * Enable or disable strict authorization. The RPC refuses to enable while any
 * live backend lacks an enrollment row, so a caller cannot strand a database by
 * flipping this early.
 */
export async function setStrictAuthorization(input: {
  client: SupabaseClient;
  enabled: boolean;
  reason?: string | null;
}): Promise<
  EnrollmentStoreResult<{ strictAuthorization: boolean; uncoveredBackends: number }>
> {
  const { data, error } = await input.client.rpc(
    "set_managed_backend_strict_authorization",
    { p_enabled: input.enabled, p_reason: input.reason ?? null },
  );
  if (error) return { ok: false, code: mapError("strict", error) };
  const record = recordOf(data);
  if (!record) return { ok: false, code: "error" };
  return {
    ok: true,
    data: {
      strictAuthorization: record.strictAuthorization === true,
      uncoveredBackends: numberField(record, "uncoveredBackends"),
    },
  };
}
