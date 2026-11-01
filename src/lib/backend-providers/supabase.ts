/**
 * ═══ CUSTOMER-OWNED SUPABASE: CREDENTIAL VALIDATION ═════════════════════════
 *
 * Server-only. Nothing here may be imported from a client component: the
 * functions accept a service-role key and must never run in a browser.
 *
 * ⚠️ VALIDATION IS A REAL NETWORK CHECK, NOT A SHAPE CHECK. A well-formed key
 * for the wrong project is worthless, and a key that has been revoked is worse
 * than worthless because it looks fine. So a connection is only `verified` after
 * the project's REST endpoint actually answered with that credential.
 *
 * ⚠️ THE SERVICE-ROLE KEY IS NEVER LOGGED, RETURNED OR PUT IN AN ERROR MESSAGE.
 * Every failure path returns a fixed, credential-free string.
 */

/** What the user supplies. All three are required for a verified connection. */
export interface SupabaseCredentials {
  /** The project URL, e.g. https://abcdefghijkl.supabase.co */
  projectUrl: string;
  /** Public by design. Safe to reference from generated code. */
  anonKey: string;
  /** Bypasses RLS. Server-only, encrypted at rest, never leaves the server. */
  serviceRoleKey: string;
}

export type SupabaseValidationCode =
  | "invalid_url"
  | "url_not_https"
  | "url_not_supabase"
  | "invalid_anon_key"
  | "invalid_service_role_key"
  | "keys_from_different_projects"
  | "project_unreachable"
  | "anon_key_rejected"
  | "service_role_key_rejected"
  | "service_role_key_not_elevated";

export interface SupabaseValidationFailure {
  ok: false;
  code: SupabaseValidationCode;
  message: string;
}

export interface SupabaseValidationSuccess {
  ok: true;
  /** The canonical project ref, e.g. "abcdefghijkl". Non-secret. */
  projectRef: string;
  /** The verified host, e.g. "abcdefghijkl.supabase.co". Non-secret. */
  host: string;
}

export type SupabaseValidationResult = SupabaseValidationSuccess | SupabaseValidationFailure;

function fail(code: SupabaseValidationCode, message: string): SupabaseValidationFailure {
  return { ok: false, code, message };
}

/**
 * A Supabase URL must be https and must be a supabase.co (or supabase.in)
 * hostname. This is not cosmetic: the adapter sends a service-role key to this
 * origin, so accepting an arbitrary host would let a user point Mavly's server
 * at a host they control and harvest the key.
 */
export function parseSupabaseProjectUrl(
  raw: unknown,
): { ok: true; url: URL; projectRef: string; host: string } | SupabaseValidationFailure {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fail("invalid_url", "Enter your Supabase project URL.");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return fail("invalid_url", "That is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    return fail("url_not_https", "The project URL must start with https://");
  }
  const host = url.hostname.toLowerCase();
  /**
   * ⚠️ ALLOWLIST, NOT A SUFFIX CHECK. `evil-supabase.co` ends with
   * "supabase.co" and would pass a naive suffix test, so the label before the
   * suffix is what is matched.
   */
  const match = /^([a-z0-9-]+)\.supabase\.(co|in)$/.exec(host);
  if (!match) {
    return fail(
      "url_not_supabase",
      "The project URL must be a supabase.co project URL, for example https://your-project.supabase.co",
    );
  }
  return { ok: true, url, projectRef: match[1], host };
}

/**
 * A Supabase JWT carries the project ref in its `ref` claim. Comparing the two
 * keys' refs is how a mismatched pair is caught before any network call: an anon
 * key from project A with a service-role key from project B would otherwise
 * produce a confusing half-working connection.
 */
export function jwtProjectRef(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { ref?: unknown };
    return typeof payload.ref === "string" ? payload.ref : null;
  } catch {
    return null;
  }
}

/** A service-role JWT carries `role: "service_role"`. */
export function jwtRole(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * Shape-check the credentials before spending a network round trip.
 *
 * ⚠️ THIS IS NOT AUTHORIZATION. It only rejects input that cannot possibly work,
 * so the user gets a precise message instead of a generic network failure.
 */
export function preflightSupabaseCredentials(
  credentials: Partial<SupabaseCredentials>,
): SupabaseValidationResult | { ok: true; projectRef: string; host: string } {
  const parsed = parseSupabaseProjectUrl(credentials.projectUrl);
  if ("ok" in parsed && parsed.ok === false) return parsed;
  if (!("ok" in parsed) || parsed.ok !== true) {
    return fail("invalid_url", "Enter your Supabase project URL.");
  }

  const anonRef = jwtProjectRef(credentials.anonKey);
  if (!anonRef) {
    return fail("invalid_anon_key", "The anon key is not a valid Supabase key.");
  }
  const serviceRef = jwtProjectRef(credentials.serviceRoleKey);
  const serviceRole = jwtRole(credentials.serviceRoleKey);
  if (!serviceRef) {
    return fail(
      "invalid_service_role_key",
      "The service-role key is not a valid Supabase key.",
    );
  }
  /**
   * A key that is not actually a service-role key is the most dangerous mistake
   * here: the connection would appear to work while every request silently ran
   * with RLS applied, and the user would debug their app instead of their key.
   */
  if (serviceRole !== "service_role") {
    return fail(
      "service_role_key_not_elevated",
      "That key is not a service-role key. Copy the service_role secret from your Supabase project settings.",
    );
  }
  if (anonRef !== serviceRef) {
    return fail(
      "keys_from_different_projects",
      "The anon key and the service-role key belong to different Supabase projects.",
    );
  }
  if (anonRef !== parsed.projectRef) {
    return fail(
      "keys_from_different_projects",
      "The keys belong to a different project than the URL you entered.",
    );
  }

  return { ok: true, projectRef: parsed.projectRef, host: parsed.host };
}

/**
 * Verify the credentials against the live project.
 *
 * Two requests: one with the anon key (proves the project is up and the anon key
 * is accepted) and one with the service-role key (proves the elevated key works).
 * Both hit the REST root, which requires no table to exist.
 *
 * ⚠️ A TIMEOUT IS A FAILURE, NOT A PASS. An unreachable project must never be
 * recorded as verified.
 */
export async function verifySupabaseCredentials(
  credentials: SupabaseCredentials,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<SupabaseValidationResult> {
  const preflight = preflightSupabaseCredentials(credentials);
  if ("ok" in preflight && preflight.ok === false) return preflight;
  if (!("ok" in preflight) || preflight.ok !== true) {
    return fail("invalid_url", "Enter your Supabase project URL.");
  }

  const parsed = parseSupabaseProjectUrl(credentials.projectUrl);
  if (!("ok" in parsed) || parsed.ok !== true) {
    return fail("invalid_url", "Enter your Supabase project URL.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const base = `${parsed.url.origin}/rest/v1/`;

  const probe = async (
    key: string,
  ): Promise<{ status: number } | { error: true }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base, {
        method: "GET",
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: controller.signal,
        cache: "no-store",
      });
      return { status: response.status };
    } catch {
      return { error: true };
    } finally {
      clearTimeout(timer);
    }
  };

  const anon = await probe(credentials.anonKey);
  if ("error" in anon) {
    return fail(
      "project_unreachable",
      "The Supabase project could not be reached. Check the project URL.",
    );
  }
  if (anon.status === 401 || anon.status === 403) {
    return fail("anon_key_rejected", "Supabase rejected the anon key.");
  }

  const service = await probe(credentials.serviceRoleKey);
  if ("error" in service) {
    return fail(
      "project_unreachable",
      "The Supabase project could not be reached. Check the project URL.",
    );
  }
  if (service.status === 401 || service.status === 403) {
    return fail("service_role_key_rejected", "Supabase rejected the service-role key.");
  }

  return { ok: true, projectRef: parsed.projectRef, host: parsed.host };
}

/**
 * The non-secret metadata stored alongside the encrypted keys. Deliberately
 * excludes every credential.
 */
export function supabaseProviderConfig(input: {
  projectRef: string;
  host: string;
}): Record<string, unknown> {
  return {
    projectRef: input.projectRef,
    host: input.host,
    // Recorded so a future adapter can tell which Supabase generation this was.
    provider: "supabase",
  };
}
