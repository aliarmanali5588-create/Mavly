import { test } from "node:test";
import assert from "node:assert/strict";

import { serveTenantRequest } from "../src/lib/hosting/serve";
import type {
  TenantServeDependencies,
  TenantServeInput,
} from "../src/lib/hosting/serve";
import type { ResolvedPublishedTenant, StoredPublishedFile } from "../src/lib/hosting/store";

/**
 * ═══ SERVING IS GATED BY BOTH PUBLICATION AND THE OPERATOR COHORT ═══════════
 *
 * The public resolver proves that a version is published. It does not know
 * whether the operator still wants Mavly to serve that project. These tests pin
 * the runtime's second gate and its status policy, using injected fakes because
 * this repository has no local Supabase harness.
 *
 * ⚠️ The resolver itself (hostname → active version, with no draft leak) is SQL
 * and is pinned in `shared-hosting-attempt-state-migration.test.ts`.
 */

const PROJECT_A = "proj-alpha";
const PROJECT_B = "proj-beta";
const HOST_A = `${PROJECT_A}.mavly.xyz`;
const HOST_B = `${PROJECT_B}.mavly.xyz`;

function tenant(projectId: string, host: string): ResolvedPublishedTenant {
  return {
    projectId,
    versionId: `version-${projectId}`,
    publishedAt: "2026-01-01T00:00:00.000Z",
    contentHash: `hash-${projectId}`,
    entryPath: "index.html",
    spaFallback: false,
  };
}

function file(path: string): StoredPublishedFile {
  return {
    path,
    content: `<h1>${path}</h1>`,
    contentType: "text/html; charset=utf-8",
    sha256: `sha-${path}`,
  };
}

interface HarnessOptions {
  host?: string | null;
  segments?: readonly string[];
  method?: string;
  runtimeEnabled?: boolean;
  eligible?: (projectId: string) => boolean;
  resolve?: TenantServeDependencies["resolveTenant"];
  read?: TenantServeDependencies["readFile"];
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<{ kind: string; value?: unknown }> = [];

  const deps: TenantServeDependencies = {
    runtimeEnabled: () => {
      calls.push({ kind: "runtimeEnabled" });
      return options.runtimeEnabled ?? true;
    },
    projectEligible: (projectId) => {
      calls.push({ kind: "projectEligible", value: projectId });
      return options.eligible ? options.eligible(projectId) : true;
    },
    resolveTenant: async (hostname) => {
      calls.push({ kind: "resolveTenant", value: hostname });
      if (options.resolve) return options.resolve(hostname);
      if (hostname === HOST_A) return { ok: true, data: tenant(PROJECT_A, HOST_A) };
      if (hostname === HOST_B) return { ok: true, data: tenant(PROJECT_B, HOST_B) };
      return { ok: true, data: null };
    },
    readFile: async (hostname, versionId, path) => {
      calls.push({ kind: "readFile", value: { hostname, versionId, path } });
      if (options.read) return options.read(hostname, versionId, path);
      return { ok: true, data: file(path) };
    },
    log: () => {},
  };

  const input: TenantServeInput = {
    host: options.host === undefined ? HOST_A : options.host,
    segments: options.segments ?? [],
    method: options.method ?? "GET",
  };

  return { deps, input, calls };
}

function kinds(calls: Array<{ kind: string }>): string[] {
  return calls.map((call) => call.kind);
}

test("an eligible published tenant is served from its active version", async () => {
  const h = harness();
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 200);
  assert.equal(response.body, "<h1>index.html</h1>");
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");

  const read = h.calls.find((call) => call.kind === "readFile");
  assert.deepEqual(read?.value, {
    hostname: HOST_A,
    versionId: `version-${PROJECT_A}`,
    path: "index.html",
  });
});

test("removing a project from the cohort stops its host without names", async () => {
  const h = harness({ eligible: (projectId) => projectId !== PROJECT_A });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 404);
  assert.equal(response.body, "This site is not published.");
  assert.equal(kinds(h.calls).includes("readFile"), false);
  assert.equal(response.body.includes(PROJECT_A), false);
});

test("a cohort removal for one project leaves another eligible project serving", async () => {
  const eligible = (projectId: string) => projectId !== PROJECT_A;

  const removed = harness({ host: HOST_A, eligible });
  assert.equal((await serveTenantRequest(removed.input, removed.deps)).status, 404);

  const kept = harness({ host: HOST_B, eligible });
  const response = await serveTenantRequest(kept.input, kept.deps);
  assert.equal(response.status, 200);
});

test("turning the shared runtime off answers 404 before resolution", async () => {
  const h = harness({ runtimeEnabled: false });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 404);
  assert.equal(kinds(h.calls).includes("resolveTenant"), false);
  assert.equal(kinds(h.calls).includes("readFile"), false);
});

test("a resolver/database failure is a 503, never a 404", async () => {
  const h = harness({
    resolve: async () => ({ ok: false, error: "connection reset", code: "08006" }),
  });

  const response = await serveTenantRequest(h.input, h.deps);
  assert.equal(response.status, 503);
  assert.equal(response.body, "This site is temporarily unavailable.");
});

test("a failed file read is a 503, never an unpublished site", async () => {
  const h = harness({
    read: async () => ({ ok: false, error: "timeout", code: "57014" }),
  });

  const response = await serveTenantRequest(h.input, h.deps);
  assert.equal(response.status, 503);
});

test("a malformed, reserved or deeper host never reaches the resolver", async () => {
  for (const host of [
    null,
    "mavly.xyz",
    "www.mavly.xyz",
    "a.b.mavly.xyz",
    "proj-alpha.example.com",
    "proj-alpha.mavly.xyz.evil.test",
  ]) {
    const h = harness({ host });
    const response = await serveTenantRequest(h.input, h.deps);
    assert.equal(response.status, 404, `host ${String(host)}`);
    assert.equal(kinds(h.calls).includes("resolveTenant"), false, `host ${String(host)}`);
  }
});

test("an unresolved tenant is 404 and is never given a default site", async () => {
  const h = harness({ host: "not-published.mavly.xyz" });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 404);
  assert.equal(kinds(h.calls).includes("readFile"), false);
});

test("HEAD returns the headers and no body for a served file", async () => {
  const h = harness({ method: "HEAD" });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 200);
  assert.equal(response.body, "");
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
});

test("a non-read method is refused before host parsing", async () => {
  const h = harness({ method: "POST", host: null });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET, HEAD");
  assert.deepEqual(kinds(h.calls), []);
});
