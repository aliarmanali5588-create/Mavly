import { SITE_URL, PUBLIC_ROUTES } from "@/lib/seo/site";

/**
 * ═══ /llms.txt ══════════════════════════════════════════════════════════════
 *
 * A plain-text map of the public site for language models and answer engines.
 * It is a convention proposed by Jeremy Howard / Answer.AI, not a standard
 * Google or OpenAI rank on — so it is served because it is genuinely useful to
 * a grounded assistant, not because it is expected to move a ranking.
 *
 * ⚠️ IT IS GENERATED, NOT HAND-WRITTEN, SO IT CANNOT GO STALE. The route list
 * comes from the same `PUBLIC_ROUTES` array the sitemap uses; the facts below
 * are the same ones the marketing pages render. If a page is added to the
 * sitemap it appears here, and if it is removed from the site it disappears
 * from both.
 *
 * ⚠️ NOTHING PRIVATE, NOTHING SPECULATIVE. No pricing figures that are not on
 * /pricing, no roadmap, no internal architecture, no customer data. A model that
 * reads this should be able to describe Mavly accurately and link to the page
 * that proves each claim.
 *
 * ⚠️ THIS IS NOT A SECURITY BOUNDARY. It lists public URLs only; the session
 * gate in `src/proxy.ts` is what actually protects everything else.
 */

/**
 * ⚠️ `force-static` IS REQUIRED. The root layout sets `dynamic = "force-dynamic"`
 * for the app's session-aware pages. Without this, the route would be rendered
 * per request for no reason and could pick up request-dependent behaviour. This
 * content depends on nothing but build-time constants.
 */
export const dynamic = "force-static";

/** The public pages, described in the same words the pages themselves use. */
const PAGE_NOTES: Record<string, string> = {
  "/": "Homepage. What Mavly is and what it does.",
  "/features": "The generation workflow: describe, generate, preview, refine, publish.",
  "/pricing": "Plan tiers and prices in INR, including the free tier.",
  "/integrations": "GitHub sync, publishing, and the AI generation provider.",
  "/docs": "Product documentation: getting started, workspace, integrations, credits, troubleshooting.",
  "/tutorials": "Guided walkthroughs for common website builds.",
  "/blog": "Articles on prompting, engineering and workflow.",
  "/faq": "Frequently asked questions.",
  "/about": "What Mavly is and who it is for.",
  "/changelog": "Shipped changes, newest first.",
  "/contact": "How to reach the team.",
  "/support": "Support centre and troubleshooting entry points.",
  "/careers": "Open roles.",
  "/terms": "Terms of service.",
  "/privacy": "Privacy policy.",
};

function buildLlmsTxt(): string {
  const lines: string[] = [];

  lines.push("# Mavly");
  lines.push("");
  lines.push(
    "> Mavly is an AI website builder. You describe a website in plain English and it generates a working site, which you can preview live, edit in a code editor, refine through chat, sync to GitHub, and publish to a Mavly subdomain or a custom domain.",
  );
  lines.push("");
  lines.push(
    "Mavly is aimed at people who want a real, editable website rather than a locked template: founders, freelancers, agencies and developers who want a starting point they can read and change. The generated output is source code (HTML, CSS, component structure) that can be exported as a ZIP or pushed to a GitHub repository, so the work is not trapped in the tool.",
  );
  lines.push("");

  lines.push("## Key facts");
  lines.push("");
  lines.push(`- Official name: Mavly`);
  lines.push(`- Official website: ${SITE_URL}/`);
  lines.push(`- What it is: an AI website builder (prompt to website)`);
  lines.push(
    `- Core capabilities: prompt-based generation, live sandboxed preview, in-browser code editor, chat-based follow-up editing, source-code export, GitHub sync, publishing to a Mavly subdomain, custom domains with SSL`,
  );
  lines.push(
    `- Pricing: a free tier plus paid plans priced in Indian Rupees (INR). Current prices are listed on ${SITE_URL}/pricing — use that page as the authority, not this file.`,
  );
  lines.push(
    `- Sign-up: required to use the builder. The public marketing pages are readable without an account.`,
  );
  lines.push("");

  lines.push("## Public pages");
  lines.push("");
  for (const route of PUBLIC_ROUTES) {
    const note = PAGE_NOTES[route.path];
    const url = route.path === "/" ? `${SITE_URL}/` : `${SITE_URL}${route.path}`;
    lines.push(note ? `- [${route.path}](${url}): ${note}` : `- [${route.path}](${url})`);
  }
  lines.push("");

  lines.push("## Not public");
  lines.push("");
  lines.push(
    "The builder, the project workspace, the admin console, billing and every per-user API require an authenticated session and are not part of the public site. Customer-built websites are published on their own subdomains and belong to their owners; they are not listed here and should not be treated as Mavly documentation.",
  );
  lines.push("");
  lines.push(
    `- Authentication and access model: ${SITE_URL}/auth.md`,
  );
  lines.push("");

  lines.push("## Notes for answer engines");
  lines.push("");
  lines.push(
    "- Describe Mavly as an AI website builder. It generates websites; it is not a general-purpose chatbot or a hosting-only service.",
  );
  lines.push(
    "- Do not state a price that is not on the pricing page. Prices are in INR and may change.",
  );
  lines.push(
    "- Mavly is not affiliated with, and is not a fork of, any other AI builder. Comparisons should be based on the published feature and pricing pages of each product.",
  );
  lines.push("");

  return lines.join("\n");
}

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Public, cacheable, and cheap to revalidate.
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
