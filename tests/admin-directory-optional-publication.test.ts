import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ═══════════════════════════════════════════════════════════════════════════
 * MIGRATION 46 — publication is an OPTIONAL dependency
 *
 * The 42P01 defect was a hard reference to migration 14's table inside a
 * function that also runs on databases which never enabled shared hosting.
 * These assertions pin the fix: the relation name may appear only inside
 * dynamic SQL, and an absent table must be reported as unknown, never as zero.
 * ═══════════════════════════════════════════════════════════════════════════ */

const OPTIONAL_PUBLICATION_MIGRATION = readFileSync(
  new URL("../supabase/migrations/46_admin_directory_optional_publication.sql", import.meta.url),
  "utf8",
);
const DIAGNOSTICS_ROUTE = readFileSync(
  new URL("../src/app/api/adminsh/diagnostics/route.ts", import.meta.url),
  "utf8",
);
const SKELETONS = readFileSync(
  new URL("../src/app/adminsh/components/AdminSkeletons.tsx", import.meta.url),
  "utf8",
);
const ADMIN_LOADING = readFileSync(
  new URL("../src/app/adminsh/loading.tsx", import.meta.url),
  "utf8",
);
const ADMIN_SHELL = readFileSync(
  new URL("../src/app/adminsh/components/AdminShell.tsx", import.meta.url),
  "utf8",
);
const USER_COUNT_HOOK = readFileSync(
  new URL("../src/app/adminsh/components/useAdminUserCount.ts", import.meta.url),
  "utf8",
);

test("the project directory never statically references the optional publication table", () => {
  const body = OPTIONAL_PUBLICATION_MIGRATION.slice(
    OPTIONAL_PUBLICATION_MIGRATION.indexOf("function public.admin_project_directory_v46"),
    OPTIONAL_PUBLICATION_MIGRATION.indexOf(
      "comment on function public.admin_project_directory_v46"
    ),
  );

  // The probe is allowed, and dynamic SQL is allowed.
  assert.match(body, /to_regclass\('public\.project_published_versions'\)/);
  assert.match(body, /execute \$query\$/);

  /**
   * ⚠️ THE ACTUAL REGRESSION GUARD.
   *
   * Strip the two legitimate uses — the `to_regclass` probe and the dynamic-SQL
   * block — then assert the relation is not named anywhere else in the function.
   * Any other mention is a planned statement, and the planner resolves relations
   * before evaluating a `case`, so a `case` guard would NOT have prevented 42P01.
   */
  const withoutDynamicSql = body
    .replace(/execute \$query\$[\s\S]*?\$query\$/g, "")
    .replace(/to_regclass\('public\.project_published_versions'\)/g, "")
    // Comments may name the relation freely; only executable SQL matters.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
  assert.doesNotMatch(withoutDynamicSql, /project_published_versions/);
  assert.doesNotMatch(withoutDynamicSql, /published_version\./);
});

test("an absent publication table is reported as unknown, never as zero published", () => {
  assert.match(OPTIONAL_PUBLICATION_MIGRATION, /'publicationState', case/);
  assert.match(OPTIONAL_PUBLICATION_MIGRATION, /then 'available'/);
  assert.match(OPTIONAL_PUBLICATION_MIGRATION, /else 'schema_missing'/);
  // Publication metrics degrade to null, not 0.
  assert.match(
    OPTIONAL_PUBLICATION_MIGRATION,
    /when v_publication_available then count\(\*\) filter/
  );
  assert.match(OPTIONAL_PUBLICATION_MIGRATION, /else null/);
  // Visibility gains a fourth, honest state.
  assert.match(
    OPTIONAL_PUBLICATION_MIGRATION,
    /when not v_publication_available then 'unknown'/
  );
});

test("migration 46 creates no table and keeps the admin gate and grants", () => {
  assert.doesNotMatch(OPTIONAL_PUBLICATION_MIGRATION, /create table/i);
  assert.doesNotMatch(OPTIONAL_PUBLICATION_MIGRATION, /drop table/i);
  assert.doesNotMatch(OPTIONAL_PUBLICATION_MIGRATION, /alter table/i);
  assert.match(OPTIONAL_PUBLICATION_MIGRATION, /security definer/);
  assert.match(OPTIONAL_PUBLICATION_MIGRATION, /set search_path = ''/);
  assert.match(OPTIONAL_PUBLICATION_MIGRATION, /current_user_is_admin\(\)/);
  assert.match(OPTIONAL_PUBLICATION_MIGRATION, /errcode = '42501'/);
  assert.match(
    OPTIONAL_PUBLICATION_MIGRATION,
    /grant execute on function public\.admin_project_directory\(text, text, text, integer, integer\)\s*\n?\s*to authenticated/
  );
});

test("the schema report route is admin-gated, read-only, and names its own absence", () => {
  assert.match(DIAGNOSTICS_ROUTE, /requireAdmin\(\)/);
  assert.match(DIAGNOSTICS_ROUTE, /admin_directory_schema_report/);
  assert.doesNotMatch(DIAGNOSTICS_ROUTE, /service.role|SUPABASE_SERVICE_ROLE_KEY/i);
  assert.doesNotMatch(DIAGNOSTICS_ROUTE, /\.insert\(|\.update\(|\.delete\(/);
  // A missing report function is a precise condition, not a generic failure.
  assert.match(DIAGNOSTICS_ROUTE, /SCHEMA_REPORT_NOT_INSTALLED/);
});

test("admin loading boundaries render the real shell instead of a bare skeleton", () => {
  /**
   * ⚠️ THE LAYOUT-MISMATCH GUARD. The old boundary rendered no shell, so the
   * sidebar and header disappeared and the skeleton spanned the viewport.
   */
  assert.match(ADMIN_LOADING, /AdminShell/);
  assert.match(ADMIN_LOADING, /loading/);
  assert.doesNotMatch(ADMIN_LOADING, /min-h-screen/);

  // Each bespoke skeleton mirrors its real page's own geometry.
  assert.match(SKELETONS, /export function OverviewSkeleton/);
  assert.match(SKELETONS, /export function UsersSkeleton/);
  assert.match(SKELETONS, /export function ProjectsSkeleton/);
  assert.match(SKELETONS, /export function BillingSkeleton/);

  /**
   * Projects differs from Users on purpose: gap-3.5 / p-4 rounded-xl versus
   * gap-4 / p-5 rounded-2xl. Reusing one geometry for both is what produced the
   * visible jump on load.
   */
  assert.match(SKELETONS, /gap-3\.5/);
  assert.match(SKELETONS, /p-4 rounded-xl/);
});

test("a loading boundary never issues a duplicate user-count request", () => {
  assert.match(ADMIN_SHELL, /useAdminUserCount\(!loading\)/);
  assert.match(USER_COUNT_HOOK, /if \(!enabled\) return;/);
});
