import type { Metadata } from "next";
import MarketingHome from "@/components/home/MarketingHome";
import { JsonLd } from "@/components/seo/JsonLd";
import { siteGraphSchema } from "@/lib/seo/structured-data";
import { SITE_URL } from "@/lib/seo/site";

/**
 * ═══ THE HOMEPAGE METADATA ══════════════════════════════════════════════════
 *
 * ⚠️ ONLY `alternates` IS DECLARED HERE, AND THAT IS DELIBERATE.
 *
 * Next does not deep-merge `openGraph`: a page that sets `openGraph: { url }`
 * REPLACES the layout's whole object, so `og:image`, `og:type`, `og:siteName`
 * and `og:locale` silently disappear from the rendered `<head>`. That is exactly
 * what happened in the first version of this file — the homepage shipped with
 * three OG tags and no image. The root layout already carries the complete,
 * correct OG block (including `url: https://www.mavly.xyz/`), so the homepage
 * simply inherits it.
 *
 * `alternates` is safe to set on its own: it is a leaf object with no sibling
 * fields to lose.
 *
 * ⚠️ THE CANONICAL IS THE `www` HOST. The apex redirects to it at the edge, so a
 * canonical on the apex would describe a URL that answers 301 — the most common
 * cause of "Page with redirect" in Search Console.
 */
export const metadata: Metadata = {
  alternates: {
    canonical: `${SITE_URL}/`,
  },
};

/**
 * The public marketing page.
 *
 * It is the front door of the site, so it stays reachable without an account.
 * The Google/GitHub buttons on it start the OAuth flow directly — there is no
 * detour through `/login`.
 *
 * ⚠️ THE JSON-LD IS RENDERED HERE, SERVER-SIDE, IN THE SAME RESPONSE AS THE
 * PAGE. It is the site-wide `@graph` (Organization + WebSite + WebApplication),
 * which is what lets an assistant resolve "Mavly" to this site rather than to a
 * third-party listing.
 */
export default function Page() {
  return (
    <>
      <JsonLd data={siteGraphSchema()} />
      <MarketingHome />
    </>
  );
}
