import type { MetadataRoute } from "next";
import { SITE_URL, DISALLOWED_PATHS } from "@/lib/seo/site";

/**
 * ═══ /robots.txt ════════════════════════════════════════════════════════════
 *
 * This replaces the old static `public/robots.txt`, which was four `Allow: /`
 * blocks and nothing else: no sitemap reference, no private-path rules, and no
 * statement at all about AI crawlers.
 *
 * ⚠️ DISCOVERY CRAWLERS AND TRAINING CRAWLERS ARE DIFFERENT, AND THIS FILE
 * TREATS THEM SEPARATELY. Being readable by an assistant that is answering
 * "what is Mavly" (a search/answer crawler) is not the same permission as
 * feeding a model's training corpus. Each group below says which it is.
 *
 * ⚠️ THE TRAINING GROUPS MIRROR THE SITE'S EXISTING POLICY, WHICH WAS
 * PERMISSIVE. The previous file's `User-agent: * / Allow: /` already permitted
 * every one of them. Writing them out explicitly changes no behaviour; it makes
 * the current stance visible and reviewable, and it gives a single place to flip
 * if that stance changes. See the note on `TRAINING_CRAWLERS`.
 *
 * ⚠️ ROBOTS.TXT IS NOT AUTHENTICATION. Every path in `DISALLOWED_PATHS` is
 * already gated server-side by `src/proxy.ts`. These rules keep crawler budget
 * off login redirects and stop a private URL surfacing in an index; they are not
 * what protects the data.
 */

/**
 * Crawlers that fetch pages in order to *answer a question now* or to build a
 * search index. Allowing these is the whole point of the exercise.
 */
const DISCOVERY_CRAWLERS = [
  "Googlebot", // Google Search index
  "Googlebot-Image",
  "bingbot", // Bing + Copilot's web grounding
  "OAI-SearchBot", // ChatGPT Search index (separate from GPTBot)
  "ChatGPT-User", // user-initiated fetch when a person asks ChatGPT to open a page
  "Claude-SearchBot", // Claude search index (separate from ClaudeBot)
  "Claude-User", // user-initiated fetch in Claude
  "PerplexityBot", // Perplexity's index
  "Perplexity-User", // user-initiated fetch in Perplexity
  "Applebot", // Siri / Spotlight / Safari suggestions
  "DuckDuckBot",
  "Twitterbot",
  "facebookexternalhit",
  "LinkedInBot",
];

/**
 * Crawlers whose purpose is building a model-training corpus.
 *
 * ⚠️ `Google-Extended` DOES NOT AFFECT GOOGLE SEARCH. It is the control for
 * Gemini training and grounding only — blocking it cannot deindex anything from
 * Google Search, and allowing it does not help ranking. It is listed here so the
 * distinction is explicit rather than assumed.
 *
 * These are allowed because the site's prior policy already allowed them. If the
 * product decision is to withhold training access, move these names into a
 * `Disallow: /` group — that is the only edit required, and it is a one-line
 * change with no effect on search visibility.
 */
const TRAINING_CRAWLERS = [
  "GPTBot",
  "Google-Extended",
  "ClaudeBot",
  "CCBot",
  "anthropic-ai",
  "Bytespider",
  "meta-externalagent",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      /*
       * The default group. `*` covers every crawler not named below, including
       * new ones that appear after this file was written. It allows the public
       * site and denies the private surface.
       */
      {
        userAgent: "*",
        allow: "/",
        disallow: DISALLOWED_PATHS,
      },
      {
        userAgent: DISCOVERY_CRAWLERS,
        allow: "/",
        disallow: DISALLOWED_PATHS,
      },
      {
        userAgent: TRAINING_CRAWLERS,
        allow: "/",
        disallow: DISALLOWED_PATHS,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
