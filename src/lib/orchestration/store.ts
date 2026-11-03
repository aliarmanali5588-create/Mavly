/**
 * ═══ WORKFLOW PERSISTENCE (WORKER-OWNED) ════════════════════════════════════
 *
 * Every write goes through the caller-scoped client the run already owns. In
 * worker mode that is the confined service-role client, after `run-agent`
 * re-verified the project owner; in any other mode the caller passes `null` and
 * no workflow is created. The browser has SELECT-only RLS and can never write a
 * task, an event or a state transition directly.
 *
 * ⚠️ TRANSITIONS ARE COMPARE-AND-SET. `transitionTask`/`updateWorkflow` include
 * the expected current status/state in the UPDATE. A duplicate queue delivery
 * or a stale worker therefore gets `null` instead of rewriting a terminal row.
 *
 * ⚠️ A MISSING MIGRATION IS `migration_required`, never a silent no-op that makes
 * the workspace claim a workflow exists.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AgentOutput,
  AgentTask,
  AgentTaskDefinition,
  AgentTaskStatus,
  TaskComplexity,
  WorkflowEventRow,
  WorkflowRow,
  WorkflowState,
} from "./contracts";
import { isAgentRole, isAgentTaskKind, isAgentTaskStatus } from "./contracts";

export type WorkflowStoreCode =
  | "unavailable"
  | "migration_required"
  | "conflict"
  | "unauthorized"
  | "not_found"
  | "error";

export interface WorkflowStoreFailure {
  ok: false;
  code: WorkflowStoreCode;
  error: string;
}

export type WorkflowStoreResult<T> = { ok: true; data: T } | WorkflowStoreFailure;

export function isWorkflowStoreFailure<T>(
  result: WorkflowStoreResult<T>,
): result is WorkflowStoreFailure {
  return result.ok === false;
}

const WORKFLOW_COLUMNS =
  "id,project_id,run_id,user_id,state,complexity,prompt_excerpt,plan_context,design_directives,summary,error_class,provider_calls,repair_attempts,reported_cost_usd,cost_known,started_at,finished_at,created_at,updated_at";

const TASK_COLUMNS =
  "id,workflow_id,project_id,task_key,role,kind,title,status,depends_on,writes_files,required,max_attempts,attempt,idempotency_key,output,error_class,error_summary,eligible,eligibility_reason,scheduled,scheduled_at,schedule_reason,started_at,finished_at,provider,model,output_produced,output_consumed,duration_ms,skip_reason,failure_reason,retry_count,created_at,updated_at";

function failure(code: WorkflowStoreCode, error: string): WorkflowStoreFailure {
  return { ok: false, code, error };
}

function mapError(scope: string, error: { code?: string; message?: string } | null): WorkflowStoreFailure {
  const code = error?.code ?? "unknown";
  console.warn(`[orchestration] ${scope} failed (${code})`);
  if (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST202" ||
    code === "PGRST204" ||
    code === "PGRST205"
  ) {
    return failure(
      "migration_required",
      "Multi-agent workflow storage is not installed or is missing lifecycle metadata. Apply migrations 29_multi_agent_orchestration.sql and 58_multi_agent_lifecycle_observability.sql.",
    );
  }
  if (code === "28000" || code === "42501") {
    return failure("unauthorized", "This project is not authorized for workflow storage.");
  }
  if (code === "23505") {
    return failure("conflict", "The workflow record already exists.");
  }
  return failure("error", "Could not complete the workflow storage operation.");
}

function taskFromRow(row: Record<string, unknown>): AgentTask {
  const dependsOn = Array.isArray(row.depends_on)
    ? row.depends_on
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const record = entry as Record<string, unknown>;
          const key = typeof record.key === "string" ? record.key : null;
          if (!key) return null;
          return { key, required: record.required !== false };
        })
        .filter((entry): entry is { key: string; required: boolean } => entry !== null)
    : [];

  const output =
    row.output && typeof row.output === "object" && !Array.isArray(row.output)
      ? (row.output as AgentOutput)
      : null;
  const parsedDurationMs =
    row.duration_ms === null || row.duration_ms === undefined
      ? null
      : Number(row.duration_ms);

  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    key: String(row.task_key),
    role: isAgentRole(row.role) ? row.role : "planner",
    kind: isAgentTaskKind(row.kind) ? row.kind : "plan",
    title: String(row.title ?? ""),
    dependsOn,
    writesFiles: row.writes_files === true,
    required: row.required !== false,
    maxAttempts: Number(row.max_attempts ?? 1),
    status: isAgentTaskStatus(row.status) ? row.status : "failed",
    attempt: Number(row.attempt ?? 0),
    idempotencyKey: String(row.idempotency_key ?? ""),
    output,
    errorClass: typeof row.error_class === "string" ? row.error_class : null,
    errorSummary: typeof row.error_summary === "string" ? row.error_summary : null,
    eligible: row.eligible !== false,
    eligibilityReason:
      typeof row.eligibility_reason === "string"
        ? row.eligibility_reason
        : "legacy_workflow_record",
    scheduledAt: typeof row.scheduled_at === "string" ? row.scheduled_at : null,
    scheduled:
      row.scheduled === true ||
      typeof row.scheduled_at === "string" ||
      row.status === "queued" ||
      row.status === "running" ||
      row.status === "completed" ||
      row.status === "failed",
    scheduleReason: typeof row.schedule_reason === "string" ? row.schedule_reason : null,
    startedAt: typeof row.started_at === "string" ? row.started_at : null,
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
    provider: typeof row.provider === "string" ? row.provider : null,
    model: typeof row.model === "string" ? row.model : null,
    outputProduced: row.output_produced === true || output !== null,
    outputConsumed: row.output_consumed === true,
    durationMs:
      parsedDurationMs !== null && Number.isFinite(parsedDurationMs)
        ? parsedDurationMs
        : null,
    skipReason: typeof row.skip_reason === "string" ? row.skip_reason : null,
    failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null,
    retryCount: Number(row.retry_count ?? 0),
  };
}

function workflowFromRow(row: Record<string, unknown>): WorkflowRow {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    run_id: String(row.run_id),
    user_id: String(row.user_id),
    state: row.state as WorkflowState,
    complexity: row.complexity as TaskComplexity,
    prompt_excerpt: String(row.prompt_excerpt ?? ""),
    plan_context: typeof row.plan_context === "string" ? row.plan_context : null,
    design_directives: typeof row.design_directives === "string" ? row.design_directives : null,
    summary: typeof row.summary === "string" ? row.summary : null,
    error_class: typeof row.error_class === "string" ? row.error_class : null,
    provider_calls: Number(row.provider_calls ?? 0),
    repair_attempts: Number(row.repair_attempts ?? 0),
    reported_cost_usd:
      typeof row.reported_cost_usd === "number" ? row.reported_cost_usd : null,
    cost_known: row.cost_known === true,
    started_at: String(row.started_at),
    finished_at: typeof row.finished_at === "string" ? row.finished_at : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export interface EnsureWorkflowInput {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  runId: string;
  complexity: TaskComplexity;
  promptExcerpt: string;
  startedAt: string;
}

/**
 * Insert once per run, or return the row a previous attempt already created.
 * The unique `run_id` constraint is the idempotency guard; a duplicate delivery
 * never resets progress.
 */
export async function ensureWorkflow(
  input: EnsureWorkflowInput,
): Promise<WorkflowStoreResult<WorkflowRow>> {
  const { data, error } = await input.client
    .from("agent_workflows")
    .insert({
      project_id: input.projectId,
      run_id: input.runId,
      user_id: input.userId,
      state: "queued",
      complexity: input.complexity,
      prompt_excerpt: input.promptExcerpt.slice(0, 500),
      started_at: input.startedAt,
    })
    .select(WORKFLOW_COLUMNS)
    .single();

  if (!error && data) {
    return { ok: true, data: workflowFromRow(data as Record<string, unknown>) };
  }
  if (error && error.code !== "23505") return mapError("ensure workflow", error);

  const existing = await getWorkflowForRun(input.client, input.projectId, input.runId);
  if (isWorkflowStoreFailure(existing)) return existing;
  if (!existing.data) return failure("error", "The workflow row could not be read after insert.");
  return { ok: true, data: existing.data };
}

export async function getWorkflowForRun(
  client: SupabaseClient,
  projectId: string,
  runId: string,
): Promise<WorkflowStoreResult<WorkflowRow | null>> {
  const { data, error } = await client
    .from("agent_workflows")
    .select(WORKFLOW_COLUMNS)
    .eq("project_id", projectId)
    .eq("run_id", runId)
    .maybeSingle();
  if (error) return mapError("read workflow", error);
  return {
    ok: true,
    data: data ? workflowFromRow(data as Record<string, unknown>) : null,
  };
}

export async function getWorkflowById(
  client: SupabaseClient,
  projectId: string,
  workflowId: string,
): Promise<WorkflowStoreResult<WorkflowRow | null>> {
  const { data, error } = await client
    .from("agent_workflows")
    .select(WORKFLOW_COLUMNS)
    .eq("project_id", projectId)
    .eq("id", workflowId)
    .maybeSingle();
  if (error) return mapError("read workflow", error);
  return {
    ok: true,
    data: data ? workflowFromRow(data as Record<string, unknown>) : null,
  };
}

export async function getLatestWorkflow(
  client: SupabaseClient,
  projectId: string,
): Promise<WorkflowStoreResult<WorkflowRow | null>> {
  const { data, error } = await client
    .from("agent_workflows")
    .select(WORKFLOW_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return mapError("read latest workflow", error);
  return {
    ok: true,
    data: data ? workflowFromRow(data as Record<string, unknown>) : null,
  };
}

export interface WorkflowPatch {
  state?: WorkflowState;
  plan_context?: string | null;
  design_directives?: string | null;
  summary?: string | null;
  error_class?: string | null;
  provider_calls?: number;
  repair_attempts?: number;
  reported_cost_usd?: number | null;
  cost_known?: boolean;
  finished_at?: string | null;
}

/**
 * Compare-and-set the workflow. `expectedStates` empty means "any non-terminal
 * writer may apply this patch" and is used only for additive usage counters.
 */
export async function updateWorkflow(
  client: SupabaseClient,
  projectId: string,
  workflowId: string,
  patch: WorkflowPatch,
  expectedStates?: readonly WorkflowState[],
): Promise<WorkflowStoreResult<WorkflowRow | null>> {
  let query = client
    .from("agent_workflows")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("id", workflowId);
  if (expectedStates && expectedStates.length > 0) {
    query = query.in("state", expectedStates as string[]);
  }
  const { data, error } = await query.select(WORKFLOW_COLUMNS).maybeSingle();
  if (error) return mapError("update workflow", error);
  return {
    ok: true,
    data: data ? workflowFromRow(data as Record<string, unknown>) : null,
  };
}

/**
 * Create the planned tasks once. `onConflict` ignores a row a previous attempt
 * already inserted, so resume never duplicates or resets completed work.
 */
export async function ensureTasks(
  client: SupabaseClient,
  workflowId: string,
  projectId: string,
  definitions: readonly AgentTaskDefinition[],
  attempt: number,
): Promise<WorkflowStoreResult<AgentTask[]>> {
  if (definitions.length === 0) return { ok: true, data: [] };

  const rows = definitions.map((definition) => ({
    workflow_id: workflowId,
    project_id: projectId,
    task_key: definition.key,
    role: definition.role,
    kind: definition.kind,
    title: definition.title,
    status: "pending",
    depends_on: definition.dependsOn,
    writes_files: definition.writesFiles,
    required: definition.required,
    max_attempts: definition.maxAttempts,
    attempt,
    idempotency_key: `${workflowId}:${definition.key}:${attempt}`,
    output: null,
    eligible: definition.eligible,
    eligibility_reason: definition.eligibilityReason.slice(0, 200),
    scheduled: false,
    scheduled_at: null,
    schedule_reason: definition.eligible ? null : definition.eligibilityReason.slice(0, 200),
    started_at: null,
    finished_at: null,
    output_produced: false,
    output_consumed: false,
    duration_ms: null,
    skip_reason: null,
    failure_reason: null,
    retry_count: 0,
  }));

  for (const row of rows) {
    if (row.eligible === false) {
      row.status = "skipped";
      row.skip_reason = row.eligibility_reason;
      row.finished_at = new Date().toISOString();
    }
  }

  const { error } = await client
    .from("agent_tasks")
    .upsert(rows, { onConflict: "workflow_id,task_key", ignoreDuplicates: true });
  if (error) return mapError("create tasks", error);
  return listTasks(client, workflowId);
}

export async function listTasks(
  client: SupabaseClient,
  workflowId: string,
): Promise<WorkflowStoreResult<AgentTask[]>> {
  const { data, error } = await client
    .from("agent_tasks")
    .select(TASK_COLUMNS)
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });
  if (error) return mapError("list tasks", error);
  return {
    ok: true,
    data: (data ?? []).map((row) => taskFromRow(row as Record<string, unknown>)),
  };
}

export interface TaskTransition {
  taskKey: string;
  from: readonly AgentTaskStatus[];
  to: AgentTaskStatus;
  attempt?: number;
  output?: AgentOutput | null;
  errorClass?: string | null;
  errorSummary?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  eligible?: boolean;
  eligibilityReason?: string | null;
  scheduledAt?: string | null;
  scheduleReason?: string | null;
  provider?: string | null;
  model?: string | null;
  outputProduced?: boolean;
  outputConsumed?: boolean;
  durationMs?: number | null;
  skipReason?: string | null;
  failureReason?: string | null;
  retryCount?: number;
  scheduled?: boolean;
}

export async function transitionTask(
  client: SupabaseClient,
  workflowId: string,
  projectId: string,
  transition: TaskTransition,
): Promise<WorkflowStoreResult<AgentTask | null>> {
  const patch: Record<string, unknown> = {
    status: transition.to,
    updated_at: new Date().toISOString(),
  };
  if (transition.attempt !== undefined) patch.attempt = transition.attempt;
  if (transition.output !== undefined) patch.output = transition.output;
  if (transition.errorClass !== undefined) patch.error_class = transition.errorClass;
  if (transition.errorSummary !== undefined) patch.error_summary = transition.errorSummary;
  if (transition.startedAt !== undefined) patch.started_at = transition.startedAt;
  if (transition.finishedAt !== undefined) patch.finished_at = transition.finishedAt;
  if (transition.eligible !== undefined) patch.eligible = transition.eligible;
  if (transition.eligibilityReason !== undefined) {
    patch.eligibility_reason = transition.eligibilityReason;
  }
  if (transition.scheduledAt !== undefined) patch.scheduled_at = transition.scheduledAt;
  if (transition.scheduleReason !== undefined) patch.schedule_reason = transition.scheduleReason;
  if (transition.scheduled !== undefined) patch.scheduled = transition.scheduled;
  if (transition.provider !== undefined) patch.provider = transition.provider;
  if (transition.model !== undefined) patch.model = transition.model;
  if (transition.outputProduced !== undefined) patch.output_produced = transition.outputProduced;
  if (transition.outputConsumed !== undefined) patch.output_consumed = transition.outputConsumed;
  if (transition.durationMs !== undefined) patch.duration_ms = transition.durationMs;
  if (transition.skipReason !== undefined) patch.skip_reason = transition.skipReason;
  if (transition.failureReason !== undefined) patch.failure_reason = transition.failureReason;
  if (transition.retryCount !== undefined) patch.retry_count = transition.retryCount;

  const { data, error } = await client
    .from("agent_tasks")
    .update(patch)
    .eq("workflow_id", workflowId)
    .eq("project_id", projectId)
    .eq("task_key", transition.taskKey)
    .in("status", transition.from as string[])
    .select(TASK_COLUMNS)
    .maybeSingle();
  if (error) return mapError("transition task", error);
  return {
    ok: true,
    data: data ? taskFromRow(data as Record<string, unknown>) : null,
  };
}

/** Mark a persisted role result as consumed by a downstream stage. */
export async function markTaskOutputConsumed(
  client: SupabaseClient,
  workflowId: string,
  projectId: string,
  taskKey: string,
): Promise<WorkflowStoreResult<AgentTask | null>> {
  const { data, error } = await client
    .from("agent_tasks")
    .update({ output_consumed: true, updated_at: new Date().toISOString() })
    .eq("workflow_id", workflowId)
    .eq("project_id", projectId)
    .eq("task_key", taskKey)
    .not("output", "is", null)
    .select(TASK_COLUMNS)
    .maybeSingle();
  if (error) return mapError("mark task output consumed", error);
  return {
    ok: true,
    data: data ? taskFromRow(data as Record<string, unknown>) : null,
  };
}

/** Activate the pre-registered failure-only Repair role exactly once. */
export async function activateRepairTask(
  client: SupabaseClient,
  workflowId: string,
  projectId: string,
): Promise<WorkflowStoreResult<AgentTask | null>> {
  const { data, error } = await client
    .from("agent_tasks")
    .update({
      status: "queued",
      eligible: true,
      eligibility_reason: "failure_triggered_repair",
      skip_reason: null,
      scheduled_at: new Date().toISOString(),
      schedule_reason: "failure_triggered_repair",
      scheduled: true,
      attempt: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("workflow_id", workflowId)
    .eq("project_id", projectId)
    .eq("task_key", "repair")
    .eq("role", "repair")
    .eq("status", "skipped")
    .select(TASK_COLUMNS)
    .maybeSingle();
  if (error) return mapError("activate repair task", error);
  return {
    ok: true,
    data: data ? taskFromRow(data as Record<string, unknown>) : null,
  };
}

export async function recordWorkflowEvent(
  client: SupabaseClient,
  input: {
    workflowId: string;
    projectId: string;
    taskKey?: string | null;
    kind: string;
    message: string;
    data?: Record<string, unknown>;
  },
): Promise<WorkflowStoreResult<null>> {
  const { error } = await client.from("agent_workflow_events").insert({
    workflow_id: input.workflowId,
    project_id: input.projectId,
    task_key: input.taskKey ?? null,
    kind: input.kind.slice(0, 80),
    message: input.message.slice(0, 500),
    data: boundedEventData(input.data ?? {}),
  });
  if (error) return mapError("record workflow event", error);
  return { ok: true, data: null };
}

function boundedEventData(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry.slice(0, 500);
    else if (typeof entry === "number" && Number.isFinite(entry)) result[key] = entry;
    else if (typeof entry === "boolean" || entry === null) result[key] = entry;
  }
  return result;
}

export async function listWorkflowEvents(
  client: SupabaseClient,
  workflowId: string,
  limit = 80,
): Promise<WorkflowStoreResult<WorkflowEventRow[]>> {
  const { data, error } = await client
    .from("agent_workflow_events")
    .select("id,workflow_id,project_id,task_key,kind,message,data,created_at")
    .eq("workflow_id", workflowId)
    .order("id", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));
  if (error) return mapError("list workflow events", error);
  return {
    ok: true,
    data: (data ?? []).map((row) => row as unknown as WorkflowEventRow),
  };
}

/** For the owner-facing status API (RLS client), not the worker. */
export async function listOwnedWorkflows(
  client: SupabaseClient,
  projectId: string,
  limit = 10,
): Promise<WorkflowStoreResult<WorkflowRow[]>> {
  const { data, error } = await client
    .from("agent_workflows")
    .select(WORKFLOW_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(50, limit)));
  if (error) return mapError("list workflows", error);
  return {
    ok: true,
    data: (data ?? []).map((row) => workflowFromRow(row as Record<string, unknown>)),
  };
}

const NON_TERMINAL_WORKFLOW_STATES: readonly WorkflowState[] = [
  "queued",
  "planning",
  "executing",
  "verifying",
  "waiting_for_dependency",
  "retrying",
  "awaiting_approval",
];

/** Cancellation may also supersede a failed attempt that has not been resumed. */
const CANCELLABLE_WORKFLOW_STATES: readonly WorkflowState[] = [
  ...NON_TERMINAL_WORKFLOW_STATES,
  "failed",
];

const NON_TERMINAL_TASK_STATUSES: readonly AgentTaskStatus[] = [
  "pending",
  "waiting_for_dependency",
  "queued",
  "running",
];

const CANCELLABLE_TASK_STATUSES: readonly AgentTaskStatus[] = [
  ...NON_TERMINAL_TASK_STATUSES,
  "failed",
];

/**
 * Worker-side cancellation for a run the user cancelled. It uses the run's own
 * client (the confined service-role client in worker mode) and never reopens a
 * terminal workflow. A task that already finished keeps its terminal status.
 */
export async function cancelWorkflowForRun(
  client: SupabaseClient,
  projectId: string,
  runId: string,
  summary = "The run was cancelled by the user.",
): Promise<WorkflowStoreResult<WorkflowRow | null>> {
  const workflow = await getWorkflowForRun(client, projectId, runId);
  if (isWorkflowStoreFailure(workflow)) return workflow;
  if (!workflow.data) return { ok: true, data: null };
  if (!CANCELLABLE_WORKFLOW_STATES.includes(workflow.data.state)) {
    return { ok: true, data: workflow.data };
  }

  const finishedAt = new Date().toISOString();
  const updated = await updateWorkflow(
    client,
    projectId,
    workflow.data.id,
    { state: "cancelled", summary, finished_at: finishedAt },
    CANCELLABLE_WORKFLOW_STATES,
  );
  if (isWorkflowStoreFailure(updated)) return updated;

  const { error: taskError } = await client
    .from("agent_tasks")
    .update({ status: "cancelled", finished_at: finishedAt, updated_at: finishedAt })
    .eq("workflow_id", workflow.data.id)
    .in("status", CANCELLABLE_TASK_STATUSES as string[]);
  if (taskError) return mapError("cancel tasks", taskError);

  await recordWorkflowEvent(client, {
    workflowId: workflow.data.id,
    projectId,
    kind: "workflow.cancelled",
    message: "The workflow was cancelled with its run.",
  });
  return { ok: true, data: updated.data };
}

/**
 * Worker-side failure for a run that failed outside the orchestration handle's
 * scope (an unexpected throw). A workflow row is only a record; this never
 * changes the run's own retry/failure classification.
 */
export async function failWorkflowForRun(
  client: SupabaseClient,
  projectId: string,
  runId: string,
  errorClass: string,
  summary: string,
): Promise<WorkflowStoreResult<WorkflowRow | null>> {
  const workflow = await getWorkflowForRun(client, projectId, runId);
  if (isWorkflowStoreFailure(workflow)) return workflow;
  if (!workflow.data) return { ok: true, data: null };
  if (!NON_TERMINAL_WORKFLOW_STATES.includes(workflow.data.state)) {
    return { ok: true, data: workflow.data };
  }

  const finishedAt = new Date().toISOString();
  const updated = await updateWorkflow(
    client,
    projectId,
    workflow.data.id,
    {
      state: "failed",
      summary: summary.slice(0, 500),
      error_class: errorClass.slice(0, 80),
      finished_at: finishedAt,
    },
    NON_TERMINAL_WORKFLOW_STATES,
  );
  if (isWorkflowStoreFailure(updated)) return updated;

  const { error: taskError } = await client
    .from("agent_tasks")
    .update({ status: "failed", finished_at: finishedAt, updated_at: finishedAt })
    .eq("workflow_id", workflow.data.id)
    .in("status", ["pending", "waiting_for_dependency", "queued", "running"] as string[]);
  if (taskError) return mapError("fail tasks", taskError);

  await recordWorkflowEvent(client, {
    workflowId: workflow.data.id,
    projectId,
    kind: "workflow.failed",
    message: "The workflow ended when its run failed.",
    data: { errorClass },
  });
  return { ok: true, data: updated.data };
}

/**
 * Owner cancellation through the migration-29 SECURITY DEFINER RPC. The browser
 * cannot UPDATE the tables, so this is the only authenticated mutation path.
 */
export async function cancelOwnedWorkflow(
  client: SupabaseClient,
  projectId: string,
  workflowId: string,
  summary = "Cancelled by the project owner.",
): Promise<WorkflowStoreResult<WorkflowRow | null>> {
  const { data, error } = await client.rpc("cancel_agent_workflow", {
    p_project_id: projectId,
    p_workflow_id: workflowId,
    p_summary: summary.slice(0, 500),
  });
  if (error) return mapError("cancel workflow", error);
  const payload = recordOrNull(data);
  if (payload?.ok !== true) {
    return failure(
      "conflict",
      typeof payload?.error === "string" ? payload.error : "The workflow could not be cancelled.",
    );
  }
  return getWorkflowById(client, projectId, workflowId);
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
