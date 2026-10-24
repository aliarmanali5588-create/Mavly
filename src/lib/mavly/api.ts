/**
 * Local implementation of the `/api/vcaas/*` surface the UI already calls.
 *
 * The catch-all performs authentication, path classification and ownership
 * checks before this module runs. Every handler here works only for the verified
 * `userId` it is given and uses the caller's RLS-scoped Supabase client.
 */

import { NextResponse, after } from "next/server";

import type { VcaasScope } from "@/lib/vcaas-scope";
import type {
  AgentStatus,
  ConversationHistory,
  ConversationMessage,
  DeploymentStatus,
  FileContent,
  FileTree,
  FileTreeEntry,
  FileWriteResult,
  ProjectLaunchResult,
  ProjectSnapshot,
  ProjectSnapshotDetail,
  RestoreResult,
  VcaasProject,
  VcaasProjectSummary,
} from "@/lib/vcaas-types";
import { isAiConfigured } from "@/lib/ai/openrouter";
import { resolveModel } from "@/lib/ai/models";
import { sanitizeProjectPath } from "@/lib/ai/agent";
import { validateProjectSlug } from "@/lib/project-slug";
import { resolveStaticPreview } from "@/lib/static-site";
import {
  createOwnedProject,
  createRun,
  deleteProject,
  finishRun,
  getFile,
  getProject,
  insertMessage,
  isStoreFailure,
  latestRun,
  listFiles,
  listMessages,
  listProjects,
  updateProject,
  writeFiles,
  type MessageRow,
  type ProjectRow,
  type RunRow,
} from "./store";
import { runAgent } from "./run-agent";
import {
  getDeploymentRow,
  isDeploymentStoreFailure,
  type DeploymentRow,
} from "@/lib/deployments/store";
import {
  deploymentHost,
  discardVercelProject,
  getProjectDeploymentStatus,
  isDeploymentServiceFailure,
  publishProject,
  wireDeploymentStatus,
} from "@/lib/deployments/service";
import {
  getSnapshot,
  hashSource,
  isSnapshotFailure,
  listSnapshots,
} from "./snapshots";
import { restoreSnapshot } from "./restore";
import {
  connectFigma,
  consumeFigmaValidationAllowance,
  disconnectFigma,
  getFigmaStatus,
  validateFigmaToken,
  type FigmaServiceFailure,
} from "@/lib/integrations/figma/service";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" } as const;
const RUN_STALE_MS = 10 * 60_000;

function rebuildUnavailable(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "Rebuilding is not available in this Mavly build. The preview is static and generated apps are not run.",
      code: "BACKEND_NOT_CONFIGURED",
      data: null,
    },
    { status: 503, headers: NO_STORE },
  );
}

/** An `init` run older than the route budget is treated as dead, not as running forever. */
function isRunActive(run: RunRow | null): boolean {
  if (run?.status !== "init") return false;
  const started = Date.parse(run.started_at);
  return Number.isFinite(started) && Date.now() - started < RUN_STALE_MS;
}

export interface MavlyRequest {
  method: string;
  segments: readonly string[];
  scope: VcaasScope;
  userId: string;
  body: unknown;
  query: URLSearchParams;
}

/**
 * Return `null` when this path is not implemented yet; the caller then answers
 * the explicit `BACKEND_NOT_CONFIGURED` 503.
 */
export async function handleMavlyVcaasRequest(input: MavlyRequest): Promise<NextResponse | null> {
  const { method, segments, scope, userId, body, query } = input;

  if (scope.kind === "account" && scope.resource === "project-list" && method === "GET") {
    return listProjectResponse(userId);
  }

  if (scope.kind === "account" && scope.resource === "credit-costs" && method === "GET") {
    return ok({ creditCosts: {} });
  }

  if (scope.kind === "account" && scope.resource === "figma-validate" && method === "POST") {
    return figmaValidateResponse(userId, body);
  }

  if (scope.kind === "create") {
    if (scope.mode === "create" && method === "POST") return createProjectResponse(userId, body);
    if (scope.mode === "launch" && method === "POST") return launchProjectResponse(userId, body);
    return null;
  }

  if (scope.kind !== "project") return null;
  const projectId = scope.projectId;
  const action = segments.slice(2).join("/");

  if (!action) {
    if (method === "GET") return projectResponse(userId, projectId);
    if (method === "PATCH") return updateProjectResponse(userId, projectId, body);
    if (method === "DELETE") return deleteProjectResponse(userId, projectId);
    return null;
  }

  if (action === "agent/start" && method === "POST") {
    return startAgentResponse(userId, projectId, body);
  }
  if (action === "agent/status" && method === "GET") {
    return agentStatusResponse(projectId);
  }
  if (action === "agent/progress" && method === "GET") {
    return agentProgressResponse(projectId);
  }
  if (action === "agent/full-conversation" && method === "GET") {
    return conversationResponse(projectId, query);
  }
  if (action === "deployments/deploy" && method === "POST") {
    return deployResponse(userId, projectId);
  }
  if (action === "deployments/status" && method === "GET") {
    return deploymentStatusResponse(userId, projectId);
  }
  if (action === "figma/status" && method === "GET") {
    return figmaStatusResponse(userId, projectId, query);
  }
  if (action === "figma/connect") {
    if (method === "POST") return figmaConnectResponse(userId, projectId, body);
    if (method === "DELETE") return figmaDisconnectResponse(userId, projectId);
  }
  if (action === "files/tree" && method === "GET") {
    return fileTreeResponse(projectId, query);
  }
  if (action === "files/content") {
    if (method === "GET") return fileContentResponse(projectId, query);
    if (method === "PUT") return fileWriteResponse(userId, projectId, body);
  }
  if (action === "rebuild" && method === "POST") {
    return rebuildUnavailable();
  }
  if (action === "rebuild/status" && method === "GET") {
    return rebuildUnavailable();
  }

  /**
   * ═══ RESTORE POINTS ═══════════════════════════════════════════════════════
   *
   *   GET  …/snapshots                    — the project's recovery points
   *   GET  …/snapshots/{id}               — one of them, with its file list
   *   POST …/snapshots/{id}/restore       — restore it over the project
   *
   * ⚠️ THE PROJECT IN THE PATH IS THE ONLY PROJECT. A snapshot id from another
   * project is not found — the query is scoped to the project, so the answer
   * never discloses that the id exists elsewhere.
   */
  if (action === "snapshots" && method === "GET") {
    return snapshotListResponse(projectId, query);
  }
  if (action.startsWith("snapshots/")) {
    const rest = action.slice("snapshots/".length).split("/");
    const snapshotId = rest[0];
    if (!snapshotId) return null;
    if (rest.length === 1 && method === "GET") {
      return snapshotDetailResponse(projectId, snapshotId);
    }
    if (rest.length === 2 && rest[1] === "restore" && method === "POST") {
      return snapshotRestoreResponse(userId, projectId, snapshotId, body);
    }
  }

  return null;
}

async function listProjectResponse(userId: string): Promise<NextResponse> {
  const result = await listProjects(userId);
  if (isStoreFailure(result)) return fail(500, "UNKNOWN", "Could not load projects.");

  const data: VcaasProjectSummary[] = result.data.map((row) => ({
    projectId: row.project_id,
    engineVersion: "v2",
    lifecycleState: "active",
    description: row.description,
    label: row.label ?? undefined,
    plan: "free",
    createdAt: row.created_at,
    lastModifiedAt: row.updated_at,
    previewImageUrl: null,
    createdVia: "ui",
  }));

  return ok(data);
}

async function createProjectResponse(userId: string, body: unknown): Promise<NextResponse> {
  const record = recordOf(body);
  const requestedId = stringOf(record.projectId)?.trim() ?? "";
  const problem = validateProjectSlug(requestedId);
  if (problem) return fail(400, "VALIDATION", "Invalid project name.");

  const description = stringOf(record.description)?.slice(0, 2_000) ?? "";
  const label = stringOf(record.label)?.slice(0, 120) ?? requestedId;

  const created = await createOwnedProject(userId, requestedId, description, label);
  if (isStoreFailure(created)) return fail(created.code === "CONFLICT" ? 409 : 500, created.code ?? "UNKNOWN", created.error);

  return ok(projectFromRow(created.data, null, false, null, null));
}

async function launchProjectResponse(userId: string, body: unknown): Promise<NextResponse> {
  if (!isAiConfigured()) {
    return fail(503, "BACKEND_NOT_CONFIGURED", "OpenRouter is not configured. Add OPENROUTER_API_KEY on the server.");
  }

  const record = recordOf(body);
  const prompt = (stringOf(record.prompt)?.trim() ?? "").slice(0, 32_000);
  if (!prompt) return fail(400, "VALIDATION", "A prompt is required.");

  const requestedId = stringOf(record.projectId)?.trim() ?? "";
  const problem = validateProjectSlug(requestedId);
  if (problem) return fail(400, "VALIDATION", "Invalid project name.");

  const description = stringOf(record.description)?.slice(0, 2_000) || prompt.slice(0, 200);
  const label = stringOf(record.label)?.slice(0, 120) || requestedId;

  const created = await createOwnedProject(userId, requestedId, description, label);
  if (isStoreFailure(created)) return fail(created.code === "CONFLICT" ? 409 : 500, created.code ?? "UNKNOWN", created.error);

  const warnings: NonNullable<ProjectLaunchResult["warnings"]> = [];
  if (record.figma !== undefined && record.figma !== null) {
    const figma = recordOf(record.figma);
    const connected = await connectFigma(created.data.project_id, userId, figma.token);
    if (connected.ok === false) {
      warnings.push({
        step: "figma",
        errorCode: connected.code,
        errorMessage: connected.error,
        endpoint: "figma/connect",
      });
    }
  }

  const model = resolveModel(stringOf(record.model), "app-generation");
  const run = await createRun(created.data.project_id, model.id, prompt);
  if (isStoreFailure(run)) {
    await deleteProject(userId, created.data.project_id);
    return fail(500, "UNKNOWN", "Could not start the agent.");
  }

  const message = await insertMessage(created.data.project_id, "user", prompt);
  if (isStoreFailure(message)) {
    await deleteProject(userId, created.data.project_id);
    return fail(500, "UNKNOWN", "Could not start the agent.");
  }

  after(() =>
    runAgent({
      userId,
      projectId: created.data.project_id,
      runId: run.data.id,
      prompt,
      requestedModel: stringOf(record.model),
    }),
  );

  const data: ProjectLaunchResult = {
    projectId: created.data.project_id,
    ...(created.data.project_id !== requestedId ? { requestedProjectId: requestedId } : {}),
    agent: { started: true, status: "init" },
    warnings,
  };
  return ok(data);
}

async function projectResponse(userId: string, projectId: string): Promise<NextResponse> {
  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) return fail(500, "UNKNOWN", "Could not load this project.");
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");

  const run = await latestRun(projectId);
  if (isStoreFailure(run)) return fail(500, "UNKNOWN", "Could not load this project.");
  const preview = await staticPreviewState(projectId);
  const deployment = await getDeploymentRow(projectId);

  return ok(
    projectFromRow(
      project.data,
      run.data,
      preview.available,
      preview.reason,
      isDeploymentStoreFailure(deployment) ? null : deployment.data,
    ),
  );
}

async function updateProjectResponse(userId: string, projectId: string, body: unknown): Promise<NextResponse> {
  const record = recordOf(body);
  const updated = await updateProject(userId, projectId, {
    ...(record.label !== undefined ? { label: stringOf(record.label) ?? null } : {}),
    ...(record.description !== undefined ? { description: stringOf(record.description) ?? "" } : {}),
  });
  if (isStoreFailure(updated)) return fail(500, "UNKNOWN", "Could not update this project.");

  const run = await latestRun(projectId);
  const preview = await staticPreviewState(projectId);
  const deployment = await getDeploymentRow(projectId);
  return ok(
    projectFromRow(
      updated.data,
      isStoreFailure(run) ? null : run.data,
      preview.available,
      preview.reason,
      isDeploymentStoreFailure(deployment) ? null : deployment.data,
    ),
  );
}

async function deleteProjectResponse(userId: string, projectId: string): Promise<NextResponse> {
  const deployment = await getDeploymentRow(projectId);
  const deleted = await deleteProject(userId, projectId);
  if (isStoreFailure(deleted)) return fail(500, "UNKNOWN", "Could not delete this project.");

  /**
   * The local delete must succeed even if Vercel cleanup does not. Run the
   * remote delete after the response and never report a fabricated failure.
   */
  if (!isDeploymentStoreFailure(deployment) && deployment.data) {
    const deploymentRow = deployment.data;
    after(() => discardVercelProject(deploymentRow));
  }

  return ok({ deleted: true });
}

async function deployResponse(userId: string, projectId: string): Promise<NextResponse> {
  const result = await publishProject(userId, projectId);
  if (isDeploymentServiceFailure(result)) {
    return fail(
      result.status,
      result.code,
      result.error,
      result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : undefined,
    );
  }
  return ok(result.data);
}

async function deploymentStatusResponse(userId: string, projectId: string): Promise<NextResponse> {
  const result = await getProjectDeploymentStatus(userId, projectId);
  if (isDeploymentServiceFailure(result)) return fail(result.status, result.code, result.error);
  return ok(result.data satisfies DeploymentStatus);
}

async function figmaValidateResponse(userId: string, body: unknown): Promise<NextResponse> {
  if (!consumeFigmaValidationAllowance(userId)) {
    return fail(429, "RATE_LIMITED", "Too many Figma checks. Wait a minute and try again.");
  }

  const token = recordOf(body).token;
  const result = await validateFigmaToken(token);
  if (result.ok === false) return figmaFail(result);
  return ok(result.data);
}

async function figmaStatusResponse(
  userId: string,
  projectId: string,
  query: URLSearchParams,
): Promise<NextResponse> {
  const result = await getFigmaStatus(projectId, userId, query.get("verify") === "true");
  if (result.ok === false) return figmaFail(result);
  return ok(result.data);
}

async function figmaConnectResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  const result = await connectFigma(projectId, userId, recordOf(body).token);
  if (result.ok === false) return figmaFail(result);
  return ok(result.data);
}

async function figmaDisconnectResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await disconnectFigma(projectId, userId);
  if (result.ok === false) return figmaFail(result);
  return ok(result.data);
}

function figmaFail(result: FigmaServiceFailure): NextResponse {
  return fail(result.status, result.code, result.error);
}

async function startAgentResponse(userId: string, projectId: string, body: unknown): Promise<NextResponse> {
  if (!isAiConfigured()) {
    return fail(503, "BACKEND_NOT_CONFIGURED", "OpenRouter is not configured. Add OPENROUTER_API_KEY on the server.");
  }

  const record = recordOf(body);
  const prompt = (stringOf(record.prompt)?.trim() ?? "").slice(0, 32_000);
  if (!prompt) return fail(400, "VALIDATION", "A prompt is required.");

  const current = await latestRun(projectId);
  if (isStoreFailure(current)) return fail(500, "UNKNOWN", "Could not start the agent.");
  if (isRunActive(current.data)) {
    return fail(409, "VALIDATION", "An agent run is already in progress.");
  }
  if (current.data?.status === "init") {
    await finishRun(current.data.id, "error", "The previous run timed out.");
  }

  const model = resolveModel(stringOf(record.model), "app-generation");
  const run = await createRun(projectId, model.id, prompt);
  if (isStoreFailure(run)) {
    return fail(run.code === "23505" ? 409 : 500, "VALIDATION", "Could not start the agent.");
  }

  const message = await insertMessage(projectId, "user", prompt);
  if (isStoreFailure(message)) {
    await finishRun(run.data.id, "error", "Could not save the prompt.");
    return fail(500, "UNKNOWN", "Could not start the agent.");
  }

  after(() =>
    runAgent({
      userId,
      projectId,
      runId: run.data.id,
      prompt,
      requestedModel: stringOf(record.model),
    }),
  );

  return ok({ status: "init", runId: run.data.id });
}

async function agentStatusResponse(projectId: string): Promise<NextResponse> {
  const run = await latestRun(projectId);
  if (isStoreFailure(run)) return fail(500, "UNKNOWN", "Could not load the agent status.");
  if (!run.data) {
    return ok({
      projectId,
      status: "idle",
      startedAt: null,
      realtimeConversation: [],
    } satisfies AgentStatus);
  }

  const messages = await listMessages(projectId, { limit: 100 });
  const realtimeConversation = isStoreFailure(messages)
    ? []
    : messages.data
        .filter((message) => message.created_at >= run.data!.started_at)
        .map(toConversationMessage);

  const status = isRunActive(run.data) ? "init" : "done";
  return ok({
    projectId,
    status,
    startedAt: run.data.started_at,
    realtimeConversation,
    expectedMinutes: status === "init" ? 2 : null,
    expectedFinishAt: status === "init"
      ? new Date(Date.parse(run.data.started_at) + 120_000).toISOString()
      : null,
    runId: run.data.id,
  } satisfies AgentStatus);
}

async function agentProgressResponse(projectId: string): Promise<NextResponse> {
  const run = await latestRun(projectId);
  if (isStoreFailure(run)) return fail(500, "UNKNOWN", "Could not load the agent progress.");
  if (!run.data) return fail(404, "PROJECT_NOT_FOUND", "No agent run found.");

  const startedAt = Date.parse(run.data.started_at);
  if (!Number.isFinite(startedAt)) {
    return fail(500, "UNKNOWN", "Could not read the agent run start time.");
  }

  const active = isRunActive(run.data);
  const stage = active
    ? Date.now() - startedAt < 10_000
      ? "starting"
      : "thinking"
    : run.data.status === "done"
      ? "done"
      : run.data.status === "error"
        ? "failed"
        : "incomplete";

  return ok({
    runId: run.data.id,
    stage,
    startedAt: run.data.started_at,
    turns: 0,
    steps: [],
    totalSteps: 0,
    files: [],
  });
}

async function conversationResponse(projectId: string, query: URLSearchParams): Promise<NextResponse> {
  const limitRaw = Number(query.get("limit"));
  const offsetRaw = Number(query.get("offsetFromEnd"));
  const result = await listMessages(projectId, {
    ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
    ...(Number.isFinite(offsetRaw) && offsetRaw > 0 ? { offsetFromEnd: offsetRaw } : {}),
  });
  if (isStoreFailure(result)) return fail(500, "UNKNOWN", "Could not load the conversation.");

  const history: ConversationHistory = {
    conversation: result.data.map(toConversationMessage),
  };
  return ok(history);
}

async function fileTreeResponse(projectId: string, query: URLSearchParams): Promise<NextResponse> {
  const files = await listFiles(projectId);
  if (isStoreFailure(files)) return fail(500, "UNKNOWN", "Could not load the project files.");

  const pathFilter = query.get("path")?.replace(/^\/+|\/+$/g, "") || "";
  const limit = clampInt(query.get("limit"), 1, 10_000, 5_000);
  const offset = clampInt(query.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0);

  const visible = pathFilter
    ? files.data.filter((file) => file.path === pathFilter || file.path.startsWith(`${pathFilter}/`))
    : files.data;

  const folders = new Set<string>();
  for (const file of visible) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }

  const entries: FileTreeEntry[] = [
    ...[...folders].map((path) => ({
      path,
      name: path.split("/").pop() ?? path,
      type: "folder" as const,
      depth: path.split("/").length - 1,
    })),
    ...visible.map((file) => ({
      path: file.path,
      name: file.path.split("/").pop() ?? file.path,
      type: "file" as const,
      size: Buffer.byteLength(file.content, "utf8"),
      depth: file.path.split("/").length - 1,
    })),
  ].sort((a, b) => a.path.localeCompare(b.path));

  const page = entries.slice(offset, offset + limit);
  const latest = visible.reduce((max, file) => (file.updated_at > max ? file.updated_at : max), "");
  const data: FileTree = {
    entries: page,
    totalEntries: entries.length,
    offset,
    limit,
    hasMore: offset + page.length < entries.length,
    commitSha: latest || null,
    filesCount: visible.length,
  };
  return ok(data);
}

async function fileContentResponse(projectId: string, query: URLSearchParams): Promise<NextResponse> {
  const path = sanitizeProjectPath(query.get("path"));
  if (!path) return fail(400, "VALIDATION", "A valid file path is required.");

  const file = await getFile(projectId, path);
  if (isStoreFailure(file)) return fail(500, "UNKNOWN", "Could not load that file.");
  if (!file.data) return fail(404, "PROJECT_NOT_FOUND", "File not found.");

  const data: FileContent = {
    path: file.data.path,
    name: file.data.path.split("/").pop() ?? file.data.path,
    size: Buffer.byteLength(file.data.content, "utf8"),
    encoding: "utf8",
    content: file.data.content,
    commitSha: file.data.updated_at,
  };
  return ok(data);
}

async function fileWriteResponse(userId: string, projectId: string, body: unknown): Promise<NextResponse> {
  const record = recordOf(body);
  const path = sanitizeProjectPath(record.path);
  if (!path) return fail(400, "VALIDATION", "A valid file path is required.");

  const raw = stringOf(record.content);
  if (raw === null) return fail(400, "VALIDATION", "File content is required.");
  const content = record.encoding === "base64"
    ? Buffer.from(raw, "base64").toString("utf8")
    : raw;

  if (Buffer.byteLength(content, "utf8") > 256 * 1024) {
    return fail(400, "VALIDATION", "That file is too large.");
  }

  const before = await getFile(projectId, path);
  const written = await writeFiles(userId, projectId, [{ path, content }]);
  if (isStoreFailure(written)) return fail(500, "UNKNOWN", "Could not save that file.");

  const data: FileWriteResult = {
    path,
    saved: true,
    bytesWritten: Buffer.byteLength(content, "utf8"),
    created: isStoreFailure(before) || !before.data,
    rebuildRequired: false,
  };
  return ok(data);
}

/**
 * The project's recovery points, newest first.
 */
async function snapshotListResponse(
  projectId: string,
  query: URLSearchParams,
): Promise<NextResponse> {
  const limitRaw = Number(query.get("limit"));
  const limit = clampInt(query.get("limit"), 1, 200, 50);
  const result = await listSnapshots(projectId, {
    ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit } : {}),
  });
  if (isSnapshotFailure(result)) {
    return fail(500, "UNKNOWN", "Could not load the recovery points.");
  }

  const snapshots: ProjectSnapshot[] = result.data.map((snapshot) => ({
    id: snapshot.id,
    projectId: snapshot.projectId,
    runId: snapshot.runId,
    kind: snapshot.kind,
    description: snapshot.description,
    sourceHash: snapshot.sourceHash,
    fileCount: snapshot.fileCount,
    changedPaths: snapshot.changedPaths,
    status: snapshot.status,
    restoredAt: snapshot.restoredAt,
    restoreOfSnapshotId: snapshot.restoreOfSnapshotId,
    createdAt: snapshot.createdAt,
  }));
  return ok({ snapshots });
}

/**
 * One recovery point: its metadata, the paths it holds (never their content)
 * and the hash of the project's current source, which the client sends back
 * when it asks to restore, so a stale restore can be refused.
 */
async function snapshotDetailResponse(
  projectId: string,
  snapshotId: string,
): Promise<NextResponse> {
  const snapshot = await getSnapshot(projectId, snapshotId);
  if (isSnapshotFailure(snapshot)) {
    if (snapshot.code === "snapshot_missing") {
      return fail(404, "SNAPSHOT_NOT_FOUND", "That recovery point does not exist.");
    }
    return fail(500, "UNKNOWN", "Could not load that recovery point.");
  }

  const current = await listFiles(projectId);
  const currentFiles = isStoreFailure(current)
    ? []
    : current.data.map((file) => ({ path: file.path, content: file.content }));

  const data: ProjectSnapshotDetail = {
    id: snapshot.data.id,
    projectId: snapshot.data.projectId,
    runId: snapshot.data.runId,
    kind: snapshot.data.kind,
    description: snapshot.data.description,
    sourceHash: snapshot.data.sourceHash,
    fileCount: snapshot.data.fileCount,
    changedPaths: snapshot.data.changedPaths,
    status: snapshot.data.status,
    restoredAt: snapshot.data.restoredAt,
    restoreOfSnapshotId: snapshot.data.restoreOfSnapshotId,
    createdAt: snapshot.data.createdAt,
    files: snapshot.data.files.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content, "utf8"),
    })),
    projectSourceHash: hashSource(currentFiles),
  };
  return ok(data);
}

/**
 * Restore a recovery point over the project.
 *
 * ⚠️ THE PRE-RESTORE STATE IS CAPTURED FIRST, INSIDE `restoreSnapshot`, so the
 * restore is itself recoverable. If that capture fails the restore is stopped
 * before a single file is written.
 */
async function snapshotRestoreResponse(
  userId: string,
  projectId: string,
  snapshotId: string,
  body: unknown,
): Promise<NextResponse> {
  const record = recordOf(body);
  const expected = stringOf(record.expectedSourceHash);
  const description = stringOf(record.description);

  const outcome = await restoreSnapshot({
    userId,
    projectId,
    snapshotId,
    expectedSourceHash: expected ?? null,
    ...(description ? { description } : {}),
  });

  if (isSnapshotFailure(outcome)) {
    if (outcome.code === "snapshot_missing") {
      return fail(404, "SNAPSHOT_NOT_FOUND", "That recovery point does not exist.");
    }
    if (outcome.code === "snapshot_not_ready") {
      return fail(409, "SNAPSHOT_NOT_READY", outcome.error);
    }
    if (outcome.code === "source_conflict") {
      return fail(409, "SOURCE_CONFLICT", outcome.error);
    }
    return fail(500, "UNKNOWN", outcome.error);
  }

  const restored = outcome.data;

  /**
   * ⭐ THE RESTORE IS RECORDED IN THE CONVERSATION. The user can see what was
   * undone, and the message is part of the history the chat renders.
   */
  const touched = restored.added.length + restored.modified.length + restored.removed.length;
  await insertMessage(
    projectId,
    "agent",
    `Restored the code to the recovery point from before that run. ${touched} ${touched === 1 ? "file" : "files"} changed. You can undo this restore from the recovery points.`,
    "regular",
  );

  const data: RestoreResult = {
    snapshotId: restored.snapshotId,
    recoverySnapshotId: restored.recoverySnapshotId,
    added: restored.added,
    modified: restored.modified,
    removed: restored.removed,
    sourceHash: restored.sourceHash,
    fileCount: restored.fileCount,
  };
  return ok(data);
}

async function staticPreviewState(
  projectId: string,
): Promise<{ available: boolean; reason: string | null }> {
  const files = await listFiles(projectId);
  if (!files.ok) return { available: false, reason: null };
  const resolved = resolveStaticPreview(
    files.data.map((file) => ({ path: file.path, content: file.content })),
  );
  return {
    available: resolved.site !== null,
    reason: resolved.unsupported ? resolved.reason : null,
  };
}

function projectFromRow(
  row: ProjectRow,
  run: RunRow | null,
  preview: boolean,
  previewUnavailableReason: string | null,
  deployment: DeploymentRow | null,
): VcaasProject {
  const previewPath = `/api/preview/${encodeURIComponent(row.project_id)}/`;
  const previewUrl = preview ? previewPath : null;
  const deploymentWire = deployment ? wireDeploymentStatus(deployment) : null;
  const deploymentStatus: "deploying" | "success" | "error" =
    deploymentWire?.status === "success"
      ? "success"
      : deploymentWire?.status === "error"
        ? "error"
        : deployment
          ? "deploying"
          : "error";
  const domainFailed = deploymentWire?.errorDetails?.stage === "domain";
  /**
   * Only a successful deployment is a production address. For a Mavly publish
   * that also means the domain is verified; `deploymentHost` withholds the host
   * until then. The Vercel project exists earlier, but presenting its host while
   * a build or domain check is pending would let the copied UI treat a dead site
   * as published.
   */
  const liveHost = deployment && deploymentStatus === "success" ? deploymentHost(deployment) : "";

  return {
    projectId: row.project_id,
    label: row.label ?? undefined,
    description: row.description,
    plan: "free",
    agentProcessStatus: isRunActive(run) ? "init" : run ? "done" : "idle",
    agentServerStatus: "Active",
    createdAt: row.created_at,
    deployment: deployment
      ? {
          status: deploymentStatus,
          createdAt: deployment.last_published_at ?? deployment.created_at,
          ...(deployment.vercel_deployment_id
            ? { versionId: deployment.vercel_deployment_id }
            : {}),
        }
      : null,
    lastDeployError:
      deployment && deploymentStatus === "error"
        ? {
            stage: domainFailed ? "domain" : "build",
            title: domainFailed ? "Domain setup failed" : "Publish failed",
            message: domainFailed
              ? deployment.mavly_domain_error ||
                deployment.error_message ||
                "Vercel could not verify this Mavly address."
              : deployment.error_message || "Vercel could not finish the deployment.",
            at: deployment.last_published_at ?? deployment.updated_at,
          }
        : null,
    versionRecovery: null,
    importInProgress: null,
    secrets: [],
    customDomain: null,
    temporalDevelopmentProjectUrl: previewUrl,
    cachedDevelopmentUrl: null,
    developmentUrlFieldToUse: "temporalDevelopmentProjectUrl",
    productionProjectUrl: liveHost,
    previewImageUrl: null,
    engineVersion: "v2",
    preview: previewUrl
      ? { temporalLinkUrl: previewUrl, url: previewUrl, deployState: "idle" }
      : null,
    previewUnavailableReason,
    lifecycle: { state: "active", pausedAt: null, resumable: false },
    state: "active",
    busy: run && isRunActive(run) ? { kind: "agent", startedAt: run.started_at } : null,
    currentRun: run ? { runId: run.id, status: run.status } : null,
    sandbox: null,
    operations: [],
  };
}

function toConversationMessage(row: MessageRow): ConversationMessage {
  return {
    author: row.author,
    message: row.message,
    messageType: row.message_type as ConversationMessage["messageType"],
    createdAt: row.created_at,
    ...(row.restore_snapshot_id ? { restoreSnapshotId: row.restore_snapshot_id } : {}),
  };
}

function ok(data: unknown): NextResponse {
  return NextResponse.json({ ok: true, data }, { headers: NO_STORE });
}

function fail(
  status: number,
  code: string,
  error: string,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json(
    { ok: false, error, code, data: null },
    { status, headers: { ...NO_STORE, ...(headers ?? {}) } },
  );
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
