/**
 * ═══ WHERE DOES A SIGNED-IN VISITOR BELONG? ═════════════════════════════════
 *
 * Pure routing policy, shared by the proxy and its tests. No Next.js imports,
 * no environment reads, no session lookup — the caller supplies the already
 * verified answer from `refreshSession()`.
 *
 * ⚠️ THE LANDING PAGE STAYS PUBLIC. `/` must keep rendering the marketing page
 * for signed-out visitors; it is not a protected route. The only thing that
 * changes for a signed-in visitor is the destination: the builder.
 *
 * ⚠️ THIS IS A SERVERSIDE DECISION, MADE ONCE, BEFORE RENDER. Doing it in the
 * proxy (with the session the same request just verified) means an
 * authenticated visitor never briefly sees the signed-out marketing page and
 * the browser never has to guess while auth is still initialising.
 */

import { DEFAULT_REDIRECT } from "./redirect";

/** The public front door. */
export const LANDING_PATH = "/";

/**
 * The builder — the canonical destination after sign-in. Reused from the
 * redirect policy so the two cannot drift.
 */
export const DASHBOARD_PATH = DEFAULT_REDIRECT;

/**
 * The destination for this request, or `null` when the request should be
 * served normally.
 *
 * Only the exact landing page is redirected: `/pricing`, `/docs`, `/login`,
 * `/auth/callback` and the project workspace keep their own behaviour. The
 * result is never `/` or `/login`, so this rule cannot create a redirect loop.
 */
export function authenticatedRootTarget(
  pathname: string,
  isAuthenticated: boolean,
): string | null {
  if (!isAuthenticated) return null;
  return pathname === LANDING_PATH ? DASHBOARD_PATH : null;
}
