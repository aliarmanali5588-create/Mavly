import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalCreatedProjectId,
  ownedProjectIds,
  registerProjectOwnership,
  type OwnershipWriter,
} from "../src/lib/project-ownership";

/**
 * ═══ CREATION → OWNERSHIP REGISTRATION ═════════════════════════════════════
 *
 * A project the database does not know about is a project nobody can open
 * (the guards answer 403). These tests pin the registration contract to the
 * session client's real behaviour:
 *
 *  · the CANONICAL response id is registered, not the requested slug;
 *  · a retry by the same user is idempotent;
 *  · an id already registered to somebody else is a conflict, never an
 *    overwrite (RLS hides that row, so `owns()` answering "not-owned" is the
 *    only evidence available);
 *  · every uncertain path fails closed — no "assume it worked".
 */

const userId = "11111111-1111-4111-8111-111111111111";

function writer(overrides: Partial<OwnershipWriter> = {}): OwnershipWriter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async insert(projectId, owner) {
      calls.push(`insert:${projectId}:${owner}`);
      return { ok: true };
    },
    async owns(projectId, owner) {
      calls.push(`owns:${projectId}:${owner}`);
      return "owned";
    },
    async listOwned(owner) {
      calls.push(`list:${owner}`);
      return ["my-app", "second-app"];
    },
    ...overrides,
  };
}

test("a successful insert registers the canonical id for the verified user", async () => {
  const db = writer();
  assert.deepEqual(await registerProjectOwnership("my-app", userId, db), {
    ok: true,
    alreadyOwned: false,
  });
  assert.deepEqual(db.calls, [`insert:my-app:${userId}`]);
});

test("an invalid project id never reaches the database", async () => {
  const db = writer({
    async insert() {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(await registerProjectOwnership("Bad_Slug", userId, db), {
    ok: false,
    reason: "invalid-project-id",
  });
});

test("a duplicate that the same user already owns is idempotent success", async () => {
  const db = writer({
    async insert() {
      return { ok: false, code: "23505" };
    },
    async owns() {
      return "owned";
    },
  });
  assert.deepEqual(await registerProjectOwnership("my-app", userId, db), {
    ok: true,
    alreadyOwned: true,
  });
});

test("a duplicate owned by somebody else is a conflict, not an overwrite", async () => {
  const db = writer({
    async insert() {
      return { ok: false, code: "23505" };
    },
    // RLS hides the other user's row: the honest answer is "not-owned".
    async owns() {
      return "not-owned";
    },
  });
  assert.deepEqual(await registerProjectOwnership("my-app", userId, db), {
    ok: false,
    reason: "conflict",
  });
});

test("a duplicate whose re-check errors is unavailable, not a conflict", async () => {
  const db = writer({
    async insert() {
      return { ok: false, code: "23505" };
    },
    async owns() {
      return "error";
    },
  });
  assert.deepEqual(await registerProjectOwnership("my-app", userId, db), {
    ok: false,
    reason: "unavailable",
  });
});

test("any other database error fails closed", async () => {
  const db = writer({
    async insert() {
      return { ok: false, code: "42501" };
    },
  });
  assert.deepEqual(await registerProjectOwnership("my-app", userId, db), {
    ok: false,
    reason: "unavailable",
  });
});

test("without Supabase configured registration is unavailable (never assumed)", async () => {
  // This environment has no Supabase env; the real `sessionOwnershipWriter()`
  // returns null. No network, no fake.
  assert.deepEqual(await registerProjectOwnership("my-app", userId), {
    ok: false,
    reason: "unavailable",
  });
});

// ── the canonical id ───────────────────────────────────────────────────────

test("the response's projectId is the authority", () => {
  // A taken name is resolved upstream; the canonical id is what was created.
  assert.equal(canonicalCreatedProjectId({ projectId: "billing-pos-2" }), "billing-pos-2");
  assert.equal(canonicalCreatedProjectId({ requestedProjectId: "billing-pos", projectId: "billing-pos-2" }), "billing-pos-2");
});

test("a missing or malformed response id is not registrable", () => {
  for (const data of [null, undefined, {}, { projectId: "" }, { projectId: 42 }, { projectId: "Bad_Slug" }]) {
    assert.equal(canonicalCreatedProjectId(data), null, JSON.stringify(data));
  }
});

// ── listing ───────────────────────────────────────────────────────────────

test("ownedProjectIds returns a set of the caller's rows", async () => {
  const ids = await ownedProjectIds(userId, writer());
  assert.ok(ids);
  assert.deepEqual([...ids!].sort(), ["my-app", "second-app"]);
});

test("a failed or unavailable listing is null (the route answers 500)", async () => {
  assert.equal(
    await ownedProjectIds(
      userId,
      writer({
        async listOwned() {
          return null;
        },
      }),
    ),
    null,
  );
  // No Supabase in this environment: also null, not "empty means owned nothing".
  assert.equal(await ownedProjectIds(userId), null);
});
