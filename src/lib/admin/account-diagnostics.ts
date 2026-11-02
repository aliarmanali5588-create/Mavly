/**
 * ═══ ACCOUNT ADMIN DIAGNOSTICS ══════════════════════════════════════════════
 *
 * ⚠️ WHY THIS FILE EXISTS. The account-status route used to answer
 *
 *     if (readError || !target?.user) return 404 USER_NOT_FOUND;
 *
 * which is a lie in every case except one. A missing service-role key, a key from
 * the wrong Supabase project, an expired key, a 401 from the Auth admin API and a
 * genuine network failure all produced "That account does not exist." The
 * operator then goes looking for a user that is probably fine, while the actual
 * fault (configuration) is invisible.
 *
 * This module separates the four conditions the brief asks to distinguish:
 *
 *   1. missing configuration   → the key is absent or too short to be a key
 *   2. invalid credentials     → the key is present but Auth rejects it (401/403)
 *   3. actual missing user     → Auth answered 404 for that id
 *   4. network / upstream      → no answer, a timeout, or a 5xx
 *
 * ⚠️ IT NEVER RETURNS OR LOGS THE KEY. `describeServiceRoleConfig` reports the
 * key's LENGTH BUCKET and the project ref the URL points at — both of which are
 * enough to prove "wrong project" without exposing a secret. The key's own
 * project ref is derivable from a JWT, but only its `ref` claim is read, never
 * the signature, the `role` claim's value beyond a comparison, or any other
 * claim.
 */

/** The four conditions, plus the one that is not a failure at all. */
export type AccountAdminFailure =
  | "not_configured"
  | "invalid_credentials"
  | "user_not_found"
  | "upstream_unavailable"
  | "unknown";

export interface AccountAdminConfigReport {
  /** True when a service-role key is present and shaped like one. */
  configured: boolean;
  /** The project ref `NEXT_PUBLIC_SUPABASE_URL` points at, or null. */
  urlProjectRef: string | null;
  /** The project ref inside the service-role key's JWT, or null if unreadable. */
  keyProjectRef: string | null;
  /**
   * True when both refs are readable and equal. `null` when it cannot be
   * determined (a non-JWT key, or an unparseable URL) — never guessed.
   */
  projectMatch: boolean | null;
  /** A coarse length bucket. Never the key, never a prefix. */
  keyLength: "missing" | "too_short" | "plausible";
  /** The `role` claim, compared against `service_role`. Never the raw value. */
  keyRoleIsServiceRole: boolean | null;
}

/** A Supabase project ref is 20 lowercase alphanumerics. */
const PROJECT_REF = /^[a-z0-9]{20}$/;

/**
 * Read the `ref` and `role` claims out of a Supabase JWT.
 *
 * ⚠️ THIS DOES NOT VERIFY THE SIGNATURE, AND IT MUST NOT BE USED FOR AUTHORITY.
 * It is a diagnostic: it answers "which project does this key claim to belong to"
 * so a mismatched deployment can be identified. The Auth server is still the only
 * thing that decides whether the key is valid.
 */
export function readKeyClaims(key: string): { ref: string | null; role: string | null } {
  const parts = key.trim().split(".");
  if (parts.length !== 3) return { ref: null, role: null };
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    return {
      ref: typeof payload.ref === "string" ? payload.ref : null,
      role: typeof payload.role === "string" ? payload.role : null,
    };
  } catch {
    return { ref: null, role: null };
  }
}

/** The project ref a Supabase URL points at: `https://<ref>.supabase.co`. */
export function projectRefFromUrl(url: string): string | null {
  try {
    const host = new URL(url.trim()).hostname;
    const label = host.split(".")[0];
    return label && PROJECT_REF.test(label) ? label : null;
  } catch {
    return null;
  }
}

/**
 * Describe this deployment's service-role configuration WITHOUT revealing it.
 *
 * ⚠️ SAFE TO RETURN FROM A DIAGNOSTIC ENDPOINT. Every field is a boolean, a
 * coarse bucket, or a project ref — which is already public (it is in the URL the
 * browser uses). The key itself never leaves this function.
 */
export function describeServiceRoleConfig(input: {
  url: string;
  key: string | undefined;
}): AccountAdminConfigReport {
  const key = (input.key ?? "").trim();
  const urlProjectRef = projectRefFromUrl(input.url);

  if (key.length === 0) {
    return {
      configured: false,
      urlProjectRef,
      keyProjectRef: null,
      projectMatch: null,
      keyLength: "missing",
      keyRoleIsServiceRole: null,
    };
  }

  /**
   * The existing gate in `worker.ts` requires >= 20 characters. A real
   * service-role JWT is far longer, so anything under that floor is reported as
   * too short rather than "plausible" — a truncated paste is a real failure mode.
   */
  if (key.length < 20) {
    return {
      configured: false,
      urlProjectRef,
      keyProjectRef: null,
      projectMatch: null,
      keyLength: "too_short",
      keyRoleIsServiceRole: null,
    };
  }

  const claims = readKeyClaims(key);
  return {
    configured: true,
    urlProjectRef,
    keyProjectRef: claims.ref,
    /**
     * ⚠️ `null`, NOT `false`, WHEN EITHER SIDE IS UNKNOWN. Reporting a mismatch
     * we cannot actually see would send the operator chasing a phantom.
     */
    projectMatch:
      claims.ref && urlProjectRef ? claims.ref === urlProjectRef : null,
    keyLength: "plausible",
    keyRoleIsServiceRole: claims.role === null ? null : claims.role === "service_role",
  };
}

/**
 * Classify a Supabase Auth admin error.
 *
 * ⚠️ THE ORDER MATTERS. A 401/403 is a credential problem even though it arrives
 * as a "read error", and a 404 is the ONLY evidence that a user is genuinely
 * absent. Everything else is an upstream problem and must not be reported as a
 * missing account.
 *
 * Supabase returns `{ message, status, code }` on `AuthError`. The status is
 * sometimes absent, so the message is used as a fallback signal — narrowly, and
 * only for the phrases the Auth server actually emits.
 */
export function classifyAuthAdminError(error: unknown): AccountAdminFailure {
  if (!error || typeof error !== "object") return "unknown";

  const record = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof record.status === "number" ? record.status : null;
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";

  if (status === 401 || status === 403) return "invalid_credentials";
  if (code === "user_not_found" || message.includes("user not found")) return "user_not_found";
  if (status === 404) return "user_not_found";

  /**
   * ⚠️ A MISSING KEY IS REPORTED BY SUPABASE AS A 401, so it is already covered
   * above. These phrases catch the cases where no status survives — a thrown
   * fetch error, a DNS failure, a socket reset.
   */
  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnrefused") ||
    message.includes("enotfound")
  ) {
    return "upstream_unavailable";
  }

  if (status !== null && status >= 500) return "upstream_unavailable";

  return "unknown";
}

/**
 * The operator-facing answer for each condition.
 *
 * ⚠️ THE MESSAGE NAMES THE FAULT, NOT THE SYMPTOM. "That account does not exist"
 * is only correct for `user_not_found`; every other case says what is actually
 * wrong, because the person reading it is the one who can fix it.
 */
export function accountAdminFailureResponse(failure: AccountAdminFailure): {
  status: number;
  code: string;
  error: string;
} {
  switch (failure) {
    case "not_configured":
      return {
        status: 503,
        code: "ACCOUNT_ADMIN_UNAVAILABLE",
        error:
          "Account administration is not configured on this deployment: SUPABASE_SERVICE_ROLE_KEY is missing or too short. Set it in the deployment environment and redeploy.",
      };
    case "invalid_credentials":
      return {
        status: 503,
        code: "ACCOUNT_ADMIN_INVALID_KEY",
        error:
          "Supabase Auth rejected the server-side service-role key (401/403). The key is present but invalid, expired, or belongs to a different Supabase project than NEXT_PUBLIC_SUPABASE_URL.",
      };
    case "user_not_found":
      return {
        status: 404,
        code: "USER_NOT_FOUND",
        error: "That account does not exist in this Supabase project.",
      };
    case "upstream_unavailable":
      return {
        status: 502,
        code: "ACCOUNT_ADMIN_UPSTREAM_UNAVAILABLE",
        error:
          "Supabase Auth could not be reached. This is a network or upstream failure, not a missing account. Retry shortly.",
      };
    default:
      return {
        status: 502,
        code: "ACCOUNT_ADMIN_UNEXPECTED",
        error:
          "Supabase Auth returned an unexpected error. The account was not modified. Check the server log for the classified failure.",
      };
  }
}
