/**
 * ═══ MULTI-AGENT ORCHESTRATION CONTRACTS ════════════════════════════════════
 *
 * A workflow is a durable, project-scoped record of how one existing
 * `project_runs` job was decomposed into specialist tasks. It is deliberately a
 * thin layer ON TOP of the existing run/lease/checkpoint model:
 *
 *   · `project_runs` remains the only generation job and the only lease owner;
 *   · `agent_workflows` 1:1 with a run (unique `run_id`);
 *   · `agent_tasks` has explicit dependencies and idempotency keys;
 *   · no second queue, no second provider, no second generation pipeline.
 *
 * ⚠️ PURE MODULE. No Supabase, Next.js or provider import. The transitions,
 * dependency graph, budgets and output validation are unit-testable without a
 * database or an API key.
 *
 * ⚠️ TASK OUTPUT IS DATA. A role's assertion that code works is never proof;
 * only recorded checks (sandbox verification, static contract validation) count.
 */

export const AGENT_ROLES = [
  "planner",
  "ui_ux",
  "coding",
  "qa",
  "repair",
  "security",
  "deployment",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}

export const AGENT_TASK_KINDS = [
  "plan",
  "design_review",
  "implement",
  "verify",
  "repair",
  "security_review",
  "deployment_proposal",
] as const;

export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];

export function isAgentTaskKind(value: unknown): value is AgentTaskKind {
  return (
    typeof value === "string" && (AGENT_TASK_KINDS as readonly string[]).includes(value)
  );
}

/**
 * `waiting_for_dependency` is a persisted task state, not a spinner: the task
 * has been created and is intentionally not runnable yet.
 */
export const AGENT_TASK_STATUSES = [
  "pending",
  "waiting_for_dependency",
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
] as const;

export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export function isAgentTaskStatus(value: unknown): value is AgentTaskStatus {
  return (
    typeof value === "string" && (AGENT_TASK_STATUSES as readonly string[]).includes(value)
  );
}

export const TERMINAL_TASK_STATUSES = [
  "completed",
  "failed",
  "skipped",
  "cancelled",
] as const;

export function isTerminalTaskStatus(value: unknown): value is AgentTaskStatus {
  return typeof value === "string" && (TERMINAL_TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * Workflow states. `planning` / `executing` / `verifying` describe the phase;
 * `retrying` and `waiting_for_dependency` are non-terminal parked states;
 * `awaiting_approval` is the Phase 10 gate and never deploys anything itself.
 */
export const WORKFLOW_STATES = [
  "queued",
  "planning",
  "executing",
  "verifying",
  "waiting_for_dependency",
  "retrying",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const TERMINAL_WORKFLOW_STATES = ["completed", "failed", "cancelled"] as const;

export function isTerminalWorkflowState(state: unknown): state is WorkflowState {
  return (
    typeof state === "string" &&
    (TERMINAL_WORKFLOW_STATES as readonly string[]).includes(state)
  );
}

export type TaskComplexity = "simple" | "standard" | "complex";

export interface ProjectFile {
  path: string;
  content: string;
}

export interface TaskDependency {
  /** The task key this task waits for. */
  key: string;
  /**
   * A failed optional dependency is skipped over; a failed required dependency
   * blocks the dependent task rather than silently running it on bad input.
   */
  required: boolean;
}

/** A validated task's plan-time definition (no database identity). */
export interface AgentTaskDefinition {
  key: string;
  role: AgentRole;
  kind: AgentTaskKind;
  title: string;
  dependsOn: readonly TaskDependency[];
  /** True only for a task that may change `project_files`. */
  writesFiles: boolean;
  /** False means the workflow may still complete when this task fails. */
  required: boolean;
  /** Bounded task-level attempt budget. */
  maxAttempts: number;
}

export interface AgentFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  path?: string;
  /** 1-based source line when the finding came from a file scan. */
  line?: number;
}

export type AgentVerificationStatus =
  | "passed"
  | "failed"
  | "pending"
  | "skipped"
  | "unavailable";

export interface AgentVerificationCheck {
  id: string;
  label: string;
  status: AgentVerificationStatus;
  /** Factual, bounded detail. Never a secret or a raw provider body. */
  detail?: string;
}

export interface AgentVerificationResult {
  status: AgentVerificationStatus;
  summary: string;
  checks: AgentVerificationCheck[];
  /** Reproducible, redacted evidence lines (paths, error classes, counts). */
  evidence: string[];
}

/** The only shape a role may hand back to the orchestrator. */
export interface AgentOutput {
  taskKey: string;
  role: AgentRole;
  /** `ok` and `skipped` still carry a summary; `unavailable` is not success. */
  status: "ok" | "failed" | "skipped" | "unavailable";
  summary: string;
  data: Record<string, unknown>;
  filesChanged: string[];
  findings: AgentFinding[];
  verification?: AgentVerificationResult;
  /** Provider-reported USD cost when the role made model calls. */
  reportedCostUsd: number | null;
  costKnown: boolean;
  durationMs: number;
}

export interface AgentTask extends AgentTaskDefinition {
  id: string;
  workflowId: string;
  status: AgentTaskStatus;
  attempt: number;
  idempotencyKey: string;
  output: AgentOutput | null;
  errorClass: string | null;
  errorSummary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Everything one task execution may read. `client` is the caller-scoped client
 * from the run (the worker's confined service-role client in worker mode); a
 * tool never creates its own client.
 */
export interface AgentInput {
  workflowId: string;
  taskKey: string;
  role: AgentRole;
  projectId: string;
  runId: string;
  userId: string;
  prompt: string;
  projectType: "website" | "android";
  mode: "create" | "update";
  files: readonly ProjectFile[];
  dependencyOutputs: Readonly<Record<string, AgentOutput>>;
  budget: ExecutionBudget;
  /** Present for model-backed roles only; never serialized into an output. */
  requestedModel?: string | null;
}

export interface AgentExecutionContext extends AgentInput {
  client: import("@supabase/supabase-js").SupabaseClient | null;
  now: () => number;
  signal?: AbortSignal;
}

export interface ExecutionBudget {
  /** Maximum billable model calls this workflow may make. */
  maxProviderCalls: number;
  /** Maximum bounded repair attempts (0 disables the repair task). */
  maxRepairAttempts: number;
  /** Total wall-clock budget for orchestration work. */
  maxWallClockMs: number;
  /** Epoch milliseconds. */
  startedAtMs: number;
  providerCalls: number;
  repairAttempts: number;
}

export const EXECUTION_BUDGET_LIMITS = {
  minProviderCalls: 1,
  maxProviderCalls: 24,
  maxRepairAttempts: 2,
  minWallClockMs: 30_000,
  maxWallClockMs: 15 * 60_000,
} as const;

export interface WorkflowRow {
  id: string;
  project_id: string;
  run_id: string;
  user_id: string;
  state: WorkflowState;
  complexity: TaskComplexity;
  prompt_excerpt: string;
  plan_context: string | null;
  design_directives: string | null;
  summary: string | null;
  error_class: string | null;
  provider_calls: number;
  repair_attempts: number;
  reported_cost_usd: number | null;
  cost_known: boolean;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowEventRow {
  id: number;
  workflow_id: string;
  project_id: string;
  task_key: string | null;
  kind: string;
  message: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** A wire-safe workflow projection. No prompt, no file content, no secret. */
export interface WorkflowView {
  id: string;
  runId: string;
  state: WorkflowState;
  complexity: TaskComplexity;
  summary: string | null;
  errorClass: string | null;
  startedAt: string;
  finishedAt: string | null;
  providerCalls: number;
  repairAttempts: number;
  reportedCostUsd: number | null;
  costKnown: boolean;
  tasks: Array<{
    key: string;
    role: AgentRole;
    kind: AgentTaskKind;
    title: string;
    status: AgentTaskStatus;
    dependsOn: string[];
    required: boolean;
    attempt: number;
    maxAttempts: number;
    summary: string | null;
    filesChanged: string[];
    findings: AgentFinding[];
    verification: AgentVerificationResult | null;
    errorClass: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
}
