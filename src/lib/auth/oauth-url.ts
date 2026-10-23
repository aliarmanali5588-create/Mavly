/**
 * Pure OAuth helpers (no runtime dependencies) so they can be unit tested.
 */

export const OAUTH_PROVIDERS = ["google", "github"] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Path of the Mavly application callback route (not the provider's callback). */
export const AUTH_CALLBACK_PATH = "/auth/callback";

/** Short-lived cookie holding the CSRF marker of the running flow. */
export const OAUTH_STATE_COOKIE = "mavly_oauth_state";

/** Short-lived cookie holding the validated post-login destination. */
export const OAUTH_NEXT_COOKIE = "mavly_oauth_next";

/** Ten minutes is long enough for a login, short enough to expire quickly. */
export const OAUTH_COOKIE_MAX_AGE = 600;

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Builds the URL the provider sends the user back to.
 *
 * ⚠️ NO QUERY STRING ON PURPOSE. Supabase matches the redirect URL against the
 * project's allow list, and an allow-list entry is written as a bare path
 * (`https://app.example.com/auth/callback`). A dynamic query string on the
 * callback URL (`?redirect=…&state=…`) is the classic way to end up with
 * "requested path is not allowed" — the allow list cannot list a URL that
 * changes on every request.
 *
 * The destination therefore travels in the `mavly_oauth_next` cookie, which is
 * written before the redirect and validated again on arrival. The same cookie
 * mechanism already carries Supabase's PKCE code verifier, so a browser that
 * drops these cookies cannot complete the flow anyway.
 *
 * The origin comes from the request that started the flow, so local
 * development (`http://localhost:3000`) and production each produce their own
 * correct callback URL.
 */
export function buildCallbackUrl(origin: string): string {
  return new URL(AUTH_CALLBACK_PATH, origin).toString();
}
