import { createHash } from "node:crypto";
import type { ManagedBackendConfig } from "./config";

const NEON_API_ORIGIN = "https://console.neon.tech/api/v2";
const API_TIMEOUT_MS = 12_000;
const DATABASE_NAME = "mavly_app";
const ROLE_NAME = "mavly_app_owner";

interface NeonProject {
  id: string;
  name: string;
  org_id: string;
  region_id: string;
}

export type NeonFailureCode =
  | "provider_auth"
  | "provider_rejected"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_error"
  | "provisioning_outcome_unknown"
  | "project_name_ambiguous"
  | "connection_uri_invalid";

export interface NeonFailure {
  ok: false;
  code: NeonFailureCode;
  outcomeUnknown: boolean;
}

export type NeonResult<T> = { ok: true; data: T } | NeonFailure;

type Fetcher = typeof fetch;

function providerFailure(
  code: NeonFailureCode,
  outcomeUnknown = false,
): NeonFailure {
  return { ok: false, code, outcomeUnknown };
}

function errorCodeForStatus(status: number): NeonFailureCode {
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 429) return "provider_rate_limited";
  if (status === 423 || status === 503) return "provider_unavailable";
  if (status >= 400 && status < 500) return "provider_rejected";
  return "provider_error";
}

async function requestJson(
  config: ManagedBackendConfig,
  fetcher: Fetcher,
  path: string,
  init: RequestInit,
): Promise<NeonResult<unknown>> {
  if (!config.apiKey) return providerFailure("provider_auth");

  let response: Response;
  try {
    response = await fetcher(`${NEON_API_ORIGIN}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    return providerFailure(
      init.method === "POST" ? "provisioning_outcome_unknown" : "provider_unavailable",
      init.method === "POST",
    );
  }

  if (!response.ok) {
    const code = errorCodeForStatus(response.status);
    const ambiguous =
      init.method === "POST" &&
      ![400, 401, 403, 404, 422, 423, 503].includes(response.status);
    return providerFailure(
      ambiguous ? "provisioning_outcome_unknown" : code,
      ambiguous,
    );
  }

  try {
    return { ok: true, data: await response.json() as unknown };
  } catch {
    return providerFailure(
      init.method === "POST" ? "provisioning_outcome_unknown" : "provider_error",
      init.method === "POST",
    );
  }
}

function projectFrom(value: unknown): NeonProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(record.id) ||
    typeof record.name !== "string" ||
    typeof record.org_id !== "string" ||
    typeof record.region_id !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    org_id: record.org_id,
    region_id: record.region_id,
  };
}

function connectionUriFrom(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.uri !== "string") return null;

  try {
    const uri = new URL(record.uri);
    if (
      (uri.protocol !== "postgres:" && uri.protocol !== "postgresql:") ||
      !uri.hostname.toLowerCase().endsWith(".neon.tech") ||
      !uri.username ||
      !uri.password ||
      uri.searchParams.get("sslmode") !== "require"
    ) {
      return null;
    }
    return record.uri;
  } catch {
    return null;
  }
}

export function neonProjectName(
  userId: string,
  projectId: string,
  registryId: string,
): string {
  const suffix = createHash("sha256")
    .update(`${userId}\u0000${projectId}\u0000${registryId}`)
    .digest("hex")
    .slice(0, 20);
  return `mavly-${suffix}`;
}

export async function findNeonProject(
  config: ManagedBackendConfig,
  name: string,
  fetcher: Fetcher = fetch,
): Promise<NeonResult<NeonProject | null>> {
  const exact: NeonProject[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams({
      org_id: config.orgId ?? "",
      search: name,
      limit: "400",
    });
    if (cursor) params.set("cursor", cursor);
    const result = await requestJson(config, fetcher, `/projects?${params}`, {
      method: "GET",
    });
    if (result.ok === false) return result;

    const record = result.data as Record<string, unknown> | null;
    const projects =
      record && Array.isArray(record.projects) ? record.projects : null;
    if (!projects) return providerFailure("provider_error");
    const unavailable = record?.unavailable;
    if (Array.isArray(unavailable) && unavailable.length > 0) {
      return providerFailure("provider_unavailable");
    }

    for (const candidate of projects) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        (candidate as Record<string, unknown>).name !== name
      ) {
        continue;
      }
      const project = projectFrom(candidate);
      if (!project) return providerFailure("provider_error");
      exact.push(project);
    }

    const pagination = record?.pagination;
    const nextCursor =
      pagination &&
      typeof pagination === "object" &&
      !Array.isArray(pagination) &&
      typeof (pagination as Record<string, unknown>).cursor === "string"
        ? (pagination as Record<string, string>).cursor
        : null;
    if (!nextCursor) {
      cursor = null;
      break;
    }
    cursor = nextCursor;
  }
  if (cursor) return providerFailure("provider_error");
  if (exact.length > 1) return providerFailure("project_name_ambiguous");
  const project = exact[0];
  if (!project) return { ok: true, data: null };
  if (
    project.org_id !== config.orgId ||
    project.region_id !== config.regionId
  ) {
    return providerFailure("provider_rejected");
  }
  return { ok: true, data: project };
}

export async function createNeonProject(
  config: ManagedBackendConfig,
  name: string,
  fetcher: Fetcher = fetch,
): Promise<NeonResult<NeonProject>> {
  const result = await requestJson(config, fetcher, "/projects", {
    method: "POST",
    body: JSON.stringify({
      project: {
        name,
        org_id: config.orgId,
        region_id: config.regionId,
        pg_version: 17,
        branch: {
          database_name: DATABASE_NAME,
          role_name: ROLE_NAME,
        },
        settings: {
          quota: {
            active_time_seconds: 360_000,
            logical_size_bytes: 1_073_741_824,
            data_transfer_bytes: 5_368_709_120,
          },
        },
        default_endpoint_settings: {
          autoscaling_limit_min_cu: 0.25,
          autoscaling_limit_max_cu: 2,
        },
      },
    }),
  });
  if (result.ok === false) return result;

  const record = result.data as Record<string, unknown> | null;
  const project = projectFrom(record?.project);
  if (
    !project ||
    project.name !== name ||
    project.org_id !== config.orgId ||
    project.region_id !== config.regionId
  ) {
    return providerFailure("provisioning_outcome_unknown", true);
  }
  return { ok: true, data: project };
}

export async function getNeonConnectionUri(
  config: ManagedBackendConfig,
  projectId: string,
  fetcher: Fetcher = fetch,
): Promise<NeonResult<string>> {
  const query = new URLSearchParams({
    database_name: DATABASE_NAME,
    role_name: ROLE_NAME,
    pooled: "true",
  });
  const result = await requestJson(
    config,
    fetcher,
    `/projects/${encodeURIComponent(projectId)}/connection_uri?${query}`,
    { method: "GET" },
  );
  if (result.ok === false) return result;
  const uri = connectionUriFrom(result.data);
  return uri
    ? { ok: true, data: uri }
    : providerFailure("connection_uri_invalid");
}
