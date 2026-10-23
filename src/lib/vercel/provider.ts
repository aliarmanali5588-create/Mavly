/**
 * Minimal, server-only Vercel REST client for Mavly-managed deployments.
 *
 * ⚠️ THE ORIGIN IS CONSTANT. No function here accepts a URL from a request. The
 * only values that vary are a server-derived project name, a server-stored
 * deployment id, and the fixed API paths below.
 *
 * API references (checked 2026-10-22):
 *   POST /v11/projects             create the tenant project
 *   POST /v2/files                 upload one file by SHA-1 digest
 *   POST /v13/deployments          create a production deployment
 *   GET  /v13/deployments/{id}     read build state
 *   GET  /v9/projects/{idOrName}   recover a project after a partial failure
 *   DELETE /v9/projects/{idOrName} remove the tenant project
 *   POST /v10/projects/{idOrName}/domains             attach a project domain
 *   GET  /v9/projects/{idOrName}/domains/{domain}     read its verification state
 *   POST /v9/projects/{idOrName}/domains/{domain}/verify  ask Vercel to verify it
 */

import { createHash } from "node:crypto";
import type { VercelDeploymentConfig } from "./config";

const API_ORIGIN = "https://api.vercel.com";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ERROR_MESSAGE = 500;

export interface VercelFailure {
  /** HTTP status, or 0 for a transport/timeout failure. */
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export type VercelResult<T> = { ok: true; data: T } | { ok: false; failure: VercelFailure };

export function isVercelFailure<T>(result: VercelResult<T>): result is { ok: false; failure: VercelFailure } {
  return result.ok === false;
}

export interface VercelProject {
  id: string;
  name: string;
}

export interface VercelProjectDomainVerification {
  type: string;
  domain: string;
  value: string;
  reason: string;
}

export interface VercelProjectDomain {
  name: string;
  verified: boolean;
  verification: VercelProjectDomainVerification[];
}

export interface VercelDeployment {
  id: string;
  url: string | null;
  readyState: string;
  alias: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

export interface VercelUploadedFile {
  file: string;
  sha: string;
  size: number;
}

interface RawResponse {
  status: number;
  text: string;
  retryAfter: number | null;
}

function apiUrl(config: VercelDeploymentConfig, path: string): URL {
  const url = new URL(path, API_ORIGIN);
  if (config.teamId) url.searchParams.set("teamId", config.teamId);
  return url;
}

async function rawRequest(
  config: VercelDeploymentConfig,
  path: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<VercelResult<RawResponse>> {
  try {
    const response = await fetch(apiUrl(config, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    const retryAfterRaw = Number(response.headers.get("retry-after"));
    return {
      ok: true,
      data: {
        status: response.status,
        text,
        retryAfter: Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw : null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      failure: {
        status: 0,
        code: "network_error",
        message: message.slice(0, MAX_ERROR_MESSAGE),
      },
    };
  }
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bodyRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function failureFrom(raw: RawResponse): VercelFailure {
  const body = bodyRecord(parseBody(raw.text));
  const nested = body ? bodyRecord(body.error) : null;

  const code =
    stringOf(nested?.code) ??
    stringOf(body?.errorCode) ??
    stringOf(body?.code) ??
    `http_${raw.status}`;
  const message =
    stringOf(nested?.message) ??
    stringOf(body?.errorMessage) ??
    stringOf(body?.message) ??
    raw.text.slice(0, MAX_ERROR_MESSAGE) ??
    "";

  return {
    status: raw.status,
    code,
    message: (message || `Vercel returned HTTP ${raw.status}.`).slice(0, MAX_ERROR_MESSAGE),
    ...(raw.retryAfter ? { retryAfterSeconds: raw.retryAfter } : {}),
  };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function projectFrom(value: unknown, fallbackName: string): VercelProject | null {
  const record = bodyRecord(value);
  if (!record) return null;
  const id = stringOf(record.id);
  const name = stringOf(record.name) ?? fallbackName;
  return id ? { id, name } : null;
}

function projectDomainFrom(value: unknown, fallbackName?: string): VercelProjectDomain | null {
  const outer = bodyRecord(value);
  if (!outer) return null;
  const record = bodyRecord(outer.domain) ?? outer;
  const name = stringOf(record.name) ?? fallbackName;
  if (!name) return null;

  const verification = Array.isArray(record.verification)
    ? record.verification.flatMap((entry): VercelProjectDomainVerification[] => {
        const item = bodyRecord(entry);
        if (!item) return [];
        return [{
          type: stringOf(item.type) ?? "",
          domain: stringOf(item.domain) ?? "",
          value: stringOf(item.value) ?? "",
          reason: stringOf(item.reason) ?? "",
        }];
      })
    : [];

  return {
    name,
    verified: record.verified === true,
    verification,
  };
}

function deploymentFrom(value: unknown): VercelDeployment | null {
  const record = bodyRecord(value);
  if (!record) return null;
  const id = stringOf(record.id);
  if (!id) return null;

  const alias = Array.isArray(record.alias)
    ? record.alias.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    id,
    url: stringOf(record.url),
    readyState: stringOf(record.readyState) ?? stringOf(record.status) ?? "QUEUED",
    alias,
    errorCode: stringOf(record.errorCode),
    errorMessage: stringOf(record.errorMessage),
  };
}

export async function createVercelProject(
  config: VercelDeploymentConfig,
  name: string,
): Promise<VercelResult<VercelProject>> {
  const raw = await rawRequest(
    config,
    "/v11/projects",
    jsonInit("POST", { name, framework: null }),
  );
  if (isVercelFailure(raw)) return raw;
  if (!isSuccess(raw.data.status)) return { ok: false, failure: failureFrom(raw.data) };

  const project = projectFrom(parseBody(raw.data.text), name);
  if (!project) {
    return {
      ok: false,
      failure: { status: 502, code: "invalid_response", message: "Vercel did not return a project id." },
    };
  }
  return { ok: true, data: project };
}

export async function getVercelProject(
  config: VercelDeploymentConfig,
  idOrName: string,
): Promise<VercelResult<VercelProject>> {
  const raw = await rawRequest(
    config,
    `/v9/projects/${encodeURIComponent(idOrName)}`,
    { method: "GET" },
  );
  if (isVercelFailure(raw)) return raw;
  if (!isSuccess(raw.data.status)) return { ok: false, failure: failureFrom(raw.data) };

  const project = projectFrom(parseBody(raw.data.text), idOrName);
  if (!project) {
    return {
      ok: false,
      failure: { status: 502, code: "invalid_response", message: "Vercel did not return a project id." },
    };
  }
  return { ok: true, data: project };
}

export async function addVercelProjectDomain(
  config: VercelDeploymentConfig,
  idOrName: string,
  domain: string,
): Promise<VercelResult<VercelProjectDomain>> {
  const raw = await rawRequest(
    config,
    `/v10/projects/${encodeURIComponent(idOrName)}/domains`,
    jsonInit("POST", { name: domain }),
  );
  if (isVercelFailure(raw)) return raw;
  if (!isSuccess(raw.data.status)) return { ok: false, failure: failureFrom(raw.data) };

  const parsed = projectDomainFrom(parseBody(raw.data.text), domain);
  if (!parsed) {
    return {
      ok: false,
      failure: { status: 502, code: "invalid_response", message: "Vercel did not return the assigned domain." },
    };
  }
  return { ok: true, data: parsed };
}

export async function getVercelProjectDomain(
  config: VercelDeploymentConfig,
  idOrName: string,
  domain: string,
): Promise<VercelResult<VercelProjectDomain>> {
  const raw = await rawRequest(
    config,
    `/v9/projects/${encodeURIComponent(idOrName)}/domains/${encodeURIComponent(domain)}`,
    { method: "GET" },
  );
  if (isVercelFailure(raw)) return raw;
  if (!isSuccess(raw.data.status)) return { ok: false, failure: failureFrom(raw.data) };

  const parsed = projectDomainFrom(parseBody(raw.data.text), domain);
  if (!parsed) {
    return {
      ok: false,
      failure: { status: 502, code: "invalid_response", message: "Vercel did not return the domain state." },
    };
  }
  return { ok: true, data: parsed };
}

export async function verifyVercelProjectDomain(
  config: VercelDeploymentConfig,
  idOrName: string,
  domain: string,
): Promise<VercelResult<VercelProjectDomain>> {
  const raw = await rawRequest(
    config,
    `/v9/projects/${encodeURIComponent(idOrName)}/domains/${encodeURIComponent(domain)}/verify`,
    { method: "POST" },
  );
  if (isVercelFailure(raw)) return raw;
  if (!isSuccess(raw.data.status)) return { ok: false, failure: failureFrom(raw.data) };

  const parsed = projectDomainFrom(parseBody(raw.data.text), domain);
  if (!parsed) {
    return {
      ok: false,
      failure: { status: 502, code: "invalid_response", message: "Vercel did not return the domain state." },
    };
  }
  return { ok: true, data: parsed };
}

/** Best-effort cleanup. A project that is already gone counts as success. */
export async function deleteVercelProject(
  config: VercelDeploymentConfig,
  idOrName: string,
): Promise<VercelResult<void>> {
  const raw = await rawRequest(
    config,
    `/v9/projects/${encodeURIComponent(idOrName)}`,
    { method: "DELETE" },
  );
  if (isVercelFailure(raw)) return raw;
  if (raw.data.status === 404) return { ok: true, data: undefined };
  if (!isSuccess(raw.data.status)) return { ok: false, failure: failureFrom(raw.data) };
  return { ok: true, data: undefined };
}

export async function uploadDeploymentFile(
  config: VercelDeploymentConfig,
  file: string,
  content: string,
): Promise<VercelResult<VercelUploadedFile>> {
  const bytes = Buffer.from(content, "utf8");
  const digest = createHash("sha1").update(bytes).digest("hex");

  const raw = await rawRequest(config, "/v2/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "x-vercel-digest": digest,
    },
    body: bytes,
  });
  if (isVercelFailure(raw)) return raw;
  if (!isSuccess(raw.data.status)) return { ok: false, failure: failureFrom(raw.data) };

  return { ok: true, data: { file, sha: digest, size: bytes.byteLength } };
}

export async function createVercelDeployment(
  config: VercelDeploymentConfig,
  input: {
    name: string;
    project: string;
    files: readonly VercelUploadedFile[];
  },
): Promise<VercelResult<VercelDeployment>> {
  const raw = await rawRequest(
    config,
    "/v13/deployments?forceNew=1",
    jsonInit("POST", {
      name: input.name,
      project: input.project,
      files: input.files.map((file) => ({ file: file.file, sha: file.sha, size: file.size })),
      target: "production",
      projectSettings: { framework: null },
    }),
  );
  if (isVercelFailure(raw)) return raw;
  if (!isSuccess(raw.data.status)) return { ok: false, failure: failureFrom(raw.data) };

  const deployment = deploymentFrom(parseBody(raw.data.text));
  if (!deployment) {
    return {
      ok: false,
      failure: { status: 502, code: "invalid_response", message: "Vercel did not return a deployment id." },
    };
  }
  return { ok: true, data: deployment };
}

export async function getVercelDeployment(
  config: VercelDeploymentConfig,
  deploymentId: string,
): Promise<VercelResult<VercelDeployment>> {
  const raw = await rawRequest(
    config,
    `/v13/deployments/${encodeURIComponent(deploymentId)}`,
    { method: "GET" },
  );
  if (isVercelFailure(raw)) return raw;
  if (!isSuccess(raw.data.status)) return { ok: false, failure: failureFrom(raw.data) };

  const deployment = deploymentFrom(parseBody(raw.data.text));
  if (!deployment) {
    return {
      ok: false,
      failure: { status: 502, code: "invalid_response", message: "Vercel did not return a deployment." },
    };
  }
  return { ok: true, data: deployment };
}

/**
 * A deterministic, tenant-isolated Vercel project name.
 *
 * The Mavly project id is globally unique, but it is also short and guessable.
 * The owner-bound hash keeps two different Mavly accounts from ever sharing a
 * Vercel project even if a project row were somehow recreated, and it keeps the
 * name stable across republishes. The result is always a valid Vercel name.
 */
export function vercelProjectName(prefix: string, projectId: string, userId: string): string {
  const suffix = createHash("sha256")
    .update(`${userId}\u0000${projectId}`, "utf8")
    .digest("hex")
    .slice(0, 8);

  const base = `${prefix}-${projectId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
    .replace(/-+$/g, "");

  return `${base || "mavly-project"}-${suffix}`;
}
