import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import {
  authorizeProjectRequest,
  checkProjectAccess,
} from "../src/app/api/vcaas/_shared";
import { GET as catchAllGet, POST as catchAllPost } from "../src/app/api/vcaas/[...path]/route";
import { POST as uploadPost } from "../src/app/api/vcaas/upload/[projectId]/route";
import { GET as sourceCodeGet } from "../src/app/api/vcaas/source-code/[projectId]/route";
import { GET as envGet } from "../src/app/api/vcaas/env/[projectId]/route";
import { GET as gitDiffGet } from "../src/app/api/vcaas/git-diff/route";
import {
  GET as runtimeGet,
  POST as runtimePost,
} from "../src/app/api/runtime/[projectId]/route";

/**
 * ═══ OWNERSHIP AT THE ROUTE BOUNDARY ═══════════════════════════════════════
 *
 * Every API route that can reach a specific project must answer 401 BEFORE it
 * does anything else. In this environment Supabase is unconfigured, so "no
 * session" is the real code path — no stubbing of the gate.
 *
 * The allow/deny matrix itself (owner / non-owner / missing row / lookup error)
 * is exercised through `authorizeProjectRequest` with an injected resolver and
 * lookup, which is the same code the routes call.
 */

const user = { id: "11111111-1111-4111-8111-111111111111" };
const team = { userId: user.id };

const req = (path: string, init?: RequestInit) =>
  new NextRequest(`http://localhost:3000${path}`, init);

const params = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

// ── anonymous refusals ─────────────────────────────────────────────────────

test("every project-scoped route refuses an anonymous caller with 401 JSON", async () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["catch-all project read", () => catchAllGet(req("/api/vcaas/projects/my-app"), { params: Promise.resolve({ path: ["projects", "my-app"] }) })],
    ["catch-all create", () => catchAllPost(req("/api/vcaas/projects", { method: "POST", body: "{}" }), { params: Promise.resolve({ path: ["projects"] }) })],
    ["catch-all launch", () => catchAllPost(req("/api/vcaas/projects/launch", { method: "POST", body: "{}" }), { params: Promise.resolve({ path: ["projects", "launch"] }) })],
    ["upload", () => uploadPost(req("/api/vcaas/upload/my-app", { method: "POST" }), params("my-app"))],
    ["source-code", () => sourceCodeGet(req("/api/vcaas/source-code/my-app"), params("my-app"))],
    ["env", () => envGet(req("/api/vcaas/env/my-app?env=dev"), params("my-app"))],
    ["git-diff", () => gitDiffGet(req("/api/vcaas/git-diff?projectId=my-app&url=https%3A%2F%2Ftotalum.app%2Fx"))],
    ["runtime status", () => runtimeGet(req("/api/runtime/my-app"), params("my-app"))],
    [
      "runtime action",
      () =>
        runtimePost(
          req("/api/runtime/my-app", {
            method: "POST",
            body: JSON.stringify({ action: "start" }),
          }),
          params("my-app"),
        ),
    ],
  ];

  for (const [name, call] of cases) {
    const res = await call();
    assert.equal(res.status, 401, name);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/, name);
    const body = (await res.json()) as { ok: boolean; code: string };
    assert.equal(body.ok, false, name);
    assert.equal(body.code, "UNAUTHENTICATED", name);
  }
});

test("git-diff asks for projectId before anything else", async () => {
  const res = await gitDiffGet(req("/api/vcaas/git-diff?url=https%3A%2F%2Ftotalum.app%2Fx"));
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /projectId/);
});

// ── the allow/deny matrix ──────────────────────────────────────────────────

test("the owner proceeds; the guard returns null", async () => {
  assert.equal(await checkProjectAccess(team, "my-app", async () => "owned"), null);
});

test("a non-owner and a missing ownership row get the same 403", async () => {
  const a = await checkProjectAccess(team, "theirs", async () => "not-owned");
  const b = await checkProjectAccess(team, "ghost", async () => "not-owned");
  assert.equal(a?.status, 403);
  assert.equal(b?.status, 403);
  assert.deepEqual(await a!.clone().json(), await b!.clone().json());
  assert.equal(JSON.stringify(await a!.json()).includes("theirs"), false);
});

test("a lookup failure is 500 (fail closed)", async () => {
  const res = await checkProjectAccess(team, "my-app", async () => "error");
  assert.equal(res?.status, 500);
});

test("a malformed id is 400 without a lookup", async () => {
  const res = await checkProjectAccess(team, "Bad_Slug", async () => {
    throw new Error("must not look up a malformed id");
  });
  assert.equal(res?.status, 400);
});

test("authorizeProjectRequest authenticates first, then checks ownership", async () => {
  const anonymous = await authorizeProjectRequest("my-app", {
    resolveUser: async () => null,
    lookup: async () => {
      throw new Error("must not look up without a session");
    },
  });
  assert.equal(anonymous.ok, false);
  if ("response" in anonymous) assert.equal(anonymous.response.status, 401);

  const owner = await authorizeProjectRequest("my-app", {
    resolveUser: async () => user,
    lookup: async (id, project) => {
      assert.equal(id, user.id);
      assert.equal(project, "my-app");
      return "owned";
    },
  });
  assert.equal(owner.ok, true);

  const foreign = await authorizeProjectRequest("my-app", {
    resolveUser: async () => user,
    lookup: async () => "not-owned",
  });
  assert.equal(foreign.ok, false);
  if ("response" in foreign) assert.equal(foreign.response.status, 403);
});

test("two users: A's project is allowed for A and 403 for B", async () => {
  const a = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const b = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const db = async (userId: string, projectId: string) =>
    projectId === "a-app" && userId === a.id ? ("owned" as const) : ("not-owned" as const);

  const asA = await authorizeProjectRequest("a-app", { resolveUser: async () => a, lookup: db });
  assert.equal(asA.ok, true);

  const asB = await authorizeProjectRequest("a-app", { resolveUser: async () => b, lookup: db });
  assert.equal(asB.ok, false);
  if ("response" in asB) assert.equal(asB.response.status, 403);
});

// ── no upstream call happens before a refusal ────────────────────────────────
//
// Structural, but load-bearing: if `authorizeProjectRequest` is moved below the
// first upstream fetch/read, these routes would spend the account key (and, for
// source-code, buffer a ZIP) on behalf of a caller we have not authorized.

test("source-code, git-diff, upload and env authorize before touching upstream", () => {
  const files = [
    "../src/app/api/vcaas/source-code/[projectId]/route.ts",
    "../src/app/api/vcaas/git-diff/route.ts",
    "../src/app/api/vcaas/upload/[projectId]/route.ts",
    "../src/app/api/vcaas/env/[projectId]/route.ts",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const authAt = source.indexOf("authorizeProjectRequest");
    assert.ok(authAt > 0, `${file} must call the guard`);
    for (const dangerous of ["vcaasRequest(", "vcaasUploadRequest(", "fetch(", "req.formData("]) {
      const at = source.indexOf(dangerous);
      if (at >= 0) assert.ok(authAt < at, `${file}: ${dangerous} must come after authorization`);
    }
  }
});

test("the runtime route authorizes before any sandbox or provider work", () => {
  const source = readFileSync(
    new URL("../src/app/api/runtime/[projectId]/route.ts", import.meta.url),
    "utf8",
  );
  const authAt = source.indexOf("await authorizeProjectRequest(");
  assert.ok(authAt > 0, "the runtime route must call the guard");
  for (const dangerous of [
    "await createSupabaseServerClient(",
    "await getProject(",
    "await getRuntimeSandboxStatus(",
    "await refreshRuntimeLogs(",
    "await startRuntimeSandbox(",
    "await stopRuntimeSandbox(",
    "await runRuntimeBuildCheck(",
  ]) {
    const at = source.indexOf(dangerous);
    assert.ok(at > authAt, `${dangerous} must come after authorization`);
  }
});
