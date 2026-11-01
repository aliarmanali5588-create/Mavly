import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dispatchModeForProject,
  parseWorkerConfig,
  type WorkerEnvironment,
} from "../src/lib/generation/worker-config";
import { runGenerationWorkerOnce } from "../src/lib/generation/worker";

function env(overrides: WorkerEnvironment = {}): WorkerEnvironment {
  return {
    NODE_ENV: "production",
    VERCEL_ENV: "production",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    ...overrides,
  };
}

test("the platform worker is ready with existing Supabase server credentials", () => {
  const config = parseWorkerConfig(env());
  assert.equal(config.requested, true);
  assert.equal(config.ready, true);
  assert.deepEqual(config.problems, []);
  assert.equal(config.workerId, "cloudflare-generation-worker");
  assert.equal(config.production, true);
});

test("project identifiers do not affect production dispatch", () => {
  const config = parseWorkerConfig(env());
  assert.equal(dispatchModeForProject("first-project", config), "worker");
  assert.equal(dispatchModeForProject("another-project", config), "worker");
});

test("local development and Vercel previews retain inline execution", () => {
  const local = parseWorkerConfig(env({ NODE_ENV: "development" }));
  assert.equal(dispatchModeForProject("local-project", local), "inline");

  const localStart = parseWorkerConfig(env({ VERCEL_ENV: undefined }));
  assert.equal(dispatchModeForProject("local-start-project", localStart), "inline");

  const preview = parseWorkerConfig(env({ VERCEL_ENV: "preview" }));
  assert.equal(dispatchModeForProject("preview-project", preview), "inline");
});

test("the platform worker fails closed without existing service-role credentials", () => {
  const noService = parseWorkerConfig(env({ SUPABASE_SERVICE_ROLE_KEY: "" }));
  assert.equal(noService.ready, false);
  assert.deepEqual(noService.problems, ["missing_service_role"]);

  const noUrl = parseWorkerConfig(env({ NEXT_PUBLIC_SUPABASE_URL: " " }));
  assert.equal(noUrl.ready, false);
  assert.deepEqual(noUrl.problems, ["missing_supabase_url"]);
});

test("legacy worker-specific variables do not gate production dispatch", () => {
  const config = parseWorkerConfig(env({
    MAVLY_GENERATION_WORKER_ENABLED: "",
    MAVLY_GENERATION_WORKER_SECRET: "",
    MAVLY_GENERATION_WORKER_PROJECTS: "",
  }));
  assert.equal(config.ready, true);
  assert.equal(dispatchModeForProject("any-project", config), "worker");
});

test("the Render background worker selects production dispatch", () => {
  const config = parseWorkerConfig(env({
    VERCEL_ENV: undefined,
    MAVLY_RENDER_WORKER: "true",
  }));
  assert.equal(config.ready, true);
  assert.equal(config.production, true);
  assert.equal(config.workerId, "render-generation-worker");
  assert.equal(dispatchModeForProject("any-project", config), "worker");
});

test("AWS remains ready and production-enabled when Render is disabled", () => {
  const config = parseWorkerConfig(env({
    VERCEL_ENV: undefined,
    MAVLY_AWS_WORKER: "true",
    MAVLY_RENDER_WORKER: "true",
    MAVLY_RENDER_WORKER_DISABLED: "true",
  }));
  assert.equal(config.requested, true);
  assert.equal(config.ready, true);
  assert.equal(config.production, true);
  assert.equal(config.workerId, "aws-generation-worker");
  assert.equal(dispatchModeForProject("any-project", config), "worker");
});

test("the Render disable flag disables the Render worker when AWS is inactive", () => {
  const config = parseWorkerConfig(env({
    VERCEL_ENV: undefined,
    MAVLY_RENDER_WORKER: "true",
    MAVLY_RENDER_WORKER_DISABLED: "true",
  }));
  assert.equal(config.requested, false);
  assert.equal(config.ready, false);
  assert.equal(config.production, false);
  assert.equal(config.workerId, "render-generation-worker-disabled");
  assert.equal(dispatchModeForProject("any-project", config), "inline");
});

test("AWS reports unavailable when Supabase credentials are missing", async () => {
  const config = parseWorkerConfig(env({
    VERCEL_ENV: undefined,
    MAVLY_AWS_WORKER: "true",
    MAVLY_RENDER_WORKER_DISABLED: "true",
    SUPABASE_SERVICE_ROLE_KEY: "",
    NEXT_PUBLIC_SUPABASE_URL: " ",
  }));
  assert.equal(config.requested, true);
  assert.equal(config.ready, false);
  assert.equal(config.production, true);
  assert.equal(config.workerId, "aws-generation-worker");
  assert.deepEqual(config.problems, ["missing_service_role", "missing_supabase_url"]);

  const result = await runGenerationWorkerOnce({ config });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "misconfigured");
});
