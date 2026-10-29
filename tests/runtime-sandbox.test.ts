import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  isProjectInRuntimeCohort,
  parseRuntimeSandboxConfig,
  type RuntimeEnvironment,
  type RuntimeSandboxConfig,
} from "../src/lib/runtime-sandbox/config";
import {
  buildCommand,
  commandLine,
  detectRuntimeProject,
  devServerCommand,
  installCommand,
  isReadyStatus,
  moduleEntryFromHtml,
  previewHostFromUrl,
  previewUrlFromProvider,
  sanitizeTerminalOutput,
} from "../src/lib/runtime-sandbox/policy";
import {
  planProjectSync,
  projectPathRejection,
  type SyncSourceFile,
} from "../src/lib/runtime-sandbox/paths";
import {
  canTransitionRuntimeState,
  type RuntimeCheck,
  type RuntimeSandboxProvider,
  type RuntimeSandboxRecord,
} from "../src/lib/runtime-sandbox/types";
import {
  getRuntimeSandboxStatus,
  runRuntimeBuildCheck,
  sourceHashForFiles,
  startRuntimeSandbox,
  stopRuntimeSandbox,
  type RuntimeFileLoader,
  type RuntimeServiceDeps,
} from "../src/lib/runtime-sandbox/service";
import {
  runtimeChecksFor,
  runtimeEvidenceFromRecord,
  runtimeEvidenceForPrompt,
  runtimeEvidenceMatchesSource,
  runtimeRepairSummary,
} from "../src/lib/runtime-sandbox/evidence";
import type {
  BeginRuntimeSandboxAnswer,
  BeginRuntimeSandboxInput,
  RuntimeSandboxStore,
  RuntimeStoreResult,
  UpdateRuntimeSandboxInput,
} from "../src/lib/runtime-sandbox/store";

/**
 * ═══ LIVE RUNTIME SANDBOX — PURE AND MOCKED ════════════════════════════════
 *
 * Nothing here creates a real E2B sandbox, touches Supabase or runs generated
 * code. The lifecycle is exercised through the same injected seam the routes
 * use: an in-memory store, a mocked provider, a fake readiness probe and a
 * fixed clock.
 *
 * ⚠️ THE REAL E2B ADAPTER IS NOT EXERCISED HERE. The tests prove Mavly's
 * decisions around it (fixed commands, path safety, readiness rules, cleanup);
 * they do not prove the vendor accepts them.
 */

const NOW = Date.parse("2026-10-29T12:00:00.000Z");

function env(overrides: RuntimeEnvironment = {}): RuntimeEnvironment {
  return {
    MAVLY_RUNTIME_SANDBOX_ENABLED: "on",
    MAVLY_RUNTIME_SANDBOX_PROJECTS: "demo-site",
    E2B_API_KEY: "e2b_test_key_value",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    ...overrides,
  };
}

function config(overrides: RuntimeEnvironment = {}): RuntimeSandboxConfig {
  return parseRuntimeSandboxConfig(env(overrides));
}

function projectFiles(overrides: Partial<Record<string, string>> = {}): SyncSourceFile[] {
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "demo",
        private: true,
        scripts: { dev: "vite", build: "vite build" },
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { vite: "^7.0.0", "@vitejs/plugin-react": "^4.0.0" },
      }),
    },
    { path: "package-lock.json", content: "{}" },
    {
      path: "index.html",
      content:
        '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    },
    { path: "src/main.tsx", content: "export const ok = true;\n" },
    { path: "src/App.tsx", content: "export default function App() { return null; }\n" },
    { path: "node_modules/evil.js", content: "process.exit(1)" },
    { path: ".env", content: "SECRET=value" },
    { path: "README.md", content: "# Demo\n" },
  ].map((file) => ({
    path: file.path,
    content: overrides[file.path] ?? file.content,
  }));
}

function baseRecord(overrides: Partial<RuntimeSandboxRecord> = {}): RuntimeSandboxRecord {
  return {
    id: randomUUID(),
    projectId: "demo-site",
    runId: null,
    provider: "e2b",
    sandboxId: "sandbox_abc123",
    framework: "react_vite",
    state: "ready",
    sourceHash: "a".repeat(64),
    syncedPaths: ["package.json", "index.html"],
    port: 5173,
    previewUrl: "https://5173-sandbox.e2b.app",
    failureCode: null,
    failureReason: null,
    logs: "ready",
    diagnostics: { devPid: 42, healthHttpStatus: 200 },
    installMs: 1_000,
    startupMs: 500,
    commandCount: 2,
    maxLifetimeSeconds: 1800,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastActivityAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
    stoppedAt: null,
    ...overrides,
  };
}

class MemoryStore implements RuntimeSandboxStore {
  version: number | null = 34;
  rows: RuntimeSandboxRecord[] = [];
  beginOverride: RuntimeStoreResult<BeginRuntimeSandboxAnswer> | null = null;
  updateCalls: UpdateRuntimeSandboxInput[] = [];

  async schemaVersion(): Promise<number | null> {
    return this.version;
  }

  async latest(projectId: string): Promise<RuntimeStoreResult<RuntimeSandboxRecord | null>> {
    const rows = this.rows
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { ok: true, data: rows.length ? rows[rows.length - 1] : null };
  }

  async begin(
    input: BeginRuntimeSandboxInput,
  ): Promise<RuntimeStoreResult<BeginRuntimeSandboxAnswer>> {
    if (this.beginOverride) return this.beginOverride;
    const active = this.rows.find(
      (row) =>
        row.projectId === input.projectId &&
        ["provisioning", "syncing", "installing", "starting", "ready", "stopping"].includes(
          row.state,
        ),
    );
    if (active) return { ok: true, data: { created: false, record: active } };
    const record = baseRecord({
      id: randomUUID(),
      projectId: input.projectId,
      sandboxId: null,
      state: "provisioning",
      sourceHash: input.sourceHash,
      syncedPaths: [],
      port: null,
      previewUrl: null,
      logs: "",
      diagnostics: {},
      installMs: null,
      startupMs: null,
      commandCount: 0,
      maxLifetimeSeconds: input.maxLifetimeSeconds,
      expiresAt: new Date(NOW + input.maxLifetimeSeconds * 1000).toISOString(),
    });
    this.rows.push(record);
    return { ok: true, data: { created: true, record } };
  }

  async update(
    input: UpdateRuntimeSandboxInput,
  ): Promise<RuntimeStoreResult<RuntimeSandboxRecord>> {
    this.updateCalls.push(input);
    const index = this.rows.findIndex((row) => row.id === input.id);
    if (index === -1) return { ok: false, error: "not found", code: "NOT_FOUND" };
    const current = this.rows[index];
    const next: RuntimeSandboxRecord = {
      ...current,
      state: input.state ?? current.state,
      sandboxId: input.sandboxId ?? current.sandboxId,
      port: input.port ?? current.port,
      previewUrl: input.previewUrl ?? current.previewUrl,
      failureCode: input.failureCode ?? current.failureCode,
      failureReason: input.failureReason ?? current.failureReason,
      logs: input.logs ?? current.logs,
      diagnostics: input.diagnostics ?? current.diagnostics,
      syncedPaths: input.syncedPaths ?? current.syncedPaths,
      installMs: input.installMs ?? current.installMs,
      startupMs: input.startupMs ?? current.startupMs,
      updatedAt: new Date(NOW).toISOString(),
      lastActivityAt: new Date(NOW).toISOString(),
      stoppedAt:
        input.state && ["stopped", "expired", "failed"].includes(input.state)
          ? new Date(NOW).toISOString()
          : current.stoppedAt,
    };
    this.rows[index] = next;
    return { ok: true, data: next };
  }

  async stop(
    projectId: string,
    id: string,
  ): Promise<RuntimeStoreResult<RuntimeSandboxRecord | null>> {
    const row = this.rows.find((entry) => entry.id === id && entry.projectId === projectId);
    if (!row) return { ok: true, data: null };
    if (["stopped", "expired", "failed"].includes(row.state)) return { ok: true, data: row };
    row.state = "stopping";
    return { ok: true, data: row };
  }
}

interface MockProvider {
  provider: RuntimeSandboxProvider;
  calls: {
    create: number;
    write: number;
    run: string[];
    startBackground: number;
    destroy: number;
    denyEgress: number;
  };
  setAlive(alive: boolean): void;
  setProcessExit(afterCalls: number): void;
  setInstallExit(code: number): void;
}

function mockProvider(
  options: {
    host?: string;
    installExit?: number;
    alive?: boolean;
  } = {},
): MockProvider {
  let alive = options.alive ?? true;
  let exitAfter = Number.POSITIVE_INFINITY;
  let processCalls = 0;
  let installExit = options.installExit ?? 0;
  const calls = {
    create: 0,
    write: 0,
    run: [] as string[],
    startBackground: 0,
    destroy: 0,
    denyEgress: 0,
  };

  const provider: RuntimeSandboxProvider = {
    name: "e2b",
    async create() {
      calls.create += 1;
      return { ok: true, value: { sandboxId: "sandbox_abc123" } };
    },
    async connect() {
      return { ok: true, value: { sandboxId: "sandbox_abc123" } };
    },
    async isRunning() {
      return { ok: true, value: alive };
    },
    async writeFiles(_sandboxId, _directory, files) {
      calls.write += files.length;
      return { ok: true, value: { written: files.length } };
    },
    async removeFiles() {
      return { ok: true, value: { removed: 0 } };
    },
    async run(_sandboxId, command) {
      calls.run.push(commandLine(command));
      const exitCode = command.command.endsWith("vite") && command.args[0] === "build" ? 0 : installExit;
      return {
        ok: true,
        value: { exitCode, stdout: "installed", stderr: "", durationMs: 500 },
      };
    },
    async startBackground() {
      calls.startBackground += 1;
      return { ok: true, value: { pid: 4242 } };
    },
    async killProcess() {
      return { ok: true, value: true };
    },
    async listProcesses() {
      processCalls += 1;
      if (!alive || processCalls > exitAfter) return { ok: true, value: [] };
      return { ok: true, value: [{ pid: 4242, command: "vite" }] };
    },
    async readText() {
      return { ok: true, value: "VITE v7 ready in 412 ms" };
    },
    async previewHost() {
      return { ok: true, value: options.host ?? "5173-sandbox.e2b.app" };
    },
    async denyEgress() {
      calls.denyEgress += 1;
      return { ok: true, value: undefined };
    },
    async setLifetime() {
      return { ok: true, value: undefined };
    },
    async destroy() {
      calls.destroy += 1;
      return { ok: true, value: "deleted" };
    },
  };

  return {
    provider,
    calls,
    setAlive(value: boolean) {
      alive = value;
    },
    setProcessExit(afterCalls: number) {
      exitAfter = afterCalls;
    },
    setInstallExit(code: number) {
      installExit = code;
    },
  };
}

function deps(
  store: MemoryStore,
  provider: MockProvider,
  input: {
    probe?: () => Promise<{ status: number } | null>;
    files?: SyncSourceFile[];
    startupTimeoutMs?: number;
  } = {},
): RuntimeServiceDeps {
  const loader: RuntimeFileLoader = async () => ({
    ok: true,
    data: input.files ?? projectFiles(),
  });
  /**
   * A monotonic fake clock. A frozen one would make the readiness poll's
   * deadline unreachable, which is exactly the kind of test-only deadlock that
   * hides a timeout bug.
   */
  let clock = NOW;
  return {
    config: {
      ...config(),
      startupTimeoutMs: input.startupTimeoutMs ?? 40,
      installTimeoutMs: 5_000,
      idleSeconds: 600,
    },
    store,
    provider: provider.provider,
    loader,
    probe: input.probe ?? (async () => ({ status: 200 })),
    now: () => ++clock,
    pollIntervalMs: 1,
  };
}

// ── Configuration ───────────────────────────────────────────────────────────

test("runtime previews are off and not ready by default", () => {
  const parsed = parseRuntimeSandboxConfig({});
  assert.equal(parsed.requested, false);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.apiKey, null);
  assert.equal(parsed.problems.includes("disabled"), true);
});

test("a complete runtime configuration is ready", () => {
  const parsed = config({ MAVLY_RUNTIME_SANDBOX_PORT: "3000" });
  assert.equal(parsed.ready, true, parsed.problems.join(","));
  assert.equal(parsed.cohort[0], "demo-site");
  assert.equal(parsed.allowAllProjects, false);
  assert.equal(parsed.port, 3000);
  assert.equal(parsed.maxLifetimeSeconds, 1800);
  assert.equal(parsed.apiKey, "e2b_test_key_value");
});

test("an absent or empty project list enables every eligible project", () => {
  for (const value of [undefined, "", "   ", "*"]) {
    const parsed = config(
      value === undefined
        ? { MAVLY_RUNTIME_SANDBOX_PROJECTS: undefined }
        : { MAVLY_RUNTIME_SANDBOX_PROJECTS: value },
    );
    assert.equal(parsed.ready, true, `${String(value)}: ${parsed.problems.join(",")}`);
    assert.equal(parsed.allowAllProjects, true);
    assert.deepEqual(parsed.cohort, []);
    assert.equal(isProjectInRuntimeCohort("any-project", parsed), true);
    assert.equal(isProjectInRuntimeCohort("another-project", parsed), true);
  }
});

test("an explicit project list is an optional restriction, not a prerequisite", () => {
  const parsed = config({ MAVLY_RUNTIME_SANDBOX_PROJECTS: "demo-site;other-site" });
  assert.equal(parsed.ready, true, parsed.problems.join(","));
  assert.equal(parsed.allowAllProjects, false);
  assert.deepEqual(parsed.cohort, ["demo-site", "other-site"]);
  assert.equal(isProjectInRuntimeCohort("demo-site", parsed), true);
  assert.equal(isProjectInRuntimeCohort("a-third-site", parsed), false);
});

test("a malformed explicit project list is refused instead of guessed", () => {
  const parsed = config({ MAVLY_RUNTIME_SANDBOX_PROJECTS: "," });
  assert.equal(parsed.ready, false);
  assert.equal(parsed.problems.includes("invalid_cohort"), true);
});

test("out-of-range limits are refused, not silently clamped to a different number", () => {
  const parsed = config({
    MAVLY_RUNTIME_SANDBOX_MAX_LIFETIME_SECONDS: "7200",
    MAVLY_RUNTIME_SANDBOX_MAX_TOTAL_BYTES: "999999999",
  });
  assert.equal(parsed.ready, false);
  assert.equal(parsed.problems.includes("invalid_limit"), true);
  /** The fallback, not the rejected value: 7200 s exceeds the provider ceiling. */
  assert.equal(parsed.maxLifetimeSeconds, 1800);
  assert.equal(parsed.maxTotalBytes, 4 * 1024 * 1024);
});

test("a missing key, an invalid template and an invalid port are reported", () => {
  const parsed = config({
    E2B_API_KEY: "",
    MAVLY_RUNTIME_SANDBOX_TEMPLATE: "bad template!",
    MAVLY_RUNTIME_SANDBOX_PORT: "80",
  });
  assert.equal(parsed.ready, false);
  assert.equal(parsed.problems.includes("missing_api_key"), true);
  assert.equal(parsed.problems.includes("invalid_template"), true);
  assert.equal(parsed.problems.includes("invalid_port"), true);
  assert.equal(parsed.apiKey, null);
});

test("QA flags are separately opt-in and the cohort never splits on spaces", () => {
  const parsed = config({
    MAVLY_RUNTIME_SANDBOX_PROJECTS: "demo-site, Alpha App",
    MAVLY_RUNTIME_SANDBOX_QA_EVIDENCE: "on",
  });
  assert.equal(parsed.ready, false);
  assert.equal(parsed.problems.includes("invalid_cohort"), true);
  assert.equal(parsed.qaEvidence, true);
  assert.equal(parsed.qaBuild, false);
});

// ── Framework detection and commands ────────────────────────────────────────

test("a persisted React + Vite project is supported and its entry is resolved", () => {
  const support = detectRuntimeProject(projectFiles());
  assert.equal(support.supported, true);
  assert.equal(support.framework, "react_vite");
  assert.equal(support.hasLockfile, true);
  assert.equal(support.entryHtml, "index.html");
  assert.equal(moduleEntryFromHtml('<script type="module" src="/src/main.tsx"></script>'), "src/main.tsx");
});

test("a project without the declared Vite dependency is refused, not guessed", () => {
  const support = detectRuntimeProject(
    projectFiles({
      "package.json": JSON.stringify({ dependencies: { react: "19" } }),
    }),
  );
  assert.equal(support.supported, false);
  assert.equal(support.reason, "missing_vite_dependency");
  assert.match(support.detail ?? "", /React project/);
});

test("a Next.js project is classified by framework, not as a missing Vite dependency", () => {
  const withDependency = detectRuntimeProject(
    projectFiles({
      "package.json": JSON.stringify({
        dependencies: { next: "16", react: "19" },
      }),
    }),
  );
  assert.equal(withDependency.supported, false);
  assert.equal(withDependency.reason, "unsupported_framework");
  assert.match(withDependency.detail ?? "", /Next\.js/);

  const configOnly = detectRuntimeProject([
    ...projectFiles({
      "package.json": JSON.stringify({ dependencies: { next: "16" } }),
    }),
    { path: "next.config.ts", content: "export default {};\n" },
  ]);
  assert.equal(configOnly.reason, "unsupported_framework");
});

test("another non-Vite framework is named instead of reported as a Vite gap", () => {
  const support = detectRuntimeProject(
    projectFiles({
      "package.json": JSON.stringify({
        dependencies: { react: "19" },
        devDependencies: { "@sveltejs/kit": "2", vite: "7" },
      }),
    }),
  );
  assert.equal(support.reason, "unsupported_framework");
  assert.match(support.detail ?? "", /SvelteKit/);
});

test("a package without React is refused before the Vite check", () => {
  const support = detectRuntimeProject(
    projectFiles({
      "package.json": JSON.stringify({ devDependencies: { vite: "7" } }),
    }),
  );
  assert.equal(support.reason, "missing_react_dependency");
});

test("yarn/pnpm/bun projects are refused rather than converted", () => {
  const files = [...projectFiles(), { path: "yarn.lock", content: "" }];
  const support = detectRuntimeProject(files);
  assert.equal(support.supported, false);
  assert.equal(support.reason, "unsupported_package_manager");
});

test("an index.html that references a missing module is refused", () => {
  const support = detectRuntimeProject(
    projectFiles({
      "index.html": '<script type="module" src="/src/missing.tsx"></script>',
    }),
  );
  assert.equal(support.supported, false);
  assert.equal(support.reason, "missing_entry_module");
});

test("installation never runs lifecycle scripts and the dev server is fixed", () => {
  const install = installCommand({ hasLockfile: true });
  assert.equal(install.command, "npm");
  assert.deepEqual(install.args.slice(0, 2), ["ci", "--ignore-scripts"]);
  assert.equal(install.cwd, "/home/user/project");

  const installNoLock = installCommand({ hasLockfile: false });
  assert.deepEqual(installNoLock.args.slice(0, 2), ["install", "--ignore-scripts"]);

  const dev = devServerCommand({ port: 5173 });
  assert.equal(dev.command, "./node_modules/.bin/vite");
  assert.deepEqual(dev.args, ["--host", "0.0.0.0", "--port", "5173", "--strictPort"]);
  assert.equal(buildCommand().args[0], "build");
  assert.throws(() => devServerCommand({ port: 80 }));
});

test("shell arguments are quoted as defence in depth", () => {
  assert.equal(
    commandLine({ command: "npm", args: ["ci", "--ignore-scripts"], cwd: "/x" }),
    "npm ci --ignore-scripts",
  );
  assert.equal(
    commandLine({ command: "echo", args: ["a; rm -rf /"], cwd: "/x" }),
    "echo 'a; rm -rf /'",
  );
});

// ── File policy ─────────────────────────────────────────────────────────────

test("path traversal, absolute paths, backslashes and secret paths are refused", () => {
  assert.equal(projectPathRejection("../etc/passwd"), "traversal");
  assert.equal(projectPathRejection("/etc/passwd"), "absolute");
  assert.equal(projectPathRejection("src\\main.tsx"), "backslash");
  assert.equal(projectPathRejection(".env.local"), "excluded");
  assert.equal(projectPathRejection("node_modules/x.js"), "excluded");
  assert.equal(projectPathRejection("src/main.tsx"), null);
});

test("a sync excludes secrets and runtime output, keeps nesting and reports removals", () => {
  const previous = ["src/old.tsx", "README.md", "node_modules/x.js"];
  const plan = planProjectSync(
    projectFiles(),
    { maxFiles: 20, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 },
    previous,
  );
  const paths = plan.files.map((file) => file.path);
  assert.equal(paths.includes("node_modules/evil.js"), false);
  assert.equal(paths.includes(".env"), false);
  assert.equal(paths.includes("src/App.tsx"), true);
  assert.deepEqual(plan.removed, ["src/old.tsx"]);
  assert.equal(plan.skipped.some((file) => file.path === ".env" && file.reason === "excluded"), true);
});

test("file-count and byte limits are enforced and reported", () => {
  const plan = planProjectSync(projectFiles(), {
    maxFiles: 2,
    maxFileBytes: 20,
    maxTotalBytes: 30,
  });
  assert.equal(plan.files.length <= 2, true);
  assert.equal(plan.bytes <= 30, true);
  assert.equal(plan.skipped.some((file) => file.reason === "too_large"), true);
});

// ── Preview host and logs ───────────────────────────────────────────────────

test("only a provider E2B host can become an embedded preview URL", () => {
  assert.equal(previewUrlFromProvider("5173-abc.e2b.app"), "https://5173-abc.e2b.app");
  assert.equal(previewUrlFromProvider("5173-abc.e2b.app/path"), null);
  assert.equal(previewUrlFromProvider("evil.example.com"), null);
  assert.equal(previewUrlFromProvider("5173-abc.e2b.app?x=1"), null);
  assert.equal(previewHostFromUrl("https://5173-abc.e2b.app/"), "5173-abc.e2b.app");
  assert.equal(previewHostFromUrl("http://5173-abc.e2b.app"), null);
  assert.equal(isReadyStatus(200), true);
  assert.equal(isReadyStatus(204), true);
  assert.equal(isReadyStatus(302), true);
  assert.equal(isReadyStatus(500), false);
});

test("terminal output is bounded and redacted before it can be stored", () => {
  const raw = [
    "\u001b[32mready\u001b[0m",
    "token e2b_abcdefghijklmnopqrstuvwxyz",
    "Authorization: Bearer abcdefghijklmnop",
    "https://secret.example.com/path",
    "x".repeat(20_000),
  ].join("\n");
  const clean = sanitizeTerminalOutput(raw, 1_000);
  assert.equal(clean.includes("e2b_abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(clean.includes("Bearer abcdefghijklmnop"), false);
  assert.equal(clean.includes("https://secret.example.com/path"), false);
  assert.equal(clean.includes("\u001b"), false);
  assert.equal(clean.length <= 1_000, true);
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

function clientStub() {
  return {} as never;
}

test("a supported project starts, installs, verifies readiness and is reused", async () => {
  const store = new MemoryStore();
  const provider = mockProvider();
  const options = deps(store, provider);

  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: options,
  });
  assert.equal(started.ok, true, started.message ?? "");
  assert.equal(started.outcome, "started");
  assert.equal(started.status?.session?.state, "ready");
  assert.equal(started.status?.session?.previewUrl, "https://5173-sandbox.e2b.app");
  assert.equal(provider.calls.create, 1);
  assert.equal(provider.calls.run.some((line) => line.includes("--ignore-scripts")), true);
  assert.equal(provider.calls.startBackground, 1);
  assert.equal(provider.calls.denyEgress, 1);
  assert.equal(store.rows[0].state, "ready");
  /** node_modules and .env never cross the boundary; six files remain. */
  assert.equal(provider.calls.write, 6);

  const reused = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: options,
  });
  assert.equal(reused.ok, true);
  assert.equal(reused.outcome, "reused");
  assert.equal(provider.calls.create, 1, "reuse must not create a second sandbox");
  assert.equal(provider.calls.startBackground, 1, "reuse must not start a second server");
});

test("an unsupported project never creates a sandbox", async () => {
  const store = new MemoryStore();
  const provider = mockProvider();
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: deps(store, provider, {
      files: [{ path: "index.html", content: "<html></html>" }],
    }),
  });
  assert.equal(started.ok, false);
  assert.equal(started.code, "RUNTIME_SANDBOX_UNSUPPORTED");
  assert.equal(provider.calls.create, 0);
  assert.equal(store.rows.length, 0);
});

test("a disabled deployment reports unavailable and does nothing", async () => {
  const store = new MemoryStore();
  const provider = mockProvider();
  const options = deps(store, provider);
  options.config = parseRuntimeSandboxConfig({});
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: options,
  });
  assert.equal(started.ok, false);
  assert.equal(started.code, "RUNTIME_SANDBOX_NOT_CONFIGURED");
  assert.equal(provider.calls.create, 0);
});

test("an explicit restriction still refuses an unlisted project", async () => {
  const store = new MemoryStore();
  const provider = mockProvider();
  const options = deps(store, provider);
  options.config = config({ MAVLY_RUNTIME_SANDBOX_PROJECTS: "another-project" });
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: options,
  });
  assert.equal(started.ok, false);
  assert.equal(started.code, "RUNTIME_SANDBOX_NOT_CONFIGURED");
  assert.equal(started.status?.capability.reason, "project_not_enabled");
  assert.equal(provider.calls.create, 0);
});

test("global enablement starts a project that was never allowlisted", async () => {
  const store = new MemoryStore();
  const provider = mockProvider();
  const options = deps(store, provider);
  options.config = {
    ...config({ MAVLY_RUNTIME_SANDBOX_PROJECTS: "" }),
    installTimeoutMs: 5_000,
    startupTimeoutMs: 40,
    idleSeconds: 600,
  };
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "brand-new-project",
    projectType: "website",
    deps: options,
  });
  assert.equal(started.ok, true, started.message ?? "");
  assert.equal(provider.calls.create, 1);
  assert.equal(started.status?.capability.reason, null);
  assert.equal(started.status?.session?.state, "ready");
});

test("an install failure is recorded, the sandbox destroyed and never ready", async () => {
  const store = new MemoryStore();
  const provider = mockProvider({ installExit: 1 });
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: deps(store, provider),
  });
  assert.equal(started.ok, false);
  assert.equal(started.code, "RUNTIME_SANDBOX_FAILED");
  assert.equal(started.status?.session?.state, "failed");
  assert.equal(started.status?.session?.failureCode, "INSTALL_FAILED");
  assert.equal(provider.calls.destroy, 1);
  assert.equal(provider.calls.startBackground, 0);
});

test("a dev server that exits immediately fails with an honest reason", async () => {
  const store = new MemoryStore();
  const provider = mockProvider();
  provider.setProcessExit(0);
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: deps(store, provider),
  });
  assert.equal(started.ok, false);
  assert.equal(started.status?.session?.state, "failed");
  assert.equal(started.status?.session?.failureCode, "DEV_SERVER_EXITED");
  assert.equal(provider.calls.destroy, 1);
});

test("a server that never answers is a startup timeout, not ready", async () => {
  const store = new MemoryStore();
  const provider = mockProvider();
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: deps(store, provider, {
      probe: async () => null,
      startupTimeoutMs: 5,
    }),
  });
  assert.equal(started.ok, false);
  assert.equal(started.status?.session?.failureCode, "STARTUP_TIMEOUT");
  assert.equal(started.status?.session?.state, "failed");
});

test("an invalid provider preview host is refused before it can be embedded", async () => {
  const store = new MemoryStore();
  const provider = mockProvider({ host: "evil.example.com" });
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: deps(store, provider),
  });
  assert.equal(started.ok, false);
  assert.equal(started.status?.session?.failureCode, "PREVIEW_HOST_INVALID");
  assert.equal(started.status?.session?.previewUrl, null);
});

test("a concurrent start for a fresh session is busy, never a second install", async () => {
  const store = new MemoryStore();
  store.rows.push(
    baseRecord({
      state: "installing",
      sourceHash: "b".repeat(64),
      previewUrl: null,
    }),
  );
  const provider = mockProvider();
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: deps(store, provider),
  });
  assert.equal(started.ok, false);
  assert.equal(started.code, "RUNTIME_SANDBOX_BUSY");
  assert.equal(provider.calls.create, 0);
});

test("stop is idempotent and destroys the owned sandbox once", async () => {
  const store = new MemoryStore();
  store.rows.push(baseRecord());
  const provider = mockProvider();

  const stopped = await stopRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    deps: deps(store, provider),
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.outcome, "stopped");
  assert.equal(stopped.status?.session?.state, "stopped");
  assert.equal(provider.calls.destroy, 1);

  const again = await stopRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    deps: deps(store, provider),
  });
  assert.equal(again.outcome, "already_stopped");
  assert.equal(provider.calls.destroy, 1);
});

test("status reconciles an expired session and never reports it ready", async () => {
  const store = new MemoryStore();
  store.rows.push(baseRecord({ expiresAt: new Date(NOW - 1_000).toISOString() }));
  const provider = mockProvider();
  const status = await getRuntimeSandboxStatus({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: deps(store, provider),
  });
  assert.equal(status.session?.state, "expired");
  assert.equal(status.pending, false);
  assert.equal(provider.calls.destroy, 1);
});

test("status reconciles a provider-expired sandbox", async () => {
  const store = new MemoryStore();
  store.rows.push(baseRecord());
  const provider = mockProvider({ alive: false });
  const status = await getRuntimeSandboxStatus({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: deps(store, provider),
  });
  assert.equal(status.session?.state, "expired");
  assert.equal(status.session?.failureCode, "PROVIDER_EXPIRED");
});

test("an ownership failure from the store is reported as forbidden", async () => {
  const store = new MemoryStore();
  store.beginOverride = { ok: false, error: "You don't have access to this project.", code: "FORBIDDEN" };
  const provider = mockProvider();
  const started = await startRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    projectType: "website",
    deps: deps(store, provider),
  });
  assert.equal(started.ok, false);
  assert.equal(started.code, "FORBIDDEN");
  assert.equal(provider.calls.create, 0);
});

test("the QA build is off unless separately enabled, and uses the fixed build command", async () => {
  const store = new MemoryStore();
  store.rows.push(baseRecord());
  const provider = mockProvider();

  const disabled = deps(store, provider);
  const unavailable = await runRuntimeBuildCheck({
    client: clientStub(),
    projectId: "demo-site",
    deps: disabled,
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(provider.calls.run.length, 0);

  const enabled = deps(store, provider);
  enabled.config = { ...(enabled.config ?? config()), qaBuild: true };
  const passed = await runRuntimeBuildCheck({
    client: clientStub(),
    projectId: "demo-site",
    deps: enabled,
  });
  assert.equal(passed.status, "passed");
  assert.equal(provider.calls.run.some((line) => line === "./node_modules/.bin/vite build"), true);
  assert.equal(provider.calls.create, 0, "a build never creates a sandbox");
});

test("a stored row from another project cannot be operated by this project id", async () => {
  const store = new MemoryStore();
  store.rows.push(baseRecord({ projectId: "another-project" }));
  const provider = mockProvider();
  const stopped = await stopRuntimeSandbox({
    client: clientStub(),
    projectId: "demo-site",
    deps: deps(store, provider),
  });
  assert.equal(stopped.outcome, "already_stopped");
  assert.equal(provider.calls.destroy, 0);
});

test("server-side idle/lifetime clock makes the source hash deterministic", () => {
  const first = sourceHashForFiles(projectFiles());
  const second = sourceHashForFiles([...projectFiles()].reverse());
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  const changed = sourceHashForFiles(projectFiles({ "src/App.tsx": "changed" }));
  assert.notEqual(first, changed);
});

// ── Evidence ────────────────────────────────────────────────────────────────

test("ready runtime evidence passes install, server and readiness but not build", () => {
  const evidence = runtimeEvidenceFromRecord(baseRecord());
  assert.equal(evidence.status, "ready");
  assert.equal(evidence.checks.find((entry) => entry.id === "install")?.status, "passed");
  assert.equal(evidence.checks.find((entry) => entry.id === "dev_server")?.status, "passed");
  assert.equal(evidence.checks.find((entry) => entry.id === "readiness")?.status, "passed");
  assert.equal(evidence.checks.find((entry) => entry.id === "build")?.status, "unavailable");
  assert.match(runtimeEvidenceForPrompt(evidence) ?? "", /not a production build/i);
});

test("a failed install is a failed check and a repair summary", () => {
  const evidence = runtimeEvidenceFromRecord(
    baseRecord({
      state: "failed",
      failureCode: "INSTALL_FAILED",
      failureReason: "Dependency installation failed.",
      installMs: null,
      startupMs: null,
      port: null,
      previewUrl: null,
      logs: "npm ERR! missing",
    }),
  );
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.checks.find((entry) => entry.id === "install")?.status, "failed");
  assert.match(runtimeRepairSummary(evidence) ?? "", /INSTALL_FAILED/);
  assert.match(runtimeRepairSummary(evidence) ?? "", /npm ERR!/);
});

test("runtime evidence is stale unless it ran the exact current source", () => {
  const files = projectFiles();
  const hash = sourceHashForFiles(files);
  const evidence = runtimeEvidenceFromRecord(
    baseRecord({ sourceHash: hash, state: "ready" }),
  );
  assert.equal(runtimeEvidenceMatchesSource(evidence, files), true);
  assert.equal(
    runtimeEvidenceMatchesSource(evidence, projectFiles({ "src/App.tsx": "changed" })),
    false,
  );
  assert.equal(runtimeEvidenceMatchesSource(evidence, []), false);
  assert.equal(
    runtimeEvidenceMatchesSource(runtimeEvidenceFromRecord(baseRecord({ sourceHash: null })), files),
    false,
  );
});

test("no session is unavailable, never a pass", () => {
  const checks: RuntimeCheck[] = runtimeChecksFor(null);
  assert.equal(checks.every((entry) => entry.status === "unavailable"), true);
  const evidence = runtimeEvidenceFromRecord(null);
  assert.equal(evidence.status, "unavailable");
  assert.equal(runtimeEvidenceForPrompt(evidence), null);
  assert.equal(runtimeRepairSummary(evidence), null);
});

test("the lifecycle transition table refuses fabricated jumps", () => {
  assert.equal(canTransitionRuntimeState("provisioning", "syncing"), true);
  assert.equal(canTransitionRuntimeState("starting", "ready"), true);
  assert.equal(canTransitionRuntimeState("provisioning", "ready"), false);
  assert.equal(canTransitionRuntimeState("failed", "ready"), false);
  assert.equal(canTransitionRuntimeState("stopped", "ready"), false);
});

// ── Static orchestration/route contracts ───────────────────────────────────

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("orchestration reads runtime evidence and never creates a sandbox itself", async () => {
  const engine = await source("src/lib/orchestration/engine.ts");
  assert.match(engine, /runtimeEvidenceForPrompt/);
  assert.match(engine, /runtimeEvidence\?\.status === "failed"/);
  assert.match(engine, /runtimeReady/);
  assert.equal(engine.includes("startRuntimeSandbox"), false);
  assert.equal(engine.includes("createRuntimeSandboxProvider"), false);
  assert.equal(engine.includes("runRuntimeBuildCheck"), false);
});

test("the runtime route exposes fixed actions only and never a command field", async () => {
  const route = await source("src/app/api/runtime/[projectId]/route.ts");
  assert.match(route, /action !== "start"/);
  assert.match(route, /authorizeProjectRequest/);
  assert.equal(/\b(?:command|args|cwd|envVars|sandboxId)\b\s*:/.test(route), false);
});

test("the lifecycle migration enforces transitions and the ready rule", async () => {
  const migration = await source("supabase/migrations/34_runtime_sandboxes.sql");
  assert.match(migration, /runtime_sandbox_transition_allowed/);
  assert.match(migration, /RUNTIME_STATE_TRANSITION_INVALID/);
  assert.match(migration, /state <> 'ready'/);
  assert.match(migration, /revoke insert, update, delete/i);
});
