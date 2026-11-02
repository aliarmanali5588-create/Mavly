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
  readAwsFrontendSchemaVersion,
  renewAwsFrontendPublication,
} from "./publication-store";
import {
  activateAwsTenantMapping,
  removeAwsTenantMapping,
  restoreAwsTenantMapping,
  verifyAwsTenantRoute,
  verifyAwsPublicTenantRouteRemoved,
} from "./tenant-mapping";
import { publishToS3, verifyS3Publication } from "./s3-publisher";

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
      await removeAwsTenantMapping(projectId, generation);
      return "restored";
    } catch {
      return "failed";
    }
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
    await restoreAwsTenantMapping({
      projectId,
      versionId: activeVersionId,
      entryPath: version.data.entry_path,
      spaFallback: version.data.spa_fallback,
      generation,
    });
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
    return { status: "error", versionId: claim.versionId, reason: "outcome_persistence_failed" };
  }
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
    return {
      status: "error",
      projectId: claim.projectId,
      reason: "outcome_persistence_failed",
    };
  }
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

  const unpublishClaim = await claimAwsFrontendUnpublish(input.client);
  if (unpublishClaim.status === "error") {
    console.error("[aws-publication] unpublish claim failed:", unpublishClaim.code);
    return { status: "error", reason: "unpublish_claim_failed" };
  }
  if (unpublishClaim.status === "claimed") {
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
  const published = await publishToS3(claim.projectId, claim.versionId, files);
  if (published.ok === false) {
    return failClaim(
      input.client,
      identity,
      published.code,
      published.code === "S3_UPLOAD_FAILED",
    );
  }
  if (
    published.manifestHash !== version.content_hash ||
    !(await verifyS3Publication(
      claim.projectId,
      claim.versionId,
      files,
      version.content_hash,
    ))
  ) {
    return failClaim(input.client, identity, "S3_UPLOAD_FAILED", true);
  }

  const renewed = await renewAwsFrontendPublication(input.client, identity);
  if (renewed.ok === false || !renewed.data) {
    return { status: "error", versionId: claim.versionId, reason: "lease_lost_before_activation" };
  }
  const hostname = mavlyHostname(claim.projectId);
  if (!hostname) {
    return failClaim(input.client, identity, "INVALID_MANIFEST", false);
  }

  try {
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
    );
    if (restored === "failed") {
      return { status: "error", versionId: claim.versionId, reason: "route_recovery_failed" };
    }
    return failClaim(input.client, identity, "KEY_VALUE_STORE_FAILED", true);
  }

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
    );
    if (restored === "failed") {
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
    );
    if (restored === "already_active") {
      return { status: "completed", versionId: claim.versionId };
    }
    if (restored === "failed") {
      return { status: "error", versionId: claim.versionId, reason: "route_recovery_failed" };
    }
    console.error("[aws-publication] activation persistence failed:", completed.code);
    return failClaim(input.client, identity, "PUBLICATION_ACTIVATION_FAILED", true);
  }

  return { status: "completed", versionId: claim.versionId };
}
