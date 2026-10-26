import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RUNTIME_HEALTH_PATH,
  RUNTIME_PORT,
  type RuntimePlan,
} from "../src/lib/runtime/profile";
import { planNextAppRouter } from "../src/lib/runtime/next-app-router";
import {
  RUNTIME_EXIT_MARKER,
  RUNTIME_LOG_MARKER,
  RUNTIME_PID_MARKER,
  classifyRuntimeStartFailure,
  detachedRuntimeScript,
  isHealthyHttpStatus,
  parseHealthOutput,
  runtimeHealthCommand,
  sanitizeDiagnostics,
} from "../src/lib/sandbox/policy";
import {
  PREVIEW_UNAVAILABLE_REASON,
  REPAIRABLE_ERROR_CLASSES,
  VERIFICATION_BUILD_TIMEOUT_MS,
  VERIFICATION_DEADLINE_MS,
  VERIFICATION_DEFAULT_MAX_REPAIRS,
  VERIFICATION_HARD_MAX_REPAIRS,
  VERIFICATION_HEALTH_REQUEST_TIMEOUT_MS,
  VERIFICATION_HEALTH_TIMEOUT_MS,
  VERIFICATION_INSTALL_TIMEOUT_MS,
  VERIFICATION_RUNTIME_TIMEOUT_MS,
  VERIFICATION_SESSION_TIMEOUT_MS,
  clampMaxRepairs,
  isRepairableErrorClass,
  notStartedVerification,
  publicVerificationStatus,
  unavailablePreview,
  type VerificationErrorClass,
} from "../src/lib/sandbox/state";
import {
  MAX_REPAIRS_ENV,
  REPAIR_ENABLED_ENV,
  parseVerificationConfig,
} from "../src/lib/sandbox/config";

/**
 * Phase 4 runtime checks are NOT proven by these tests. They prove the bounded
 * plan the worker is allowed to launch and the vocabulary it may report:
 * loopback-only, fixed port/path, a fixed binary, and a health result that is
 * parsed locally. A provider microVM is never started here.
 */

function packageJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name: "demo-app",
      private: true,
      scripts: { build: "next build", ...(overrides.scripts as object | undefined) },
      dependencies: { next: "16.2.10", react: "19.2.7", "react-dom": "19.2.7" },
      ...overrides,
    },
    null,
    2,
  );
}

function files(manifest: string = packageJson()) {
  return [
    { path: "package.json", content: manifest },
    {
      path: "app/layout.tsx",
      content: "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    },
    {
      path: "app/page.tsx",
      content: "export default function Page() { return <main>Hello</main>; }",
    },
  ];
}

function plan(manifest: string = packageJson()): RuntimePlan {
  const result = planNextAppRouter(files(manifest));
  /**
   * The narrowing guard comes FIRST. `assert.equal(result.ok, true)` is an
   * assertion function, so TypeScript narrows `result.ok` to `true` and the
   * following `=== false` check would be an impossible comparison (and
   * `result.summary` would be `never`).
   */
  if (result.ok === false) throw new Error(result.summary);
  assert.equal(result.ok, true);
  return result.plan;
}

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MAVLY_VERIFICATION_SANDBOX_ENABLED: "on",
    MAVLY_VERIFICATION_SANDBOX_PROJECTS: "alpha-app",
    VERCEL_OIDC_TOKEN: "oidc-token-value",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    ...overrides,
  };
}

// ── Startup command ─────────────────────────────────────────────────────────

test("the runtime is the fixed loopback binary, never the generated start script", () => {
  const resolved = plan();
  assert.deepEqual(resolved.runtime, {
    cmd: "./node_modules/.bin/next",
    args: ["start", "-H", "127.0.0.1", "-p", String(RUNTIME_PORT)],
  });
  assert.equal(resolved.runtimePort, RUNTIME_PORT);
  assert.equal(resolved.runtimeHealthPath, RUNTIME_HEALTH_PATH);
  assert.equal(resolved.runtime.args.includes("127.0.0.1"), true);
  assert.equal(resolved.runtime.cmd.includes("npm"), false);
});

test("an absent start script uses the fixed profile default", () => {
  assert.equal(plan().startScript, null);
});

test("an exact next start script is accepted but still not executed", () => {
  const resolved = plan(packageJson({ scripts: { build: "next build", start: " next   start " } }));
  assert.equal(resolved.startScript, "next start");
  assert.deepEqual(resolved.runtime.args, ["start", "-H", "127.0.0.1", "-p", String(RUNTIME_PORT)]);
});

test("an arbitrary start script is refused instead of run", () => {
  for (const start of [
    "next start && curl https://example.com",
    "node server.js",
    "npm run start",
    "next dev",
    "sh -c 'start'",
  ]) {
    const result = planNextAppRouter(files(packageJson({ scripts: { build: "next build", start } })));
    assert.equal(result.ok, false, start);
    if (result.ok === false) assert.equal(result.code, "unsupported_runtime", start);
  }
});

test("the detached runtime wrapper records pid and exit, and exits 0 itself", () => {
  const script = detachedRuntimeScript(plan());
  assert.match(script, /^set \+e/m);
  assert.match(script, /'\.\/node_modules\/\.bin\/next' 'start' '-H' '127\.0\.0\.1' '-p' '3000' > '\.mavly\/runtime\.log' 2>&1 &/);
  assert.match(script, /^pid=\$!$/m);
  assert.equal(script.includes(RUNTIME_PID_MARKER), true);
  assert.equal(script.includes(RUNTIME_EXIT_MARKER), true);
  assert.equal(script.includes(RUNTIME_LOG_MARKER), true);
  assert.match(script, /^wait "\$pid"$/m);
  assert.match(script, /exit 0\s*$/);
  // No shell composition from a generated manifest reaches the invocation.
  assert.equal(script.includes("curl"), false);
  assert.equal(script.includes("npm run"), false);
});

// ── Health check ────────────────────────────────────────────────────────────

test("the health check is sandbox-local and fixed to the profile port and path", () => {
  const command = runtimeHealthCommand(plan(), VERIFICATION_HEALTH_REQUEST_TIMEOUT_MS);
  assert.equal(command.cmd, "node");
  assert.equal(command.args[2], String(RUNTIME_PORT));
  assert.equal(command.args[3], RUNTIME_HEALTH_PATH);
  assert.equal(command.args[4], String(VERIFICATION_HEALTH_REQUEST_TIMEOUT_MS));
  assert.equal(command.args[1].includes('host:"127.0.0.1"'), true);
  assert.equal(command.args[1].includes("http.get"), true);
  assert.equal(command.args[1].includes("https"), false);
  // The response body is discarded, so generated output cannot flood a worker.
  assert.equal(command.args[1].includes("res.resume()"), true);
});

test("the request timeout is clamped to a bounded window", () => {
  const tooSmall = runtimeHealthCommand(plan(), 10);
  const tooLarge = runtimeHealthCommand(plan(), 60_000);
  assert.equal(tooSmall.args[4], "1000");
  assert.equal(tooLarge.args[4], "10000");
});

test("a health observation is parsed, never inferred", () => {
  assert.deepEqual(parseHealthOutput("status:204"), { kind: "status", status: 204 });
  assert.deepEqual(parseHealthOutput("status:500"), { kind: "status", status: 500 });
  assert.deepEqual(parseHealthOutput("timeout"), { kind: "timeout" });
  assert.deepEqual(parseHealthOutput("error:ECONNREFUSED"), {
    kind: "unreachable",
    code: "ECONNREFUSED",
  });
  for (const raw of [null, undefined, "", "ok", "status:20", "status:2000", "error:", "x".repeat(90)]) {
    assert.deepEqual(parseHealthOutput(raw), { kind: "unknown" }, String(raw));
  }
});

test("only 2xx and 3xx count as a healthy runtime", () => {
  for (const status of [200, 204, 301, 302, 399]) {
    assert.equal(isHealthyHttpStatus(status), true, String(status));
  }
  for (const status of [0, 100, 199, 400, 404, 500, 599]) {
    assert.equal(isHealthyHttpStatus(status), false, String(status));
  }
});

test("a runtime failure distinguishes port binding from an application start failure", () => {
  assert.equal(
    classifyRuntimeStartFailure(
      sanitizeDiagnostics("listen EADDRINUSE: address already in use 127.0.0.1:3000"),
    ),
    "runtime_port_unavailable",
  );
  assert.equal(
    classifyRuntimeStartFailure(sanitizeDiagnostics("EACCES: permission denied, bind")),
    "runtime_port_unavailable",
  );
  assert.equal(
    classifyRuntimeStartFailure(sanitizeDiagnostics("Error: Cannot find module 'next'")),
    "runtime_start_failed",
  );
  assert.equal(
    classifyRuntimeStartFailure(sanitizeDiagnostics("TypeError: x is not a function")),
    "runtime_start_failed",
  );
});

// ── Status vocabulary ───────────────────────────────────────────────────────

test("runtime and repair stages are in-flight, never terminal", () => {
  assert.equal(publicVerificationStatus("runtime_starting"), "running");
  assert.equal(publicVerificationStatus("health_checking"), "running");
  assert.equal(publicVerificationStatus("repairing"), "running");
});

test("only source-level build/runtime/health failures are repair eligible", () => {
  assert.deepEqual(REPAIRABLE_ERROR_CLASSES, [
    "build_failed",
    "runtime_start_failed",
    "health_check_failed",
  ]);
  const notRepairable: (VerificationErrorClass | null | undefined)[] = [
    "install_failed",
    "dependency_resolution_failed",
    "runtime_port_unavailable",
    "runtime_exited",
    "timeout",
    "cancelled",
    "configuration_error",
    "provider_error",
    "repair_failed",
    null,
    undefined,
  ];
  for (const errorClass of notRepairable) {
    assert.equal(isRepairableErrorClass(errorClass), false, String(errorClass));
  }
  assert.equal(isRepairableErrorClass("build_failed"), true);
});

test("the repair budget defaults to one and never exceeds two", () => {
  assert.equal(VERIFICATION_DEFAULT_MAX_REPAIRS, 1);
  assert.equal(VERIFICATION_HARD_MAX_REPAIRS, 2);
  assert.equal(clampMaxRepairs(undefined), 1);
  assert.equal(clampMaxRepairs(null), 1);
  assert.equal(clampMaxRepairs(Number.NaN), 1);
  assert.equal(clampMaxRepairs(-4), 0);
  assert.equal(clampMaxRepairs(0), 0);
  assert.equal(clampMaxRepairs(1.9), 1);
  assert.equal(clampMaxRepairs(2), 2);
  assert.equal(clampMaxRepairs(9), 2);
});

test("the runtime budget fits inside the session and the hard deadline", () => {
  assert.equal(
    VERIFICATION_INSTALL_TIMEOUT_MS +
      VERIFICATION_BUILD_TIMEOUT_MS +
      VERIFICATION_RUNTIME_TIMEOUT_MS <
      VERIFICATION_SESSION_TIMEOUT_MS,
    true,
  );
  assert.equal(VERIFICATION_SESSION_TIMEOUT_MS < VERIFICATION_DEADLINE_MS, true);
  assert.equal(
    VERIFICATION_HEALTH_REQUEST_TIMEOUT_MS < VERIFICATION_HEALTH_TIMEOUT_MS,
    true,
  );
  assert.equal(VERIFICATION_HEALTH_TIMEOUT_MS < VERIFICATION_RUNTIME_TIMEOUT_MS, true);
});

// ── Preview contract ────────────────────────────────────────────────────────

test("preview is a status contract with no URL and no provider access", () => {
  const preview = unavailablePreview();
  assert.deepEqual(Object.keys(preview).sort(), ["authenticated", "reason", "status"]);
  assert.equal(preview.status, "unavailable");
  assert.equal(preview.authenticated, false);
  assert.equal(PREVIEW_UNAVAILABLE_REASON.length > 0, true);
  assert.equal(PREVIEW_UNAVAILABLE_REASON.length <= 400, true);

  const serialized = JSON.stringify(preview);
  assert.equal(/https?:|wss?:|sandbox|token|domain|url/i.test(serialized), false);

  const notStarted = notStartedVerification("11111111-1111-4111-8111-111111111111", "demo-app");
  assert.deepEqual(notStarted.preview, preview);
  assert.deepEqual(notStarted.repair, {
    status: "none",
    attempts: 0,
    maxAttempts: 0,
    snapshotId: null,
  });
  assert.equal(notStarted.buildPassed, null);
  assert.equal(notStarted.runtimeStarted, null);
  assert.equal(notStarted.healthPassed, null);
  assert.equal(notStarted.healthChecked, false);
});

// ── Repair configuration ────────────────────────────────────────────────────

test("repair is disabled even when verification is enabled unless opted in", () => {
  const config = parseVerificationConfig(env());
  assert.equal(config.ready, true);
  assert.equal(config.repairEnabled, false);
  assert.equal(config.maxRepairs, 0);
});

test("repair defaults to one attempt when enabled", () => {
  const config = parseVerificationConfig(env({ [REPAIR_ENABLED_ENV]: "on" }));
  assert.equal(config.repairEnabled, true);
  assert.equal(config.maxRepairs, 1);
  assert.equal(config.ready, true);
});

test("the repair budget is parsed, clamped and cannot exceed two", () => {
  assert.equal(
    parseVerificationConfig(
      env({ [REPAIR_ENABLED_ENV]: "on", [MAX_REPAIRS_ENV]: "2" }),
    ).maxRepairs,
    2,
  );
  assert.equal(
    parseVerificationConfig(
      env({ [REPAIR_ENABLED_ENV]: "on", [MAX_REPAIRS_ENV]: "9" }),
    ).maxRepairs,
    2,
  );
  assert.equal(
    parseVerificationConfig(
      env({ [REPAIR_ENABLED_ENV]: "on", [MAX_REPAIRS_ENV]: "not-a-number" }),
    ).maxRepairs,
    1,
  );
  const zero = parseVerificationConfig(
    env({ [REPAIR_ENABLED_ENV]: "on", [MAX_REPAIRS_ENV]: "0" }),
  );
  assert.equal(zero.maxRepairs, 0);
  assert.equal(zero.repairEnabled, false);
});

test("a repair flag without the verification prerequisites changes nothing", () => {
  const config = parseVerificationConfig({
    [REPAIR_ENABLED_ENV]: "on",
    [MAX_REPAIRS_ENV]: "2",
  });
  assert.equal(config.repairEnabled, true);
  assert.equal(config.ready, false);
  assert.equal(config.problems.includes("disabled"), true);
  assert.equal(config.problems.includes("missing_cohort"), true);
});
