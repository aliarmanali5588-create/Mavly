import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deleteVercelDeployment,
  listVercelProductionDeployments,
  removeVercelProjectDomain,
} from "../src/lib/vercel/provider";
import type { VercelDeploymentConfig } from "../src/lib/vercel/config";
import { publicDeploymentFailure } from "../src/lib/deployments/vercel-failure";
import { isDeploymentRowStale } from "../src/lib/deployments/store";
import type { DeploymentRow } from "../src/lib/deployments/store";

/**
 * ═══ UNPUBLISH IS A REMOTE OPERATION, NOT A LOCAL FLAG ══════════════════════
 *
 * These tests pin the two halves that can be verified without a live Vercel
 * account or a Supabase session:
 *
 *   · the exact requests used to detach a project domain and remove production
 *     deployments (method, fixed origin, encoded identifiers, no token in a URL);
 *   · the failure wording and the pure state helpers that decide whether a
 *     stuck `unpublishing` claim may be retried.
 *
 * Nothing here performs a real takedown. `MAVLY_VERCEL_DEPLOYMENTS.md` records
 * the human-run integration check for that.
 */

const CONFIG: VercelDeploymentConfig = {
  token: "tok_do_not_log",
  teamId: null,
  projectPrefix: "mavly",
};

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

type CapturedCalls = CapturedCall[] & { restore: () => void };

function fakeResponse(status: number, body: string | null = "", headers: Record<string, string> = {}) {
  // `Response` rejects any body (including "") on a null-body status.
  const payload = status === 204 || status === 205 || status === 304 ? null : body;
  return new Response(payload, { status, headers });
}

function captureFetch(
  input: Array<{ status: number; body?: string | null; headers?: Record<string, string> }>,
): CapturedCalls {
  const calls = [] as CapturedCall[];
  const original = globalThis.fetch;
  let index = 0;

  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const entry = input[Math.min(index, input.length - 1)];
    index += 1;
    calls.push({
      url: String(request),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return fakeResponse(entry.status, entry.body ?? null, entry.headers);
  }) as typeof fetch;

  return Object.assign(calls, {
    restore: () => {
      globalThis.fetch = original;
    },
  }) as CapturedCalls;
}

test("detaching the Mavly domain is a DELETE against the fixed Vercel origin", async () => {
  const calls = captureFetch([{ status: 204 }]);
  try {
    const result = await removeVercelProjectDomain(
      CONFIG,
      "prj_abc123",
      "create-a-login-page-5c63f.mavly.xyz",
    );

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://api.vercel.com/v9/projects/prj_abc123/domains/create-a-login-page-5c63f.mavly.xyz",
    );
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].headers.authorization, "Bearer tok_do_not_log");
    // The credential never becomes part of the URL or a query parameter.
    assert.equal(calls[0].url.includes("tok_do_not_log"), false);
  } finally {
    calls.restore();
  }
});

test("detaching an already-detached domain is idempotent (404 is success)", async () => {
  const calls = captureFetch([{ status: 404, body: "" }]);
  try {
    const result = await removeVercelProjectDomain(CONFIG, "prj_abc123", "site.mavly.xyz");
    assert.equal(result.ok, true);
  } finally {
    calls.restore();
  }
});

test("a refused domain detach is a provider failure, never a silent success", async () => {
  const calls = captureFetch([
    { status: 500, body: JSON.stringify({ error: { code: "internal", message: "boom" } }) },
  ]);
  try {
    const result = await removeVercelProjectDomain(CONFIG, "prj_abc123", "site.mavly.xyz");
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.failure.status, 500);
      assert.equal(result.failure.code, "internal");
    }
  } finally {
    calls.restore();
  }
});

test("removing a deployment is a DELETE and treats 404 as already gone", async () => {
  const calls = captureFetch([{ status: 404, body: "" }]);
  try {
    const result = await deleteVercelDeployment(CONFIG, "dpl_old");
    assert.equal(result.ok, true);
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].url, "https://api.vercel.com/v13/deployments/dpl_old");
  } finally {
    calls.restore();
  }
});

test("the production deployment list is scoped to one project and accepts id or uid", async () => {
  const calls = captureFetch([
    {
      status: 200,
      body: JSON.stringify({
        deployments: [
          { id: "dpl_new", readyState: "READY" },
          { uid: "dpl_legacy", readyState: "READY" },
          { name: "missing-an-id" },
        ],
      }),
    },
  ]);
  try {
    const result = await listVercelProductionDeployments(CONFIG, "prj_abc123");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.data, ["dpl_new", "dpl_legacy"]);

    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /^https:\/\/api\.vercel\.com\/v6\/deployments\?/);
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("projectId"), "prj_abc123");
    assert.equal(url.searchParams.get("target"), "production");
    assert.equal(url.searchParams.get("limit"), "100");
  } finally {
    calls.restore();
  }
});

test("unpublish failures are worded for a takedown, not a publish", () => {
  const limited = publicDeploymentFailure(
    { status: 429, code: "rate_limited", message: "slow down", retryAfterSeconds: 7 },
    "unpublish",
  );
  assert.equal(limited.status, 429);
  assert.match(limited.error, /unpublish/i);
  assert.equal(limited.retryAfterSeconds, 7);

  const rejected = publicDeploymentFailure(
    { status: 400, code: "invalid_request", message: "Domain is not attached." },
    "unpublish",
  );
  assert.equal(rejected.status, 400);
  assert.equal(rejected.code, "VALIDATION");
  assert.equal(rejected.error, "Domain is not attached.");

  const unavailable = publicDeploymentFailure(
    { status: 502, code: "bad_gateway", message: "upstream" },
    "unpublish",
  );
  assert.equal(unavailable.status, 502);
  assert.match(unavailable.error, /unpublish/i);
});

test("an unpublish authorization failure never leaks the upstream message", () => {
  const denied = publicDeploymentFailure(
    { status: 403, code: "forbidden", message: "team_secret does not own this project" },
    "unpublish",
  );

  assert.equal(denied.status, 503);
  assert.equal(denied.code, "BACKEND_NOT_CONFIGURED");
  assert.equal(denied.error.includes("team_secret"), false);
});

function row(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    project_id: "create-a-login-page-5c63f",
    provider: "vercel",
    vercel_project_id: "prj_abc123",
    vercel_project_name: "mavly-create-a-login-page-5c63f-1a2b3c4d",
    vercel_deployment_id: "dpl_old",
    status: "ready",
    url: "old-deployment.vercel.app",
    error_code: null,
    error_message: null,
    mavly_hostname: "create-a-login-page-5c63f.mavly.xyz",
    mavly_domain_status: "verified",
    mavly_domain_error: null,
    mavly_domain_checked_at: "2026-10-25T00:00:00.000Z",
    created_at: "2026-10-24T00:00:00.000Z",
    updated_at: new Date().toISOString(),
    last_published_at: "2026-10-25T00:00:00.000Z",
    last_unpublished_at: null,
    ...overrides,
  };
}

test("a fresh unpublish claim is not stale; an abandoned one is retryable", () => {
  assert.equal(isDeploymentRowStale(row({ status: "unpublishing" })), false);

  const abandoned = row({
    status: "unpublishing",
    updated_at: new Date(Date.now() - 16 * 60_000).toISOString(),
  });
  assert.equal(isDeploymentRowStale(abandoned), true);
});
