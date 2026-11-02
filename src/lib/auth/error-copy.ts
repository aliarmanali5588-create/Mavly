/**
 * The words the sign-in flow shows when something goes wrong.
 *
 * ⚠️ THE CODES ARE THE CONTRACT, THE WORDS ARE THE COPY. The callback route
 * and the sign-in button only ever hand around the code (`oauth_failed`,
 * `missing_code`, …); the message is looked up here, in one place, so the
 * homepage and the sign-in page cannot drift apart.
 *
 * The codes travel in the URL (`/login?error=…`), so they must stay short and
 * stable. The copy may be reworded freely.
 *
 * ⚠️ NOTHING HERE EVER CONTAINS A VALUE. The copy names the environment
 * variables that have to be set — those names are public by construction — but
 * never a URL, a key, a client secret, a session token or a cookie.
 */
import { supabaseConfigProblem, type SupabaseConfigProblem } from "../supabase/config";

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  /** The provider reported an error or the user cancelled. */
  oauth_failed:
    "Sign-in was cancelled or the provider returned an error. Please try again.",
  /** The provider came back without a code. */
  missing_code:
    "The provider did not return a sign-in code. Please try again.",
  /** The callback carried a state that does not belong to this browser. */
  invalid_state:
    "This sign-in request could not be verified. Please try again.",
  /** The sign-in request is older than the ten minutes it is good for. */
  session_expired: "Your sign-in request expired. Please try again.",
  /** A banned user may be unable to establish a Mavly session to see their reason. */
  account_suspended: "This account is suspended. Contact customer support for a review.",
  /** The code could not be exchanged for a session. */
  exchange_failed: "We could not complete the sign-in. Please try again.",
  /** This deployment has no Supabase keys, so nobody can sign in. */
  not_configured: "Sign-in is not configured for this deployment yet.",
};

/**
 * The message for an error code.
 *
 * Unknown codes fall back to a neutral message: a code we do not know about
 * must never be shown to the user as-is.
 */
export function authErrorMessage(code: string | null | undefined): string {
  if (!code) return "We could not start the sign-in. Please try again.";
  return AUTH_ERROR_MESSAGES[code] ?? "We could not reach the provider. Please try again.";
}

/**
 * What to do about a missing Supabase configuration.
 *
 * The two variables are named because the name is the whole fix: a deployment
 * that sets `SUPABASE_URL` instead of `NEXT_PUBLIC_SUPABASE_URL` reads empty
 * in the browser bundle, and the operator can only find that by being told
 * which name is missing.
 */
const DEPLOYMENT_HINT =
  "Set it in Vercel (Settings → Environment Variables) and redeploy — NEXT_PUBLIC_* values are inlined into the browser bundle at build time.";

/**
 * The "sign-in is not configured" message for a specific problem.
 *
 * `null` means "nothing is wrong with the configuration" — which is not a
 * state this message is ever shown in, but it must still be harmless.
 */
export function notConfiguredMessage(
  problem: SupabaseConfigProblem | null = supabaseConfigProblem(),
): string {
  switch (problem) {
    case "missing_url":
      return `Sign-in is not configured for this deployment yet: NEXT_PUBLIC_SUPABASE_URL is missing. ${DEPLOYMENT_HINT}`;
    case "missing_key":
      return `Sign-in is not configured for this deployment yet: NEXT_PUBLIC_SUPABASE_ANON_KEY is missing. ${DEPLOYMENT_HINT}`;
    case "invalid_url":
      return "Sign-in is not configured for this deployment yet: NEXT_PUBLIC_SUPABASE_URL is not a valid http(s) URL.";
    case "invalid_key":
      return "Sign-in is not configured for this deployment yet: NEXT_PUBLIC_SUPABASE_ANON_KEY is malformed.";
    default:
      return AUTH_ERROR_MESSAGES.not_configured;
  }
}

/**
 * The message for a sign-in error, with the configuration problem spelled out
 * when the failure is a missing configuration.
 */
export function signInErrorMessage(code: string | null | undefined): string {
  if (code === "not_configured") return notConfiguredMessage();
  return authErrorMessage(code);
}
