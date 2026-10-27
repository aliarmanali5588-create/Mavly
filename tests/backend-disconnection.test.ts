import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { GET as configGet } from "../src/app/api/config/route";
import { backendNotConfigured } from "../src/app/api/vcaas/_shared";
import { isVcaasErrorCode } from "../src/lib/vcaas-errors";

/**
 * ═══ THE BACKEND BOUNDARY ══════════════════════════════════════════════════
 *
 * Mavly now has one local builder backend (FreeModel + Supabase) plus the
 * unchanged explicit 503 for everything else. These tests pin the boundary:
 *
 *  · Totalum stays removed, and no runtime reads its key or host;
 *  · unimplemented paths still answer the agreed 503;
 *  · generated code is stored as text, never executed;
 *  · the preview is sandboxed and provider keys stay server-only.
 *
 * Authentication and ownership are covered by `api-guards.test.ts` and
 * `route-authorization.test.ts`.
 */

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const FORBIDDEN_TOTALUM_RUNTIME = [
  "builder-api.totalum.app",
  "api-accounts.totalum.app",
  "TOTALUM_VCAAS_API_KEY",
  "VCAAS_API_KEY",
  "getVcaasApiKey",
  "vcaasRequest",
  "vcaasUploadRequest",
  "TOTALUM_API_ORIGIN",
];

function serverFiles(): string[] {
  return [
    ...(readdirSync(new URL("src/app/api", root), { recursive: true }) as string[])
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
      .map((entry) => `src/app/api/${entry.replaceAll("\\", "/")}`),
    ...(readdirSync(new URL("src/lib", root), { recursive: true }) as string[])
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
      .map((entry) => `src/lib/${entry.replaceAll("\\", "/")}`),
    "src/proxy.ts",
  ];
}

// ── The controlled response ────────────────────────────────────────────────

test("the unimplemented response is a 503 with the agreed code and message", async () => {
  const res = backendNotConfigured();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "private, no-store, max-age=0");

  const body = (await res.json()) as {
    ok: boolean;
    error: string;
    code: string;
    data: unknown;
  };
  assert.equal(body.ok, false);
  assert.equal(body.code, "BACKEND_NOT_CONFIGURED");
  assert.equal(body.error, "The Mavly backend is not implemented yet.");
  assert.equal(body.data, null);
});

test("BACKEND_NOT_CONFIGURED belongs to the client's stable error vocabulary", () => {
  assert.equal(isVcaasErrorCode("BACKEND_NOT_CONFIGURED"), true);
});

test("/api/config answers configured:false without exposing a secret", async () => {
  const res = configGet();
  const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body.data), ["configured"]);
  assert.equal(body.data.configured, false, "the public config flag stays unchanged");
  assert.equal(/tlm_sk_|sb_secret|eyJ[A-Za-z0-9_-]{10,}/.test(JSON.stringify(body)), false);
});

// ── Totalum remains removed ────────────────────────────────────────────────

test("the Totalum server client stays deleted", () => {
  assert.equal(existsSync(new URL("src/lib/vcaas-server.ts", root)), false);
});

test("server-side runtime never names a Totalum host or key", () => {
  for (const file of serverFiles()) {
    if (!existsSync(new URL(file, root))) continue;
    const source = read(file);
    for (const token of FORBIDDEN_TOTALUM_RUNTIME) {
      assert.equal(
        source.includes(token),
        false,
        `${file} must not reference ${JSON.stringify(token)}`,
      );
    }
  }
});

test("the proxy no longer trusts any Totalum host for CORS", () => {
  assert.equal(read("src/proxy.ts").includes("totalum-project.com"), false);
});

// ── The local builder boundary ─────────────────────────────────────────────

test("FreeModel is the active website-generation provider and its key stays server-only", () => {
  const files = [
    ...(readdirSync(new URL("src", root), { recursive: true }) as string[])
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
      .map((entry) => `src/${entry.replaceAll("\\", "/")}`),
  ].filter((file) => existsSync(new URL(file, root)));

  for (const file of files) {
    const source = read(file);
    assert.equal(
      source.includes("NEXT_PUBLIC_GROQ"),
      false,
      `${file} must not make the FreeModel key public`,
    );
    if (file.endsWith(".tsx")) {
      assert.equal(
        source.includes("GROQ_API_KEY"),
        false,
        `${file} is a component and must not read the FreeModel server key`,
      );
    }
  }

  assert.equal(read("src/lib/ai/groq.ts").includes("GROQ_API_KEY"), true);
  assert.equal(read("src/lib/ai/groq.ts").includes("console."), false);
  assert.equal(read("src/lib/ai/agent.ts").includes('"./provider"'), true);
  assert.equal(read("src/lib/mavly/run-agent.ts").includes("@/lib/ai/provider"), true);
  assert.equal(read("src/lib/mavly/run-agent.ts").includes("@/lib/ai/openrouter"), false);
  assert.equal(read("src/lib/mavly/api.ts").includes('from "@/lib/ai/provider"'), true);
  assert.equal(read("src/lib/ai/provider.ts").includes('from "./groq"'), true);
  assert.equal(read("src/lib/ai/provider.ts").includes('from "./openrouter"'), false);
  assert.equal(read("src/lib/ai/openrouter.ts").includes("OPENROUTER_API_KEY"), true);
  assert.equal(read("src/lib/ai/openrouter-images.ts").includes("OPENROUTER_API_KEY"), true);
  assert.equal(existsSync(new URL("src/lib/ai/openrouter.ts", root)), true);
});

test("the AI modules do not execute generated output", () => {
  for (const file of ["src/lib/ai/agent.ts", "src/lib/ai/groq.ts", "src/lib/mavly/run-agent.ts"]) {
    const source = read(file);
    for (const dangerous of ["eval(", "new Function(", "child_process", "execSync("]) {
      assert.equal(source.includes(dangerous), false, `${file} must not use ${dangerous}`);
    }
  }
});

test("the catch-all still falls back to the explicit 503", () => {
  const source = read("src/app/api/vcaas/[...path]/route.ts");
  assert.equal(source.includes("handleMavlyVcaasRequest"), true);
  assert.equal(source.includes("return backendNotConfigured()"), true);
});

test("the proxy does not overwrite the preview CSP", () => {
  const proxy = read("src/proxy.ts");
  assert.equal(proxy.includes('pathname.startsWith("/api/preview/")'), true);
});

test("the preview is opaque-origin and cannot call Mavly APIs", () => {
  const source = read("src/app/api/preview/[projectId]/[[...path]]/route.ts");
  assert.equal(source.includes("sandbox allow-scripts"), true);
  assert.equal(source.includes("allow-same-origin"), false, "the CSP must not grant same-origin");
  assert.equal(source.includes("connect-src 'none'"), true);
  assert.equal(source.includes("frame-ancestors 'self'"), true);
  assert.equal(source.includes("authorizeProjectRequest"), true);
});

test("the source ZIP and preview authorize before reading project files", () => {
  for (const file of [
    "src/app/api/vcaas/source-code/[projectId]/route.ts",
    "src/app/api/preview/[projectId]/[[...path]]/route.ts",
  ]) {
    const source = read(file);
    const authAt = source.indexOf("authorizeProjectRequest");
    const readAt = source.indexOf("getFile(") >= 0 ? source.indexOf("getFile(") : source.indexOf("listFiles(");
    assert.ok(authAt > 0, `${file} must call the guard`);
    assert.ok(readAt > authAt, `${file} must authorize before reading project files`);
  }
});
