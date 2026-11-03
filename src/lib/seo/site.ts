/**
 * ═══ ONE PLACE THAT KNOWS THE PUBLIC SITE ═══════════════════════════════════
 *
 * Every canonical URL, sitemap entry, robots rule and structured-data `@id` in
 * the app reads from this module. That is deliberate: the failure mode this
 * prevents is a sitemap advertising `mavly.xyz` while the pages canonicalise to
 * `www.mavly.xyz` (or the reverse), which tells a search engine that every page
 * is a duplicate of a page it cannot index.
 *
 * ⚠️ THE CANONICAL HOST IS `www`. The apex `mavly.xyz` redirects to
 * `www.mavly.xyz` at the edge (Cloudflare), and that redirect is intentional and
 * preserved. A canonical URL must be the URL that actually serves a 200 — the
 * post-redirect one — otherwise Google Search Console reports "Page with
 * redirect" against every canonical it is given.
 *
 * ⚠️ THIS IS NOT AN ACCESS-CONTROL LIST. `PUBLIC_ROUTES` describes what may be
 * advertised to crawlers. The session gate in `src/proxy.ts` remains the only
 * thing that decides who may *read* a route. Excluding a path here is an SEO
 * decision; it is never a security boundary.
 */

/** The canonical origin. Apex redirects here; never build URLs from the apex. */
export const SITE_URL = "https://www.mavly.xyz";

/** The brand name as it should appear in titles and structured data. */
export const SITE_NAME = "Mavly";

/** The one-line description reused by metadata, JSON-LD and llms.txt. */
export const SITE_DESCRIPTION =
  "Mavly is an AI website builder that turns a plain-English prompt into a working website, with live preview, code editing, GitHub sync and publishing.";

/** The verified logo asset (1254×1254 PNG, the same file the app icon uses). */
export const SITE_LOGO_PATH = "/logo/Mavly.png";

/** The public contact address used on marketing pages. */
export const SITE_CONTACT_EMAIL = "hello@mavly.xyz";

/**
 * ⚠️ SOCIAL PROFILES ARE OMITTED ON PURPOSE. `sameAs` in Organization schema is
 * an identity claim: search engines and AI assistants use it to decide that two
 * mentions are the same entity. Listing a handle that does not exist, or one
 * that is not verified, corrupts exactly the signal this file exists to build.
 * Add a URL here only once the profile is live and controlled by Mavly.
 */
export const SITE_SOCIAL_PROFILES: string[] = [];

export interface PublicRoute {
  /** Path relative to the canonical origin, always starting with `/`. */
  path: string;
  /** Sitemap priority hint. Advisory only; it does not affect ranking. */
  priority: number;
  changeFrequency:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  /**
   * ⚠️ NO `lastModified` IS DERIVED FROM BUILD TIME. A sitemap that stamps every
   * URL with "now" on each deploy tells crawlers the whole site changed when
   * nothing did, and they learn to ignore the field. Entries here simply omit
   * `lastmod`; a route that has a real, content-derived date can add one.
   */
}

/**
 * ═══ THE PUBLIC, INDEXABLE SURFACE ═══════════════════════════════════════════
 *
 * Every entry is a real route that renders marketing content without a session.
 * Verified against `src/app/**` — do not add a path here speculatively.
 *
 * ⚠️ DELIBERATELY ABSENT: `/dashboard`, `/project/*`, `/adminsh/*`,
 * `/account-restricted`, `/upgrade`, `/credit-topup`, `/login`, `/auth/*`,
 * `/api/*` and every `*.mavly.xyz` tenant host. Those are either authenticated,
 * per-user, or customer-owned. A customer's published site is theirs to submit,
 * not ours to advertise.
 */
export const PUBLIC_ROUTES: PublicRoute[] = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/features", priority: 0.9, changeFrequency: "monthly" },
  { path: "/pricing", priority: 0.9, changeFrequency: "monthly" },
  { path: "/integrations", priority: 0.8, changeFrequency: "monthly" },
  { path: "/docs", priority: 0.8, changeFrequency: "monthly" },
  { path: "/tutorials", priority: 0.7, changeFrequency: "monthly" },
  { path: "/blog", priority: 0.7, changeFrequency: "weekly" },
  { path: "/faq", priority: 0.7, changeFrequency: "monthly" },
  { path: "/about", priority: 0.6, changeFrequency: "monthly" },
  { path: "/changelog", priority: 0.6, changeFrequency: "weekly" },
  { path: "/contact", priority: 0.5, changeFrequency: "yearly" },
  { path: "/support", priority: 0.5, changeFrequency: "monthly" },
  { path: "/careers", priority: 0.4, changeFrequency: "monthly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
];

/**
 * Paths that must never be indexed, expressed as robots.txt `Disallow` rules.
 *
 * ⚠️ THIS IS CRAWL HYGIENE, NOT AUTHENTICATION. `Disallow` stops a well-behaved
 * crawler from *fetching* a URL; it does not protect it. Every path below is
 * already gated server-side by `src/proxy.ts` and its own route handlers. The
 * rules exist so crawler budget is not spent on pages that will only ever
 * return a login redirect, and so a private URL never appears in an index.
 *
 * ⚠️ `/api/` IS DISALLOWED. It is not content, and an indexed API response is a
 * leak waiting to happen. It is also already session-gated.
 */
export const DISALLOWED_PATHS: string[] = [
  "/api/",
  "/dashboard",
  "/project/",
  "/adminsh",
  "/adminsh-auth",
  "/account-restricted",
  "/login",
  "/auth/",
  "/upgrade",
  "/credit-topup",
];

/** An absolute canonical URL for a site-relative path. */
export function absoluteUrl(path: string): string {
  if (path === "/") return `${SITE_URL}/`;
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Metadata `alternates.canonical` for a page.
 *
 * ⚠️ RETURNED AS AN ABSOLUTE URL, NOT A PATH. Next resolves a relative canonical
 * against `metadataBase`, and `metadataBase` is also what OG image URLs resolve
 * against — one wrong value there silently rewrites both. Passing the finished
 * absolute URL removes that coupling for the pages that matter most.
 */
export function canonicalFor(path: string): string {
  return absoluteUrl(path);
}
