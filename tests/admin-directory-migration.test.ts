import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SQL = readFileSync(
  new URL("../supabase/migrations/41_admin_directory.sql", import.meta.url),
  "utf8",
);
const USERS_ROUTE = readFileSync(
  new URL("../src/app/api/adminsh/users/route.ts", import.meta.url),
  "utf8",
);
const PROJECTS_ROUTE = readFileSync(
  new URL("../src/app/api/adminsh/projects/route.ts", import.meta.url),
  "utf8",
);
const USERS_PAGE = readFileSync(
  new URL("../src/app/adminsh/users/page.tsx", import.meta.url),
  "utf8",
);
const PROJECTS_PAGE = readFileSync(
  new URL("../src/app/adminsh/projects/page.tsx", import.meta.url),
  "utf8",
);
const BILLING_PAGE = readFileSync(
  new URL("../src/app/adminsh/billing/page.tsx", import.meta.url),
  "utf8",
);

function functionBody(name: string) {
  const start = SQL.indexOf(`function public.${name}`);
  assert.ok(start >= 0, `migration defines ${name}`);
  return SQL.slice(start, SQL.indexOf("$$;", start) + 3);
}

test("admin directory RPCs independently enforce the admin session", () => {
  for (const name of ["admin_user_directory", "admin_project_directory"]) {
    const body = functionBody(name);
    assert.match(body, /security definer/);
    assert.match(body, /set search_path = ''/);
    assert.match(body, /auth\.uid\(\)\s+is\s+null/);
    assert.match(body, /public\.current_user_is_admin\(\)/);
    assert.match(body, /errcode\s*=\s*'42501'/);
  }

  assert.match(SQL, /grant execute on function public\.admin_user_directory\(text, text, integer, integer\) to authenticated/);
  assert.match(SQL, /grant execute on function public\.admin_project_directory\(text, text, text, integer, integer\) to authenticated/);
  assert.match(SQL, /revoke all on function public\.admin_user_directory\(text, text, integer, integer\) from public, anon/);
  assert.match(SQL, /revoke all on function public\.admin_project_directory\(text, text, text, integer, integer\) from public, anon/);
});

test("project publication reflects the active version and verified Mavly hostname", () => {
  const body = functionBody("admin_project_directory");
  assert.match(body, /published_version\.status\s*=\s*'active'/);
  assert.match(body, /deployment\.active_version_id/);
  assert.match(body, /deployment\.status\s*<>\s*'unpublished'/);
  assert.match(body, /mavly_domain_status\s*=\s*'verified'/);
  assert.match(body, /mavly_hostname\s*=\s*\(lower\(project_id\)\s*\|\|\s*'\.mavly\.xyz'\)/);
  assert.match(body, /'routesCount', null/);
});

test("admin directory routes use the caller-scoped admin guard and no service-role client", () => {
  for (const [source, rpcName] of [
    [USERS_ROUTE, "admin_user_directory"],
    [PROJECTS_ROUTE, "admin_project_directory"],
  ] as const) {
    assert.match(source, /requireAdmin\(\)/);
    assert.match(source, new RegExp(`rpc\\("${rpcName}"`));
    assert.match(source, /withTimeout/);
    assert.doesNotMatch(source, /service.role|SUPABASE_SERVICE_ROLE_KEY/i);
  }
});

test("admin pages contain no customer, project, or Mavly billing demo records", () => {
  assert.doesNotMatch(USERS_PAGE, /MOCK_USERS_LIST/);
  assert.doesNotMatch(PROJECTS_PAGE, /MOCK_PROJECTS_LIST/);
  assert.doesNotMatch(BILLING_PAGE, /MOCK_TRANSACTIONS|MOCK_REVENUE_MONTHLY|₹\s*[\d,]+/);
  assert.match(BILLING_PAGE, /No Mavly platform billing records are available/);
  assert.match(BILLING_PAGE, /Customer-owned Razorpay/);
});
