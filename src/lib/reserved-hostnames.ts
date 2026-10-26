/**
 * ═══ HOSTNAMES MAVLY'S OWN INFRASTRUCTURE OWNS ══════════════════════════════
 *
 * Every published site lives at `<project-id>.mavly.xyz`. The project id is
 * chosen by the user (or derived from their prompt), so without a reservation
 * list a project could legitimately be named `www`, `api` or `admin` and its
 * published host would collide with an address the platform itself needs.
 *
 * ⚠️ THIS LIST IS A PRODUCT/SECURITY BOUNDARY, NOT A STYLE PREFERENCE. It is
 * applied in four places, and they must agree:
 *
 *   1. project creation  — `validateProjectSlug` refuses a reserved name;
 *   2. slug generation   — `suggestProjectSlug` / `nextAvailableSlug` skip it;
 *   3. publishing        — `publishProject` refuses to attach a reserved host;
 *   4. request routing   — `parseTenantHost` never treats it as a tenant.
 *
 * The database mirrors this list as a CHECK constraint on
 * `public.project_deployments.mavly_hostname` (migration 14, `NOT VALID` so a
 * legacy row that already used such a host is never rewritten). Keep the two in
 * step: `tests/shared-hosting-migration.test.ts` asserts every entry below is
 * present in the migration.
 *
 * ⚠️ RESERVING A NAME DOES NOT RENAME ANYTHING. An existing project called
 * `www` keeps its id, its files and (if it somehow had one) its legacy
 * deployment. It simply cannot PUBLISH on a Mavly hostname until it is renamed
 * by its owner.
 */

/** Top-level application routes plus platform/service hostnames. */
export const RESERVED_HOST_LABELS: readonly string[] = [
  // ── application routes (src/app/*) ─────────────────────────────────────────
  "adminsh",
  "api",
  "auth",
  "careers",
  "changelog",
  "contact",
  "credit-topup",
  "dashboard",
  "docs",
  "faq",
  "features",
  "home",
  "integrations",
  "login",
  "preview",
  "privacy",
  "project",
  "projects",
  "signup",
  "support",
  "terms",
  "tutorials",
  "upgrade",
  // ── marketing / operational hosts ──────────────────────────────────────────
  "blog",
  "help",
  "status",
  "www",
  // ── infrastructure and delivery ────────────────────────────────────────────
  "assets",
  "cdn",
  "files",
  "mail",
  "ns1",
  "ns2",
  "smtp",
  "static",
  "storage",
  "vercel",
  // ── reserved for future platform use ───────────────────────────────────────
  "admin",
  "app",
  "billing",
  "internal",
  "system",
];

const RESERVED = new Set(RESERVED_HOST_LABELS);

/** True when this single hostname label belongs to Mavly, not to a tenant. */
export function isReservedLabel(label: string): boolean {
  return RESERVED.has(label.trim().toLowerCase());
}
