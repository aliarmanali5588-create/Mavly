/**
 * ═══ THE OLD PATHS, AND WHERE THEY GO NOW ══════════════════════════════════
 *
 * The builder used to live at `/home`. It lives at `/dashboard` now, and the old
 * URL keeps working: it answers a **308** (permanent) redirect to the new one.
 *
 * ⚠️ `/dashboard` IS A REAL ROUTE NOW — it must never appear in this map. A
 * legacy entry that points at a live route would shadow it.
 *
 * ⚠️ THE QUERY STRING IS KEPT, THE TARGET IS NOT NEGOTIABLE. `/home?tab=chat`
 * becomes `/dashboard?tab=chat`; the destination is always a path on this site,
 * so a legacy URL can never redirect a visitor somewhere else.
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
  "/home": "/dashboard",
  "/en": "/",
  "/es": "/",
};

/**
 * The target of a legacy redirect, or `null` when the path is not a legacy one.
 *
 * `query` is the *already validated* query string of the incoming request; it
 * is appended to the target, never to the path that is looked up.
 */
export function legacyRedirectTarget(
  path: string,
  query?: string | null,
): string | null {
  const target = LEGACY_REDIRECTS[path];
  if (!target) return null;

  if (!query) return target;

  return `${target}?${query}`;
}
