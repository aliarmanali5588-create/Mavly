/**
 * ═══ PHASE 5 — FULL-STACK DEPLOYMENT ORCHESTRATION ══════════════════════════
 *
 * A full-stack deployment is NOT a static publish with a build step bolted on.
 * It has a different contract:
 *
 *   · the bytes come from an IMMUTABLE snapshot that already PASSED the isolated
 *     build/runtime verification for that exact hash — never `project_files`;
 *   · Vercel's native Next.js runtime builds and executes the app, so route
 *     handlers and server code run at the provider, never on a Mavly host;
 *   · every production secret and the application database URL must already be
 *     synced to the provider before the attempt can settle `ready`;
 *   · the attempt is fenced by a monotonic number, so a late provider response
 *     cannot overwrite a newer attempt;
 *   · rollback points at a previously READY attempt and uses provider Instant
 *     Rollback; disable is a real takedown, not a hidden URL.
 *
 * ⚠️ OFF BY DEFAULT AND COHORT-GATED. `readFullstackHostingConfig` is the gate.
 * A project that is in the cohort but missing a prerequisite is REFUSED with the
 * missing prerequisite; it is never downgraded to a static publish.
 *
 * ⚠️ READINESS IS A CONTRACT, NOT A PROBE. Mavly does not fetch the deployed app
 * and does not open the user's database. `ready` means: Vercel reports READY,
 * the Mavly domain is verified, every production secret is synced, and (when the
 * source references it) the database URL fingerprint matches. Query correctness
 * and runtime behaviour beyond the build remain the user's responsibility.
 */

import type { DeploymentStatus } from "@/lib/vcaas-types";
import { isSharedHostingProject } from "@/lib/hosting/config";
import {
  deploymentEnvReadiness,
  envReadinessMessage,
} from "@/lib/hosting/deployment-env";
import {
  fullstackConfigRefusal,
  isFullstackHostingProject,
  readFullstackHostingConfig,
} from "@/lib/hosting/fullstack-config";
import { databaseReadinessForDeployment } from "@/lib/hosting/fullstack-database";
import {
  claimFullstackAttempt,
  disableFullstackDeployment,
  isFullstackStoreFailure,
  listDeploymentEnv,
  readDeploymentKind,
  readFullstackState,
  settleFullstackAttempt,
  type FullstackAttemptRow,
  type FullstackDeploymentRow,
  type FullstackStoreFailure,
} from "@/lib/hosting/fullstack-store";
import {
  listDeployableSnapshots,
  resolveVerifiedSource,
} from "@/lib/hosting/fullstack-source";
import { logHostingEvent } from "@/lib/hosting/events";
import { deploymentOperationLimiter } from "@/lib/hosting/publish-limits";
import { getProject, isStoreFailure } from "@/lib/mavly/store";
import { mavlyHostname } from "@/lib/mavly-hostname";
import { enforceDeploymentApproval } from "@/lib/orchestration/approval-gate";
import {
  planFullstackDeployment,
  snapshotHashMatches,
} from "@/lib/runtime/deployment-plan";
import {
  isVercelDeploymentConfigFailure,
  readVercelDeploymentConfig,
  type VercelDeploymentConfig,
} from "@/lib/vercel/config";
import {
  createVercelDeployment,
  createVercelProject,
  deleteVercelDeployment,
  getVercelDeployment,
  getVercelProject,
  isVercelFailure,
  listVercelProductionDeployments,
  removeVercelProjectDomain,
  rollbackVercelDeployment,
  uploadDeploymentFile,
  vercelProjectName,
  verifyVercelProjectDomain,
  type VercelFailure,
  type VercelUploadedFile,
} from "@/lib/vercel/provider";

import { assignMavlyDomain } from "./domain-assignment";
import { isDeploymentStoreFailure, updateDeploymentRow } from "./store";
import { publicDeploymentFailure } from "./vercel-failure";

/** A domain check is at most once a minute, exactly like the static path. */
const DOMAIN_CHECK_INTERVAL_MS = 60_000;
/** A queued/rolling row this old belongs to a process that died. */
const STALE_ATTEMPT_MS = 15 * 60_000;
const ERROR_MESSAGE_MAX = 500;
/** Bounded upload concurrency: a deployment is not a CDN bulk transfer. */
const UPLOAD_CONCURRENCY = 4;

export interface FullstackFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  retryAfterSeconds?: number;
}

export type FullstackResult<T> = { ok: true; data: T } | FullstackFailure;

export function isFullstackFailure<T>(
  result: FullstackResult<T>,
): result is FullstackFailure {
  return result.ok === false;
}

function fail(
  status: number,
  code: string,
  error: string,
  retryAfterSeconds?: number,
): FullstackFailure {
  return {
    ok: false,
    status,
    code,
    error,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function fromVercel(
  failure: VercelFailure,
  action: "publish" | "unpublish" = "publish",
): FullstackFailure {
  return { ok: false, ...publicDeploymentFailure(failure, action) };
}

function rateLimitFailure(decision: {
  scope: "user" | "global";
  retryAfterSeconds: number;
}): FullstackFailure {
  logHostingEvent("rate_limited", { scope: decision.scope });
  return fail(
    429,
    "RATE_LIMITED",
    decision.scope === "global"
      ? "Mavly is handling a lot of publishing right now. Try again shortly."
      : "Too many publishing operations. Wait a moment and try again.",
    decision.retryAfterSeconds,
  );
}

/**
 * Store failures are mapped to the small client vocabulary. A missing migration
 * is `BACKEND_NOT_CONFIGURED` (503), exactly like the shared-hosting preflight,
 * so the workspace shows an actionable configuration message instead of a
 * generic server error.
 */
function fromStore(failure: FullstackStoreFailure): FullstackFailure {
  switch (failure.code) {
    case "migration_required":
      return fail(503, "BACKEND_NOT_CONFIGURED", failure.error);
    case "unavailable":
      return fail(503, "BACKEND_NOT_CONFIGURED", failure.error);
    case "conflict":
    case "stale":
      return fail(409, "VALIDATION", failure.error);
    case "validation":
      return fail(400, "VALIDATION", failure.error);
    case "not_found":
      return fail(404, "PROJECT_NOT_FOUND", failure.error);
    default:
      return fail(500, "UNKNOWN", failure.error);
  }
}

function isStale(iso: string | null): boolean {
  const parsed = Date.parse(iso ?? "");
  return Number.isFinite(parsed) && Date.now() - parsed > STALE_ATTEMPT_MS;
}

function domainCheckDue(checkedAt: string | null): boolean {
  const parsed = Date.parse(checkedAt ?? "");
  return !Number.isFinite(parsed) || Date.now() - parsed > DOMAIN_CHECK_INTERVAL_MS;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ─────────────────────────── pure projections ──────────────────────────────

export type FullstackLifecycleOutcome = "building" | "ready" | "failed" | "cancelled";

/** Provider `readyState` → attempt lifecycle. Anything unknown is still building. */
export function lifecycleFromReadyState(readyState: string): FullstackLifecycleOutcome {
  switch ((readyState ?? "").toUpperCase()) {
    case "READY":
      return "ready";
    case "ERROR":
    case "BLOCKED":
      return "failed";
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    default:
      return "building";
  }
}

const UNPUBLISHED: DeploymentStatus = {
  status: "unpublished",
  createdAt: null,
  step: "unpublished",
  canUnpublish: false,
};

/**
 * The wire projection stays backward compatible: `status` is the same field the
 * existing workspace already renders. The richer lifecycle only chooses the step
 * and the error stage.
 *
 * ⚠️ `success` IS NEVER RETURNED FOR A READY LIFECYCLE WITH AN UNVERIFIED DOMAIN.
 * A deployment that is live only at `*.vercel.app` is still deploying at the
 * address the user was promised.
 */
export function wireFullstackStatus(
  row: FullstackDeploymentRow | null,
): DeploymentStatus {
  if (!row) return UNPUBLISHED;

  const createdAt = row.last_published_at ?? row.created_at;
  if (row.lifecycle === "disabled" || row.status === "unpublished") {
    return { ...UNPUBLISHED, createdAt: row.disabled_at ?? createdAt };
  }

  const hasHostname = Boolean(row.mavly_hostname);
  const domainVerified = !hasHostname || row.mavly_domain_status === "verified";
  const domainFailed =
    hasHostname &&
    row.mavly_domain_status === "error" &&
    (row.lifecycle === "ready" || row.lifecycle === "failed");
  const deploymentId = row.vercel_deployment_id
    ? { deploymentId: row.vercel_deployment_id }
    : {};
  const host =
    hasHostname && row.mavly_domain_status === "verified" ? row.mavly_hostname : "";

  if (row.lifecycle === "ready") {
    if (!domainVerified) {
      return {
        status: "deploying",
        createdAt,
        ...deploymentId,
        step: "domain",
        canUnpublish: true,
      };
    }
    return {
      status: "success",
      createdAt,
      ...deploymentId,
      step: "ready",
      canUnpublish: true,
      ...(host ? { liveUrl: `https://${host}` } : {}),
    };
  }

  if (row.lifecycle === "failed" || row.lifecycle === "cancelled") {
    const stage = domainFailed ? "domain" : row.lifecycle === "cancelled" ? "cancelled" : "build";
    const message = domainFailed
      ? row.mavly_domain_error ||
        row.error_message ||
        "Vercel could not verify this Mavly address."
      : row.error_message || "Vercel could not finish the deployment.";
    return {
      status: "error",
      createdAt,
      ...deploymentId,
      step: stage,
      /**
       * A failed update can leave the previous deployment serving at the same
       * address; that is still something to take down.
       */
      canUnpublish: Boolean(
        row.mavly_hostname || row.vercel_deployment_id || row.previous_deployment_id,
      ),
      errorDetails: {
        stage,
        title: domainFailed ? "Domain setup failed" : "Deployment failed",
        message,
      },
    };
  }

  /**
   * queued | building | deploying | rolling_back, or a missing lifecycle on a
   * row the database should not have produced. All are in-flight, never success.
   */
  const domainPending = hasHostname && !domainVerified && row.mavly_domain_status !== "error";
  return {
    status: "deploying",
    createdAt,
    ...deploymentId,
    step: row.lifecycle === "rolling_back" ? "rollback" : domainPending ? "domain" : "building",
    canUnpublish: false,
  };
}

// ───────────────────────────── shared helpers ──────────────────────────────

async function ownedProject(userId: string, projectId: string): Promise<FullstackFailure | null> {
  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) return fail(500, "UNKNOWN", "Could not load this project.");
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");
  return null;
}

function hostingGate(): FullstackFailure | null {
  const config = readFullstackHostingConfig();
  if ("reason" in config) {
    return fail(503, "BACKEND_NOT_CONFIGURED", fullstackConfigRefusal(config.reason));
  }
  return null;
}

function vercelGate(): { config: VercelDeploymentConfig } | FullstackFailure {
  const config = readVercelDeploymentConfig();
  if (isVercelDeploymentConfigFailure(config)) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      config.reason === "disabled"
        ? "Publishing is not enabled on this Mavly deployment."
        : "Publishing is not configured on this Mavly deployment.",
    );
  }
  return { config: config.config };
}

/**
 * ═══ THE ONLY PROVIDER PROJECT A FULL-STACK OPERATION MAY TARGET ════════════
 *
 * The name is derived from the immutable Mavly project id plus an owner-bound
 * hash (`vercelProjectName`). It is the one identifier a forged deployment row
 * cannot choose: the hash includes the caller's user id, so another tenant's
 * project name is not derivable.
 *
 * Status, rollback and takedown therefore resolve the provider project by that
 * name and use the returned id. They never trust `vercel_project_id` /
 * `vercel_project_name` from the row, which deployment RPCs can write. A 404
 * means this project has no provider project (nothing to operate on); any other
 * provider failure is reported instead of guessing.
 */
type HostingProjectResolution =
  | { ok: true; data: { id: string; name: string } }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "unavailable"; failure: VercelFailure };

async function resolveHostingProject(
  config: VercelDeploymentConfig,
  projectId: string,
  userId: string,
): Promise<HostingProjectResolution> {
  const name = vercelProjectName(projectId, userId);
  const project = await getVercelProject(config, name);
  if (isVercelFailure(project)) {
    return project.failure.status === 404
      ? { ok: false, reason: "not_found" }
      : { ok: false, reason: "unavailable", failure: project.failure };
  }
  return { ok: true, data: { id: project.data.id, name: project.data.name } };
}

async function settleFailure(
  projectId: string,
  attempt: { id: string; attempt: number },
  input: {
    lifecycle?: "failed" | "cancelled";
    providerProjectId?: string | null;
    providerDeploymentId?: string | null;
    providerUrl?: string | null;
    domainStatus?: "pending" | "verified" | "error" | null;
    domainError?: string | null;
    errorCode: string;
    errorMessage: string;
  },
): Promise<void> {
  const settled = await settleFullstackAttempt({
    attemptId: attempt.id,
    lifecycle: input.lifecycle ?? "failed",
    providerProjectId: input.providerProjectId ?? null,
    providerDeploymentId: input.providerDeploymentId ?? null,
    providerUrl: input.providerUrl ?? null,
    domainStatus: input.domainStatus ?? null,
    domainError: input.domainError ?? null,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage.replace(/[\r\n\t]+/g, " ").slice(0, ERROR_MESSAGE_MAX),
  });
  if (isFullstackStoreFailure(settled) && settled.code !== "stale") {
    console.error(`[fullstack] could not record the failure (${settled.code})`, {
      projectId,
      attempt: attempt.attempt,
    });
  }
}

async function readWire(
  projectId: string,
  fallback: DeploymentStatus,
): Promise<DeploymentStatus> {
  const state = await readFullstackState(projectId);
  if (isFullstackStoreFailure(state)) return fallback;
  return wireFullstackStatus(state.data.mapping);
}

function deploymentFailureCode(failure: VercelFailure): string {
  if (failure.status === 401 || failure.status === 403) return "publishing_not_authorized";
  return (failure.code || "deployment_failed").slice(0, 120);
}

function deploymentFailureMessage(failure: VercelFailure): string {
  if (failure.status === 401 || failure.status === 403) {
    return "Vercel did not authorize this deployment.";
  }
  return (failure.message || "Vercel could not complete the deployment.").slice(
    0,
    ERROR_MESSAGE_MAX,
  );
}

/**
 * Upload every file with bounded concurrency. The first failure stops new work;
 * in-flight uploads are allowed to finish so no request is abandoned halfway.
 */
async function uploadAll(
  config: VercelDeploymentConfig,
  files: readonly { path: string; content: string }[],
): Promise<{ ok: true; data: VercelUploadedFile[] } | { ok: false; failure: VercelFailure }> {
  const uploaded: VercelUploadedFile[] = new Array(files.length);
  const state: { failure: VercelFailure | null } = { failure: null };
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (state.failure) return;
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      const file = files[index];
      const result = await uploadDeploymentFile(config, file.path, file.content);
      if (isVercelFailure(result)) {
        state.failure = result.failure;
        return;
      }
      uploaded[index] = result.data;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => worker()),
  );

  if (state.failure) return { ok: false, failure: state.failure };
  return { ok: true, data: uploaded };
}

// ─────────────────────────────── deploy ────────────────────────────────────

export interface PublishFullstackOptions {
  /** Pin a verified snapshot. It is re-validated; the id alone grants nothing. */
  snapshotId?: string | null;
  /** The owner-approved proposal bound to this exact snapshot and hash. */
  approvalId?: string | null;
}

/**
 * Deploy a verified snapshot to the provider's native Next.js runtime.
 *
 * The caller (`publishProject`) has already consumed the publish admission
 * window, so this function does not consume it a second time.
 */
export async function publishFullstackProject(
  userId: string,
  projectId: string,
  options: PublishFullstackOptions = {},
): Promise<FullstackResult<DeploymentStatus>> {
  const gated = hostingGate();
  if (gated) return gated;

  /**
   * ⚠️ DEFENSE IN DEPTH. `publishProject` already routes an intended cohort
   * project here, but this function is also the destination for an EXISTING
   * full-stack row whose project has since been removed from the cohort. A
   * removal must stop new full-stack builds; it must never let the deploy
   * silently fall through to a static publish that drops every API route.
   */
  if (!isFullstackHostingProject(projectId)) {
    return fail(
      409,
      "VALIDATION",
      "Full-stack hosting is not enabled for this project. Ask the operator to add it to the cohort.",
    );
  }

  /**
   * Shared hosting and full-stack hosting claim the same `<id>.mavly.xyz`
   * address through different mechanisms. Overlapping cohorts would make the
   * tenant rewrite shadow the provider domain, so the combination is refused.
   */
  if (isSharedHostingProject(projectId)) {
    return fail(
      409,
      "VALIDATION",
      "This project is assigned to shared hosting. Remove it from the shared cohort before deploying full-stack code.",
    );
  }

  const ownership = await ownedProject(userId, projectId);
  if (ownership) return ownership;

  if (options.snapshotId && !isUuid(options.snapshotId)) {
    return fail(400, "VALIDATION", "That snapshot id is not valid.");
  }

  const source = await resolveVerifiedSource(projectId, options.snapshotId ?? null);
  if ("error" in source) {
    switch (source.code) {
      case "verification_required":
        return fail(409, "VALIDATION", source.error);
      case "snapshot_missing":
      case "snapshot_mismatch":
        return fail(409, "VALIDATION", source.error);
      case "migration_required":
        return fail(503, "BACKEND_NOT_CONFIGURED", source.error);
      default:
        return fail(503, "BACKEND_NOT_CONFIGURED", source.error);
    }
  }

  const plan = planFullstackDeployment(source.source.files);
  if ("code" in plan) {
    const detail = plan.diagnostics[0] ? ` ${plan.diagnostics[0]}` : "";
    return fail(400, "VALIDATION", `${plan.summary}${detail}`.slice(0, ERROR_MESSAGE_MAX));
  }
  if (!snapshotHashMatches(plan.plan.sourceHash, source.source.sourceHash)) {
    return fail(
      409,
      "VALIDATION",
      "The snapshot hash changed while preparing the deployment. Verify the project again, then deploy.",
    );
  }
  if (
    source.source.runtimeProfile &&
    source.source.runtimeProfile !== plan.plan.profile
  ) {
    return fail(
      409,
      "VALIDATION",
      "The verification runtime profile does not match the deployment profile.",
    );
  }

  const hostname = mavlyHostname(projectId);
  if (!hostname) {
    return fail(400, "VALIDATION", "This project id cannot be published on a Mavly address.");
  }

  /**
   * ⚠️ THE APPROVAL GATE RUNS AFTER THE VERIFIED SNAPSHOT AND DEPLOYABLE HASH ARE
   * DERIVED, and before the first attempt/provider write. It is a no-op when the
   * gate is not enabled, so existing full-stack rows keep their behaviour.
   */
  const approval = await enforceDeploymentApproval({
    projectId,
    target: "fullstack",
    snapshotId: source.source.snapshotId,
    sourceHash: plan.plan.sourceHash,
    approvalId: options.approvalId ?? null,
  });
  if (!approval.ok) return fail((approval as { status: number }).status, (approval as { code: string }).code, (approval as { error: string }).error);

  const provider = vercelGate();
  if (!("config" in provider)) return provider;
  const config = provider.config;

  const existing = await readFullstackState(projectId);
  const existingState = isFullstackStoreFailure(existing) ? null : existing.data;
  /**
   * ⚠️ THE NAME IS ALWAYS DERIVED FROM THE IMMUTABLE IDS, NEVER READ FROM THE
   * ROW. `project_deployments.vercel_project_name` is written by a
   * SECURITY DEFINER claim RPC; taking a name from there and using it to create
   * or look up a provider project would let a forged row choose the target.
   * The stored project ID is still preferred — it came from a provider
   * response — and is resolved below without trusting a name.
   */
  const name = vercelProjectName(projectId, userId);
  const storedProjectId = existingState?.mapping.vercel_project_id ?? null;
  // Comparison only: this value decides whether the mapping needs a write. It
  // is never used to create, look up or target a provider project.
  const storedName = existingState?.mapping.vercel_project_name ?? "";

  logHostingEvent("publish_started", {
    project: projectId,
    mode: "fullstack",
    snapshot: source.source.snapshotId,
  });

  const claimed = await claimFullstackAttempt({
    projectId,
    kind: "deploy",
    snapshotId: source.source.snapshotId,
    sourceHash: plan.plan.sourceHash,
    runtimeProfile: "next-app-router",
    vercelProjectName: name,
  });
  if (isFullstackStoreFailure(claimed)) return fromStore(claimed);
  const attempt = { id: claimed.data.attemptId, attempt: claimed.data.attempt };

  /**
   * Resolve the provider project by the deterministic, owner-bound NAME only.
   *
   * ⚠️ THE STORED ID IS NOT USED AS A TARGET. A deployment row's project id is
   * written through RPCs that an authenticated caller can invoke; using it to
   * pick a Vercel project would let a forged row deploy into another tenant's
   * project. The name contains a hash of the caller's user id, so it cannot be
   * chosen for somebody else. A stored id is replaced after this succeeds.
   *
   * The remote project is never deleted here: a renamed or orphaned project is
   * simply left alone when the deterministic address is created/resolved.
   */
  const existingByName = await getVercelProject(config, name);
  let vercelProject: { id: string; name: string };
  if (isVercelFailure(existingByName)) {
    if (existingByName.failure.status !== 404) {
      await settleFailure(projectId, attempt, {
        providerProjectId: storedProjectId,
        errorCode: deploymentFailureCode(existingByName.failure),
        errorMessage: deploymentFailureMessage(existingByName.failure),
      });
      return fromVercel(existingByName.failure);
    }
    const created = await createVercelProject(config, name);
    if (isVercelFailure(created)) {
      // A concurrent request may have created it between the read and create.
      if (created.failure.status === 409) {
        const raced = await getVercelProject(config, name);
        if (isVercelFailure(raced)) {
          await settleFailure(projectId, attempt, {
            providerProjectId: storedProjectId,
            errorCode: deploymentFailureCode(raced.failure),
            errorMessage: deploymentFailureMessage(raced.failure),
          });
          return fromVercel(raced.failure);
        }
        vercelProject = raced.data;
      } else {
        await settleFailure(projectId, attempt, {
          providerProjectId: storedProjectId,
          errorCode: deploymentFailureCode(created.failure),
          errorMessage: deploymentFailureMessage(created.failure),
        });
        return fromVercel(created.failure);
      }
    } else {
      vercelProject = created.data;
    }
  } else {
    vercelProject = existingByName.data;
  }

  if (vercelProject.name !== name) {
    await settleFailure(projectId, attempt, {
      providerProjectId: storedProjectId,
      errorCode: "deployment_project_mismatch",
      errorMessage: "Vercel returned a different project for this project's address.",
    });
    return fail(
      409,
      "VALIDATION",
      "Vercel returned a different project for this project's address. Try again or contact support.",
    );
  }
  if (
    storedProjectId !== vercelProject.id ||
    storedName !== vercelProject.name
  ) {
    const saved = await updateDeploymentRow(projectId, {
      vercel_project_id: vercelProject.id,
      vercel_project_name: vercelProject.name,
    });
    if (isDeploymentStoreFailure(saved)) {
      await settleFailure(projectId, attempt, {
        providerProjectId: vercelProject.id,
        errorCode: "deployment_mapping_failed",
        errorMessage: "Mavly could not save the hosting project mapping.",
      });
      return fail(500, "UNKNOWN", "Could not save the deployment mapping.");
    }
  }

  /**
   * ═══ READINESS IS CHECKED AFTER THE PROVIDER PROJECT EXISTS ═══════════════
   *
   * Project secrets are write-only, so a value saved before the Vercel project
   * existed could not be pushed (`awaiting_project`). If this gate ran before
   * the project was created, that state would be permanent: the first deploy
   * could never run, so the project would never exist. The project now exists
   * (above), so this attempt fails with an actionable "re-save" message and the
   * NEXT deploy can sync every value.
   *
   * The database-level `ready` gate repeats both checks inside
   * `settle_fullstack_attempt`, so this is fast feedback, not the guarantee.
   */
  const env = await listDeploymentEnv(projectId);
  if (isFullstackStoreFailure(env)) {
    await settleFailure(projectId, attempt, {
      providerProjectId: vercelProject.id,
      errorCode: "deployment_env_unreadable",
      errorMessage: "Mavly could not read the deployment environment state.",
    });
    return fromStore(env);
  }
  const envReadiness = deploymentEnvReadiness(env.data);
  if (!envReadiness.ready) {
    const message = envReadinessMessage(envReadiness);
    await settleFailure(projectId, attempt, {
      providerProjectId: vercelProject.id,
      errorCode: "secrets_not_synced",
      errorMessage: message,
    });
    return fail(409, "VALIDATION", message);
  }

  const database = await databaseReadinessForDeployment(
    projectId,
    plan.plan.requiresDatabase,
  );
  if ("error" in database) {
    await settleFailure(projectId, attempt, {
      providerProjectId: vercelProject.id,
      errorCode: "database_state_unreadable",
      errorMessage: database.error,
    });
    return fail(database.status, database.code, database.error);
  }
  if (!database.data.ready) {
    const message =
      database.data.reason === "missing"
        ? "This project's source reads DATABASE_URL, but no database connection is configured. Save one, then deploy."
        : database.data.reason === "unverified"
          ? "The database connection has not passed a live connectivity check. Save the connection again to verify it, then deploy."
          : "The database connection is not synced to the hosting provider. Save the connection again, then deploy.";
    await settleFailure(projectId, attempt, {
      providerProjectId: vercelProject.id,
      errorCode: "database_not_synced",
      errorMessage: message,
    });
    return fail(409, "VALIDATION", message);
  }

  /**
   * Attach the Mavly address BEFORE submitting the build. A domain owned by
   * another project fails here, without spending build minutes. A pending
   * DNS/certificate challenge is not a failure: the attempt stays in flight and
   * can never settle `ready` until it is verified.
   */
  const assigned = await assignMavlyDomain(config, vercelProject.id, hostname);
  if ("error" in assigned) {
    await settleFailure(projectId, attempt, {
      providerProjectId: vercelProject.id,
      domainStatus: "error",
      domainError: assigned.error,
      errorCode: assigned.code.toLowerCase().startsWith("domain") ? assigned.code : `domain_${assigned.code}`,
      errorMessage: assigned.error,
    });
    return assigned;
  }

  const uploaded = await uploadAll(config, plan.plan.files);
  if ("failure" in uploaded) {
    await settleFailure(projectId, attempt, {
      providerProjectId: vercelProject.id,
      domainStatus: assigned.data.status,
      domainError: assigned.data.error,
      errorCode: deploymentFailureCode(uploaded.failure),
      errorMessage: deploymentFailureMessage(uploaded.failure),
    });
    return fromVercel(uploaded.failure);
  }

  const deployment = await createVercelDeployment(config, {
    name: vercelProject.name,
    project: vercelProject.id,
    files: uploaded.data,
    framework: "nextjs",
    target: "production",
  });
  if (isVercelFailure(deployment)) {
    await settleFailure(projectId, attempt, {
      providerProjectId: vercelProject.id,
      domainStatus: assigned.data.status,
      domainError: assigned.data.error,
      errorCode: deploymentFailureCode(deployment.failure),
      errorMessage: deploymentFailureMessage(deployment.failure),
    });
    return fromVercel(deployment.failure);
  }

  const outcome = lifecycleFromReadyState(deployment.data.readyState);
  if (outcome === "failed" || outcome === "cancelled") {
    await settleFailure(projectId, attempt, {
      lifecycle: outcome,
      providerProjectId: vercelProject.id,
      providerDeploymentId: deployment.data.id,
      providerUrl: deployment.data.url,
      domainStatus: assigned.data.status,
      domainError: assigned.data.error,
      errorCode: deployment.data.errorCode ?? "deployment_failed",
      errorMessage:
        deployment.data.errorMessage ?? "Vercel could not finish the deployment.",
    });
    return {
      ok: true,
      data: await readWire(projectId, {
        status: "error",
        createdAt: new Date().toISOString(),
        step: "build",
        canUnpublish: true,
        errorDetails: {
          stage: "build",
          title: "Deployment failed",
          message:
            deployment.data.errorMessage ?? "Vercel could not finish the deployment.",
        },
      }),
    };
  }

  const settled = await settleFullstackAttempt({
    attemptId: attempt.id,
    lifecycle: "building",
    providerProjectId: vercelProject.id,
    providerDeploymentId: deployment.data.id,
    providerUrl: deployment.data.url,
    domainStatus: assigned.data.status,
    domainError: assigned.data.error,
  });
  const submitted: DeploymentStatus = {
    status: "deploying",
    createdAt: new Date().toISOString(),
    deploymentId: deployment.data.id,
    step: assigned.data.status === "verified" ? "building" : "domain",
    canUnpublish: false,
  };
  if (isFullstackStoreFailure(settled)) {
    if (settled.code === "stale") return { ok: true, data: await readWire(projectId, submitted) };
    return fail(
      500,
      "UNKNOWN",
      "The deployment was submitted to Vercel but Mavly could not record the result. Check the workspace again shortly.",
    );
  }

  return { ok: true, data: await readWire(projectId, submitted) };
}

// ─────────────────────────────── status ────────────────────────────────────

/**
 * Poll the provider and finalize the attempt. Readiness is finalized HERE, on a
 * status read, exactly like the static domain refresh: there is no background
 * scheduler for a user-initiated deployment, and a row with nobody polling stays
 * `deploying` rather than pretending to be ready.
 */
export async function getFullstackDeploymentStatus(
  userId: string,
  projectId: string,
): Promise<FullstackResult<DeploymentStatus>> {
  const ownership = await ownedProject(userId, projectId);
  if (ownership) return ownership;

  const state = await readFullstackState(projectId);
  if (isFullstackStoreFailure(state)) {
    if (state.code === "not_found") return { ok: true, data: UNPUBLISHED };
    return fromStore(state);
  }

  const row = state.data.mapping;
  if (row.deployment_kind !== "fullstack") {
    return { ok: true, data: wireFullstackStatus(row) };
  }
  if (row.lifecycle === "disabled") {
    return { ok: true, data: wireFullstackStatus(row) };
  }

  const inFlight =
    row.lifecycle === "queued" ||
    row.lifecycle === "building" ||
    row.lifecycle === "deploying" ||
    row.lifecycle === "rolling_back";
  const domainPending =
    Boolean(row.mavly_hostname) &&
    row.mavly_domain_status !== "verified" &&
    row.mavly_domain_status !== "error";
  if (!inFlight && !domainPending) {
    return { ok: true, data: wireFullstackStatus(row) };
  }

  const provider = vercelGate();
  if (!("config" in provider)) {
    // The last recorded state is authoritative; never fabricate readiness.
    return { ok: true, data: wireFullstackStatus(row) };
  }
  const config = provider.config;

  /**
   * Never target a provider project named by a deployment row. Resolve the
   * deterministic, owner-bound project instead; a row's project id/name is
   * written through deployment RPCs and may not be trusted for a provider
   * call.
   */
  const hosting = await resolveHostingProject(config, projectId, userId);
  if ("reason" in hosting) {
    if (hosting.reason === "not_found") {
      const activeAttempt = state.data.attempts.find((attempt) => attempt.finished_at === null);

      /**
       * ⚠️ A FIRST DEPLOY MAY STILL BE CREATING THE PROJECT. When no deployment
       * has been recorded yet, give the same stall window as the branch below
       * before declaring the project missing; a concurrent status poll must not
       * fail a publish that is about to create it.
       */
      if (!row.vercel_deployment_id && !isStale(row.updated_at)) {
        return { ok: true, data: wireFullstackStatus(row) };
      }

      if (activeAttempt) {
        await settleFailure(projectId, { id: activeAttempt.id, attempt: activeAttempt.attempt }, {
          providerProjectId: null,
          errorCode: "deployment_project_missing",
          errorMessage: "The hosting project no longer exists. Deploy the project again.",
        });
        return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
      }
      /**
       * There is no provider project to verify against, so no row can be shown
       * as ready or in flight from this state. Never report success without the
       * provider confirming the deployment.
       */
      return {
        ok: true,
        data: wireFullstackStatus({
          ...row,
          lifecycle: "failed",
          status: "error",
          error_code: "deployment_project_missing",
          error_message: "The hosting project no longer exists. Deploy the project again.",
        }),
      };
    }
    // Nothing was written: a transient provider read must not change state.
    return { ok: true, data: wireFullstackStatus(row) };
  }
  const providerProject = hosting.data.id;

  const active =
    state.data.attempts.find(
      (attempt) => attempt.finished_at === null && attempt.attempt === row.deployment_attempt,
    ) ?? state.data.attempts.find((attempt) => attempt.finished_at === null);

  if (!row.vercel_deployment_id) {
    if (!isStale(row.updated_at)) return { ok: true, data: wireFullstackStatus(row) };
    if (active) {
      await settleFailure(projectId, { id: active.id, attempt: active.attempt }, {
        providerProjectId: providerProject,
        errorCode: "deployment_stalled",
        errorMessage: "The deployment did not reach the hosting provider. Try deploying again.",
      });
      return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
    }
    return { ok: true, data: wireFullstackStatus(row) };
  }

  const remote = await getVercelDeployment(config, row.vercel_deployment_id);
  if (isVercelFailure(remote)) {
    if (remote.failure.status === 404 && active) {
      await settleFailure(projectId, { id: active.id, attempt: active.attempt }, {
        providerProjectId: providerProject,
        errorCode: "deployment_not_found",
        errorMessage: "The hosting provider no longer has this deployment.",
      });
      return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
    }
    // A transient read failure is not a failed build.
    return { ok: true, data: wireFullstackStatus(row) };
  }

  /**
   * Vercel reports the project a deployment belongs to. A row can carry a
   * deployment id written through a deployment RPC, so a mismatch is never
   * treated as this project's deployment.
   */
  if (remote.data.projectId && remote.data.projectId !== providerProject) {
    if (active) {
      await settleFailure(projectId, { id: active.id, attempt: active.attempt }, {
        providerProjectId: providerProject,
        errorCode: "deployment_not_owned",
        errorMessage: "The hosting provider reports this deployment belongs to another project.",
      });
      return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
    }
    return {
      ok: true,
      data: wireFullstackStatus({
        ...row,
        lifecycle: "failed",
        status: "error",
        error_code: "deployment_not_owned",
        error_message: "The hosting provider reports this deployment belongs to another project.",
      }),
    };
  }

  const outcome = lifecycleFromReadyState(remote.data.readyState);
  if (outcome === "failed" || outcome === "cancelled") {
    if (active) {
      await settleFailure(projectId, { id: active.id, attempt: active.attempt }, {
        lifecycle: outcome,
        providerProjectId: providerProject,
        providerDeploymentId: remote.data.id,
        providerUrl: remote.data.url,
        errorCode: remote.data.errorCode ?? "deployment_failed",
        errorMessage: remote.data.errorMessage ?? "Vercel could not finish the deployment.",
      });
    }
    return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
  }
  if (outcome !== "ready") {
    return { ok: true, data: wireFullstackStatus(row) };
  }

  /**
   * Provider build is READY. The Mavly address must also be verified before this
   * can be called `success`; a pending challenge is retried at most once a
   * minute, and an explicit error is a failed deployment.
   */
  let domainStatus = row.mavly_domain_status;
  let domainError = row.mavly_domain_error;
  let domainChecked = false;
  if (row.mavly_hostname && domainStatus !== "verified" && domainStatus !== "error") {
    if (domainCheckDue(row.mavly_domain_checked_at)) {
      domainChecked = true;
      const checked = await verifyVercelProjectDomain(
        config,
        providerProject,
        row.mavly_hostname,
      );
      if (isVercelFailure(checked)) {
        if (checked.failure.status === 404) {
          domainStatus = "error";
          domainError = "The Mavly address is no longer attached to this deployment.";
        }
      } else if (checked.data.verified) {
        domainStatus = "verified";
        domainError = null;
      } else {
        domainStatus = "pending";
        domainError = "Vercel has not verified the Mavly address yet.";
      }
    }
  }

  if (!active) {
    /**
     * Without an unfinished attempt there is nothing to settle. A verified
     * address must still be persisted: the attempt can have finished `ready`
     * while the Mavly domain was pending, and this poll is what makes the live
     * URL appear. Without this write the row would look `deploying` for ever.
     */
    if (domainChecked && domainStatus !== row.mavly_domain_status) {
      const patched = await updateDeploymentRow(projectId, {
        mavly_domain_status: domainStatus,
        mavly_domain_error: domainError,
        mavly_domain_checked_at: new Date().toISOString(),
      });
      return {
        ok: true,
        data: wireFullstackStatus(
          isDeploymentStoreFailure(patched) ? row : { ...row, ...patched.data },
        ),
      };
    }
    return { ok: true, data: wireFullstackStatus(row) };
  }

  const attemptRef = { id: active.id, attempt: active.attempt };

  if (!row.mavly_hostname || domainStatus === "verified") {
    const settled = await settleFullstackAttempt({
      attemptId: active.id,
      lifecycle: "ready",
      providerProjectId: providerProject,
      providerDeploymentId: remote.data.id,
      providerUrl: remote.data.url,
      domainStatus: domainStatus ?? null,
    });
    if (isFullstackStoreFailure(settled) && settled.code !== "stale") {
      console.error(`[fullstack] could not finalize readiness (${settled.code})`);
      return { ok: true, data: wireFullstackStatus(row) };
    }
    return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
  }

  if (domainStatus === "error") {
    await settleFailure(projectId, attemptRef, {
      providerProjectId: providerProject,
      providerDeploymentId: remote.data.id,
      providerUrl: remote.data.url,
      domainStatus: "error",
      domainError: domainError ?? "Vercel could not verify the Mavly address.",
      errorCode: "domain_verification_failed",
      errorMessage: domainError ?? "Vercel could not verify the Mavly address.",
    });
    return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
  }

  if (!domainChecked) {
    // Polled again before the domain check window elapsed: report, do not write.
    return { ok: true, data: wireFullstackStatus(row) };
  }

  /**
   * Still pending after an actual check. Record the check time so the next poll
   * is rate-limited, and keep the attempt in flight.
   */
  const patched = await updateDeploymentRow(projectId, {
    mavly_domain_status: "pending",
    mavly_domain_error: domainError,
    mavly_domain_checked_at: new Date().toISOString(),
  });
  return {
    ok: true,
    data: wireFullstackStatus(
      isDeploymentStoreFailure(patched) ? row : { ...row, ...patched.data },
    ),
  };
}

// ────────────────────────────── rollback ───────────────────────────────────

/**
 * Roll production traffic back to a previously READY attempt.
 *
 * The target is an ATTEMPT, not a snapshot id from the browser: the attempt
 * records the immutable snapshot, its hash and the provider deployment that was
 * actually live. A new attempt fences the operation, so a late response cannot
 * overwrite a newer deploy.
 */
export async function rollbackFullstackProject(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<FullstackResult<DeploymentStatus>> {
  const allowance = deploymentOperationLimiter.consume(userId);
  if ("scope" in allowance) return rateLimitFailure(allowance);

  /**
   * ⚠️ ROLLBACK IS A RECOVERY ACTION, NOT A NEW ROLLOUT. It must remain
   * available when the full-stack flag or the secrets key is unavailable:
   * `vercelGate` below is the only prerequisite that matters, because a
   * provider call is what restores the previous deployment. The row checks
   * below also prove this project already has a full-stack deployment.
   */
  const ownership = await ownedProject(userId, projectId);
  if (ownership) return ownership;

  const record = recordOf(body);
  const targetId = typeof record.attemptId === "string" ? record.attemptId.trim() : "";
  if (!targetId || !isUuid(targetId)) {
    return fail(400, "VALIDATION", "A rollback target attempt is required.");
  }

  const state = await readFullstackState(projectId);
  if (isFullstackStoreFailure(state)) return fromStore(state);
  const row = state.data.mapping;
  if (row.deployment_kind !== "fullstack") {
    return fail(409, "VALIDATION", "This project has no full-stack deployment to roll back.");
  }
  if (row.lifecycle === "disabled") {
    return fail(409, "VALIDATION", "This deployment is disabled. Deploy it again before rolling back.");
  }
  if (
    row.lifecycle === "queued" ||
    row.lifecycle === "building" ||
    row.lifecycle === "deploying" ||
    row.lifecycle === "rolling_back"
  ) {
    return fail(409, "VALIDATION", "A deployment attempt is already in progress.");
  }

  const target = state.data.attempts.find((attempt) => attempt.id === targetId);
  if (!target || target.lifecycle !== "ready" || !target.provider_deployment_id) {
    return fail(409, "VALIDATION", "That rollback target is not available.");
  }
  if (!target.snapshot_id) {
    return fail(
      409,
      "VALIDATION",
      "The rollback target snapshot no longer exists, so it cannot be redeployed.",
    );
  }
  if (
    row.vercel_deployment_id &&
    row.vercel_deployment_id === target.provider_deployment_id &&
    row.lifecycle === "ready"
  ) {
    // Already live: a no-op, not a fake new deployment.
    return { ok: true, data: wireFullstackStatus(row) };
  }

  const provider = vercelGate();
  if (!("config" in provider)) return provider;
  const config = provider.config;

  const hosting = await resolveHostingProject(config, projectId, userId);
  if ("reason" in hosting) {
    if ("failure" in hosting) return fromVercel(hosting.failure);
    return fail(
      409,
      "VALIDATION",
      "This project has no hosting project to roll back. Deploy it again first.",
    );
  }
  // Both targeting and the claim's display name come from the deterministic
  // project — never from a row that a deployment RPC can write.
  const providerProject = hosting.data.id;
  const claimName = hosting.data.name;

  const claimed = await claimFullstackAttempt({
    projectId,
    kind: "rollback",
    snapshotId: target.snapshot_id,
    sourceHash: target.source_hash,
    runtimeProfile: "next-app-router",
    vercelProjectName: claimName,
    targetAttemptId: target.id,
  });
  if (isFullstackStoreFailure(claimed)) return fromStore(claimed);
  const attempt = { id: claimed.data.attemptId, attempt: claimed.data.attempt };

  logHostingEvent("publish_started", {
    project: projectId,
    mode: "rollback",
    target: target.provider_deployment_id,
  });

  /**
   * Validate the target BEFORE asking the provider to move production traffic.
   * A deployment id that belongs to another project must never reach the
   * rollback call.
   */
  const targetDeployment = await getVercelDeployment(
    config,
    target.provider_deployment_id,
  );
  if (isVercelFailure(targetDeployment)) {
    await settleFailure(projectId, attempt, {
      providerProjectId: providerProject,
      providerDeploymentId: target.provider_deployment_id,
      errorCode: "rollback_target_unavailable",
      errorMessage: "The rollback target could not be read from the hosting provider.",
    });
    return fromVercel(targetDeployment.failure);
  }
  if (
    targetDeployment.data.projectId &&
    targetDeployment.data.projectId !== providerProject
  ) {
    await settleFailure(projectId, attempt, {
      providerProjectId: providerProject,
      errorCode: "rollback_target_not_owned",
      errorMessage: "The rollback target does not belong to this project.",
    });
    return fail(
      409,
      "VALIDATION",
      "That rollback target does not belong to this project.",
    );
  }

  const requested = await rollbackVercelDeployment(
    config,
    providerProject,
    target.provider_deployment_id,
  );
  if (isVercelFailure(requested)) {
    await settleFailure(projectId, attempt, {
      providerProjectId: providerProject,
      errorCode: deploymentFailureCode(requested.failure),
      errorMessage: deploymentFailureMessage(requested.failure),
    });
    logHostingEvent("publish_failed", { project: projectId, stage: "rollback" });
    return fromVercel(requested.failure);
  }

  /**
   * Record the fenced in-flight transition BEFORE any ready write. `ready`
   * requires an attempt in `building`/`deploying`/`rolling_back` carrying the
   * same provider deployment id, so this is what makes the fast path legal and
   * what stops a delayed response from swapping the target later.
   */
  const rolling = await settleFullstackAttempt({
    attemptId: attempt.id,
    lifecycle: "rolling_back",
    providerProjectId: providerProject,
    providerDeploymentId: target.provider_deployment_id,
    providerUrl: targetDeployment.data.url ?? target.provider_url,
    domainStatus: row.mavly_domain_status ?? null,
  });
  if (isFullstackStoreFailure(rolling)) {
    if (rolling.code === "stale") {
      return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
    }
    return fail(500, "UNKNOWN", "Could not record the rollback.");
  }

  /**
   * The provider accepted the request. `ready` is only claimable once the target
   * deployment actually reports READY and the Mavly address is verified.
   */
  const targetReady = lifecycleFromReadyState(targetDeployment.data.readyState) === "ready";
  const domainVerified =
    !row.mavly_hostname || row.mavly_domain_status === "verified";

  if (targetReady && domainVerified) {
    const settled = await settleFullstackAttempt({
      attemptId: attempt.id,
      lifecycle: "ready",
      providerProjectId: providerProject,
      providerDeploymentId: target.provider_deployment_id,
      providerUrl: targetDeployment.data.url ?? target.provider_url,
      domainStatus: row.mavly_domain_status ?? null,
    });
    if (isFullstackStoreFailure(settled) && settled.code !== "stale") {
      return fail(500, "UNKNOWN", "Could not record the rollback.");
    }
    return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
  }

  return { ok: true, data: await readWire(projectId, wireFullstackStatus(row)) };
}

// ─────────────────────────────── disable ───────────────────────────────────

/**
 * Take the public deployment down. This is the same contract as the static
 * unpublish: detach the Mavly address, remove production deployments, and only
 * then record `disabled`. The Vercel project, its name, the snapshot history and
 * the files are kept so the project can be deployed again.
 */
export async function disableFullstackProject(
  userId: string,
  projectId: string,
): Promise<FullstackResult<DeploymentStatus>> {
  const allowance = deploymentOperationLimiter.consume(userId);
  if ("scope" in allowance) return rateLimitFailure(allowance);

  /**
   * ⚠️ A TAKEDOWN MUST NOT DEPEND ON THE ROLLOUT FLAGS. If the project was
   * removed from the cohort, the flag was switched off, or the project-secrets
   * key is missing, the site is still live and must still be removable. Only
   * the provider configuration is required, because the provider is where the
   * domain and deployments actually live.
   */
  const ownership = await ownedProject(userId, projectId);
  if (ownership) return ownership;

  const state = await readFullstackState(projectId);
  if (isFullstackStoreFailure(state)) {
    if (state.code === "not_found") return { ok: true, data: UNPUBLISHED };
    return fromStore(state);
  }

  const row = state.data.mapping;
  if (row.deployment_kind !== "fullstack") {
    return fail(409, "VALIDATION", "This project has no full-stack deployment to disable.");
  }
  if (row.lifecycle === "disabled") {
    return { ok: true, data: wireFullstackStatus(row) };
  }
  if (
    row.lifecycle === "queued" ||
    row.lifecycle === "building" ||
    row.lifecycle === "deploying" ||
    row.lifecycle === "rolling_back"
  ) {
    return fail(409, "VALIDATION", "A deployment attempt is in progress. Try again when it finishes.");
  }

  const provider = vercelGate();
  if (!("config" in provider)) return provider;
  const config = provider.config;

  const hosting = await resolveHostingProject(config, projectId, userId);
  if ("reason" in hosting) {
    if ("failure" in hosting) return fromVercel(hosting.failure, "unpublish");
    /**
     * No provider project exists under this project's deterministic address.
     * If the row could describe a live site (a deployment id or an attached
     * Mavly address), Mavly cannot confirm a takedown and must not record one;
     * a renamed/orphaned provider project needs operator help. When there is
     * nothing that could be live, the explicit disabled state is truthful.
     */
    const couldBeLive = Boolean(
      row.vercel_deployment_id || row.previous_deployment_id || row.mavly_hostname,
    );
    if (couldBeLive) {
      return fail(
        409,
        "VALIDATION",
        "Mavly could not find the hosting project for this address. Contact support before assuming the site is down.",
      );
    }
    const disabled = await disableFullstackDeployment(projectId);
    if (isFullstackStoreFailure(disabled)) return fromStore(disabled);
    logHostingEvent("unpublish_completed", { project: projectId, mode: "fullstack" });
    return { ok: true, data: await readWire(projectId, UNPUBLISHED) };
  }
  const target = hosting.data.id;

  if (row.mavly_hostname) {
    const detached = await removeVercelProjectDomain(config, target, row.mavly_hostname);
    // A 404 means the address is not attached to this project: already down.
    if (isVercelFailure(detached) && detached.failure.status !== 404) {
      logHostingEvent("unpublish_failed", { project: projectId, stage: "domain" });
      return fromVercel(detached.failure, "unpublish");
    }
  }

  const listed = await listVercelProductionDeployments(config, target);
  if (isVercelFailure(listed) && listed.failure.status !== 404) {
    logHostingEvent("unpublish_failed", { project: projectId, stage: "list" });
    return fromVercel(listed.failure, "unpublish");
  }

  /**
   * ⚠️ ONLY DELETE DEPLOYMENTS THE PROVIDER SAYS BELONG TO THIS PROJECT.
   *
   * `vercel_deployment_id` / `previous_deployment_id` live in a row that
   * deployment RPCs can write. Deleting a mapped id without confirming it is in
   * this project's production list would let a forged row make Mavly's own
   * Vercel token remove a deployment from another Mavly project.
   */
  const deploymentIds = new Set<string>(isVercelFailure(listed) ? [] : listed.data);

  /**
   * The production list is bounded (100). A mapped deployment older than that
   * is removed only when the provider confirms it belongs to THIS project; a
   * mapped id alone is never trusted.
   */
  for (const mappedId of [row.vercel_deployment_id, row.previous_deployment_id]) {
    if (!mappedId || deploymentIds.has(mappedId)) continue;
    const mapped = await getVercelDeployment(config, mappedId);
    if (isVercelFailure(mapped)) continue;
    if (mapped.data.projectId && mapped.data.projectId === target) {
      deploymentIds.add(mappedId);
    }
  }

  for (const id of deploymentIds) {
    const removed = await deleteVercelDeployment(config, id);
    if (isVercelFailure(removed)) {
      /**
       * The Mavly address is already detached, but a provider host may still
       * serve. Do not record `disabled`: the operator can retry, and the status
       * stays truthful about the partial takedown.
       */
      logHostingEvent("unpublish_failed", { project: projectId, stage: "deployment" });
      return fail(
        502,
        "UNKNOWN",
        "The Mavly address was detached, but a provider deployment could not be removed. Try disabling again.",
      );
    }
  }

  const disabled = await disableFullstackDeployment(projectId);
  if (isFullstackStoreFailure(disabled)) return fromStore(disabled);

  logHostingEvent("unpublish_completed", { project: projectId, mode: "fullstack" });
  return { ok: true, data: await readWire(projectId, UNPUBLISHED) };
}

// ─────────────────────────────── history ───────────────────────────────────

export interface PublicDeploymentAttempt {
  attemptId: string;
  attempt: number;
  kind: "deploy" | "rollback";
  lifecycle: string;
  snapshotId: string | null;
  sourceHash: string;
  deploymentId: string | null;
  url: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function publicAttempt(row: FullstackAttemptRow): PublicDeploymentAttempt {
  return {
    attemptId: row.id,
    attempt: row.attempt,
    kind: row.kind,
    lifecycle: row.lifecycle,
    snapshotId: row.snapshot_id,
    sourceHash: row.source_hash,
    deploymentId: row.provider_deployment_id,
    url: row.provider_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function fullstackDeploymentHistory(
  userId: string,
  projectId: string,
): Promise<FullstackResult<{ attempts: PublicDeploymentAttempt[] }>> {
  const ownership = await ownedProject(userId, projectId);
  if (ownership) return ownership;

  const state = await readFullstackState(projectId);
  if (isFullstackStoreFailure(state)) {
    if (state.code === "not_found") return { ok: true, data: { attempts: [] } };
    return fromStore(state);
  }
  return { ok: true, data: { attempts: state.data.attempts.map(publicAttempt) } };
}

/**
 * The verified snapshots an operator may pin. Metadata only: no file content and
 * no snapshot that has not passed verification.
 */
export async function fullstackDeployableSnapshots(
  userId: string,
  projectId: string,
): Promise<
  FullstackResult<{ snapshots: { snapshotId: string; sourceHash: string; verifiedAt: string | null }[] }>
> {
  const ownership = await ownedProject(userId, projectId);
  if (ownership) return ownership;

  const list = await listDeployableSnapshots(projectId);
  if ("error" in list) return fail(503, "BACKEND_NOT_CONFIGURED", list.error);
  return { ok: true, data: { snapshots: list.data } };
}

/**
 * Whether this project already has a full-stack deployment row.
 *
 * ⚠️ DELIBERATELY INDEPENDENT OF THE CURRENT FLAG/COHORT. Status and takedown
 * must keep working after an operator removes a project from the cohort or
 * turns the feature off; asking the rollout configuration first would silently
 * route a live full-stack row through the static status/unpublish path.
 */
export async function isFullstackDeploymentRow(projectId: string): Promise<boolean> {
  return (await readDeploymentKind(projectId)) === "fullstack";
}
