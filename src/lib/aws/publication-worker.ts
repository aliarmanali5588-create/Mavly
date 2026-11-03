import type { SupabaseClient } from "@supabase/supabase-js";
import { mavlyHostname } from "@/lib/mavly-hostname";
import { contentTypeForPath, isSafePublishedSegment } from "@/lib/hosting/published-version";
import { preparePublishedFiles } from "@/lib/hosting/store";
import { isAwsFrontendHostingProject, readAwsFrontendHostingConfig } from "./config";
import {
  claimAwsFrontendUnpublish,
  claimAwsFrontendPublication,
  completeAwsFrontendUnpublish,
  completeAwsFrontendPublication,
  failAwsFrontendUnpublish,
  failAwsFrontendPublication,
  authorizeAwsFrontendRouteRestore,
  authorizeAwsFrontendRouteActivation,
  readAwsFrontendSchemaVersion,
  readAwsFrontendFencingSchemaVersion,
  renewAwsFrontendPublication,
} from "./publication-store";
import {
  activateAwsTenantMapping,
  removeAwsTenantMapping,
  restoreAwsTenantMapping,
  readAwsTenantMapping,
  verifyAwsTenantRoute,
  verifyAwsPublicTenantRouteRemoved,
} from "./tenant-mapping";
import {
  AwsPublicationLeaseLostError,
  publishToS3,
  verifyS3Publication,
  type S3PublicationOutcome,
} from "./s3-publisher";
import { emitAwsPublicationEvent } from "./observability";

export interface AwsPublicationTickSummary {
  status:
    | "empty"
    | "completed"
    | "unpublished"
    | "retry"
    | "failed"
    | "unavailable"
    | "error";
  versionId?: string;
  projectId?: string;
  reason?: string;
}

const PUBLICATION_LEASE_RENEW_INTERVAL_MS = 60_000;
const PUBLICATION_OPERATION_DEADLINE_MS = 6 * 60_000;

interface PublicationLeaseGuard {
  abortSignal: AbortSignal;
  assert: () => void;
  stop: () => void;
}

function startPublicationLeaseGuard(
  client: SupabaseClient,
  identity: { versionId: string; leaseToken: string },
  projectId: string,
): PublicationLeaseGuard {
  const controller = new AbortController();
  let stopped = false;
  let lost = false;
  let renewalInFlight = false;

  const markLost = (reason: string): void => {
    if (stopped || lost) return;
    lost = true;
    controller.abort(reason);
    emitAwsPublicationEvent("lease_lost", {
      projectId,
      versionId: identity.versionId,
      reason,
    });
  };

  const renew = (): void => {
    if (stopped || lost || renewalInFlight) return;
    renewalInFlight = true;
    void renewAwsFrontendPublication(client, identity)
      .then((result) => {
        if (result.ok === false || !result.data) markLost("renewal_rejected");
      })
      .catch(() => markLost("renewal_failed"))
      .finally(() => {
        renewalInFlight = false;
      });
  };

  const interval = setInterval(renew, PUBLICATION_LEASE_RENEW_INTERVAL_MS);
  const deadline = setTimeout(
    () => markLost("operation_deadline_exceeded"),
    PUBLICATION_OPERATION_DEADLINE_MS,
  );
  if (typeof interval.unref === "function") interval.unref();
  if (typeof deadline.unref === "function") deadline.unref();

  return {
    abortSignal: controller.signal,
    assert: () => {
      if (lost || controller.signal.aborted) throw new AwsPublicationLeaseLostError();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      clearTimeout(deadline);
    },
  };
}

interface PublicationVersion {
  project_id: string;
  status: string;
  content_hash: string;
  entry_path: string;
  spa_fallback: boolean;
  file_count: number;
  byte_count: number;
}

interface PublicationFile {
  path: string;
  content: string;
  content_type: string;
  sha256: string;
  size_bytes: number;
}

async function restoreActiveTenantRoute(
  client: SupabaseClient,
  projectId: string,
  attemptedVersionId: string,
  leaseToken: string,
  routingGeneration: number,
): Promise<"restored" | "already_active" | "failed"> {
  const deployment = await client
    .from("project_deployments")
    .select("provider,status,active_version_id,aws_route_generation")
    .eq("project_id", projectId)
    .maybeSingle();
  if (deployment.error || !deployment.data || deployment.data.provider !== "aws") {
    return "failed";
  }
  const generation = deployment.data.aws_route_generation;
  if (!Number.isSafeInteger(generation) || generation < 1) return "failed";
  if (
    deployment.data.status === "ready" &&
    deployment.data.active_version_id === attemptedVersionId
  ) {
    return "already_active";
  }

  const activeVersionId =
    typeof deployment.data.active_version_id === "string"
      ? deployment.data.active_version_id
      : null;
  if (!activeVersionId) {
    try {
      const current = await readAwsTenantMapping(projectId, { allowWhenDisabled: true });
      if (!current) return "restored";
      const authorized = await authorizeAwsFrontendRouteRestore(client, {
        projectId,
        versionId: attemptedVersionId,
        leaseToken,
        routingGeneration,
        expectedActiveVersionId: null,
      });
      if (authorized.ok === false || !authorized.data) return "failed";
      await removeAwsTenantMapping(projectId, generation, attemptedVersionId);
      return "restored";
    } catch {
      return "failed";
    }
  }

  try {
    const current = await readAwsTenantMapping(projectId, { allowWhenDisabled: true });
    if (current?.versionId === activeVersionId) return "restored";
  } catch {
    return "failed";
  }

  const version = await client
    .from("project_published_versions")
    .select("entry_path,spa_fallback")
    .eq("project_id", projectId)
    .eq("id", activeVersionId)
    .eq("status", "active")
    .maybeSingle();
  if (
    version.error ||
    !version.data ||
    typeof version.data.entry_path !== "string" ||
    typeof version.data.spa_fallback !== "boolean"
  ) {
    return "failed";
  }

  try {
    const authorized = await authorizeAwsFrontendRouteRestore(client, {
      projectId,
      versionId: attemptedVersionId,
      leaseToken,
      routingGeneration,
      expectedActiveVersionId: activeVersionId,
    });
    if (authorized.ok === false || !authorized.data) return "failed";
    await restoreAwsTenantMapping({
      projectId,
      versionId: activeVersionId,
      entryPath: version.data.entry_path,
      spaFallback: version.data.spa_fallback,
      generation,
    }, attemptedVersionId);
    return "restored";
  } catch {
    return "failed";
  }
}

function validEntryPath(path: string): boolean {
  return Boolean(
    path &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every(isSafePublishedSegment),
  );
}

async function failClaim(
  client: SupabaseClient,
  claim: { versionId: string; leaseToken: string },
  code: string,
  retryable: boolean,
): Promise<AwsPublicationTickSummary> {
  const failed = await failAwsFrontendPublication(client, {
    versionId: claim.versionId,
    leaseToken: claim.leaseToken,
    code,
    retryable,
  });
  if (failed.ok === false) {
    console.error("[aws-publication] could not persist outcome:", failed.code);
    emitAwsPublicationEvent("outcome_persistence_failed", {
      versionId: claim.versionId,
      code: failed.code,
    });
    return { status: "error", versionId: claim.versionId, reason: "outcome_persistence_failed" };
  }
  emitAwsPublicationEvent(
    failed.data === "retry_wait" ? "publication_retry" : "publication_failed",
    {
      versionId: claim.versionId,
      code,
      status: failed.data,
    },
  );
  return {
    status: failed.data === "retry_wait" ? "retry" : "failed",
    versionId: claim.versionId,
    reason: code.toLowerCase(),
  };
}

async function failUnpublishClaim(
  client: SupabaseClient,
  claim: { projectId: string; leaseToken: string },
  reason: string,
  retryable: boolean,
): Promise<AwsPublicationTickSummary> {
  const failed = await failAwsFrontendUnpublish(client, {
    ...claim,
    retryable,
  });
  if (failed.ok === false) {
    console.error("[aws-publication] could not persist unpublish outcome:", failed.code);
    emitAwsPublicationEvent("outcome_persistence_failed", {
      projectId: claim.projectId,
      code: failed.code,
    });
    return {
      status: "error",
      projectId: claim.projectId,
      reason: "outcome_persistence_failed",
    };
  }
  emitAwsPublicationEvent(
    failed.data === "retry_wait" ? "publication_retry" : "publication_failed",
    { projectId: claim.projectId, code: reason, status: failed.data },
  );
  return {
    status: failed.data === "retry_wait" ? "retry" : "failed",
    projectId: claim.projectId,
    reason,
  };
}

export async function runAwsFrontendPublicationTick(input: {
  client: SupabaseClient;
}): Promise<AwsPublicationTickSummary> {
  const config = readAwsFrontendHostingConfig();
  const canPublish = config.enabled && config.problem === null;
  if (!config.keyValueStoreArn) {
    return {
      status: "unavailable",
      reason: config.problem ?? "missing_key_value_store",
    };
  }

  const schema = await readAwsFrontendSchemaVersion(input.client);
  if (schema.ok === false) {
    return { status: "unavailable", reason: schema.code.toLowerCase() };
  }
  if (schema.data < 51) return { status: "unavailable", reason: "schema_outdated" };
  const fencingSchema = await readAwsFrontendFencingSchemaVersion(input.client);
  if (fencingSchema.ok === false) {
    return { status: "unavailable", reason: fencingSchema.code.toLowerCase() };
  }
  if (fencingSchema.data < 56) {
    return { status: "unavailable", reason: "fencing_schema_outdated" };
  }

  const unpublishClaim = await claimAwsFrontendUnpublish(input.client);
  if (unpublishClaim.status === "error") {
    console.error("[aws-publication] unpublish claim failed:", unpublishClaim.code);
    return { status: "error", reason: "unpublish_claim_failed" };
  }
  if (unpublishClaim.status === "claimed") {
    emitAwsPublicationEvent("unpublish_started", {
      projectId: unpublishClaim.projectId,
      attempt: unpublishClaim.attemptCount,
      generation: unpublishClaim.routingGeneration,
    });
    const identity = {
      projectId: unpublishClaim.projectId,
      leaseToken: unpublishClaim.leaseToken,
    };
    const owner = await input.client
      .from("projects")
      .select("project_id,user_id")
      .eq("project_id", unpublishClaim.projectId)
      .maybeSingle();
    if (owner.error) {
      return failUnpublishClaim(input.client, identity, "owner_lookup_failed", true);
    }
    if (!owner.data || owner.data.user_id !== unpublishClaim.ownerId) {
      return failUnpublishClaim(input.client, identity, "owner_mismatch", false);
    }

    try {
      await removeAwsTenantMapping(
        unpublishClaim.projectId,
        unpublishClaim.routingGeneration,
      );
    } catch {
      console.error("[aws-publication] KVS route removal failed:", {
        projectId: unpublishClaim.projectId,
      });
      return failUnpublishClaim(input.client, identity, "route_removal_failed", true);
    }

    if (!(await verifyAwsPublicTenantRouteRemoved(unpublishClaim.projectId))) {
      console.error("[aws-publication] route removal was not publicly confirmed:", {
        projectId: unpublishClaim.projectId,
      });
      return failUnpublishClaim(
        input.client,
        identity,
        "route_removal_unverified",
        true,
      );
    }

    const completed = await completeAwsFrontendUnpublish(input.client, identity);
    if (completed.ok === false) {
      const failed = await failUnpublishClaim(
        input.client,
        identity,
        "unpublish_completion_failed",
        true,
      );
      return {
        status: failed.status,
        projectId: unpublishClaim.projectId,
        reason: "unpublish_completion_failed",
      };
    }
    emitAwsPublicationEvent("unpublish_completed", {
      projectId: unpublishClaim.projectId,
      generation: unpublishClaim.routingGeneration,
    });
    return { status: "unpublished", projectId: unpublishClaim.projectId };
  }

  if (!canPublish) {
    return {
      status: "unavailable",
      reason: config.problem ?? "disabled",
    };
  }

  const claim = await claimAwsFrontendPublication(input.client);
  if (claim.status === "error") {
    console.error("[aws-publication] claim failed:", claim.code);
    return { status: "error", reason: "claim_failed" };
  }
  if (claim.status === "empty") return { status: "empty" };

  const identity = {
    versionId: claim.versionId,
    leaseToken: claim.leaseToken,
  };

  emitAwsPublicationEvent("publication_claimed", {
    projectId: claim.projectId,
    versionId: claim.versionId,
    attempt: claim.attemptCount,
    generation: claim.routingGeneration,
  });

  if (!isAwsFrontendHostingProject(claim.projectId)) {
    return failClaim(input.client, identity, "INVALID_MANIFEST", false);
  }

  const owner = await input.client
    .from("projects")
    .select("project_id,user_id")
    .eq("project_id", claim.projectId)
    .maybeSingle();
  if (owner.error) {
    return failClaim(input.client, identity, "PUBLICATION_FAILED", true);
  }
  if (!owner.data || owner.data.user_id !== claim.ownerId) {
    return failClaim(input.client, identity, "INVALID_MANIFEST", false);
  }

  const versionResult = await input.client
    .from("project_published_versions")
    .select("project_id,status,content_hash,entry_path,spa_fallback,file_count,byte_count")
    .eq("id", claim.versionId)
    .maybeSingle();
  if (versionResult.error) {
    return failClaim(input.client, identity, "PUBLICATION_FAILED", true);
  }
  const version = versionResult.data as PublicationVersion | null;
  if (
    !version ||
    version.project_id !== claim.projectId ||
    version.status !== "draft" ||
    !validEntryPath(version.entry_path) ||
    typeof version.spa_fallback !== "boolean"
  ) {
    return failClaim(input.client, identity, "INVALID_MANIFEST", false);
  }

  emitAwsPublicationEvent("publication_started", {
    projectId: claim.projectId,
    versionId: claim.versionId,
    attempt: claim.attemptCount,
    generation: claim.routingGeneration,
  });

  const fileResult = await input.client
    .from("project_published_files")
    .select("path,content,content_type,sha256,size_bytes")
    .eq("version_id", claim.versionId)
    .order("path", { ascending: true });
  if (fileResult.error) {
    return failClaim(input.client, identity, "PUBLICATION_FAILED", true);
  }
  const rows = fileResult.data as PublicationFile[] | null;
  if (!Array.isArray(rows) || rows.length !== version.file_count) {
    return failClaim(input.client, identity, "INVALID_MANIFEST", false);
  }
  if (
    rows.some(
      (row) =>
        typeof row.path !== "string" ||
        typeof row.content !== "string" ||
        typeof row.content_type !== "string" ||
        typeof row.sha256 !== "string" ||
        typeof row.size_bytes !== "number",
    )
  ) {
    return failClaim(input.client, identity, "INVALID_MANIFEST", false);
  }

  const prepared = preparePublishedFiles(
    rows.map((row) => ({ path: row.path, content: row.content })),
    contentTypeForPath,
  );
  if (prepared.ok === false) {
    return failClaim(input.client, identity, "INVALID_MANIFEST", false);
  }
  const preparedFiles = prepared.data;
  if (
    preparedFiles.contentHash !== version.content_hash ||
    preparedFiles.fileCount !== version.file_count ||
    preparedFiles.byteCount !== Number(version.byte_count) ||
    rows.some((row, index) => {
      const expected = preparedFiles.rows[index];
      return (
        row.content_type !== expected.contentType ||
        row.sha256 !== expected.sha256 ||
        row.size_bytes !== expected.sizeBytes
      );
    }) ||
    !rows.some((row) => row.path === version.entry_path)
  ) {
    return failClaim(input.client, identity, "INVALID_MANIFEST", false);
  }

  const files = rows.map((row) => ({
    path: row.path,
    content: row.content,
    contentType: row.content_type,
  }));
  const leaseGuard = startPublicationLeaseGuard(input.client, identity, claim.projectId);
  let published: S3PublicationOutcome;
  try {
    leaseGuard.assert();
    published = await publishToS3(claim.projectId, claim.versionId, files, {
      abortSignal: leaseGuard.abortSignal,
      assertLease: leaseGuard.assert,
    });
    leaseGuard.assert();
  } catch (error) {
    leaseGuard.stop();
    if (error instanceof AwsPublicationLeaseLostError) {
      return { status: "error", versionId: claim.versionId, reason: "lease_lost_during_s3" };
    }
    return failClaim(input.client, identity, "S3_UPLOAD_FAILED", true);
  }
  if (published.ok === false) {
    leaseGuard.stop();
    return failClaim(
      input.client,
      identity,
      published.code,
      published.code === "S3_UPLOAD_FAILED",
    );
  }
  emitAwsPublicationEvent("s3_upload_completed", {
    projectId: claim.projectId,
    versionId: claim.versionId,
    uploadedCount: published.uploadedCount,
    failedCount: 0,
    totalBytes: published.totalBytes,
    durationMs: published.durationMs,
  });
  let verified = false;
  try {
    verified =
      published.manifestHash === version.content_hash &&
      (await verifyS3Publication(
        claim.projectId,
        claim.versionId,
        files,
        version.content_hash,
        {
          abortSignal: leaseGuard.abortSignal,
          assertLease: leaseGuard.assert,
        },
      ));
    leaseGuard.assert();
  } catch (error) {
    leaseGuard.stop();
    if (error instanceof AwsPublicationLeaseLostError) {
      return { status: "error", versionId: claim.versionId, reason: "lease_lost_during_s3" };
    }
    return failClaim(input.client, identity, "S3_UPLOAD_FAILED", true);
  }
  leaseGuard.stop();
  if (!verified) return failClaim(input.client, identity, "S3_UPLOAD_FAILED", true);
  emitAwsPublicationEvent("s3_verification_completed", {
    projectId: claim.projectId,
    versionId: claim.versionId,
    uploadedCount: files.length,
    totalBytes: published.totalBytes,
  });

  const renewed = await renewAwsFrontendPublication(input.client, identity);
  if (renewed.ok === false || !renewed.data) {
    emitAwsPublicationEvent("lease_lost", {
      projectId: claim.projectId,
      versionId: claim.versionId,
      reason: "lease_lost_before_activation",
    });
    return { status: "error", versionId: claim.versionId, reason: "lease_lost_before_activation" };
  }
  const hostname = mavlyHostname(claim.projectId);
  if (!hostname) {
    return failClaim(input.client, identity, "INVALID_MANIFEST", false);
  }

  try {
    const authorized = await authorizeAwsFrontendRouteActivation(input.client, {
      projectId: claim.projectId,
      versionId: claim.versionId,
      leaseToken: identity.leaseToken,
      routingGeneration: claim.routingGeneration,
    });
    if (authorized.ok === false || !authorized.data) {
      emitAwsPublicationEvent("lease_lost", {
        projectId: claim.projectId,
        versionId: claim.versionId,
        reason: "lease_lost_before_activation",
      });
      return { status: "error", versionId: claim.versionId, reason: "lease_lost_before_activation" };
    }
    await activateAwsTenantMapping({
      projectId: claim.projectId,
      versionId: claim.versionId,
      entryPath: version.entry_path,
      spaFallback: version.spa_fallback,
      generation: claim.routingGeneration,
    });
  } catch {
    const restored = await restoreActiveTenantRoute(
      input.client,
      claim.projectId,
      claim.versionId,
      identity.leaseToken,
      claim.routingGeneration,
    );
    if (restored === "failed") {
      emitAwsPublicationEvent("route_recovery_failed", {
        projectId: claim.projectId,
        versionId: claim.versionId,
        reason: "activation_failed",
      });
      return { status: "error", versionId: claim.versionId, reason: "route_recovery_failed" };
    }
    emitAwsPublicationEvent("publication_retry", {
      projectId: claim.projectId,
      versionId: claim.versionId,
      code: "KEY_VALUE_STORE_FAILED",
      status: restored,
    });
    return failClaim(input.client, identity, "KEY_VALUE_STORE_FAILED", true);
  }

  emitAwsPublicationEvent("kvs_activation_completed", {
    projectId: claim.projectId,
    versionId: claim.versionId,
    generation: claim.routingGeneration,
  });

  const routeReady = await verifyAwsTenantRoute({
    projectId: claim.projectId,
    versionId: claim.versionId,
    hostname,
  });
  if (!routeReady) {
    const restored = await restoreActiveTenantRoute(
      input.client,
      claim.projectId,
      claim.versionId,
      identity.leaseToken,
      claim.routingGeneration,
    );
    if (restored === "failed") {
      emitAwsPublicationEvent("route_recovery_failed", {
        projectId: claim.projectId,
        versionId: claim.versionId,
        reason: "route_verification_failed",
      });
      return { status: "error", versionId: claim.versionId, reason: "route_recovery_failed" };
    }
    return failClaim(input.client, identity, "KEY_VALUE_STORE_FAILED", true);
  }

  const completed = await completeAwsFrontendPublication(input.client, identity);
  if (completed.ok === false) {
    const restored = await restoreActiveTenantRoute(
      input.client,
      claim.projectId,
      claim.versionId,
      identity.leaseToken,
      claim.routingGeneration,
    );
    if (restored === "already_active") {
      return { status: "completed", versionId: claim.versionId };
    }
    if (restored === "failed") {
      emitAwsPublicationEvent("route_recovery_failed", {
        projectId: claim.projectId,
        versionId: claim.versionId,
        reason: "completion_failed",
      });
      return { status: "error", versionId: claim.versionId, reason: "route_recovery_failed" };
    }
    console.error("[aws-publication] activation persistence failed:", completed.code);
    return failClaim(input.client, identity, "PUBLICATION_ACTIVATION_FAILED", true);
  }

  emitAwsPublicationEvent("publication_completed", {
    projectId: claim.projectId,
    versionId: claim.versionId,
    generation: claim.routingGeneration,
  });
  return { status: "completed", versionId: claim.versionId };
}
