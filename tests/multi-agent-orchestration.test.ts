import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AGENT_ROLES,
  isAgentTaskKind,
  isAgentTaskStatus,
  isAgentRole,
  isTerminalTaskStatus,
  isTerminalWorkflowState,
  type AgentOutput,
  type AgentTask,
  type AgentTaskStatus,
} from "../src/lib/orchestration/contracts";
import {
  approvalExpiry,
  approvalRejectionReason,
  isDeploymentTarget,
  proposalView,
  type DeploymentProposalRow,
} from "../src/lib/orchestration/approval";
import {
  DEPLOYMENT_APPROVAL_REQUIRED_ENV,
  DEPLOYMENT_APPROVAL_TTL_ENV,
  MULTI_AGENT_ENABLED_ENV,
  MULTI_AGENT_MAX_PROVIDER_CALLS_ENV,
  MULTI_AGENT_MAX_REPAIRS_ENV,
  MULTI_AGENT_MAX_WALL_CLOCK_ENV,
  MULTI_AGENT_PROJECTS_ENV,
  MULTI_AGENT_REPAIR_ENABLED_ENV,
  deploymentApprovalRequiredFor,
  isProjectInMultiAgentCohort,
  parseDeploymentApprovalConfig,
  parseMultiAgentConfig,
} from "../src/lib/orchestration/config";
import {
  AGENT_TOOLS,
  ROLE_CATALOG,
  parseDesignReview,
  parseJsonObject,
  parsePlannerPlan,
  parseRepairDiagnosis,
  parseSourceReview,
  roleAllowsTool,
  subordinateContextBlock,
} from "../src/lib/orchestration/roles";
import { securityReview } from "../src/lib/orchestration/security";
import { toolCannotExecuteHere, validateToolRequest } from "../src/lib/orchestration/tools";
import {
  allTasksTerminal,
  blockedTasks,
  canResumeWorkflow,
  canTransitionTask,
  canTransitionWorkflow,
  classifyComplexity,
  createBudget,
  deadlineReached,
  dependencyVerdict,
  deriveWorkflowState,
  deriveWorkflowVerification,
  failureSignature,
  isRepeatedFailure,
  normalizeAgentOutput,
  readyTasks,
  repairTaskDefinition,
  reserveProviderCall,
  reserveRepairAttempt,
  selectRunnable,
  taskRetryDelayMs,
  tasksForComplexity,
  allRoleTaskDefinitionsForComplexity,
  workflowStatesThatCanTransitionTo,
} from "../src/lib/orchestration/workflow";
import {
  ROLE_MODEL_DEFINITIONS,
  resolveRoleModel,
  roleModelStatus,
} from "../src/lib/ai/model-roles";
import { OPENROUTER_MODEL_CATALOG } from "../src/lib/ai/models";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const MIGRATION = read("supabase/migrations/29_multi_agent_orchestration.sql");
const LIFECYCLE_MIGRATION = read("supabase/migrations/58_multi_agent_lifecycle_observability.sql");
const RUN_AGENT = read("src/lib/mavly/run-agent.ts");
const ENGINE = read("src/lib/orchestration/engine.ts");
const MODEL_ROLE_SOURCE = read("src/lib/ai/model-roles.ts");
const CREDITS_STORE = read("src/lib/credits/store.ts");
const API = read("src/lib/mavly/api.ts");
const STATIC_PUBLISH = read("src/lib/deployments/service.ts");
const FULLSTACK_PUBLISH = read("src/lib/deployments/fullstack.ts");
const CATALOG = read("src/lib/vcaas.ts");
const PANEL = read("src/components/workspace/v2/ProjectWorkflowPanel.tsx");
const ENV_EXAMPLE = read(".env.example");

const NOW = Date.parse("2026-10-28T00:00:00.000Z");

function task(
  key: string,
  status: AgentTaskStatus,
  overrides: Partial<AgentTask> = {},
): AgentTask {
  return {
    key,
    role: "coding",
    kind: "implement",
    title: key,
    dependsOn: [],
    writesFiles: false,
    required: true,
    maxAttempts: 1,
    id: `00000000-0000-4000-8000-00000000000${key.length % 10}`,
    workflowId: "11111111-1111-4111-8111-111111111111",
    status,
    attempt: 1,
    idempotencyKey: `${key}:1`,
    output: null,
    errorClass: null,
    errorSummary: null,
    eligible: true,
    eligibilityReason: "test",
    scheduledAt: null,
    scheduled: false,
    scheduleReason: null,
    startedAt: null,
    finishedAt: null,
    provider: null,
    model: null,
    outputProduced: false,
    outputConsumed: false,
    durationMs: null,
    skipReason: null,
    failureReason: null,
    retryCount: 0,
    ...overrides,
  };
}

function output(overrides: Partial<AgentOutput> = {}): AgentOutput {
  return {
    taskKey: "plan",
    role: "planner",
    status: "ok",
    summary: "A plan.",
    data: {},
    filesChanged: [],
    findings: [],
    reportedCostUsd: 0,
    costKnown: true,
    durationMs: 10,
    ...overrides,
  };
}

function proposal(overrides: Partial<DeploymentProposalRow> = {}): DeploymentProposalRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    project_id: "demo-project",
    user_id: "33333333-3333-4333-8333-333333333333",
    workflow_id: null,
    run_id: null,
    target: "static",
    snapshot_id: null,
    source_hash: "a".repeat(64),
    runtime_profile: null,
    verification_id: null,
    status: "approved",
    summary: {},
    approved_by: "33333333-3333-4333-8333-333333333333",
    approved_at: new Date(NOW - 60_000).toISOString(),
    expires_at: new Date(NOW + 60 * 60_000).toISOString(),
    consumed_at: null,
    revoked_at: null,
    created_at: new Date(NOW - 120_000).toISOString(),
    ...overrides,
  };
}

const READY_ENV = {
  [MULTI_AGENT_ENABLED_ENV]: "1",
  [MULTI_AGENT_PROJECTS_ENV]: "demo-project",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  OPENROUTER_API_KEY: "test-key",
};

// ── Workflow transitions ────────────────────────────────────────────────────

test("workflow transitions are explicit and terminal states stay closed", () => {
  assert.equal(canTransitionWorkflow("queued", "planning"), true);
  assert.equal(canTransitionWorkflow("executing", "verifying"), true);
  assert.equal(canTransitionWorkflow("verifying", "awaiting_approval"), true);
  assert.equal(canTransitionWorkflow("completed", "verifying"), false);
  assert.equal(canTransitionWorkflow("cancelled", "queued"), false);
  assert.equal(canTransitionWorkflow("failed", "queued"), true);
  assert.equal(canResumeWorkflow("failed"), true);
  assert.equal(canResumeWorkflow("cancelled"), false);
  assert.equal(isTerminalWorkflowState("completed"), true);
  assert.equal(isTerminalWorkflowState("awaiting_approval"), false);
});

test("the compare-and-set predecessor set never includes the target state", () => {
  for (const state of ["completed", "failed", "awaiting_approval", "planning"] as const) {
    const sources = workflowStatesThatCanTransitionTo(state);
    assert.ok(!sources.includes(state), `${state} must not be its own predecessor`);
  }
  assert.ok(workflowStatesThatCanTransitionTo("completed").includes("verifying"));
  assert.ok(workflowStatesThatCanTransitionTo("queued").includes("failed"));
  assert.deepEqual(workflowStatesThatCanTransitionTo("planning").sort(), [
    "executing",
    "queued",
    "retrying",
    "waiting_for_dependency",
  ]);
});

test("task transitions do not reopen terminal tasks", () => {
  assert.equal(canTransitionTask("pending", "queued"), true);
  assert.equal(canTransitionTask("queued", "running"), true);
  assert.equal(canTransitionTask("running", "completed"), true);
  assert.equal(canTransitionTask("failed", "queued"), true);
  assert.equal(canTransitionTask("completed", "running"), false);
  assert.equal(canTransitionTask("cancelled", "queued"), false);
  assert.equal(isTerminalTaskStatus("skipped"), true);
  assert.equal(isTerminalTaskStatus("queued"), false);
});

test("role, task-kind and status validators reject unknown values", () => {
  for (const role of AGENT_ROLES) assert.equal(isAgentRole(role), true);
  assert.equal(isAgentRole("superuser"), false);
  assert.equal(isAgentTaskKind("deploy"), false);
  assert.equal(isAgentTaskStatus("done"), false);
});

// ── Task graph, complexity and dependencies ─────────────────────────────────

test("complexity is conservative and deterministic", () => {
  assert.equal(
    classifyComplexity({
      prompt: "change the button label",
      mode: "update",
      projectType: "website",
      existingFileCount: 3,
    }),
    "simple",
  );
  assert.equal(
    classifyComplexity({
      prompt: "add authentication, payments and an admin dashboard",
      mode: "create",
      projectType: "website",
      existingFileCount: 0,
    }),
    "complex",
  );
  assert.equal(
    classifyComplexity({
      prompt: "add a contact page",
      mode: "create",
      projectType: "website",
      existingFileCount: 0,
    }),
    "standard",
  );
  assert.equal(
    classifyComplexity({
      prompt: "build a notes app",
      mode: "create",
      projectType: "android",
      existingFileCount: 0,
    }),
    "complex",
  );
});

test("a simple workflow pays for fewer specialists", () => {
  const simple = tasksForComplexity("simple", { repairEnabled: false }).map((entry) => entry.key);
  const standard = tasksForComplexity("standard", { repairEnabled: false }).map((entry) => entry.key);
  assert.deepEqual(simple, ["implement", "verify", "security-review"]);
  assert.ok(standard.includes("plan"));
  assert.ok(standard.includes("design-review"));
  assert.ok(standard.includes("deployment-proposal"));
  assert.ok(!standard.includes("repair"));
});

test("every locked role receives an explicit eligibility decision", () => {
  const simple = allRoleTaskDefinitionsForComplexity("simple", { repairEnabled: false });
  assert.deepEqual(
    simple.map((entry) => entry.role),
    ["planner", "ui_ux", "coding", "qa", "security", "repair", "deployment"],
  );
  assert.equal(simple.find((entry) => entry.role === "coding")?.eligible, true);
  assert.equal(simple.find((entry) => entry.role === "planner")?.eligible, false);
  assert.equal(simple.find((entry) => entry.role === "repair")?.eligible, false);
  assert.equal(
    simple.find((entry) => entry.role === "planner")?.eligibilityReason,
    "complexity_gate_simple_request",
  );

  const repairEnabled = allRoleTaskDefinitionsForComplexity("standard", { repairEnabled: true });
  assert.equal(repairEnabled.find((entry) => entry.role === "repair")?.eligibilityReason, "failure_only");
});

test("dependencies name real tasks and only coding writes files", () => {
  const tasks = tasksForComplexity("standard", { repairEnabled: true });
  const byKey = new Map(tasks.map((entry) => [entry.key, entry]));
  for (const entry of tasks) {
    for (const dependency of entry.dependsOn) {
      assert.ok(byKey.has(dependency.key), `${entry.key} depends on an unknown ${dependency.key}`);
    }
  }
  assert.deepEqual(
    tasks.filter((entry) => entry.writesFiles).map((entry) => entry.key),
    ["implement"],
  );
  assert.equal(repairTaskDefinition(2).writesFiles, false);
  assert.equal(repairTaskDefinition(99).maxAttempts, 2);
});

test("required dependency failures block; optional ones are skipped over", () => {
  const tasks = [
    task("plan", "failed"),
    task("design-review", "failed"),
    task("implement", "pending", {
      dependsOn: [
        { key: "plan", required: true },
        { key: "design-review", required: false },
      ],
      writesFiles: true,
    }),
  ];
  const byKey = new Map(tasks.map((entry) => [entry.key, entry]));
  assert.equal(dependencyVerdict(tasks[2], byKey), "blocked");
  assert.equal(dependencyVerdict(tasks[1], byKey), "ready");

  const optionalOnly = new Map([
    ["plan", task("plan", "completed")],
    ["design-review", task("design-review", "failed")],
  ]);
  assert.equal(dependencyVerdict(tasks[2], optionalOnly), "ready");

  assert.equal(blockedTasks(tasks).length, 1);
  assert.equal(readyTasks(tasks).length, 0);
});

test("concurrent read-only roles are allowed but a second writer is not", () => {
  const tasks = [
    task("verify", "pending", { writesFiles: false, required: false }),
    task("security-review", "pending", { writesFiles: false, required: false }),
    task("implement", "pending", { writesFiles: true }),
    task("other-writer", "pending", { writesFiles: true }),
  ];
  const selected = selectRunnable(tasks, { maxConcurrency: 4 });
  assert.equal(selected.filter((entry) => entry.writesFiles).length, 1);
  assert.ok(selected.length <= 4);

  const runningWriter = selectRunnable(
    [task("implement", "running", { writesFiles: true }), task("other-writer", "pending", { writesFiles: true })],
    { maxConcurrency: 4 },
  );
  assert.deepEqual(runningWriter.map((entry) => entry.key), []);
});

test("allTasksTerminal requires every task to be terminal", () => {
  assert.equal(allTasksTerminal([]), false);
  assert.equal(
    allTasksTerminal([task("a", "completed"), task("b", "skipped")]),
    true,
  );
  assert.equal(allTasksTerminal([task("a", "completed"), task("b", "failed")]), true);
  assert.equal(allTasksTerminal([task("a", "completed"), task("b", "running")]), false);
});

test("derived workflow state never turns a required failure into success", () => {
  assert.equal(
    deriveWorkflowState([task("implement", "failed", { required: true })], {
      deploymentProposed: false,
      cancelled: false,
    }),
    "failed",
  );
  assert.equal(
    deriveWorkflowState([task("implement", "completed"), task("verify", "pending")], {
      deploymentProposed: false,
      cancelled: false,
    }),
    "verifying",
  );
  assert.equal(
    deriveWorkflowState([task("implement", "completed"), task("verify", "skipped")], {
      deploymentProposed: false,
      cancelled: false,
    }),
    "completed",
  );
  assert.equal(
    deriveWorkflowState([task("implement", "completed"), task("deployment-proposal", "completed")], {
      deploymentProposed: true,
      cancelled: false,
    }),
    "awaiting_approval",
  );
  assert.equal(
    deriveWorkflowState([task("implement", "running")], {
      deploymentProposed: false,
      cancelled: true,
    }),
    "cancelled",
  );
});

// ── Budgets and retries ─────────────────────────────────────────────────────

test("budget limits are clamped, not trusted", () => {
  const budget = createBudget(
    { maxProviderCalls: 999, maxRepairAttempts: 99, maxWallClockMs: 1 },
    NOW,
  );
  assert.equal(budget.maxProviderCalls, 24);
  assert.equal(budget.maxRepairAttempts, 2);
  assert.equal(budget.maxWallClockMs, 30_000);
  assert.equal(budget.startedAtMs, NOW);

  const minimum = createBudget({ maxProviderCalls: 0 }, NOW);
  assert.equal(minimum.maxProviderCalls, 1);
});

test("provider calls and repair attempts stop at their budget", () => {
  const budget = createBudget({ maxProviderCalls: 2, maxRepairAttempts: 1 }, NOW);
  assert.equal(reserveProviderCall(budget, NOW).ok, true);
  assert.equal(reserveProviderCall(budget, NOW).ok, true);
  const exhausted = reserveProviderCall(budget, NOW);
  assert.deepEqual(exhausted, { ok: false, reason: "provider_calls" });

  assert.equal(deadlineReached(budget, NOW + 30_000), true);
  assert.equal(deadlineReached(budget, NOW + 29_999), false);

  assert.equal(reserveRepairAttempt(budget), true);
  assert.equal(reserveRepairAttempt(budget), false);
});

test("specialist calls inherit the generation deadline and reserve coding time", () => {
  assert.match(ENGINE, /maxWallClockMs: Math\.min\(/);
  assert.match(ENGINE, /ROLE_FINALIZE_RESERVE_MS/);
  assert.match(ENGINE, /remainingMs - ROLE_FINALIZE_RESERVE_MS/);
  assert.match(ENGINE, /preCodingDeadlineAtMs/);
  assert.match(RUN_AGENT, /ORCHESTRATION_CODING_RESERVE_MS/);
  assert.match(RUN_AGENT, /maxWallClockMs:/);
  assert.match(RUN_AGENT, /orchestrationRemainingMs \+ POST_CODING_REVIEW_RESERVE_MS/);
  assert.match(RUN_AGENT, /insufficient_shared_budget/);
});

test("task retry backoff is bounded and jittered inside its range", () => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const delay = taskRetryDelayMs(attempt, { baseMs: 1_000, maxMs: 8_000, random: () => 1 });
    assert.ok(delay >= 500 && delay <= 8_000, `attempt ${attempt} produced ${delay}`);
  }
  assert.equal(taskRetryDelayMs(1, { baseMs: 1_000, maxMs: 8_000, random: () => 1 }), 1_000);
  assert.equal(taskRetryDelayMs(4, { baseMs: 1_000, maxMs: 8_000, random: () => 1 }), 8_000);
});

test("repeated failure signatures are detected, different ones are not", () => {
  const signature = failureSignature({ role: "repair", errorClass: "GENERATION_FAILED", filesChanged: ["b.ts", "a.ts"] });
  assert.equal(signature, "repair:GENERATION_FAILED:a.ts,b.ts");
  assert.equal(isRepeatedFailure([signature], signature), false);
  assert.equal(isRepeatedFailure([signature, signature], signature), true);
  assert.equal(
    isRepeatedFailure([signature], failureSignature({ role: "repair", errorClass: "TIMEOUT" })),
    false,
  );
  assert.equal(isRepeatedFailure([], ""), false);
});

// ── Output projection ───────────────────────────────────────────────────────

test("agent output is bounded before it can be persisted", () => {
  const normalized = normalizeAgentOutput(
    output({
      summary: "s".repeat(5_000),
      filesChanged: ["a.ts", "a.ts", "b.ts"],
      data: { text: "t".repeat(10_000), list: ["x", "y", 3], nested: { a: 1 } },
      findings: [
        {
          id: "f1",
          severity: "high",
          title: "t".repeat(500),
          detail: "d".repeat(2_000),
          evidence: "e".repeat(300),
        },
      ],
    }),
  );
  assert.equal(normalized.summary.length, 1_500);
  assert.deepEqual(normalized.filesChanged, ["a.ts", "b.ts"]);
  assert.equal(String(normalized.data.text).length, 6_000);
  assert.deepEqual(normalized.data.list, ["x", "y"]);
  assert.equal(normalized.data.nested, undefined);
  assert.equal(normalized.findings[0].title.length, 200);
  assert.equal(normalized.findings[0].detail.length, 1_000);
  assert.equal(normalized.findings[0].evidence?.length, 200);
});

test("verification projection never upgrades generation into a full verification pass", () => {
  const projection = deriveWorkflowVerification([
    task("implement", "completed", { output: output({ role: "coding", taskKey: "implement" }), outputProduced: true }),
    task("verify", "completed", {
      output: output({
        role: "qa",
        taskKey: "verify",
        verification: {
          status: "pending",
          summary: "Build and runtime evidence are unavailable.",
          checks: [
            { id: "source-present", label: "Source", status: "passed" },
            { id: "static-entry", label: "Entry", status: "passed" },
            { id: "build", label: "Build", status: "unavailable" },
          ],
          evidence: [],
        },
      }),
    }),
    task("security-review", "completed", {
      output: output({
        role: "security",
        taskKey: "security-review",
        verification: { status: "passed", summary: "Static review passed.", checks: [], evidence: [] },
      }),
    }),
  ]);
  assert.equal(projection.generated, "passed");
  assert.equal(projection.structurallyValid, "passed");
  assert.equal(projection.compiled, "unavailable");
  assert.equal(projection.rendered, "unavailable");
  assert.equal(projection.functionallyVerified, "unavailable");
  assert.equal(projection.securityReviewed, "passed");
  assert.equal(projection.fullyVerified, false);
});

// ── Configuration ───────────────────────────────────────────────────────────

test("multi-agent config is off and cohort-scoped by default", () => {
  const disabled = parseMultiAgentConfig({});
  assert.equal(disabled.requested, false);
  assert.equal(disabled.ready, false);
  assert.ok(disabled.problems.includes("disabled"));
  assert.ok(disabled.problems.includes("missing_cohort"));
  assert.equal(isProjectInMultiAgentCohort("demo-project", disabled), false);
});

test("multi-agent config requires the durable worker and an explicit cohort", () => {
  const ready = parseMultiAgentConfig(READY_ENV);
  assert.equal(ready.ready, true, ready.problems.join(","));
  assert.deepEqual(ready.cohort, ["demo-project"]);
  assert.equal(isProjectInMultiAgentCohort("demo-project", ready), true);
  assert.equal(isProjectInMultiAgentCohort("other-project", ready), false);

  const noWorker = parseMultiAgentConfig({
    ...READY_ENV,
    SUPABASE_SERVICE_ROLE_KEY: "",
  });
  assert.equal(noWorker.ready, false);
  assert.ok(noWorker.problems.includes("worker_not_ready"));

  const noKey = parseMultiAgentConfig({ ...READY_ENV, OPENROUTER_API_KEY: "" });
  assert.ok(noKey.problems.includes("missing_ai_key"));

  const invalid = parseMultiAgentConfig({ ...READY_ENV, [MULTI_AGENT_PROJECTS_ENV]: "not a project" });
  assert.ok(invalid.problems.includes("invalid_cohort"));
  assert.equal(invalid.ready, false);
});

test("budget overrides are clamped and repair defaults are conservative", () => {
  const config = parseMultiAgentConfig({
    ...READY_ENV,
    [MULTI_AGENT_MAX_PROVIDER_CALLS_ENV]: "999",
    [MULTI_AGENT_MAX_WALL_CLOCK_ENV]: "1",
    [MULTI_AGENT_REPAIR_ENABLED_ENV]: "1",
    [MULTI_AGENT_MAX_REPAIRS_ENV]: "99",
  });
  assert.equal(config.maxProviderCalls, 24);
  assert.equal(config.maxWallClockMs, 30_000);
  assert.equal(config.repairEnabled, true);
  assert.equal(config.maxRepairs, 2);

  const noRepair = parseMultiAgentConfig({
    ...READY_ENV,
    [MULTI_AGENT_REPAIR_ENABLED_ENV]: "1",
    [MULTI_AGENT_MAX_REPAIRS_ENV]: "0",
  });
  assert.equal(noRepair.repairEnabled, false);
  assert.equal(noRepair.maxRepairs, 0);
});

test("the deployment approval gate is independent and cohort-aware", () => {
  assert.equal(deploymentApprovalRequiredFor("demo-project", {}), false);
  assert.equal(
    deploymentApprovalRequiredFor("demo-project", { [DEPLOYMENT_APPROVAL_REQUIRED_ENV]: "1" }),
    true,
  );
  assert.equal(deploymentApprovalRequiredFor("demo-project", READY_ENV), true);
  assert.equal(deploymentApprovalRequiredFor("other-project", READY_ENV), false);

  const parsed = parseDeploymentApprovalConfig({
    [DEPLOYMENT_APPROVAL_REQUIRED_ENV]: "on",
    [DEPLOYMENT_APPROVAL_TTL_ENV]: "99999",
  });
  assert.deepEqual(parsed, { required: true, ttlMinutes: 1_440 });
});

// ── Approval rules ──────────────────────────────────────────────────────────

test("approval expiry is bounded", () => {
  assert.equal(approvalExpiry(NOW, 1), new Date(NOW + 5 * 60_000).toISOString());
  assert.equal(approvalExpiry(NOW, 9_999), new Date(NOW + 1_440 * 60_000).toISOString());
});

test("an approval is valid only for its exact project, target, snapshot and hash", () => {
  const expected = {
    projectId: "demo-project",
    target: "static" as const,
    snapshotId: null,
    sourceHash: "a".repeat(64),
  };
  assert.equal(approvalRejectionReason(proposal(), expected, NOW), null);
  assert.match(
    approvalRejectionReason(proposal({ status: "proposed", approved_at: null, approved_by: null }), expected, NOW) ?? "",
    /not been approved/i,
  );
  assert.match(
    approvalRejectionReason(proposal({ expires_at: new Date(NOW - 1).toISOString() }), expected, NOW) ?? "",
    /expired/i,
  );
  assert.match(
    approvalRejectionReason(proposal({ source_hash: "b".repeat(64) }), expected, NOW) ?? "",
    /source changed/i,
  );
  assert.match(
    approvalRejectionReason(proposal({ project_id: "other" }), expected, NOW) ?? "",
    /different project/i,
  );
  assert.match(
    approvalRejectionReason(proposal({ target: "fullstack" }), expected, NOW) ?? "",
    /different deployment target/i,
  );
  assert.match(
    approvalRejectionReason(proposal({ consumed_at: new Date(NOW).toISOString() }), expected, NOW) ?? "",
    /already used/i,
  );
  assert.match(
    approvalRejectionReason(proposal({ status: "revoked", revoked_at: new Date(NOW).toISOString() }), expected, NOW) ?? "",
    /revoked/i,
  );
  assert.match(
    approvalRejectionReason(
      proposal({ snapshot_id: "44444444-4444-4444-8444-444444444444" }),
      expected,
      NOW,
    ) ?? "",
    /different source snapshot/i,
  );
  assert.match(approvalRejectionReason(null, expected, NOW) ?? "", /No deployment approval/i);
});

test("a consumed proposal stays consumed; an expired one is projected as expired", () => {
  const consumed = proposalView(
    proposal({ status: "consumed", consumed_at: new Date(NOW).toISOString() }),
    NOW,
  );
  assert.equal(consumed.status, "consumed");

  const expired = proposalView(
    proposal({ expires_at: new Date(NOW - 1).toISOString() }),
    NOW,
  );
  assert.equal(expired.status, "expired");

  const revoked = proposalView(
    proposal({ status: "revoked", revoked_at: new Date(NOW).toISOString(), expires_at: new Date(NOW - 1).toISOString() }),
    NOW,
  );
  assert.equal(revoked.status, "revoked");

  assert.equal(isDeploymentTarget("static"), true);
  assert.equal(isDeploymentTarget("lambda"), false);
});

// ── Security role (deterministic) ───────────────────────────────────────────

test("the security review passes clean source and fails only on real matches", () => {
  const clean = securityReview([
    { path: "app/page.tsx", content: "export default function Page() { return <main>Hi</main>; }" },
  ]);
  assert.equal(clean.verification.status, "passed");
  assert.equal(clean.findings.length, 0);
  assert.equal(
    clean.verification.checks.find((check) => check.id === "authorization")?.status,
    "unavailable",
  );

  const leaked = securityReview([
    { path: "lib/key.ts", content: "-----BEGIN RSA PRIVATE KEY-----\nMIIE..." },
  ]);
  assert.equal(leaked.verification.status, "failed");
  assert.equal(leaked.findings[0].id, "private-key");
  assert.equal(leaked.findings[0].path, "lib/key.ts");
});

test("the security review distinguishes client code and Android manifests", () => {
  const serviceRole = securityReview([
    {
      path: "components/leak.tsx",
      content: '"use client";\nconst key = process.env.SUPABASE_SERVICE_ROLE_KEY;',
    },
  ]);
  assert.ok(serviceRole.findings.some((finding) => finding.id === "service-role-in-client"));

  const nonClient = securityReview([
    { path: "lib/server.ts", content: "const key = process.env.SUPABASE_SERVICE_ROLE_KEY;" },
  ]);
  assert.equal(nonClient.findings.some((finding) => finding.id === "service-role-in-client"), false);

  const android = securityReview([
    {
      path: "app/src/main/AndroidManifest.xml",
      content: '<manifest><application android:debuggable="true" android:usesCleartextTraffic="true" /></manifest>',
    },
  ]);
  assert.equal(android.verification.status, "failed");
  assert.ok(android.findings.some((finding) => finding.id === "android-debuggable"));
  assert.ok(android.findings.some((finding) => finding.id === "android-cleartext"));
});

test("findings never include a matched secret value", () => {
  const review = securityReview([
    { path: "lib/config.ts", content: 'const token = "sk-or-v1-abcdefghijklmnopqrstuvwxyz";' },
  ]);
  const serialized = JSON.stringify(review);
  assert.equal(serialized.includes("abcdefghijklmnopqrstuvwxyz"), false);
});

// ── Scoped tools ────────────────────────────────────────────────────────────

test("roles only receive the tools their catalog entry allows", () => {
  assert.equal(roleAllowsTool("coding", "apply_file_changes"), true);
  assert.equal(roleAllowsTool("planner", "apply_file_changes"), false);
  assert.equal(roleAllowsTool("deployment", "request_deployment_approval"), true);
  assert.equal(roleAllowsTool("security", "apply_file_changes"), false);
  for (const role of AGENT_ROLES) {
    assert.ok(ROLE_CATALOG[role].tools.every((tool) => (AGENT_TOOLS as readonly string[]).includes(tool)));
  }
});

test("tool requests are validated before any orchestrator runs them", () => {
  const files = [{ path: "app/page.tsx", content: "export default function Page() { return null; }" }];

  assert.equal(
    validateToolRequest({ role: "planner", tool: "apply_file_changes", args: {}, files }).ok,
    false,
  );

  const allowed = validateToolRequest({
    role: "coding",
    tool: "apply_file_changes",
    args: { files: [{ path: "app/page.tsx", content: "export default 1;" }] },
    files,
  });
  assert.equal(allowed.ok, true);

  const secret = validateToolRequest({
    role: "coding",
    tool: "apply_file_changes",
    args: { files: [{ path: ".env", content: "SECRET=1" }] },
    files,
  });
  assert.equal(secret.ok, false);
  if (secret.ok === false) assert.equal(secret.code, "secret_path");

  const unknownRead = validateToolRequest({
    role: "planner",
    tool: "read_files",
    args: { paths: ["missing.ts"] },
    files,
  });
  assert.equal(unknownRead.ok, false);
  if (unknownRead.ok === false) assert.equal(unknownRead.code, "unknown_path");

  const badProfile = validateToolRequest({
    role: "qa",
    tool: "run_project_checks",
    args: { profile: "anything" },
    files,
  });
  assert.equal(badProfile.ok, false);

  const badTarget = validateToolRequest({
    role: "deployment",
    tool: "request_deployment_approval",
    args: { target: "lambda" },
    files,
  });
  assert.equal(badTarget.ok, false);

  assert.notEqual(toolCannotExecuteHere("run_project_checks"), null);
  assert.notEqual(toolCannotExecuteHere("inspect_preview"), null);
  assert.equal(toolCannotExecuteHere("list_files"), null);
});

// ── Role output parsing ─────────────────────────────────────────────────────

test("role parsers accept one JSON object and reject prose or an empty answer", () => {
  assert.equal(parseJsonObject("").ok, false);
  assert.equal(parseJsonObject("no json here").ok, false);
  assert.equal(parseJsonObject("[1,2,3]").ok, false);
  assert.equal(parseJsonObject("```json\n{\"a\":1}\n```").ok, true);
});

test("planner, design and repair parsers bound their output", () => {
  const plan = parsePlannerPlan(
    JSON.stringify({
      summary: "Add a contact page.",
      pages: ["app/contact/page.tsx"],
      components: ["ContactForm"],
      integrations: [],
      constraints: ["Keep the existing palette."],
      steps: ["Add the route", "Add the form"],
      risks: [],
      verification: ["The page renders."],
    }),
  );
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.value.pages[0], "app/contact/page.tsx");
    assert.equal(plan.value.steps.length, 2);
  }
  assert.equal(parsePlannerPlan('{"pages":[]}').ok, false);

  const design = parseDesignReview(
    JSON.stringify({
      designSystem: "Tailwind tokens already in globals.css.",
      directives: ["Reuse Button"],
      accessibility: ["Label the input"],
      responsive: ["Stack on mobile"],
      risks: [],
      verification: ["Keyboard reachable"],
    }),
  );
  assert.equal(design.ok, true);
  assert.equal(parseDesignReview('{"directives":[]}').ok, false);

  const repair = parseRepairDiagnosis(
    JSON.stringify({
      diagnosis: "Hypothesis: the manifest omitted the page.",
      fixes: [{ path: "app/page.tsx", action: "change", detail: "Add the missing route export." }],
      avoid: ["Rewriting every file"],
      verification: ["Next build exits 0"],
    }),
  );
  assert.equal(repair.ok, true);
  if (repair.ok) assert.equal(repair.value.fixes.length, 1);
  assert.equal(parseRepairDiagnosis('{"fixes":[]}').ok, false);
});

test("source-review findings must cite an existing path and source line", () => {
  const parsed = parseSourceReview(
    JSON.stringify({
      summary: "Review limited to the supplied source.",
      findings: [
        {
          severity: "medium",
          title: "Missing accessible name",
          detail: "The input has no associated label.",
          path: "app/page.tsx",
          line: 2,
          evidence: "<input />",
        },
        {
          severity: "high",
          title: "Unknown path",
          detail: "This path was not supplied.",
          path: "missing.ts",
          line: 1,
          evidence: "const missing = true;",
        },
        {
          severity: "critical",
          title: "Out-of-range line",
          detail: "This line is not in the supplied file.",
          path: "app/page.tsx",
          line: 40,
          evidence: "<input />",
        },
      ],
      risks: ["Runtime behavior was not checked."],
    }),
    [{ path: "app/page.tsx", content: "const title = 'Page';\n<input />" }],
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.findings.length, 1);
    assert.equal(parsed.value.findings[0].line, 2);
  }
});

test("each multi-agent role resolves its exact finalized model without fallback", () => {
  /** The locked product mapping. Changing a pin must change this expectation. */
  const expected: Record<string, string | null> = {
    planner: "deepseek/deepseek-v4-pro",
    ui_ux: "anthropic/claude-sonnet-5",
    coding: "anthropic/claude-sonnet-5",
    qa: "openai/gpt-5.6-sol",
    security: "anthropic/claude-sonnet-5",
    repair: "deepseek/deepseek-v4-pro",
    deployment: null,
  };
  assert.deepEqual(
    Object.fromEntries(ROLE_MODEL_DEFINITIONS.map(({ role, modelId }) => [role, modelId])),
    expected,
  );
  for (const definition of ROLE_MODEL_DEFINITIONS) {
    assert.equal(
      resolveRoleModel({ role: definition.role })?.id ?? null,
      expected[definition.role],
    );
    if (definition.modelId) {
      assert.equal(
        OPENROUTER_MODEL_CATALOG.some((model) => model.id === definition.modelId),
        true,
      );
    }
  }
  assert.doesNotMatch(MODEL_ROLE_SOURCE, /\bresolveModel\s*\(/);
  assert.equal(
    roleModelStatus({} as unknown as NodeJS.ProcessEnv, "my-project").find((entry) => entry.role === "deployment")?.kind,
    "deterministic",
  );
});

test("role completions use durable per-attempt accounting and the existing coding engine", () => {
  // The implementation records each specialist call through the durable
  // provider-attempt RPCs (migration 32), pre-dispatch, so an aborted call is
  // still an accounted attempt. These assert the real call sites.
  assert.match(ENGINE, /beginProviderAttempt\(startInput, handle\.client\)/);
  assert.match(ENGINE, /completeProviderAttempt\(usageInput, handle\.client\)/);
  assert.match(ENGINE, /const attemptId = randomUUID\(\)/);
  assert.match(ENGINE, /promptTokens: result\.metadata\.usage\.promptTokens/);
  assert.match(ENGINE, /model: model\.id,/);
  assert.match(CREDITS_STORE, /rpc\("record_ai_usage_attempt"/);
  assert.match(RUN_AGENT, /resolveRoleModel/);
  assert.match(RUN_AGENT, /requestedModel: codingRoleModel\?\.id \?\? input\.requestedModel/);
  // A specialist call that cannot be durably recorded is never sent.
  assert.match(ENGINE, /usage_attempt_unavailable/);
  assert.match(ENGINE, /outcome\.allFiles\.length === 0 \|\| runtimeFailed \|\| buildFailed/);
  assert.match(ENGINE, /deterministicFailed \? "failed" : "ok"/);
});

test("specialist context is explicitly subordinate and bounded", () => {
  const block = subordinateContextBlock("Plan", "Do exactly this.", 10);
  assert.match(block, /advisory context/i);
  assert.match(block, /outrank/i);
  assert.match(block, /Do exactly/);
  assert.equal(block.length < 300, true);
  assert.equal(subordinateContextBlock("Plan", "   ", 10), "");
});

// ── Static integration invariants ───────────────────────────────────────────

test("migration 29 is additive, owner-scoped and exposes only fenced writes", () => {
  assert.match(MIGRATION, /create table if not exists public\.agent_workflows/);
  assert.match(MIGRATION, /create table if not exists public\.agent_tasks/);
  assert.match(MIGRATION, /create table if not exists public\.agent_workflow_events/);
  assert.match(MIGRATION, /create table if not exists public\.deployment_proposals/);
  assert.match(MIGRATION, /run_id uuid not null unique/);
  assert.match(MIGRATION, /alter table public\.agent_workflows enable row level security/);
  assert.match(MIGRATION, /create policy "agent_workflows_select_own"/);
  assert.match(MIGRATION, /create policy "deployment_proposals_select_own"/);

  for (const fn of [
    "cancel_agent_workflow",
    "create_deployment_proposal",
    "approve_deployment_proposal",
    "revoke_deployment_proposal",
    "consume_deployment_approval",
    "multi_agent_schema_version",
  ]) {
    assert.match(MIGRATION, new RegExp(`create or replace function public\\.${fn}`));
    assert.match(MIGRATION, new RegExp(`grant execute on function public\\.${fn}`));
  }

  // The proposal tables are SELECT-only for the authenticated role.
  assert.match(MIGRATION, /grant select \([\s\S]*?\) on public\.deployment_proposals to authenticated;/);
  assert.doesNotMatch(MIGRATION, /grant (?:insert|update|delete|all)[^;]* on public\.deployment_proposals to authenticated/i);
  assert.match(MIGRATION, /grant all on public\.deployment_proposals to service_role/);
});

test("migration 58 persists explicit role lifecycle and consumption metadata", () => {
  assert.match(LIFECYCLE_MIGRATION, /add column if not exists eligible boolean/);
  assert.match(LIFECYCLE_MIGRATION, /add column if not exists scheduled_at timestamptz/);
  assert.match(LIFECYCLE_MIGRATION, /add column if not exists scheduled boolean/);
  assert.match(LIFECYCLE_MIGRATION, /add column if not exists provider text/);
  assert.match(LIFECYCLE_MIGRATION, /add column if not exists model text/);
  assert.match(LIFECYCLE_MIGRATION, /add column if not exists output_consumed boolean/);
  assert.match(LIFECYCLE_MIGRATION, /multi_agent_lifecycle_schema_version/);
  assert.match(LIFECYCLE_MIGRATION, /select 58/);
  assert.match(LIFECYCLE_MIGRATION, /grant select \([\s\S]*?output_consumed/);
});

test("generation integrates orchestration without creating a second pipeline", () => {
  assert.match(RUN_AGENT, /beginOrchestration/);
  assert.match(RUN_AGENT, /runPlanningAgents/);
  assert.match(RUN_AGENT, /markCodingStarted/);
  assert.match(RUN_AGENT, /recordCodingCompleted/);
  assert.match(RUN_AGENT, /recordCodingFailed/);
  // Worker mode only: an inline after() run has no durable scheduler or service client.
  assert.match(RUN_AGENT, /input\.worker\s*\?\s*await beginOrchestration/);
  // The failure path must not substitute a second run/queue.
  assert.doesNotMatch(RUN_AGENT, /create_generation_job/);
});

test("image-stage failures reach Coding as explicit unavailable placements", () => {
  assert.match(RUN_AGENT, /markImagePlacementsUnavailable/);
  assert.match(RUN_AGENT, /generationInput\.imagePending = manifest\.images\.map/);
  assert.match(RUN_AGENT, /The pages use placeholders for the planned imagery/);
});

test("the deploy route passes a server-derived approval and reuses the gate", () => {
  assert.match(API, /deployments\/proposals/);
  assert.match(API, /agent\/workflow/);
  assert.match(API, /approvalId/);
  assert.match(STATIC_PUBLISH, /enforceDeploymentApproval/);
  assert.match(FULLSTACK_PUBLISH, /enforceDeploymentApproval/);
  // The gate result is checked before any provider mutation in both paths.
  assert.match(STATIC_PUBLISH, /const approval = await enforceDeploymentApproval[\s\S]{0,400}if \(!approval\.ok\) return fail/);
  assert.match(FULLSTACK_PUBLISH, /const approval = await enforceDeploymentApproval[\s\S]{0,400}if \(!approval\.ok\) return fail/);
});

test("the workspace exposes the truthful agent/approval surface through the catalog", () => {
  assert.match(CATALOG, /agent\.workflow|workflow: \(projectId/);
  assert.match(CATALOG, /deployments\.proposals|proposals: \{/);
  assert.match(CATALOG, /consume|approvalId/);
  assert.match(PANEL, /pending/);
  assert.match(PANEL, /not proof|not a pass/i);
  assert.match(PANEL, /Deploy this approval/);
  assert.match(PANEL, /outputProduced/);
  assert.match(PANEL, /eligibilityReason/);
  // No panel may call a raw /api path or auto-deploy.
  assert.doesNotMatch(PANEL, /fetch\(/);
  assert.doesNotMatch(PANEL, /\/api\//);
});

test("every Phase 10 flag is documented in .env.example", () => {
  for (const key of [
    MULTI_AGENT_ENABLED_ENV,
    MULTI_AGENT_PROJECTS_ENV,
    MULTI_AGENT_REPAIR_ENABLED_ENV,
    MULTI_AGENT_MAX_REPAIRS_ENV,
    MULTI_AGENT_MAX_PROVIDER_CALLS_ENV,
    MULTI_AGENT_MAX_WALL_CLOCK_ENV,
    DEPLOYMENT_APPROVAL_REQUIRED_ENV,
    DEPLOYMENT_APPROVAL_TTL_ENV,
  ]) {
    assert.match(ENV_EXAMPLE, new RegExp(`^${key}=`, "m"), `${key} is missing from .env.example`);
  }
});
