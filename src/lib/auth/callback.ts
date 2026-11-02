import { DEFAULT_REDIRECT, safeRedirectPath } from "./redirect";

/**
 * Pure decision logic for the OAuth callback route.
 *
 * The route handler supplies the request data and the code-exchange function;
 * everything that decides *what happens next* lives here so it can be tested
 * without a browser, a provider or a network.
 */

export type AuthErrorCode =
  | "not_configured"
  | "oauth_failed"
  | "missing_code"
  | "invalid_state"
  | "session_expired"
  | "account_suspended"
  | "exchange_failed";

/**
 * ⚠️ THE `never` OPTIONALS ARE LOAD-BEARING IN THIS CODEBASE. `tsconfig.json`
 * has `strict: false`, so TypeScript does not narrow a union by a boolean
 * discriminant: `if (outcome.ok) { … } else { outcome.error }` would not
 * compile. Declaring the other branch's property as `?: never` keeps both
 * properties readable on the union without a type guard, while the runtime
 * shape stays exactly one of the two.
 */
export type CallbackOutcome =
  | { ok: true; redirectTo: string; error?: never }
  | { ok: false; error: AuthErrorCode; redirectTo?: never };

export type CallbackInput = {
  /** Query parameters of the callback request. */
  searchParams: URLSearchParams;
  /** Value of the state cookie written when the flow started, if any. */
  stateCookie: string | null;
  /** Value of the destination cookie written when the flow started, if any. */
  nextCookie: string | null;
  /** Exchanges the authorisation code for a session. Resolves to an error on failure. */
  exchangeCode: (code: string) => Promise<{ error: unknown } | null>;
};

function isBannedAccountError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "user_banned"
  );
}

function decodeCookieValue(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export async function resolveCallbackOutcome(input: CallbackInput): Promise<CallbackOutcome> {
  const { searchParams } = input;

  // The provider reported a failure (user cancelled, provider error, ...).
  if (searchParams.get("error_code") === "user_banned") {
    return { ok: false, error: "account_suspended" };
  }
  if (searchParams.get("error")) {
    return { ok: false, error: "oauth_failed" };
  }

  const code = searchParams.get("code");
  if (!code) {
    return { ok: false, error: "missing_code" };
  }

  // No state cookie means the flow was started in another browser, the cookie
  // expired, or cookies are blocked. In all three cases the exchange would
  // fail anyway — fail early with an honest message.
  //
  // ⚠️ ONLY THE PRESENCE OF THE COOKIE IS CHECKED, never the `state` query
  // parameter. Supabase's PKCE flow owns that parameter: the Auth server
  // generates it, validates it on the way back and may forward it to this
  // URL. Comparing it with our own cookie would refuse perfectly valid
  // sign-ins (the two values are never the same). The CSRF guarantee comes
  // from the PKCE code verifier — a cookie only the browser that started the
  // flow has — plus the marker cookie above.
  const expectedState = input.stateCookie;
  if (!expectedState) {
    return { ok: false, error: "session_expired" };
  }

  const rawNext =
    searchParams.get("redirect") ?? decodeCookieValue(input.nextCookie) ?? null;
  const redirectTo = safeRedirectPath(rawNext, DEFAULT_REDIRECT);

  // ⚠️ A THROW IS AN ERROR CODE, NOT A CRASH. The exchange talks to the Auth
  // server, so a network failure can reject; the visitor must end up on
  // `/login` with a retry, not on a 500.
  let result: { error: unknown } | null = null;
  try {
    result = await input.exchangeCode(code);
  } catch {
    result = { error: new Error("exchange threw") };
  }
  if (!result || result.error) {
    return {
      ok: false,
      error: result?.error && isBannedAccountError(result.error)
        ? "account_suspended"
        : "exchange_failed",
    };
  }

  return { ok: true, redirectTo };
}
