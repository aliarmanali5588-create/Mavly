import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PUBLIC_API_PATHS, apiSessionDecision } from "../src/lib/api-access";

/**
 * Static invariants for the worker endpoint. These are text assertions, not a
 * live request: they prove the route cannot be reached by a browser session
 * shortcut and that it keeps its own bearer boundary.
 */

const route = readFileSync(
  new URL("../src/app/api/generation/worker/route.ts", import.meta.url),
  "utf8",
);
const worker = readFileSync(
  new URL("../src/lib/generation/worker.ts", import.meta.url),
  "utf8",
);

test("only the exact worker path bypasses the proxy session gate", () => {
  assert.equal(PUBLIC_API_PATHS.includes("/api/generation/worker"), true);
  assert.equal(apiSessionDecision("/api/generation/worker", false), "allow");
  assert.equal(apiSessionDecision("/api/generation/worker/", false), "unauthenticated");
  assert.equal(apiSessionDecision("/api/generation/worker/run", false), "unauthenticated");
  assert.equal(apiSessionDecision("/api/generation/workers", false), "unauthenticated");
  assert.equal(apiSessionDecision("/api/generation", false), "unauthenticated");
});

test("the route is a bounded Node function that accepts POST and GET", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /export const maxDuration = 300/);
  assert.match(route, /export const POST = handle/);
  assert.match(route, /export const GET = handle/);
});

test("the route authenticates itself with a constant-time bearer secret", () => {
  assert.match(route, /timingSafeStringEqual\(bearerToken\(request\), config\.secret\)/);
  assert.match(route, /\/\^Bearer\\s\+\(\.\+\)\$\/i/);
  assert.match(route, /code: "UNAUTHORIZED"/);
  assert.match(route, /status: 401/);
});

test("a disabled worker is invisible and an incomplete one fails closed", () => {
  assert.match(route, /if \(!config\.requested\) return json\(\{ ok: false \}, 404\)/);
  assert.match(route, /if \(!config\.ready \|\| !config\.secret\)/);
  assert.match(route, /code: "BACKEND_NOT_CONFIGURED"/);
  assert.match(route, /status: 503/);
});

test("the route returns only non-sensitive outcome fields and no cache", () => {
  assert.match(route, /const NO_STORE = "private, no-store, max-age=0"/);
  for (const field of ["runId", "errorClass", "retryAfterSeconds", "reason", "recovered"]) {
    assert.equal(route.includes(field), true, `missing ${field}`);
  }
  assert.equal(route.includes("result.prompt"), false);
  assert.equal(route.includes("error_message"), false);
  assert.equal(route.includes("response.text()"), false);
  assert.equal(route.includes("console.log"), false);
});

test("one call performs recovery, a schema preflight, a claim, verification and renewal", () => {
  assert.match(worker, /runGenerationWorkerOnce/);
  assert.match(worker, /generationWorkerSchemaVersion/);
  assert.match(worker, /isWorkerSchemaReady/);
  assert.match(worker, /recoverExpiredGenerationLeases/);
  assert.match(worker, /claimWorkerJob/);
  assert.match(worker, /parseClaimResult/);
  assert.match(worker, /verifyClaimedProject/);
  assert.match(worker, /renewWorkerLease/);
  assert.match(worker, /startLeaseRenewal/);
  assert.match(worker, /generation\.claimed/);
  assert.match(worker, /generation\.lease_recovered/);
  assert.match(worker, /generation\.worker_unavailable/);
});
