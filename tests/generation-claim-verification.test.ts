import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isProjectInCohort,
  isWorkerSchemaReady,
  parseClaimResult,
  verifyClaimedProject,
  type ClaimedGenerationJob,
} from "../src/lib/generation/verification";

/**
 * The worker runs with a service-role client, so this pure module is the second
 * wall around its claim. These tests prove that a malformed, foreign or
 * non-worker claim is refused before any file is touched.
 */

const RUN_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const LEASE = "33333333-3333-3333-3333-333333333333";
const TRACE = "a".repeat(32);

function claim(overrides: {
  run?: Record<string, unknown>;
  user_id?: unknown;
} = {}): Record<string, unknown> {
  return {
    status: "claimed",
    user_id: USER_ID,
    lease_seconds: 420,
    ...overrides,
    run: {
      id: RUN_ID,
      project_id: "my-project",
      lease_token: LEASE,
      trace_id: TRACE,
      prompt: "build a small site",
      model: "deepseek/deepseek-v4.1-flash",
      stage: "validating",
      dispatch_mode: "worker",
      finished_at: null,
      job_attempt: 1,
      max_job_attempts: 3,
      enqueued_at: "2026-10-26T00:00:00.000Z",
      claimed_at: "2026-10-26T00:00:01.000Z",
      lease_expires_at: "2026-10-26T00:07:01.000Z",
      generation_manifest: null,
      ...overrides.run,
    },
  };
}

function invalidReason(raw: unknown): string | undefined {
  const parsed = parseClaimResult(raw);
  return parsed.status === "invalid" ? parsed.reason : undefined;
}

// ── Claim parsing ──────────────────────────────────────────────────────────

test("an empty queue and a dead letter are distinct, non-error answers", () => {
  assert.deepEqual(parseClaimResult({ status: "empty" }), { status: "empty" });
  assert.deepEqual(parseClaimResult({ status: "dead_letter", reason: "attempts_exhausted" }), {
    status: "dead_letter",
    reason: "attempts_exhausted",
  });
  assert.deepEqual(parseClaimResult({ status: "dead_letter" }), {
    status: "dead_letter",
    reason: "unknown",
  });
});

test("a well-formed claim is accepted with its fencing data", () => {
  const parsed = parseClaimResult(claim());
  assert.equal(parsed.status, "claimed");
  if (parsed.status !== "claimed") return;
  const job: ClaimedGenerationJob = parsed.job;
  assert.equal(job.runId, RUN_ID);
  assert.equal(job.projectId, "my-project");
  assert.equal(job.userId, USER_ID);
  assert.equal(job.leaseToken, LEASE);
  assert.equal(job.traceId, TRACE);
  assert.equal(job.jobAttempt, 1);
  assert.equal(job.maxAttempts, 3);
  assert.equal(job.stage, "validating");
  assert.equal(job.prompt, "build a small site");
});

test("anything that is not a claim is refused rather than guessed", () => {
  assert.equal(invalidReason(null), "not_an_object");
  assert.equal(invalidReason("claimed"), "not_an_object");
  assert.equal(invalidReason([]), "not_an_object");
  assert.equal(invalidReason({ status: "weird" }), "unknown_status");
  assert.equal(invalidReason({ status: "claimed" }), "missing_run");
});

test("run identifiers and the fingerprint must be real", () => {
  assert.equal(invalidReason(claim({ run: { id: "not-a-uuid" } })), "invalid_run_id");
  assert.equal(
    invalidReason(claim({ run: { project_id: "../escape" } })),
    "invalid_project_id",
  );
  assert.equal(invalidReason(claim({ user_id: "someone" })), "invalid_user_id");
  assert.equal(invalidReason(claim({ run: { lease_token: "lease" } })), "invalid_lease_token");
  assert.equal(invalidReason(claim({ run: { trace_id: "trace" } })), "invalid_trace_id");
});

test("a claim must be at the validating stage and dispatched to the worker", () => {
  assert.equal(invalidReason(claim({ run: { stage: "generating" } })), "not_claimed_stage");
  assert.equal(invalidReason(claim({ run: { stage: "completed" } })), "not_claimed_stage");
  assert.equal(
    invalidReason(claim({ run: { dispatch_mode: "inline" } })),
    "not_worker_dispatched",
  );
  assert.equal(
    invalidReason(claim({ run: { finished_at: "2026-10-26T00:00:00.000Z" } })),
    "already_finished",
  );
});

test("a missing or oversized prompt is refused", () => {
  assert.equal(invalidReason(claim({ run: { prompt: "" } })), "invalid_prompt");
  assert.equal(invalidReason(claim({ run: { prompt: undefined } })), "invalid_prompt");
  assert.equal(invalidReason(claim({ run: { prompt: "x".repeat(32_001) } })), "invalid_prompt");
});

test("the attempt budget is checked before the job runs", () => {
  assert.equal(invalidReason(claim({ run: { job_attempt: 0 } })), "invalid_job_attempt");
  assert.equal(invalidReason(claim({ run: { job_attempt: "1" } })), "invalid_job_attempt");
  assert.equal(invalidReason(claim({ run: { max_job_attempts: 11 } })), "invalid_max_attempts");
  assert.equal(invalidReason(claim({ run: { max_job_attempts: 0 } })), "invalid_max_attempts");
  assert.equal(
    invalidReason(claim({ run: { job_attempt: 4, max_job_attempts: 3 } })),
    "attempt_budget_exceeded",
  );
});

// ── Ownership and cohort ───────────────────────────────────────────────────

test("the worker re-checks the owner and the configured cohort", () => {
  const job = { projectId: "my-project", userId: USER_ID };
  assert.deepEqual(
    verifyClaimedProject({ job, ownerId: USER_ID, cohort: ["my-project"] }),
    { ok: true },
  );
  assert.deepEqual(
    verifyClaimedProject({ job, ownerId: "99999999-9999-9999-9999-999999999999", cohort: ["my-project"] }),
    { ok: false, reason: "owner_mismatch" },
  );
  assert.deepEqual(verifyClaimedProject({ job, ownerId: null, cohort: ["my-project"] }), {
    ok: false,
    reason: "owner_mismatch",
  });
  assert.deepEqual(verifyClaimedProject({ job, ownerId: USER_ID, cohort: ["other-project"] }), {
    ok: false,
    reason: "not_in_cohort",
  });
});

test("cohort comparison is case-insensitive and does not prefix-match", () => {
  assert.equal(isProjectInCohort("my-project", ["my-project"]), true);
  assert.equal(isProjectInCohort("MY-PROJECT", ["my-project"]), true);
  assert.equal(isProjectInCohort("my-project", ["my-project-2"]), false);
  assert.equal(isProjectInCohort("my-project", []), false);
});

// ── Schema preflight ───────────────────────────────────────────────────────

test("the worker refuses to run before migration 32 is present", () => {
  assert.equal(isWorkerSchemaReady(32), true);
  assert.equal(isWorkerSchemaReady(33), true);
  assert.equal(isWorkerSchemaReady("32"), true);
  assert.equal(isWorkerSchemaReady(31), false);
  assert.equal(isWorkerSchemaReady(16), false);
  assert.equal(isWorkerSchemaReady(16.5), false);
  assert.equal(isWorkerSchemaReady(null), false);
  assert.equal(isWorkerSchemaReady("abc"), false);
});
