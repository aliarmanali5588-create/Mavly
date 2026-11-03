import { SITE_URL } from "@/lib/seo/site";

/**
 * ═══ /auth.md ═══════════════════════════════════════════════════════════════
 *
 * A public, machine-readable description of how authentication works at the
 * boundary: what is public, how a person signs up, what is protected, and how an
 * authorized user reaches their own resources.
 *
 * ⚠️ THIS FILE IS A DESCRIPTION, NOT A MECHANISM. It grants nothing. There is no
 * token, cookie, key or endpoint here that can be used to authenticate. Reading
 * it gives an agent the same information a visitor gets from the sign-in page.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT IN IT:
 *   · no Supabase project URL, anon key, service-role key or JWT secret;
 *   · no internal auth route paths beyond the public callback (`/auth/callback`),
 *     which is already reachable and already visible in the OAuth redirect;
 *   · no description of session-cookie internals, token formats or refresh logic;
 *   · no admin console paths, no API endpoints, no database or RPC names;
 *   · no claim that any automated system may act on a user's behalf.
 *
 * ⚠️ IT IS GENERATED, NOT A STATIC FILE, so the canonical origin comes from the
 * same constant the sitemap and structured data use. A hardcoded copy here would
 * be one more place to drift when the canonical host changes.
 */

/**
 * ⚠️ `force-static` IS REQUIRED. The root layout sets `dynamic = "force-dynamic"`
 * for the session-aware app. This content depends only on build-time constants,
 * so it is rendered once and served as a static asset.
 */
export const dynamic = "force-static";

function buildAuthMd(): string {
  return `# Authentication at Mavly

This document describes how authentication works on ${SITE_URL}. It is written
for automated agents and human integrators who need to understand what is public
and what requires an account.

## Summary

Mavly is an AI website builder. Its public marketing pages are readable by
anyone. The builder itself, every project workspace, and all account data
require a signed-in user. There is no anonymous or machine-only path into those
areas, and none is described here because none exists.

## Public access

The following are readable without an account, by a person or a crawler:

- The marketing site: the homepage, features, pricing, integrations,
  documentation, tutorials, blog, FAQ, about, changelog, contact, support,
  careers, terms and privacy pages.
- \`/robots.txt\`, \`/sitemap.xml\`, \`/llms.txt\` and this file.
- The sign-in page at \`/login\`.

Public pages are listed in \`/sitemap.xml\` and described in \`/llms.txt\`. Nothing
on a public page is personalized, and no public page reads or displays account
data.

## Registration

There is no separate sign-up form and no password to create. An account is
created the first time a person completes one of the supported OAuth flows:

1. The person opens \`/login\` (or uses the sign-in buttons on the homepage).
2. They choose **Continue with Google** or **Continue with GitHub**.
3. They authorize Mavly in that provider's own consent screen.
4. The provider returns them to \`/auth/callback\`, where the session is
   established and they are sent to the builder.

A first-time sign-in creates the account. A returning sign-in reuses it. Mavly
does not store a password for the account: authentication is delegated to the
identity provider the person chose.

## Login

The same flow is used to sign in. A person who is already signed in and visits
\`/login\` is sent on to their destination rather than shown the form again.

After a successful sign-in the default destination is \`/dashboard\`. A
\`?redirect=\` parameter may carry a return path, but only a relative path on this
origin is ever honoured; absolute, protocol-relative and cross-origin values are
rejected.

## Authentication requirements

- A verified session is required for the builder, the project workspace, the
  admin console, billing, credits, and every per-user API.
- Sessions are established only through the OAuth flow above. There is no API
  key, bearer token, basic-auth credential or query parameter that grants access
  to a Mavly account.
- Requests to protected application pages without a valid session are redirected
  to \`/login\`. Requests to protected APIs without a valid session are answered
  with an HTTP 401 and a JSON body, not a redirect.
- Authorization is enforced on the server for every request. Hiding a link or a
  button in the interface is not what protects a resource.

## Protected areas

These are not public and are not part of the crawlable site:

- \`/dashboard\` — the builder and project list.
- \`/project/…\` — an individual project workspace.
- \`/adminsh/…\` — the internal admin console, which additionally requires an
  administrator role checked against the database.
- \`/upgrade\` and \`/credit-topup\` — per-user plan and credit pages.
- Every \`/api/…\` route that is not explicitly public.

Customer-built websites are published on their own subdomains. They belong to
the customer who built them and are not part of Mavly's public documentation.

## Accessing your own resources

An authorized user reaches their own projects by signing in and using the
builder at \`/dashboard\`. There is no supported way to read or modify another
account's projects, and no supported way to act on a project without being
signed in as its owner.

If you are an automated system and a user wants you to work with their Mavly
account, the user must complete the sign-in flow themselves in a browser. Mavly
does not provide a delegated-access or service-account mechanism for third
parties.

## For AI agents and automated systems

- **Do not attempt to bypass authentication**, guess credentials, replay
  sessions, or access any account that you have not been explicitly authorized to
  access.
- **Do not treat this document as permission.** It describes the boundary; it
  does not grant entry to it.
- **Do not scrape or act on behalf of a signed-in user** without that user's
  explicit authorization, and never by reusing a session you did not establish
  with their consent.
- Public pages may be read and cited freely. If you quote Mavly, cite
  ${SITE_URL} and the specific page you used.

## Contact

Questions about access or account security: hello@mavly.xyz
`;
}

export function GET() {
  return new Response(buildAuthMd(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
