import type { SupabaseClient } from "@supabase/supabase-js";

import { emitGenerationEvent } from "@/lib/observability/events";

import type { ManagedBackendConfig } from "./config";
import {
  authorizeProvisioning,
  evaluateEnrollment,
  ENROLLMENT_POLICY_VERSION,
  ENROLLMENT_REASONS,
  enrollmentReasonLabel,
  type AuthorizationResult,
  type EnrollmentDecision,
  type EnrollmentReasonCode,
  type EnrollmentState,
} from "./enrollment";
import {
  authorizeProvisioningRpc,
  countActiveProvisions,
  enrollManagedBackend,
  readEnrollment,
  type EnrollmentStoreFailureCode,
  type EnrollmentStoreResult,
} from "./enrollment-store";

/**
 * ═══ ENROLLMENT SERVICE — POLICY DECISION → PERSISTED AUTHORIZATION ═════════
 *
 * This module is the ONLY place that decides whether a project may be enrolled,
 * and the only place that writes that decision. Two entry points:
 *
 *   ensureEnrollment()      — enrollment-time. Runs the full rollout policy once
 *                             and persists the result. Called from the managed
 *                             backend stage of a generation run.
 *
 *   recheckAuthorization()  — execution-time. The narrow recheck the worker runs
 *                             before provisioning and before configuration.
 *
 * ⚠️ NEITHER ACCEPTS A MODEL OUTPUT. `backendRequired` and `hasDataModel` come
 * from `detectBackendRequirement()` and `parseAppDataModel()`, both of which are
 * trusted server code. The planner's own `requiresDatabase` is an input to that
 * policy, never an authorization.
 */

export interface EnrollmentOutcome {
  /** True when provisioning may proceed for this project right now. */
  authorized: boolean;
  state: EnrollmentState;
  decision: EnrollmentDecision;
  /** Owner-safe sentence. Never contains a salt, a note or an internal id. */
  label: string;
  /** Set when the registry itself could not be read or written. */
  storageFailure: EnrollmentStoreFailureCode | null;
}

function storageFailureOutcome(
  code: EnrollmentStoreFailureCode,
): EnrollmentOutcome {
  const reasonCode: EnrollmentReasonCode =
    code === "migration_required" ? "platform_not_ready" : "platform_not_ready";
  return {
    authorized: false,
    state: "not_enrolled",
    decision: {
      eligible: false,
      reasonCode,
      policyVersion: ENROLLMENT_POLICY_VERSION,
      cohort: null,
      bucket: null,
      decisionTimestamp: new Date().toISOString(),
    },
    label:
      code === "migration_required"
        ? "Managed database enrollment storage is not installed on this deployment. Apply supabase/migrations/37_managed_backend_enrollment.sql."
        : enrollmentReasonLabel(reasonCode),
    storageFailure: code,
  };
}

/**
 * ═══ LEGACY COMPATIBILITY ═══════════════════════════════════════════════════
 *
 * When no enrollment mode is configured, the deployment is still on the static
 * project allowlist. Rather than bypassing this module, the legacy list is
 * expressed as a decision and (when the registry exists) recorded with
 * `source = 'legacy'`, so the migration to the registry is observable and the
 * worker's execution-time gate has a row to check.
 *
 * ⚠️ The legacy path still requires the list to contain the project. An empty
 * list authorizes nobody — `parseManagedBackendConfig` already refuses to make
 * the deployment `ready` in that case.
 */
export async function ensureEnrollment(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  config: ManagedBackendConfig;
  backendRequired: boolean;
  hasDataModel: boolean;
  /** The project incarnation, when the caller already resolved it. */
  projectCreatedAt?: string | null;
}): Promise<EnrollmentOutcome> {
  const { config } = input;
  const now = new Date().toISOString();
  const enrollmentConfig = config.enrollment;

  const existing = await readEnrollment({
    client: input.client,
    projectId: input.projectId,
    userId: input.userId,
  });
  /**
   * A missing migration is NOT fatal to a legacy deployment: the static list
   * still authorizes, exactly as before. It IS fatal to a registry deployment,
   * because there is no other authorization source.
   */
  if (existing.ok === false) {
    if (enrollmentConfig.registryAuthoritative) {
      return storageFailureOutcome(existing.code);
    }
    const legacy = legacyDecision(input, now);
    return {
      authorized: legacy.eligible,
      state: legacy.eligible ? "approved" : "not_enrolled",
      decision: legacy,
      label: enrollmentReasonLabel(legacy.reasonCode),
      storageFailure: existing.code,
    };
  }

  const current = existing.data;

  /**
   * ⚠️ LEGACY MODE. No enrollment mode configured means the static list is the
   * authorization. The registry row is still written when possible so that a
   * later switch to a registry mode has history, but the DECISION comes from the
   * list, not from the policy engine.
   */
  if (!enrollmentConfig.registryAuthoritative) {
    const legacy = legacyDecision(input, now);
    if (legacy.eligible) {
      const written = await enrollManagedBackend({
        client: input.client,
        projectId: input.projectId,
        userId: input.userId,
        status: "approved",
        reasonCode: legacy.reasonCode,
        cohort: "allowlisted",
        policyVersion: ENROLLMENT_POLICY_VERSION,
        rolloutBucket: null,
        source: "legacy",
      });
      // A write failure here does not revoke a legacy authorization; it only
      // means the registry has no row for the worker's later recheck.
      if (written.ok === false) {
        return {
          authorized: true,
          state: "approved",
          decision: legacy,
          label: enrollmentReasonLabel(legacy.reasonCode),
          storageFailure: written.code,
        };
      }
      return {
        authorized: true,
        state: written.data.status,
        decision: legacy,
        label: enrollmentReasonLabel(legacy.reasonCode),
        storageFailure: null,
      };
    }
    return {
      authorized: false,
      state: current?.status ?? "not_enrolled",
      decision: legacy,
      label: enrollmentReasonLabel(legacy.reasonCode),
      storageFailure: null,
    };
  }

  /**
   * ═══ REGISTRY MODE ════════════════════════════════════════════════════════
   *
   * Capacity is only consulted when the project is not already grandfathered,
   * so an approved project never becomes "capacity reached".
   */
  let activeProvisions = 0;
  if (current?.status !== "approved") {
    const counted = await countActiveProvisions(input.client);
    if (counted.ok === false) return storageFailureOutcome(counted.code);
    activeProvisions = counted.data;
  }

  const decision = evaluateEnrollment({
    mode: enrollmentConfig.mode ?? "disabled",
    rolloutPercent: enrollmentConfig.rolloutPercent,
    rolloutSalt: enrollmentConfig.rolloutSalt,
    internalProjects: enrollmentConfig.internalProjects,
    allowlist: config.cohort,
    projectId: input.projectId,
    projectCreatedAt: input.projectCreatedAt ?? current?.projectCreatedAt ?? now,
    backendRequired: input.backendRequired,
    hasDataModel: input.hasDataModel,
    platformReady: config.ready,
    activeProvisions,
    maxActiveProvisions: enrollmentConfig.maxActiveProvisions,
    currentState: current?.status ?? null,
    now,
  });

  /**
   * ⚠️ AN OPERATOR DECISION IS NEVER OVERWRITTEN BY THE POLICY. `enroll_managed_backend`
   * enforces this in SQL too; skipping the write here keeps the audit trail
   * clean of no-op events.
   */
  if (
    current &&
    (current.status === "revoked" ||
      current.status === "suspended" ||
      current.status === "rejected")
  ) {
    return {
      authorized: false,
      state: current.status,
      decision,
      label: enrollmentReasonLabel(decision.reasonCode),
      storageFailure: null,
    };
  }

  if (!decision.eligible) {
    /**
     * A project that is merely outside the rollout is recorded as `pending`, not
     * `rejected`: it is not disqualified, it just has not been admitted yet, and
     * the next evaluation (after a rollout change) may approve it.
     */
    const shouldRecordPending =
      decision.reasonCode === "outside_rollout_percentage" ||
      decision.reasonCode === "capacity_reached";
    if (shouldRecordPending) {
      await enrollManagedBackend({
        client: input.client,
        projectId: input.projectId,
        userId: input.userId,
        status: "pending",
        reasonCode: decision.reasonCode,
        cohort: decision.cohort,
        policyVersion: decision.policyVersion,
        rolloutBucket: decision.bucket,
      });
    }
    return {
      authorized: false,
      state: current?.status ?? "not_enrolled",
      decision,
      label: enrollmentReasonLabel(decision.reasonCode),
      storageFailure: null,
    };
  }

  const written = await enrollManagedBackend({
    client: input.client,
    projectId: input.projectId,
    userId: input.userId,
    status: "approved",
    reasonCode: decision.reasonCode,
    cohort: decision.cohort,
    policyVersion: decision.policyVersion,
    rolloutBucket: decision.bucket,
  });
  if (written.ok === false) return storageFailureOutcome(written.code);

  /**
   * ⚠️ THE EVENT IS EMITTED ONLY WHEN THE STATE ACTUALLY CHANGED. A generation
   * that re-evaluates an already-approved project must not produce a stream of
   * duplicate "approved" lines that look like repeated provisioning.
   */
  if (written.data.changed) {
    emitGenerationEvent("managed_backend.enrollment.approved", {
      projectId: input.projectId,
      status: written.data.status,
      cohort: decision.cohort,
      policyVersion: decision.policyVersion,
      reason: decision.reasonCode,
      rolloutBucket: decision.bucket,
    });
    emitGenerationEvent("managed_backend.cohort.assigned", {
      projectId: input.projectId,
      cohort: decision.cohort,
      policyVersion: decision.policyVersion,
      rolloutBucket: decision.bucket,
    });
  }

  return {
    authorized: written.data.status === "approved",
    state: written.data.status,
    decision,
    label: enrollmentReasonLabel(decision.reasonCode),
    storageFailure: null,
  };
}

function legacyDecision(
  input: { projectId: string; backendRequired: boolean; hasDataModel: boolean; config: ManagedBackendConfig },
  now: string,
): EnrollmentDecision {
  const base = {
    policyVersion: ENROLLMENT_POLICY_VERSION,
    decisionTimestamp: now,
    cohort: "allowlisted" as const,
    bucket: null,
  };
  if (!input.backendRequired) {
    return { eligible: false, reasonCode: "backend_not_required", ...base };
  }
  if (!input.hasDataModel) {
    return { eligible: false, reasonCode: "no_data_model", ...base };
  }
  if (!input.config.ready) {
    return { eligible: false, reasonCode: "platform_not_ready", cohort: null, ...base };
  }
  const listed = input.config.cohort.includes(input.projectId.toLowerCase());
  if (!listed) {
    return { eligible: false, reasonCode: "not_in_allowlist", ...base };
  }
  return { eligible: true, reasonCode: "eligible", ...base };
}

/**
 * ═══ EXECUTION-TIME RECHECK ═════════════════════════════════════════════════
 *
 * Run by the worker immediately before provisioning and before configuration.
 * It combines the SQL gate (live rows, stamps `last_authorized_at`) with the
 * pure `authorizeProvisioning` check, so both the database and the application
 * agree before any provider call.
 *
 * On a legacy deployment with no registry row, the SQL gate reports
 * `enrollment_missing`; the caller decides whether that is fatal. It is not:
 * legacy authorization came from the environment list, and `ensureEnrollment`
 * already ran. `recheckAuthorization` therefore returns `legacy: true` so the
 * caller can proceed without pretending a row exists.
 */
export interface RecheckOutcome {
  authorized: boolean;
  reasonCode: EnrollmentReasonCode;
  /** True when the deployment is on the static allowlist and has no row. */
  legacy: boolean;
  storageFailure: EnrollmentStoreFailureCode | null;
}

export async function recheckAuthorization(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  config: ManagedBackendConfig;
}): Promise<RecheckOutcome> {
  const result = await authorizeProvisioningRpc({
    client: input.client,
    projectId: input.projectId,
    userId: input.userId,
  });

  if (result.ok === false) {
    /**
     * A missing migration on a legacy deployment is not a blocker: the static
     * list authorized this project already. Anywhere else it is fatal.
     */
    if (result.code === "migration_required" && !input.config.enrollment.registryAuthoritative) {
      return {
        authorized: input.config.ready,
        reasonCode: input.config.ready ? "eligible" : "platform_not_ready",
        legacy: true,
        storageFailure: result.code,
      };
    }
    return {
      authorized: false,
      reasonCode: "platform_not_ready",
      legacy: false,
      storageFailure: result.code,
    };
  }

  const gate = result.data;
  if (!gate.authorized) {
    /**
     * ⚠️ MIGRATION 38. `not_enrolled_strict` is NEVER tolerated. The SQL gate
     * reports it only when the deployment has strict authorization on, and in
     * that mode a missing row is a denial by definition. Tolerating it here
     * would silently undo the whole point of strict mode.
     */
    if (gate.reasonCode === "not_enrolled_strict") {
      emitGenerationEvent("managed_backend.authorization.denied", {
        projectId: input.projectId,
        reason: "not_enrolled_strict",
      });
      return {
        authorized: false,
        reasonCode: "not_enrolled_strict",
        legacy: false,
        storageFailure: null,
      };
    }
    const legacyMissing =
      gate.reasonCode === "enrollment_missing" &&
      !input.config.enrollment.registryAuthoritative;
    if (legacyMissing) {
      return {
        authorized: input.config.ready,
        reasonCode: input.config.ready ? "eligible" : "platform_not_ready",
        legacy: true,
        storageFailure: null,
      };
    }
    /**
     * A reason the vocabulary does not know is treated as a denial, not as an
     * unknown-but-fine. `enrollment_missing` is the safe fallback because it is
     * the reason that means "no authorization row exists".
     */
    const known = (ENROLLMENT_REASONS as readonly string[]).includes(gate.reasonCode)
      ? (gate.reasonCode as EnrollmentReasonCode)
      : "enrollment_missing";
    return {
      authorized: false,
      reasonCode: known,
      legacy: false,
      storageFailure: null,
    };
  }

  /**
   * The SQL gate already verified ownership, incarnation and status. This second
   * pass runs the pure policy so the application's own rules (policy version,
   * platform readiness) are enforced even if the SQL drifted.
   */
  const pure: AuthorizationResult = authorizeProvisioning({
    enrollment: {
      status: gate.enrollmentStatus ?? "not_enrolled",
      projectId: input.projectId,
      projectCreatedAt: gate.projectCreatedAt ?? "",
      userId: input.userId,
      policyVersion: ENROLLMENT_POLICY_VERSION,
    },
    projectId: input.projectId,
    projectCreatedAt: gate.projectCreatedAt ?? "",
    userId: input.userId,
    platformReady: input.config.ready,
    /**
     * The gate already authorized, so an enrollment row exists and the strict
     * branch below is unreachable. Passing `true` keeps the two layers in
     * agreement rather than asserting a compatibility path that did not apply.
     */
    strictAuthorization: true,
  });
  if (pure.authorized === false) {
    emitGenerationEvent("managed_backend.authorization.denied", {
      projectId: input.projectId,
      reason: pure.reasonCode,
    });
    return {
      authorized: false,
      reasonCode: pure.reasonCode,
      legacy: false,
      storageFailure: null,
    };
  }
  emitGenerationEvent("managed_backend.provisioning.authorized", {
    projectId: input.projectId,
    status: gate.enrollmentStatus ?? null,
  });
  return { authorized: true, reasonCode: "eligible", legacy: false, storageFailure: null };
}

/** Re-exported so callers do not need to import two modules for the vocabulary. */
export { ENROLLMENT_POLICY_VERSION };
export type { EnrollmentStoreResult };
