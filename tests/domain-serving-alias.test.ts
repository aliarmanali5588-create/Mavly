import { test } from "node:test";
import assert from "node:assert/strict";

import {
  serveTenantRequest,
  type TenantServeDependencies,
  type TenantServeInput,
} from "../src/lib/hosting/serve";
import type { ResolvedPublishedTenant } from "../src/lib/hosting/store";

/**
 * ═══ ALIAS SERVING — `<slug>.mavly.xyz` ON THE NEXT RUNTIME ═════════════════
 *
 * `resolve_published_tenant` matches the canonical `<project-id>.mavly.xyz`
 * hostname only. A human-readable alias is an additive domain row, so it
 * resolves to nothing there. Without a fallback the alias 404s on the Next
 * runtime while CloudFront's wildcard serves it — a split-brain where the same
 * URL works or fails depending on which edge answered.
 *
 * These tests pin the fallback, and pin that it cannot bypass the cohort
 * off-switch or turn an infrastructure failure into a "not published" 404.
 */

const PROJECT = "proj-alpha";
const ALIAS = "my-portfolio.mavly.xyz";
const CANONICAL = `${PROJECT}.mavly.xyz`;

function version(hostname: string): ResolvedPublishedTenant {
  return {
    projectId: PROJECT,
    versionId: `version-${PROJECT}`,
    publishedAt: null,
    contentHash: "",
    entryPath: "index.html",
    spaFallback: false,
  };
}

interface Options {
  host?: string;
  eligible?: boolean;
  canonical?: ResolvedPublishedTenant | null;
  alias?: ResolvedPublishedTenant | null;
  aliasFailure?: { error: string; code: string };
  canonicalFailure?: { error: string; code: string };
  aliasFile?: { ok: true; data: null } | { ok: false; error: string; code: string };
}

function harness(options: Options = {}) {
  const calls: string[] = [];
  const deps: TenantServeDependencies = {
    runtimeEnabled: () => true,
    projectEligible: () => options.eligible ?? true,
    resolveTenant: async (hostname) => {
      calls.push(`resolveTenant:${hostname}`);
      if (options.canonicalFailure) return { ok: false, ...options.canonicalFailure };
      return { ok: true, data: options.canonical ?? null };
    },
    resolveAlias: async (hostname) => {
      calls.push(`resolveAlias:${hostname}`);
      if (options.aliasFailure) return { ok: false, ...options.aliasFailure };
      return { ok: true, data: options.alias ?? null };
    },
    readFile: async (_hostname, _versionId, path) => {
      calls.push(`readFile:${path}`);
      return {
        ok: true,
        data: {
          path,
          content: `<h1>${path}</h1>`,
          contentType: "text/html; charset=utf-8",
          sha256: "sha",
        },
      };
    },
    readAliasFile: async (_hostname, _versionId, path) => {
      calls.push(`readAliasFile:${path}`);
      if (options.aliasFile) {
        if (!options.aliasFile.ok) return options.aliasFile;
        return { ok: true, data: null };
      }
      return {
        ok: true,
        data: {
          path,
          content: `<h1>alias:${path}</h1>`,
          contentType: "text/html; charset=utf-8",
          sha256: "sha",
        },
      };
    },
    log: () => {},
  };
  const input: TenantServeInput = {
    host: options.host ?? ALIAS,
    segments: [],
    method: "GET",
  };
  return { deps, input, calls };
}

test("an active alias is served through the domain resolver", async () => {
  const h = harness({ alias: version(ALIAS) });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 200);
  assert.equal(response.body, "<h1>alias:index.html</h1>");
  assert.ok(h.calls.includes(`resolveAlias:${ALIAS}`));
  assert.ok(h.calls.includes("readAliasFile:index.html"));
  // The canonical read RPC re-resolves through the canonical-only function and
  // would return nothing for an alias, so it must not be used here.
  assert.equal(h.calls.some((call) => call.startsWith("readFile:")), false);
});

test("an alias cannot bypass the shared-hosting cohort off-switch", async () => {
  const h = harness({ alias: version(ALIAS), eligible: false });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 404);
  assert.equal(h.calls.some((call) => call.startsWith("readAliasFile:")), false);
});

test("an inactive or unverified alias is 404, never a default site", async () => {
  const h = harness({ alias: null });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 404);
  assert.equal(h.calls.some((call) => call.startsWith("readAliasFile:")), false);
});

test("an alias resolver failure is 503, never 404", async () => {
  const h = harness({ aliasFailure: { error: "connection reset", code: "08006" } });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(
    response.status,
    503,
    "an infrastructure failure must not tell a visitor the site is unpublished",
  );
});

test("an alias whose file read fails is 503, never 404", async () => {
  const h = harness({
    alias: version(ALIAS),
    aliasFile: { ok: false, error: "timeout", code: "57014" },
  });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 503);
});

test("the canonical hostname never consults the alias resolver", async () => {
  const h = harness({ host: CANONICAL, canonical: version(CANONICAL) });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 200);
  assert.equal(h.calls.some((call) => call.startsWith("resolveAlias:")), false);
  assert.ok(h.calls.includes("readFile:index.html"));
});

test("a canonical host that does not resolve may fall back to an alias row", async () => {
  /**
   * A project id can itself be a valid alias label, and an operator may attach
   * an alias that looks canonical. The fallback is safe because the alias
   * resolver re-checks the active/ready/certificate gate for that exact
   * hostname; it is not a widening of the canonical contract.
   */
  const h = harness({ host: CANONICAL, canonical: null, alias: version(CANONICAL) });
  const response = await serveTenantRequest(h.input, h.deps);

  assert.equal(response.status, 200);
  assert.ok(h.calls.includes("readAliasFile:index.html"));
});
