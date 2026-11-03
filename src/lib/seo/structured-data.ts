/**
 * ═══ STRUCTURED DATA, BUILT FROM THE SAME FACTS AS THE PAGES ════════════════
 *
 * Every value here is either a constant from `site.ts` or a figure that appears
 * verbatim in the marketing UI. That constraint is the whole point: JSON-LD that
 * disagrees with the visible page is worse than no JSON-LD, because it teaches a
 * search engine (and an AI assistant) something false about the product.
 *
 * ⚠️ WHAT IS DELIBERATELY ABSENT, AND WHY:
 *
 *  · `aggregateRating` / `review` — Mavly has no collected, verifiable review
 *    corpus. Inventing one is a manual-action risk in Google and, more
 *    importantly, a lie. Omitted until real reviews exist and are attributable.
 *  · `offers` on SoftwareApplication — the pricing page renders INR tiers, but
 *    `Offer` requires a price that is stable and machine-checkable. The plans
 *    and their prices are instead stated in `llms.txt` and on `/pricing`, where
 *    a human reads the same number. See the note on `SoftwareApplication` below.
 *  · `sameAs` — no verified social profiles exist yet (see `site.ts`).
 *  · `SearchAction` — Mavly has no public site search. Declaring one advertises
 *    a URL template that 404s, which is a broken promise to a crawler.
 */

import {
  SITE_URL,
  SITE_NAME,
  SITE_DESCRIPTION,
  SITE_LOGO_PATH,
  SITE_SOCIAL_PROFILES,
  absoluteUrl,
} from "./site";

/**
 * Stable `@id` values.
 *
 * ⚠️ THESE MUST NOT CHANGE BETWEEN DEPLOYS. The `@id` is how separate JSON-LD
 * blocks on separate pages are understood to describe *the same* entity. A
 * regenerated id per build turns one organisation into a hundred unrelated ones.
 */
const ORGANIZATION_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;
const APP_ID = `${SITE_URL}/#software`;

/** The verified logo, in the shape Google's Organization docs expect. */
function logoObject() {
  return {
    "@type": "ImageObject",
    url: absoluteUrl(SITE_LOGO_PATH),
    width: 1254,
    height: 1254,
  };
}

/**
 * The Mavly organisation.
 *
 * `Organization` is the entity anchor: it is what lets an assistant answer
 * "what is Mavly" with the official site rather than a third-party summary.
 */
export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: SITE_NAME,
    alternateName: "Mavly AI",
    url: `${SITE_URL}/`,
    logo: logoObject(),
    description: SITE_DESCRIPTION,
    email: "hello@mavly.xyz",
    // Empty today; a verified profile is added in site.ts, not here.
    ...(SITE_SOCIAL_PROFILES.length > 0 ? { sameAs: SITE_SOCIAL_PROFILES } : {}),
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: "hello@mavly.xyz",
        url: absoluteUrl("/contact"),
        availableLanguage: ["English"],
      },
    ],
  };
}

/**
 * The website itself.
 *
 * ⚠️ NO `potentialAction`/`SearchAction`. There is no public search endpoint on
 * mavly.xyz, so declaring one would point crawlers at a URL that does not work.
 */
export function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: `${SITE_URL}/`,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    publisher: { "@id": ORGANIZATION_ID },
    inLanguage: "en",
  };
}

/**
 * The product, as a web application.
 *
 * ⚠️ `applicationCategory` IS `DeveloperApplication`. Mavly generates and
 * exports source code and syncs to GitHub; describing it as a generic
 * "BusinessApplication" would mis-set the category a directory or assistant
 * uses to place it. `WebApplication` is the operating-system-neutral type for a
 * product that runs in a browser.
 *
 * ⚠️ `featureList` IS NOT A MARKETING WISH LIST. Each entry is a capability the
 * product actually ships, matching `/features` and `/integrations`. Do not add
 * an item here before the feature exists.
 */
export function softwareApplicationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "@id": APP_ID,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    description: SITE_DESCRIPTION,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "AI Website Builder",
    operatingSystem: "Web browser",
    browserRequirements: "Requires JavaScript.",
    publisher: { "@id": ORGANIZATION_ID },
    isPartOf: { "@id": WEBSITE_ID },
    featureList: [
      "Prompt-based AI website generation",
      "Live sandboxed preview with desktop and mobile viewports",
      "In-browser code editor and file tree",
      "Chat-based follow-up editing",
      "Source-code export and ZIP download",
      "GitHub repository sync",
      "Publishing to a Mavly subdomain",
      "Custom domain connection with SSL",
    ],
    /*
     * ⚠️ `offers` IS INTENTIONALLY OMITTED. The real tiers are INR-priced and
     * rendered on /pricing; encoding them here as `Offer` objects would create a
     * second, silently-stale copy of pricing inside machine-readable markup. The
     * pricing page remains the single source of truth.
     */
  };
}

/**
 * A breadcrumb trail for a nested public page.
 *
 * `items` are ordered root-first. The last item is the current page and carries
 * no `item` URL in Google's preferred shape, but a self-referencing URL is also
 * accepted and is what we emit, because it keeps the trail usable as a plain
 * link list.
 */
export function breadcrumbSchema(
  trail: Array<{ name: string; path: string }>,
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      item: absoluteUrl(entry.path),
    })),
  };
}

/**
 * A `@graph` of the site-wide entities, for the homepage.
 *
 * ⚠️ ONE SCRIPT TAG, THREE NODES. Emitting Organization, WebSite and
 * WebApplication as three separate `<script>` blocks invites a validator to see
 * three unrelated roots; a `@graph` states the relationships (`publisher`,
 * `isPartOf`) explicitly and in one place.
 */
export function siteGraphSchema() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
    ],
  };
}
