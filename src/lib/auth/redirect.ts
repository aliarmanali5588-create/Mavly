/**
 * ═══ RETURN DESTINATIONS — ONLY EVER A PATH ON THIS SITE ═══════════════════
 *
 * The sign-in journey carries one value across the OAuth round trip: where the
 * visitor was heading before they were asked to authenticate. That value
 * arrives from the query string or from a cookie, which means it is
 * attacker-controlled.
 *
 * ⚠️ SO IT IS VALIDATED, NOT TRUSTED. `/login?redirect=https://evil.example`
 * used to be pushed straight into `router.push()`, which is an open redirect:
 * the victim starts on our domain and is handed to a phishing page that
 * inherits the trust of the landing.
 *
 * ⚠️ WHAT IS REFUSED:
 *   · absolute URLs (`https://evil.example`, `http://…`)
 *   · protocol-relative URLs (`//evil.example`)
 *   · backslash spellings (`/\evil.example` — browsers read `\` as `/`)
 *   · anything that resolves to a different ORIGIN once parsed
 *   · control characters and whitespace inside the path
 *   · the auth routes themselves (`/login`, `/auth/callback`) — a return
 *     destination pointing back at the sign-in page is an authentication loop
 *
 * What survives is a relative path on this origin: `/`, `/dashboard`,
 * `/project/my-app`, `/dashboard?tab=chat`.
 */

/**
 * Where a visitor lands after signing in when they had no destination.
 *
 * The builder (`/dashboard`) — not the marketing page. `/` is the public
 * landing page and stays public, so sending somebody there after a sign-in
 * would feel like nothing happened.
 */
export const DEFAULT_REDIRECT = "/dashboard";

/** Paths that must never be used as a return destination (they cause loops). */
const RESERVED_DESTINATIONS = ["/login", "/auth/callback"];

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Reduce an untrusted value to a safe internal path, or fall back.
 *
 * @param raw      the untrusted value (query parameter, cookie)
 * @param fallback what to return when the value is missing or unusable
 */
export function safeRedirectPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_REDIRECT,
): string {
  if (typeof raw !== "string") return fallback;

  const value = raw.trim();
  if (!value) return fallback;

  // Must be a path, not a URL: this alone rejects "https://evil" and "//evil".
  if (!value.startsWith("/")) return fallback;

  // A backslash is read as a slash by browsers, so "/\evil.example" is
  // protocol-relative in disguise.
  if (value.includes("\\")) return fallback;

  // Control characters (including newlines and tabs) can split a header or a
  // redirect target in ways no parser expects.
  if (CONTROL_CHARACTERS.test(value)) return fallback;

  try {
    // Resolve against a throwaway origin: if the result points anywhere else,
    // it was not an internal path.
    const base = new URL("http://mavly.invalid");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return fallback;
    if (!parsed.pathname.startsWith("/")) return fallback;
    if (
      RESERVED_DESTINATIONS.some(
        (r) => parsed.pathname === r || parsed.pathname.startsWith(`${r}/`),
      )
    ) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

/**
 * The same rule under the names the sign-in flow used before it was renamed.
 * One rule, two names — the login page, the callback and the proxy must not
 * be able to drift apart on what a valid destination is.
 */
export const DEFAULT_AUTH_DESTINATION = DEFAULT_REDIRECT;
export const safeInternalPath = safeRedirectPath;

/**
 * The URL that starts the authentication flow for a given destination.
 *
 * @param target where to come back to (validated)
 * @param origin the absolute origin to build against; omit for a relative URL
 */
export function loginUrlFor(target: string, origin?: string): string {
  const path = safeRedirectPath(target, DEFAULT_REDIRECT);
  const query = `?redirect=${encodeURIComponent(path)}`;
  if (!origin) return `/login${query}`;
  return new URL(`/login${query}`, origin).toString();
}
