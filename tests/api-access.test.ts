import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_API_PATHS,
  apiSessionDecision,
  isPublicApiPath,
} from "../src/lib/api-access";

/**
 * The API session gate's POLICY (F-1), as a pure function — the proxy turns
 * "unauthenticated" into a JSON 401; everything about WHICH paths are gated,
 * and what counts as an exception, is decided here.
 */

// ── The public exceptions are exact paths ───────────────────────────────────

test("the public API paths are the config probe and the internal worker", () => {
  assert.deepEqual([...PUBLIC_API_PATHS], [
    "/api/config",
    "/api/generation/worker",
  ]);
  assert.equal(isPublicApiPath("/api/config"), true);
  assert.equal(isPublicApiPath("/api/generation/worker"), true);
});

test("the exceptions are exact matches, not prefixes", () => {
  // Near-miss shapes must fall on the protected side.
  assert.equal(isPublicApiPath("/api/configx"), false);
  assert.equal(isPublicApiPath("/api/config/"), false);
  assert.equal(isPublicApiPath("/api/config/nested"), false);
  assert.equal(isPublicApiPath("/API/config"), false);
  assert.equal(isPublicApiPath("/apiconfig"), false);
  assert.equal(isPublicApiPath(""), false);
});

test("the worker exception does not leak to neighbouring paths", () => {
  assert.equal(isPublicApiPath("/api/generation/workerx"), false);
  assert.equal(isPublicApiPath("/api/generation/worker/"), false);
  assert.equal(isPublicApiPath("/api/generation/worker/run"), false);
  assert.equal(isPublicApiPath("/api/generation"), false);
  assert.equal(isPublicApiPath("/api/generation/workers"), false);
  assert.equal(isPublicApiPath("/API/generation/worker"), false);
});

// ── The gate decision matrix ────────────────────────────────────────────────

test("every protected API path is denied without a session", () => {
  const protectedPaths = [
    "/api/vcaas/projects",
    "/api/vcaas/projects/launch",
    "/api/vcaas/git-diff",
    "/api/preview/my-app",
    "/api/preview/my-app/src/index.css",
    "/api/visual-edit/my-app/apply",
    "/api/vcaas/upload/my-app",
    "/api/vcaas/source-code/my-app",
    "/api/vcaas/env/my-app",
    "/api/vcaas/backup-download/my-app/b_1",
    "/api/anything-else",
  ];
  for (const path of protectedPaths) {
    assert.equal(
      apiSessionDecision(path, false),
      "unauthenticated",
      `expected ${path} to require a session`,
    );
  }
});

test("a verified session lets every API path through", () => {
  // "Valid session → normal request flow": with `hasSession` true (which the
  // proxy sets only after getUser() verified the token) nothing is blocked.
  for (const path of ["/api/vcaas/projects", "/api/preview/my-app", "/api/config", "/api/other"]) {
    assert.equal(apiSessionDecision(path, true), "allow", path);
  }
});

test("/api/config is allowed even without a session", () => {
  assert.equal(apiSessionDecision("/api/config", false), "allow");
});

test("the internal worker passes the session gate but authenticates itself", () => {
  // The gate answers "is anybody home?", not "may this caller run work?". The
  // worker route requires a server-only bearer secret of its own.
  assert.equal(apiSessionDecision("/api/generation/worker", false), "allow");
  assert.equal(apiSessionDecision("/api/generation/worker/run", false), "unauthenticated");
});

test("non-API paths are never this gate's business", () => {
  // The page gate (requiresSession in the proxy) owns these; answering 401 to
  // a browser navigation would be nonsense.
  for (const path of ["/", "/dashboard", "/project/my-app", "/login", "/auth/callback", "/terms"]) {
    assert.equal(apiSessionDecision(path, false), "allow", path);
  }
});
