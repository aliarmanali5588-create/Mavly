import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_WORKER_COHORT,
  MIN_WORKER_SECRET_LENGTH,
  dispatchModeForProject,
  isProjectInWorkerCohort,
  parseWorkerConfig,
  type WorkerEnvironment,
} from "../src/lib/generation/worker-config";

/**
 * The worker is opt-in and cohort-scoped. A configuration mistake must make it
 * NOT READY rather than silently widening the set of projects it may run.
 */

function env(overrides: WorkerEnvironment = {}): WorkerEnvironment {
  return {
    MAVLY_GENERATION_WORKER_ENABLED: "on",
    MAVLY_GENERATION_WORKER_SECRET: "s".repeat(32),
    MAVLY_GENERATION_WORKER_PROJECTS: "alpha-app, beta-app",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    ...overrides,
  };
}

test("a complete configuration is ready and parses the cohort", () => {
  const config = parseWorkerConfig(env());
  assert.equal(config.requested, true);
  assert.equal(config.ready, true);
  assert.deepEqual(config.problems, []);
  assert.deepEqual(config.cohort, ["alpha-app", "beta-app"]);
  assert.equal(config.workerId, "generation-worker");
  assert.equal(config.secret, "s".repeat(32));
});

test("the flag accepts only the documented truthy spellings", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseWorkerConfig(env({ MAVLY_GENERATION_WORKER_ENABLED: value })).requested, true);
  }
  for (const value of ["0", "false", "no", "off", "", "enabled"]) {
    const config = parseWorkerConfig(env({ MAVLY_GENERATION_WORKER_ENABLED: value }));
    assert.equal(config.requested, false, value);
    assert.equal(config.ready, false, value);
    assert.equal(config.problems.includes("disabled"), true, value);
  }
});

test("a missing or weak secret is a refusal, not a warning", () => {
  const missing = parseWorkerConfig(env({ MAVLY_GENERATION_WORKER_SECRET: "" }));
  assert.equal(missing.ready, false);
  assert.equal(missing.problems.includes("missing_secret"), true);

  const short = parseWorkerConfig(env({
    MAVLY_GENERATION_WORKER_SECRET: "s".repeat(MIN_WORKER_SECRET_LENGTH - 1),
  }));
  assert.equal(short.ready, false);
  assert.equal(short.problems.includes("weak_secret"), true);

  const spaced = parseWorkerConfig(env({
    MAVLY_GENERATION_WORKER_SECRET: `${"s".repeat(20)} ${"s".repeat(20)}`,
  }));
  assert.equal(spaced.ready, false);
  assert.equal(spaced.problems.includes("weak_secret"), true);
});

test("an empty cohort is never treated as 'all projects'", () => {
  for (const value of ["", "   ", ",,", " ; "]) {
    const config = parseWorkerConfig(env({ MAVLY_GENERATION_WORKER_PROJECTS: value }));
    assert.equal(config.ready, false, value);
    assert.equal(config.problems.includes("missing_cohort"), true, value);
    assert.deepEqual(config.cohort, []);
  }
});

test("a malformed cohort member makes the whole worker not ready", () => {
  const config = parseWorkerConfig(env({
    MAVLY_GENERATION_WORKER_PROJECTS: "alpha-app, Beta_App",
  }));
  assert.equal(config.ready, false);
  assert.equal(config.problems.includes("invalid_cohort"), true);
});

test("server-only service-role and Supabase URL are required", () => {
  const noService = parseWorkerConfig(env({ SUPABASE_SERVICE_ROLE_KEY: "" }));
  assert.equal(noService.ready, false);
  assert.equal(noService.problems.includes("missing_service_role"), true);

  const noUrl = parseWorkerConfig(env({ NEXT_PUBLIC_SUPABASE_URL: " " }));
  assert.equal(noUrl.ready, false);
  assert.equal(noUrl.problems.includes("missing_supabase_url"), true);
});

test("the cohort is split, lowercased, de-duplicated and bounded", () => {
  const config = parseWorkerConfig(env({
    MAVLY_GENERATION_WORKER_PROJECTS: " alpha-app ;ALPHA-APP\nbeta-app ",
  }));
  assert.deepEqual(config.cohort, ["alpha-app", "beta-app"]);

  const many = Array.from({ length: MAX_WORKER_COHORT + 10 }, (_, index) => `p-${index}`);
  const capped = parseWorkerConfig(env({ MAVLY_GENERATION_WORKER_PROJECTS: many.join(",") }));
  assert.equal(capped.cohort.length, MAX_WORKER_COHORT);
  assert.equal(capped.ready, true);
});

test("only a ready worker whose cohort contains the project dispatches to it", () => {
  const ready = parseWorkerConfig(env());
  assert.equal(dispatchModeForProject("alpha-app", ready), "worker");
  assert.equal(dispatchModeForProject("ALPHA-APP", ready), "worker");
  assert.equal(dispatchModeForProject("gamma-app", ready), "inline");

  const disabled = parseWorkerConfig(env({ MAVLY_GENERATION_WORKER_ENABLED: "" }));
  assert.equal(dispatchModeForProject("alpha-app", disabled), "inline");
  assert.equal(isProjectInWorkerCohort("alpha-app", disabled), false);

  const weak = parseWorkerConfig(env({ MAVLY_GENERATION_WORKER_SECRET: "short" }));
  assert.equal(dispatchModeForProject("alpha-app", weak), "inline");
});

test("cohort membership is exact, so lookalike projects stay inline", () => {
  const config = parseWorkerConfig(env());
  assert.equal(isProjectInWorkerCohort("alpha-app", config), true);
  assert.equal(isProjectInWorkerCohort("alpha-app-2", config), false);
  assert.equal(isProjectInWorkerCohort("alpha", config), false);
});
