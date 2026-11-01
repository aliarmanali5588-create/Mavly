/**
 * ═══ SUPABASE MANAGEMENT API OAUTH CLIENT ═══════════════════════════════════
 *
 * Two jobs in one place:
 *
 *   1. The OAuth handshake (authorize → code → token pair), with PKCE S256.
 *   2. The allowlisted Management API calls this integration needs.
 *
 * ⚠️ THE URLS ARE CONSTANTS. Nothing here accepts a client-supplied host, so
 * this is not an SSRF surface. A project ref is validated against a strict
 * pattern before it enters a path, and the segment is encoded.
 *
 * ⚠️ NO TOKEN IS EVER LOGGED OR RETURNED TO A CALLER OUTSIDE THIS MODULE'S
 * SERVER-SIDE CALLERS. The Authorization header is set on the request and never
 * appears in an error, a log line or a response body.
 */

import {
  SUPABASE_MANAGEMENT_API_URL,
  SUPABASE_OAUTH_AUTHORIZE_URL,
  SUPABASE_OAUTH_TOKEN_URL,
  type SupabaseOAuthConfig,
} from "./config";

const TIMEOUT_MS = 20_000;

export type SupabaseOAuthErrorCode =
  | "supabase_unavailable"
  | "supabase_unauthorized"
  | "supabase_forbidden"
  | "supabase_not_found"
  | "supabase_rate_limited"
  | "supabase_invalid_response"
  | "supabase_failed"
  | "supabase_scope_missing";

export type SupabaseOAuthResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: SupabaseOAuthErrorCode; status?: number };

export function isSupabaseOAuthFailure<T>(
  result: SupabaseOAuthResult<T>,
): result is { ok: false; code: SupabaseOAuthErrorCode; status?: number } {
  return result.ok === false;
}

export interface SupabaseTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO instant the access token stops working, when Supabase says so. */
  expiresAt: string | null;
  /**
   * ⚠️ FALSE MEANS "WE DO NOT KNOW WHEN THIS EXPIRES", NOT "IT NEVER EXPIRES".
   * Callers must treat an unknown expiry as expiring now and prefer a refresh.
   */
  expiryKnown: boolean;
  /** The scopes Supabase actually granted. Never assumed. */
  grantedScopes: string[];
}

function nonEmptyString(value: unknown, max = 8192): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/** A Supabase project ref is a short lowercase alphanumeric token. */
export function isSafeProjectRef(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{6,40}$/.test(value);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      // A redirect must never be followed with an Authorization header attached.
      redirect: "error",
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mapStatus(status: number): SupabaseOAuthErrorCode {
  if (status === 401) return "supabase_unauthorized";
  if (status === 403) return "supabase_forbidden";
  if (status === 404) return "supabase_not_found";
  if (status === 429) return "supabase_rate_limited";
  if (status >= 500) return "supabase_unavailable";
  return "supabase_failed";
}

/**
 * ═══ AUTHORIZE ══════════════════════════════════════════════════════════════
 *
 * ⚠️ NO `scope` PARAMETER. Supabase deprecated it: scopes are configured on the
 * OAuth App and reported back in the token response. Sending it would be
 * ignored at best and misleading at worst.
 */
export function buildSupabaseAuthorizeUrl(
  config: SupabaseOAuthConfig,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(SUPABASE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function parseTokenSet(body: unknown): SupabaseTokenSet | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;

  const accessToken = nonEmptyString(value.access_token);
  if (!accessToken) return null;

  /**
   * ═══ EXPIRY IS NEVER ASSUMED ═════════════════════════════════════════════
   *
   * ⚠️ A MISSING OR MALFORMED `expires_in` MUST NOT MEAN "VALID FOREVER". The
   * previous version stored `null` and the broker treated `null` as "no expiry
   * to check", so a token with an unreadable lifetime was used indefinitely and
   * only discovered dead on a 401.
   *
   * `expires_in` may arrive as a number, a numeric string, or something unusable.
   * A usable value is clamped to a sane window; anything else is recorded as
   * `expiresAt: null` AND flagged `expiryKnown: false`, which the broker treats
   * as "treat as expiring now" — it will attempt a refresh rather than assume
   * the token is good.
   */
  let expiresAt: string | null = null;
  let expiryKnown = false;

  const rawExpiresIn =
    typeof value.expires_in === "number"
      ? value.expires_in
      : typeof value.expires_in === "string" && /^\d{1,9}$/.test(value.expires_in.trim())
        ? Number(value.expires_in.trim())
        : null;

  if (
    rawExpiresIn !== null &&
    Number.isFinite(rawExpiresIn) &&
    rawExpiresIn > 0
  ) {
    /**
     * Clamp: no token is trusted for more than 24 hours, and a sub-second value
     * is rounded up so a token is never considered already-expired on arrival.
     */
    const seconds = Math.min(Math.max(Math.floor(rawExpiresIn), 1), 86_400);
    expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    expiryKnown = true;
  }

  const refreshToken = nonEmptyString(value.refresh_token, 4096);

  /**
   * `scope` may be a space-delimited string or an array. Both shapes are
   * accepted because the response format has varied; an absent scope yields an
   * empty list, which the broker treats as "nothing granted" rather than
   * "everything allowed".
   */
  let grantedScopes: string[] = [];
  if (typeof value.scope === "string") {
    grantedScopes = value.scope.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(value.scope)) {
    grantedScopes = value.scope.filter((entry): entry is string => typeof entry === "string");
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    expiryKnown,
    grantedScopes,
  };
}

/**
 * ═══ TOKEN EXCHANGE ═════════════════════════════════════════════════════════
 *
 * `application/x-www-form-urlencoded` with client credentials in a Basic header,
 * per the Supabase integration guide and the OAuth2 spec.
 */
export async function exchangeSupabaseCode(
  config: SupabaseOAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<SupabaseOAuthResult<SupabaseTokenSet>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetchWithTimeout(SUPABASE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${config.clientId}:${config.clientSecret}`,
        "utf8",
      ).toString("base64")}`,
    },
    body: body.toString(),
  });

  if (!response) return { ok: false, code: "supabase_unavailable" };
  if (!response.ok) return { ok: false, code: mapStatus(response.status), status: response.status };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, code: "supabase_invalid_response" };
  }

  const tokens = parseTokenSet(parsed);
  return tokens
    ? { ok: true, data: tokens }
    : { ok: false, code: "supabase_invalid_response" };
}

/**
 * ═══ REFRESH ════════════════════════════════════════════════════════════════
 *
 * ⚠️ A REFUSED REFRESH MEANS REVOKED, NOT "TRY AGAIN". Supabase returns 401 when
 * the user revoked the app; that is a terminal state the caller must surface as
 * `reconnection_required`, never as a transient failure to retry.
 */
export async function refreshSupabaseToken(
  config: SupabaseOAuthConfig,
  refreshToken: string,
): Promise<SupabaseOAuthResult<SupabaseTokenSet>> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetchWithTimeout(SUPABASE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${config.clientId}:${config.clientSecret}`,
        "utf8",
      ).toString("base64")}`,
    },
    body: body.toString(),
  });

  if (!response) return { ok: false, code: "supabase_unavailable" };
  if (!response.ok) return { ok: false, code: mapStatus(response.status), status: response.status };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, code: "supabase_invalid_response" };
  }

  const tokens = parseTokenSet(parsed);
  return tokens
    ? { ok: true, data: tokens }
    : { ok: false, code: "supabase_invalid_response" };
}

/**
 * ═══ MANAGEMENT API ═════════════════════════════════════════════════════════
 *
 * One authenticated call. The token is a parameter, never stored on a client
 * object, so it cannot outlive the call or leak through a shared instance.
 */
async function managementCall<T>(
  accessToken: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<SupabaseOAuthResult<T>> {
  const response = await fetchWithTimeout(`${SUPABASE_MANAGEMENT_API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response) return { ok: false, code: "supabase_unavailable" };
  if (!response.ok) return { ok: false, code: mapStatus(response.status), status: response.status };

  try {
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, code: "supabase_invalid_response" };
  }
}

export interface SupabaseOrganization {
  slug: string;
  name: string;
}

export interface SupabaseProject {
  ref: string;
  name: string;
  organizationSlug: string | null;
  region: string | null;
  status: string | null;
}

/** List the organizations the token can see. */
export async function listOrganizations(
  accessToken: string,
): Promise<SupabaseOAuthResult<SupabaseOrganization[]>> {
  const result = await managementCall<unknown>(accessToken, "/organizations");
  if (result.ok === false) return result;
  if (!Array.isArray(result.data)) return { ok: false, code: "supabase_invalid_response" };

  const organizations: SupabaseOrganization[] = [];
  for (const entry of result.data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const slug = nonEmptyString(record.slug, 128);
    if (!slug) continue;
    organizations.push({
      slug,
      name: nonEmptyString(record.name, 256) ?? slug,
    });
  }
  return { ok: true, data: organizations };
}

/** List the projects the token can see. */
export async function listProjects(
  accessToken: string,
): Promise<SupabaseOAuthResult<SupabaseProject[]>> {
  const result = await managementCall<unknown>(accessToken, "/projects");
  if (result.ok === false) return result;
  if (!Array.isArray(result.data)) return { ok: false, code: "supabase_invalid_response" };

  const projects: SupabaseProject[] = [];
  for (const entry of result.data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    /**
     * ⚠️ A REF THAT FAILS THE PATTERN IS DROPPED, NOT COERCED. It would become a
     * path segment on the next call, so an unexpected shape is a reason to omit
     * the project rather than to trust it.
     */
    if (!isSafeProjectRef(record.id)) continue;
    projects.push({
      ref: record.id,
      name: nonEmptyString(record.name, 256) ?? record.id,
      organizationSlug: nonEmptyString(record.organization_slug, 128),
      region: nonEmptyString(record.region, 64),
      status: nonEmptyString(record.status, 64),
    });
  }
  return { ok: true, data: projects };
}

/**
 * The project's metadata: name, region, status, Postgres version, host.
 *
 * ⚠️ THIS DELIBERATELY DOES NOT CALL `/api-keys`. That endpoint returns the
 * project's `anon` AND `service_role` keys in one array. The service-role key
 * bypasses RLS entirely, so returning it to the browser, to an agent, or into a
 * model's context would hand over the whole database. There is no legitimate
 * reason for this integration to read it, so it is never requested.
 *
 * The `anon` key is public by design, but it is still not needed here: the
 * generated app gets it through the provider registry, not through a broker
 * response.
 */
export async function readProjectConfig(
  accessToken: string,
  projectRef: string,
): Promise<SupabaseOAuthResult<unknown>> {
  if (!isSafeProjectRef(projectRef)) return { ok: false, code: "supabase_failed" };
  return managementCall<unknown>(
    accessToken,
    `/projects/${encodeURIComponent(projectRef)}`,
  );
}

/** The database schema, via the PostgREST OpenAPI document. */
export async function readDatabaseSchema(
  accessToken: string,
  projectRef: string,
): Promise<SupabaseOAuthResult<unknown>> {
  if (!isSafeProjectRef(projectRef)) return { ok: false, code: "supabase_failed" };
  return managementCall<unknown>(
    accessToken,
    `/projects/${encodeURIComponent(projectRef)}/database/openapi`,
  );
}

/**
 * ═══ SQL EXECUTION ══════════════════════════════════════════════════════════
 *
 * ⚠️ THIS IS THE MOST DANGEROUS CALL IN THE INTEGRATION. It runs arbitrary SQL
 * against a customer database. It is only ever reached through the broker in
 * `broker.ts`, which classifies the statement, enforces the scope, and requires
 * explicit user approval for anything destructive. Nothing else may call it.
 *
 * ⚠️ THE STATEMENT IS NEVER LOGGED. Only the broker's classification is.
 */
export async function runDatabaseQuery(
  accessToken: string,
  projectRef: string,
  query: string,
): Promise<SupabaseOAuthResult<unknown>> {
  if (!isSafeProjectRef(projectRef)) return { ok: false, code: "supabase_failed" };
  return managementCall<unknown>(
    accessToken,
    `/projects/${encodeURIComponent(projectRef)}/database/query`,
    { method: "POST", body: { query } },
  );
}

/** The project's Edge Functions. */
export async function listEdgeFunctions(
  accessToken: string,
  projectRef: string,
): Promise<SupabaseOAuthResult<unknown>> {
  if (!isSafeProjectRef(projectRef)) return { ok: false, code: "supabase_failed" };
  return managementCall<unknown>(
    accessToken,
    `/projects/${encodeURIComponent(projectRef)}/functions`,
  );
}
