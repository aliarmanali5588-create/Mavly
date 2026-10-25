/**
 * Publish orchestration for Mavly-managed Vercel deployments.
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
import { mavlyHostname } from "@/lib/mavly-hostname";
import { getProject, isStoreFailure, listFiles } from "@/lib/mavly/store";
import {
  isVercelDeploymentConfigFailure,
  readVercelDeploymentConfig,
  type VercelDeploymentConfig,
} from "@/lib/vercel/config";
import {
  formatVercelFailureDiagnostic,
  vercelConfigPresence,
} from "@/lib/vercel/diagnostics";
import {
  addVercelProjectDomain,
  createVercelDeployment,
  createVercelProject,
  deleteVercelProject,
  getVercelDeployment,
  getVercelProject,
  getVercelProjectDomain,
  isVercelFailure,
  uploadDeploymentFile,
  vercelProjectName,
  verifyVercelProjectDomain,
  type VercelFailure,
  type VercelProjectDomain,
} from "@/lib/vercel/provider";
import {
  beginDeployment,
  getDeploymentRow,
  isDeploymentRowStale,
  isDeploymentStoreFailure,
  updateDeploymentRow,
  type DeploymentRow,
  type DeploymentStatus as StoredDeploymentStatus,
  type MavlyDomainStatus,
} from "./store";
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

function wireStatus(status: StoredDeploymentStatus): "deploying" | "success" | "error" {
  if (status === "ready") return "success";
  if (status === "error" || status === "canceled") return "error";
  return "deploying";
}

/**
 * The stable production host for a deployment row, without a scheme.
 *
 * A row with a Mavly hostname only exposes it after Vercel reports the domain
 * verified. A legacy row (no Mavly hostname) keeps its existing Vercel address,
 * so historical deployments continue to work and their URL is never rewritten.
 */
export function deploymentHost(row: DeploymentRow | null): string {
  if (!row) return "";
  if (row.mavly_hostname) {
    return row.mavly_domain_status === "verified" ? row.mavly_hostname : "";
  }
  return row.vercel_project_name ? `${row.vercel_project_name}.vercel.app` : "";
}

export function wireDeploymentStatus(row: DeploymentRow): WireDeploymentStatus {
  const deploymentState = wireStatus(row.status);
  const hasMavlyHostname = Boolean(row.mavly_hostname);
  const domainVerified = !hasMavlyHostname || row.mavly_domain_status === "verified";
  const domainErrorCode = (row.error_code ?? "").toLowerCase();
  const domainFailed =
    hasMavlyHostname &&
    row.mavly_domain_status === "error" &&
    (deploymentState === "success" || domainErrorCode.startsWith("domain"));
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
  const createdAt = row.last_published_at ?? row.created_at;

  return {
    status,
    createdAt,
    ...(row.vercel_deployment_id ? { deploymentId: row.vercel_deployment_id } : {}),
    step: status === "deploying" ? (domainStep ? "domain" : "building") : status,
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
                  "Vercel could not verify this Mavly address.",
              }
            : {
                stage: "build",
                title: "Publish failed",
                message: row.error_message || "Vercel could not finish the deployment.",
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

interface DomainAssignment {
  status: MavlyDomainStatus;
  error: string | null;
}

/**
 * Attach the project's Mavly hostname to its Vercel project and ask Vercel to
 * verify it. A domain that is merely attached is not ready: only
 * `verified: true` may make a deployment live at the Mavly address.
 */
async function assignMavlyDomain(
  config: VercelDeploymentConfig,
  vercelProjectId: string,
  hostname: string,
): Promise<DeploymentServiceResult<DomainAssignment>> {
  const added = await addVercelProjectDomain(config, vercelProjectId, hostname);
  let domain: VercelProjectDomain;

  if (isVercelFailure(added)) {
    /**
     * Vercel reports an existing project-domain as a validation/conflict error.
     * Re-read it from THIS project before deciding: a domain attached to another
     * Vercel project must never be adopted.
     */
    if (added.failure.status === 400 || added.failure.status === 409) {
      const existing = await getVercelProjectDomain(config, vercelProjectId, hostname);
      if (isVercelFailure(existing)) {
        if (existing.failure.status === 404) {
          return fail(
            409,
            "DOMAIN_CONFLICT",
            `The Mavly address ${hostname} is already assigned to another deployment.`,
          );
        }
        return fromVercel(existing.failure);
      }
      domain = existing.data;
    } else {
      return fromVercel(added.failure);
    }
  } else {
    domain = added.data;
  }

  if (!domain.verified) {
    const checked = await verifyVercelProjectDomain(config, vercelProjectId, hostname);
    if (isVercelFailure(checked)) {
      if (checked.failure.status === 404) {
        return fail(
          502,
          "DOMAIN_NOT_FOUND",
          `Vercel could not find the Mavly address ${hostname} after assigning it.`,
        );
      }
      if (checked.failure.status === 401 || checked.failure.status === 403) {
        return fromVercel(checked.failure);
      }
      // A pending DNS/certificate challenge is not a failed publish. Status
      // checks will retry verification without ever reporting success early.
      return { ok: true, data: { status: "pending", error: null } };
    }
    domain = checked.data;
  }

  return {
    ok: true,
    data: { status: domain.verified ? "verified" : "pending", error: null },
  };
}

async function recordDomainFailure(
  projectId: string,
  hostname: string,
  failure: { code: string; error: string },
): Promise<void> {
  const normalizedCode = failure.code.toLowerCase();
  const errorCode = (
    normalizedCode.startsWith("domain") ? failure.code : `domain_${failure.code}`
  ).slice(0, 120);
  const updated = await updateDeploymentRow(projectId, {
    status: "error",
    error_code: errorCode,
    error_message: failure.error.slice(0, ERROR_MESSAGE_MAX),
    mavly_hostname: hostname,
    mavly_domain_status: "error",
    mavly_domain_error: failure.error.slice(0, ERROR_MESSAGE_MAX),
    mavly_domain_checked_at: new Date().toISOString(),
  });
  if (isDeploymentStoreFailure(updated)) {
    console.error("[deployments] could not record domain failure:", updated.error);
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

export async function publishProject(
  userId: string,
  projectId: string,
): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  const config = readVercelDeploymentConfig();
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

  const hostname = mavlyHostname(projectId);
  if (!hostname) {
    return fail(400, "VALIDATION", "This project id cannot be published on a Mavly address.");
  }

  const requestedName = vercelProjectName(config.config.projectPrefix, projectId, userId);
  const began = await beginDeployment(projectId, requestedName);
  if (isDeploymentStoreFailure(began)) {
    return began.code === "CONFLICT"
      ? fail(409, "VALIDATION", began.error)
      : fail(500, "UNKNOWN", "Could not start the publish.");
  }

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
  if (isDeploymentServiceFailure(assigned)) {
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

  return { ok: true, data: wireDeploymentStatus(updated.data) };
}

export async function getProjectDeploymentStatus(
  userId: string,
  projectId: string,
): Promise<DeploymentServiceResult<WireDeploymentStatus>> {
  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) {
    return fail(500, "UNKNOWN", "Could not load this project.");
  }
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");

  const row = await getDeploymentRow(projectId);
  if (isDeploymentStoreFailure(row)) {
    return fail(500, "UNKNOWN", "Could not load the deployment status.");
  }
  if (!row.data) return { ok: true, data: { status: null, createdAt: null } };

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
