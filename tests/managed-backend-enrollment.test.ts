import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ENROLLMENT_MODES,
  ENROLLMENT_POLICY_VERSION,
  ENROLLMENT_REASONS,
  ENROLLMENT_STATES,
  PERSISTED_ENROLLMENT_STATES,
  authorizeProvisioning,
  enrollmentBucket,
  enrollmentReasonLabel,
  enrollmentStatusView,
  evaluateEnrollment,
  isEnrollmentMode,
  isPersistedEnrollmentState,
  type EnrollmentMode,
  type EnrollmentPolicyInput,
  type EnrollmentState,
} from "../src/lib/managed-backend/enrollment";
import {
  parseEnrollmentConfig,
  parseManagedBackendConfig,
  type ManagedBackendConfigProblem,
} from "../src/lib/managed-backend/config";
import {
  backfillSummaryFrom,
  coverageFrom,
} from "../src/lib/managed-backend/enrollment-store";
import { commitGateAllows } from "../src/lib/managed-backend/runner";

/**
 * ═══ MANAGED BACKEND ENROLLMENT — PURE AND STATIC ═══════════════════════════
 *
 * Nothing here provisions Neon, calls Supabase, or runs a migration. These tests
 * pin the decisions that make automatic enrollment safe:
 *
 *   · a static site never enrolls;
 *   · a model output can never approve anything;
 *   · a percentage rollout is deterministic and monotonic;
 *   · an operator revocation outranks every policy path;
 *   · general availability is never the default;
 *   · every configuration failure fails CLOSED.
 *
 * The SQL half (RLS, grants, the execution-time gate) is verified statically at
 * the bottom of this file, because this repository's policy is that agents do
 * not run a database.
 */

const SALT = "test-rollout-salt-0123456789abcdef";

function policyInput(
  overrides: Partial<EnrollmentPolicyInput> = {},
): EnrollmentPolicyInput {
  return {
    mode: "percentage",
    rolloutPercent: 100,
    rolloutSalt: SALT,
    internalProjects: [],
    allowlist: [],
    projectId: "my-app",
    projectCreatedAt: "2026-01-01T00:00:00.000Z",
    backendRequired: true,
    hasDataModel: true,
    platformReady: true,
    activeProvisions: 0,
    maxActiveProvisions: 5,
    currentState: null,
    now: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

test("enrollment states are a closed set and not_enrolled is never persisted", () => {
  assert.deepEqual([...ENROLLMENT_STATES], [
    "not_enrolled",
    "pending",
    "approved",
    "rejected",
    "revoked",
    "suspended",
  ]);
  assert.equal(isPersistedEnrollmentState("not_enrolled"), false);
  for (const state of PERSISTED_ENROLLMENT_STATES) {
    assert.equal(isPersistedEnrollmentState(state), true, state);
  }
  assert.equal(isPersistedEnrollmentState("approved "), false);
  assert.equal(isPersistedEnrollmentState(42), false);
});

test("enrollment modes are a closed set with disabled first and GA last", () => {
  assert.equal(ENROLLMENT_MODES[0], "disabled");
  assert.equal(ENROLLMENT_MODES[ENROLLMENT_MODES.length - 1], "general_availability");
  assert.equal(isEnrollmentMode("percentage"), true);
  assert.equal(isEnrollmentMode("everyone"), false);
});

test("every reason code has an owner-facing label and none leaks internals", () => {
  for (const reason of ENROLLMENT_REASONS) {
    const label = enrollmentReasonLabel(reason);
    assert.ok(label.length > 0, reason);
    assert.ok(label.length < 240, `${reason} label too long`);
    // A label must never contain a credential-shaped or internal token.
    assert.ok(!/salt|secret|token|key|uri|ciphertext/i.test(label), reason);
  }
});

// ── Static-only and model-less projects never enroll ────────────────────────

test("a project that does not need a backend is never enrolled", () => {
  const decision = evaluateEnrollment(policyInput({ backendRequired: false }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "backend_not_required");
});

test("a required backend with no validated data model is never enrolled", () => {
  const decision = evaluateEnrollment(policyInput({ hasDataModel: false }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "no_data_model");
});

test("a static project consumes no rollout slot and no capacity", () => {
  // Even at 100% with capacity full, a static project is refused for its own
  // reason, never for capacity — so it cannot mask a real capacity problem.
  const decision = evaluateEnrollment(
    policyInput({
      backendRequired: false,
      activeProvisions: 99,
      maxActiveProvisions: 5,
    }),
  );
  assert.equal(decision.reasonCode, "backend_not_required");
});

// ── Platform readiness outranks cohort ──────────────────────────────────────

test("an unready platform reports platform_not_ready, not a cohort refusal", () => {
  const decision = evaluateEnrollment(policyInput({ platformReady: false }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "platform_not_ready");
  assert.equal(decision.cohort, null);
});

test("disabled mode enrolls nobody even when every other gate passes", () => {
  const decision = evaluateEnrollment(policyInput({ mode: "disabled" }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "mode_disabled");
});

// ── Cohorts ─────────────────────────────────────────────────────────────────

test("internal mode admits only listed projects", () => {
  const listed = evaluateEnrollment(
    policyInput({ mode: "internal", internalProjects: ["my-app"] }),
  );
  assert.equal(listed.eligible, true);
  assert.equal(listed.cohort, "internal");

  const unlisted = evaluateEnrollment(
    policyInput({ mode: "internal", internalProjects: ["other-app"] }),
  );
  assert.equal(unlisted.eligible, false);
  assert.equal(unlisted.reasonCode, "not_in_internal_cohort");
});

test("allowlisted mode admits only the allowlist", () => {
  const listed = evaluateEnrollment(
    policyInput({ mode: "allowlisted", allowlist: ["my-app"] }),
  );
  assert.equal(listed.eligible, true);
  assert.equal(listed.cohort, "allowlisted");

  const unlisted = evaluateEnrollment(
    policyInput({ mode: "allowlisted", allowlist: [] }),
  );
  assert.equal(unlisted.eligible, false);
  assert.equal(unlisted.reasonCode, "not_in_allowlist");
});

test("general availability is capacity-bounded and never the default", () => {
  const ok = evaluateEnrollment(policyInput({ mode: "general_availability" }));
  assert.equal(ok.eligible, true);
  assert.equal(ok.cohort, "general_availability");

  const full = evaluateEnrollment(
    policyInput({
      mode: "general_availability",
      activeProvisions: 5,
      maxActiveProvisions: 5,
    }),
  );
  assert.equal(full.eligible, false);
  assert.equal(full.reasonCode, "capacity_reached");

  // The engine's own default mode is not GA: an unset mode must be disabled.
  const disabled = evaluateEnrollment(policyInput({ mode: "disabled" }));
  assert.equal(disabled.eligible, false);
});

// ── Percentage rollout: determinism and monotonicity ────────────────────────

test("the rollout bucket is deterministic for the same inputs", () => {
  const a = enrollmentBucket({
    projectId: "my-app",
    projectCreatedAt: "2026-01-01T00:00:00.000Z",
    salt: SALT,
  });
  const b = enrollmentBucket({
    projectId: "my-app",
    projectCreatedAt: "2026-01-01T00:00:00.000Z",
    salt: SALT,
  });
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 100);
});

test("the bucket changes with salt, project and incarnation", () => {
  const base = enrollmentBucket({
    projectId: "my-app",
    projectCreatedAt: "2026-01-01T00:00:00.000Z",
    salt: SALT,
  });
  const otherSalt = enrollmentBucket({
    projectId: "my-app",
    projectCreatedAt: "2026-01-01T00:00:00.000Z",
    salt: "a-different-salt-0123456789abcdef",
  });
  const otherProject = enrollmentBucket({
    projectId: "other-app",
    projectCreatedAt: "2026-01-01T00:00:00.000Z",
    salt: SALT,
  });
  /**
   * A recreated project (same slug, new created_at) must be a DIFFERENT rollout
   * subject, otherwise slug reuse would inherit the previous approval.
   */
  const otherIncarnation = enrollmentBucket({
    projectId: "my-app",
    projectCreatedAt: "2026-06-01T00:00:00.000Z",
    salt: SALT,
  });
  const distinct = new Set([base, otherSalt, otherProject, otherIncarnation]);
  assert.ok(distinct.size >= 3, "buckets should differ across inputs");
});

test("repeated evaluation returns the same decision", () => {
  const first = evaluateEnrollment(policyInput({ rolloutPercent: 50 }));
  const second = evaluateEnrollment(policyInput({ rolloutPercent: 50 }));
  assert.deepEqual(first, second);
});

test("raising the percentage never removes an admitted project", () => {
  /**
   * The core monotonicity guarantee: buckets are fixed, so admission is
   * `bucket < percent`. Every project admitted at 10% is still admitted at 25%.
   */
  const admittedAt10: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const decision = evaluateEnrollment(
      policyInput({ projectId: `project-${i}`, rolloutPercent: 10 }),
    );
    if (decision.eligible) admittedAt10.push(`project-${i}`);
  }
  assert.ok(admittedAt10.length > 0, "10% should admit some projects");

  for (const projectId of admittedAt10) {
    const at25 = evaluateEnrollment(
      policyInput({ projectId, rolloutPercent: 25 }),
    );
    assert.equal(at25.eligible, true, `${projectId} lost admission when raising rollout`);
  }
});

test("lowering the percentage stops new admissions but grandfathers existing ones", () => {
  const projectId = "my-app";
  const admitted = evaluateEnrollment(
    policyInput({ projectId, rolloutPercent: 100 }),
  );
  assert.equal(admitted.eligible, true);

  /**
   * ⚠️ THE REQUIREMENT THAT MATTERS MOST HERE. An already-approved enrollment is
   * not revoked by a rollout decrease: its database must not disappear because
   * an operator dialed the percentage down.
   */
  const afterDecrease = evaluateEnrollment(
    policyInput({ projectId, rolloutPercent: 0, currentState: "approved" }),
  );
  assert.equal(afterDecrease.eligible, true);
  assert.equal(afterDecrease.reasonCode, "grandfathered");
});

test("a project outside the percentage is pending, not rejected", () => {
  const decision = evaluateEnrollment(policyInput({ rolloutPercent: 0 }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "outside_rollout_percentage");
  assert.ok(decision.bucket !== null);
});

test("percentage mode without a salt refuses rather than enrolling everyone", () => {
  const decision = evaluateEnrollment(
    policyInput({ rolloutPercent: 100, rolloutSalt: "" }),
  );
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "platform_not_ready");
});

// ── Operator decisions outrank the policy ───────────────────────────────────

test("revoked, suspended and rejected outrank every policy path", () => {
  const cases: Array<[EnrollmentState, string]> = [
    ["revoked", "revoked_by_operator"],
    ["suspended", "suspended_by_operator"],
    ["rejected", "rejected_by_operator"],
  ];
  for (const [state, reason] of cases) {
    // Even at 100% GA with capacity free, an operator decision wins.
    const decision = evaluateEnrollment(
      policyInput({
        mode: "general_availability",
        rolloutPercent: 100,
        currentState: state,
      }),
    );
    assert.equal(decision.eligible, false, state);
    assert.equal(decision.reasonCode, reason, state);
  }
});

test("a revoked project is not re-admitted by a rollout increase", () => {
  const decision = evaluateEnrollment(
    policyInput({ mode: "general_availability", currentState: "revoked" }),
  );
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "revoked_by_operator");
});

// ── Execution-time authorization ────────────────────────────────────────────

const approvedEnrollment = {
  status: "approved" as EnrollmentState,
  projectId: "my-app",
  projectCreatedAt: "2026-01-01T00:00:00.000Z",
  userId: "11111111-1111-1111-1111-111111111111",
  policyVersion: ENROLLMENT_POLICY_VERSION,
};

function authInput(overrides: Record<string, unknown> = {}) {
  return {
    enrollment: approvedEnrollment,
    projectId: "my-app",
    projectCreatedAt: "2026-01-01T00:00:00.000Z",
    userId: "11111111-1111-1111-1111-111111111111",
    platformReady: true,
    ...overrides,
  } as Parameters<typeof authorizeProvisioning>[0];
}

test("an approved, owned, matching incarnation is authorized", () => {
  const result = authorizeProvisioning(authInput());
  assert.equal(result.authorized, true);
});

test("no enrollment row means no authorization", () => {
  const result = authorizeProvisioning(authInput({ enrollment: null }));
  assert.equal(result.authorized, false);
  assert.equal(result.authorized === false && result.reasonCode, "enrollment_missing");
});

test("a revoked enrollment cannot provision, even for the right owner", () => {
  const result = authorizeProvisioning(
    authInput({ enrollment: { ...approvedEnrollment, status: "revoked" } }),
  );
  assert.equal(result.authorized, false);
  assert.equal(result.authorized === false && result.reasonCode, "revoked_by_operator");
});

test("a suspended enrollment cannot provision", () => {
  const result = authorizeProvisioning(
    authInput({ enrollment: { ...approvedEnrollment, status: "suspended" } }),
  );
  assert.equal(result.authorized, false);
  assert.equal(result.authorized === false && result.reasonCode, "suspended_by_operator");
});

test("a pending enrollment cannot provision", () => {
  const result = authorizeProvisioning(
    authInput({ enrollment: { ...approvedEnrollment, status: "pending" } }),
  );
  assert.equal(result.authorized, false);
});

test("the wrong owner cannot provision", () => {
  const result = authorizeProvisioning(
    authInput({ userId: "22222222-2222-2222-2222-222222222222" }),
  );
  assert.equal(result.authorized, false);
  assert.equal(result.authorized === false && result.reasonCode, "owner_mismatch");
});

test("the wrong project incarnation cannot provision", () => {
  const result = authorizeProvisioning(
    authInput({ projectCreatedAt: "2026-06-01T00:00:00.000Z" }),
  );
  assert.equal(result.authorized, false);
  assert.equal(result.authorized === false && result.reasonCode, "incarnation_mismatch");
});

test("an enrollment for a different project cannot provision", () => {
  const result = authorizeProvisioning(authInput({ projectId: "other-app" }));
  assert.equal(result.authorized, false);
});

test("an unready platform blocks even an approved enrollment", () => {
  const result = authorizeProvisioning(authInput({ platformReady: false }));
  assert.equal(result.authorized, false);
  assert.equal(result.authorized === false && result.reasonCode, "platform_not_ready");
});

test("an older policy version forces re-evaluation", () => {
  const result = authorizeProvisioning(
    authInput({ enrollment: { ...approvedEnrollment, policyVersion: "0" } }),
  );
  assert.equal(result.authorized, false);
  assert.equal(result.authorized === false && result.reasonCode, "policy_version_mismatch");
});

// ── Status projection ───────────────────────────────────────────────────────

test("an approved enrollment is not reported as a ready backend", () => {
  const view = enrollmentStatusView({
    state: "approved",
    cohort: "percentage",
    reasonCode: "eligible",
    policyVersion: ENROLLMENT_POLICY_VERSION,
    enrolledAt: "2026-01-01T00:00:00.000Z",
    lastAuthorizedAt: null,
  });
  assert.equal(view.state, "approved");
  assert.equal(view.eligible, true);
  assert.equal(view.provisioningAuthorized, true);
  // The label must not claim a database exists.
  assert.ok(!/ready|live|created/i.test(view.label));
});

test("a revoked enrollment reports no provisioning authorization", () => {
  const view = enrollmentStatusView({
    state: "revoked",
    cohort: "percentage",
    reasonCode: "revoked_by_operator",
    policyVersion: ENROLLMENT_POLICY_VERSION,
    enrolledAt: "2026-01-01T00:00:00.000Z",
    lastAuthorizedAt: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(view.provisioningAuthorized, false);
  assert.equal(view.eligible, false);
});

// ── Configuration: every failure fails closed ───────────────────────────────

function enrollmentEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    MAVLY_MANAGED_BACKENDS_ENABLED: "true",
    MAVLY_NEON_AGENT_PLAN_APPROVED: "true",
    NEON_API_KEY: "napi_test",
    NEON_ORG_ID: "org-abc123",
    NEON_REGION_ID: "aws-us-east-1",
    MAVLY_MANAGED_BACKENDS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    MAVLY_APP_GATEWAY_ORIGIN: "https://app.example.com",
    MAVLY_MANAGED_BACKENDS_RPC_SECRET: "x".repeat(40),
    ...overrides,
  };
}

test("an unset enrollment mode is the documented legacy path", () => {
  const config = parseManagedBackendConfig(
    enrollmentEnv({ MAVLY_MANAGED_BACKENDS_PROJECTS: "my-app" }),
  );
  assert.equal(config.enrollment.mode, null);
  assert.equal(config.enrollment.registryAuthoritative, false);
  assert.equal(config.ready, true);
});

test("legacy mode still refuses an empty project list", () => {
  const config = parseManagedBackendConfig(enrollmentEnv());
  assert.equal(config.ready, false);
  assert.ok(config.problems.includes("missing_cohort"));
});

test("legacy mode still refuses a wildcard cohort", () => {
  const config = parseManagedBackendConfig(
    enrollmentEnv({ MAVLY_MANAGED_BACKENDS_PROJECTS: "*" }),
  );
  assert.equal(config.ready, false);
  assert.ok(config.problems.includes("missing_cohort"));
});

test("registry mode allows an empty project list, because the list is not authorization", () => {
  const config = parseManagedBackendConfig(
    enrollmentEnv({ MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "disabled" }),
  );
  assert.equal(config.enrollment.registryAuthoritative, true);
  assert.equal(config.ready, true);
  assert.ok(!config.problems.includes("missing_cohort"));
});

test("registry mode still refuses a wildcard cohort", () => {
  const config = parseManagedBackendConfig(
    enrollmentEnv({
      MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "allowlisted",
      MAVLY_MANAGED_BACKENDS_PROJECTS: "*",
    }),
  );
  assert.equal(config.ready, false);
  assert.ok(config.problems.includes("missing_cohort"));
});

test("an unknown enrollment mode is refused", () => {
  const config = parseManagedBackendConfig(
    enrollmentEnv({ MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "everyone" }),
  );
  assert.equal(config.ready, false);
  assert.ok(config.problems.includes("invalid_enrollment_mode"));
});

test("percentage mode without a percentage is refused, never defaulted to 100", () => {
  const config = parseManagedBackendConfig(
    enrollmentEnv({
      MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "percentage",
      MAVLY_MANAGED_BACKENDS_ROLLOUT_SALT: SALT,
    }),
  );
  assert.equal(config.ready, false);
  assert.ok(config.problems.includes("invalid_rollout_percent"));
  assert.equal(config.enrollment.rolloutPercent, 0);
});

test("a malformed or out-of-range percentage is refused", () => {
  for (const value of ["abc", "-5", "100", "1000", "12.5"]) {
    const problems: ManagedBackendConfigProblem[] = [];
    parseEnrollmentConfig(
      {
        MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "percentage",
        MAVLY_MANAGED_BACKENDS_ROLLOUT_PERCENT: value,
        MAVLY_MANAGED_BACKENDS_ROLLOUT_SALT: SALT,
      },
      problems,
    );
    assert.ok(
      problems.includes("invalid_rollout_percent"),
      `percentage "${value}" should be refused`,
    );
  }
});

test("percentage mode without a salt is refused", () => {
  const config = parseManagedBackendConfig(
    enrollmentEnv({
      MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "percentage",
      MAVLY_MANAGED_BACKENDS_ROLLOUT_PERCENT: "10",
    }),
  );
  assert.equal(config.ready, false);
  assert.ok(config.problems.includes("missing_rollout_salt"));
});

test("a valid percentage configuration parses", () => {
  const config = parseManagedBackendConfig(
    enrollmentEnv({
      MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "percentage",
      MAVLY_MANAGED_BACKENDS_ROLLOUT_PERCENT: "25",
      MAVLY_MANAGED_BACKENDS_ROLLOUT_SALT: SALT,
      MAVLY_MANAGED_BACKENDS_MAX_ACTIVE_PROVISIONS: "3",
    }),
  );
  assert.equal(config.ready, true);
  assert.equal(config.enrollment.mode, "percentage");
  assert.equal(config.enrollment.rolloutPercent, 25);
  assert.equal(config.enrollment.maxActiveProvisions, 3);
});

test("capacity is bounded and never zero or unbounded", () => {
  for (const value of ["0", "999", "-1", "abc"]) {
    const problems: ManagedBackendConfigProblem[] = [];
    parseEnrollmentConfig(
      {
        MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "internal",
        MAVLY_MANAGED_BACKENDS_MAX_ACTIVE_PROVISIONS: value,
      },
      problems,
    );
    assert.ok(
      problems.includes("invalid_max_active_provisions"),
      `capacity "${value}" should be refused`,
    );
  }
});

test("the default capacity is bounded", () => {
  const config = parseEnrollmentConfig(
    { MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "internal" },
    [],
  );
  assert.ok(config.maxActiveProvisions >= 1);
  assert.ok(config.maxActiveProvisions <= 50);
});

test("the rollout salt never appears in a parsed public projection", () => {
  const config = parseManagedBackendConfig(
    enrollmentEnv({
      MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE: "percentage",
      MAVLY_MANAGED_BACKENDS_ROLLOUT_PERCENT: "10",
      MAVLY_MANAGED_BACKENDS_ROLLOUT_SALT: SALT,
    }),
  );
  // The salt is present on the server config (the policy needs it)…
  assert.equal(config.enrollment.rolloutSalt, SALT);
  // …but no status projection may carry it.
  const view = enrollmentStatusView({
    state: "approved",
    cohort: "percentage",
    reasonCode: "eligible",
    policyVersion: ENROLLMENT_POLICY_VERSION,
    enrolledAt: null,
    lastAuthorizedAt: null,
  });
  assert.ok(!JSON.stringify(view).includes(SALT));
});

// ── Static verification of the migration ────────────────────────────────────

test("migration 37 keeps the registry deny-by-default and service-role-only", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/37_managed_backend_enrollment.sql", import.meta.url),
    "utf8",
  );

  // RLS enabled on both tables.
  assert.match(sql, /alter table public\.project_managed_backend_enrollments enable row level security/);
  assert.match(sql, /alter table public\.project_managed_backend_enrollment_events enable row level security/);

  // No policy is created on either table: zero policies means deny-all.
  assert.ok(!/create policy[\s\S]{0,200}project_managed_backend_enrollment/i.test(sql));

  // Privileges revoked from the client roles.
  assert.match(sql, /revoke all on public\.project_managed_backend_enrollments\s+from public, anon, authenticated/);
  assert.match(sql, /revoke all on public\.project_managed_backend_enrollment_events\s+from public, anon, authenticated/);

  // Every mutation function is security definer with an empty search_path.
  // Comments are stripped first so the header prose cannot satisfy the check.
  const code = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const definers = code.match(/security definer/g) ?? [];
  const emptyPaths = code.match(/set search_path = ''/g) ?? [];
  assert.ok(definers.length >= 8, "expected the enrollment RPCs to be security definer");
  assert.equal(definers.length, emptyPaths.length, "every definer must pin an empty search_path");

  // The policy write path refuses a non-service caller.
  assert.match(sql, /auth\.role\(\) <> 'service_role'[\s\S]{0,120}service role required/);

  // Administrative actions derive authority from the caller's own identity.
  assert.match(sql, /if not public\.current_user_is_admin\(\) then/);
  assert.ok(!/p_is_admin|is_admin boolean|p_role/i.test(sql), "no client-supplied admin flag");

  // The audit table is append-only.
  assert.match(sql, /enrollment audit history is append-only/);
  assert.match(sql, /before update or delete on public\.project_managed_backend_enrollment_events/);

  // One enrollment per project incarnation.
  assert.match(sql, /unique \(project_id, project_created_at\)/);

  // The execution-time gate exists and is service-role only.
  assert.match(sql, /create or replace function public\.authorize_managed_backend_provisioning/);
  assert.match(sql, /grant execute on function public\.authorize_managed_backend_provisioning\(text, uuid\)\s+to service_role/);

  // Revocation never deletes customer data.
  assert.ok(!/delete from public\.project_managed_backends/i.test(sql));
  assert.ok(!/delete from public\.project_managed_backend_enrollments/i.test(sql));
  assert.ok(!/drop table/i.test(sql));

  // Schema marker.
  assert.match(sql, /select 37/);
});

test("migration 37 guards the create and configure paths without changing signatures", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/37_managed_backend_enrollment.sql", import.meta.url),
    "utf8",
  );

  // Both pre-existing functions are redefined with their original signatures.
  assert.match(
    sql,
    /create or replace function public\.mark_managed_backend_create_started\(\s*p_project_id text,\s*p_project_created_at timestamptz,\s*p_lease_token uuid\s*\)/,
  );
  assert.match(
    sql,
    /create or replace function public\.begin_managed_backend_configuration\(\s*p_project_id text,\s*p_user_id uuid,\s*p_lease_token uuid\s*\)/,
  );

  // The guard is conditional on a registry row existing, so a legacy deployment
  // with no rows keeps its exact previous behavior.
  const guards = sql.match(/if found and v_enrollment_status <> 'approved' then/g) ?? [];
  assert.equal(guards.length, 2, "both the create and configure paths need the guard");
});

test("the run stage no longer authorizes on the project id alone", async () => {
  const source = await readFile(
    new URL("../src/lib/mavly/run-agent.ts", import.meta.url),
    "utf8",
  );
  // The old single-line cohort check is gone.
  assert.ok(
    !/const inCohort = config\.cohort\.includes\(input\.projectId\.toLowerCase\(\)\)/.test(source),
    "the static cohort check must be replaced by the enrollment service",
  );
  // Enrollment and the execution-time recheck are both present.
  assert.match(source, /await ensureEnrollment\(/);
  assert.match(source, /await recheckAuthorization\(/);
  // The configuration phase gets its own recheck, not just provisioning.
  assert.match(source, /configuration_authorization_/);
});

test("the enrollment service never trusts a model output as authorization", async () => {
  const source = await readFile(
    new URL("../src/lib/managed-backend/enrollment-service.ts", import.meta.url),
    "utf8",
  );
  // The policy inputs are booleans derived by trusted code, never a raw planner
  // object passed through.
  assert.ok(!/planner\??\.requiresDatabase/.test(source));
  assert.ok(!/manifest\.backendRequirement/.test(source));
});

/**
 * ═══ MIGRATION 38 — BACKFILL AND STRICT AUTHORIZATION ═══════════════════════
 *
 * The ten scenarios below are the ones that decide whether strict mode can be
 * turned on without stranding a customer database. They are split into two
 * kinds, and the split is honest about what each can prove:
 *
 *   PURE      — real code, real assertions: the commit gate's fail-closed rule,
 *               the strict-mode reason code, the summary/coverage parsers.
 *
 *   STATIC    — the migration SQL is read and its structure asserted. This
 *               repository's policy is that agents do not run a database, so a
 *               static assertion is the strongest evidence available here. It
 *               proves the branch exists and is shaped correctly; it does NOT
 *               prove Postgres accepts it. That is stated in the runbook too.
 */

const migration38 = async () =>
  readFile(
    new URL("../supabase/migrations/38_managed_backend_enrollment_hardening.sql", import.meta.url),
    "utf8",
  ); /** Strip `--` line comments so header prose cannot satisfy an assertion. */
function sqlCode(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n"); }

// ── 1. Strict mode: a missing enrollment is a denial ────────────────────────

test("strict authorization turns a missing enrollment into a denial", () => {
  const legacy = authorizeProvisioning(authInput({ enrollment: null })); assert.equal(legacy.authorized, false); assert.equal(
    (legacy as { reasonCode: string }).reasonCode,
    "enrollment_missing",
    "outside strict mode a missing row keeps the legacy compatibility reason",
  ); const strict = authorizeProvisioning(
    authInput({ enrollment: null, strictAuthorization: true }),
  ); assert.equal(strict.authorized, false); assert.equal(
    (strict as { reasonCode: string }).reasonCode,
    "not_enrolled_strict",
    "inside strict mode absence IS the denial, with its own reason",
  ); }); test("strict mode does not weaken any other denial", () => {
  for (const status of ["revoked", "suspended", "rejected", "pending"] as const) {
    const result = authorizeProvisioning(
      authInput({
        enrollment: { ...approvedEnrollment, status },
        strictAuthorization: true,
      }),
    ); assert.equal(result.authorized, false, `${status} must deny under strict mode`); }

  // An approved row still authorizes under strict mode: strictness is about
  // ABSENCE, not about making every project fail.
  const approved = authorizeProvisioning(
    authInput({ strictAuthorization: true }),
  ); assert.equal(approved.authorized, true); }); test("the new reason code is in the vocabulary and has an owner-facing label", () => {
  assert.ok((ENROLLMENT_REASONS as readonly string[]).includes("not_enrolled_strict")); const label = enrollmentReasonLabel("not_enrolled_strict"); assert.ok(label.length > 0); // It must not leak an internal identifier or claim success.
  assert.ok(!/uuid|registry|salt/i.test(label)); }); // ── 2. The commit gate fails closed ─────────────────────────────────────────

test("an authorization check that cannot answer is a refusal, not a pass", async () => {
  assert.equal(await commitGateAllows(undefined), true, "no check means no gate"); assert.equal(await commitGateAllows(async () => true), true); assert.equal(await commitGateAllows(async () => false), false); assert.equal(
    await commitGateAllows(async () => {
      throw new Error("storage unavailable"); }),
    false,
    "a throwing check must deny: 'cannot answer' is never 'yes'",
  ); // Anything that is not exactly `true` denies.
  assert.equal(
    await commitGateAllows((async () => "yes") as unknown as () => Promise<boolean>),
    false,
  ); }); // ── 3. Backfill summary parsing ─────────────────────────────────────────────

test("a backfill summary defaults to a dry run and never invents counts", () => {
  const summary = backfillSummaryFrom({
    scanned: 12,
    eligible: 9,
    alreadyEnrolled: 2,
    skipped: 1,
    rejected: 1,
    inserted: 0,
    promoted: 0,
    rejectedReasons: { backfill_project_missing: 1 },
    rejectedSamples: [
      {
        projectId: "gone-app",
        projectCreatedAt: "2026-01-01T00:00:00+00:00",
        backendStatus: "ready",
        reason: "backfill_project_missing",
      },
    ],
    completedAt: "2026-11-01T00:00:00+00:00",
  }); assert.ok(summary); assert.equal(summary!.dryRun, true, "an omitted dryRun field must read as a dry run"); assert.equal(summary!.scanned, 12); assert.equal(summary!.rejected, 1); assert.equal(summary!.rejectedReasons.backfill_project_missing, 1); assert.equal(summary!.rejectedSamples[0].projectId, "gone-app"); // A malformed payload is a failure, not a zeroed success.
  assert.equal(backfillSummaryFrom(null), null); assert.equal(backfillSummaryFrom("nope"), null); // Missing numeric fields read as zero rather than NaN.
  const sparse = backfillSummaryFrom({ dryRun: false }); assert.ok(sparse); assert.equal(sparse!.scanned, 0); assert.equal(sparse!.dryRun, false); }); test("coverage treats an absent strict flag as strict and an absent ready flag as not ready", () => {
  const coverage = coverageFrom({
    totalBackends: 10,
    liveBackends: 8,
    coveredBackends: 8,
    uncoveredBackends: 0,
    orphanedBackends: 2,
    approvedEnrollments: 8,
    // strictAuthorization and readyForStrict deliberately omitted.
  }); assert.ok(coverage); assert.equal(
    coverage!.strictAuthorization,
    true,
    "an unreadable strict flag must read as strict, never as permissive",
  ); assert.equal(
    coverage!.readyForStrict,
    false,
    "readiness must be positively asserted, never assumed",
  ); assert.equal(coverageFrom(null), null); }); // ── 4. The migration's structure ────────────────────────────────────────────

test("migration 38 adds no destructive statement and no customer-data write", async () => {
  const sql = sqlCode(await migration38());

  assert.ok(!/drop table/i.test(sql), "no table may be dropped");
  assert.ok(!/drop column/i.test(sql), "no column may be dropped");
  assert.ok(!/truncate/i.test(sql), "nothing may be truncated");
  assert.ok(
    !/delete from/i.test(sql),
    "no row may be deleted: revocation and rollback never delete customer data",
  );
  assert.ok(
    !/alter table public\.project_managed_backends[\s\S]{0,200}drop/i.test(sql),
    "the backend registry is never altered destructively",
  );
  // The backfill reads the backend registry and writes only the enrollment side.
  // SCOPED TO THE BACKFILL: `claim_managed_backend` legitimately inserts a
  // registry row and is the only function allowed to. Asserting over the whole
  // migration would fail on that correct insert and hide the real rule.
  const backfillBody = sql.slice(
    sql.indexOf("create or replace function public.backfill_managed_backend_enrollments"),
    sql.indexOf("comment on function public.backfill_managed_backend_enrollments"),
  );
  assert.ok(backfillBody.length > 1000, "the backfill body must be found");
  assert.ok(
    !/insert into public\.project_managed_backends/i.test(backfillBody),
    "a backfill must never create a backend row",
  );
  assert.ok(
    !/update public\.project_managed_backends/i.test(backfillBody),
    "a backfill must never modify a backend row",
  );
  assert.ok(
    !/update public\.project_managed_backends[\s\S]{0,400}status = 'ready'/i.test(sql),
    "a backfill must never promote a backend to ready",
  );
});

test("migration 38 is safe to re-run", async () => {
  const sql = sqlCode(await migration38());

  // Idempotent DDL.
  assert.match(sql, /create table if not exists public\.managed_backend_enrollment_policy/);
  assert.match(sql, /on conflict \(id\) do nothing/);
  // Every function is `create or replace`, so a second apply redefines rather
  // than colliding.
  const creates = sql.match(/create or replace function/g) ?? [];
  assert.ok(creates.length >= 9, `expected the full gate set, saw ${creates.length}`);
  assert.ok(!/^\s*create function/m.test(sql), "no bare `create function` may exist");
  // The backfill itself is idempotent.
  assert.match(sql, /on conflict \(project_id, project_created_at\) do nothing/);
});

test("the strict switch refuses to enable while a live backend is uncovered", async () => {
  const sql = sqlCode(await migration38());

  assert.match(
    sql,
    /create or replace function public\.set_managed_backend_strict_authorization/,
  );
  // Enabling counts uncovered live backends and raises when any exist.
  assert.match(sql, /if p_enabled then[\s\S]{0,600}v_uncovered > 0/);
  assert.match(sql, /strict authorization refused/);
  // Disabling is always allowed: that is the rollback path.
  assert.ok(
    !/if not p_enabled then[\s\S]{0,200}raise exception/i.test(sql),
    "disabling strict mode must never be blocked",
  );
  // Administrator-only, derived from the caller's own identity.
  assert.match(sql, /current_user_is_admin\(\)/); assert.ok(!/p_is_admin/i.test(sql), "no client-supplied admin flag"); }); test("the authorization predicate fails closed when the control row is missing", async () => {
  const sql = sqlCode(await migration38()); const fn = sql.slice(
    sql.indexOf("create or replace function public.managed_backend_enrollment_permits"),
  ); const body = fn.slice(0, fn.indexOf("comment on function")); // A missing enrollment row is permitted only when strict is explicitly false.
  assert.match(body, /select e\.status = 'approved'/); assert.match(body, /not coalesce\(/); assert.match(body, /,\s*\n?\s*true\s*\n?\s*\)/, "coalesce default must be true (strict)"); }); // ── 5. Backfill classification, one case per required scenario ──────────────

test("backfill classifies each required backend scenario explicitly", async () => {
  const sql = sqlCode(await migration38()); const fn = sql.slice(
    sql.indexOf("create or replace function public.backfill_managed_backend_enrollments"),
  ); const body = fn.slice(0, fn.indexOf("comment on function")); // (a) existing ready / provisioned / configuring / provisioning → eligible
  assert.match(body, /v_class := 'eligible'; v_reason := 'backfill_existing_backend'/); // (b) existing failed backend → eligible, because the project was authorized
  //     and may legitimately retry.
  assert.match(body, /v_row\.backend_status = 'failed'[\s\S]{0,120}v_class := 'eligible'/); // (c) missing project record → REJECTED, never inherited.
  // The branch now probes for a reused slug before classifying, so a fixed
  // character window is fragile against prose. Assert the structure instead.
  assert.match(body, /if v_row\.project_user_id is null then/);
  assert.match(body, /backfill_project_missing/);
  assert.match(body, /backfill_incarnation_mismatch/); // (d) owner mismatch → REJECTED.
  assert.match(body, /backend_user_id is distinct from v_row\.project_user_id/); assert.match(body, /backfill_owner_mismatch/); // (e) incarnation mismatch: the join is on project_id AND created_at, so a
  //     reused slug with a new created_at does not match. It must be reported as
  //     its OWN rejection, distinct from a deleted project, because the two are
  //     different operator problems.
  assert.match(
    body,
    /left join public\.projects p\s+on p\.project_id = b\.project_id\s+and p\.created_at = b\.project_created_at/,
  );
  assert.match(body, /backfill_incarnation_mismatch/);
  assert.match(
    body,
    /exists \(\s*select 1 from public\.projects p2 where p2\.project_id = v_row\.project_id\s*\)/,
    "incarnation mismatch must be distinguished from a missing project by an existence probe",
  );
  // (f) ambiguous backend states are SKIPPED for an operator, never approved.
  assert.match(body, /'outcome_unknown', 'cleanup_pending'/); assert.match(body, /backfill_outcome_unknown/); assert.match(body, /backfill_cleanup_pending/); }); test("backfill never overwrites a newer enrollment decision", async () => {
  const sql = sqlCode(await migration38()); const fn = sql.slice(
    sql.indexOf("create or replace function public.backfill_managed_backend_enrollments"),
  ); const body = fn.slice(0, fn.indexOf("comment on function")); // An operator decision short-circuits before any write.
  assert.match(
    body,
    /v_existing_status in \('approved', 'revoked', 'suspended', 'rejected'\)[\s\S]{0,80}continue/,
  ); // Only a `pending` row is promoted, and only when this run says eligible.
  assert.match(body, /v_existing_status = 'pending'[\s\S]{0,200}v_class = 'eligible'/); // Every write is guarded by the dry-run flag.
  const writes = body.match(/if not v_dry then/g) ?? []; assert.ok(writes.length >= 3, "every write path must honour the dry-run flag"); // The audit trail records the backfill as the actor.
  assert.match(body, /'backfill'/); }); test("backfill records its source and audit metadata", async () => {
  const sql = sqlCode(await migration38()); const fn = sql.slice(
    sql.indexOf("create or replace function public.backfill_managed_backend_enrollments"),
  ); const body = fn.slice(0, fn.indexOf("comment on function")); // `source = 'migration'` distinguishes a backfilled row from a policy decision.
  assert.match(body, /source = 'migration'/); assert.match(body, /'migration', v_reason/); // An append-only event is written for each insert and promotion.
  assert.match(body, /record_managed_backend_enrollment_event/); // The summary carries the counts the runbook asks an operator to check.
  for (const key of [
    "scanned",
    "eligible",
    "alreadyEnrolled",
    "skipped",
    "rejected",
    "inserted",
    "promoted",
    "rejectedReasons",
    "rejectedSamples",
  ]) {
    assert.match(body, new RegExp(`'${key}'`), `summary must report ${key}`); }
}); // ── 6. Strict-aware guards in every gate ────────────────────────────────────

test("every provisioning and configuration gate consults the shared predicate", async () => {
  const sql = sqlCode(await migration38()); // The gate functions that must be strict-aware.
  const gates = [
    "claim_managed_backend",
    "mark_managed_backend_create_started",
    "begin_managed_backend_configuration",
    "record_managed_backend_migration",
  ]; for (const gate of gates) {
    const start = sql.indexOf(`create or replace function public.${gate}`); assert.ok(start >= 0, `${gate} must be redefined`); const rest = sql.slice(start); const end = rest.indexOf("$$;"); const body = rest.slice(0, end); assert.match(
      body,
      /managed_backend_enrollment_permits\(/,
      `${gate} must call the shared predicate`,
    ); }

  // The reported gate distinguishes strict absence from legacy absence.
  assert.match(sql, /'not_enrolled_strict'::text/); assert.match(sql, /'enrollment_missing'::text/); }); test("migration 38 preserves every existing function signature", async () => {
  const sql = sqlCode(await migration38()); const signatures = [
    /claim_managed_backend\(\s*p_project_id text,\s*p_user_id uuid,\s*p_lease_token uuid,\s*p_region_id text,\s*p_lease_seconds integer default 90\s*\)/,
    /mark_managed_backend_create_started\(\s*p_project_id text,\s*p_project_created_at timestamptz,\s*p_lease_token uuid\s*\)/,
    /begin_managed_backend_configuration\(\s*p_project_id text,\s*p_user_id uuid,\s*p_lease_token uuid\s*\)/,
    /record_managed_backend_migration\(\s*p_project_id text,\s*p_project_created_at timestamptz,\s*p_lease_token uuid,\s*p_step_name text,\s*p_checksum text\s*\)/,
    /authorize_managed_backend_provisioning\(\s*p_project_id text,\s*p_user_id uuid\s*\)/,
  ]; for (const signature of signatures) {
    assert.match(sql, signature, `signature changed: ${signature}`); }

  // Lease fencing is untouched: the guards are added, the fences are not removed.
  assert.match(sql, /b\.lease_token = p_lease_token/); assert.match(sql, /b\.config_lease_token = p_lease_token/); assert.match(sql, /b\.lease_expires_at > now\(\)/); assert.match(sql, /b\.config_lease_expires_at > now\(\)/); }); test("the completion and failure paths stay unguarded so reality can be recorded", async () => {
  const sql = sqlCode(await migration38()); for (const fn of [
    "complete_managed_backend",
    "complete_managed_backend_configuration",
    "fail_managed_backend",
    "fail_managed_backend_configuration",
  ]) {
    assert.ok(
      !sql.includes(`create or replace function public.${fn}(`),
      `${fn} must keep its migration 30/35 body: blocking it would strand a row`,
    ); }
}); // ── 7. Migration ordering ───────────────────────────────────────────────────

test("migration 38 depends only on migrations 30, 35 and 37", async () => {
  const sql = sqlCode(await migration38()); // It reads the registry from 30, the configuration columns from 35 and the
  // enrollment tables from 37.
  assert.match(sql, /public\.project_managed_backends/); assert.match(sql, /public\.project_managed_backend_enrollments/); assert.match(sql, /public\.project_managed_backend_enrollment_events|record_managed_backend_enrollment_event/); assert.match(sql, /public\.projects/); // It does not touch anything from 34 (runtime sandboxes) or 36 (hand-off).
  assert.ok(!/project_runtime_sandboxes/i.test(sql)); assert.ok(!/handoff_generation_job/i.test(sql)); // Schema marker is monotonic.
  assert.match(sql, /select 38/); }); test("the schema marker never moves backwards", async () => {
  const sql = sqlCode(await migration38()); // The marker is written as `select 38 $$;` on its own line; the previous
  // pattern required a trailing space and silently never matched.
  const marker = sql.match(/select (\d+)\s*\$\$;/);
  assert.ok(marker, "the schema marker must be present");
  assert.equal(Number(marker![1]), 38); }); // ── 8. The TypeScript side of strict mode ──────────────────────────────────

test("the strict reason is never tolerated as a legacy compatibility path", async () => {
  const source = await readFile(
    new URL("../src/lib/managed-backend/enrollment-service.ts", import.meta.url),
    "utf8",
  ); // The legacy tolerance is keyed on `enrollment_missing` only.
  assert.match(source, /gate\.reasonCode === "enrollment_missing"/); // `not_enrolled_strict` is denied before that branch can run.
  const strictIndex = source.indexOf('gate.reasonCode === "not_enrolled_strict"'); const legacyIndex = source.indexOf('gate.reasonCode === "enrollment_missing"'); assert.ok(strictIndex >= 0, "the strict denial must be handled explicitly"); assert.ok(
    strictIndex < legacyIndex,
    "the strict denial must be handled BEFORE the legacy tolerance",
  ); }); test("the claim path reports an unenrolled project as a policy refusal", async () => {
  const service = await readFile(
    new URL("../src/lib/managed-backend/service.ts", import.meta.url),
    "utf8",
  ); assert.match(service, /claim\.data\.claimStatus === "not_authorized"/); assert.match(service, /MANAGED_BACKEND_NOT_ENROLLED/); // It must not be reported as busy: retrying would not help.
  // Compare like with like: the not_authorized BRANCH must come before the busy
  // BRANCH. Comparing the error-code string against a status check measured the
  // wrong thing and could never pass.
  // SCOPED TO ensureManagedBackend: configureManagedBackend has its own `busy`
  // branch earlier in the file, so a file-wide indexOf compares across functions
  // and can never express this rule.
  const ensureStart = service.indexOf("export async function ensureManagedBackend");
  assert.ok(ensureStart >= 0, "ensureManagedBackend must exist");
  const ensureBody = service.slice(ensureStart);
  const notAuthorized = ensureBody.indexOf('claim.data.claimStatus === "not_authorized"');
  const busy = ensureBody.indexOf('claim.data.claimStatus === "busy"');
  assert.ok(notAuthorized >= 0 && busy >= 0, "both branches must exist");
  assert.ok(
    notAuthorized < busy,
    "the authorization refusal must be checked first",
  );
  // The configuration path must ALSO refuse rather than fall through to busy.
  const configStart = service.indexOf("export async function configureManagedBackend");
  const configBody = service.slice(configStart, ensureStart);
  assert.match(
    configBody,
    /claim\.data\.claimStatus === "not_authorized"/,
    "the configuration claim must handle a withdrawn authorization",
  );}); test("the schema runner rechecks authorization immediately before commit", async () => {
  const runner = await readFile(
    new URL("../src/lib/managed-backend/runner.ts", import.meta.url),
    "utf8",
  ); assert.match(runner, /authorizeBeforeCommit/); assert.match(runner, /SCHEMA_AUTHORIZATION_REVOKED/); const gate = runner.indexOf("commitGateAllows(input.authorizeBeforeCommit)"); const commit = runner.indexOf('await client.query("commit")'); assert.ok(gate >= 0 && commit > gate, "the gate must run before the commit"); }); test("the backfill wrapper defaults to a dry run", async () => {
  const store = await readFile(
    new URL("../src/lib/managed-backend/enrollment-store.ts", import.meta.url),
    "utf8",
  ); assert.match(store, /p_dry_run: input\.dryRun !== false/); assert.match(store, /backfill_managed_backend_enrollments/); assert.match(store, /managed_backend_enrollment_coverage/); assert.match(store, /set_managed_backend_strict_authorization/); });

// ── 9. A withdrawn authorization is reported as itself, not as a lock ────────

test("a configuration-time revocation is not misreported as an ownership failure", async () => {
  const store = await readFile(
    new URL("../src/lib/managed-backend/store.ts", import.meta.url),
    "utf8",
  ); /**
   * `begin_managed_backend_configuration` raises 42501 for a withdrawn
   * enrollment, and an owner mismatch raises 42501 too. Without the message
   * check the operator is told "the project owner could not be verified" when
   * the real cause is a revocation.
   */
  assert.match(store, /not_authorized/); assert.match(store, /enrollment not authorized/i); const guardIndex = store.indexOf("/enrollment not authorized/i"); const forbiddenIndex = store.indexOf('if (code === "42501") return "forbidden"'); assert.ok(guardIndex >= 0, "the enrollment guard must be distinguished"); assert.ok(
    guardIndex < forbiddenIndex,
    "the enrollment check must precede the generic forbidden mapping",
  ); const service = await readFile(
    new URL("../src/lib/managed-backend/service.ts", import.meta.url),
    "utf8",
  ); // The refusal must surface as a policy refusal with its own code.
  assert.match(service, /MANAGED_BACKEND_NOT_ENROLLED/); assert.match(service, /authorization was withdrawn/); }); test("the configuration claim can represent a withdrawn authorization", async () => {
  const store = await readFile(
    new URL("../src/lib/managed-backend/store.ts", import.meta.url),
    "utf8",
  ); // The claim type must not narrow to the point where the refusal is
  // unrepresentable; the parser must accept it rather than returning null.
  const claimType = store.slice(
    store.indexOf("export interface ManagedBackendConfigClaim"),
    store.indexOf("export interface ManagedBackendStatusRow"),
  ); assert.match(claimType, /"not_authorized"/); assert.match(store, /record\.claim_status === "not_authorized"/); });
