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
  ProjectVerification,
  ProjectVerificationStatus,
  RestoreResult,
  VcaasProject,
  VcaasProjectSummary,
  VcaasSecret,
} from "@/lib/vcaas-types";
import { generationConfigurationError, isAiConfigured } from "@/lib/ai/provider";
import {
  COHERE_NORTH_MINI_CODE_MODEL_ID,
  isCohereNorthMiniCodeEnabledForProject,
  resolveModel,
} from "@/lib/ai/models";
import { parseImageGenerationRequest, resolveImageModel } from "@/lib/ai/image-models";
import {
  generateImage,
  isImageProviderConfigured,
  isImageGenerationFailure,
  type ImageGenerationFailure,
} from "@/lib/ai/openrouter-images";
import { sanitizeProjectPath } from "@/lib/ai/agent";
import { androidCapability } from "@/lib/android/capability";
import {
  androidPackageForProject,
  androidPathRejection,
  validateAndroidProject,
} from "@/lib/android/contract";
import {
  ANDROID_BUILD_TOOLCHAIN,
  androidBuildConfig,
  androidBuildProblemMessage,
  isProjectInAndroidBuildCohort,
} from "@/lib/android/build-config";
import {
  androidBuildSchemaVersion,
  cancelAndroidBuild,
  createAndroidBuild,
  getAndroidBuildForOwner,
  getAndroidBuildFull,
  isAndroidBuildStoreFailure,
  listAndroidBuilds,
} from "@/lib/android/build-store";
import { managedBackendStatus } from "@/lib/managed-backend/store";
import {
  managedBackendStatusView,
  type ManagedBackendStatusView,
} from "@/lib/managed-backend/status";
import { readOwnEnrollment } from "@/lib/managed-backend/enrollment-store";
import {
  enrollmentStatusView,
  type EnrollmentReasonCode,
} from "@/lib/managed-backend/enrollment";
import { generationWorkerConfig } from "@/lib/generation/worker-config";
import {
  creditAdmissionForProject,
  creditsProblemMessage,
} from "@/lib/credits/config";
import {
  createGenerationJobWithCredits,
  finishCreditGenerationRun,
  isCreditsFailure,
  resumeGenerationJobWithCredits,
} from "@/lib/credits/store";
import {
  creditSnapshotForOwner,
  recordRunUsage,
} from "@/lib/credits/service";
import { toAndroidBuildView, type AndroidBuildView } from "@/lib/android/build-state";
import { createAndroidArtifactStore } from "@/lib/android/artifact-store";
import { createSupabaseWorkerClient } from "@/lib/supabase/worker";
import { validateProjectSlug } from "@/lib/project-slug";
import { resolveStaticPreview } from "@/lib/static-site";
import {
  resolveGenerationState,
  resolvePreviewState,
  type PreviewRunSignal,
  type PreviewState,
} from "@/lib/preview-status";
import { projectGenerationProgressStage } from "@/lib/run-progress";
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
  type ProjectType,
  type RunRow,
  type RunStage,
} from "./store";
import { runAgent } from "./run-agent";
import { ensureProjectRuleFiles } from "@/lib/project-rules/service";
import { isAgentControlPath } from "@/lib/project-rules/rules";
import { dispatchModeForProject } from "@/lib/generation/worker-config";
import { emitGenerationEvent } from "@/lib/observability/events";
import {
  runStaticVerification,
  type StaticVerification,
} from "@/lib/verification/static";
import { imageGenerationLimiter, type ImageGenerationLimitDecision } from "./image-limits";
import {
  getDeploymentRow,
  isDeploymentStoreFailure,
  type DeploymentRow,
} from "@/lib/deployments/store";
import {
  deploymentHost,
  getProjectDeploymentStatus,
  isDeploymentServiceFailure,
  publishProject,
  unpublishProject,
  wireDeploymentStatus,
} from "@/lib/deployments/service";
import {
  isAwsFrontendHostingProject,
  readAwsFrontendHostingConfig,
} from "@/lib/aws/config";
import {
  disableFullstackProject,
  fullstackDeployableSnapshots,
  fullstackDeploymentHistory,
  isFullstackFailure,
  rollbackFullstackProject,
} from "@/lib/deployments/fullstack";
import { toWorkflowView } from "@/lib/orchestration/engine";
import {
  cancelOwnedWorkflow,
  getLatestWorkflow,
  isWorkflowStoreFailure,
  listTasks,
} from "@/lib/orchestration/store";
import {
  deploymentApprovalRequiredFor,
  isProjectInMultiAgentCohort,
  multiAgentConfig,
  multiAgentProblemMessage,
} from "@/lib/orchestration/config";
import {
  approveProposal,
  getProposal,
  isApprovalServiceFailure,
  listProposals,
  proposeDeployment,
  revokeProposal,
} from "@/lib/orchestration/approval-service";
import {
  getDatabaseStatus,
  isDatabaseServiceFailure,
  removeDatabaseConfig,
  saveDatabaseConfig,
} from "@/lib/hosting/fullstack-database";
import {
  createSnapshot,
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
import { publicIntegrationCatalog } from "@/lib/integrations/contracts";
import {
  disablePaymentsIntegration,
  getPaymentsStatus,
  isPaymentsServiceFailure,
  savePaymentsIntegration,
  testPaymentsIntegration,
  type PaymentsServiceFailure,
} from "@/lib/integrations/payments/service";
import {
  clearProjectMemory,
  createProjectDecision,
  deleteProjectMemory,
  isMemoryServiceFailure,
  listProjectMemory,
  updateProjectMemory,
  type MemoryServiceFailure,
} from "@/lib/memory/service";

import {
  cancelVerification,
  getVerificationForRun,
} from "@/lib/sandbox/store";
import { verificationSandboxConfig } from "@/lib/sandbox/config";
import type { VerificationResult, VerificationStatus } from "@/lib/sandbox/state";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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

/**
 * The durable `retry_wait` stage is reported as `retrying`: the job is accepted
 * and scheduled, and `nextAttemptAt` carries the exact truth. The public stage
 * vocabulary does not grow a value that copied UI does not understand.
 */
type PublicRunStage = Exclude<RunStage, "retry_wait">;

function stageOf(run: RunRow | null): PublicRunStage | null {
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
  if (run.stage === "retry_wait") return "retrying";
  if (run.stage && ACTIVE_STAGES.has(run.stage)) return run.stage as PublicRunStage;
  return "queued";
}

/**
 * ⚠️ A WORKER-DISPATCHED JOB IS NEVER DECLARED STALE BY THE USER PATH. Its
 * lease and the service-role recovery RPC are authoritative, and a queued
 * worker job must survive a backlog. Only the inline `after()` path keeps the
 * heartbeat heuristic, because it has no lease.
 */
function isWorkerDispatched(run: RunRow | null): boolean {
  return run?.dispatch_mode === "worker";
}

/** A run is active while it is unfinished and in an accepted/running stage. */
function isRunActive(run: RunRow | null): boolean {
  if (!run || run.finished_at) return false;
  const stage = stageOf(run);
  if (!stage || !ACTIVE_STAGES.has(stage)) return false;
  if (isWorkerDispatched(run)) return true;
  const last = Date.parse(run.heartbeat_at ?? run.started_at);
  return Number.isFinite(last) && Date.now() - last < RUN_STALE_MS;
}

function isRunStale(run: RunRow | null): boolean {
  if (!run || run.finished_at || isWorkerDispatched(run)) return false;
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
    return listProjectResponse(userId, query);
  }

  if (scope.kind === "account" && scope.resource === "credit-costs" && method === "GET") {
    return ok({ creditCosts: {} });
  }

  /**
   * ═══ CREDIT ACCOUNT (READ) ═════════════════════════════════════════════════
   *
   * The workspace's authoritative balance. The read also performs one bounded
   * owner-scoped reconciliation, so a process that died between a completed run
   * and its settlement is repaired before the number is shown.
   *
   * When credits are disabled the response says so and carries NULL values —
   * never a fabricated zero balance.
   */
  if (scope.kind === "account" && scope.resource === "credits" && method === "GET") {
    return creditsResponse();
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
  /**
   * ═══ ANDROID BUILDS ════════════════════════════════════════════════════════
   *
   * Source generation is real. Isolated debug builds are real too, but OFF by
   * default: they need migration 26, the scheduled generation worker, a digest-pinned
   * sandbox image, a private artifact bucket and an explicit project cohort.
   * These routes never fabricate a build row or artifact. When a prerequisite
   * is missing, GET reports the truthful capability and POST refuses with the
   * exact blocker.
   */
  if (action === "mobile/builds" && method === "GET") {
    return androidBuildsResponse(userId, projectId);
  }
  if (action === "mobile/builds" && method === "POST") {
    return androidBuildStartResponse(userId, projectId, body);
  }
  if (action.startsWith("mobile/builds/") && method === "GET") {
    return androidBuildArtifactResponse(userId, projectId, action);
  }
  if (action.startsWith("mobile/builds/") && method === "POST") {
    return androidBuildActionResponse(userId, projectId, action);
  }
  if (action === "analytics/activity" && method === "GET") {
    return projectActivityResponse(projectId, query);
  }
  if (action === "agent/full-conversation" && method === "GET") {
    return conversationResponse(projectId, query);
  }
  if (action === "deployments/deploy" && method === "POST") {
    const unsupported = await rejectAndroidWebsiteDeployment(userId, projectId);
    if (unsupported) return unsupported;
    return deployResponse(userId, projectId, body);
  }
  if (action === "deployments/unpublish" && method === "POST") {
    return unpublishResponse(userId, projectId);
  }
  if (action === "deployments/status" && method === "GET") {
    return deploymentStatusResponse(userId, projectId);
  }
  /**
   * ═══ DEPLOYMENT APPROVAL (PHASE 10) ═══════════════════════════════════════
   *
   * A proposal is NOT a deployment. It records the exact server-derived target,
   * snapshot and source hash a human may approve. Approval is a separate owner
   * act; the deploy route consumes it atomically.
   */
  if (action === "deployments/proposals" && method === "GET") {
    return deploymentProposalsResponse(userId, projectId);
  }
  if (action === "deployments/proposals" && method === "POST") {
    return proposeDeploymentResponse(userId, projectId, body);
  }
  if (action.startsWith("deployments/proposals/")) {
    const rest = action.slice("deployments/proposals/".length).split("/");
    const proposalId = rest[0];
    if (proposalId && rest.length === 1 && method === "GET") {
      return deploymentProposalResponse(userId, projectId, proposalId);
    }
    if (proposalId && rest.length === 2 && method === "POST" && rest[1] === "approve") {
      return approveDeploymentProposalResponse(userId, projectId, proposalId);
    }
    if (proposalId && rest.length === 2 && method === "POST" && rest[1] === "revoke") {
      return revokeDeploymentProposalResponse(userId, projectId, proposalId, body);
    }
  }
  /**
   * ═══ AGENT WORKFLOW OBSERVABILITY (PHASE 10) ══════════════════════════════
   *
   * READ-ONLY projection of the durable workflow/tasks the worker recorded for
   * this project's latest run. `cancel` stops the workflow record; it does not
   * pretend to undo a provider request already sent.
   */
  if (action === "agent/workflow" && method === "GET") {
    return workflowStatusResponse(projectId);
  }
  if (action === "agent/workflow/cancel" && method === "POST") {
    return workflowCancelResponse(userId, projectId);
  }
  /**
   * ═══ FULL-STACK DEPLOYMENT OPERATIONS ═════════════════════════════════════
   *
   * These routes are project-scoped, so the catch-all has already proved
   * ownership. Each handler re-verifies ownership through the caller's
   * RLS-scoped client and is additionally gated by the explicit full-stack
   * cohort; a project outside it receives a truthful configuration refusal.
   *
   *   POST …/deployments/rollback   — restore a previously READY attempt
   *   POST …/deployments/disable    — real takedown (same contract as unpublish)
   *   GET  …/deployments/history    — attempt history / rollback targets
   *   GET  …/deployments/snapshots  — verified snapshots that may be pinned
   */
  if (action === "deployments/rollback" && method === "POST") {
    return rollbackResponse(userId, projectId, body);
  }
  if (action === "deployments/disable" && method === "POST") {
    return disableResponse(userId, projectId);
  }
  if (action === "deployments/history" && method === "GET") {
    return deploymentHistoryResponse(userId, projectId);
  }
  if (action === "deployments/snapshots" && method === "GET") {
    return deployableSnapshotsResponse(userId, projectId);
  }
  /**
   * ═══ APPLICATION DATABASE CONTRACT (METADATA ONLY) ════════════════════════
   *
   *   GET    …/database/config — is a connection configured and synced?
   *   PUT    …/database/config — validate + store the URL as a project secret
   *   DELETE …/database/config — remove the contract and its secret
   *
   * The URL is never returned. "Configured" is not a live connectivity proof.
   */
  if (action === "database/config") {
    if (method === "GET") return databaseStatusResponse(userId, projectId);
    if (method === "PUT" || method === "POST") {
      return databaseSaveResponse(userId, projectId, body);
    }
    if (method === "DELETE") return databaseRemoveResponse(userId, projectId);
  }
  if (action === "figma/status" && method === "GET") {
    return figmaStatusResponse(userId, projectId, query);
  }
  if (action === "figma/connect") {
    if (method === "POST") return figmaConnectResponse(userId, projectId, body);
    if (method === "DELETE") return figmaDisconnectResponse(userId, projectId);
  }
  /**
   * ═══ BUSINESS INTEGRATIONS (PHASE 6) ═════════════════════════════════════
   *
   *   GET    …/integrations/catalog               supported providers (static)
   *   GET    …/integrations/payments              truthful status + history
   *   PUT    …/integrations/payments              test + save credentials
   *   POST   …/integrations/payments/test         re-test stored credentials
   *   DELETE …/integrations/payments              disable (webhook token stays stable)
   *
   * The catalogue lists only implemented providers. Credential values are
   * write-only: every response is metadata. A deployment/project outside the
   * explicit cohort receives a precise 503, never a half-working screen.
   */
  if (action === "integrations/catalog" && method === "GET") {
    return ok(publicIntegrationCatalog());
  }
  if (action === "integrations/payments") {
    if (method === "GET") return paymentsStatusResponse(userId, projectId);
    if (method === "PUT" || method === "POST") {
      return savePaymentsIntegrationResponse(userId, projectId, body);
    }
    if (method === "DELETE") return disablePaymentsIntegrationResponse(userId, projectId);
  }
  if (action === "integrations/payments/test" && method === "POST") {
    return testPaymentsIntegrationResponse(userId, projectId);
  }
  /**
   * ═══ PROJECT MEMORY (PHASE 8) ═══════════════════════════════════════════
   *
   *   GET    …/memory                 decisions + observed outcomes + facts
   *   POST   …/memory                 create an explicit user decision
   *   DELETE …/memory?confirm=all     clear memory rows (never files/snapshots)
   *   PATCH  …/memory/{id}            edit content/status with revision
   *   DELETE …/memory/{id}            delete one memory
   *   POST   …/memory/{id}/approve    activate a proposed decision
   *   POST   …/memory/{id}/reject     archive it
   *
   * Every operation is project-scoped and authenticated. Memory is context, not
   * authorization; disabled/cohort refusal is explicit, never a fake list.
   */
  if (action === "memory") {
    if (method === "GET") return projectMemoryResponse(projectId, userId);
    if (method === "POST") return createProjectMemoryResponse(projectId, userId, body);
    if (method === "DELETE") return clearProjectMemoryResponse(projectId, userId, query);
  }
  if (action.startsWith("memory/")) {
    const rest = action.slice("memory/".length).split("/");
    const memoryId = rest[0];
    if (memoryId && rest.length === 1) {
      if (method === "PATCH" || method === "PUT") {
        return updateProjectMemoryResponse(projectId, userId, memoryId, body);
      }
      if (method === "DELETE") {
        return deleteProjectMemoryResponse(projectId, userId, memoryId);
      }
    }
    if (memoryId && rest.length === 2 && method === "POST" && rest[1] === "approve") {
      return updateProjectMemoryResponse(projectId, userId, memoryId, {
        ...recordOf(body),
        status: "active",
      });
    }
    if (memoryId && rest.length === 2 && method === "POST" && rest[1] === "reject") {
      return updateProjectMemoryResponse(projectId, userId, memoryId, {
        ...recordOf(body),
        status: "archived",
      });
    }
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

async function listProjectResponse(userId: string, query: URLSearchParams): Promise<NextResponse> {
  const requestedTypes = query.getAll("projectType");
  if (requestedTypes.length > 1) {
    return fail(400, "VALIDATION", "Project type must be website or android.");
  }
  const requestedType = requestedTypes[0];
  const projectType: ProjectType | undefined =
    requestedType === "website" || requestedType === "android" ? requestedType : undefined;
  if (requestedType !== undefined && projectType === undefined) {
    return fail(400, "VALIDATION", "Project type must be website or android.");
  }

  const result = await listProjects(userId, projectType);
  if (isStoreFailure(result)) return fail(500, "UNKNOWN", "Could not load projects.");

  const data: VcaasProjectSummary[] = result.data.map((row) => ({
    projectId: row.project_id,
    projectType: row.project_type ?? "website",
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

async function creditsResponse(): Promise<NextResponse> {
  const snapshot = await creditSnapshotForOwner();

  if (snapshot.errorCode === "MIGRATION_REQUIRED") {
    return fail(
      503,
      "MIGRATION_REQUIRED",
      snapshot.problem ??
        "Credit accounting needs migrations 31_credit_foundation.sql and 32_credit_reliability_hardening.sql.",
    );
  }
  if (snapshot.errorCode === "UNAVAILABLE") {
    return fail(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");
  }
  if (snapshot.errorCode) {
    return fail(500, "UNKNOWN", snapshot.problem ?? "Could not load the credit account.");
  }

  return ok(snapshot);
}

async function createProjectResponse(userId: string, body: unknown): Promise<NextResponse> {
  const record = recordOf(body);
  const requestedId = stringOf(record.projectId)?.trim() ?? "";
  const problem = validateProjectSlug(requestedId);
  if (problem) return fail(400, "VALIDATION", "Invalid project name.");
  const projectType = projectTypeOf(record.projectType);
  if (!projectType) return fail(400, "VALIDATION", "Project type must be website or android.");
  const creationRequestId = stringOf(record.clientRequestId)?.trim() ?? "";
  if (projectType === "android" && !isRequestId(creationRequestId)) {
    return fail(400, "VALIDATION", "A valid clientRequestId is required to create an Android project.");
  }

  const description = stringOf(record.description)?.slice(0, 2_000) ?? "";
  const label = stringOf(record.label)?.slice(0, 120) ?? requestedId;

  const created = await createOwnedProject(
    userId,
    requestedId,
    description,
    label,
    projectType,
    projectType === "android" ? creationRequestId : undefined,
  );
  if (isStoreFailure(created)) {
    if (created.code === "P0001" || /PROJECT_LIMIT_REACHED/i.test(created.error)) {
      return fail(403, "PROJECT_LIMIT_REACHED", "Your current plan has reached its project limit.");
    }
    return fail(created.code === "CONFLICT" ? 409 : 500, created.code ?? "UNKNOWN", created.error);
  }

  /**
   * ⚠️ EVERY WEBSITE PROJECT OWNS ITS CONTROL FILES FROM CREATION. The rules
   * file and the (initially empty) work log live in `project_files`, so the
   * explorer shows them before the first generation. A failure is reported, not
   * skipped: a project without rules would let the agents plan unconstrained.
   */
  if (projectType === "website") {
    const rules = await ensureProjectRuleFiles({
      userId,
      projectId: created.data.project_id,
      projectType,
    });
    if (!rules.ok) {
      await deleteProject(userId, created.data.project_id);
      return fail(500, "GENERATION_PERSIST_FAILED", (rules as { ok: false; error: string }).error);
    }
  }

  return ok(projectFromRow(created.data, null, false, null, null));
}

async function launchProjectResponse(userId: string, body: unknown): Promise<NextResponse> {
  const record = recordOf(body);
  const projectType = projectTypeOf(record.projectType);
  if (!projectType) return fail(400, "VALIDATION", "Project type must be website or android.");
  const creationRequestId = stringOf(record.clientRequestId)?.trim() ?? "";
  if (projectType === "android" && !isRequestId(creationRequestId)) {
    return fail(400, "VALIDATION", "A valid clientRequestId is required to launch an Android project.");
  }
  /**
   * A WEBSITE LAUNCH MAY ALSO CARRY A CREATION KEY. It is optional, but when it
   * is present a retry (double click, timeout, reconnect) resolves to the SAME
   * project and therefore to the SAME run instead of creating a second one.
   */
  if (projectType === "website" && creationRequestId && !isRequestId(creationRequestId)) {
    return fail(400, "VALIDATION", "clientRequestId must be a UUID.");
  }
  if (!isAiConfigured()) {
    return fail(503, "BACKEND_NOT_CONFIGURED", generationConfigurationError());
  }
  const workerConfig = generationWorkerConfig();
  if (workerConfig.production && !workerConfig.ready) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Production generation requires the existing server-side Supabase service-role configuration.",
    );
  }

  const prompt = (stringOf(record.prompt)?.trim() ?? "").slice(0, 32_000);
  if (!prompt) return fail(400, "VALIDATION", "A prompt is required.");

  const requestedId = stringOf(record.projectId)?.trim() ?? "";
  const problem = validateProjectSlug(requestedId);
  if (problem) return fail(400, "VALIDATION", "Invalid project name.");
  const requestedModel = stringOf(record.model)?.trim() ?? null;
  if (
    requestedModel === COHERE_NORTH_MINI_CODE_MODEL_ID &&
    !isCohereNorthMiniCodeEnabledForProject(requestedId)
  ) {
    return fail(403, "FORBIDDEN", "The Cohere testing model is not enabled for this project.");
  }

  const description = stringOf(record.description)?.slice(0, 2_000) || prompt.slice(0, 200);
  const label = stringOf(record.label)?.slice(0, 120) || requestedId;

  const created = await createOwnedProject(
    userId,
    requestedId,
    description,
    label,
    projectType,
    creationRequestId ? creationRequestId : undefined,
  );
  if (isStoreFailure(created)) {
    if (created.code === "P0001" || /PROJECT_LIMIT_REACHED/i.test(created.error)) {
      return fail(403, "PROJECT_LIMIT_REACHED", "Your current plan has reached its project limit.");
    }
    return fail(created.code === "CONFLICT" ? 409 : 500, created.code ?? "UNKNOWN", created.error);
  }

  /**
   * ⚠️ A KEYED LAUNCH MAY HAVE RETURNED AN EXISTING PROJECT. It is then not this
   * request's project, so no failure path below may delete it.
   */
  const mayReuseExistingProject = creationRequestId.length > 0;

  /**
   * Persist the two control files BEFORE the run is admitted, so the rules are
   * on disk before the planner can be called and a failure is reported instead
   * of silently planning without them.
   */
  if (projectType === "website") {
    const rules = await ensureProjectRuleFiles({
      userId,
      projectId: created.data.project_id,
      projectType,
    });
    if (!rules.ok) {
      if (!mayReuseExistingProject) await deleteProject(userId, created.data.project_id);
      return fail(500, "GENERATION_PERSIST_FAILED", (rules as { ok: false; error: string }).error);
    }
  }

  if (
    requestedModel === COHERE_NORTH_MINI_CODE_MODEL_ID &&
    !isCohereNorthMiniCodeEnabledForProject(created.data.project_id)
  ) {
    if (!mayReuseExistingProject) await deleteProject(userId, created.data.project_id);
    return fail(403, "FORBIDDEN", "The Cohere testing model is not enabled for this project.");
  }
  const model = resolveModel(requestedModel, "app-generation", process.env, created.data.project_id);
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
  const dispatchMode = dispatchModeForProject(created.data.project_id, workerConfig);
  const creditPolicy = creditAdmissionForProject(created.data.project_id);
  if (creditPolicy.kind === "misconfigured") {
    if (!mayReuseExistingProject) await deleteProject(userId, created.data.project_id);
    return fail(
      503,
      "CREDIT_CONFIGURATION",
      creditsProblemMessage(creditPolicy.problem),
    );
  }
  /** The server decides the cost; the request body cannot name it. */
  const creditCost = creditPolicy.kind === "enabled" ? creditPolicy.amount : null;
  const admission = await admitGeneration({
    userId,
    projectId: created.data.project_id,
    model: model.id,
    prompt,
    idempotencyKey: idempotencyKeyOf(record),
    dispatchMode,
    creditCost,
  });
  if (admission.kind === "failure") {
    emitGenerationEvent("generation.rejected", {
      projectId: created.data.project_id,
      reason: admission.code ?? "admission_failed",
      dispatchMode,
    });
    if (!mayReuseExistingProject) await deleteProject(userId, created.data.project_id);
    return admissionFailure(admission);
  }
  if (admission.kind === "insufficient") {
    emitGenerationEvent("credits.refused", {
      projectId: created.data.project_id,
      reason: "INSUFFICIENT_CREDITS",
      status: "insufficient_credits",
      ...(admission.available !== null ? { credits: admission.available } : {}),
    });
    if (!mayReuseExistingProject) await deleteProject(userId, created.data.project_id);
    return fail(
      402,
      "INSUFFICIENT_CREDITS",
      "You do not have enough available credits to start this generation. Nothing was charged and no run was created.",
    );
  }
  if (admission.kind === "rate_limited") {
    emitGenerationEvent("generation.rejected", {
      projectId: created.data.project_id,
      reason: "rate_limited",
      status: admission.scope,
      dispatchMode,
    });
    if (!mayReuseExistingProject) await deleteProject(userId, created.data.project_id);
    return rateLimited(admission.scope, admission.retryAfterSeconds);
  }
  if (admission.kind === "conflict") {
    emitGenerationEvent("generation.rejected", {
      projectId: created.data.project_id,
      reason: "conflict",
      dispatchMode,
    });
    if (!mayReuseExistingProject) await deleteProject(userId, created.data.project_id);
    return fail(409, "CONFLICT", "A generation is already active for this project.");
  }
  if (admission.status === "existing") {
    /**
     * ⚠️ A RETRY IS NOT A CONFLICT. The creation key resolved to the same
     * project, so the generation key resolved to the same run: return it,
     * start nothing, charge nothing and delete nothing.
     */
    return ok({
      projectId: created.data.project_id,
      ...(created.data.project_id !== requestedId ? { requestedProjectId: requestedId } : {}),
      agent: { started: true, status: admission.run.finished_at ? "done" : "init" },
      warnings,
    });
  }

  const run = admission.run;
  if (creditCost !== null) {
    emitGenerationEvent("credits.reserved", {
      runId: run.id,
      projectId: created.data.project_id,
      traceId: run.trace_id,
      credits: creditCost,
      status: "reserved",
    });
  }
  const message = await insertMessage(created.data.project_id, "user", prompt);
  if (isStoreFailure(message)) {
    const finished = await finishOwnerRun({
      userId,
      projectId: created.data.project_id,
      runId: run.id,
      dispatchMode: run.dispatch_mode,
      status: "error",
      message: "Could not save the prompt.",
      stage: "failed",
      errorCode: "RUN_PROMPT_SAVE_FAILED",
      reason: "Run could not start",
    });
    if (!finished) {
      return fail(
        503,
        "CREDIT_SETTLEMENT_DEFERRED",
        "The prompt could not be saved and the run could not be safely finalized. It was kept for recovery.",
      );
    }
    if (projectType !== "android") await deleteProject(userId, created.data.project_id);
    return fail(500, "UNKNOWN", "Could not start the agent.");
  }

  emitGenerationEvent("generation.accepted", {
    traceId: run.trace_id,
    runId: run.id,
    projectId: created.data.project_id,
    model: run.model,
    dispatchMode: run.dispatch_mode,
  });

  /**
   * ⚠️ A WORKER JOB IS NOT STARTED INLINE. The scheduler's worker tick claims
   * it; starting `after()` here would create a second executor for one job.
   */
  if (run.dispatch_mode !== "worker") {
    after(() =>
      runAgent({
        userId,
        projectId: created.data.project_id,
        runId: run.id,
        prompt,
        requestedModel: run.model,
      }),
    );
  }

  const data: ProjectLaunchResult = {
    projectId: created.data.project_id,
    ...(created.data.project_id !== requestedId ? { requestedProjectId: requestedId } : {}),
    agent: { started: true, status: "init" },
    warnings,
  };
  return ok(data);
}

function projectTypeOf(value: unknown): ProjectType | null {
  if (value === undefined || value === "website") return "website";
  if (value === "android") return "android";
  return null;
}

function isRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function idempotencyKeyOf(body: Record<string, unknown>): string | null {
  const raw = stringOf(body.clientRequestId) ?? stringOf(body.idempotencyKey);
  const key = raw?.trim().slice(0, 200) ?? "";
  return key || null;
}

/**
 * The launch path's one admission answer, whether credits are enforced or not.
 *
 * ⚠️ THE SERVER DECIDES THE CREDIT COST. `creditCost` comes from the
 * server-side project cohort, never from the request body.
 */
type LaunchAdmission =
  | { kind: "run"; status: "created" | "existing"; run: RunRow }
  | { kind: "conflict" }
  | { kind: "rate_limited"; scope: "user" | "global"; retryAfterSeconds: number }
  | { kind: "insufficient"; available: number | null; required: number | null }
  | { kind: "failure"; error: string; code?: string };

async function admitGeneration(input: {
  userId: string;
  projectId: string;
  model: string;
  prompt: string;
  idempotencyKey: string | null;
  dispatchMode: "inline" | "worker";
  creditCost: number | null;
}): Promise<LaunchAdmission> {
  if (input.creditCost !== null) {
    if (!input.idempotencyKey || !isRequestId(input.idempotencyKey)) {
      return {
        kind: "failure",
        error: "A UUID clientRequestId is required for credit-enabled generation.",
        code: "INVALID",
      };
    }
    if (input.dispatchMode !== "worker") {
      return {
        kind: "failure",
        error: "Credit-enabled generation requires the durable worker for this project.",
        code: "UNAVAILABLE",
      };
    }
    const admitted = await createGenerationJobWithCredits({
      userId: input.userId,
      projectId: input.projectId,
      model: input.model,
      prompt: input.prompt,
      idempotencyKey: input.idempotencyKey,
      dispatchMode: input.dispatchMode,
      amountCredits: input.creditCost,
    });
    if (isCreditsFailure(admitted)) {
      if (admitted.code === "INSUFFICIENT_CREDITS") {
        return {
          kind: "insufficient",
          available: admitted.available ?? null,
          required: admitted.required ?? input.creditCost,
        };
      }
      return { kind: "failure", error: admitted.error, code: admitted.code };
    }
    if (admitted.data.status === "rate_limited") {
      return {
        kind: "rate_limited",
        scope: admitted.data.scope,
        retryAfterSeconds: admitted.data.retryAfterSeconds,
      };
    }
    if (admitted.data.status === "conflict") return { kind: "conflict" };
    return { kind: "run", status: admitted.data.status, run: admitted.data.run };
  }

  const admitted = await createGenerationJob({
    projectId: input.projectId,
    model: input.model,
    prompt: input.prompt,
    idempotencyKey: input.idempotencyKey,
    dispatchMode: input.dispatchMode,
  });
  if (isStoreFailure(admitted)) {
    if (/CREDIT_(?:POLICY|RESERVATION|RUN_STATE)/i.test(`${admitted.code ?? ""} ${admitted.error}`)) {
      return {
        kind: "failure",
        error: "The database has credit enforcement enabled but this request is not configured for a reserved worker run.",
        code: "UNAVAILABLE",
      };
    }
    return { kind: "failure", error: admitted.error, code: admitted.code };
  }
  if (admitted.data.status === "rate_limited") {
    return {
      kind: "rate_limited",
      scope: admitted.data.scope,
      retryAfterSeconds: admitted.data.retryAfterSeconds,
    };
  }
  if (admitted.data.status === "conflict") return { kind: "conflict" };
  return { kind: "run", status: admitted.data.status, run: admitted.data.run };
}

async function finishOwnerRun(input: {
  userId: string;
  projectId: string;
  runId: string;
  dispatchMode: "inline" | "worker";
  status: "error" | "cancelled";
  message: string;
  stage: "failed" | "cancelled" | "interrupted";
  errorCode: string;
  reason: string;
}): Promise<boolean> {
  if (input.dispatchMode === "worker") {
    const creditFinish = await finishCreditGenerationRun({
      userId: input.userId,
      projectId: input.projectId,
      runId: input.runId,
      status: input.status,
      stage: input.stage,
      errorCode: input.errorCode,
      errorMessage: input.message,
      reason: input.reason,
    });
    if (!isCreditsFailure(creditFinish)) {
      if (creditFinish.data !== "not_credit_project") {
        if (creditFinish.data === input.status) {
          emitGenerationEvent("credits.released", {
            runId: input.runId,
            projectId: input.projectId,
            status: "released",
          });
        }
        return creditFinish.data === input.status;
      }
    } else if (
      creditFinish.code !== "MIGRATION_REQUIRED" &&
      creditFinish.code !== "UNAVAILABLE"
    ) {
      console.error(`[mavly] credit terminal transition failed: ${creditFinish.code}`);
      return false;
    }
  }

  return finishRun(input.runId, input.status, input.message, {
    stage: input.stage,
    errorCode: input.errorCode,
    cancellationRequestedAt: input.status === "cancelled" ? new Date().toISOString() : undefined,
  });
}

function admissionFailure(failure: { error: string; code?: string }): NextResponse {
  if (failure.code === "INVALID") return fail(400, "VALIDATION", failure.error);
  if (failure.code === "MIGRATION_REQUIRED") {
    return fail(503, "MIGRATION_REQUIRED", failure.error);
  }
  if (failure.code === "UNAUTHENTICATED") return fail(401, "UNAUTHENTICATED", failure.error);
  if (failure.code === "FORBIDDEN") return fail(403, "FORBIDDEN", failure.error);
  if (failure.code === "CONFLICT") return fail(409, "CONFLICT", failure.error);
  if (failure.code === "UNAVAILABLE") {
    return fail(503, "CREDIT_CONFIGURATION", failure.error);
  }
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
  const preview =
    project.data.project_type === "android"
      ? {
          available: false,
          reason: "Native Android projects do not have a web preview.",
          entryPath: null,
          updatedAt: null,
        }
      : await staticPreviewState(projectId);
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
      preview.entryPath && preview.updatedAt
        ? { path: preview.entryPath, updatedAt: preview.updatedAt }
        : null,
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
  const preview =
    updated.data.project_type === "android"
      ? {
          available: false,
          reason: "Native Android projects do not have a web preview.",
          entryPath: null,
          updatedAt: null,
        }
      : await staticPreviewState(projectId);
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
      preview.entryPath && preview.updatedAt
        ? { path: preview.entryPath, updatedAt: preview.updatedAt }
        : null,
    ),
  );
}

async function deleteProjectResponse(userId: string, projectId: string): Promise<NextResponse> {
  const deployment = await getDeploymentRow(projectId);
  if (isDeploymentStoreFailure(deployment)) {
    return fail(500, "UNKNOWN", "Could not check the project's hosting state before deletion.");
  }
  if (deployment.data?.provider === "aws") {
    if (deployment.data.status !== "unpublished") {
      const unpublished = await unpublishProject(userId, projectId);
      if (isDeploymentServiceFailure(unpublished)) {
        return fail(unpublished.status, unpublished.code, unpublished.error);
      }
      if (unpublished.data.status !== "unpublished") {
        return fail(
          409,
          "VALIDATION",
          "The AWS site is still being unpublished. Wait for that operation to finish before deleting the project.",
        );
      }
    }
  }

  const deleted = await deleteProject(userId, projectId);
  if (isStoreFailure(deleted)) return fail(500, "UNKNOWN", "Could not delete this project.");
  return ok({ deleted: true });
}

async function deployResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  const deployment = await getDeploymentRow(projectId);
  if (isDeploymentStoreFailure(deployment)) {
    return fail(500, "UNKNOWN", "Could not load the deployment status.");
  }
  const awsConfig = readAwsFrontendHostingConfig();
  const awsRouteAllowed =
    deployment.data?.provider === "aws" ||
    (awsConfig.enabled &&
      awsConfig.problem === null &&
      isAwsFrontendHostingProject(projectId));
  if (!awsRouteAllowed) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Customer-app publishing is unavailable for this project. No deployment provider is configured.",
    );
  }

  const record = recordOf(body);
  const result = await publishProject(userId, projectId, {
    snapshotId: stringOf(record.snapshotId),
    approvalId: stringOf(record.approvalId),
  });
  if (isDeploymentServiceFailure(result)) {
    return fail(
      result.status,
      result.code,
      result.error,
      result.retryAfterSeconds
        ? { "retry-after": String(result.retryAfterSeconds) }
        : undefined,
    );
  }
  return ok(result.data);
}

async function rejectAndroidWebsiteDeployment(
  userId: string,
  projectId: string,
): Promise<NextResponse | null> {
  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) return fail(500, "UNKNOWN", "Could not load this project.");
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");
  if (project.data.project_type !== "android") return null;

  return fail(
    503,
    "ANDROID_HOSTING_NOT_CONFIGURED",
    "Static website publishing does not apply to Android projects. Debug APK builds use the Android build queue, and no Android hosting or store publishing is implemented.",
  );
}

async function requireAndroidProject(
  userId: string,
  projectId: string,
): Promise<NextResponse | null> {
  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) return fail(500, "UNKNOWN", "Could not load this project.");
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");
  if (project.data.project_type !== "android") {
    return fail(
      400,
      "NOT_ANDROID_PROJECT",
      "This endpoint is only available for Android projects.",
    );
  }
  return null;
}

const ANDROID_BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function androidBuildWire(build: AndroidBuildView) {
  const status =
    build.status === "succeeded"
      ? ("success" as const)
      : build.status === "failed" ||
          build.status === "timed_out" ||
          build.status === "configuration_error" ||
          build.status === "infrastructure_error"
        ? ("failed" as const)
        : build.status;
  return {
    id: build.id,
    platform: "android" as const,
    status,
    state: build.status,
    stage: build.stage,
    attempt: build.attempt,
    maxAttempts: build.maxAttempts,
    toolchain: build.toolchain,
    variant: build.variant,
    createdAt: build.createdAt,
    startedAt: build.startedAt,
    finishedAt: build.finishedAt,
    cancelRequestedAt: build.cancelRequestedAt,
    artifactState: build.artifactState,
    artifact: build.artifact
      ? {
          type: "apk" as const,
          fileName: build.artifact.fileName,
          sizeBytes: build.artifact.sizeBytes,
          sha256: build.artifact.sha256,
          applicationId: build.artifact.applicationId,
          expiresAt: build.artifact.expiresAt,
        }
      : null,
    signed: false as const,
    error: build.error,
    logExcerpt: build.logExcerpt,
    logTruncated: build.logTruncated,
    hasLog: build.hasLog,
  };
}

function androidBuildFailureResponse(failure: {
  code: string;
  error: string;
}): NextResponse {
  if (failure.code === "MIGRATION_REQUIRED") return fail(503, "MIGRATION_REQUIRED", failure.error);
  if (failure.code === "UNAUTHENTICATED") return fail(401, "UNAUTHENTICATED", failure.error);
  if (failure.code === "FORBIDDEN") return fail(403, "FORBIDDEN", failure.error);
  if (failure.code === "NOT_FOUND") return fail(404, "ANDROID_BUILD_NOT_FOUND", failure.error);
  if (failure.code === "CONFLICT") return fail(400, "ANDROID_BUILD_INVALID", failure.error);
  return fail(500, "UNKNOWN", "The Android build request could not be completed.");
}

type AndroidBuildSnapshotOutcome =
  | { ok: true; snapshotId: string; sourceHash: string }
  | { ok: false; response: NextResponse };

async function androidBuildSnapshot(
  userId: string,
  projectId: string,
): Promise<AndroidBuildSnapshotOutcome> {
  const files = await listFiles(projectId);
  if (isStoreFailure(files)) {
    return { ok: false, response: fail(500, "UNKNOWN", "Could not read the project source.") };
  }
  const sourceFiles = files.data.map((file) => ({ path: file.path, content: file.content }));
  if (sourceFiles.length === 0) {
    return {
      ok: false,
      response: fail(409, "ANDROID_SOURCE_MISSING", "Generate Android source before starting a build."),
    };
  }

  const contract = validateAndroidProject(sourceFiles, androidPackageForProject(projectId));
  if (contract.ok === false) {
    const detail = contract.violations.slice(0, 5).join("; ");
    return {
      ok: false,
      response: fail(
        409,
        "ANDROID_CONTRACT_INVALID",
        `${contract.error}${detail ? ` ${detail}` : ""}`,
      ),
    };
  }

  const sourceHash = hashSource(sourceFiles);
  const existing = await listSnapshots(projectId, { limit: 50 });
  if (!isSnapshotFailure(existing)) {
    const reusable = existing.data.find(
      (snapshot) => snapshot.status === "ready" && snapshot.sourceHash === sourceHash,
    );
    if (reusable) {
      return { ok: true, snapshotId: reusable.id, sourceHash };
    }
  }

  const created = await createSnapshot({
    userId,
    projectId,
    kind: "manual",
    description: "Android build input",
    files: sourceFiles,
  });
  if (isSnapshotFailure(created)) {
    return {
      ok: false,
      response: fail(500, "UNKNOWN", "Could not save the immutable Android build snapshot."),
    };
  }
  return { ok: true, snapshotId: created.data.id, sourceHash: created.data.sourceHash };
}

async function androidBuildsResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const unsupported = await requireAndroidProject(userId, projectId);
  if (unsupported) return unsupported;

  const config = androidBuildConfig();
  const supabase = await createSupabaseServerClient();
  if (!supabase) return fail(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");
  const schema = await androidBuildSchemaVersion(supabase);
  if (schema === null) {
    return fail(
      503,
      "MIGRATION_REQUIRED",
      "Android builds need migration 26_android_builds.sql.",
    );
  }

  const builds = await listAndroidBuilds(supabase, projectId, 20);
  if (isAndroidBuildStoreFailure(builds)) return androidBuildFailureResponse(builds);
  return ok({
    builds: builds.data.map(androidBuildWire),
    capability: androidCapability(projectId, config),
  });
}

async function androidBuildStartResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  const unsupported = await requireAndroidProject(userId, projectId);
  if (unsupported) return unsupported;

  const record = recordOf(body);
  const platform = stringOf(record.platform)?.trim().toLowerCase() || "android";
  if (platform !== "android") {
    return fail(
      400,
      "PLATFORM_NOT_CONFIGURED",
      "Only Android debug builds are available; iOS builds are not configured.",
    );
  }

  const config = androidBuildConfig();
  if (!config.ready) {
    return fail(
      503,
      "ANDROID_BUILD_NOT_CONFIGURED",
      androidBuildProblemMessage(config.problems[0] ?? "disabled"),
    );
  }
  if (!isProjectInAndroidBuildCohort(projectId, config)) {
    return fail(
      503,
      "ANDROID_BUILD_NOT_CONFIGURED",
      "This project is outside the Android build cohort.",
    );
  }
  if (!generationWorkerConfig().ready) {
    return fail(
      503,
      "ANDROID_BUILD_NOT_CONFIGURED",
      "The durable generation worker's Supabase credentials are not configured, so Android builds cannot be claimed.",
    );
  }
  if (config.provider !== "vercel") {
    return fail(503, "ANDROID_BUILD_NOT_CONFIGURED", "No supported Android build provider is configured.");
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return fail(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");
  const schema = await androidBuildSchemaVersion(supabase);
  if (schema === null) {
    return fail(503, "MIGRATION_REQUIRED", "Android builds need migration 26_android_builds.sql.");
  }

  const rawKey = stringOf(record.clientRequestId) ?? stringOf(record.idempotencyKey);
  const idempotencyKey = rawKey?.trim().slice(0, 200) || null;

  // Avoid creating a snapshot for a request the active-project rule will fold
  // into an existing build. The RPC still enforces this atomically.
  const active = await listAndroidBuilds(supabase, projectId, 5);
  if (isAndroidBuildStoreFailure(active)) return androidBuildFailureResponse(active);
  const existing = active.data.find(
    (build) => build.status === "queued" || build.status === "running",
  );
  if (existing) {
    return ok({
      status: "existing",
      build: androidBuildWire(existing),
      capability: androidCapability(projectId, config),
    });
  }

  const snapshot = await androidBuildSnapshot(userId, projectId);
  if (snapshot.ok === false) return snapshot.response;

  const created = await createAndroidBuild(supabase, {
    projectId,
    snapshotId: snapshot.snapshotId,
    sourceHash: snapshot.sourceHash,
    toolchain: config.toolchain || ANDROID_BUILD_TOOLCHAIN,
    idempotencyKey,
  });
  if (isAndroidBuildStoreFailure(created)) return androidBuildFailureResponse(created);
  if (created.data.status === "rate_limited") {
    return fail(429, "RATE_LIMITED", "An Android build is already queued or running.", {
      "retry-after": String(created.data.retryAfterSeconds),
    });
  }

  return ok({
    status: created.data.status,
    build: androidBuildWire(created.data.build),
    capability: androidCapability(projectId, config),
  });
}

async function androidBuildArtifactResponse(
  userId: string,
  projectId: string,
  action: string,
): Promise<NextResponse> {
  const unsupported = await requireAndroidProject(userId, projectId);
  if (unsupported) return unsupported;

  const rest = action.slice("mobile/builds/".length).split("/");
  const buildId = rest[0];
  if (
    !buildId ||
    !ANDROID_BUILD_ID_PATTERN.test(buildId) ||
    rest.length !== 2 ||
    (rest[1] !== "download" && rest[1] !== "log")
  ) {
    return fail(404, "NOT_FOUND", "Not found");
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return fail(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");
  const owned = await getAndroidBuildForOwner(supabase, projectId, buildId);
  if (isAndroidBuildStoreFailure(owned)) return androidBuildFailureResponse(owned);
  if (!owned.data) return fail(404, "ANDROID_BUILD_NOT_FOUND", "No such Android build exists for this project.");

  const view = toAndroidBuildView(owned.data);
  if (rest[1] === "log") {
    return ok({ log: view.logExcerpt, truncated: view.logTruncated, hasLog: view.hasLog });
  }

  if (view.status !== "succeeded") {
    return fail(409, "ANDROID_BUILD_NOT_READY", "This Android build has not produced a verified artifact.");
  }
  if (!view.artifact) {
    if (view.artifactState === "expiring" || view.artifactState === "expired") {
      return fail(410, "ANDROID_ARTIFACT_EXPIRED", "This Android artifact has expired.");
    }
    if (view.artifactState === "delete_failed" || view.artifactState === "failed") {
      return fail(410, "ANDROID_ARTIFACT_UNAVAILABLE", "This Android artifact is no longer available.");
    }
    return fail(404, "ANDROID_ARTIFACT_NOT_FOUND", "No verified Android artifact exists.");
  }

  const service = createSupabaseWorkerClient();
  if (!service) {
    return fail(503, "ANDROID_ARTIFACT_NOT_CONFIGURED", "Private artifact storage is not configured.");
  }
  const full = await getAndroidBuildFull(service, projectId, buildId);
  if (isAndroidBuildStoreFailure(full)) return androidBuildFailureResponse(full);
  if (
    !full.data ||
    full.data.artifact_state !== "available" ||
    !full.data.artifact_bucket ||
    !full.data.artifact_path ||
    !full.data.artifact_expires_at ||
    Date.parse(full.data.artifact_expires_at) <= Date.now()
  ) {
    return fail(410, "ANDROID_ARTIFACT_UNAVAILABLE", "This Android artifact is no longer available.");
  }

  const store = createAndroidArtifactStore(service, full.data.artifact_bucket);
  const signed = await store.sign(full.data.artifact_path, 300);
  if (signed.ok === false) {
    return fail(503, "ANDROID_ARTIFACT_UNAVAILABLE", "The private artifact could not be authorized.");
  }

  return ok({
    url: signed.data.url,
    urlExpiresAt: signed.data.expiresAt,
    artifactType: "apk",
    buildId,
    fileName: view.artifact.fileName,
    sizeBytes: view.artifact.sizeBytes,
    sha256: view.artifact.sha256,
    applicationId: view.artifact.applicationId,
  });
}

async function androidBuildActionResponse(
  userId: string,
  projectId: string,
  action: string,
): Promise<NextResponse> {
  const unsupported = await requireAndroidProject(userId, projectId);
  if (unsupported) return unsupported;

  const rest = action.slice("mobile/builds/".length).split("/");
  const buildId = rest[0];
  if (!buildId || !ANDROID_BUILD_ID_PATTERN.test(buildId) || rest.length !== 2) {
    return fail(404, "NOT_FOUND", "Not found");
  }
  if (rest[1] === "store-upload") {
    return fail(
      503,
      "ANDROID_BUILD_NOT_CONFIGURED",
      "A store upload needs a release-signed build, and release signing/publishing is not configured.",
    );
  }
  if (rest[1] === "cancel") {
    const supabase = await createSupabaseServerClient();
    if (!supabase) return fail(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");
    const cancelled = await cancelAndroidBuild(supabase, projectId, buildId);
    if (isAndroidBuildStoreFailure(cancelled)) return androidBuildFailureResponse(cancelled);
    if (cancelled.data.status === "not_found") {
      return fail(404, "ANDROID_BUILD_NOT_FOUND", "No such Android build exists for this project.");
    }
    return ok({
      status: cancelled.data.status,
      build: cancelled.data.build ? androidBuildWire(cancelled.data.build) : null,
    });
  }
  return fail(404, "NOT_FOUND", "Not found");
}

async function unpublishResponse(userId: string, projectId: string): Promise<NextResponse> {
  const deployment = await getDeploymentRow(projectId);
  if (isDeploymentStoreFailure(deployment)) {
    return fail(500, "UNKNOWN", "Could not load the deployment status.");
  }
  if (deployment.data?.provider !== "aws") {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Mavly does not manage unpublishing for this deployment provider.",
    );
  }
  const result = await unpublishProject(userId, projectId);
  if (isDeploymentServiceFailure(result)) {
    return fail(result.status, result.code, result.error);
  }
  return ok(result.data);
}

async function deploymentStatusResponse(userId: string, projectId: string): Promise<NextResponse> {
  const deployment = await getDeploymentRow(projectId);
  if (isDeploymentStoreFailure(deployment)) {
    return fail(500, "UNKNOWN", "Could not load the deployment status.");
  }
  const awsConfig = readAwsFrontendHostingConfig();
  const awsRouteAllowed =
    deployment.data?.provider === "aws" ||
    (awsConfig.enabled &&
      awsConfig.problem === null &&
      isAwsFrontendHostingProject(projectId));
  if (!awsRouteAllowed) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Customer-app deployment status is unavailable for this project.",
    );
  }

  const result = await getProjectDeploymentStatus(userId, projectId);
  if (isDeploymentServiceFailure(result)) {
    return fail(result.status, result.code, result.error);
  }
  return ok(result.data);
}

function workflowStoreFailureResponse(failure: {
  code: string;
  error: string;
}): NextResponse {
  switch (failure.code) {
    case "migration_required":
    case "unavailable":
      return fail(503, "BACKEND_NOT_CONFIGURED", failure.error);
    case "unauthorized":
      return fail(403, "FORBIDDEN", failure.error);
    case "not_found":
      return fail(404, "NOT_FOUND", failure.error);
    case "conflict":
      return fail(409, "CONFLICT", failure.error);
    default:
      return fail(500, "UNKNOWN", failure.error);
  }
}

async function workflowStatusResponse(projectId: string): Promise<NextResponse> {
  const config = multiAgentConfig();
  const enabled = isProjectInMultiAgentCohort(projectId, config);
  const approvalRequired = deploymentApprovalRequiredFor(projectId);
  const note = enabled ? undefined : multiAgentProblemMessage(config.problems);
  const client = await createSupabaseServerClient();
  if (!client) {
    return fail(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");
  }

  const workflow = await getLatestWorkflow(client, projectId);
  if (isWorkflowStoreFailure(workflow)) {
    if (workflow.code === "migration_required") {
      return ok({
        enabled,
        approvalRequired,
        migrationRequired: true,
        workflow: null,
        note: workflow.error,
      });
    }
    return workflowStoreFailureResponse(workflow);
  }
  if (!workflow.data) {
    return ok({
      enabled,
      approvalRequired,
      migrationRequired: false,
      workflow: null,
      ...(note ? { note } : {}),
    });
  }

  const tasks = await listTasks(client, workflow.data.id);
  if (isWorkflowStoreFailure(tasks)) return workflowStoreFailureResponse(tasks);
  return ok({
    enabled,
    approvalRequired,
    migrationRequired: false,
    workflow: toWorkflowView(workflow.data, tasks.data),
    ...(note ? { note } : {}),
  });
}

async function workflowCancelResponse(userId: string, projectId: string): Promise<NextResponse> {
  const ownership = await getProject(userId, projectId);
  if (isStoreFailure(ownership)) {
    return fail(500, "UNKNOWN", "Could not load this project.");
  }
  if (!ownership.data || ownership.data.user_id !== userId) {
    return fail(403, "FORBIDDEN", "You don't have access to this project.");
  }

  const client = await createSupabaseServerClient();
  if (!client) {
    return fail(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");
  }
  const latest = await getLatestWorkflow(client, projectId);
  if (isWorkflowStoreFailure(latest)) return workflowStoreFailureResponse(latest);
  if (!latest.data) return fail(404, "NOT_FOUND", "This project has no workflow to cancel.");

  const cancelled = await cancelOwnedWorkflow(client, projectId, latest.data.id);
  if (isWorkflowStoreFailure(cancelled)) {
    return workflowStoreFailureResponse(cancelled);
  }
  return workflowStatusResponse(projectId);
}

async function deploymentProposalsResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await listProposals(userId, projectId);
  if (isApprovalServiceFailure(result)) return fail(result.status, result.code, result.error);
  return ok(result.data);
}

async function proposeDeploymentResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  const record = recordOf(body);
  const result = await proposeDeployment(userId, projectId, {
    snapshotId: stringOf(record.snapshotId),
    target: record.target,
  });
  if (isApprovalServiceFailure(result)) return fail(result.status, result.code, result.error);
  return ok(result.data);
}

async function deploymentProposalResponse(
  userId: string,
  projectId: string,
  proposalId: string,
): Promise<NextResponse> {
  const result = await getProposal(userId, projectId, proposalId);
  if (isApprovalServiceFailure(result)) return fail(result.status, result.code, result.error);
  return ok(result.data);
}

async function approveDeploymentProposalResponse(
  userId: string,
  projectId: string,
  proposalId: string,
): Promise<NextResponse> {
  const result = await approveProposal(userId, projectId, proposalId);
  if (isApprovalServiceFailure(result)) return fail(result.status, result.code, result.error);
  return ok(result.data);
}

async function revokeDeploymentProposalResponse(
  userId: string,
  projectId: string,
  proposalId: string,
  body: unknown,
): Promise<NextResponse> {
  const reason = stringOf(recordOf(body).reason);
  const result = await revokeProposal(userId, projectId, proposalId, reason);
  if (isApprovalServiceFailure(result)) return fail(result.status, result.code, result.error);
  return ok(result.data);
}

function fullstackFailureResponse(failure: {
  status: number;
  code: string;
  error: string;
  retryAfterSeconds?: number;
}): NextResponse {
  return fail(
    failure.status,
    failure.code,
    failure.error,
    failure.retryAfterSeconds ? { "retry-after": String(failure.retryAfterSeconds) } : undefined,
  );
}

async function rollbackResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  const result = await rollbackFullstackProject(userId, projectId, body);
  if (isFullstackFailure(result)) return fullstackFailureResponse(result);
  return ok(result.data);
}

async function disableResponse(userId: string, projectId: string): Promise<NextResponse> {
  const result = await disableFullstackProject(userId, projectId);
  if (isFullstackFailure(result)) return fullstackFailureResponse(result);
  return ok(result.data);
}

async function deploymentHistoryResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await fullstackDeploymentHistory(userId, projectId);
  if (isFullstackFailure(result)) return fullstackFailureResponse(result);
  return ok(result.data);
}

async function deployableSnapshotsResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await fullstackDeployableSnapshots(userId, projectId);
  if (isFullstackFailure(result)) return fullstackFailureResponse(result);
  return ok(result.data);
}

async function databaseStatusResponse(userId: string, projectId: string): Promise<NextResponse> {
  const result = await getDatabaseStatus(userId, projectId);
  if (isDatabaseServiceFailure(result)) {
    return fail(result.status, result.code, result.error);
  }
  return ok(result.data);
}

async function databaseSaveResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  const result = await saveDatabaseConfig(userId, projectId, body);
  if (isDatabaseServiceFailure(result)) {
    return fail(result.status, result.code, result.error);
  }
  return ok(result.data);
}

async function databaseRemoveResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await removeDatabaseConfig(userId, projectId);
  if (isDatabaseServiceFailure(result)) {
    return fail(result.status, result.code, result.error);
  }
  return ok(result.data);
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

function paymentsFail(result: PaymentsServiceFailure): NextResponse {
  return fail(result.status, result.code, result.error);
}

async function paymentsStatusResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await getPaymentsStatus(projectId, userId);
  if (isPaymentsServiceFailure(result)) return paymentsFail(result);
  return ok(result.data);
}

async function savePaymentsIntegrationResponse(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<NextResponse> {
  const result = await savePaymentsIntegration(projectId, userId, body);
  if (isPaymentsServiceFailure(result)) return paymentsFail(result);
  return ok(result.data);
}

async function testPaymentsIntegrationResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await testPaymentsIntegration(projectId, userId);
  if (isPaymentsServiceFailure(result)) return paymentsFail(result);
  return ok(result.data);
}

async function disablePaymentsIntegrationResponse(
  userId: string,
  projectId: string,
): Promise<NextResponse> {
  const result = await disablePaymentsIntegration(projectId, userId);
  if (isPaymentsServiceFailure(result)) return paymentsFail(result);
  return ok(result.data);
}

function memoryFail(result: MemoryServiceFailure): NextResponse {
  return fail(result.status, result.code, result.error);
}

async function projectMemoryResponse(
  projectId: string,
  userId: string,
): Promise<NextResponse> {
  const result = await listProjectMemory(projectId, userId);
  if (isMemoryServiceFailure(result)) return memoryFail(result);
  return ok(result.data);
}

async function createProjectMemoryResponse(
  projectId: string,
  userId: string,
  body: unknown,
): Promise<NextResponse> {
  const result = await createProjectDecision(projectId, userId, body);
  if (isMemoryServiceFailure(result)) return memoryFail(result);
  return ok(result.data);
}

async function updateProjectMemoryResponse(
  projectId: string,
  userId: string,
  memoryId: string,
  body: unknown,
): Promise<NextResponse> {
  const result = await updateProjectMemory(projectId, userId, memoryId, body);
  if (isMemoryServiceFailure(result)) return memoryFail(result);
  return ok(result.data);
}

async function deleteProjectMemoryResponse(
  projectId: string,
  userId: string,
  memoryId: string,
): Promise<NextResponse> {
  const result = await deleteProjectMemory(projectId, userId, memoryId);
  if (isMemoryServiceFailure(result)) return memoryFail(result);
  return ok(result.data);
}

async function clearProjectMemoryResponse(
  projectId: string,
  userId: string,
  query: URLSearchParams,
): Promise<NextResponse> {
  const result = await clearProjectMemory(projectId, userId, query.get("confirm"));
  if (isMemoryServiceFailure(result)) return memoryFail(result);
  return ok(result.data);
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

async function startAgentResponse(userId: string, projectId: string, body: unknown): Promise<NextResponse> {
  if (!isAiConfigured()) {
    return fail(503, "BACKEND_NOT_CONFIGURED", generationConfigurationError());
  }
  const workerConfig = generationWorkerConfig();
  if (workerConfig.production && !workerConfig.ready) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Production generation requires the existing server-side Supabase service-role configuration.",
    );
  }

  /**
   * Read the project type before admission so a website follow-up cannot be
   * accepted without its rules and work-state files. The run engine re-checks
   * this for legacy projects and for worker-dispatched runs.
   */
  const projectRecord = await getProject(userId, projectId);
  if (isStoreFailure(projectRecord)) {
    return fail(500, "UNKNOWN", "Could not read this project before generation.");
  }
  if (!projectRecord.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");
  if (projectRecord.data.project_type !== "android") {
    const rules = await ensureProjectRuleFiles({
      userId,
      projectId,
      projectType: "website",
    });
    if (!rules.ok) return fail(500, "GENERATION_PERSIST_FAILED", (rules as { ok: false; error: string }).error);
  }

  const record = recordOf(body);
  const prompt = (stringOf(record.prompt)?.trim() ?? "").slice(0, 32_000);
  if (!prompt) return fail(400, "VALIDATION", "A prompt is required.");

  const requestedModel = stringOf(record.model)?.trim() ?? null;
  if (
    requestedModel === COHERE_NORTH_MINI_CODE_MODEL_ID &&
    !isCohereNorthMiniCodeEnabledForProject(projectId)
  ) {
    return fail(403, "FORBIDDEN", "The Cohere testing model is not enabled for this project.");
  }
  const model = resolveModel(requestedModel, "app-generation", process.env, projectId);
  const dispatchMode = dispatchModeForProject(projectId, workerConfig);
  const creditPolicy = creditAdmissionForProject(projectId);
  if (creditPolicy.kind === "misconfigured") {
    return fail(
      503,
      "CREDIT_CONFIGURATION",
      creditsProblemMessage(creditPolicy.problem),
    );
  }
  const creditCost = creditPolicy.kind === "enabled" ? creditPolicy.amount : null;
  const admission = await admitGeneration({
    userId,
    projectId,
    model: model.id,
    prompt,
    idempotencyKey: idempotencyKeyOf(record),
    dispatchMode,
    creditCost,
  });
  if (admission.kind === "failure") {
    emitGenerationEvent("generation.rejected", {
      projectId,
      reason: admission.code ?? "admission_failed",
      dispatchMode,
    });
    return admissionFailure(admission);
  }

  if (admission.kind === "insufficient") {
    emitGenerationEvent("credits.refused", {
      projectId,
      reason: "INSUFFICIENT_CREDITS",
      status: "insufficient_credits",
      ...(admission.available !== null ? { credits: admission.available } : {}),
    });
    return fail(
      402,
      "INSUFFICIENT_CREDITS",
      "You do not have enough available credits to start this generation.",
    );
  }
  if (admission.kind === "rate_limited") {
    emitGenerationEvent("generation.rejected", {
      projectId,
      reason: "rate_limited",
      status: admission.scope,
      dispatchMode,
    });
    return rateLimited(admission.scope, admission.retryAfterSeconds);
  }
  if (admission.kind === "conflict") {
    emitGenerationEvent("generation.rejected", {
      projectId,
      reason: "conflict",
      dispatchMode,
    });
    return fail(
      409,
      "CONFLICT",
      "An agent run is already in progress for this project.",
    );
  }

  const run = admission.run;

  /**
   * A repeated request with the same idempotency key returns the existing run.
   * Do not insert the user's prompt twice and do not start a second worker.
   */
  if (admission.status === "existing") {
    return ok({
      status: run.finished_at ? "done" : "init",
      stage: stageOf(run),
      runId: run.id,
      idempotent: true,
    });
  }

  if (creditCost !== null) {
    emitGenerationEvent("credits.reserved", {
      runId: run.id,
      projectId,
      traceId: run.trace_id,
      credits: creditCost,
      status: "reserved",
    });
  }

  const message = await insertMessage(projectId, "user", prompt);
  if (isStoreFailure(message)) {
    await finishOwnerRun({
      userId,
      projectId,
      runId: run.id,
      dispatchMode: run.dispatch_mode,
      status: "error",
      message: "Could not save the prompt.",
      stage: "failed",
      errorCode: "RUN_PROMPT_SAVE_FAILED",
      reason: "Run could not start",
    });
    return fail(500, "UNKNOWN", "Could not start the agent.");
  }

  emitGenerationEvent("generation.accepted", {
    traceId: run.trace_id,
    runId: run.id,
    projectId,
    model: run.model,
    dispatchMode: run.dispatch_mode,
    ...(dispatchMode === "inline" ? { reason: "non_production_dispatch" } : {}),
  });

  // A worker-dispatched run belongs to the scheduler's worker tick.
  if (run.dispatch_mode !== "worker") {
    /**
     * ⚠️ AN ESCAPING INLINE ERROR MUST NOT BE SILENT. `runAgent` handles its own
     * typed failures, but a rejection that escapes it (an unexpected throw in a
     * module it calls) previously became an unhandled rejection the response had
     * already returned from: the run stayed in `validating` with no message until
     * the 10-minute stale interrupt, and nothing recorded why. It is reported
     * here instead, and the run remains resumable/recoverable.
     */
    after(() =>
      runAgent({
        userId,
        projectId,
        runId: run.id,
        prompt,
        requestedModel: run.model,
      }).catch((error: unknown) => {
        emitGenerationEvent("generation.worker_error", {
          traceId: run.trace_id,
          runId: run.id,
          projectId,
          dispatchMode: "inline",
          reason: "inline_dispatch_failed",
        });
        console.error(
          `[mavly] inline run ${run.id} rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
    );
  }

  return ok({ status: "init", stage: "queued", runId: run.id });
}

async function resumeAgentResponse(userId: string, projectId: string): Promise<NextResponse> {
  const workerConfig = generationWorkerConfig();
  if (workerConfig.production && !workerConfig.ready) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Production generation requires the existing server-side Supabase service-role configuration.",
    );
  }
  if (!isAiConfigured()) {
    return fail(503, "BACKEND_NOT_CONFIGURED", generationConfigurationError());
  }

  const projectRecord = await getProject(userId, projectId);
  if (isStoreFailure(projectRecord)) {
    return fail(500, "UNKNOWN", "Could not read this project before resuming.");
  }
  if (!projectRecord.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");
  if (projectRecord.data.project_type !== "android") {
    const rules = await ensureProjectRuleFiles({
      userId,
      projectId,
      projectType: "website",
    });
    if (!rules.ok) return fail(500, "GENERATION_PERSIST_FAILED", (rules as { ok: false; error: string }).error);
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

  /**
   * ⚠️ A RESUME IS A NEW ATTEMPT AND MUST BE PAID FOR LIKE ONE.
   * The credit-aware RPC reopens the run and takes a fresh hold only when the
   * previous hold was released; a duplicate resume reuses the live hold.
   */
  const creditPolicy = creditAdmissionForProject(projectId);
  if (creditPolicy.kind === "misconfigured") {
    return fail(
      503,
      "CREDIT_CONFIGURATION",
      creditsProblemMessage(creditPolicy.problem),
    );
  }
  const creditCost = creditPolicy.kind === "enabled" ? creditPolicy.amount : null;
  let reopenedRun: RunRow | null = null;

  if (creditCost !== null) {
    if (
      run.dispatch_mode !== "worker" ||
      dispatchModeForProject(projectId, workerConfig) !== "worker"
    ) {
      return fail(
        503,
        "CREDIT_CONFIGURATION",
        "Credit-enabled runs require platform-wide durable worker dispatch before resuming.",
      );
    }
    const resumed = await resumeGenerationJobWithCredits(userId, projectId, run.id, creditCost);
    if (isCreditsFailure(resumed)) {
      if (resumed.code === "INSUFFICIENT_CREDITS") {
        emitGenerationEvent("credits.refused", {
          runId: run.id,
          projectId,
          reason: "INSUFFICIENT_CREDITS",
          status: "insufficient_credits",
          ...(resumed.available !== null ? { credits: resumed.available } : {}),
        });
        return fail(
          402,
          "INSUFFICIENT_CREDITS",
          "You do not have enough available credits to resume this run. Nothing was charged and the run was not reopened.",
        );
      }
      if (resumed.code === "MIGRATION_REQUIRED") {
        return fail(503, "MIGRATION_REQUIRED", resumed.error);
      }
      return fail(500, "UNKNOWN", "Could not resume the agent.");
    }
    if (resumed.data.status !== "resumed") {
      return fail(409, "RUN_NOT_RESUMABLE", "That run cannot be resumed.");
    }
    reopenedRun = resumed.data.run;
  } else {
    const reopened = await resumeRun(projectId, run.id);
    if (isStoreFailure(reopened)) {
      if (/CREDIT_(?:POLICY|RESERVATION|RUN_STATE)/i.test(`${reopened.code ?? ""} ${reopened.error}`)) {
        return fail(
          503,
          "CREDIT_CONFIGURATION",
          "The database has credit enforcement enabled but this resume is not configured for a reserved worker run.",
        );
      }
      if (reopened.code === "CONFLICT") {
        return fail(409, "CONFLICT", reopened.error);
      }
      if (reopened.code === "RATE_LIMITED_USER" || reopened.code === "RATE_LIMITED_GLOBAL") {
        return rateLimited(reopened.code === "RATE_LIMITED_GLOBAL" ? "global" : "user", 30);
      }
      return fail(500, "UNKNOWN", "Could not resume the agent.");
    }
    reopenedRun = reopened.data;
  }

  if (!reopenedRun) {
    return fail(409, "RUN_NOT_RESUMABLE", "That run cannot be resumed.");
  }
  const resumedRun = reopenedRun;

  if (creditCost !== null) {
    emitGenerationEvent("credits.reserved", {
      runId: resumedRun.id,
      projectId,
      traceId: resumedRun.trace_id,
      credits: creditCost,
      status: "reserved",
    });
  }

  emitGenerationEvent("generation.accepted", {
    traceId: resumedRun.trace_id,
    runId: resumedRun.id,
    projectId,
    model: resumedRun.model,
    dispatchMode: resumedRun.dispatch_mode,
    status: "resumed",
  });

  // A resumed worker run goes back to the durable queue; the scheduler claims it.
  if (resumedRun.dispatch_mode !== "worker") {
    after(() =>
      runAgent({
        userId,
        projectId,
        runId: resumedRun.id,
        prompt: resumedRun.prompt,
        requestedModel: resumedRun.model,
        resume: true,
      }).catch((error: unknown) => {
        emitGenerationEvent("generation.worker_error", {
          traceId: resumedRun.trace_id,
          runId: resumedRun.id,
          projectId,
          dispatchMode: "inline",
          reason: "inline_resume_failed",
        });
        console.error(
          `[mavly] inline resume ${resumedRun.id} rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
    );
  }

  return ok({ status: "init", stage: "queued", runId: resumedRun.id, resumed: true });
}

async function cancelAgentResponse(userId: string, projectId: string): Promise<NextResponse> {
  const current = await latestRun(projectId);
  if (isStoreFailure(current)) return fail(500, "UNKNOWN", "Could not cancel the agent.");
  if (!current.data) return fail(404, "RUN_NOT_FOUND", "There is no run to cancel.");

  const run = await interruptIfStale(current.data);

  // A repeated cancel is idempotent and does not add a second message.
  if (run?.stage === "cancelled") {
    return ok({
      runId: run.id,
      status: "cancelled",
      stage: "cancelled",
      alreadyCancelled: true,
    });
  }

  if (!isRunActive(run)) {
    /**
     * A completed run may still have an isolated build in flight. Cancelling it
     * is the only way a user can stop that work, so `agent/stop` covers it
     * instead of reporting "not in progress" while a sandbox is still running.
     */
    const verification = await cancelVerificationForRun(
      projectId,
      run?.id ?? current.data.id,
    );
    if (verification === "cancelled") {
      return ok({
        runId: run?.id ?? current.data.id,
        status: run?.stage ?? "completed",
        stage: run?.stage ?? "completed",
        verificationCancelled: true,
      });
    }
    return fail(409, "RUN_NOT_ACTIVE", "That run is not in progress.");
  }

  /**
   * ⚠️ THE TERMINAL UPDATE IS THE CANCELLATION. `finished_at` also fences the
   * worker out: a queued job is never claimed, and a running worker's next
   * checkpoint fails. `cancellation_requested_at` records when the request
   * landed, as distinct from when the worker observed it. An already-submitted
   * provider request cannot be recalled; the run simply keeps none of its
   * output.
   */
  const cancelled = await finishOwnerRun({
    userId,
    projectId,
    runId: run.id,
    dispatchMode: run.dispatch_mode,
    status: "cancelled",
    message: "The run was cancelled by the user.",
    stage: "cancelled",
    errorCode: "RUN_CANCELLED",
    reason: "Run cancelled by the user",
  });
  if (!cancelled) {
    return fail(409, "RUN_NOT_ACTIVE", "That run finished before it could be cancelled.");
  }

  await recordRunUsage({
    runId: run.id,
    projectId,
    traceId: run.trace_id,
  });

  await insertMessage(
    projectId,
    "agent",
    "The run was cancelled. Completed batches were kept and the code was not rolled back automatically.",
    "error",
  );

  emitGenerationEvent("generation.cancelled", {
    traceId: run.trace_id,
    runId: run.id,
    projectId,
    dispatchMode: run.dispatch_mode,
    stage: "cancelled",
  });

  return ok({ runId: run.id, status: "cancelled", stage: "cancelled" });
}

/** Verification rows exist only when this deployment targeted the project. */
function verificationCohortCovers(projectId: string): boolean {
  const config = verificationSandboxConfig();
  return config.requested && config.cohort.includes(projectId.toLowerCase());
}

async function cancelVerificationForRun(
  projectId: string,
  runId: string,
): Promise<"cancelled" | "none" | "already_terminal" | null> {
  if (!verificationCohortCovers(projectId)) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const result = await cancelVerification(supabase, projectId, runId);
  return result.ok ? result.status : null;
}

async function readVerification(
  projectId: string,
  runId: string,
): Promise<ProjectVerification | undefined> {
  if (!verificationCohortCovers(projectId)) return undefined;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return undefined;
  const result = await getVerificationForRun(supabase, projectId, runId);
  return result ? toPublicVerification(result) : undefined;
}

/**
 * `VerificationResult` models both a stored verification row and the ABSENCE of
 * one (`not_started`, from `notStartedVerification`). The public wire type has
 * no `not_started` member on purpose: a run without a row omits `verification`
 * entirely (`readVerification` returns `undefined`), so `not_started` can never
 * reach this mapping. The table is total over `VerificationStatus`, so adding a
 * status to that union fails the build until its wire mapping is chosen here.
 */
const PUBLIC_VERIFICATION_STATUS: Record<VerificationStatus, ProjectVerificationStatus> = {
  not_started: "pending",
  pending: "pending",
  running: "running",
  passed: "passed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  unsupported_runtime: "unsupported_runtime",
  configuration_error: "configuration_error",
  infrastructure_error: "infrastructure_error",
};

/** Drop the provider resource reference and Mavly row id from the read model. */
function toPublicVerification(result: VerificationResult): ProjectVerification {
  return {
    status: PUBLIC_VERIFICATION_STATUS[result.status],
    stage: result.stage,
    runId: result.runId,
    snapshotId: result.snapshotId,
    attempt: result.attempt,
    maxAttempts: result.maxAttempts,
    provider: result.provider,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    enqueuedAt: result.enqueuedAt,
    stageStartedAt: result.stageStartedAt,
    exitCode: result.exitCode,
    errorClass: result.errorClass,
    summary: result.summary,
    diagnostics: result.diagnostics,
    diagnosticsTruncated: result.diagnosticsTruncated,
    cleanupComplete: result.cleanupComplete,
    partial: result.partial,
    correlationId: result.correlationId,
    buildPassed: result.buildPassed,
    runtimeStarted: result.runtimeStarted,
    healthPassed: result.healthPassed,
    runtimeProfile: result.runtimeProfile,
    runtimePort: result.runtimePort,
    runtimeExitCode: result.runtimeExitCode,
    healthHttpStatus: result.healthHttpStatus,
    healthChecked: result.healthChecked,
    runtimeStartedAt: result.runtimeStartedAt,
    runtimeFinishedAt: result.runtimeFinishedAt,
    healthCheckedAt: result.healthCheckedAt,
    preview: result.preview,
    repair: result.repair,
  };
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
  const stage = stageOf(run);
  const manifest = parseManifestFileCount(run.generation_manifest);
  const verification = isRunActive(run)
    ? undefined
    : await readVerification(projectId, run.id);
  const managedBackend = isRunActive(run)
    ? undefined
    : await readManagedBackend(projectId);
  /**
   * ⚠️ STATIC CHECKS ARE REPORTED SEPARATELY FROM `verification`, AND ONLY WHEN
   * NO SANDBOX VERIFICATION EXISTS FOR THIS RUN. They answer "did the planned
   * files materialise and are they structurally complete?" — never "does it
   * build, start or render". A sandbox verification, when present, is the
   * authority and is never overwritten or embellished by this.
   */
  const staticVerification =
    !isRunActive(run) && !verification
      ? await readStaticVerification(projectId, run)
      : undefined;
  return ok({
    projectId,
    status,
    stage,
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
    // A scheduled retry is not a failure. Its last error is still exposed as
    // `lastErrorClass`, which is machine-readable and sanitized.
    failureCode:
      stage === "failed" || stage === "cancelled" ? run.error_code : null,
    traceId: run.trace_id ?? undefined,
    jobAttempt: run.job_attempt,
    maxJobAttempts: run.max_job_attempts,
    nextAttemptAt: run.next_attempt_at,
    lastErrorClass: run.last_error_class,
    dispatchMode: run.dispatch_mode,
    model: run.model_used ?? run.model ?? undefined,
    usage: {
      promptTokens: run.prompt_tokens,
      completionTokens: run.completion_tokens,
      totalTokens: run.total_tokens,
      reasoningTokens: run.reasoning_tokens,
    },
    ...(verification ? { verification } : {}),
    ...(managedBackend ? { managedBackend } : {}),
    ...(staticVerification ? { staticVerification } : {}),
  } satisfies AgentStatus);
}

/**
 * Stages A/B over the project's CURRENT files, for a finished generation that has
 * no sandbox verification. Returns `undefined` for anything it cannot honestly
 * judge (an unfinished run, an unreadable file list, a project with no files).
 *
 * The manifest of the completed run is the expected file list: `complete()` only
 * writes after every planned path is present, so a missing planned path here is a
 * real finding (a file deleted afterwards), not a guess.
 */
async function readStaticVerification(
  projectId: string,
  run: { generation_manifest: unknown; stage: string | null },
): Promise<StaticVerification | undefined> {
  if (run.stage !== "completed") return undefined;
  const files = await listFiles(projectId);
  if (isStoreFailure(files) || files.data.length === 0) return undefined;

  /** Kotlin is the only generated language outside the web profile. */
  const android = files.data.some((file) => file.path.endsWith(".kt"));
  return runStaticVerification({
    files: files.data.map((file) => ({ path: file.path, content: file.content })),
    projectType: android ? "android" : "website",
    requiredPaths: manifestPaths(run.generation_manifest),
  });
}

/**
 * Owner-visible managed-backend state. The RPC checks ownership itself, returns
 * no ciphertext, and reports a missing migration as an absence rather than a
 * fabricated status. A project that never needed a backend has no row.
 *
 * ═══ ENROLLMENT IS READ SEPARATELY, AND MAY EXIST WITHOUT A BACKEND ═════════
 *
 * A project can be `approved` for enrollment and still have no database (the
 * run has not reached provisioning, or it is still `pending`). That is why the
 * enrollment projection is attached when present instead of being folded into
 * `state`: "authorized" and "ready" are different facts and the UI must be able
 * to tell them apart. A missing enrollment table is an absence, not an error.
 */
async function readManagedBackend(
  projectId: string,
): Promise<ManagedBackendStatusView | undefined> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return undefined;

  const enrollment = await readOwnEnrollment({ client: supabase, projectId });
  const enrollmentView =
    enrollment.ok && enrollment.data
      ? enrollmentStatusView({
          state: enrollment.data.status,
          cohort: enrollment.data.cohort,
          reasonCode: enrollment.data.reasonCode as EnrollmentReasonCode,
          policyVersion: enrollment.data.policyVersion,
          enrolledAt: enrollment.data.enrolledAt,
          lastAuthorizedAt: enrollment.data.lastAuthorizedAt,
        })
      : null;

  const result = await managedBackendStatus({ client: supabase, projectId });
  if (result.ok === false || !result.data) {
    /**
     * No backend row. If the project is enrolled, report that honestly rather
     * than returning nothing: "approved, no database yet" is real information.
     */
    if (!enrollmentView) return undefined;
    return managedBackendStatusView({
      state: "not_required",
      dataModel: null,
      authRequired: false,
      connectionVerified: false,
      schemaVerified: false,
      gatewayConfigured: false,
      errorCode: null,
      lastStep: null,
      updatedAt: null,
      enrollment: enrollmentView,
    });
  }
  const row = result.data;
  return managedBackendStatusView({
    state: row.status,
    dataModel: row.dataModel,
    authRequired: row.authRequired,
    connectionVerified: row.connectionVerified,
    schemaVerified: row.schemaVerified,
    gatewayConfigured: row.gatewayConfigured,
    errorCode: row.errorCode,
    lastStep: row.lastStep,
    updatedAt: row.updatedAt || null,
    enrollment: enrollmentView,
  });
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

  const plannedPaths = manifestPaths(run.generation_manifest);
  const lifecycle = stageOf(run) ?? "queued";
  const allPathsCheckpointed =
    plannedPaths.length > 0 && plannedPaths.every((path) => seen.has(path));
  let previewReady = false;
  if (
    lifecycle === "completed" ||
    (allPathsCheckpointed &&
      (lifecycle === "generating" || lifecycle === "validating"))
  ) {
    const currentFiles = await listFiles(projectId);
    if (isStoreFailure(currentFiles)) {
      return fail(500, "UNKNOWN", "Could not verify the saved preview files.");
    }
    previewReady = !!resolveStaticPreview(
      currentFiles.data.map((file) => ({ path: file.path, content: file.content })),
    ).site;
  }
  const progress = projectGenerationProgressStage(
    lifecycle,
    plannedPaths.length > 0,
    allPathsCheckpointed,
    previewReady,
  );

  return ok({
    runId: run.id,
    stage: progress.stage,
    retrying: progress.retrying,
    previewReady,
    startedAt: run.started_at,
    turns: Math.max(run.batch_count, checkpointCount),
    steps: [],
    totalSteps: checkpointCount,
    files,
  });
}

function manifestPaths(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const files = (manifest as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => {
      if (!file || typeof file !== "object") return null;
      return sanitizeProjectPath((file as { path?: unknown }).path);
    })
    .filter((path): path is string => path !== null);
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
  if (
    stage === "queued" ||
    stage === "validating" ||
    stage === "generating" ||
    stage === "retrying" ||
    stage === "retry_wait"
  ) {
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
  if (content.includes("\u0000")) {
    return fail(400, "VALIDATION", "Binary content is not allowed.");
  }

  /**
   * An Android project uses the same path profile as generated source. Manual
   * edits must not introduce a keystore, APK, environment file or build output.
   */
  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) return fail(500, "UNKNOWN", "Could not load this project.");
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");
  if (project.data.project_type === "website") {
    if (isAgentControlPath(path)) {
      return fail(
        403,
        "FORBIDDEN",
        "Mavly-managed project rules and work-state files cannot be edited from the source editor.",
      );
    }

    const currentRun = await latestRun(projectId);
    if (isStoreFailure(currentRun)) {
      return fail(500, "UNKNOWN", "Could not check whether this project is being generated.");
    }
    if (currentRun.data && !currentRun.data.finished_at) {
      return fail(
        409,
        "CONFLICT",
        "This website is being generated. Wait for the run to finish before editing source files.",
      );
    }
  }
  if (project.data.project_type === "android") {
    const rejection = androidPathRejection(path);
    if (rejection) {
      return fail(400, "VALIDATION", `That path is not allowed in an Android project: ${rejection}.`);
    }
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
  if (!isImageProviderConfigured()) {
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

interface StaticPreviewState {
  available: boolean;
  reason: string | null;
  /** The file the preview route will actually serve, when one exists. */
  entryPath: string | null;
  /** `project_files.updated_at` for that entry. */
  updatedAt: string | null;
}

async function staticPreviewState(projectId: string): Promise<StaticPreviewState> {
  const files = await listFiles(projectId);
  if (!files.ok) {
    return { available: false, reason: null, entryPath: null, updatedAt: null };
  }
  const resolved = resolveStaticPreview(
    files.data.map((file) => ({ path: file.path, content: file.content })),
  );
  const entryPath = resolved.site?.entryPath ?? null;
  const entry = entryPath
    ? files.data.find((file) => file.path === entryPath) ?? null
    : null;
  return {
    available: resolved.site !== null,
    reason: resolved.unsupported ? resolved.reason : null,
    entryPath,
    updatedAt: entry?.updated_at ?? null,
  };
}

function projectFromRow(
  row: ProjectRow,
  run: RunRow | null,
  preview: boolean,
  previewUnavailableReason: string | null,
  deployment: DeploymentRow | null,
  secrets: VcaasSecret[] = [],
  previewEntry: { path: string; updatedAt: string } | null = null,
): VcaasProject {
  const previewPath = `/api/preview/${encodeURIComponent(row.project_id)}/`;
  const previewUrl = preview ? previewPath : null;
  /**
   * ⚠️ THE PREVIEW LABEL COMES FROM SAVED CONTENT AND THE DURABLE RUN, never
   * from the presence of a URL. A failed run that left an older preview.html is
   * "stale", not "ready"; no saved entry is "none"/"incomplete", not a blank
   * frame pretending to be a site.
   */
  const runSignal: PreviewRunSignal | null = run
    ? {
        stage: run.stage,
        status: run.status,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        errorMessage: run.error_message,
      }
    : null;
  const previewState: PreviewState = resolvePreviewState({
    entry: previewEntry,
    unavailableReason: previewUnavailableReason,
    run: runSignal,
  });
  const generation = resolveGenerationState(runSignal);
  /**
   * `unpublished` is a recorded state, but it is not a deployment the workspace
   * should present as existing: there is no live site, no live URL and no
   * deployment link. A later publish claims the same mapping.
   */
  const deploymentRecord =
    deployment && deployment.status !== "unpublished" ? deployment : null;
  const deploymentWire = deploymentRecord ? wireDeploymentStatus(deploymentRecord) : null;
  const deploymentStatus: "deploying" | "success" | "error" =
    deploymentWire?.status === "success"
      ? "success"
      : deploymentWire?.status === "error"
        ? "error"
        : deploymentRecord
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
  const liveHost =
    deploymentRecord && deploymentStatus === "success"
      ? deploymentHost(deploymentRecord)
      : "";

  return {
    projectId: row.project_id,
    projectType: row.project_type ?? "website",
    ...(row.project_type === "android" ? { android: androidCapability(row.project_id) } : {}),
    label: row.label ?? undefined,
    description: row.description,
    plan: "free",
    agentProcessStatus: isRunActive(run) ? "init" : run ? "done" : "idle",
    /**
     * ⚠️ STATIC, NOT ACTIVE. There is no generated development server in Mavly:
     * the preview route serves a saved HTML document. `"Active"` here was a
     * hardcoded lie that let the workspace imply a live runtime (and HMR) that
     * does not exist.
     */
    agentServerStatus: "Static",
    previewState,
    generation,
    createdAt: row.created_at,
    deployment: deploymentRecord
      ? {
          status: deploymentStatus,
          createdAt: deploymentRecord.last_published_at ?? deploymentRecord.created_at,
          ...(deploymentRecord.vercel_deployment_id
            ? { versionId: deploymentRecord.vercel_deployment_id }
            : {}),
        }
      : null,
    lastDeployError:
      deploymentRecord && deploymentStatus === "error"
        ? {
            stage: domainFailed ? "domain" : "build",
            title: domainFailed ? "Domain setup failed" : "Publish failed",
            message: domainFailed
              ? deploymentRecord.mavly_domain_error ||
                deploymentRecord.error_message ||
                "Vercel could not verify this Mavly address."
              : deploymentRecord.error_message || "Vercel could not finish the deployment.",
            at: deploymentRecord.last_published_at ?? deploymentRecord.updated_at,
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
