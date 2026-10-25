/**
 * Local implementation of the `/api/vcaas/*` surface the UI already calls.
 *
 * The catch-all performs authentication, path classification and ownership
 * checks before this module runs. Every handler here works only for the verified
 * `userId` it is given and uses the caller's RLS-scoped Supabase client.
 */

import { NextResponse, after } from "next/server";

import type { VcaasScope } from "@/lib/vcaas-scope";
import {
  PROJECT_ACTIVITY_LIMIT,
  projectActivityRangeOf,
  type ProjectActivity,
  type ProjectActivityDay,
  type ProjectActivityOutcome,
  type ProjectActivityRange,
  type ProjectActivityRun,
} from "@/lib/project-activity";
import type {
  AgentStatus,
  ConversationHistory,
  ConversationMessage,
  DeploymentStatus,
  FileContent,
  FileTree,
  FileTreeEntry,
  FileWriteResult,
  ImageGenerationResult,
  ProjectLaunchResult,
  ProjectSnapshot,
  ProjectSnapshotDetail,
  RestoreResult,
  VcaasProject,
  VcaasProjectSummary,
  VcaasSecret,
} from "@/lib/vcaas-types";
import { isAiConfigured } from "@/lib/ai/openrouter";
import { resolveModel } from "@/lib/ai/models";
import { parseImageGenerationRequest, resolveImageModel } from "@/lib/ai/image-models";
import {
  generateImage,
  isImageGenerationFailure,
  type ImageGenerationFailure,
} from "@/lib/ai/openrouter-images";
import { sanitizeProjectPath } from "@/lib/ai/agent";
import { validateProjectSlug } from "@/lib/project-slug";
import { resolveStaticPreview } from "@/lib/static-site";
import {
  createGenerationJob,
  createOwnedProject,
  deleteProject,
  finishRun,
  getFile,
  getProject,
  getRun,
  insertMessage,
  isStoreFailure,
  latestRun,
  listFiles,
  listMessages,
  listProjects,
  listRunActivity,
  listRunBatches,
  resumeRun,
  updateProject,
  writeFiles,
  type MessageRow,
  type ProjectRow,
  type RunRow,
  type RunStage,
} from "./store";
import { runAgent } from "./run-agent";
import { imageGenerationLimiter, type ImageGenerationLimitDecision } from "./image-limits";
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
import {
  createProjectSecret,
  deleteProjectSecret,
  isProjectSecretServiceFailure,
  listProjectSecrets,
  updateProjectSecret,
  type ProjectSecretServiceFailure,
} from "@/lib/project-secrets/service";
import {
  createApiKey,
  isProjectApiKeyServiceFailure,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  type ProjectApiKeyServiceFailure,
} from "@/lib/project-api-keys/service";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" } as const;
const RUN_STALE_MS = 10 * 60_000;
const ACTIVE_STAGES: ReadonlySet<RunStage> = new Set([
  "queued",
  "validating",
  "generating",
  "retrying",
]);

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

function stageOf(run: RunRow | null): RunStage | null {
  if (!run) return null;
  if (
    run.stage === "completed" ||
    run.stage === "failed" ||
    run.stage === "cancelled" ||
    run.stage === "interrupted"
  ) {
    return run.stage;
  }
  if (run.finished_at) return run.status === "done" ? "completed" : "failed";
  if (run.stage && ACTIVE_STAGES.has(run.stage)) return run.stage;
  return "queued";
}

/** A run is active only while it is unfinished, in an active stage, and heartbeating. */
function isRunActive(run: RunRow | null): boolean {
  if (!run || run.finished_at) return false;
  const stage = stageOf(run);
  if (!stage || !ACTIVE_STAGES.has(stage)) return false;
  const last = Date.parse(run.heartbeat_at ?? run.started_at);
  return Number.isFinite(last) && Date.now() - last < RUN_STALE_MS;
}

function isRunStale(run: RunRow | null): boolean {
  if (!run || run.finished_at) return false;
  const stage = stageOf(run);
  if (!stage || !ACTIVE_STAGES.has(stage)) return false;
  const last = Date.parse(run.heartbeat_at ?? run.started_at);
  return Number.isFinite(last) && Date.now() - last >= RUN_STALE_MS;
}

/** Close an abandoned run once, so it cannot remain "generating" forever. */
async function interruptIfStale(run: RunRow | null): Promise<RunRow | null> {
  if (!run || !isRunStale(run)) return run;
  const changed = await finishRun(
    run.id,
    "error",
    "The run was interrupted before completion. You can resume it.",
    {
      stage: "interrupted",
      errorCode: "RUN_INTERRUPTED",
    },
  );
  if (!changed) {
    // Another process finished this run while we were deciding it was stale.
    const fresh = await getRun(run.project_id, run.id);
    if (!isStoreFailure(fresh)) return fresh.data ?? run;
    return run;
  }
  return {
    ...run,
    status: "error",
    stage: "interrupted",
    finished_at: new Date().toISOString(),
    error_message: "The run was interrupted before completion. You can resume it.",
    error_code: "RUN_INTERRUPTED",
  };
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
  if (action === "agent/resume" && method === "POST") {
    return resumeAgentResponse(userId, projectId);
  }
  if ((action === "agent/cancel" || action === "agent/stop") && method === "POST") {
    return cancelAgentResponse(userId, projectId);
  }
  if (action === "agent/status" && method === "GET") {
    return agentStatusResponse(projectId);
  }
  if (action === "agent/progress" && method === "GET") {
    return agentProgressResponse(projectId);
  }
  if (action === "analytics/activity" && method === "GET") {
    return projectActivityResponse(projectId, query);
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
  if (action === "secrets") {
    if (method === "GET") return projectSecretsResponse(userId, projectId);
    if (method === "POST") return createProjectSecretResponse(userId, projectId, body);
  }
  if (action.startsWith("secrets/")) {
    const rest = action.slice("secrets/".length).split("/");
    const secretId = rest[0];
    if (secretId && rest.length === 1) {
      if (method === "PUT" || method === "PATCH") {
        return updateProjectSecretResponse(userId, projectId, secretId, body);
      }
      if (method === "DELETE") {
        return deleteProjectSecretResponse(userId, projectId, secretId);
      }
    }
  }
  if (action === "api-keys") {
    if (method === "GET") return projectApiKeysResponse(userId, projectId);
    if (method === "POST") return createProjectApiKeyResponse(userId, projectId, body);
  }
  if (action.startsWith("api-keys/")) {
    const rest = action.slice("api-keys/".length).split("/");
    const keyId = rest[0];
    if (keyId && rest.length === 1 && method === "DELETE") {
      return revokeProjectApiKeyResponse(userId, projectId, keyId);
    }
    if (keyId && rest.length === 2 && rest[1] === "rotate" && method === "POST") {
      return rotateProjectApiKeyResponse(userId, projectId, keyId);
    }
  }
  if (action === "preview/rotate-url" && method === "POST") {
    return previewRotateUrlResponse(userId, projectId);
  }
  if (action === "files/tree" && method === "GET") {
    return fileTreeResponse(projectId, query);
  }
  if (action === "files/content") {
    if (method === "GET") return fileContentResponse(projectId, query);
    if (method === "PUT") return fileWriteResponse(userId, projectId, body);
  }
  /**
   * ═══ IMAGE GENERATION ═════════════════════════════════════════════════════
   *
   *   POST …/images/generate — one image from the server-side image model.
   *
   * The catch-all already verified the session and that this project belongs to
   * the caller. The image is returned as base64 and is NOT written anywhere:
   * there is no binary asset pipeline in this build (`project_files` is text
   * served as text) and no credit engine to charge. The response says so in its
   * types; nothing here claims the image was saved.
   */
  if (action === "images/generate" && method === "POST") {
    return imageGenerationResponse(userId, projectId, body);
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
  const admission = await createGenerationJob({
    projectId: created.data.project_id,
    model: model.id,
    prompt,
    idempotencyKey: idempotencyKeyOf(record),
  });
  if (isStoreFailure(admission)) {
    await deleteProject(userId, created.data.project_id);
    return admissionFailure(admission);
  }
  if (admission.data.status === "rate_limited") {
    await deleteProject(userId, created.data.project_id);
    return rateLimited(admission.data.scope, admission.data.retryAfterSeconds);
  }
  if (admission.data.status === "conflict" || admission.data.status === "existing") {
    await deleteProject(userId, created.data.project_id);
    return fail(409, "CONFLICT", "A generation is already active for this project.");
  }

  const run = admission.data.run;
  const message = await insertMessage(created.data.project_id, "user", prompt);
  if (isStoreFailure(message)) {
    await finishRun(run.id, "error", "Could not save the prompt.", { stage: "failed", errorCode: "RUN_PROMPT_SAVE_FAILED" });
    await deleteProject(userId, created.data.project_id);
    return fail(500, "UNKNOWN", "Could not start the agent.");
  }

  after(() =>
    runAgent({
      userId,
      projectId: created.data.project_id,
      runId: run.id,
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

function idempotencyKeyOf(body: Record<string, unknown>): string | null {
  const raw = stringOf(body.clientRequestId) ?? stringOf(body.idempotencyKey);
  const key = raw?.trim().slice(0, 200) ?? "";
  return key || null;
}

function admissionFailure(failure: { error: string; code?: string }): NextResponse {
  if (failure.code === "MIGRATION_REQUIRED") {
    return fail(503, "MIGRATION_REQUIRED", failure.error);
  }
  if (failure.code === "UNAUTHENTICATED") return fail(401, "UNAUTHENTICATED", failure.error);
  if (failure.code === "FORBIDDEN") return fail(403, "FORBIDDEN", failure.error);
  if (failure.code === "CONFLICT") return fail(409, "CONFLICT", failure.error);
  return fail(500, "UNKNOWN", "Could not start the agent.");
}

function rateLimited(scope: "user" | "global", retryAfterSeconds: number): NextResponse {
  const retry = Math.max(1, Math.min(Math.ceil(retryAfterSeconds), 900));
  return fail(
    429,
    "RATE_LIMITED",
    scope === "user"
      ? "You already have the maximum number of generations running. Wait for one to finish and try again."
      : "Mavly is at capacity right now. Your request was not started; try again shortly.",
    { "retry-after": String(retry) },
  );
}

async function projectResponse(userId: string, projectId: string): Promise<NextResponse> {
  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) return fail(500, "UNKNOWN", "Could not load this project.");
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");

  const run = await latestRun(projectId);
  if (isStoreFailure(run)) return fail(500, "UNKNOWN", "Could not load this project.");
  const preview = await staticPreviewState(projectId);
  const deployment = await getDeploymentRow(projectId);
  const secrets = await secretsForProject(projectId, userId);

  return ok(
    projectFromRow(
      project.data,
      run.data,
      preview.available,
      preview.reason,
      isDeploymentStoreFailure(deployment) ? null : deployment.data,
      secrets,
    ),
  );
}

/**
 * Project metadata currently carries secrets for the workspace and composer.
 * If the optional secrets table is unavailable, the project itself still loads;
 * the dedicated secrets endpoint reports the configuration failure precisely.
 */
async function secretsForProject(projectId: string, userId: string): Promise<VcaasSecret[]> {
  const result = await listProjectSecrets(projectId, userId);
  return isProjectSecretServiceFailure(result) ? [] : result.data;
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
  const secrets = await secretsForProject(projectId, userId);
  return ok(
    projectFromRow(
      updated.data,
      isStoreFailure(run) ? null : run.data,
      preview.available,
      preview.reason,
      isDeploymentStoreFailure(deployment) ? null : deployment.data,
      secrets,
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

function secretFail(result: ProjectSecretServiceFailure): NextResponse {
  return fail(result.status, result.code, result.error);
}

function apiKeyFail(result: ProjectApiKeyServiceFailure): NextResponse {
  return fail(result.status, result.code, result.error);
}

async function projectSecretsResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await listProjectSecrets(projectId, userId);
  if (isProjectSecretServiceFailure(result)) return secretFail(result);
  return ok(result.data);
}

async function createProjectSecretResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  const result = await createProjectSecret(projectId, userId, body);
  if (isProjectSecretServiceFailure(result)) return secretFail(result);
  return ok(result.data);
}

async function updateProjectSecretResponse(
  userId: string,
  projectId: string,
  secretId: string,
  body: unknown,
): Promise<NextResponse> {
  const result = await updateProjectSecret(projectId, userId, secretId, body);
  if (isProjectSecretServiceFailure(result)) return secretFail(result);
  return ok(result.data);
}

async function deleteProjectSecretResponse(
  userId: string,
  projectId: string,
  secretId: string,
): Promise<NextResponse> {
  const result = await deleteProjectSecret(projectId, userId, secretId);
  if (isProjectSecretServiceFailure(result)) return secretFail(result);
  return ok(result.data);
}

async function projectApiKeysResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await listApiKeys(projectId, userId);
  if (isProjectApiKeyServiceFailure(result)) return apiKeyFail(result);
  return ok(result.data);
}

async function createProjectApiKeyResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  const result = await createApiKey(projectId, userId, body);
  if (isProjectApiKeyServiceFailure(result)) return apiKeyFail(result);
  return ok(result.data);
}

async function revokeProjectApiKeyResponse(
  userId: string,
  projectId: string,
  keyId: string,
): Promise<NextResponse> {
  const result = await revokeApiKey(projectId, userId, keyId);
  if (isProjectApiKeyServiceFailure(result)) return apiKeyFail(result);
  return ok(result.data);
}

async function rotateProjectApiKeyResponse(
  userId: string,
  projectId: string,
  keyId: string,
): Promise<NextResponse> {
  const result = await rotateApiKey(projectId, userId, keyId);
  if (isProjectApiKeyServiceFailure(result)) return apiKeyFail(result);
  return ok(result.data);
}

async function previewRotateUrlResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  // The UI expects { temporalLinkUrl: string; rotatedAt: string }
  // Generate a new preview address
  const { randomUUID } = await import("node:crypto");
  const temporalLinkUrl = `https://preview-${randomUUID().slice(0, 8)}-${projectId}.mavly.app`;
  return ok({ temporalLinkUrl, rotatedAt: new Date().toISOString() });
}

async function startAgentResponse(userId: string, projectId: string, body: unknown): Promise<NextResponse> {
  if (!isAiConfigured()) {
    return fail(503, "BACKEND_NOT_CONFIGURED", "OpenRouter is not configured. Add OPENROUTER_API_KEY on the server.");
  }

  const record = recordOf(body);
  const prompt = (stringOf(record.prompt)?.trim() ?? "").slice(0, 32_000);
  if (!prompt) return fail(400, "VALIDATION", "A prompt is required.");

  const model = resolveModel(stringOf(record.model), "app-generation");
  const admission = await createGenerationJob({
    projectId,
    model: model.id,
    prompt,
    idempotencyKey: idempotencyKeyOf(record),
  });
  if (isStoreFailure(admission)) return admissionFailure(admission);

  if (admission.data.status === "rate_limited") {
    return rateLimited(admission.data.scope, admission.data.retryAfterSeconds);
  }
  if (admission.data.status === "conflict") {
    return fail(
      409,
      "CONFLICT",
      "An agent run is already in progress for this project.",
    );
  }

  const run = admission.data.run;

  /**
   * A repeated request with the same idempotency key returns the existing run.
   * Do not insert the user's prompt twice and do not start a second worker.
   */
  if (admission.data.status === "existing") {
    return ok({
      status: run.finished_at ? "done" : "init",
      stage: stageOf(run),
      runId: run.id,
      idempotent: true,
    });
  }

  const message = await insertMessage(projectId, "user", prompt);
  if (isStoreFailure(message)) {
    await finishRun(run.id, "error", "Could not save the prompt.", {
      stage: "failed",
      errorCode: "RUN_PROMPT_SAVE_FAILED",
    });
    return fail(500, "UNKNOWN", "Could not start the agent.");
  }

  after(() =>
    runAgent({
      userId,
      projectId,
      runId: run.id,
      prompt,
      requestedModel: stringOf(record.model),
    }),
  );

  return ok({ status: "init", stage: "queued", runId: run.id });
}

async function resumeAgentResponse(userId: string, projectId: string): Promise<NextResponse> {
  if (!isAiConfigured()) {
    return fail(503, "BACKEND_NOT_CONFIGURED", "OpenRouter is not configured. Add OPENROUTER_API_KEY on the server.");
  }

  const current = await latestRun(projectId);
  if (isStoreFailure(current)) return fail(500, "UNKNOWN", "Could not resume the agent.");
  if (!current.data) return fail(404, "RUN_NOT_FOUND", "There is no run to resume.");

  const run = await interruptIfStale(current.data);
  if (isRunActive(run)) {
    return fail(409, "CONFLICT", "That run is still in progress.");
  }
  const stage = stageOf(run);
  if (!run || (stage !== "failed" && stage !== "interrupted")) {
    return fail(409, "RUN_NOT_RESUMABLE", "Only a failed or interrupted run can be resumed.");
  }

  const reopened = await resumeRun(projectId, run.id);
  if (isStoreFailure(reopened)) {
    if (reopened.code === "CONFLICT") {
      return fail(409, "CONFLICT", reopened.error);
    }
    if (reopened.code === "RATE_LIMITED_USER" || reopened.code === "RATE_LIMITED_GLOBAL") {
      return rateLimited(reopened.code === "RATE_LIMITED_GLOBAL" ? "global" : "user", 30);
    }
    return fail(500, "UNKNOWN", "Could not resume the agent.");
  }
  if (!reopened.data) {
    return fail(409, "RUN_NOT_RESUMABLE", "That run cannot be resumed.");
  }

  after(() =>
    runAgent({
      userId,
      projectId,
      runId: reopened.data!.id,
      prompt: reopened.data!.prompt,
      requestedModel: reopened.data!.model,
      resume: true,
    }),
  );

  return ok({ status: "init", stage: "queued", runId: reopened.data.id, resumed: true });
}

async function cancelAgentResponse(userId: string, projectId: string): Promise<NextResponse> {
  const current = await latestRun(projectId);
  if (isStoreFailure(current)) return fail(500, "UNKNOWN", "Could not cancel the agent.");
  if (!current.data) return fail(404, "RUN_NOT_FOUND", "There is no run to cancel.");

  const run = await interruptIfStale(current.data);
  if (!isRunActive(run)) {
    return fail(409, "RUN_NOT_ACTIVE", "That run is not in progress.");
  }

  const cancelled = await finishRun(run.id, "cancelled", "The run was cancelled by the user.", {
    stage: "cancelled",
    errorCode: "RUN_CANCELLED",
  });
  if (!cancelled) {
    return fail(409, "RUN_NOT_ACTIVE", "That run finished before it could be cancelled.");
  }
  await insertMessage(
    projectId,
    "agent",
    "The run was cancelled. Completed batches were kept and the code was not rolled back automatically.",
    "error",
  );

  return ok({ runId: run.id, status: "cancelled", stage: "cancelled" });
}

async function agentStatusResponse(projectId: string): Promise<NextResponse> {
  const latest = await latestRun(projectId);
  if (isStoreFailure(latest)) return fail(500, "UNKNOWN", "Could not load the agent status.");
  if (!latest.data) {
    return ok({
      projectId,
      status: "idle",
      startedAt: null,
      realtimeConversation: [],
    } satisfies AgentStatus);
  }

  const run = await interruptIfStale(latest.data);
  if (!run) return fail(500, "UNKNOWN", "Could not load the agent status.");

  const messages = await listMessages(projectId, { limit: 100 });
  const realtimeConversation = isStoreFailure(messages)
    ? []
    : messages.data
        .filter((message) => message.created_at >= run.started_at)
        .map(toConversationMessage);

  const status = isRunActive(run) ? "init" : "done";
  const manifest = parseManifestFileCount(run.generation_manifest);
  return ok({
    projectId,
    status,
    stage: stageOf(run),
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    realtimeConversation,
    // Do not invent an ETA. The client shows elapsed time from `startedAt`
    // until the run reports a terminal stage.
    expectedMinutes: null,
    expectedFinishAt: null,
    runId: run.id,
    filesWritten: run.files_written,
    totalFiles: manifest,
    batchCount: run.batch_count,
    checkpointCount: run.checkpoint_count,
    attemptCount: run.attempt_count,
    failureCode: run.error_code,
    model: run.model_used ?? run.model ?? undefined,
    usage: {
      promptTokens: run.prompt_tokens,
      completionTokens: run.completion_tokens,
      totalTokens: run.total_tokens,
      reasoningTokens: run.reasoning_tokens,
    },
  } satisfies AgentStatus);
}

function parseManifestFileCount(manifest: unknown): number | null {
  if (!manifest || typeof manifest !== "object") return null;
  const files = (manifest as { files?: unknown }).files;
  return Array.isArray(files) ? files.length : null;
}

async function agentProgressResponse(projectId: string): Promise<NextResponse> {
  const latest = await latestRun(projectId);
  if (isStoreFailure(latest)) return fail(500, "UNKNOWN", "Could not load the agent progress.");
  if (!latest.data) return fail(404, "PROJECT_NOT_FOUND", "No agent run found.");

  const run = await interruptIfStale(latest.data);
  if (!run) return fail(500, "UNKNOWN", "Could not load the agent progress.");

  const startedAt = Date.parse(run.started_at);
  if (!Number.isFinite(startedAt)) {
    return fail(500, "UNKNOWN", "Could not read the agent run start time.");
  }

  const batches = await listRunBatches(run.id);
  const seen = new Set<string>();
  const files: { path: string; change: "edit"; added: number; removed: number }[] = [];
  if (!isStoreFailure(batches)) {
    for (const batch of batches.data) {
      for (const path of batch.paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        files.push({ path, change: "edit", added: 0, removed: 0 });
      }
    }
  }
  const checkpointCount = isStoreFailure(batches)
    ? run.checkpoint_count
    : Math.max(run.checkpoint_count, batches.data.length);

  return ok({
    runId: run.id,
    stage: progressStageOf(run),
    startedAt: run.started_at,
    turns: Math.max(run.batch_count, checkpointCount),
    steps: [],
    totalSteps: checkpointCount,
    files,
  });
}

/** The client only knows a small stage vocabulary; map the durable stage onto it. */
function progressStageOf(run: RunRow): string {
  const stage = stageOf(run);
  switch (stage) {
    case "queued":
      return "queued";
    case "validating":
      return "starting";
    case "generating":
      return "working";
    case "retrying":
      return "fixing";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "interrupted":
      return "failed";
    default:
      return run.status === "done" ? "done" : "failed";
  }
}

async function projectActivityResponse(
  projectId: string,
  query: URLSearchParams,
): Promise<NextResponse> {
  const requested = query.get("range");
  const key: ProjectActivityRange =
    requested === "7d" || requested === "30d" || requested === "90d" || requested === "all"
      ? requested
      : "30d";
  const range = projectActivityRangeOf(key);
  const rows = await listRunActivity(projectId, {
    since: range.from,
    limit: PROJECT_ACTIVITY_LIMIT,
  });
  if (isStoreFailure(rows)) {
    if (rows.code === "42703" || rows.code === "42P01") {
      return fail(
        503,
        "MIGRATION_REQUIRED",
        "Project activity needs the generation-jobs migration. Apply supabase/migrations/10_generation_jobs.sql.",
      );
    }
    return fail(500, "UNKNOWN", "Could not load project activity.");
  }

  const days = new Map<string, ProjectActivityDay>();
  const totals: ProjectActivity["totals"] = {
    runs: 0,
    completed: 0,
    failed: 0,
    active: 0,
    filesWritten: 0,
    tokens: 0,
  };
  const recent: ProjectActivityRun[] = [];

  for (const row of rows.data) {
    const outcome = activityOutcomeOf(row.stage, row.status);
    const started = Date.parse(row.started_at);
    const finished = row.finished_at ? Date.parse(row.finished_at) : Number.NaN;
    const durationMs =
      Number.isFinite(started) && Number.isFinite(finished) && finished >= started
        ? finished - started
        : null;
    const tokens =
      row.total_tokens ??
      (row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0);

    totals.runs += 1;
    totals.filesWritten += row.files_written;
    totals.tokens += tokens;
    if (outcome === "completed") totals.completed += 1;
    else if (outcome === "failed" || outcome === "cancelled" || outcome === "interrupted") {
      totals.failed += 1;
    } else {
      totals.active += 1;
    }

    if (Number.isFinite(started)) {
      const date = new Date(started).toISOString().slice(0, 10);
      const day = days.get(date) ?? {
        date,
        runs: 0,
        completed: 0,
        failed: 0,
        filesWritten: 0,
        tokens: 0,
      };
      day.runs += 1;
      day.filesWritten += row.files_written;
      day.tokens += tokens;
      if (outcome === "completed") day.completed += 1;
      else if (outcome === "failed" || outcome === "cancelled" || outcome === "interrupted") {
        day.failed += 1;
      }
      days.set(date, day);
    }

    if (recent.length < 20) {
      recent.push({
        id: row.id,
        outcome,
        stage: row.stage,
        model: row.model,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationMs,
        filesWritten: row.files_written,
        totalTokens: row.total_tokens ?? (tokens > 0 ? tokens : null),
        errorCode: row.error_code,
      });
    }
  }

  const data: ProjectActivity = {
    range,
    totals,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    recent,
    truncated: rows.data.length >= PROJECT_ACTIVITY_LIMIT,
  };
  return ok(data);
}

function activityOutcomeOf(
  stage: string,
  status: RunRow["status"],
): ProjectActivityOutcome {
  if (stage === "completed") return "completed";
  if (stage === "cancelled") return "cancelled";
  if (stage === "interrupted") return "interrupted";
  if (stage === "failed") return "failed";
  if (stage === "queued" || stage === "validating" || stage === "generating" || stage === "retrying") {
    return stage === "queued" ? "queued" : "active";
  }
  return status === "done" ? "completed" : status === "error" ? "failed" : "queued";
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
 * ═══ ONE IMAGE, FROM THE SERVER'S IMAGE MODEL ═══════════════════════════════
 *
 * The provider call is server-side only (`OPENROUTER_API_KEY` never leaves the
 * server), the prompt is bounded, and the model's own supported parameters are
 * the only ones accepted. There is no user-supplied URL anywhere on this path,
 * so it opens no fetch-to-arbitrary-host surface.
 *
 * ⚠️ NO CREDIT CHARGE. This build has no credit engine — no reservation, no
 * balance, no refund — so inventing a price here would be a fake debit. The
 * feature is unbilled until a real credit policy exists; that is a product
 * decision, not something this handler may assume.
 */
async function imageGenerationResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  if (!isAiConfigured()) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "OpenRouter is not configured. Add OPENROUTER_API_KEY on the server.",
    );
  }

  const model = resolveImageModel();
  const parsed = parseImageGenerationRequest(body, model);
  if (parsed.ok === false) return fail(400, "VALIDATION", parsed.error);

  /**
   * ⚠️ BEFORE THE PROVIDER CALL, AFTER VALIDATION. A malformed request costs
   * nothing upstream, so it must not spend the user's window. A provider failure
   * does spend it: that is deliberate, so a broken key or a hanging provider
   * cannot be retried in a tight loop.
   *
   * ⚠️ THE CEILING IS BEST-EFFORT AND PER INSTANCE. See `image-limits.ts`: a hard
   * cross-instance cap needs the persisted admission RPC described there, which
   * this change deliberately does not add.
   */
  const allowance = imageGenerationLimiter.consume(userId);
  if (allowance.ok === false) return imageLimitResponse(allowance);

  const generated = await generateImage({
    model,
    prompt: parsed.request.prompt,
    aspectRatio: parsed.request.aspectRatio,
    outputFormat: parsed.request.outputFormat,
    seed: parsed.request.seed,
  });
  if (isImageGenerationFailure(generated)) return imageGenerationFailureResponse(generated);

  const data: ImageGenerationResult = {
    projectId,
    model: generated.model,
    mediaType: generated.image.mediaType,
    format: generated.image.format,
    bytes: generated.image.bytes,
    imageBase64: generated.image.base64,
    usage: {
      // ⚠️ THE PROVIDER'S COST IS NOT RETURNED. It stays in the server-side
      // `generated.usage` for future accounting only; exposing it would publish
      // the operator's per-image cost and margin to the browser.
      totalTokens: generated.usage.totalTokens,
    },
  };
  return ok(data);
}

/**
 * A refusal from the in-memory admission window. Nothing reached OpenRouter, so
 * "nothing was generated" is true here and the retry hint is the window reset.
 */
function imageLimitResponse(
  denial: Extract<ImageGenerationLimitDecision, { ok: false }>,
): NextResponse {
  return fail(
    429,
    "RATE_LIMITED",
    denial.scope === "user"
      ? "You've reached the image generation limit for now. Try again in a few minutes."
      : "Image generation is at capacity right now. Try again shortly.",
    { "retry-after": String(denial.retryAfterSeconds) },
  );
}

/**
 * Every provider failure becomes a sanitised `{ ok: false, code }` answer. The
 * provider's message is never forwarded verbatim: it can name hosts, accounts
 * or internal request ids.
 */
function imageGenerationFailureResponse(failure: ImageGenerationFailure): NextResponse {
  const retryAfter =
    failure.retryAfterMs && failure.retryAfterMs > 0
      ? { "retry-after": String(Math.max(1, Math.min(Math.ceil(failure.retryAfterMs / 1_000), 900))) }
      : undefined;

  switch (failure.code) {
    case "CONFIGURATION":
      return fail(
        503,
        "BACKEND_NOT_CONFIGURED",
        "Image generation is not configured on this server.",
      );
    case "AUTHENTICATION":
      return fail(
        502,
        "IMAGE_PROVIDER_ERROR",
        "The image provider rejected Mavly's credentials. Nothing was generated.",
      );
    case "INVALID_REQUEST":
      return fail(
        400,
        "VALIDATION",
        "The image provider rejected that request. Try a different prompt, aspect ratio or format.",
      );
    case "CONTENT_FILTER":
      return fail(
        422,
        "CONTENT_REJECTED",
        "The image provider blocked this prompt. Nothing was generated.",
      );
    case "RATE_LIMITED":
      return fail(
        429,
        "RATE_LIMITED",
        "The image provider is busy right now. Nothing was generated; try again shortly.",
        retryAfter,
      );
    case "IMAGE_TOO_LARGE":
      return fail(
        502,
        "IMAGE_TOO_LARGE",
        "The generated image was too large to deliver. Try a smaller aspect ratio.",
      );
    case "EMPTY_RESPONSE":
      return fail(
        502,
        "IMAGE_PROVIDER_ERROR",
        "The image provider returned an empty response. Try again.",
      );
    case "INVALID_RESPONSE":
      return fail(
        502,
        "IMAGE_PROVIDER_ERROR",
        "The image provider's response was not a usable image. Try again.",
      );
    case "TIMEOUT":
      return fail(
        504,
        "IMAGE_TIMEOUT",
        "The image request timed out before the provider answered. Nothing was returned to Mavly.",
      );
    default:
      /**
       * `PROVIDER_ERROR`, `TRANSIENT`, `NETWORK`, `UNKNOWN`. We know Mavly did
       * not receive an image; we do NOT know that nothing was generated upstream,
       * so this copy must not claim it was.
       */
      return fail(
        502,
        "IMAGE_PROVIDER_ERROR",
        "The image request failed and Mavly received no image. Try again.",
      );
  }
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
  secrets: VcaasSecret[] = [],
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
    secrets,
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
