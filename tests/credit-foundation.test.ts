import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  creditsConfig,
  creditAdmissionForProject,
  creditCostForProject,
  creditsProblemMessage,
} from "../src/lib/credits/config";
import {
  canReleaseReservation,
  canSettleReservation,
  creditBalance,
  creditNumber,
  insufficientCreditsFrom,
  needsFreshReservation,
  shouldChargeRun,
} from "../src/lib/credits/state";
import { mapCreditsError, normalizeReservation } from "../src/lib/credits/store";
import { roleModelStatus } from "../src/lib/ai/model-roles";

const CREDIT_SQL = readFileSync(
  new URL("../supabase/migrations/31_credit_foundation.sql", import.meta.url),
  "utf8",
);
const CREDIT_RELIABILITY_SQL = readFileSync(
  new URL("../supabase/migrations/32_credit_reliability_hardening.sql", import.meta.url),
  "utf8",
);
const GENERATION_SQL = readFileSync(
  new URL("../supabase/migrations/16_durable_generation_worker.sql", import.meta.url),
  "utf8",
);
const API = readFileSync(new URL("../src/lib/mavly/api.ts", import.meta.url), "utf8");
const RUN_AGENT = readFileSync(new URL("../src/lib/mavly/run-agent.ts", import.meta.url), "utf8");
const WORKER = readFileSync(new URL("../src/lib/generation/worker.ts", import.meta.url), "utf8");
const ENGINE = readFileSync(new URL("../src/lib/orchestration/engine.ts", import.meta.url), "utf8");
const CREDIT_SERVICE = readFileSync(new URL("../src/lib/credits/service.ts", import.meta.url), "utf8");
const WORKSPACE = readFileSync(
  new URL("../src/app/project/[projectId]/page.tsx", import.meta.url),
  "utf8",
);

const VALID_ENV = {
  MAVLY_CREDITS_ENABLED: "1",
  MAVLY_CREDITS_PROJECTS: "my-app,other-app",
  MAVLY_CREDITS_GENERATION_COST: "7",
};

// ── Configuration ───────────────────────────────────────────────────────────

test("credits are off unless every prerequisite is valid", () => {
  const disabled = creditsConfig({});
  assert.equal(disabled.requested, false);
  assert.equal(disabled.ready, false);
  assert.equal(disabled.generationCost, null);
  assert.deepEqual(disabled.problems, ["disabled"]);
  assert.match(creditsProblemMessage("disabled"), /disabled/i);

  const flagOnly = creditsConfig({ MAVLY_CREDITS_ENABLED: "true" });
  assert.equal(flagOnly.requested, true);
  assert.equal(flagOnly.ready, false);
  assert.ok(flagOnly.problems.includes("missing_cohort"));
  assert.ok(flagOnly.problems.includes("missing_cost"));

  const wildcard = creditsConfig({
    MAVLY_CREDITS_ENABLED: "1",
    MAVLY_CREDITS_PROJECTS: "*",
    MAVLY_CREDITS_GENERATION_COST: "5",
  });
  assert.equal(wildcard.ready, false);
  assert.ok(wildcard.problems.includes("invalid_cohort"));
  assert.deepEqual(wildcard.cohort, ["*"]);

  for (const cost of ["0", "-1", "1.5", "abc", "100001"]) {
    const invalid = creditsConfig({
      MAVLY_CREDITS_ENABLED: "1",
      MAVLY_CREDITS_PROJECTS: "my-app",
      MAVLY_CREDITS_GENERATION_COST: cost,
    });
    assert.equal(invalid.ready, false, `cost ${cost} must be refused`);
    assert.ok(invalid.problems.includes("invalid_cost"));
  }

  const ready = creditsConfig(VALID_ENV);
  assert.equal(ready.requested, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.generationCost, 7);
  assert.deepEqual(ready.cohort, ["my-app", "other-app"]);
});

test("the generation charge is server-derived and cohort-scoped", () => {
  assert.equal(creditCostForProject("my-app", VALID_ENV), 7);
  assert.equal(creditCostForProject("MY-APP", VALID_ENV), 7);
  assert.equal(creditCostForProject("outside", VALID_ENV), null);
  assert.equal(creditCostForProject("my-app", {}), null);
  assert.equal(
    creditCostForProject("my-app", { ...VALID_ENV, MAVLY_CREDITS_GENERATION_COST: "0" }),
    null,
  );
  assert.deepEqual(
    creditAdmissionForProject("my-app", {
      ...VALID_ENV,
      MAVLY_CREDITS_GENERATION_COST: "0",
    }),
    { kind: "misconfigured", problem: "invalid_cost" },
  );
  assert.deepEqual(creditAdmissionForProject("outside", VALID_ENV), {
    kind: "outside_cohort",
  });
});

// ── Pure balance / lifecycle rules ──────────────────────────────────────────

test("an available balance is never fabricated from unknown or invalid values", () => {
  assert.deepEqual(creditBalance(10, 3), { balance: 10, reserved: 3, available: 7 });
  assert.deepEqual(creditBalance("10", "3"), { balance: 10, reserved: 3, available: 7 });
  assert.equal(creditBalance(3, 10), null, "holds cannot exceed the balance");
  assert.equal(creditBalance(-1, 0), null);
  assert.equal(creditBalance(1.5, 0), null);
  assert.equal(creditBalance(null, 0), null);
  assert.equal(creditBalance("nope", 0), null);

  assert.equal(creditNumber(0), 0);
  assert.equal(creditNumber("0"), 0);
  assert.equal(creditNumber(-5), null);
  assert.equal(creditNumber(Number.NaN), null);
});

test("only a proven successful completion settles a reservation", () => {
  const completed = { finishedAt: "2026-10-28T00:00:00.000Z", status: "done", stage: "completed" };
  assert.equal(canSettleReservation(completed, "reserved"), true);
  assert.equal(canSettleReservation({ ...completed, status: "error" }, "reserved"), false);
  assert.equal(canSettleReservation({ ...completed, stage: "failed" }, "reserved"), false);
  assert.equal(
    canSettleReservation({ finishedAt: null, status: "init", stage: "generating" }, "reserved"),
    false,
  );
  assert.equal(canSettleReservation(completed, "consumed"), false);
  assert.equal(canSettleReservation(completed, "released"), false);
  assert.equal(canSettleReservation(completed, null), false);
  assert.equal(shouldChargeRun("completed"), true);
  assert.equal(shouldChargeRun("failed"), false);
  assert.equal(shouldChargeRun("cancelled"), false);
});

test("only a terminal unsuccessful run releases its hold", () => {
  const failed = { finishedAt: "2026-10-28T00:00:00.000Z", status: "error", stage: "failed" };
  const cancelled = { ...failed, stage: "cancelled" };
  const interrupted = { ...failed, stage: "interrupted" };
  const completed = { ...failed, status: "done", stage: "completed" };
  const active = { finishedAt: null, status: "init", stage: "generating" };

  assert.equal(canReleaseReservation(failed, "reserved"), true);
  assert.equal(canReleaseReservation(cancelled, "reserved"), true);
  assert.equal(canReleaseReservation(interrupted, "reserved"), true);
  assert.equal(canReleaseReservation(completed, "reserved"), false);
  assert.equal(canReleaseReservation(active, "reserved"), false);
  assert.equal(canReleaseReservation(failed, "consumed"), false);

  assert.equal(needsFreshReservation(null), true);
  assert.equal(needsFreshReservation("released"), true);
  assert.equal(needsFreshReservation("reserved"), false);
  assert.equal(needsFreshReservation("consumed"), false);
});

test("an insufficient-credits refusal keeps unknown values unknown", () => {
  assert.deepEqual(insufficientCreditsFrom(3, 10), { available: 3, required: 10 });
  assert.deepEqual(insufficientCreditsFrom("3", "10"), { available: 3, required: 10 });
  assert.deepEqual(insufficientCreditsFrom(null, undefined), { available: null, required: null });
});

// ── RPC error mapping ───────────────────────────────────────────────────────

test("credit RPC failures are mapped, never guessed", () => {
  assert.equal(
    mapCreditsError({
      message: "Could not find the function public.create_generation_job_with_credits",
      code: "PGRST202",
    }).code,
    "MIGRATION_REQUIRED",
  );
  assert.equal(mapCreditsError({ message: "UNAUTHENTICATED", code: "28000" }).code, "UNAUTHENTICATED");
  assert.equal(mapCreditsError({ message: "FORBIDDEN", code: "42501" }).code, "FORBIDDEN");
  assert.equal(
    mapCreditsError({ message: "PROVIDER_ATTEMPT_ID_CONFLICT", code: "22000" }).code,
    "CONFLICT",
  );

  const insufficient = mapCreditsError({
    message: "INSUFFICIENT_CREDITS",
    details: '{"available": 3, "required": 10}',
  });
  assert.equal(insufficient.code, "INSUFFICIENT_CREDITS");
  assert.equal(insufficient.available, 3);
  assert.equal(insufficient.required, 10);

  assert.equal(
    mapCreditsError({ message: "IDEMPOTENCY_CONFLICT", code: "22000" }).code,
    "CONFLICT",
  );
  assert.equal(
    mapCreditsError({ message: "INVALID_CREDIT_AMOUNT", code: "22023" }).code,
    "INVALID",
  );
  assert.equal(
    mapCreditsError({ message: "CREDIT_ACCOUNT_INCONSISTENT", code: "P0001" }).code,
    "UNKNOWN",
  );
});

test("a reservation row is read strictly and never defaults to a fake amount", () => {
  const reservation = normalizeReservation({
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    project_id: "my-app",
    run_id: "33333333-3333-4333-8333-333333333333",
    amount_credits: 7,
    consumed_credits: 0,
    released_credits: 0,
    refunded_credits: 0,
    status: "reserved",
    created_at: "2026-10-28T00:00:00.000Z",
    settled_at: null,
  });
  assert.equal(reservation?.amount, 7);
  assert.equal(reservation?.status, "reserved");

  assert.equal(normalizeReservation({ ...reservation, status: "unknown" }), null);
  assert.equal(normalizeReservation({ ...reservation, amount_credits: "x" }), null);
  assert.equal(normalizeReservation(null), null);
});

// ── Migration 31 contracts ──────────────────────────────────────────────────

test("migration 31 is additive and introduces no destructive statement", () => {
  assert.equal(/drop table/i.test(CREDIT_SQL), false);
  assert.equal(/delete from/i.test(CREDIT_SQL), false);
  assert.equal(/truncate/i.test(CREDIT_SQL), false);
  assert.match(CREDIT_SQL, /select 31;/);
  for (const table of [
    "credit_accounts",
    "credit_project_policies",
    "credit_reservations",
    "credit_ledger",
    "ai_cost_rates",
    "ai_usage_attempts",
  ]) {
    assert.match(CREDIT_SQL, new RegExp(`create table if not exists public\\.${table}`));
  }
});

test("migration 32 is additive and every SECURITY DEFINER function pins its search path", () => {
  assert.equal(/drop table/i.test(CREDIT_RELIABILITY_SQL), false);
  assert.equal(/delete from/i.test(CREDIT_RELIABILITY_SQL), false);
  assert.equal(/truncate/i.test(CREDIT_RELIABILITY_SQL), false);
  assert.match(CREDIT_RELIABILITY_SQL, /select 32;/);

  const functions = Array.from(
    CREDIT_RELIABILITY_SQL.matchAll(
      /create or replace function public\.([^(]+)\([\s\S]*?\n\$\$;/g,
    ),
  );
  const securityDefiners = functions.filter((match) =>
    /\bsecurity definer\b/i.test(match[0]),
  );
  assert.ok(securityDefiners.length > 0, "migration should define privileged functions");
  for (const match of securityDefiners) {
    assert.match(
      match[0],
      /set search_path = public, pg_temp/i,
      `${match[1]} must pin its search_path`,
    );
  }
});

test("the ledger is append-only and uniquely keyed per account", () => {
  assert.match(
    CREDIT_SQL,
    /create trigger credit_ledger_immutable[\s\S]*?before update or delete on public\.credit_ledger/,
  );
  assert.match(CREDIT_SQL, /CREDIT_LEDGER_APPEND_ONLY/);
  assert.match(
    CREDIT_SQL,
    /constraint credit_ledger_user_key_unique unique \(user_id, idempotency_key\)/,
  );
  assert.match(
    CREDIT_SQL,
    /constraint credit_reservations_user_key_unique unique \(user_id, idempotency_key\)/,
  );
});

test("one live reservation per run is database-enforced", () => {
  assert.match(
    CREDIT_SQL,
    /create unique index if not exists credit_reservations_live_run_idx\s+on public\.credit_reservations \(run_id\)\s+where status = 'reserved'/,
  );
  assert.match(CREDIT_SQL, /for update/);
});

test("credit admission serializes competing spends and uses the database account lock", () => {
  assert.match(GENERATION_SQL, /pg_advisory_xact_lock\(hashtext\('mavly:create_generation_job'\)\)/);
  const accountLockBody = CREDIT_SQL.slice(
    CREDIT_SQL.indexOf("create or replace function public.lock_credit_account"),
    CREDIT_SQL.indexOf("create or replace function public.ai_estimate_cost_usd"),
  );
  assert.match(accountLockBody, /on conflict \(user_id\) do nothing/);
  assert.match(accountLockBody, /where user_id = p_user_id\s+for update/);
});

test("account and reservation invariants are check constraints", () => {
  assert.match(CREDIT_SQL, /check \(balance_credits >= 0\)/);
  assert.match(CREDIT_SQL, /check \(reserved_credits >= 0\)/);
  assert.match(CREDIT_SQL, /check \(reserved_credits <= balance_credits\)/);
  assert.match(CREDIT_SQL, /credit_reservations_status_consistent/);
  assert.match(CREDIT_SQL, /refunded_credits = 0 or status = 'consumed'/);
});

test("credits use exact integers and USD uses numeric, never floating point", () => {
  assert.match(CREDIT_SQL, /balance_credits bigint/);
  assert.match(CREDIT_SQL, /amount_credits bigint/);
  assert.match(CREDIT_SQL, /estimated_cost_usd numeric\(20, 9\)/);
  assert.match(CREDIT_SQL, /actual_cost_usd numeric\(20, 9\)/);
  const ddl = CREDIT_SQL.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.equal(/\breal\b|\bdouble precision\b|\bfloat\b/i.test(ddl), false);
});

test("admission and the hold commit in one transaction and insufficiency aborts it", () => {
  assert.match(
    CREDIT_SQL,
    /v_result := public\.create_generation_job\([\s\S]*?if v_available < v_amount then[\s\S]*?raise exception 'INSUFFICIENT_CREDITS'/,
  );
  assert.match(CREDIT_SQL, /create_generation_job_with_credits/);
  assert.match(CREDIT_SQL, /idempotency_key_reused/);
  assert.match(CREDIT_SQL, /v_run\.model is distinct from p_model/);
});

test("settlement and release are terminal-state guarded", () => {
  assert.match(CREDIT_SQL, /run_not_completed/);
  assert.match(CREDIT_SQL, /if v_run\.finished_at is null or v_run\.status = 'done' then/);
  assert.match(CREDIT_SQL, /run_not_failed/);
  assert.match(CREDIT_SQL, /no_live_reservation/);
});

test("duplicate settlement, release, and refunds cannot apply accounting twice", () => {
  const settleBody = CREDIT_SQL.slice(
    CREDIT_SQL.indexOf("create or replace function public.settle_generation_reservation"),
    CREDIT_SQL.indexOf("create or replace function public.release_generation_reservation"),
  );
  assert.match(settleBody, /status = 'reserved'[\s\S]*?for update/);
  assert.match(settleBody, /'status', 'noop', 'reason', 'no_live_reservation'/);
  assert.match(settleBody, /'generation_consumed'/);
  assert.match(settleBody, /'settle:' \|\| v_reservation\.id::text/);

  const releaseBody = CREDIT_SQL.slice(
    CREDIT_SQL.indexOf("create or replace function public.release_generation_reservation"),
    CREDIT_SQL.indexOf("create or replace function public.finish_credit_generation_run"),
  );
  assert.match(releaseBody, /status = 'reserved'[\s\S]*?for update/);
  assert.match(releaseBody, /'generation_released'/);
  assert.match(releaseBody, /'release:' \|\| v_reservation\.id::text/);

  const refundBody = CREDIT_SQL.slice(
    CREDIT_SQL.indexOf("create or replace function public.refund_generation_reservation"),
    CREDIT_SQL.indexOf("create or replace function public.get_credit_account"),
  );
  assert.match(refundBody, /status = 'consumed'[\s\S]*?for update/);
  assert.match(refundBody, /'refund:' \|\| v_reservation\.id::text \|\| ':amount:' \|\| v_amount::text/);
  assert.match(refundBody, /v_existing\.amount_credits is distinct from v_amount/);
  assert.match(refundBody, /'generation_refunded'/);
});

test("privileged credit operations are service-role-only", () => {
  for (const fn of [
    "grant_credits",
    "refund_generation_reservation",
    "create_generation_job_with_credits",
    "resume_generation_job_with_credits",
    "release_generation_reservation",
    "finish_credit_generation_run",
    "record_ai_usage_attempt",
    "maintain_credit_reservations",
    "release_orphaned_credit_reservations",
  ]) {
    assert.match(
      CREDIT_SQL,
      new RegExp(
        `revoke all on function public\\.${fn}\\([\\s\\S]*?\\) from authenticated;[\\s\\S]*?grant execute on function public\\.${fn}\\([\\s\\S]*?\\) to service_role;`,
      ),
      `${fn} must not be executable by an authenticated caller`,
    );
  }
  assert.equal(/grant execute on function public\.grant_credits\([^)]*\) to authenticated/.test(CREDIT_SQL), false);
});

test("every SECURITY DEFINER credit function pins search_path and revokes PUBLIC execution", () => {
  const starts = [...CREDIT_SQL.matchAll(/create or replace function public\.([a-z0-9_]+)\(/gi)];
  const secured = starts.filter((match, index) => {
    const start = match.index ?? 0;
    const next = starts[index + 1]?.index ?? CREDIT_SQL.length;
    const definition = CREDIT_SQL.slice(start, next);
    return /security definer/i.test(definition.slice(0, definition.indexOf("as $$")));
  });
  assert.ok(secured.length > 0);
  for (const match of secured) {
    const start = match.index ?? 0;
    const next = starts[starts.indexOf(match) + 1]?.index ?? CREDIT_SQL.length;
    const definition = CREDIT_SQL.slice(start, next);
    const header = definition.slice(0, definition.indexOf("as $$"));
    assert.match(header, /set search_path = public, pg_temp/i, `${match[1]} must pin search_path`);
    assert.match(
      definition,
      new RegExp(`revoke all on function public\\.${match[1]}\\(`, "i"),
      `${match[1]} must revoke default PUBLIC execution`,
    );
  }
});

test("the database policy blocks direct legacy admission on credited projects", () => {
  assert.match(
    CREDIT_SQL,
    /grant select, insert, update, delete on public\.credit_project_policies to service_role/,
  );
  assert.match(
    CREDIT_SQL,
    /revoke all on public\.credit_project_policies from public, anon, authenticated/,
  );
  assert.match(CREDIT_SQL, /create trigger project_runs_credit_state_guard/);
  assert.match(CREDIT_SQL, /CREDIT_POLICY_PROJECT_IMMUTABLE/);
  assert.match(CREDIT_SQL, /CREDIT_POLICY_RESERVATION_MISMATCH/);
  assert.match(
    CREDIT_SQL,
    /create or replace function public\.guard_credit_project_policy\(\)[\s\S]*?pg_advisory_xact_lock\(\s*hashtext\('mavly:credit-policy'\),\s*hashtext\(/,
  );
  assert.match(
    CREDIT_SQL,
    /create or replace function public\.guard_credit_project_run_state\(\)[\s\S]*?pg_advisory_xact_lock\(\s*hashtext\('mavly:credit-policy'\),\s*hashtext\(new\.project_id\)/,
  );
  assert.match(CREDIT_SQL, /raise exception 'CREDIT_RUN_STATE_SERVER_ONLY'/);
  assert.match(CREDIT_SQL, /new\.dispatch_mode is distinct from 'worker'/);
  assert.match(
    CREDIT_SQL,
    /current_setting\('mavly\.credit_admission_project_id', true\)\s+is distinct from new\.project_id/,
  );
  assert.match(
    CREDIT_SQL,
    /current_setting\('mavly\.credit_resume_project_id', true\)\s+is not distinct from new\.project_id/,
  );

  const admissionBody = CREDIT_SQL.slice(
    CREDIT_SQL.indexOf("create or replace function public.create_generation_job_with_credits"),
    CREDIT_SQL.indexOf("create or replace function public.settle_generation_reservation"),
  );
  assert.match(admissionBody, /set_config\('mavly\.credit_admission_project_id', p_project_id, true\)/);
  assert.match(admissionBody, /p_amount_credits is distinct from v_policy\.generation_cost_credits/);
  assert.match(
    admissionBody,
    /pg_advisory_xact_lock\(\s*hashtext\('mavly:credit-policy'\),\s*hashtext\(p_project_id\)\s*\)[\s\S]*?select \* into v_policy/,
  );
  assert.doesNotMatch(admissionBody, /for share/);

  const resumeBody = CREDIT_SQL.slice(
    CREDIT_SQL.indexOf("create or replace function public.resume_generation_job_with_credits"),
  );
  assert.match(
    resumeBody,
    /pg_advisory_xact_lock\(\s*hashtext\('mavly:credit-policy'\),\s*hashtext\(p_project_id\)\s*\)[\s\S]*?select \* into v_policy/,
  );
  assert.match(resumeBody, /set_config\('mavly\.credit_resume_project_id', p_project_id, true\)/);
  assert.match(
    CREDIT_SQL,
    /revoke all on function public\.create_generation_job\(text, text, text, text, text\) from public;[\s\S]*?grant execute on function public\.create_generation_job\(text, text, text, text, text\) to service_role;/,
  );
});

test("unknown provider costs stay explicitly unknown", () => {
  assert.match(CREDIT_SQL, /usage_source in \('provider', 'unavailable'\)/);
  assert.match(CREDIT_SQL, /cost_source in \('provider_reported', 'rate_card', 'unavailable'\)/);
  assert.match(CREDIT_SQL, /reconciliation_status in \('reconciled', 'unreconciled', 'uncertain', 'unavailable'\)/);
  assert.match(CREDIT_SQL, /v_uncertain := v_error in \('TIMEOUT', 'NETWORK'\)/);
  assert.match(CREDIT_SQL, /return query select null::numeric, null::text/);
});

test("the credit-aware resume re-holds only after a release", () => {
  assert.match(CREDIT_SQL, /resume_generation_job_with_credits/);
  // A duplicate resume of an ACTIVE run is refused without charging again.
  assert.match(
    CREDIT_SQL,
    /if v_run\.finished_at is null then[\s\S]*?'status', 'not_resumable', 'reason', 'run_active'/,
  );
  // A terminal run's unreleased hold is closed BEFORE the second hold is taken,
  // which is what the one-live-hold-per-run index requires.
  const resumeBody = CREDIT_SQL.slice(
    CREDIT_SQL.indexOf("create or replace function public.resume_generation_job_with_credits"),
  );
  const releaseAt = resumeBody.indexOf("public.release_generation_reservation(");
  const secondHoldAt = resumeBody.indexOf("insert into public.credit_reservations");
  assert.ok(releaseAt > -1, "the resume must release a stranded hold");
  assert.ok(secondHoldAt > releaseAt, "the release must precede the new hold");
  assert.match(API, /resumeGenerationJobWithCredits/);
  assert.match(API, /creditCost/);
});

test("a hold whose run was deleted can still be released", () => {
  assert.match(CREDIT_SQL, /release_orphaned_credit_reservations/);
  assert.match(CREDIT_SQL, /not exists \(\s*select 1 from public\.project_runs r where r\.id = res\.run_id\s*\)/);
  assert.match(CREDIT_SQL, /if exists \(select 1 from public\.project_runs r where r\.id = v_res\.run_id\) then/);
  assert.match(CREDIT_SQL, /interval '1 hour'/);
  // The worker tick runs it before settling, and the launch path releases the
  // hold itself before it deletes a project.
  assert.match(CREDIT_SQL, /v_orphans := public\.release_orphaned_credit_reservations\(v_limit\)/);
  assert.match(API, /await releaseRunCredits\(\{ runId: run\.id/);
});

// ── Pipeline wiring ─────────────────────────────────────────────────────────

test("the launch path refuses insufficient credits before any run exists", () => {
  assert.match(API, /createGenerationJobWithCredits/);
  assert.match(API, /402,\s*\n\s*"INSUFFICIENT_CREDITS"/);
  assert.match(API, /Nothing was charged and no run was created/);
  assert.match(API, /creditCostForProject\(created\.data\.project_id\)/);
});

test("chat retries reuse a persisted request identity until the server accepts the run", () => {
  assert.match(WORKSPACE, /agentStartRequestFingerprint\(requestPayload\)/);
  assert.match(WORKSPACE, /pendingAgentStartRequestRef/);
  assert.match(WORKSPACE, /sessionStorage\.getItem\(agentStartRequestStorageKey\(projectId\)\)/);
  assert.match(WORKSPACE, /sessionStorage\.setItem\([\s\S]*?JSON\.stringify\(pendingStart\)/);
  assert.match(WORKSPACE, /clientRequestId: pendingStart\.clientRequestId/);
  assert.match(WORKSPACE, /JSON\.stringify\(\{ \.\.\.pendingStart, accepted: true \}\)/);

  const sendBody = WORKSPACE.slice(
    WORKSPACE.indexOf("const sendPromptText = useCallback"),
    WORKSPACE.indexOf("const handleSendPrompt"),
  );
  assert.match(sendBody, /if \(res\.ok\) \{\s*pendingAgentStartRequestRef\.current = null/);
  assert.doesNotMatch(sendBody.slice(sendBody.indexOf("} else {")), /pendingAgentStartRequestRef\.current = null/);
});

test("a retried launch returns the same run instead of a conflict", () => {
  // The creation key is passed for any project type, so a retry resolves to the
  // SAME project and therefore to the SAME run key.
  assert.match(API, /creationRequestId \? creationRequestId : undefined/);
  assert.match(API, /const mayReuseExistingProject = creationRequestId\.length > 0;/);

  const existingBlock = API.slice(
    API.indexOf('if (admission.status === "existing")'),
    API.indexOf("const run = admission.run;"),
  );
  assert.match(existingBlock, /agent: \{ started: true/);
  assert.doesNotMatch(existingBlock, /deleteProject/);
  assert.doesNotMatch(existingBlock, /"CONFLICT"/);
  assert.doesNotMatch(existingBlock, /fail\(409/);

  // A keyed launch never deletes a project it may not have created.
  const keyedDeletes = API.match(/if \(!mayReuseExistingProject\) await deleteProject/g) ?? [];
  assert.ok(keyedDeletes.length >= 4, "every failure path is guarded by the keyed-launch rule");
  assert.equal(/projectType !== "android"\) await deleteProject/.test(API), false);
});

test("settlement follows the terminal run write, not the reverse", () => {
  const completeBlock = RUN_AGENT.slice(RUN_AGENT.indexOf("if (!finished)"));
  assert.ok(completeBlock.indexOf("settleRunCredits") > -1);
  assert.match(RUN_AGENT, /await settleRunCredits\(/);
  assert.match(RUN_AGENT, /await releaseRunCredits\(/);
  assert.match(RUN_AGENT, /await recordRunUsage\(/);
  assert.match(API, /releaseRunCredits\(/);
  assert.match(WORKER, /maintainCreditsForWorker\(/);
  assert.match(CREDIT_RELIABILITY_SQL, /create trigger project_runs_credit_terminal_settlement/);
  assert.match(CREDIT_RELIABILITY_SQL, /settle_generation_reservation\(new\.id\)/);
  assert.match(CREDIT_RELIABILITY_SQL, /release_generation_reservation\(/);
});

test("provider attempts are durably marked before dispatch and updated by stable ID", () => {
  assert.match(RUN_AGENT, /isProjectInCreditsCohort\(input\.projectId, creditConfig\)/);
  assert.match(RUN_AGENT, /!!liveReservation\.data/);
  assert.match(CREDIT_SERVICE, /isProjectInCreditsCohort\(context\.projectId, config\)/);
  assert.match(ENGINE, /beginProviderAttempt\(startInput, handle\.client\)/);
  assert.match(ENGINE, /completeProviderAttempt\(usageInput, handle\.client\)/);
  assert.match(RUN_AGENT, /beginProviderAttempt\(inputForStart, guard\.client\)/);
  assert.match(RUN_AGENT, /started\.data !== "started"/);
  assert.match(ENGINE, /started\.data !== "started"/);
  assert.match(RUN_AGENT, /completeProviderAttempt\(/);
  assert.match(CREDIT_RELIABILITY_SQL, /create or replace function public\.begin_ai_provider_attempt/);
  assert.match(CREDIT_RELIABILITY_SQL, /'dispatchState', 'dispatching'/);
  assert.match(CREDIT_RELIABILITY_SQL, /create or replace function public\.complete_ai_provider_attempt/);
  assert.match(CREDIT_RELIABILITY_SQL, /'dispatchState', 'result_received'/);
  assert.match(CREDIT_RELIABILITY_SQL, /GENERATION_LEASE_LOST/);
  assert.match(CREDIT_RELIABILITY_SQL, /PROVIDER_ATTEMPT_ID_CONFLICT/);
  assert.match(CREDIT_RELIABILITY_SQL, /get diagnostics v_inserted = row_count/);
  assert.match(CREDIT_RELIABILITY_SQL, /where p\.project_id = p_project_id/);
  assert.match(CREDIT_RELIABILITY_SQL, /v_run\.lease_token is distinct from p_lease_token/);
  assert.match(CREDIT_RELIABILITY_SQL, /v_run\.lease_expires_at <= now\(\)/);
  assert.match(
    CREDIT_RELIABILITY_SQL,
    /create or replace function public\.maintain_credit_reservations\([\s\S]*?policy\.enabled/,
  );
  assert.match(CREDIT_RELIABILITY_SQL, /usage\.metadata ->> 'dispatchState' = 'dispatching'/);
});

test("usage writes and credit-aware admission wrappers are service-role-only", () => {
  assert.match(CREDIT_RELIABILITY_SQL, /revoke all on function public\.record_ai_usage_attempts\(uuid\) from public, anon, authenticated/);
  assert.match(CREDIT_RELIABILITY_SQL, /grant execute on function public\.record_ai_usage_attempts\(uuid\) to service_role/);
  assert.match(CREDIT_RELIABILITY_SQL, /create_generation_job_with_credits_ordered/);
  assert.match(CREDIT_RELIABILITY_SQL, /resume_generation_job_with_credits_ordered/);
  assert.match(CREDIT_RELIABILITY_SQL, /pg_advisory_xact_lock\(hashtext\('mavly:create_generation_job'\)\)/);
  assert.match(CREDIT_RELIABILITY_SQL, /revoke execute on function public\.create_generation_job_with_credits/);
  assert.match(CREDIT_RELIABILITY_SQL, /revoke execute on function public\.resume_generation_job_with_credits/);
  assert.match(CREDIT_RELIABILITY_SQL, /revoke all on function public\.begin_ai_provider_attempt\([\s\S]*?\) from public, anon, authenticated/);
  assert.match(CREDIT_RELIABILITY_SQL, /revoke all on function public\.complete_ai_provider_attempt\([\s\S]*?\) from public, anon, authenticated/);
  assert.match(CREDIT_RELIABILITY_SQL, /set search_path = public, pg_temp/);
  assert.match(CREDIT_SQL, /p_attempt_key text/);
  assert.match(CREDIT_SQL, /constraint ai_usage_attempts_key_unique unique \(attempt_key\)/);
  assert.match(CREDIT_SQL, /on conflict \(attempt_key\) do nothing/);
});

test("each role resolves exactly its own finalized catalog model", () => {
  const status = roleModelStatus({ MAVLY_MODEL_PLANNER: "not/a-model" } as unknown as NodeJS.ProcessEnv);
  const byRole = (role: string) => status.find((entry) => entry.role === role);
  const finalized: Record<string, string> = {
    planner: "deepseek/deepseek-v4-pro",
    ui_ux: "anthropic/claude-sonnet-5",
    coding: "anthropic/claude-sonnet-5",
    qa: "openai/gpt-5.6-sol",
    security: "anthropic/claude-sonnet-5",
    repair: "deepseek/deepseek-v4-pro",
  };

  for (const [role, expectedModel] of Object.entries(finalized)) {
    assert.equal(byRole(role)?.resolved, expectedModel);
    assert.equal(byRole(role)?.accepted, true);
    /**
     * Configured is not the same as verified: the finalized specialist ids are
     * catalog entries that must be sent verbatim, but their live availability
     * is unproven until an operator confirms them.
     */
    assert.equal(byRole(role)?.verified, false);
    assert.match(String(byRole(role)?.note), /not been verified/);
  }

  // Deployment is deterministic and has no model at all.
  assert.equal(byRole("deployment")?.kind, "deterministic");
  assert.equal(byRole("deployment")?.resolved, null);

  // No environment variable retargets a role: every model role resolves to the
  // id it is pinned to, never to the project's requested model or the default.
  for (const entry of status) {
    assert.equal(entry.accepted, true, `${entry.role} must resolve its pinned model`);
    if (entry.kind === "model") assert.equal(entry.resolved, entry.configured);
  }
});
