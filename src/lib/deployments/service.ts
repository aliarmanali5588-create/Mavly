/**
 * Publish and unpublish orchestration for Mavly-managed static and full-stack hosting.
 *
 * The route has already authenticated the caller and proved ownership of
 * `projectId`. This module repeats the project read through the caller's
 * RLS-scoped client, then:
 *
 *   1. resolves the project's static entry point (`preview.html`, `index.html`,
 *      or `public/index.html`) from public.project_files;
 *   2. creates one deterministic Vercel project per Mavly project (or reuses it);
 *   3. attaches the derived `<project-id>.mavly.xyz` domain and verifies it;
 *   4. uploads the static site and creates a production deployment with no
 *      framework build;
 *   5. records the Vercel ids, build state and domain state in
 *      public.project_deployments.
 *
 * ⚠️ ONLY STATIC FILES ARE PUBLISHED. Source that needs a framework build is
 * refused with an actionable message instead of being reported as a failed
 * build. Neither Mavly nor Vercel executes the imported source.
 */

import type { DeploymentStatus as WireDeploymentStatus } from "@/lib/vcaas-types";
import { resolveStaticPreview, staticPublishFiles } from "@/lib/static-site";
import type { StaticPublishFile, StaticSite } from "@/lib/static-site";
import { mavlyHostname } from "@/lib/mavly-hostname";
import {
  PUBLISHED_VERSION_RETENTION,
  isSharedHostingProject,
  isSharedHostingRuntimeEnabled,
  sharedDeploymentName,
} from "@/lib/hosting/config";
import {
  isAwsFrontendHostingProject,
  readAwsFrontendHostingConfig,
} from "@/lib/aws/config";
import {
  enqueueAwsFrontendPublication,
  enqueueAwsFrontendUnpublish,
  readAwsFrontendSchemaVersion,
} from "@/lib/aws/publication-store";
import {
  verifyAwsPublicTenantRoute,
} from "@/lib/aws/tenant-mapping";
import { logHostingEvent } from "@/lib/hosting/events";
import type { HostingEvent } from "@/lib/hosting/events";
import { isFullstackHostingRequested } from "@/lib/hosting/fullstack-config";
import {
  SHARED_HOSTING_INSTALL_MESSAGE,
  migrationRequirementMessage,
  requiredMigrationFor,
} from "@/lib/hosting/migration-requirement";
import { deploymentOperationLimiter } from "@/lib/hosting/publish-limits";
import { enforceDeploymentApproval } from "@/lib/orchestration/approval-gate";
import { contentTypeForPath } from "@/lib/hosting/published-version";
import { verifySharedPublication } from "@/lib/hosting/serve";
import type { SharedPublicationProbe } from "@/lib/hosting/serve";
import {
  activateSharedPublication,
  createPublishedVersion,
  deactivatePublishedVersion,
  isHostingStoreFailure,
  markPublishedVersionFailed,
  preparePublishedFiles,
  pruneSupersededVersions,
  readSharedHostingSchemaVersion,
} from "@/lib/hosting/store";
import { getProject, isStoreFailure, listFiles } from "@/lib/mavly/store";
import { hashSource } from "@/lib/mavly/snapshots";
import {
  isVercelDeploymentConfigFailure,
  readVercelDeploymentConfig,
  type VercelDeploymentConfig,
  type VercelDeploymentConfigResult,
} from "@/lib/vercel/config";
import {
  formatVercelFailureDiagnostic,
  vercelConfigPresence,
} from "@/lib/vercel/diagnostics";
import {
  createVercelDeployment,
  createVercelProject,
  deleteVercelDeployment,
  deleteVercelProject,
  getVercelDeployment,
  getVercelProject,
  getVercelProjectDomain,
  isVercelFailure,
  listVercelProductionDeployments,
  removeVercelProjectDomain,
  uploadDeploymentFile,
  vercelProjectName,
  verifyVercelProjectDomain,
  type VercelFailure,
  type VercelResult,
} from "@/lib/vercel/provider";
import {
  beginDeployment,
  claimUnpublish,
  finishUnpublish,
  getDeploymentRow,
  isDeploymentRowStale,
  isDeploymentStoreFailure,
  releaseUnpublish,
  updateDeploymentRow,
  type DeploymentRow,
  type DeploymentStatus as StoredDeploymentStatus,
  type DeploymentStoreResult,
} from "./store";
import { assignMavlyDomain, recordDomainFailure } from "./domain-assignment";
import {
  disableFullstackProject,
  getFullstackDeploymentStatus,
  isFullstackDeploymentRow,
  publishFullstackProject,
} from "./fullstack";
import { resolveVercelProject } from "./vercel-project";
import { publicDeploymentFailure } from "./vercel-failure";

const PUBLISH_MAX_BYTES = 8_000_000;
const PUBLISH_MAX_FILES = 1_000;
const ERROR_MESSAGE_MAX = 500;
const DOMAIN_CHECK_INTERVAL_MS = 60_000;

export interface DeploymentServiceFailure {
  status: number;
  code: string;
  error: string;
  retryAfterSeconds?: number;
}

export type DeploymentServiceResult<T> =
  | { ok: true; data: T }
  | ({ ok: false } & DeploymentServiceFailure);

export function isDeploymentServiceFailure<T>(
  result: DeploymentServiceResult<T>,
): result is { ok: false } & DeploymentServiceFailure {
  return result.ok === false;
}

function fail(
  status: number,
  code: string,
  error: string,
  retryAfterSeconds?: number,
): DeploymentServiceResult<never> {
  return {
    ok: false,
    status,
    code,
    error,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function fromVercel(failure: VercelFailure): DeploymentServiceResult<never> {
  return { ok: false, ...publicDeploymentFailure(failure) };
}

function storedStatusFor(readyState: string): StoredDeploymentStatus {
  switch (readyState.toUpperCase()) {
    case "READY":
      return "ready";
    case "ERROR":
    case "BLOCKED":
      return "error";
    case "CANCELED":
      return "canceled";
    default:
      return "building";
  }
}

function wireStatus(
  status: StoredDeploymentStatus,
): "deploying" | "success" | "error" | "unpublishing" | "unpublished" {
  if (status === "ready") return "success";
  if (status === "error" || status === "canceled") return "error";
  if (status === "unpublishing") return "unpublishing";
  if (status === "unpublished") return "unpublished";
  return "deploying";
}

/**
 * The stable production host for a deployment row, without a scheme.
 *
 * A row with a Mavly hostname only exposes it after Vercel reports the domain
 * verified. A legacy row (no Mavly hostname) keeps its existing Vercel address,
 * so historical deployments continue to work and their URL is never rewritten.
 * An unpublished row exposes no address at all.
 */
export function deploymentHost(row: DeploymentRow | null): string {
  if (!row || row.status === "unpublished") return "";
  if (row.mavly_hostname) {
    return row.mavly_domain_status === "verified" ? row.mavly_hostname : "";
  }
  return row.vercel_project_name ? `${row.vercel_project_name}.vercel.app` : "";
}

export function wireDeploymentStatus(row: DeploymentRow): WireDeploymentStatus {
  const deploymentState = wireStatus(row.status);
  const createdAt =
    row.status === "unpublished"
      ? row.last_unpublished_at ?? row.last_published_at ?? row.created_at
      : row.last_published_at ?? row.created_at;

  /**
   * An unpublished mapping is a real state, not "no row": it keeps the Vercel
   * project mapping and Mavly hostname for a later republish, but it must never
   * expose a live URL or invite a second unpublish.
   */
  if (deploymentState === "unpublished") {
    return {
      status: "unpublished",
      createdAt,
      step: "unpublished",
      canUnpublish: false,
    };
  }
  if (deploymentState === "unpublishing") {
    return {
      status: "unpublishing",
      createdAt,
      step: "unpublishing",
      canUnpublish: false,
      ...(row.vercel_deployment_id ? { deploymentId: row.vercel_deployment_id } : {}),
    };
  }

  const hasMavlyHostname = Boolean(row.mavly_hostname);
  const domainVerified = !hasMavlyHostname || row.mavly_domain_status === "verified";
  const domainErrorCode = (row.error_code ?? "").toLowerCase();
  const domainFailed =
    hasMavlyHostname &&
    row.mavly_domain_status === "error" &&
    (deploymentState === "success" || domainErrorCode.startsWith("domain"));
  const providerName =
    row.provider === "aws" ? "AWS" : row.provider === "shared" ? "Mavly" : "Vercel";
  const status =
    deploymentState === "success"
      ? domainFailed
        ? "error"
        : domainVerified
          ? "success"
          : "deploying"
      : deploymentState;
  const domainStep = row.status === "ready" && hasMavlyHostname && !domainVerified;
  const host = deploymentHost(row);

  return {
    status,
    createdAt,
    ...(row.vercel_deployment_id ? { deploymentId: row.vercel_deployment_id } : {}),
    step: status === "deploying" ? (domainStep ? "domain" : "building") : status,
    /**
     * Unpublish is offered when there is something public to take down. A failed
     * republish can leave the previous production deployment serving at the same
     * Mavly host, so an `error`/`canceled` row still qualifies when a hostname or
     * deployment id proves the publish reached Vercel. A first publish that failed
     * before either existed has nothing to unpublish.
     */
    canUnpublish:
      row.status === "ready" ||
      ((row.status === "error" || row.status === "canceled") &&
        Boolean(row.mavly_hostname || row.vercel_deployment_id)),
    ...(status === "success" && host ? { liveUrl: `https://${host}` } : {}),
    ...(status === "error"
      ? {
          errorDetails: domainFailed
            ? {
                stage: "domain",
                title: "Domain setup failed",
                message:
                  row.mavly_domain_error ||
                  row.error_message ||
                  `${providerName} could not verify this Mavly address.`,
              }
            : {
                stage: "build",
                title: "Publish failed",
                message: row.error_message || `${providerName} could not finish the deployment.`,
              },
        }
      : {}),
  };
}

async function recordFailure(projectId: string, failure: VercelFailure): Promise<void> {
  /**
   * Authorization failures are diagnosed in server logs. Persisting the upstream
   * message would later surface it to the project owner through the status card,
   * so only a generic, non-sensitive statement reaches the database.
   */
  const authorizationFailure = failure.status === 401 || failure.status === 403;
  const updated = await updateDeploymentRow(projectId, {
    status: "error",
    error_code: authorizationFailure ? "publishing_not_authorized" : failure.code.slice(0, 120),
    error_message: authorizationFailure
      ? "Vercel did not authorize this publish."
      : failure.message.slice(0, ERROR_MESSAGE_MAX),
  });
  if (isDeploymentStoreFailure(updated)) {
    console.error("[deployments] could not record deployment failure:", updated.error);
  }
}

function domainCheckDue(row: DeploymentRow): boolean {
  const checkedAt = Date.parse(row.mavly_domain_checked_at ?? "");
  return !Number.isFinite(checkedAt) || Date.now() - checkedAt >= DOMAIN_CHECK_INTERVAL_MS;
}

/**
 * Re-check a pending Mavly domain. A transient Vercel failure keeps the last
 * state; a verified domain clears the pending marker. This never upgrades a
 * deployment to success on its own — `wireDeploymentStatus` still requires the
 * deployment itself to be ready.
 */
async function refreshPendingDomain(
  config: VercelDeploymentConfig,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  if (
    !row.mavly_hostname ||
    row.mavly_domain_status === "verified" ||
    row.mavly_domain_status === "error"
  ) {
    return row;
  }

  const target = row.vercel_project_id || row.vercel_project_name;
  if (!target) return row;

  const checked = await verifyVercelProjectDomain(config, target, row.mavly_hostname);
  if (isVercelFailure(checked)) {
    if (checked.failure.status === 404) {
      const failed = await updateDeploymentRow(row.project_id, {
        mavly_domain_status: "error",
        mavly_domain_error: `Vercel can no longer find ${row.mavly_hostname}. Publish again to reattach it.`,
        mavly_domain_checked_at: new Date().toISOString(),
        error_code: "domain_not_found",
        error_message: `Vercel can no longer find ${row.mavly_hostname}.`,
      });
      return isDeploymentStoreFailure(failed) ? row : failed.data;
    }
    if (checked.failure.status === 401 || checked.failure.status === 403) {
      const failed = await updateDeploymentRow(row.project_id, {
        mavly_domain_status: "error",
        mavly_domain_error: "Vercel did not authorize domain verification.",
        mavly_domain_checked_at: new Date().toISOString(),
        error_code: "domain_not_authorized",
        error_message: "Vercel did not authorize domain verification.",
      });
      return isDeploymentStoreFailure(failed) ? row : failed.data;
    }
    return row;
  }

  const patched = await updateDeploymentRow(row.project_id, {
    mavly_domain_status: checked.data.verified ? "verified" : "pending",
    mavly_domain_error: null,
    mavly_domain_checked_at: new Date().toISOString(),
    ...(checked.data.verified
      ? { error_code: null, error_message: null }
      : {}),
  });
  return isDeploymentStoreFailure(patched) ? row : patched.data;
}

function rateLimitFailure(decision: {
  scope: "user" | "global";
  retryAfterSeconds: number;
}): DeploymentServiceResult<never> {
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
 * ═══ SHARED PUBLISH — ATTEMPT STATE IS NOT LIVE STATE ═══════════════════════
 *
 * `project_deployments.status` describes the LATEST ATTEMPT. The public
 * resolver (migration 15) serves from `active_version_id` + the active version,
 * so writing `queued`/`error` here can never take the previous version down.
 *
 * The dependencies are injectable so the orchestration can be exercised with a
 * fake store in `node:test`; production uses the defaults below.
 */
export interface SharedPublishDependencies {
  schema: typeof readSharedHostingSchemaVersion;
  begin: (
    projectId: string,
    vercelProjectName: string,
    provider: "shared",
    options: { preserveLastPublishedAt: boolean },
  ) => Promise<DeploymentStoreResult<DeploymentRow>>;
  createVersion: typeof createPublishedVersion;
  activate: typeof activateSharedPublication;
  recordRow: typeof updateDeploymentRow;
  probe: typeof verifySharedPublication;
  markFailed: typeof markPublishedVersionFailed;
  prune: typeof pruneSupersededVersions;
  log: (event: HostingEvent, fields?: Record<string, unknown>) => void;
}

const DEFAULT_SHARED_PUBLISH_DEPENDENCIES: SharedPublishDependencies = {
  schema: readSharedHostingSchemaVersion,
  begin: (projectId, vercelProjectName, provider, options) =>
    beginDeployment(projectId, vercelProjectName, provider, options),
  createVersion: createPublishedVersion,
  activate: activateSharedPublication,
  recordRow: updateDeploymentRow,
  probe: verifySharedPublication,
  markFailed: markPublishedVersionFailed,
  prune: pruneSupersededVersions,
  log: logHostingEvent,
};

function migrationFailure(
  code: string | undefined,
  message: string,
): DeploymentServiceResult<never> | null {
  if (code === "MIGRATION_REQUIRED") {
    const migration = message.includes("15_shared_hosting_attempt_state.sql")
      ? "15_shared_hosting_attempt_state.sql"
      : "14_shared_hosting.sql";
    return fail(503, "BACKEND_NOT_CONFIGURED", migrationRequirementMessage(migration));
  }
  const migration = requiredMigrationFor({ code, message });
  return migration
    ? fail(503, "BACKEND_NOT_CONFIGURED", migrationRequirementMessage(migration))
    : null;
}

/**
 * A failed attempt records its own outcome and nothing else.
 *
 * `active_version_id`, `mavly_hostname` and the active version row are untouched.
 * Under the migration-15 resolver that means the previous publication keeps
 * serving; if this was a first publish there is no active version and the site
 * is truthfully unpublished.
 */
async function recordSharedFailure(
  deps: Pick<SharedPublishDependencies, "recordRow" | "log">,
  projectId: string,
  message: string,
  previousVersionId: string | null,
): Promise<void> {
  const text = previousVersionId
    ? `${message} The previous published version was left unchanged.`
    : message;
  const updated = await deps.recordRow(projectId, {
    status: "error",
    error_code: "shared_publish_failed",
    error_message: text.slice(0, ERROR_MESSAGE_MAX),
  });
  if (isDeploymentStoreFailure(updated)) {
    console.error("[deployments] could not record shared publish failure:", updated.error);
  }
  deps.log("publish_failed", { project: projectId, stage: "store" });
}

function sharedFailureResult(
  base: string,
  previousVersionId: string | null,
  fallback: string,
): DeploymentServiceResult<never> {
  return fail(
    500,
    "UNKNOWN",
    previousVersionId ? `${base} The previous published version was left unchanged.` : fallback,
  );
}

/**
 * The probe is the ONLY source of `verified`. A timeout, an unresolved host or
 * an unreadable entry document stays `pending` and is retried by a later status
 * read; it never becomes a fabricated success.
 */
function probeDomainState(probe: SharedPublicationProbe): {
  status: "verified" | "pending";
  error: string | null;
} {
  /**
   * `"reason" in probe`, NOT `if (probe.ok)`. This project compiles with
   * `strictNullChecks: false`, where the boolean discriminant does not narrow
   * the union, so the failure branch would still be typed as the whole union.
   * The `in` check (already used further down for the failure log) narrows by
   * property presence instead.
   */
  if (!("reason" in probe)) return { status: "verified", error: null };
  return {
    status: "pending",
    error:
      probe.reason === "not_resolved"
        ? "Mavly could not resolve the published address yet."
        : probe.reason === "entry_missing"
          ? "The published entry document could not be read yet."
          : "Mavly could not verify the published address yet.",
  };
}

/**
 * ═══ SHARED PUBLISH — NO VERCEL, ONE IMMUTABLE VERSION ══════════════════════
 *
 *   0. preflight the attempt-state migration (before any write);
 *   1. claim the project's single attempt slot (`provider = shared`);
 *   2. validate + hash the exact static file set;
 *   3. insert an INACTIVE version and all of its bytes;
 *   4. activate atomically — live pointer + `status = ready`, `verified` never;
 *   5. prove Mavly's own runtime resolves the host to THAT version;
 *   6. persist only the probe result (`verified` or `pending`).
 *
 * A failure in 0–4 leaves the previous version active and serving. The previous
 * version is superseded only inside step 4, the one transition that may change
 * what the public resolver returns.
 */
export async function publishSharedVersion(
  input: {
    projectId: string;
    hostname: string;
    site: StaticSite;
    publishFiles: readonly StaticPublishFile[];
  },
  deps: SharedPublishDependencies = DEFAULT_SHARED_PUBLISH_DEPENDENCIES,
): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  const { projectId, hostname, site, publishFiles } = input;

  deps.log("publish_started", {
    project: projectId,
    host: hostname,
    mode: "shared",
    files: publishFiles.length,
  });

  const prepared = preparePublishedFiles(publishFiles, contentTypeForPath);
  if (isHostingStoreFailure(prepared)) {
    return fail(400, "VALIDATION", prepared.error);
  }

  /**
   * ⚠️ PREFLIGHT BEFORE ANY WRITE. If migration 15 is absent, writing `queued`
   * would leave the OLD resolver (14) requiring `ready`, and the live site would
   * go down before we could report the missing migration. Nothing is written
   * until both migrations are proven installed.
   */
  const schema = await deps.schema();
  if (isHostingStoreFailure(schema)) {
    if (schema.code === "MIGRATION_REQUIRED") {
      return fail(503, "BACKEND_NOT_CONFIGURED", schema.error || SHARED_HOSTING_INSTALL_MESSAGE);
    }
    const migration = migrationFailure(schema.code, schema.error);
    if (migration) return migration;
    return fail(500, "UNKNOWN", "Could not verify the shared hosting backend.");
  }
  if (schema.data < 15) {
    return fail(503, "BACKEND_NOT_CONFIGURED", SHARED_HOSTING_INSTALL_MESSAGE);
  }

  const began = await deps.begin(
    projectId,
    sharedDeploymentName(projectId),
    "shared",
    { preserveLastPublishedAt: true },
  );
  if (isDeploymentStoreFailure(began)) {
    const migration = migrationFailure(began.code, began.error);
    if (migration) return migration;
    return began.code === "CONFLICT"
      ? fail(409, "VALIDATION", began.error)
      : fail(500, "UNKNOWN", "Could not start the publish.");
  }

  /** The version that remains live until step 4 actually succeeds. */
  const previousVersionId = began.data.active_version_id ?? null;

  const version = await deps.createVersion({
    projectId,
    prepared: prepared.data,
    entryPath: "index.html",
    /**
     * Only a standalone generated preview is a single client-routed document.
     * An imported multi-page site keeps literal 404s for unknown paths; the
     * policy is recorded in the immutable version, never guessed per request.
     */
    spaFallback: site.generated,
  });
  if (isHostingStoreFailure(version)) {
    await recordSharedFailure(
      deps,
      projectId,
      "Mavly could not store the published website.",
      previousVersionId,
    );
    const migration = migrationFailure(version.code, version.error);
    if (migration) return migration;
    return sharedFailureResult(
      "Could not store the published website.",
      previousVersionId,
      "Could not store the published website.",
    );
  }

  const activated = await deps.activate(projectId, version.data.id, hostname);
  if (isHostingStoreFailure(activated)) {
    await deps.markFailed(version.data.id);
    await recordSharedFailure(
      deps,
      projectId,
      "Mavly could not activate the published website.",
      previousVersionId,
    );
    const migration = migrationFailure(activated.code, activated.error);
    if (migration) return migration;
    return sharedFailureResult(
      "Could not activate the published website.",
      previousVersionId,
      "Could not activate the published website.",
    );
  }

  deps.log("artifact_created", {
    project: projectId,
    version: version.data.id,
    files: version.data.fileCount,
    bytes: version.data.byteCount,
    hash: version.data.contentHash,
  });
  deps.log("version_activated", { project: projectId, version: version.data.id });

  /**
   * The activation is committed: `status = ready`, `active_version_id` and the
   * hostname already describe the new live version. Only NOW may the runtime be
   * probed, and only a probe that resolves the EXACT version may become
   * `verified`.
   */
  const probe = await deps.probe(hostname, version.data.id);
  const domain = probeDomainState(probe);

  const saved = await deps.recordRow(projectId, {
    status: "ready",
    vercel_deployment_id: null,
    url: null,
    error_code: null,
    error_message: null,
    mavly_hostname: hostname,
    mavly_domain_status: domain.status,
    mavly_domain_error: domain.error,
    mavly_domain_checked_at: new Date().toISOString(),
    active_version_id: version.data.id,
  });
  if (isDeploymentStoreFailure(saved)) {
    return fail(
      500,
      "UNKNOWN",
      "The website was published but Mavly could not record it. Reload the workspace shortly.",
    );
  }

  const removed = await deps.prune(projectId, PUBLISHED_VERSION_RETENTION);
  if (removed > 0) deps.log("versions_pruned", { project: projectId, removed });

  if ("reason" in probe) {
    deps.log("publish_failed", {
      project: projectId,
      stage: "probe",
      reason: probe.reason,
    });
  }

  return { ok: true, data: wireDeploymentStatus(saved.data) };
}

async function enqueueAwsPublication(input: {
  projectId: string;
  hostname: string;
  site: StaticSite;
  publishFiles: readonly StaticPublishFile[];
}): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  const { projectId, hostname, site, publishFiles } = input;
  const schema = await readAwsFrontendSchemaVersion();
  if (schema.ok === false) {
    return fail(
      schema.code === "MIGRATION_REQUIRED" ? 503 : 500,
      schema.code === "MIGRATION_REQUIRED" ? "BACKEND_NOT_CONFIGURED" : "UNKNOWN",
      schema.error,
    );
  }
  if (schema.data < 51) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "AWS frontend hosting is not installed. Apply migration 51_aws_frontend_deployment.sql.",
    );
  }

  const prepared = preparePublishedFiles(publishFiles, contentTypeForPath);
  if (isHostingStoreFailure(prepared)) {
    return fail(400, "VALIDATION", prepared.error);
  }

  const began = await beginDeployment(
    projectId,
    "",
    "aws",
    { preserveLastPublishedAt: true },
  );
  if (isDeploymentStoreFailure(began)) {
    const migration = migrationFailure(began.code, began.error);
    if (migration) return migration;
    return began.code === "CONFLICT"
      ? fail(409, "VALIDATION", began.error)
      : fail(500, "UNKNOWN", "Could not start the AWS publish.");
  }

  const version = await createPublishedVersion({
    projectId,
    prepared: prepared.data,
    entryPath: "index.html",
    spaFallback: site.generated,
  });
  if (isHostingStoreFailure(version)) {
    await updateDeploymentRow(projectId, {
      status: "error",
      error_code: "aws_version_store_failed",
      error_message: "Mavly could not store the published website.",
    });
    const migration = migrationFailure(version.code, version.error);
    if (migration) return migration;
    return fail(500, "UNKNOWN", "Mavly could not store the published website.");
  }

  const queued = await enqueueAwsFrontendPublication({
    projectId,
    versionId: version.data.id,
  });
  if (queued.ok === false) {
    await markPublishedVersionFailed(version.data.id);
    await updateDeploymentRow(projectId, {
      status: "error",
      error_code: "aws_queue_failed",
      error_message: "Mavly could not queue the AWS publication.",
    });
    return fail(
      queued.code === "MIGRATION_REQUIRED" ? 503 : 500,
      queued.code === "MIGRATION_REQUIRED" ? "BACKEND_NOT_CONFIGURED" : "UNKNOWN",
      queued.error,
    );
  }

  const recorded = await updateDeploymentRow(projectId, {
    mavly_hostname: hostname,
    mavly_domain_status: "pending",
    mavly_domain_error: null,
    mavly_domain_checked_at: null,
    error_code: null,
    error_message: null,
  });
  if (isDeploymentStoreFailure(recorded)) {
    return fail(
      500,
      "UNKNOWN",
      "The AWS publication was queued, but Mavly could not refresh its status.",
    );
  }
  return { ok: true, data: wireDeploymentStatus(recorded.data) };
}

/**
 * Re-prove a pending shared publication. A transient lookup/read failure keeps
 * the row `pending` (and therefore non-successful) instead of inventing either a
 * live site or a failed publish.
 */
async function refreshSharedPublication(row: DeploymentRow): Promise<DeploymentRow> {
  if (!row.mavly_hostname || !row.active_version_id) return row;

  const probe = await verifySharedPublication(row.mavly_hostname, row.active_version_id);
  const domain = probeDomainState(probe);

  const patched = await updateDeploymentRow(row.project_id, {
    mavly_domain_status: domain.status,
    mavly_domain_error: domain.error,
    mavly_domain_checked_at: new Date().toISOString(),
    ...(probe.ok ? { error_code: null, error_message: null } : {}),
  });
  return isDeploymentStoreFailure(patched) ? row : patched.data;
}

async function unpublishSharedProject(
  projectId: string,
  lease: string,
  row: DeploymentRow,
): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  try {
    /**
     * The mapping is the public switch: after deactivation the resolver finds no
     * active version, so the host stops serving immediately. The version history
     * and the Vercel legacy mapping (if any) are preserved for republishing.
     */
    const deactivated = await deactivatePublishedVersion(projectId);
    if (isHostingStoreFailure(deactivated)) {
      logHostingEvent("unpublish_failed", { project: projectId, stage: "deactivate" });
      await rollBackUnpublish(
        projectId,
        lease,
        row.status,
        "Mavly could not take this website offline.",
      );
      return fail(
        deactivated.code === "MIGRATION_REQUIRED" ? 503 : 500,
        deactivated.code === "MIGRATION_REQUIRED" ? "BACKEND_NOT_CONFIGURED" : "UNKNOWN",
        deactivated.code === "MIGRATION_REQUIRED"
          ? "Shared hosting is not installed. Apply migration 14."
          : "Mavly could not take this website offline.",
      );
    }

    const finished = await finishUnpublish(projectId, lease);
    if (isDeploymentStoreFailure(finished)) {
      console.error("[deployments] shared unpublish finished but was not recorded:", finished.error);
      return fail(
        500,
        "UNKNOWN",
        "The website is no longer public, but Mavly could not record the change. Reload in a moment to see the current state.",
      );
    }

    logHostingEvent("unpublish_completed", { project: projectId, mode: "shared" });
    return { ok: true, data: wireDeploymentStatus(finished.data) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[deployments] unexpected shared unpublish failure:", message);
    await rollBackUnpublish(
      projectId,
      lease,
      row.status,
      "Mavly did not confirm the unpublish. The website may still be live.",
    );
    return fail(
      502,
      "UNKNOWN",
      "Mavly did not confirm the unpublish. The website may still be live.",
    );
  }
}

async function unpublishAwsProject(
  projectId: string,
  lease: string,
  previousStatus: StoredDeploymentStatus,
  unpublishingRow: DeploymentRow,
): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  const queued = await enqueueAwsFrontendUnpublish({
    projectId,
    leaseUpdatedAt: lease,
  });
  if (queued.ok === false) {
    const restoredStatus =
      previousStatus === "unpublishing" ? "error" : previousStatus;
    await releaseUnpublish(projectId, lease, restoredStatus, {
      code: queued.code,
      message: "Mavly could not queue the AWS route removal.",
    });
    return fail(
      queued.code === "MIGRATION_REQUIRED" ? 503 : 500,
      queued.code === "MIGRATION_REQUIRED" ? "BACKEND_NOT_CONFIGURED" : "UNKNOWN",
      queued.error,
    );
  }
  return { ok: true, data: wireDeploymentStatus(unpublishingRow) };
}

/**
 * Status for a shared row never consults Vercel: there is no Vercel project.
 * Terminal states are authoritative; a pending probe is retried at most once a
 * minute; a stale in-flight claim becomes an actionable failure.
 */
async function sharedDeploymentStatus(
  projectId: string,
  row: DeploymentRow,
): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  let current = row;

  if (current.status === "unpublishing") {
    if (!isDeploymentRowStale(current)) {
      return { ok: true, data: wireDeploymentStatus(current) };
    }
    /** A killed process: finish the deactivation it started. */
    const deactivated = await deactivatePublishedVersion(projectId);
    if (isHostingStoreFailure(deactivated)) {
      return { ok: true, data: wireDeploymentStatus(current) };
    }
    const finished = await finishUnpublish(projectId, current.updated_at);
    return {
      ok: true,
      data: wireDeploymentStatus(isDeploymentStoreFailure(finished) ? current : finished.data),
    };
  }

  async function awsDeploymentStatus(
    projectId: string,
    row: DeploymentRow,
  ): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
    if (row.status === "unpublishing") {
      return { ok: true, data: wireDeploymentStatus(row) };
    }

    if (
      row.status !== "ready" ||
      !row.mavly_hostname ||
      row.mavly_domain_status === "verified" ||
      row.mavly_domain_status === "error" ||
      !row.active_version_id ||
      !domainCheckDue(row)
    ) {
      return { ok: true, data: wireDeploymentStatus(row) };
    }

    let verified = false;
    try {
      verified = await verifyAwsPublicTenantRoute({
        projectId,
        versionId: row.active_version_id,
        hostname: row.mavly_hostname,
      });
    } catch {
      return { ok: true, data: wireDeploymentStatus(row) };
    }

    const patched = await updateDeploymentRow(projectId, {
      mavly_domain_status: verified ? "verified" : "pending",
      mavly_domain_error: null,
      mavly_domain_checked_at: new Date().toISOString(),
    });
    return {
      ok: true,
      data: wireDeploymentStatus(isDeploymentStoreFailure(patched) ? row : patched.data),
    };
  }

  if (current.status === "queued" || current.status === "building") {
    if (!isDeploymentRowStale(current)) {
      return { ok: true, data: wireDeploymentStatus(current) };
    }
    const stalled = await updateDeploymentRow(projectId, {
      status: "error",
      error_code: "deployment_stalled",
      error_message: "The publish did not complete. Try publishing again.",
    });
    return {
      ok: true,
      data: wireDeploymentStatus(isDeploymentStoreFailure(stalled) ? current : stalled.data),
    };
  }

  /**
   * ⚠️ ROLLBACK TRUTHFULNESS. A published version still exists in the database
   * after the operator turns shared hosting off (or removes this project from
   * the cohort), but the runtime answers 404 for the tenant host. Reporting
   * `success` and a live URL would be a lie, so the row is presented as an error
   * the owner can act on (the legacy Vercel path remains available).
   */
  if (!isSharedHostingRuntimeEnabled() || !isSharedHostingProject(projectId)) {
    return {
      ok: true,
      data: wireDeploymentStatus({
        ...current,
        status: "error",
        error_code: "shared_hosting_disabled",
        error_message: "Shared hosting is disabled for this project.",
        mavly_domain_status: "error",
        mavly_domain_error: "Shared hosting is disabled for this project.",
      }),
    };
  }

  if (
    current.status === "ready" &&
    current.mavly_hostname &&
    current.active_version_id &&
    current.mavly_domain_status !== "verified" &&
    current.mavly_domain_status !== "error" &&
    domainCheckDue(current)
  ) {
    current = await refreshSharedPublication(current);
  }

  return { ok: true, data: wireDeploymentStatus(current) };
}

export interface PublishProjectOptions {
  /** A verified snapshot to deploy. Only meaningful for full-stack hosting. */
  snapshotId?: string | null;
  /**
   * The owner-approved deployment proposal for this exact artifact. Required
   * only when the deployment approval gate is enabled for the project.
   */
  approvalId?: string | null;
}

export async function publishProject(
  userId: string,
  projectId: string,
  options: PublishProjectOptions = {},
): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  const allowance = deploymentOperationLimiter.consume(userId);
  if (allowance.ok === false) return rateLimitFailure(allowance);

  /**
   * ═══ FULL-STACK HOSTING IS A DIFFERENT CONTRACT ═══════════════════════════
   *
   * A project the operator explicitly listed is routed here BEFORE any static
   * resolution. If a prerequisite is missing, `publishFullstackProject` refuses
   * with that prerequisite — it never falls through to a static publish that
   * would silently drop every server route.
   *
   * ⚠️ AN EXISTING FULL-STACK ROW IS ROUTED HERE TOO, even when the project is
   * no longer in the cohort. Otherwise removing a project from the cohort would
   * make its next deploy a static publish, silently replacing a full-stack site
   * with one that has no API routes. `publishFullstackProject` then refuses the
   * removal with a clear message.
   *
   * The admission window above is consumed exactly once.
   */
  if (
    isFullstackHostingRequested(projectId) ||
    (await isFullstackDeploymentRow(projectId))
  ) {
    return publishFullstackProject(userId, projectId, options);
  }

  const existing = await getDeploymentRow(projectId);
  if (isDeploymentStoreFailure(existing)) {
    const migration = migrationFailure(existing.code, existing.error);
    if (migration) return migration;
    return fail(500, "UNKNOWN", "Could not load the deployment status.");
  }

  const awsConfig = readAwsFrontendHostingConfig();
  if (awsConfig.enabled && awsConfig.problem !== null) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      `AWS frontend hosting is enabled but not fully configured (${awsConfig.problem}).`,
    );
  }
  const awsCohort = isAwsFrontendHostingProject(projectId);
  const existingAwsDeployment = existing.data?.provider === "aws";
  if (existingAwsDeployment && !awsCohort) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "This project already uses AWS hosting, but its AWS hosting configuration or cohort is no longer enabled.",
    );
  }
  const aws = existingAwsDeployment || awsCohort;

  if (aws && existing.data?.provider === "vercel") {
    return fail(
      409,
      "HOSTING_MIGRATION_REQUIRED",
      "This project has an existing Vercel deployment. It must be migrated and verified before AWS hosting can replace it.",
    );
  }
  if (aws && existing.data?.provider === "shared") {
    return fail(
      409,
      "HOSTING_MIGRATION_REQUIRED",
      "This project has an existing shared-hosting publication. It must be migrated and verified before AWS hosting can replace it.",
    );
  }

  /**
   * Which hosting path this project uses. Existing AWS mappings remain on AWS;
   * a new AWS cohort does not silently replace a Vercel deployment.
   */
  const shared = isSharedHostingProject(projectId);
  if (aws && shared) {
    return fail(
      409,
      "HOSTING_PROVIDER_CONFLICT",
      "This project is configured for both AWS and shared hosting. Select exactly one hosting provider.",
    );
  }

  /**
   * Vercel credentials are required only for the legacy path. A shared publish
   * must work with no Vercel configuration at all — that is the migration's
   * whole point.
   */
  let config: VercelDeploymentConfigResult | null = null;
  if (!shared && !aws) {
    config = readVercelDeploymentConfig();
    if (isVercelDeploymentConfigFailure(config)) {
    /**
     * Presence only: no token, no value, no request content. This is the line
     * that tells an operator whether the flag or the token name is the mismatch.
     */
    console.warn(
      `[deployments] configuration failure ${formatVercelFailureDiagnostic({
        operation: "read_config",
        method: "CONFIG",
        endpoint: "environment",
        status: 0,
        upstreamCode: config.reason,
        upstreamMessage:
          config.reason === "disabled"
            ? "MAVLY_VERCEL_DEPLOYMENTS_ENABLED is not enabled."
            : "VERCEL_API_TOKEN is missing or empty.",
        requestId: null,
        config: vercelConfigPresence(),
      })}`,
    );
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      config.reason === "disabled"
        ? "Publishing is not enabled on this Mavly deployment."
        : "Publishing is not configured on this Mavly deployment.",
    );
    }
  }

  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) {
    return fail(500, "UNKNOWN", "Could not load this project.");
  }
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");

  const files = await listFiles(projectId);
  if (isStoreFailure(files)) {
    return fail(500, "UNKNOWN", "Could not read the project source.");
  }
  const resolved = resolveStaticPreview(
    files.data.map((file) => ({ path: file.path, content: file.content })),
  );
  if (!resolved.site) {
    return fail(
      400,
      "VALIDATION",
      resolved.reason,
    );
  }
  const publishFiles = staticPublishFiles(
    files.data.map((file) => ({ path: file.path, content: file.content })),
    resolved.site,
  );
  if (publishFiles.length === 0 || publishFiles.length > PUBLISH_MAX_FILES) {
    return fail(
      400,
      "VALIDATION",
      publishFiles.length === 0
        ? "This project has no static files to publish."
        : "This static site has too many files to publish in one pass.",
    );
  }
  const totalBytes = publishFiles.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  if (totalBytes > PUBLISH_MAX_BYTES) {
    return fail(400, "VALIDATION", "This static site is too large to publish in one pass.");
  }

  /**
   * ⚠️ THE APPROVAL GATE RUNS AFTER THE EXACT FILE SET IS DERIVED and before any
   * provider mutation. When the gate is off this is a no-op, so the legacy path
   * is unchanged. The hash is server-derived; a browser cannot supply it.
   */
  const approval = await enforceDeploymentApproval({
    projectId,
    target: "static",
    snapshotId: null,
    sourceHash: hashSource(publishFiles),
    approvalId: options.approvalId ?? null,
  });
  if (!approval.ok) return fail((approval as { status: number }).status, (approval as { code: string }).code, (approval as { error: string }).error);

  const hostname = mavlyHostname(projectId);
  if (!hostname) {
    return fail(400, "VALIDATION", "This project id cannot be published on a Mavly address.");
  }

  if (shared) {
    return publishSharedVersion({
      projectId,
      hostname,
      site: resolved.site,
      publishFiles,
    });
  }

  if (aws) {
    return enqueueAwsPublication({
      projectId,
      hostname,
      site: resolved.site,
      publishFiles,
    });
  }

  if (!config || isVercelDeploymentConfigFailure(config)) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Publishing is not configured on this Mavly deployment.",
    );
  }

  const requestedName = vercelProjectName(config.config.projectPrefix, projectId, userId);
  const began = await beginDeployment(projectId, requestedName);
  if (isDeploymentStoreFailure(began)) {
    const migration = migrationFailure(began.code, began.error);
    if (migration) return migration;
    return began.code === "CONFLICT"
      ? fail(409, "VALIDATION", began.error)
      : fail(500, "UNKNOWN", "Could not start the publish.");
  }

  /**
   * A legacy republish of a project that previously used shared hosting leaves a
   * resolvable shared version behind. It is deactivated only AFTER this Vercel
   * publish reaches `ready` (below), never before: a failed legacy publish must
   * not take the previous site down. A deployment without migration 14 has no
   * such column, so legacy publishing still works unchanged.
   */
  const previousSharedVersion = began.data.active_version_id ?? null;

  /**
   * Reuse the name already mapped to this project. The prefix is configuration,
   * and changing it must not point an existing deployment at a host that does
   * not exist.
   */
  const name = began.data.vercel_project_name || requestedName;

  /**
   * Recover from a saved id that the current credentials cannot read. This never
   * deletes or overwrites the remote project; it only replaces the local mapping
   * after the deterministic name is accessible or has been created in the
   * currently configured scope. A domain still attached to the old project is
   * reported as a conflict later rather than being silently stolen.
   */
  const resolvedProject = await resolveVercelProject(
    {
      getProject: (idOrName) => getVercelProject(config.config, idOrName),
      createProject: (projectName) => createVercelProject(config.config, projectName),
    },
    { storedId: began.data.vercel_project_id, name },
  );
  if (resolvedProject.ok === false) {
    await recordFailure(projectId, resolvedProject.failure);
    return fromVercel(resolvedProject.failure);
  }

  const vercelProject = resolvedProject.data.project;
  const vercelProjectId = vercelProject.id;
  if (
    resolvedProject.data.replacedStoredId ||
    began.data.vercel_project_id !== vercelProject.id ||
    began.data.vercel_project_name !== vercelProject.name
  ) {
    if (resolvedProject.data.replacedStoredId) {
      console.warn(
        "[deployments] saved Vercel project was inaccessible; recovered the deterministic project target",
      );
    }
    const saved = await updateDeploymentRow(projectId, {
      vercel_project_id: vercelProject.id,
      vercel_project_name: vercelProject.name,
    });
    if (isDeploymentStoreFailure(saved)) {
      return fail(500, "UNKNOWN", "Could not save the deployment mapping.");
    }
  }

  /**
   * Attach the Mavly hostname BEFORE creating the deployment. If the address is
   * already owned by another project, fail here without pretending a publish
   * happened. Verification can still be pending; the deployment then stays
   * "deploying" until Vercel reports the domain verified.
   */
  const assigned = await assignMavlyDomain(config.config, vercelProjectId, hostname);
  if ("error" in assigned) {
    await recordDomainFailure(projectId, hostname, assigned);
    return assigned;
  }

  const domainSaved = await updateDeploymentRow(projectId, {
    mavly_hostname: hostname,
    mavly_domain_status: assigned.data.status,
    mavly_domain_error: assigned.data.error,
    mavly_domain_checked_at: new Date().toISOString(),
  });
  if (isDeploymentStoreFailure(domainSaved)) {
    await updateDeploymentRow(projectId, {
      status: "error",
      error_code: "domain_save_failed",
      error_message: "Mavly could not record the project's Mavly address.",
      mavly_domain_status: "error",
      mavly_domain_error: "Mavly could not record the project's Mavly address.",
      mavly_domain_checked_at: new Date().toISOString(),
    });
    if (domainSaved.code === "23505") {
      return fail(409, "DOMAIN_CONFLICT", `The Mavly address ${hostname} is already mapped to another project.`);
    }
    return fail(500, "UNKNOWN", "Could not save the project's Mavly address.");
  }

  const uploadedFiles: { file: string; sha: string; size: number }[] = [];
  for (const file of publishFiles) {
    const uploaded = await uploadDeploymentFile(config.config, file.path, file.content);
    if (isVercelFailure(uploaded)) {
      await recordFailure(projectId, uploaded.failure);
      return fromVercel(uploaded.failure);
    }
    uploadedFiles.push(uploaded.data);
  }

  const deployment = await createVercelDeployment(config.config, {
    name,
    project: vercelProjectId,
    files: uploadedFiles,
  });
  if (isVercelFailure(deployment)) {
    await recordFailure(projectId, deployment.failure);
    return fromVercel(deployment.failure);
  }

  const status = storedStatusFor(deployment.data.readyState);
  const updated = await updateDeploymentRow(projectId, {
    vercel_project_id: vercelProjectId,
    vercel_project_name: name,
    vercel_deployment_id: deployment.data.id,
    status,
    url: deployment.data.url,
    error_code: status === "error" ? deployment.data.errorCode ?? "deployment_failed" : null,
    error_message:
      status === "error"
        ? (deployment.data.errorMessage ?? "Vercel could not finish the deployment.").slice(0, ERROR_MESSAGE_MAX)
        : null,
  });
  if (isDeploymentStoreFailure(updated)) {
    return fail(
      500,
      "UNKNOWN",
      "The site was submitted to Vercel but Mavly could not record the result. Check the workspace again shortly.",
    );
  }

  /**
   * The legacy publish is recorded. Only now may the project stop being served
   * at the shared runtime — a failed publish above returned before this point and
   * left the previous version resolvable.
   */
  if (previousSharedVersion && updated.data.status === "ready") {
    const deactivated = await deactivatePublishedVersion(projectId);
    if (isHostingStoreFailure(deactivated)) {
      console.warn(
        "[deployments] could not deactivate the previous shared version:",
        deactivated.code ?? "UNKNOWN",
      );
    }
  }

  return { ok: true, data: wireDeploymentStatus(updated.data) };
}

function releasableStatus(
  status: StoredDeploymentStatus,
): Exclude<StoredDeploymentStatus, "unpublishing" | "unpublished"> {
  return status === "ready" || status === "error" || status === "canceled"
    ? status
    : "error";
}

/**
 * Confirm whether a failed DELETE actually detached the domain.
 *
 * A transport timeout may mean Vercel processed the request; the provider state
 * is the authority. Only a 404 (no attached domain) is proof of detachment.
 */
async function domainDetachedAfterFailure(
  config: VercelDeploymentConfig,
  target: string,
  hostname: string,
): Promise<boolean | null> {
  const existing = await getVercelProjectDomain(config, target, hostname);
  if (isVercelFailure(existing)) {
    return existing.failure.status === 404 ? true : null;
  }
  return false;
}

async function removeProductionDeployments(
  config: VercelDeploymentConfig,
  row: DeploymentRow,
  required: boolean,
): Promise<VercelResult<void>> {
  const target = row.vercel_project_id || row.vercel_project_name;
  const ids = new Set<string>();
  if (row.vercel_deployment_id) ids.add(row.vercel_deployment_id);

  if (target) {
    const listed = await listVercelProductionDeployments(config, target);
    if (isVercelFailure(listed)) {
      if (required) return listed;
      console.warn(
        "[deployments] unpublish could not list every production deployment; removing the recorded one only",
      );
    } else {
      for (const id of listed.data) ids.add(id);
    }
  }

  for (const id of ids) {
    const deleted = await deleteVercelDeployment(config, id);
    if (isVercelFailure(deleted)) {
      if (required) return deleted;
      console.warn(
        "[deployments] the Mavly address is detached, but a Vercel deployment could not be removed",
      );
    }
  }
  return { ok: true, data: undefined };
}

async function rollBackUnpublish(
  projectId: string,
  leaseUpdatedAt: string,
  previousStatus: StoredDeploymentStatus,
  message: string,
  /**
   * A cleanup that may have removed some of the public deployments cannot be
   * rolled back to `ready` without risking a false "the site is live" claim. It
   * is restored as `error` instead; `canUnpublish` stays true so it can be retried.
   */
  restoreStatus?: Exclude<StoredDeploymentStatus, "unpublishing" | "unpublished">,
): Promise<void> {
  const restoreTo = restoreStatus ?? releasableStatus(previousStatus);
  const recordFailure =
    previousStatus === "unpublishing" || restoreTo !== previousStatus || restoreTo === "error";
  /**
   * The status and the failure text are written in ONE lease-guarded statement.
   * A second update would be unconditional, so a new publish could claim the row
   * between the two writes and inherit an old unpublish error.
   */
  const released = await releaseUnpublish(
    projectId,
    leaseUpdatedAt,
    restoreTo,
    recordFailure
      ? { code: "unpublish_failed", message: message.slice(0, ERROR_MESSAGE_MAX) }
      : undefined,
  );
  if (isDeploymentStoreFailure(released)) {
    console.error("[deployments] could not roll back a failed unpublish:", released.error);
  }
}

/**
 * ═══ UNPUBLISH — THE PUBLIC SITE ACTUALLY GOES DOWN ═════════════════════════
 *
 * There is no "hide the URL" state here. The operation:
 *
 *   1. claims the mapping with an optimistic lease (`status = unpublishing`);
 *   2. detaches the derived `<project-id>.mavly.xyz` project domain at Vercel —
 *      this is what stops the public Mavly address serving the site;
 *   3. removes the project's production deployments, so their `.vercel.app`
 *      hosts and aliases do not keep serving the old bytes either;
 *   4. records `unpublished` only after the provider confirms the public host is
 *      gone. A provider failure rolls the status back and is reported as a
 *      failure — it never fabricates success.
 *
 * Shared wildcard DNS is untouched. The Vercel project, its deterministic name,
 * the Mavly hostname, the Mavly project row and every generated file are kept so
 * the same project can publish again at the same address.
 *
 * A row whose `mavly_hostname` is NULL is a legacy mapping whose public address
 * is the Vercel project host. For those, removing the production deployments is
 * the critical operation rather than detaching a domain.
 */
export async function unpublishProject(
  userId: string,
  projectId: string,
): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  /**
   * A full-stack row takes the provider takedown path (detach the Mavly domain,
   * remove production deployments, then record `disabled`). A project that is
   * merely in the cohort but still has a static mapping keeps the static
   * unpublish, so adding a project to the cohort cannot make its existing site
   * impossible to take down.
   *
   * The admission window is consumed by whichever path actually runs.
   */
  if (await isFullstackDeploymentRow(projectId)) {
    return disableFullstackProject(userId, projectId);
  }

  const allowance = deploymentOperationLimiter.consume(userId);
  if (allowance.ok === false) return rateLimitFailure(allowance);

  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) {
    return fail(500, "UNKNOWN", "Could not load this project.");
  }
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");

  const rowResult = await getDeploymentRow(projectId);
  if (isDeploymentStoreFailure(rowResult)) {
    const migration = migrationFailure(rowResult.code, rowResult.error);
    if (migration) return migration;
    return fail(500, "UNKNOWN", "Could not load the deployment status.");
  }
  const row = rowResult.data;
  if (!row) {
    return {
      ok: true,
      data: { status: "unpublished", createdAt: null, step: "unpublished", canUnpublish: false },
    };
  }
  if (row.status === "unpublished") {
    return { ok: true, data: wireDeploymentStatus(row) };
  }
  if (row.status === "queued" || row.status === "building") {
    return fail(409, "VALIDATION", "A publish is already in progress. Wait for it to finish before unpublishing.");
  }
  if (row.status === "unpublishing" && !isDeploymentRowStale(row)) {
    return { ok: true, data: wireDeploymentStatus(row) };
  }

  /**
   * The PROVIDER decides how a takedown happens, not the current environment:
   * a row created by the legacy path must still be detached at Vercel even if
   * the deployment has since opted into shared hosting. A shared row needs no
   * Vercel configuration at all.
   */
  const sharedRow = row.provider === "shared";
  const awsRow = row.provider === "aws";

  let config: VercelDeploymentConfigResult | null = null;
  if (!sharedRow && !awsRow) {
    config = readVercelDeploymentConfig();
    if (isVercelDeploymentConfigFailure(config)) {
      return fail(
        503,
        "BACKEND_NOT_CONFIGURED",
        config.reason === "disabled"
          ? "Unpublishing is not enabled on this Mavly deployment."
          : "Unpublishing is not configured on this Mavly deployment.",
      );
    }
  }

  const claimed = await claimUnpublish(projectId, row);
  if (isDeploymentStoreFailure(claimed)) {
    const migration = migrationFailure(claimed.code, claimed.error);
    if (migration) return migration;
    /**
     * A concurrent request may have just finished. Re-read before answering so
     * a repeated click gets the authoritative state instead of a blind error.
     */
    const latest = await getDeploymentRow(projectId);
    if (!isDeploymentStoreFailure(latest) && latest.data) {
      if (latest.data.status === "unpublished" || latest.data.status === "unpublishing") {
        return { ok: true, data: wireDeploymentStatus(latest.data) };
      }
      if (latest.data.status === "queued" || latest.data.status === "building") {
        return fail(409, "VALIDATION", "A publish is already in progress. Wait for it to finish before unpublishing.");
      }
    }
    return fail(
      409,
      "VALIDATION",
      "A deployment operation is already in progress. Reload the project and try again.",
    );
  }

  const lease = claimed.data.updated_at;

  /**
   * ⚠️ A SHARED TAKEDOWN TOUCHES NO VERCEL RESOURCE. It clears the published
   * mapping so the tenant runtime stops resolving the host, and keeps the
   * version history (and any legacy Vercel mapping) for a later republish.
   */
  if (sharedRow) {
    return unpublishSharedProject(projectId, lease, row);
  }
  if (awsRow) {
    return unpublishAwsProject(projectId, lease, row.status, claimed.data);
  }

  if (!config || isVercelDeploymentConfigFailure(config)) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Unpublishing is not configured on this Mavly deployment.",
    );
  }

  const target = row.vercel_project_id || row.vercel_project_name;

  try {
    if (row.mavly_hostname) {
      if (!target) {
        const message = "This deployment has no Vercel project mapping to unpublish.";
        await rollBackUnpublish(projectId, lease, row.status, message);
        return fail(500, "UNKNOWN", message);
      }

      const removed = await removeVercelProjectDomain(
        config.config,
        target,
        row.mavly_hostname,
      );
      if (isVercelFailure(removed)) {
        const detached = await domainDetachedAfterFailure(
          config.config,
          target,
          row.mavly_hostname,
        );
        if (detached !== true) {
          const publicFailure = publicDeploymentFailure(removed.failure, "unpublish");
          await rollBackUnpublish(
            projectId,
            lease,
            row.status,
            publicFailure.error,
          );
          return { ok: false, ...publicFailure };
        }
      }
    }

    /**
     * A legacy row has no Mavly domain, so removing its production deployments
     * is what takes the public address down and therefore must succeed. For a
     * Mavly row the domain is already detached; deployment cleanup is a second
     * layer so the old `.vercel.app` host does not remain public.
     */
    const cleaned = await removeProductionDeployments(
      config.config,
      row,
      /* required */ row.mavly_hostname === null,
    );
    if (isVercelFailure(cleaned)) {
      const publicFailure = publicDeploymentFailure(cleaned.failure, "unpublish");
      /**
       * Only a legacy row reaches this branch (a Mavly row treats cleanup as
       * best-effort). Some of its production deployments may already be gone, so
       * restoring `ready` could claim a live site that no longer exists.
       */
      await rollBackUnpublish(
        projectId,
        lease,
        row.status,
        publicFailure.error,
        row.mavly_hostname === null ? "error" : undefined,
      );
      return { ok: false, ...publicFailure };
    }

    const finished = await finishUnpublish(projectId, lease);
    if (isDeploymentStoreFailure(finished)) {
      console.error("[deployments] unpublish finished remotely but was not recorded:", finished.error);
      return fail(
        500,
        "UNKNOWN",
        "The website is no longer public, but Mavly could not record the change. Reload in a moment to see the current state.",
      );
    }
    return { ok: true, data: wireDeploymentStatus(finished.data) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[deployments] unexpected unpublish failure:", message);
    await rollBackUnpublish(
      projectId,
      lease,
      row.status,
      "The hosting provider did not confirm the unpublish. The website may still be live.",
    );
    return fail(
      502,
      "UNKNOWN",
      "The hosting provider did not confirm the unpublish. The website may still be live.",
    );
  }
}

/**
 * Reconcile a stale `unpublishing` claim after a process died mid-request.
 *
 * The provider state decides: a missing project domain (Mavly host) or no READY
 * production deployment (legacy) means the site is down and the row is moved to
 * `unpublished`; a still-attached domain/deployment means the takedown did not
 * complete, so the row is moved back to a state that reflects what is actually
 * serving rather than leaving the UI stuck on "Unpublishing".
 */
async function reconcileStaleUnpublish(
  config: VercelDeploymentConfig,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  const target = row.vercel_project_id || row.vercel_project_name;

  let domainDetached = row.mavly_hostname === null;
  if (row.mavly_hostname) {
    if (!target) return row;
    const domain = await getVercelProjectDomain(config, target, row.mavly_hostname);
    if (isVercelFailure(domain)) {
      if (domain.failure.status !== 404) return row;
      domainDetached = true;
    } else {
      domainDetached = false;
    }
  }

  let deploymentStillReady = false;
  if (row.vercel_deployment_id) {
    const deployment = await getVercelDeployment(config, row.vercel_deployment_id);
    if (isVercelFailure(deployment)) {
      if (deployment.failure.status !== 404) return row;
    } else {
      deploymentStillReady = deployment.data.readyState.toUpperCase() === "READY";
    }
  }

  let cleanupFailed = false;
  if (domainDetached) {
    /**
     * Finish the takedown the dead process started. A Mavly host is already
     * detached, so deployment cleanup is best-effort; a legacy host IS the Vercel
     * deployment host, so a cleanup failure must not be recorded as unpublished.
     */
    const cleaned = await removeProductionDeployments(
      config,
      row,
      row.mavly_hostname === null,
    );
    if (!isVercelFailure(cleaned)) {
      const finished = await finishUnpublish(row.project_id, row.updated_at);
      if (!isDeploymentStoreFailure(finished)) return finished.data;
      return row;
    }
    cleanupFailed = true;
  }

  /**
   * Something is still serving — or a legacy cleanup removed some deployments and
   * then failed, which is not proof of a live site. Record that the takedown did
   * not finish instead of pretending it did; the owner can retry. This uses the
   * same lease as the claim, so a concurrent worker cannot be overwritten.
   */
  const restored = await releaseUnpublish(
    row.project_id,
    row.updated_at,
    !cleanupFailed && (deploymentStillReady || row.mavly_hostname) ? "ready" : "error",
    {
      code: "unpublish_incomplete",
      message:
        "The unpublish did not finish. The website may still be live; try unpublishing again.",
    },
  );
  return isDeploymentStoreFailure(restored) ? row : restored.data;
}

export async function getProjectDeploymentStatus(
  userId: string,
  projectId: string,
): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  /**
   * A full-stack row has its own lifecycle, attempt fence and readiness
   * contract. Only a row that is actually full-stack is routed here, so a
   * project added to the cohort with an older static deployment keeps the
   * static status shape.
   */
  if (await isFullstackDeploymentRow(projectId)) {
    return getFullstackDeploymentStatus(userId, projectId);
  }

  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) {
    return fail(500, "UNKNOWN", "Could not load this project.");
  }
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");

  const row = await getDeploymentRow(projectId);
  if (isDeploymentStoreFailure(row)) {
    const migration = migrationFailure(row.code, row.error);
    if (migration) return migration;
    return fail(500, "UNKNOWN", "Could not load the deployment status.");
  }
  if (!row.data) {
    return {
      ok: true,
      data: { status: "unpublished", createdAt: null, step: "unpublished", canUnpublish: false },
    };
  }

  /**
   * A recorded unpublish is terminal. It still keeps the Vercel project mapping
   * for a later republish, but no remote read is needed and no live URL exists.
   */
  if (row.data.status === "unpublished") {
    return { ok: true, data: wireDeploymentStatus(row.data) };
  }

  /**
   * A shared row has no Vercel deployment to poll. Its terminal states are
   * authoritative, a pending readiness probe is retried at most once a minute,
   * and a stale claim is reconciled locally.
   */
  if (row.data.provider === "shared") {
    return sharedDeploymentStatus(projectId, row.data);
  }
  if (row.data.provider === "aws") {
    return awsDeploymentStatus(projectId, row.data);
  }

  /**
   * An unpublish is a short server operation, but a killed process can leave the
   * claim behind. Only a stale claim is reconciled, so a request that is still in
   * flight is never raced.
   */
  if (row.data.status === "unpublishing") {
    if (!isDeploymentRowStale(row.data)) {
      return { ok: true, data: wireDeploymentStatus(row.data) };
    }
    const config = readVercelDeploymentConfig();
    if (isVercelDeploymentConfigFailure(config)) {
      return { ok: true, data: wireDeploymentStatus(row.data) };
    }
    const reconciled = await reconcileStaleUnpublish(config.config, row.data);
    return { ok: true, data: wireDeploymentStatus(reconciled) };
  }

  /**
   * An in-flight deployment needs a remote read. A ready deployment with a
   * pending Mavly domain also needs a domain check; terminal rows with a
   * verified domain are authoritative and do not spend Vercel API quota.
   */
  const inFlight = row.data.status === "queued" || row.data.status === "building";
  const domainPending =
    Boolean(row.data.mavly_hostname) &&
    row.data.mavly_domain_status !== "verified" &&
    row.data.mavly_domain_status !== "error";
  if (!inFlight && !domainPending) {
    return { ok: true, data: wireDeploymentStatus(row.data) };
  }

  /**
   * A queued row with no deployment id means the server died between claiming
   * the slot and submitting to Vercel. There is nothing to poll remotely, so a
   * stale row is surfaced as an error instead of spinning for ever.
   */
  if (inFlight && !row.data.vercel_deployment_id) {
    if (!isDeploymentRowStale(row.data)) {
      return { ok: true, data: wireDeploymentStatus(row.data) };
    }
    const stalled = await updateDeploymentRow(projectId, {
      status: "error",
      error_code: "deployment_stalled",
      error_message: "The publish did not reach Vercel. Try publishing again.",
    });
    return {
      ok: true,
      data: wireDeploymentStatus(isDeploymentStoreFailure(stalled) ? row.data : stalled.data),
    };
  }

  const config = readVercelDeploymentConfig();
  if (isVercelDeploymentConfigFailure(config)) {
    // A pending domain remains "deploying", never a fabricated success.
    return { ok: true, data: wireDeploymentStatus(row.data) };
  }

  let current = row.data;
  if (inFlight && current.vercel_deployment_id) {
    const remote = await getVercelDeployment(config.config, current.vercel_deployment_id);
    if (isVercelFailure(remote)) {
      if (remote.failure.status === 404) {
        const patched = await updateDeploymentRow(projectId, {
          status: "error",
          error_code: "deployment_not_found",
          error_message: "The Vercel deployment no longer exists.",
        });
        return {
          ok: true,
          data: wireDeploymentStatus(isDeploymentStoreFailure(patched) ? current : patched.data),
        };
      }
      // Keep the last recorded state. A transient read failure is not a failed build.
      return { ok: true, data: wireDeploymentStatus(current) };
    }

    const status = storedStatusFor(remote.data.readyState);
    const patched = await updateDeploymentRow(projectId, {
      status,
      url: remote.data.url,
      error_code: status === "error" ? remote.data.errorCode ?? "deployment_failed" : null,
      error_message:
        status === "error"
          ? (remote.data.errorMessage ?? "Vercel could not finish the deployment.").slice(0, ERROR_MESSAGE_MAX)
          : null,
    });
    current = isDeploymentStoreFailure(patched) ? current : patched.data;
  }

  if (
    current.status === "ready" &&
    current.mavly_hostname &&
    current.mavly_domain_status !== "verified" &&
    current.mavly_domain_status !== "error" &&
    domainCheckDue(current)
  ) {
    current = await refreshPendingDomain(config.config, current);
  }

  return { ok: true, data: wireDeploymentStatus(current) };
}

/**
 * Best-effort remote cleanup after the Mavly project row is deleted.
 *
 * Called from the project delete handler after the database delete succeeded.
 * A Vercel failure here leaves an orphan project, which is logged without any
 * credential and never turns a successful local delete into an error.
 */
export async function discardVercelProject(row: DeploymentRow): Promise<void> {
  /**
   * ⚠️ A SHARED MAPPING NEVER OWNS A VERCEL PROJECT. Deleting the shared hosting
   * application because one tenant was removed would take every other tenant
   * down. Shared cleanup is the database cascade of this project's rows only.
   */
  if (row.provider !== "vercel") return;

  const config = readVercelDeploymentConfig();
  if (isVercelDeploymentConfigFailure(config)) return;

  const target = row.vercel_project_id || row.vercel_project_name;
  if (!target) return;

  const result = await deleteVercelProject(config.config, target);
  if (isVercelFailure(result)) {
    console.error(
      `[deployments] Vercel cleanup failed (${result.failure.status}): ${result.failure.message}`,
    );
  }
}
