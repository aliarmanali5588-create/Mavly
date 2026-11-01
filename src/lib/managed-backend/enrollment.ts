/**
 * ═══ MANAGED BACKEND ENROLLMENT — WHO IS ALLOWED TO GET A DATABASE ══════════
 *
 * Enrollment answers ONE question: "is this project authorized to receive a
 * managed backend?" It is deliberately NOT the backend lifecycle. A project can
 * be `approved` for enrollment and still have no database (`not_required`), or
 * have a `ready` database and later be `suspended`. The two state machines never
 * write into each other:
 *
 *   enrollment  → not_enrolled | pending | approved | rejected | revoked | suspended
 *   lifecycle   → not_required | pending_approval | provisioning | provisioned |
 *                 configuring | ready | failed | outcome_unknown | cleanup_pending
 *
 * ═══ WHY THIS REPLACES THE STATIC PROJECT ALLOWLIST ═════════════════════════
 *
 * `MAVLY_MANAGED_BACKENDS_PROJECTS` required an operator to paste every eligible
 * customer UUID into an environment variable. That does not scale, and it made
 * "the project id is in a list" the whole authorization story. Here, the trusted
 * server evaluates a deterministic policy over facts it already owns (ownership,
 * incarnation, requirement, platform readiness, cohort) and records the decision
 * in Supabase. The model is never consulted, and a project id alone authorizes
 * nothing.
 *
 * ═══ THE TWO GATES, AND WHY THEY ARE DIFFERENT ══════════════════════════════
 *
 *   · ENROLLMENT-TIME gate — the rollout policy (mode + percentage + capacity).
 *     It decides whether a project is admitted AT ALL. It runs once, when the
 *     project first needs a backend, and its result is persisted.
 *
 *   · EXECUTION-TIME gate — `authorizeProvisioning()`. It runs before EVERY
 *     provisioning/configuration call and re-checks only facts that must still
 *     hold: approved enrollment, not revoked/suspended, ownership, incarnation,
 *     platform readiness. It deliberately does NOT re-run the percentage lottery.
 *
 * That split is what makes a rollout decrease safe: lowering the percentage
 * stops NEW admissions and never yanks a database out from under a project that
 * already has one. Revocation is the only thing that stops an existing project,
 * and it is explicit, audited, and never deletes customer data.
 *
 * Pure: no I/O, no clock, no environment. Every input is passed in.
 */

import { createHash } from "node:crypto";

/** The policy version stamped on every recorded decision. */
export const ENROLLMENT_POLICY_VERSION = "1";

/**
 * Rollout cohorts, in the order they are meant to be used. `disabled` is the
 * default and `general_availability` is never the default — both are asserted
 * by tests, because a silent flip to GA is the single worst failure mode here.
 */
export const ENROLLMENT_MODES = [
  "disabled",
  "internal",
  "allowlisted",
  "percentage",
  "general_availability",
] as const;

export type EnrollmentMode = (typeof ENROLLMENT_MODES)[number];

/**
 * The persisted enrollment states. `not_enrolled` is the ABSENCE of a row, so it
 * is a valid decision/status value but never a stored one — the same convention
 * `not_required` follows in the backend lifecycle.
 */
export const ENROLLMENT_STATES = [
  "not_enrolled",
  "pending",
  "approved",
  "rejected",
  "revoked",
  "suspended",
] as const;

export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

/** The states migration 37 accepts in `project_managed_backend_enrollments`. */
export const PERSISTED_ENROLLMENT_STATES: readonly EnrollmentState[] = [
  "pending",
  "approved",
  "rejected",
  "revoked",
  "suspended",
];

export function isPersistedEnrollmentState(
  value: unknown,
): value is EnrollmentState {
  return (
    typeof value === "string" &&
    (PERSISTED_ENROLLMENT_STATES as readonly string[]).includes(value)
  );
}

export function isEnrollmentMode(value: unknown): value is EnrollmentMode {
  return (
    typeof value === "string" &&
    (ENROLLMENT_MODES as readonly string[]).includes(value)
  );
}

/**
 * Machine-readable reasons. Every one is safe to show an owner: none of them
 * reveals a credential, an internal identifier, a salt or another tenant.
 */
export const ENROLLMENT_REASONS = [
  "eligible",
  "grandfathered",
  "mode_disabled",
  "platform_not_ready",
  "backend_not_required",
  "no_data_model",
  "project_not_owned",
  "invalid_incarnation",
  "not_in_internal_cohort",
  "not_in_allowlist",
  "outside_rollout_percentage",
  "capacity_reached",
  "suspended_by_operator",
  "revoked_by_operator",
  "rejected_by_operator",
  "enrollment_missing",
  /**
   * Migration 38: strict authorization is on and this project has NO enrollment
   * row. Distinct from `enrollment_missing` on purpose — that one is the legacy
   * compatibility path where a missing row is tolerated, and conflating the two
   * would make an operator unable to tell which deployment they are looking at.
   */
  "not_enrolled_strict",
  "incarnation_mismatch",
  "owner_mismatch",
  "policy_version_mismatch",
] as const;

export type EnrollmentReasonCode = (typeof ENROLLMENT_REASONS)[number];

/** Reasons that mean "the platform cannot authorize anyone right now". */
const PLATFORM_BLOCKING_REASONS: ReadonlySet<EnrollmentReasonCode> = new Set([
  "mode_disabled",
  "platform_not_ready",
]);

export function isPlatformBlockingReason(
  reason: EnrollmentReasonCode,
): boolean {
  return PLATFORM_BLOCKING_REASONS.has(reason);
}

export interface EnrollmentDecision {
  /** True only when the project may be enrolled AND provisioned. */
  eligible: boolean;
  reasonCode: EnrollmentReasonCode;
  policyVersion: string;
  /**
   * The cohort the project landed in. `null` when no cohort was reached because
   * the platform itself is not ready (there is no meaningful cohort then).
   */
  cohort: EnrollmentMode | null;
  /** Deterministic 0–99 bucket, or null when the percentage policy did not run. */
  bucket: number | null;
  decisionTimestamp: string;
}

/**
 * ═══ DETERMINISTIC ROLLOUT BUCKET ═══════════════════════════════════════════
 *
 * A project's bucket is a pure function of (salt, project id, incarnation). Two
 * consequences that the requirements depend on:
 *
 *   · Repeated evaluation returns the SAME bucket, so a project never flips
 *     between enrolled and not on successive requests.
 *   · Raising the percentage from 10 to 25 admits exactly the projects in
 *     buckets 10–24 and reassigns nobody. Lowering it back to 10 removes only
 *     those same projects from FUTURE admission; an already-approved enrollment
 *     is grandfathered (see `evaluateEnrollment`).
 *
 * `projectCreatedAt` is part of the hash so a deleted-and-recreated project with
 * the same slug is a different rollout subject. Without it, slug reuse would
 * inherit the previous incarnation's bucket.
 */
export function enrollmentBucket(input: {
  projectId: string;
  projectCreatedAt: string;
  salt: string;
}): number {
  const digest = createHash("sha256")
    .update(`${input.salt}\u0000${input.projectId}\u0000${input.projectCreatedAt}`)
    .digest();
  // First 4 bytes as an unsigned int, folded into 0–99. Using a fixed slice
  // keeps the value stable across Node versions and platforms.
  const value = digest.readUInt32BE(0);
  return value % 100;
}

export interface EnrollmentPolicyInput {
  /** The rollout mode the deployment is configured for. */
  mode: EnrollmentMode;
  /** 0–99 for `percentage`; ignored by every other mode. */
  rolloutPercent: number;
  /** Server-only salt. Required for `percentage`; never leaves the server. */
  rolloutSalt: string;
  /** Explicit internal project ids (lowercased), for `internal`. */
  internalProjects: readonly string[];
  /** Explicit allowlist (lowercased), for `allowlisted`. */
  allowlist: readonly string[];
  /** The project being evaluated. */
  projectId: string;
  projectCreatedAt: string;
  /** The trusted requirement decision: does the product need persistence? */
  backendRequired: boolean;
  /** A validated data model exists. No model means no database, ever. */
  hasDataModel: boolean;
  /** Every platform prerequisite (Neon key, org, region, encryption, gateway). */
  platformReady: boolean;
  /** How many projects are currently mid-provisioning. */
  activeProvisions: number;
  /** The configured ceiling on concurrent provisions. */
  maxActiveProvisions: number;
  /** The project's current persisted enrollment state, if any. */
  currentState: EnrollmentState | null;
  /** The timestamp to stamp on the decision. */
  now: string;
}

/**
 * ═══ THE POLICY ENGINE ══════════════════════════════════════════════════════
 *
 * Order matters and is intentional: platform readiness is checked before the
 * cohort so a misconfigured deployment reports "not ready" rather than blaming
 * the project's cohort. Requirement and model checks come next, because a static
 * site must never consume a rollout slot or a provisioning slot.
 */
export function evaluateEnrollment(
  input: EnrollmentPolicyInput,
): EnrollmentDecision {
  const base = {
    policyVersion: ENROLLMENT_POLICY_VERSION,
    decisionTimestamp: input.now,
  } as const;

  const deny = (
    reasonCode: EnrollmentReasonCode,
    cohort: EnrollmentMode | null = null,
    bucket: number | null = null,
  ): EnrollmentDecision => ({
    eligible: false,
    reasonCode,
    cohort,
    bucket,
    ...base,
  });

  /**
   * ⚠️ AN OPERATOR DECISION OUTRANKS THE POLICY. A revoked or suspended project
   * is never re-admitted by a rollout change, a percentage increase or a fresh
   * generation. Only an explicit administrative resume/approve clears it.
   */
  if (input.currentState === "revoked") return deny("revoked_by_operator");
  if (input.currentState === "suspended") return deny("suspended_by_operator");
  if (input.currentState === "rejected") return deny("rejected_by_operator");

  if (input.mode === "disabled") return deny("mode_disabled");
  if (!input.platformReady) return deny("platform_not_ready");

  /**
   * ⚠️ GRANDFATHERING. An already-approved enrollment stays authorized even if
   * the rollout has since narrowed. This is the requirement that a percentage
   * decrease must not silently revoke working databases. It is checked AFTER
   * the operator overrides above, so revocation still wins.
   */
  if (input.currentState === "approved") {
    return {
      eligible: true,
      reasonCode: "grandfathered",
      cohort: input.mode,
      bucket: null,
      ...base,
    };
  }

  if (!input.backendRequired) return deny("backend_not_required");
  if (!input.hasDataModel) return deny("no_data_model");

  const projectId = input.projectId.trim().toLowerCase();

  if (input.mode === "internal") {
    const listed = input.internalProjects.includes(projectId);
    return listed
      ? { eligible: true, reasonCode: "eligible", cohort: "internal", bucket: null, ...base }
      : deny("not_in_internal_cohort", "internal");
  }

  if (input.mode === "allowlisted") {
    const listed = input.allowlist.includes(projectId);
    return listed
      ? { eligible: true, reasonCode: "eligible", cohort: "allowlisted", bucket: null, ...base }
      : deny("not_in_allowlist", "allowlisted");
  }

  if (input.mode === "percentage") {
    /**
     * A missing salt is a configuration bug, not an invitation to enroll
     * everyone. `parseManagedBackendEnrollmentConfig` already refuses this, and
     * the engine refuses it again so a caller cannot bypass the parser.
     */
    if (!input.rolloutSalt) return deny("platform_not_ready", "percentage");
    const bucket = enrollmentBucket({
      projectId: input.projectId,
      projectCreatedAt: input.projectCreatedAt,
      salt: input.rolloutSalt,
    });
    if (bucket >= input.rolloutPercent) {
      return deny("outside_rollout_percentage", "percentage", bucket);
    }
    if (input.activeProvisions >= input.maxActiveProvisions) {
      return deny("capacity_reached", "percentage", bucket);
    }
    return {
      eligible: true,
      reasonCode: "eligible",
      cohort: "percentage",
      bucket,
      ...base,
    };
  }

  // general_availability — every policy-passing project, still capacity-bounded.
  if (input.activeProvisions >= input.maxActiveProvisions) {
    return deny("capacity_reached", "general_availability");
  }
  return {
    eligible: true,
    reasonCode: "eligible",
    cohort: "general_availability",
    bucket: null,
    ...base,
  };
}

/**
 * ═══ EXECUTION-TIME AUTHORIZATION ═══════════════════════════════════════════
 *
 * The worker's independent recheck, run before every provisioning and
 * configuration call. It is intentionally narrower than `evaluateEnrollment`:
 * no percentage lottery, no capacity gate (the lease already serializes work),
 * and no requirement re-derivation. It answers only "may this exact project
 * incarnation be touched right now?"
 *
 * ⚠️ A stale worker must never provision after revocation. Because this reads
 * the enrollment row at execution time rather than trusting a decision passed in
 * from the request that queued the work, a revocation that lands between claim
 * and create is observed here.
 */
export interface AuthorizationInput {
  /** The persisted enrollment row, or null when none exists. */
  enrollment: {
    status: EnrollmentState;
    projectId: string;
    projectCreatedAt: string;
    userId: string | null;
    policyVersion: string;
  } | null;
  /** The project the worker is actually operating on. */
  projectId: string;
  /** The incarnation the worker resolved from `public.projects`. */
  projectCreatedAt: string;
  /** The owner the worker verified. */
  userId: string;
  /** Platform prerequisites still hold. */
  platformReady: boolean;
  /**
   * Migration 38. When true, a MISSING enrollment row is a denial rather than
   * the legacy compatibility path. Defaults to `false` so every existing caller
   * keeps its current behavior until it opts in explicitly.
   */
  strictAuthorization?: boolean;
}

export type AuthorizationResult =
  | { authorized: true }
  | { authorized: false; reasonCode: EnrollmentReasonCode };

export function authorizeProvisioning(
  input: AuthorizationInput,
): AuthorizationResult {
  if (!input.platformReady) {
    return { authorized: false, reasonCode: "platform_not_ready" };
  }
  const enrollment = input.enrollment;
  if (!enrollment) {
    /**
     * ⚠️ THE STRICT-MODE DIFFERENCE. A missing row is only tolerable outside
     * strict mode; inside it, absence IS the denial.
     */
    return {
      authorized: false,
      reasonCode: input.strictAuthorization === true
        ? "not_enrolled_strict"
        : "enrollment_missing",
    };
  }
  /**
   * Ownership and incarnation are compared here as well as in SQL. The SQL
   * function is the authority (it reads the live rows); this is the second lock
   * on the same door, so a caller that skipped the RPC still cannot proceed.
   */
  if (enrollment.userId !== input.userId) {
    return { authorized: false, reasonCode: "owner_mismatch" };
  }
  if (enrollment.projectId !== input.projectId) {
    return { authorized: false, reasonCode: "enrollment_missing" };
  }
  if (
    Date.parse(enrollment.projectCreatedAt) !== Date.parse(input.projectCreatedAt)
  ) {
    return { authorized: false, reasonCode: "incarnation_mismatch" };
  }
  if (enrollment.status !== "approved") {
    if (enrollment.status === "revoked") {
      return { authorized: false, reasonCode: "revoked_by_operator" };
    }
    if (enrollment.status === "suspended") {
      return { authorized: false, reasonCode: "suspended_by_operator" };
    }
    if (enrollment.status === "rejected") {
      return { authorized: false, reasonCode: "rejected_by_operator" };
    }
    return { authorized: false, reasonCode: "enrollment_missing" };
  }
  if (enrollment.policyVersion !== ENROLLMENT_POLICY_VERSION) {
    return { authorized: false, reasonCode: "policy_version_mismatch" };
  }
  return { authorized: true };
}

/** An owner-facing sentence per reason. Never a success claim, never a secret. */
export function enrollmentReasonLabel(reason: EnrollmentReasonCode): string {
  switch (reason) {
    case "eligible":
      return "This project is enrolled for a managed database.";
    case "grandfathered":
      return "This project was enrolled earlier and keeps its managed database.";
    case "mode_disabled":
      return "Automatic managed database enrollment is switched off on this deployment.";
    case "platform_not_ready":
      return "Mavly's managed database platform is not fully configured on this deployment.";
    case "backend_not_required":
      return "This project does not need a persistent backend.";
    case "no_data_model":
      return "A database was needed but no valid data model was produced, so none was created.";
    case "project_not_owned":
      return "The project owner could not be verified.";
    case "invalid_incarnation":
      return "The project's creation record could not be verified.";
    case "not_in_internal_cohort":
      return "Automatic enrollment is currently limited to internal projects.";
    case "not_in_allowlist":
      return "Automatic enrollment is currently limited to an approved project list.";
    case "outside_rollout_percentage":
      return "This project is outside the current managed database rollout.";
    case "capacity_reached":
      return "Mavly is at its managed database provisioning capacity. Retry shortly.";
    case "suspended_by_operator":
      return "Managed database enrollment for this project is suspended by an operator.";
    case "revoked_by_operator":
      return "Managed database enrollment for this project was revoked. Existing data was not deleted.";
    case "rejected_by_operator":
      return "Managed database enrollment for this project was declined by an operator.";
    case "enrollment_missing":
      return "This project is not enrolled for a managed database.";
    case "not_enrolled_strict":
      return "This project is not enrolled for a managed database, and automatic enrollment is closed on this deployment.";
    case "incarnation_mismatch":
      return "The enrollment record belongs to a different incarnation of this project.";
    case "owner_mismatch":
      return "The enrollment record belongs to a different owner.";
    case "policy_version_mismatch":
      return "The enrollment was decided under an older policy and must be re-evaluated.";
  }
}

/** The owner-facing enrollment status projection. Never contains a salt. */
export interface EnrollmentStatusView {
  state: EnrollmentState;
  cohort: EnrollmentMode | null;
  eligible: boolean;
  reasonCode: EnrollmentReasonCode;
  label: string;
  policyVersion: string | null;
  enrolledAt: string | null;
  lastAuthorizedAt: string | null;
  /** True when the backend lifecycle may proceed for this project. */
  provisioningAuthorized: boolean;
}

export function enrollmentStatusView(input: {
  state: EnrollmentState;
  cohort: EnrollmentMode | null;
  reasonCode: EnrollmentReasonCode;
  policyVersion: string | null;
  enrolledAt: string | null;
  lastAuthorizedAt: string | null;
}): EnrollmentStatusView {
  return {
    state: input.state,
    cohort: input.cohort,
    eligible: input.state === "approved",
    reasonCode: input.reasonCode,
    label: enrollmentReasonLabel(input.reasonCode),
    policyVersion: input.policyVersion,
    enrolledAt: input.enrolledAt,
    lastAuthorizedAt: input.lastAuthorizedAt,
    provisioningAuthorized: input.state === "approved",
  };
}
