import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isMissingDatabaseObject } from "@/lib/hosting/migration-requirement";

export type AwsPublicationStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string };

function failure(code: string | undefined, error: string): AwsPublicationStoreResult<never> {
  if (isMissingDatabaseObject({ code, message: error })) {
    return {
      ok: false,
      code: "MIGRATION_REQUIRED",
      error: "Apply migration 51_aws_frontend_deployment.sql before enabling AWS hosting.",
    };
  }
  const message = error.toLowerCase();
  if (
    message.includes("aws_frontend_hosting_schema_version") ||
    message.includes("enqueue_aws_frontend") ||
    message.includes("claim_aws_frontend")
  ) {
    return {
      ok: false,
      code: "MIGRATION_REQUIRED",
      error: "Apply migration 51_aws_frontend_deployment.sql before enabling AWS hosting.",
    };
  }
  if (
    message.includes("aws_frontend_fencing_schema_version") ||
    message.includes("authorize_aws_frontend_route_restore") ||
    message.includes("authorize_aws_frontend_route_activation")
  ) {
    return {
      ok: false,
      code: "MIGRATION_REQUIRED",
      error:
        "Apply migration 56_aws_frontend_fencing_and_status.sql before enabling AWS hosting.",
    };
  }
  return { ok: false, code: code ?? "DATABASE_ERROR", error };
}

export async function readAwsFrontendSchemaVersion(
  client?: SupabaseClient,
): Promise<AwsPublicationStoreResult<number>> {
  const supabase = client ?? (await createSupabaseServerClient());
  if (!supabase) {
    return { ok: false, code: "UNAVAILABLE", error: "Supabase is not configured." };
  }
  const { data, error } = await supabase.rpc("aws_frontend_hosting_schema_version");
  if (error) return failure(error.code, error.message);
  const version = typeof data === "number" ? data : Number(data);
  return Number.isSafeInteger(version)
    ? { ok: true, data: version }
    : { ok: false, code: "DATABASE_ERROR", error: "AWS schema marker is invalid." };
}

export async function readAwsFrontendFencingSchemaVersion(
  client?: SupabaseClient,
): Promise<AwsPublicationStoreResult<number>> {
  const supabase = client ?? (await createSupabaseServerClient());
  if (!supabase) {
    return { ok: false, code: "UNAVAILABLE", error: "Supabase is not configured." };
  }
  const { data, error } = await supabase.rpc("aws_frontend_fencing_schema_version");
  if (error) return failure(error.code, error.message);
  const version = typeof data === "number" ? data : Number(data);
  return Number.isSafeInteger(version)
    ? { ok: true, data: version }
    : { ok: false, code: "DATABASE_ERROR", error: "AWS fencing schema marker is invalid." };
}

export async function enqueueAwsFrontendPublication(input: {
  projectId: string;
  versionId: string;
}): Promise<AwsPublicationStoreResult<string>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, code: "UNAVAILABLE", error: "Supabase is not configured." };
  }
  const { data, error } = await supabase.rpc("enqueue_aws_frontend_publication", {
    p_project_id: input.projectId,
    p_version_id: input.versionId,
  });
  if (error) return failure(error.code, error.message);
  if (typeof data !== "string" || data !== input.versionId) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: "Supabase did not confirm the publication queue record.",
    };
  }
  return { ok: true, data };
}

export async function enqueueAwsFrontendUnpublish(input: {
  projectId: string;
  leaseUpdatedAt: string;
}): Promise<AwsPublicationStoreResult<void>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, code: "UNAVAILABLE", error: "Supabase is not configured." };
  }
  const { data, error } = await supabase.rpc("enqueue_aws_frontend_unpublish", {
    p_project_id: input.projectId,
    p_lease_updated_at: input.leaseUpdatedAt,
  });
  if (error) return failure(error.code, error.message);
  if (data !== true) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: "Supabase did not confirm the AWS unpublish queue record.",
    };
  }
  return { ok: true, data: undefined };
}

export async function claimAwsFrontendPublication(
  client: SupabaseClient,
): Promise<
  | { status: "empty" }
  | {
      status: "claimed";
      projectId: string;
      versionId: string;
      ownerId: string;
      leaseToken: string;
      attemptCount: number;
      routingGeneration: number;
    }
  | { status: "error"; code: string; error: string }
> {
  const { data, error } = await client.rpc("claim_aws_frontend_publication");
  if (error) return { status: "error", code: error.code ?? "DATABASE_ERROR", error: error.message };
  if (!Array.isArray(data) || data.length === 0) return { status: "empty" };
  const row = data[0] as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.project_id !== "string" ||
    typeof row.version_id !== "string" ||
    typeof row.owner_id !== "string" ||
    typeof row.lease_token !== "string" ||
    typeof row.attempt_count !== "number" ||
    !Number.isInteger(row.attempt_count) ||
    row.attempt_count < 1 ||
    row.attempt_count > 8 ||
    typeof row.routing_generation !== "number" ||
    !Number.isSafeInteger(row.routing_generation) ||
    row.routing_generation < 1
  ) {
    return {
      status: "error",
      code: "INVALID_CLAIM",
      error: "The AWS publication claim response was invalid.",
    };
  }
  return {
    status: "claimed",
    projectId: row.project_id,
    versionId: row.version_id,
    ownerId: row.owner_id,
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
    routingGeneration: row.routing_generation,
  };
}

export async function claimAwsFrontendUnpublish(
  client: SupabaseClient,
): Promise<
  | { status: "empty" }
  | {
      status: "claimed";
      projectId: string;
      ownerId: string;
      leaseToken: string;
      attemptCount: number;
      routingGeneration: number;
    }
  | { status: "error"; code: string; error: string }
> {
  const { data, error } = await client.rpc("claim_aws_frontend_unpublish");
  if (error) {
    return {
      status: "error",
      code: error.code ?? "DATABASE_ERROR",
      error: error.message,
    };
  }
  if (!Array.isArray(data) || data.length === 0) return { status: "empty" };
  const row = data[0] as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.project_id !== "string" ||
    typeof row.owner_id !== "string" ||
    typeof row.lease_token !== "string" ||
    typeof row.attempt_count !== "number" ||
    !Number.isInteger(row.attempt_count) ||
    row.attempt_count < 1 ||
    row.attempt_count > 8 ||
    typeof row.routing_generation !== "number" ||
    !Number.isSafeInteger(row.routing_generation) ||
    row.routing_generation < 1
  ) {
    return {
      status: "error",
      code: "INVALID_CLAIM",
      error: "The AWS unpublish claim response was invalid.",
    };
  }
  return {
    status: "claimed",
    projectId: row.project_id,
    ownerId: row.owner_id,
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
    routingGeneration: row.routing_generation,
  };
}

export async function failAwsFrontendUnpublish(
  client: SupabaseClient,
  input: {
    projectId: string;
    leaseToken: string;
    retryable: boolean;
  },
): Promise<AwsPublicationStoreResult<"retry_wait" | "failed">> {
  const { data, error } = await client.rpc("fail_aws_frontend_unpublish", {
    p_project_id: input.projectId,
    p_lease_token: input.leaseToken,
    p_retryable: input.retryable,
  });
  if (error) return failure(error.code, error.message);
  if (data !== "retry_wait" && data !== "failed") {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: "Supabase did not confirm the AWS unpublish failure state.",
    };
  }
  return { ok: true, data };
}

export async function completeAwsFrontendUnpublish(
  client: SupabaseClient,
  input: { projectId: string; leaseToken: string },
): Promise<AwsPublicationStoreResult<void>> {
  const { error } = await client.rpc("complete_aws_frontend_unpublish", {
    p_project_id: input.projectId,
    p_lease_token: input.leaseToken,
  });
  return error
    ? failure(error.code, error.message)
    : { ok: true, data: undefined };
}

export async function failAwsFrontendPublication(
  client: SupabaseClient,
  input: {
    versionId: string;
    leaseToken: string;
    code: string;
    retryable: boolean;
  },
): Promise<AwsPublicationStoreResult<"retry_wait" | "failed">> {
  const { data, error } = await client.rpc("fail_aws_frontend_publication", {
    p_version_id: input.versionId,
    p_lease_token: input.leaseToken,
    p_error_code: input.code,
    p_retryable: input.retryable,
  });
  if (error) return failure(error.code, error.message);
  if (data !== "retry_wait" && data !== "failed") {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: "Supabase did not confirm the AWS publication failure state.",
    };
  }
  return { ok: true, data };
}

export async function renewAwsFrontendPublication(
  client: SupabaseClient,
  input: { versionId: string; leaseToken: string },
): Promise<AwsPublicationStoreResult<boolean>> {
  const { data, error } = await client.rpc("renew_aws_frontend_publication", {
    p_version_id: input.versionId,
    p_lease_token: input.leaseToken,
  });
  if (error) return failure(error.code, error.message);
  if (typeof data !== "boolean") {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: "Supabase did not confirm the AWS publication lease.",
    };
  }
  return { ok: true, data };
}

export async function authorizeAwsFrontendRouteRestore(
  client: SupabaseClient,
  input: {
    projectId: string;
    versionId: string;
    leaseToken: string;
    routingGeneration: number;
    expectedActiveVersionId: string | null;
  },
): Promise<AwsPublicationStoreResult<boolean>> {
  const { data, error } = await client.rpc("authorize_aws_frontend_route_restore", {
    p_project_id: input.projectId,
    p_version_id: input.versionId,
    p_lease_token: input.leaseToken,
    p_routing_generation: input.routingGeneration,
    p_expected_active_version_id: input.expectedActiveVersionId,
  });
  if (error) return failure(error.code, error.message);
  if (typeof data !== "boolean") {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: "Supabase did not confirm AWS route-restore ownership.",
    };
  }
  return { ok: true, data };
}

export async function authorizeAwsFrontendRouteActivation(
  client: SupabaseClient,
  input: {
    projectId: string;
    versionId: string;
    leaseToken: string;
    routingGeneration: number;
  },
): Promise<AwsPublicationStoreResult<boolean>> {
  const { data, error } = await client.rpc("authorize_aws_frontend_route_activation", {
    p_project_id: input.projectId,
    p_version_id: input.versionId,
    p_lease_token: input.leaseToken,
    p_routing_generation: input.routingGeneration,
  });
  if (error) return failure(error.code, error.message);
  if (typeof data !== "boolean") {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: "Supabase did not confirm AWS route-activation ownership.",
    };
  }
  return { ok: true, data };
}

export async function completeAwsFrontendPublication(
  client: SupabaseClient,
  input: { versionId: string; leaseToken: string },
): Promise<AwsPublicationStoreResult<void>> {
  const { error } = await client.rpc("complete_aws_frontend_publication", {
    p_version_id: input.versionId,
    p_lease_token: input.leaseToken,
  });
  return error
    ? failure(error.code, error.message)
    : { ok: true, data: undefined };
}
