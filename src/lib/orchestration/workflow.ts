/**
 * ═══ THE PURE WORKFLOW STATE MACHINE ════════════════════════════════════════
 *
 * This module owns four decisions that must be provable without a database:
 *
 *   1. which workflow/task transitions are legal;
 *   2. how a task graph is derived from task complexity;
 *   3. which tasks may run now, and which may run concurrently;
 *   4. how a budget and a retry/loop bound are spent.
 *
 * The SQL layer stores the result; it does not invent a state. The orchestrator
 * validates every transition through these helpers before it writes, so a
 * duplicate queue delivery cannot re-run a completed task or finalize a
 * cancelled workflow.
 */

import {
  EXECUTION_BUDGET_LIMITS,
  isTerminalTaskStatus,
  type AgentOutput,
  type AgentTask,
  type AgentTaskDefinition,
  type AgentTaskKind,
  type AgentTaskStatus,
  type ExecutionBudget,
  type TaskComplexity,
  type TaskDependency,
  type WorkflowState,
} from "./contracts";

// ── Workflow transitions ────────────────────────────────────────────────────

const WORKFLOW_TRANSITIONS: Record<WorkflowState, readonly WorkflowState[]> = {
  queued: ["planning", "executing", "failed", "cancelled"],
  planning: [
    "executing",
    "waiting_for_dependency",
    "retrying",
    "failed",
    "cancelled",
  ],
  executing: [
    "planning",
    "verifying",
    "waiting_for_dependency",
    "retrying",
    "failed",
    "cancelled",
  ],
  verifying: [
    "completed",
    "awaiting_approval",
    "waiting_for_dependency",
    "retrying",
    "failed",
    "cancelled",
  ],
  waiting_for_dependency: ["planning", "executing", "failed", "cancelled"],
  retrying: ["planning", "executing", "verifying", "failed", "cancelled"],
  awaiting_approval: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransitionWorkflow(from: WorkflowState, to: WorkflowState): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

/**
 * The states a writer may present as its compare-and-set precondition when it
 * moves a workflow to `to`. Empty means no non-terminal source state can reach
 * it, which a caller must treat as "do not write".
 */
export function workflowStatesThatCanTransitionTo(to: WorkflowState): WorkflowState[] {
  return (Object.keys(WORKFLOW_TRANSITIONS) as WorkflowState[]).filter(
    (from) => from !== to && WORKFLOW_TRANSITIONS[from].includes(to),
  );
}

export function assertWorkflowTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransitionWorkflow(from, to)) {
    throw new Error(`Illegal workflow transition ${from} -> ${to}`);
  }
}

/** A terminal workflow may only be reopened by the explicit user-resume path. */
export function canResumeWorkflow(state: WorkflowState): boolean {
  return state === "failed";
}

// ── Task transitions ────────────────────────────────────────────────────────

const TASK_TRANSITIONS: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  pending: ["queued", "waiting_for_dependency", "skipped", "cancelled"],
  waiting_for_dependency: ["pending", "queued", "skipped", "cancelled"],
  queued: ["running", "failed", "skipped", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  failed: ["queued", "skipped", "cancelled"],
  completed: [],
  skipped: [],
  cancelled: [],
};

export function canTransitionTask(from: AgentTaskStatus, to: AgentTaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: AgentTaskStatus, to: AgentTaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Illegal task transition ${from} -> ${to}`);
  }
}

// ── Complexity and the task graph ───────────────────────────────────────────

const INTEGRATION_TERMS = [
  "auth",
  "login",
  "signup",
  "oauth",
  "payment",
  "razorpay",
  "stripe",
  "checkout",
  "database",
  "postgres",
  "supabase",
  "upload",
  "storage",
  "email",
  "notification",
  "webhook",
  "realtime",
  "websocket",
  "dashboard",
  "admin",
  "role",
  "permission",
  "api",
  "cron",
  "background job",
  "analytics",
] as const;

export interface ComplexityInput {
  prompt: string;
  mode: "create" | "update";
  projectType: "website" | "android";
  existingFileCount: number;
}

/**
 * Complexity selects how many specialists run. It is deterministic and
 * conservative: a simple copy change must not pay for a planner, a design
 * review, a security review and a deployment proposal.
 */
export function classifyComplexity(input: ComplexityInput): TaskComplexity {
  const prompt = input.prompt.trim().toLowerCase();
  const terms = INTEGRATION_TERMS.filter((term) => prompt.includes(term));

  if (input.mode === "update" && prompt.length <= 280 && input.existingFileCount <= 8) {
    if (terms.length === 0) return "simple";
  }

  if (
    terms.length >= 3 ||
    prompt.length >= 1_200 ||
    input.existingFileCount >= 40 ||
    (input.projectType === "android" && input.mode === "create")
  ) {
    return "complex";
  }

  return "standard";
}

export function tasksForComplexity(
  complexity: TaskComplexity,
  options: { repairEnabled: boolean } = { repairEnabled: false },
): AgentTaskDefinition[] {
  const plan: AgentTaskDefinition = {
    key: "plan",
    role: "planner",
    kind: "plan",
    title: "Plan the implementation",
    dependsOn: [],
    writesFiles: false,
    required: true,
    maxAttempts: 2,
  };

  const design: AgentTaskDefinition = {
    key: "design-review",
    role: "ui_ux",
    kind: "design_review",
    title: "Review design system, accessibility and responsiveness",
    dependsOn: [{ key: "plan", required: true }],
    writesFiles: false,
    required: false,
    maxAttempts: 2,
  };

  const implement: AgentTaskDefinition = {
    key: "implement",
    role: "coding",
    kind: "implement",
    title: "Implement the approved plan",
    dependsOn: [
      { key: "plan", required: true },
      ...(complexity === "simple"
        ? []
        : [{ key: "design-review", required: false }]),
    ],
    writesFiles: true,
    required: true,
    maxAttempts: 1,
  };

  const verify: AgentTaskDefinition = {
    key: "verify",
    role: "qa",
    kind: "verify",
    title: "Verify the resulting project",
    dependsOn: [{ key: "implement", required: true }],
    writesFiles: false,
    required: true,
    maxAttempts: 1,
  };

  const security: AgentTaskDefinition = {
    key: "security-review",
    role: "security",
    kind: "security_review",
    title: "Review secrets, authorization and unsafe execution",
    dependsOn: [{ key: "implement", required: true }],
    writesFiles: false,
    required: true,
    maxAttempts: 1,
  };

  const deployment: AgentTaskDefinition = {
    key: "deployment-proposal",
    role: "deployment",
    kind: "deployment_proposal",
    title: "Prepare a deployment proposal for owner approval",
    dependsOn: [
      { key: "verify", required: false },
      { key: "security-review", required: true },
    ],
    writesFiles: false,
    required: false,
    maxAttempts: 1,
  };

  const tasks: AgentTaskDefinition[] = [plan];
  if (complexity !== "simple") tasks.push(design);
  tasks.push(implement, verify, security);
  if (complexity !== "simple") tasks.push(deployment);
  return tasks.filter((task) => task.kind !== "repair" || options.repairEnabled);
}

/**
 * A repair task is created after a failure, never in the happy-path graph. It
 * is diagnostic only: it may not write files, so it cannot bypass the verified
 * apply path or the last-known-good snapshot.
 */
export function repairTaskDefinition(maxAttempts = 1): AgentTaskDefinition {
  return {
    key: "repair",
    role: "repair",
    kind: "repair",
    title: "Diagnose the failure and propose targeted fixes",
    dependsOn: [{ key: "implement", required: false }],
    writesFiles: false,
    required: false,
    maxAttempts: Math.max(1, Math.min(2, Math.floor(maxAttempts))),
  };
}

// ── Dependency scheduling ───────────────────────────────────────────────────

export type DependencyVerdict = "ready" | "waiting" | "blocked";

function outputSatisfies(dependency: TaskDependency, task: AgentTask | undefined): boolean {
  if (!task) return false;
  if (task.status === "completed" || task.status === "skipped") return true;
  // An optional dependency that failed is skipped over by design; a required
  // dependency that failed blocks its dependents.
  if (dependency.required) return false;
  return task.status === "failed" || task.status === "cancelled";
}

export function dependencyVerdict(
  task: Pick<AgentTaskDefinition, "dependsOn">,
  byKey: ReadonlyMap<string, AgentTask>,
): DependencyVerdict {
  let waiting = false;
  for (const dependency of task.dependsOn) {
    const upstream = byKey.get(dependency.key);
    if (!upstream) {
      waiting = true;
      continue;
    }
    if (outputSatisfies(dependency, upstream)) continue;
    if (upstream.status === "failed" || upstream.status === "cancelled") return "blocked";
    waiting = true;
  }
  return waiting ? "waiting" : "ready";
}

export function readyTasks(tasks: readonly AgentTask[]): AgentTask[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  return tasks.filter(
    (task) =>
      (task.status === "pending" || task.status === "waiting_for_dependency") &&
      dependencyVerdict(task, byKey) === "ready",
  );
}

export function blockedTasks(tasks: readonly AgentTask[]): AgentTask[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  return tasks.filter(
    (task) =>
      (task.status === "pending" || task.status === "waiting_for_dependency") &&
      dependencyVerdict(task, byKey) === "blocked",
  );
}

/**
 * Pick the tasks an orchestrator may start now. A task that writes files is
 * exclusive; read-only tasks may run together up to the configured bound. This
 * is what prevents two conflicting writers from editing the same project.
 */
export function selectRunnable(
  tasks: readonly AgentTask[],
  options: { maxConcurrency: number },
): AgentTask[] {
  const running = tasks.filter((task) => task.status === "running");
  const runningWriter = running.some((task) => task.writesFiles);
  const ready = readyTasks(tasks);
  const limit = Math.max(1, Math.min(options.maxConcurrency, 4));
  const selected: AgentTask[] = [];
  let writerSelected = runningWriter;

  for (const task of ready) {
    if (selected.length + running.length >= limit) break;
    if (task.writesFiles) {
      if (writerSelected) continue;
      writerSelected = true;
    }
    selected.push(task);
  }
  return selected;
}

/** True when every task has reached a terminal status. */
export function allTasksTerminal(tasks: readonly AgentTask[]): boolean {
  return tasks.length > 0 && tasks.every((task) => isTerminalTaskStatus(task.status));
}

/**
 * The workflow state implied by its tasks. Explicit phase transitions still win;
 * this projection is used for recovery and for the status API.
 */
export function deriveWorkflowState(
  tasks: readonly AgentTask[],
  options: { deploymentProposed: boolean; cancelled: boolean },
): WorkflowState {
  if (options.cancelled) return "cancelled";
  if (tasks.some((task) => task.status === "cancelled")) return "cancelled";
  if (tasks.length === 0) return "queued";

  const implement = tasks.find((task) => task.key === "implement");
  const criticalFailure = tasks.find(
    (task) => task.required && (task.status === "failed" || task.status === "cancelled"),
  );
  if (criticalFailure) return "failed";
  if (options.deploymentProposed) return "awaiting_approval";

  const allDone = tasks.every(
    (task) => task.status === "completed" || task.status === "skipped",
  );
  if (allDone) return "completed";

  if (tasks.some((task) => task.status === "failed")) return "retrying";
  if (implement && (implement.status === "completed" || implement.status === "failed")) {
    return "verifying";
  }
  if (implement && implement.status === "running") return "executing";
  return "planning";
}

// ── Budgets, retries and loop detection ─────────────────────────────────────

export interface BudgetConfig {
  maxProviderCalls?: number;
  maxRepairAttempts?: number;
  maxWallClockMs?: number;
}

export function createBudget(config: BudgetConfig, nowMs: number): ExecutionBudget {
  const maxProviderCalls = clampInt(
    config.maxProviderCalls ?? 8,
    EXECUTION_BUDGET_LIMITS.minProviderCalls,
    EXECUTION_BUDGET_LIMITS.maxProviderCalls,
  );
  const maxWallClockMs = clampInt(
    config.maxWallClockMs ?? 4 * 60_000,
    EXECUTION_BUDGET_LIMITS.minWallClockMs,
    EXECUTION_BUDGET_LIMITS.maxWallClockMs,
  );
  return {
    maxProviderCalls,
    maxRepairAttempts: clampInt(
      config.maxRepairAttempts ?? 1,
      0,
      EXECUTION_BUDGET_LIMITS.maxRepairAttempts,
    ),
    maxWallClockMs,
    startedAtMs: nowMs,
    providerCalls: 0,
    repairAttempts: 0,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export type BudgetDecision =
  | { ok: true; remaining: number }
  | { ok: false; reason: "provider_calls" | "deadline" };

export function reserveProviderCall(
  budget: ExecutionBudget,
  nowMs: number,
): BudgetDecision {
  if (budget.providerCalls >= budget.maxProviderCalls) {
    return { ok: false, reason: "provider_calls" };
  }
  if (nowMs - budget.startedAtMs >= budget.maxWallClockMs) {
    return { ok: false, reason: "deadline" };
  }
  budget.providerCalls += 1;
  return { ok: true, remaining: budget.maxProviderCalls - budget.providerCalls };
}

export function deadlineReached(budget: ExecutionBudget, nowMs: number): boolean {
  return nowMs - budget.startedAtMs >= budget.maxWallClockMs;
}

export function reserveRepairAttempt(budget: ExecutionBudget): boolean {
  if (budget.repairAttempts >= budget.maxRepairAttempts) return false;
  budget.repairAttempts += 1;
  return true;
}

/**
 * Exponential backoff with jitter, bounded by the task policy. This is for an
 * in-process task retry; the durable run retry remains `retryDelaySeconds`.
 */
export function taskRetryDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = Math.max(100, options.baseMs ?? 2_000);
  const max = Math.max(base, options.maxMs ?? 30_000);
  const raw = Math.min(max, base * 2 ** Math.max(0, Math.floor(attempt) - 1));
  const random = Math.min(1, Math.max(0, (options.random ?? Math.random)()));
  return Math.round(raw * (0.5 + random * 0.5));
}

/**
 * A failure signature is deliberately coarse. Two failures with the same role,
 * error class and (for a repair task) the same target files are the same failed
 * fix; applying it again would burn budget without new information.
 */
export function failureSignature(output: {
  role: string;
  errorClass: string;
  filesChanged?: readonly string[];
}): string {
  const files = [...(output.filesChanged ?? [])].sort().slice(0, 20).join(",");
  return `${output.role}:${output.errorClass}:${files}`;
}

export function isRepeatedFailure(
  previousSignatures: readonly string[],
  signature: string,
  limit = 2,
): boolean {
  if (!signature) return false;
  return previousSignatures.filter((entry) => entry === signature).length >= limit;
}

// ── Output projections ──────────────────────────────────────────────────────

const MAX_SUMMARY = 1_500;
const MAX_FINDINGS = 40;
const MAX_FILES_CHANGED = 200;

export function normalizeAgentOutput(output: AgentOutput): AgentOutput {
  return {
    ...output,
    summary: output.summary.slice(0, MAX_SUMMARY),
    filesChanged: [...new Set(output.filesChanged)].slice(0, MAX_FILES_CHANGED),
    findings: output.findings.slice(0, MAX_FINDINGS).map((finding) => ({
      ...finding,
      title: finding.title.slice(0, 200),
      detail: finding.detail.slice(0, 1_000),
      ...(finding.evidence
        ? { evidence: finding.evidence.slice(0, 200) }
        : {}),
    })),
    data: boundedRecord(output.data),
  };
}

function boundedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry.slice(0, 6_000);
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      result[key] = entry;
    } else if (typeof entry === "boolean" || entry === null) {
      result[key] = entry;
    } else if (Array.isArray(entry)) {
      result[key] = entry
        .filter((item): item is string => typeof item === "string")
        .slice(0, 40)
        .map((item) => item.slice(0, 500));
    }
  }
  return result;
}

export function taskKindLabel(kind: AgentTaskKind): string {
  switch (kind) {
    case "plan":
      return "Planning";
    case "design_review":
      return "Design review";
    case "implement":
      return "Implementation";
    case "verify":
      return "Verification";
    case "repair":
      return "Repair diagnosis";
    case "security_review":
      return "Security review";
    case "deployment_proposal":
      return "Deployment proposal";
  }
}
