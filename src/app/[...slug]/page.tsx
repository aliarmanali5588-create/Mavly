import { notFound, permanentRedirect } from "next/navigation";
import { legacyRedirectTarget } from "@/lib/legacy-routes";

/**
 * Catch-all for every path that doesn't match a real route.
 *
 * ⚠️ UNKNOWN PATHS ARE A 404 NOW, NOT A REDIRECT. The old catch-all sent every
 * mistyped URL to the dashboard, which hid broken links (a dead link looked
 * like a slow page) and made the site look like it had no error pages at all.
 *
 * Only the handful of paths that really used to exist are redirected, so old
 * links keep working:
 *
 *   /home → /dashboard  (the builder moved from /home to /dashboard)
 *   /en, /es → /        (old locale prefixes of the landing page)
 *
 * Real routes such as `/dashboard`, `/project/[projectId]` and the `/api/*`
 * handlers are more specific, so they are matched before this fallback.
 */
export default async function CatchAll({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const path = `/${slug.join("/")}`;

  // The query string of a legacy URL is worth keeping (`/home?tab=chat` still
  // means the chat tab) — but only the parameters themselves, never anything
  // that could point the redirect somewhere else.
  const search = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") query.append(key, value);
  }

  const target = legacyRedirectTarget(path, query.toString());
  if (target) {
    permanentRedirect(target);
  }

  notFound();
}
