/**
 * Supabase Management API OAuth client.
 *
 * The URLs are constants. Nothing here accepts a client-supplied host, so this
 * is not an SSRF surface. Tokens, codes and client secrets are never logged or
 * included in an error returned to the browser.
 *
 * Docs:
 *   GET  https://api.supabase.com/v1/oauth/authorize
 *   POST https://api.supabase.com/v1/oauth/token
 *   POST https://api.supabase.com/v1/oauth/revoke
 *   GET  https://api.supabase.com/v1/organizations      (organizations:read)
 *   GET  https://api.supabase.com/v1/projects           (projects:read)
 */

import type { SupabaseIntegrationConfig } from "./config";
import type { SupabaseOrganization, SupabaseProjectSummary } from "./types";

const AUTHORIZE_URL = "https://api.supabase.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.supabase.com/v1/oauth/token";
const REVOKE_URL = "https://api.supabase.com/v1/oauth/revoke";
const ORGANIZATIONS_URL = "https://api.supabase.com/v1/organizations";
const PROJECTS_URL = "https://api.supabase.com/v1/projects";
const TIMEOUT_MS = 15_000;

export type SupabaseOAuthErrorCode =
  | "oauth_unavailable"
  | "oauth_invalid_response"
  | "oauth_unauthorized"
  | "oauth_insufficient_scope"
  | "oauth_invalid_grant"
  | "oauth_rate_limited"
  | "oauth_failed";

export type SupabaseOAuthSuccess<T> = { ok: true; data: T };
export type SupabaseOAuthFailure = { ok: false; code: SupabaseOAuthErrorCode };
export type SupabaseOAuthResult<T> = SupabaseOAuthSuccess<T> | SupabaseOAuthFailure;

export function isOAuthFailure<T>(result: SupabaseOAuthResult<T>): result is SupabaseOAuthFailure {
  return result.ok === false;
}

export interface SupabaseTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function basicAuth(config: SupabaseIntegrationConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

async function errorName(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown, max = 16_384): string | null {
  if (typeof value !== "string") return null;
  if (!value || value.length > max) return null;
  return value;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function parseTokenSet(body: unknown): SupabaseTokenSet | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const accessToken = nonEmptyString(value.access_token);
  const refreshToken = nonEmptyString(value.refresh_token);
  const expiresIn = positiveNumber(value.expires_in);
  const tokenType = value.token_type;
  if (!accessToken || !refreshToken || !expiresIn) return null;
  if (typeof tokenType !== "string" || !tokenType) return null;
  return { accessToken, refreshToken, expiresIn };
}

function mapFailure(response: Response, error: string | null): SupabaseOAuthErrorCode {
  if (response.status === 429) return "oauth_rate_limited";
  if (response.status === 403) return "oauth_insufficient_scope";
  if (error === "invalid_grant") return "oauth_invalid_grant";
  if (response.status === 401) return "oauth_unauthorized";
  return "oauth_failed";
}

export function buildAuthorizeUrl(
  config: SupabaseIntegrationConfig,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeAuthorizationCode(
  config: SupabaseIntegrationConfig,
  code: string,
  codeVerifier: string,
): Promise<SupabaseOAuthResult<SupabaseTokenSet>> {
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: basicAuth(config),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response) return { ok: false, code: "oauth_unavailable" };
  if (!response.ok) {
    return { ok: false, code: mapFailure(response, await errorName(response)) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "oauth_invalid_response" };
  }

  const tokens = parseTokenSet(body);
  return tokens
    ? { ok: true, data: tokens }
    : { ok: false, code: "oauth_invalid_response" };
}

export async function refreshAccessToken(
  config: SupabaseIntegrationConfig,
  refreshToken: string,
): Promise<SupabaseOAuthResult<SupabaseTokenSet>> {
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: basicAuth(config),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response) return { ok: false, code: "oauth_unavailable" };
  if (!response.ok) {
    return { ok: false, code: mapFailure(response, await errorName(response)) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "oauth_invalid_response" };
  }

  const tokens = parseTokenSet(body);
  return tokens
    ? { ok: true, data: tokens }
    : { ok: false, code: "oauth_invalid_response" };
}

export async function revokeRefreshToken(
  config: SupabaseIntegrationConfig,
  refreshToken: string,
): Promise<SupabaseOAuthResult<{ revoked: true }>> {
  const response = await fetchWithTimeout(REVOKE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!response) return { ok: false, code: "oauth_unavailable" };
  if (!response.ok) {
    return { ok: false, code: mapFailure(response, await errorName(response)) };
  }
  return { ok: true, data: { revoked: true } };
}

async function authorizedGet(
  config: SupabaseIntegrationConfig,
  url: string,
  accessToken: string,
): Promise<SupabaseOAuthResult<unknown>> {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response) return { ok: false, code: "oauth_unavailable" };
  if (!response.ok) {
    return { ok: false, code: mapFailure(response, await errorName(response)) };
  }

  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, code: "oauth_invalid_response" };
  }
}

export async function listOrganizations(
  config: SupabaseIntegrationConfig,
  accessToken: string,
): Promise<SupabaseOAuthResult<SupabaseOrganization[]>> {
  const result = await authorizedGet(
    config,
    ORGANIZATIONS_URL,
    accessToken,
  );
  if (isOAuthFailure(result)) return result;
  if (!Array.isArray(result.data)) {
    return { ok: false, code: "oauth_invalid_response" };
  }

  const organizations: SupabaseOrganization[] = [];
  for (const item of result.data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = nonEmptyString(row.id, 128);
    const slug = nonEmptyString(row.slug, 128);
    const name = nonEmptyString(row.name, 256);
    if (id && slug && name) organizations.push({ id, slug, name });
  }

  return organizations.length > 0 || result.data.length === 0
    ? { ok: true, data: organizations }
    : { ok: false, code: "oauth_invalid_response" };
}

export async function listProjects(
  config: SupabaseIntegrationConfig,
  accessToken: string,
): Promise<SupabaseOAuthResult<SupabaseProjectSummary[]>> {
  const result = await authorizedGet(config, PROJECTS_URL, accessToken);
  if (isOAuthFailure(result)) return result;
  if (!Array.isArray(result.data)) {
    return { ok: false, code: "oauth_invalid_response" };
  }

  const projects: SupabaseProjectSummary[] = [];
  for (const item of result.data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const ref = nonEmptyString(row.ref, 64);
    const name = nonEmptyString(row.name, 256);
    const organizationId = nonEmptyString(row.organization_id, 128);
    const organizationSlug = nonEmptyString(row.organization_slug, 128);
    const status = typeof row.status === "string" ? row.status : null;
    if (ref && name && organizationId && organizationSlug) {
      projects.push({ ref, name, organizationId, organizationSlug, status });
    }
  }

  return projects.length > 0 || result.data.length === 0
    ? { ok: true, data: projects }
    : { ok: false, code: "oauth_invalid_response" };
}
