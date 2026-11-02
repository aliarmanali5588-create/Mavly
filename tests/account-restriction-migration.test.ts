import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../supabase/migrations/49_account_restriction_reason.sql", import.meta.url),
  "utf8",
);

test("suspension reasons are readable only for the authenticated caller", () => {
  assert.match(migration, /function public\.current_user_restriction_reason\(\)/);
  assert.match(migration, /security definer[\s\S]*?set search_path = ''/);
  assert.match(migration, /e\.target_user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /e\.resulting_banned_until = u\.banned_until/);
  assert.match(migration, /grant execute on function public\.current_user_restriction_reason\(\) to authenticated/);
  assert.match(migration, /revoke all on function public\.current_user_restriction_reason\(\) from anon/);
});

test("the worker status lookup is restricted to the service role", () => {
  assert.match(migration, /function public\.account_user_is_restricted\(p_user_id uuid\)/);
  assert.match(migration, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(migration, /grant execute on function public\.account_user_is_restricted\(uuid\) to service_role/);
  assert.match(migration, /revoke all on function public\.account_user_is_restricted\(uuid\) from anon, authenticated/);
  assert.match(migration, /u\.banned_until > now\(\)/);
  assert.match(migration, /account_restriction_schema_version\(\)[\s\S]*?select 49/);
});
