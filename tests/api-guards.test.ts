import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";
import {
  authFailed,
  enforceProjectScope,
  resolveVcaasContext,
} from "../src/app/api/vcaas/_shared";
import { GET as configGet } from "../src/app/api/config/route";

/**
 * Phase 2 end to end, without a server, without Supabase, and without the
 * Totalum API:
 *
 *  · the proxy really answers unauthenticated API calls with JSON 401 (F-1),
 *    keeps OPTIONS preflight first, keeps /api/config public and keeps the
 *    page/callback routing it had before;
 *  · `resolveVcaasContext` refuses when there is no verified session and
 *    carries the verified id when there is (F-2);
 *  · `enforceProjectScope` allows the owner, refuses everyone else with an
 *    indistinguishable 403, 400s a malformed slug without ever querying, fails
 *    closed on a lookup error, and does not mistake account-scoped path
 *    segments for project ids.
 *
 * The test environment has no Supabase configuration (see auth-config.test.ts),
 * so "no session" is the real, deterministic production code path — no stubbing
 * of the gate itself anywhere in this file.
 */

function req(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

/** A team object as `resolveVcaasContext` would mint it for this user. */
const team = { userId: "11111111-1111-4111-8111-111111111111" };

/** A lookup that must never be reached — throws if the guard queries anyway. */
const noLookup = async (): Promise<never> => {
  throw new Error("the ownership lookup must not run for this path");
};

// ═══ F-1 — the proxy's API gate ═══════════════════════════════════════════

test("a signed-out call to a protected API path gets JSON 401, not a redirect", async () => {
  const res = await proxy(req("/api/vcaas/projects", { headers: { origin: "http://localhost:3000" } }));

  assert.equal(res.status, 401);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(res.headers.get("location"), null, "fetch must never be redirected to a login page");
  assert.equal(res.headers.get("cache-control"), "private, no-store, max-age=0");
  // CORS is still applied, so a browser caller sees the refusal as a 401.
  assert.match(res.headers.get("access-control-allow-origin") ?? "", /localhost:3000/);

  const body = (await res.json()) as { ok: boolean; code: string; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "UNAUTHENTICATED");
  assert.equal(typeof body.error, "string");
});

test("every proxied API surface is gated the same way", async () => {
  for (const path of [
    "/api/preview/my-app",
    "/api/visual-edit/my-app/apply",
    "/api/vcaas/upload/my-app",
    "/api/vcaas/source-code/my-app",
    "/api/vcaas/env/my-app",
    "/api/vcaas/git-diff?url=x",
    "/api/vcaas/accounts",
  ]) {
    const res = await proxy(req(path));
    assert.equal(res.status, 401, `${path} must require a session`);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/, path);
  }
});

test("the gate keys on the VERIFIED user, not on a cookie's presence", async () => {
  // Structural, but it is the load-bearing line: `user` comes from
  // refreshSession → getUser(). A tampered cookie still yields user === null.
  const proxySource = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.equal(
    proxySource.includes("apiSessionDecision(request.nextUrl.pathname, user !== null)"),
    true,
  );
  // And the 401 is produced by the classification helper, not a hand-rolled path list.
  assert.equal(proxySource.includes('return unauthorized;'), true);
});

test("OPTIONS preflight is still answered first, without any auth", async () => {
  const res = await proxy(
    req("/api/vcaas/projects", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000" },
    }),
  );
  assert.equal(res.status, 204);
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /GET, POST, PUT, DELETE, PATCH, OPTIONS/);
});

test("/api/config stays public and answers only its boolean", async () => {
  // Through the proxy: not gated.
  const viaProxy = await proxy(req("/api/config"));
  assert.equal(viaProxy.status, 200, "the approved public exception must not be gated");

  // The route itself: the payload is exactly one boolean flag — no key, no
  // env value, nothing JWT-shaped.
  const routeRes = await configGet();
  const body = (await routeRes.json()) as { ok: boolean; data: Record<string, unknown> };
  assert.equal(routeRes.status, 200);
  assert.deepEqual(Object.keys(body.data), ["configured"]);
  assert.equal(typeof body.data.configured, "boolean");
  const raw = JSON.stringify(body);
  assert.equal(/tlm_sk_|sb_secret|eyJ[A-Za-z0-9_-]{10,}/.test(raw), false, "no credential material");
});

test("near-miss API paths are NOT part of the public exception", async () => {
  const res = await proxy(req("/api/configx"));
  assert.equal(res.status, 401);
});

// ── What the gate must not disturb ──────────────────────────────────────────

test("marketing, legal and auth-callback routing is unchanged", async () => {
  const home = await proxy(req("/"));
  assert.equal(home.status, 200, "the marketing page stays public");

  // A stray OAuth answer still forwards to the callback (auth flow preserved).
  const stray = await proxy(req("/?code=abc123"));
  assert.equal(stray.status, 303);
  assert.match(stray.headers.get("location") ?? "", /^http:\/\/localhost:3000\/auth\/callback\?code=abc123/);

  // The callback itself is never bounced or gated by the API gate.
  const callback = await proxy(req("/auth/callback?code=abc123"));
  assert.equal(callback.status, 200);
  assert.equal(callback.headers.get("location"), null);
});

test("signed-out page navigation still redirects to the login page", async () => {
  const dashboard = await proxy(req("/dashboard"));
  assert.equal(dashboard.status, 303);
  const location = dashboard.headers.get("location") ?? "";
  assert.match(location, /\/login\?redirect=%2Fdashboard/);

  const workspace = await proxy(req("/project/my-app"));
  assert.equal(workspace.status, 303);
  assert.match(workspace.headers.get("location") ?? "", /\/login\?redirect=%2Fproject%2Fmy-app/);
});

// ═══ F-2 — resolveVcaasContext ════════════════════════════════════════════

test("no verifiable session (missing or invalid → null) is refused with 401 JSON", async () => {
  // Both real-world cases reach the resolver as `null`: getUser() errors on an
  // expired/tampered/revoked token and on a missing one alike.
  const denied = await resolveVcaasContext(async () => null);
  assert.equal(authFailed(denied), true);
  if (!authFailed(denied)) return;

  assert.equal(denied.response.status, 401);
  assert.match(denied.response.headers.get("content-type") ?? "", /application\/json/);
  const body = (await denied.response.json()) as { ok: boolean; code: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "UNAUTHENTICATED");
});

test("a verified session becomes the identity used everywhere", async () => {
  const auth = await resolveVcaasContext(async () => ({ id: team.userId }));
  assert.equal(authFailed(auth), false);
  if (authFailed(auth)) return;

  assert.equal(auth.team.userId, team.userId);
  assert.equal(auth.ctx.accountUserId, team.userId);
  // There is no other identity channel: the result carries nothing from a
  // request, a body, a query parameter, or anything upstream returned.
});

// ═══ F-2 — enforceProjectScope ════════════════════════════════════════════

test("the owner is allowed to continue", async () => {
  const seen: Array<[string, string]> = [];
  const owned = async (userId: string, projectId: string) => {
    seen.push([userId, projectId]);
    return "owned" as const;
  };

  const outOfScope = await enforceProjectScope(team, "GET", ["projects", "create-a-billing-pos"], owned);
  assert.equal(outOfScope, null, "the owner's request proceeds unchanged");
  assert.deepEqual(seen, [[team.userId, "create-a-billing-pos"]], "the check is by exact (user, project)");
});

test("a non-owner gets 403", async () => {
  const res = await enforceProjectScope(
    team,
    "GET",
    ["projects", "somebody-elses-app"],
    async () => "not-owned",
  );
  assert.equal(res?.status, 403);
  const body = (await res!.json()) as { ok: boolean; code: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "FORBIDDEN");
});

test("non-owner and no-ownership-record are indistinguishable (no enumeration)", async () => {
  // The lookup maps both realities to "not-owned"; the two answers must be
  // byte-identical, and neither may echo the project id back.
  const a = await enforceProjectScope(team, "GET", ["projects", "ghost-project"], async () => "not-owned");
  const b = await enforceProjectScope(team, "GET", ["projects", "ghost-project"], async () => "not-owned");
  const bodyA = await a!.clone().json();
  const bodyB = await b!.clone().json();
  assert.deepEqual(bodyA, bodyB);
  assert.equal(JSON.stringify(bodyA).includes("ghost-project"), false);
});

test("a lookup error fails CLOSED with a server error", async () => {
  const res = await enforceProjectScope(team, "GET", ["projects", "my-app"], async () => "error");
  assert.equal(res?.status, 500);
  assert.equal(res?.headers.get("cache-control"), "private, no-store, max-age=0");
  const body = (await res!.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});

test("with no Supabase configured the default lookup fails closed too", async () => {
  // No injected stub: this is the production code path in this environment.
  const res = await enforceProjectScope(team, "GET", ["projects", "my-app"]);
  assert.equal(res?.status, 500);
});

test("an invalid project slug is 400 and never reaches the lookup", async () => {
  for (const bad of ["Bad_Slug", "UPPER", "a--b", "a-", "-a", "../etc", "a".repeat(64)]) {
    const res = await enforceProjectScope(team, "GET", ["projects", bad], noLookup);
    assert.equal(res?.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    const body = (await res!.clone().json()) as { code: string };
    assert.equal(body.code, "VALIDATION");
  }
});

test("account-scoped and id-less paths are never mistaken for project ids", async () => {
  // Each of these would be a catastrophic false "not-owned" (or worse, a
  // lookup of a literal segment) if path[1] were read as an id blindly.
  const paths: Array<[string, string[]]> = [
    ["webhooks", ["webhooks", "wh_123"]],
    ["domains", ["domains"]],
    ["account", ["account", "credit-costs"]],
    ["project groups", ["project-groups", "grp_1"]],
    ["the list/create path", ["projects"]],
    ["an empty segment", ["projects", ""]],
  ];
  for (const [, path] of paths) {
    const res = await enforceProjectScope(team, "GET", path, noLookup);
    assert.equal(res, null, `${path.join("/")} must pass without a lookup`);
  }
});

test("known action segments pass for their method, and are still ids for the other", async () => {
  // POST /projects/launch is the launch action — no project id in the path.
  const launch = await enforceProjectScope(team, "POST", ["projects", "launch"], noLookup);
  assert.equal(launch, null);

  // GET /projects/credit-limits/at-limit is an account action.
  const limits = await enforceProjectScope(team, "GET", ["projects", "credit-limits", "at-limit"], noLookup);
  assert.equal(limits, null);

  // But GET /projects/launch IS a get of a project that happens to be called
  // "launch" — the ownership check must still run (here: refused).
  const asProject = await enforceProjectScope(team, "GET", ["projects", "launch"], async () => "not-owned");
  assert.equal(asProject?.status, 403);
});

// ═══ Call sites really use the guards ═════════════════════════════════════

test("the preview and visual-edit routes await their guards", async () => {
  const preview = readFileSync(
    new URL("../src/app/api/preview/[projectId]/[[...path]]/route.ts", import.meta.url),
    "utf8",
  );
  const apply = readFileSync(
    new URL("../src/app/api/visual-edit/[projectId]/apply/route.ts", import.meta.url),
    "utf8",
  );

  // Preview now has one combined guard: session + ownership in order.
  assert.equal(
    preview.includes("const auth = await authorizeProjectRequest(projectId)"),
    true,
    "preview",
  );
  assert.ok(
    preview.indexOf("authorizeProjectRequest") < preview.indexOf("getFile("),
    "preview must authorize before reading the generated file",
  );

  // Visual apply is still unimplemented and keeps the explicit two guards.
  assert.equal(apply.includes("const auth = await resolveVcaasContext()"), true, "visual-edit apply");
  assert.equal(apply.includes("if (authFailed(auth)) return auth.response;"), true, "visual-edit apply");
  // WITH await, which is load-bearing: without it the returned Promise is
  // truthy and every request would be "refused".
  assert.equal(apply.includes("await enforceProjectScope("), true, "visual-edit apply");
});
