/**
 * ═══ WHO MAY CALL MAVLY'S API WITH CREDENTIALS? ══════════════════════════════
 *
 * This module replaces the old "the request's own Host is trusted" rule.
 *
 * ⚠️ WHY THE OLD RULE HAD TO GO. It answered `origin === "https://" + Host`,
 * which is true for ANY hostname the edge routes to the app — including every
 * tenant host once `*.mavly.xyz` points at this application. A hostname is a
 * routing input, not proof of authorization.
 *
 * The allowlist is explicit configuration:
 *
 *   NEXT_PUBLIC_APP_URL   the canonical app origin (and its `www`/apex sibling)
 *   MAVLY_ALLOWED_ORIGINS optional comma-separated extra origins
 *
 * Nothing here can name a tenant host: tenants are never added to the list.
 *
 * ⚠️ MUTATIONS. A browser marks who initiated a request with `Origin` and
 * `Sec-Fetch-Site`. A generated website at `foo.mavly.xyz` calling
 * `https://mavly.xyz/api/...` is SAME-SITE (same registrable domain), so
 * `SameSite=Lax` cookies are still sent and a simple `POST` needs no preflight.
 * A credential-bearing mutation is therefore allowed only when:
 *
 *   · its Origin is explicitly allowlisted; or
 *   · the browser reports `same-origin` / `none`, which is computed by the
 *     browser against the URL actually fetched and cannot be produced by a
 *     tenant page; or
 *   · there is no browser signal at all (a server-to-server client), while an
 *     Origin that IS present must still be allowlisted.
 *
 * `same-site` and `cross-site` are rejected unless the Origin is allowlisted,
 * which is exactly the tenant-content case.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Normalise `https://example.com/` → `https://example.com`. */
function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The configured app origins. A parse failure is ignored rather than widened:
 * an unreadable value must never turn into "allow everything".
 */
export function allowedAppOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = new Set<string>();

  const appOrigin = normalizeOrigin(env.NEXT_PUBLIC_APP_URL ?? "");
  if (appOrigin) {
    origins.add(appOrigin);
    // The marketing site is commonly served on both the apex and www. Add the
    // sibling explicitly rather than trusting whichever host the request used.
    try {
      const url = new URL(appOrigin);
      const host = url.hostname;
      const sibling = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
      if (sibling.includes(".")) {
        origins.add(`${url.protocol}//${sibling}${url.port ? `:${url.port}` : ""}`);
      }
    } catch {
      /* appOrigin already parsed; unreachable in practice. */
    }
  }

  for (const entry of (env.MAVLY_ALLOWED_ORIGINS ?? "").split(",")) {
    const origin = normalizeOrigin(entry);
    if (origin) origins.add(origin);
  }

  return [...origins];
}

export function isAllowedAppOrigin(
  origin: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return allowedAppOrigins(env).includes(normalized);
}

export interface MutationOriginInput {
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  isProduction: boolean;
}

/**
 * `null` = allowed. Any other value is a short machine code for the log, never
 * a user-facing message.
 */
export function crossOriginMutationReason(
  input: MutationOriginInput,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return null;
  // Development keeps its permissive behaviour: the app is reached on several
  // localhost ports and third-party tooling may call it directly.
  if (!input.isProduction) return null;

  /**
   * `Sec-Fetch-Site` is set by the browser, not by page script, and it is
   * computed against the URL actually fetched. `same-origin` therefore proves
   * the request came from the app on the host serving the API — it cannot be
   * produced by a tenant page or a third-party site.
   */
  const site = (input.secFetchSite ?? "").toLowerCase();
  const browserSameOrigin = site === "same-origin" || site === "none";

  if (input.origin) {
    if (isAllowedAppOrigin(input.origin, env)) return null;
    /**
     * ⚠️ `same-origin` IS PROOF, NOT CONFIGURATION — AND MUST NOT DEPEND ON THE
     * ALLOWLIST. The browser computes `Sec-Fetch-Site` against the URL it
     * actually fetched, and page script cannot set it. A tenant page at
     * `<project>.mavly.xyz` calling `https://mavly.xyz/api/...` is `same-site`,
     * never `same-origin`, so accepting this signal cannot be produced by
     * published content.
     *
     * Gating this exception on `allowlist.length === 0` turned a stale or
     * mismatched `NEXT_PUBLIC_APP_URL` / `MAVLY_ALLOWED_ORIGINS` into a total
     * launch outage: the real dashboard is same-origin with the API, yet its
     * POST was refused because the configured allowlist named a different
     * origin. The allowlist still governs `same-site` and `cross-site`
     * requests below.
     */
    if (browserSameOrigin) return null;
    return "origin_not_allowed";
  }

  if (browserSameOrigin) return null;
  if (!site) return null; // non-browser client with no Origin header
  return "cross_site_request";
}
