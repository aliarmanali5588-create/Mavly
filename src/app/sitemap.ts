import type { MetadataRoute } from "next";
import { PUBLIC_ROUTES, absoluteUrl } from "@/lib/seo/site";

/**
 * ═══ /sitemap.xml ═══════════════════════════════════════════════════════════
 *
 * Generated from `PUBLIC_ROUTES` in `src/lib/seo/site.ts`, so the sitemap and
 * the canonical tags on each page cannot drift apart.
 *
 * ⚠️ NO `lastModified`. Next's `MetadataRoute.Sitemap` accepts it, and the
 * tempting implementation is `new Date()` — which stamps every URL with the
 * deploy time and tells a crawler the entire site changed on every push. That
 * trains it to ignore the field, which is worse than omitting it. A `lastmod`
 * is only worth emitting when it comes from the content itself; none of these
 * routes has a content date yet, so none claims one.
 *
 * ⚠️ NOTHING PER-USER, PER-PROJECT OR CUSTOMER-OWNED BELONGS HERE. See the
 * comment on `PUBLIC_ROUTES`. A published customer site lives on its own
 * `*.mavly.xyz` host and is the customer's to submit.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
