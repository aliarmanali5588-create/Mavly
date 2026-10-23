import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRoutableProjectSlug } from "../src/lib/project-slug";

/**
 * The ownership foundation (route-hardening phase, step 1):
 *   · supabase/migrations/02_create_projects.sql
 *   · supabase/backfill-ownership.template.sql
 *
 * `npm test` has no database, so these tests assert the FILES' properties —
 * the same style as `routes.test.ts` reading `proxy.ts`. What they protect is
 * the set of invariants a future "small tweak" must not silently break:
 * RLS stays on, anon stays out, ownership never transfers, the backfill stays
 * a fill-in template that cannot invent an id, and the SQL slug constraint
 * keeps agreeing with `isRoutableProjectSlug`.
 */

const migration = readFileSync(
  new URL("../supabase/migrations/02_create_projects.sql", import.meta.url),
  "utf8",
);
const backfill = readFileSync(
  new URL("../supabase/backfill-ownership.template.sql", import.meta.url),
  "utf8",
);

/**
 * The backfill's executable SQL: everything that is not a `--` comment line.
 * The template's prose deliberately NAMES the forbidden constructs ("do not
 * `row_security off`"), so the privilege and literal scans below must ignore
 * comments — only what would actually run may be judged.
 */
const backfillExecutable = backfill
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

// ── The migration: table shape ──────────────────────────────────────────────

test("the migration is additive and idempotent", () => {
  assert.equal(migration.includes("create table if not exists public.projects"), true);
  assert.equal(migration.includes("drop policy if exists"), true);
  // Every CREATE POLICY has a matching DROP POLICY IF EXISTS first.
  const creates = migration.match(/create policy /g)?.length ?? 0;
  const drops = migration.match(/drop policy if exists/g)?.length ?? 0;
  assert.equal(creates, drops);
  assert.equal(creates >= 3, true);
  assert.equal(migration.includes("drop constraint if exists"), true);
  assert.equal(migration.includes("create index if not exists"), true);
});

test("ownership rows key on the upstream slug and a real auth user", () => {
  assert.equal(migration.includes("project_id text primary key"), true);
  assert.equal(
    migration.includes("user_id uuid not null references auth.users (id) on delete cascade"),
    true,
  );
  assert.equal(migration.includes("created_at timestamptz not null default now()"), true);
});

// ── The migration: RLS ──────────────────────────────────────────────────────

test("RLS is enabled on the ownership table", () => {
  assert.equal(migration.includes("alter table public.projects enable row level security"), true);
});

test("policies are scoped to authenticated and to the caller's own row", () => {
  // to authenticated, never to anon or service_role.
  assert.equal(/to\s+anon/.test(migration), false);
  assert.equal(/to\s+service_role/.test(migration), false);
  const policyBlocks = migration.split(/create policy /).slice(1);
  assert.equal(policyBlocks.length >= 3, true);
  for (const block of policyBlocks) {
    const body = block.split(");")[0];
    assert.equal(body.includes("to authenticated"), true);
    assert.equal(body.includes("(select auth.uid()) = user_id"), true);
  }
});

test("there is no policy that grants anon anything", () => {
  assert.equal(/policy .* for .* to anon/i.test(migration), false);
  // No catch-all either.
  assert.equal(/for\s+all/i.test(migration), false);
});

test("ownership never transfers: select, insert and delete only — no update", () => {
  const verbs = [...migration.matchAll(/for\s+(select|insert|update|delete|all)/gi)].map((m) =>
    m[1].toLowerCase(),
  );
  assert.equal(verbs.includes("update"), false);
  assert.equal(verbs.includes("all"), false);
  assert.equal(verbs.includes("select"), true);
  assert.equal(verbs.includes("insert"), true);
  assert.equal(verbs.includes("delete"), true);
  // The insert policy pins the writer to their own user_id.
  assert.equal(migration.includes("with check ((select auth.uid()) = user_id)"), true);
});

// ── The migration: slug constraint ──────────────────────────────────────────

/**
 * A hand mirror of `projects_project_id_format`, kept honest by the
 * cross-check below. Postgres has no lookaround, so the JS
 * `isRoutableProjectSlug` is approximated by three plain predicates.
 */
function sqlAllowsProjectId(id: string): boolean {
  return (
    id.length >= 1 &&
    id.length <= 63 &&
    /^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(id) &&
    !id.includes("--")
  );
}

test("the SQL slug constraint and isRoutableProjectSlug agree on every sample", () => {
  const corpus = [
    // Routable — must be storable (these are real shapes of real projects).
    "a",
    "my-app",
    "crm-app-2",
    "deep-investigate-on-internet111testdev", // 38 chars: too long to CREATE, must remain storable
    "francesc-test-dev-tesstttt", // contains -dev-: reserved to create, must remain storable
    "a".repeat(63), // the routable ceiling
    // Not routable — must be refused by BOTH (path safety).
    "",
    "UPPER",
    "2048-game", // must start with a letter
    "a--b", // no double hyphen
    "a-", // no trailing hyphen
    "-a", // no leading hyphen
    "a_b",
    "a.b",
    "a/b", // path traversal shape
    "../etc",
    "a b",
    "a?b=1", // query-string shape
    "café",
    "a".repeat(64), // one past the ceiling
  ];
  for (const slug of corpus) {
    assert.equal(
      sqlAllowsProjectId(slug),
      isRoutableProjectSlug(slug),
      `disagreement on ${JSON.stringify(slug)}`,
    );
  }
});

test("the migration states that create-time rules are deliberately not enforced", () => {
  // The 4–35 length and -dev- rules live only in validateProjectSlug; the
  // comment is what stops a future reader from 'tightening' the constraint
  // and locking out the 38-character project documented in project-slug.ts.
  assert.equal(migration.includes("IS NOT THE CREATE-TIME RULE"), true);
  assert.equal(migration.includes("isRoutableProjectSlug"), true);
});

// ── The backfill template ───────────────────────────────────────────────────

test("the backfill is a transaction with conflict-safe inserts", () => {
  assert.equal(backfill.includes("begin;"), true);
  assert.equal(backfill.includes("commit;"), true);
  assert.equal(backfill.includes("on conflict (project_id) do nothing"), true);
});

test("the backfill never disables RLS or widens privileges", () => {
  assert.equal(/row_security\s+off/i.test(backfillExecutable), false);
  assert.equal(/disable row level security/i.test(backfillExecutable), false);
  assert.equal(/force row level security/i.test(backfillExecutable), false);
  assert.equal(/revoke/i.test(backfillExecutable), false);
  assert.equal(/grant /i.test(backfillExecutable), false);
});

test("the backfill contains placeholders, never a plausible id", () => {
  assert.equal(backfill.includes("REPLACE-WITH-PROJECT-ID"), true);
  assert.equal(backfill.includes("00000000-0000-0000-0000-000000000000"), true);
  // Every UUID-shaped token that would EXECUTE is the all-zero placeholder —
  // a filled copy must never be committed, and an unfilled one cannot smuggle
  // a real id. (Comments may name the example pattern; they never run.)
  const uuids =
    backfillExecutable.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ??
    [];
  for (const uuid of uuids) {
    assert.equal(
      uuid === "00000000-0000-0000-0000-000000000000",
      true,
      `unexpected uuid literal in executable SQL: ${uuid}`,
    );
  }
  // And no hard-coded project slug that looks real in anything that runs —
  // only the uppercase placeholder sits in the VALUES list.
  const slugs = backfillExecutable.match(/\('[a-z][a-z0-9-]*[a-z0-9]'\s*,/g) ?? [];
  assert.equal(slugs.length, 0, `found a realistic slug literal: ${slugs.join(", ")}`);
});

test("the unfilled placeholder cannot pass the table's own constraints", () => {
  // The uppercase placeholder trips the format CHECK; the zero UUID is not a
  // real auth.users row, so the FK (or the EXISTS guard) stops it. Either way
  // a template run inserts nothing — which is the safety property.
  assert.equal(sqlAllowsProjectId("REPLACE-WITH-PROJECT-ID"), false);
  assert.equal(
    "00000000-0000-0000-0000-000000000000".match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    ) !== null,
    true,
  );
});

test("the backfill documents when to run it and the no-invented-id rule", () => {
  assert.equal(backfill.includes("NEVER INVENT AN ID"), true);
  assert.equal(backfill.includes("BEFORE the route guards"), true);
  assert.equal(backfill.includes("02_create_projects.sql"), true);
});
