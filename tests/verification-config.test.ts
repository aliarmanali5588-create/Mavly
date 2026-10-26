import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SANDBOX_COHORT,
  isProjectInVerificationCohort,
  parseVerificationConfig,
  type SandboxEnvironment,
} from "../src/lib/sandbox/config";

/**
 * Verification is opt-in, all-or-nothing and cohort-scoped. A half-configured
 * deployment must report "not ready" rather than enqueue work nothing can run.
 */

function env(overrides: SandboxEnvironment = {}): SandboxEnvironment {
  return {
    MAVLY_VERIFICATION_SANDBOX_ENABLED: "on",
    MAVLY_VERIFICATION_SANDBOX_PROJECTS: "alpha-app, beta-app",
    VERCEL_OIDC_TOKEN: "oidc-token-value",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    ...overrides,
  };
}

test("verification is disabled and not ready by default", () => {
  const config = parseVerificationConfig({});
  assert.equal(config.requested, false);
  assert.equal(config.ready, false);
  assert.equal(config.provider, null);
  assert.deepEqual(config.cohort, []);
  assert.equal(config.problems.includes("disabled"), true);
});

test("a complete OIDC configuration is ready and defaults to Vercel", () => {
  const config = parseVerificationConfig(env());
  assert.equal(config.requested, true);
  assert.equal(config.ready, true);
  assert.equal(config.provider, "vercel");
  assert.deepEqual(config.problems, []);
  assert.deepEqual(config.cohort, ["alpha-app", "beta-app"]);
  assert.equal(config.credentials.oidcToken, "oidc-token-value");
});

test("an access-token triple is accepted instead of OIDC", () => {
  const config = parseVerificationConfig(
    env({
      VERCEL_OIDC_TOKEN: "",
      VERCEL_TOKEN: "access-token",
      VERCEL_TEAM_ID: "team_123",
      VERCEL_PROJECT_ID: "prj_123",
    }),
  );
  assert.equal(config.ready, true);
  assert.equal(config.credentials.token, "access-token");
});

test("an incomplete access-token triple is not credentials", () => {
  const config = parseVerificationConfig(
    env({ VERCEL_OIDC_TOKEN: "", VERCEL_TOKEN: "access-token", VERCEL_TEAM_ID: "team_123" }),
  );
  assert.equal(config.ready, false);
  assert.equal(config.problems.includes("missing_credentials"), true);
});

test("E2B is recognized by name but reported as not implemented", () => {
  const config = parseVerificationConfig(env({ MAVLY_VERIFICATION_SANDBOX_PROVIDER: "e2b" }));
  assert.equal(config.provider, "e2b");
  assert.equal(config.ready, false);
  assert.equal(config.problems.includes("provider_not_implemented"), true);
});

test("an unknown provider is refused, not treated as a default", () => {
  const config = parseVerificationConfig(
    env({ MAVLY_VERIFICATION_SANDBOX_PROVIDER: "fly-machines" }),
  );
  assert.equal(config.provider, null);
  assert.equal(config.problems.includes("unknown_provider"), true);
});

test("an empty or malformed cohort is a refusal", () => {
  const empty = parseVerificationConfig(env({ MAVLY_VERIFICATION_SANDBOX_PROJECTS: "" }));
  assert.equal(empty.problems.includes("missing_cohort"), true);

  const malformed = parseVerificationConfig(
    env({ MAVLY_VERIFICATION_SANDBOX_PROJECTS: "Alpha App, alpha-app" }),
  );
  assert.equal(malformed.ready, false);
  assert.equal(malformed.problems.includes("invalid_cohort"), true);
});

test("cohort entries are lowercased, de-duplicated and bounded", () => {
  const config = parseVerificationConfig(
    env({ MAVLY_VERIFICATION_SANDBOX_PROJECTS: "alpha-app, Alpha-App; beta-app" }),
  );
  assert.deepEqual(config.cohort, ["alpha-app", "beta-app"]);

  const many = Array.from({ length: MAX_SANDBOX_COHORT + 20 }, (_, index) => `app-${index}`);
  const capped = parseVerificationConfig(
    env({ MAVLY_VERIFICATION_SANDBOX_PROJECTS: many.join(",") }),
  );
  assert.equal(capped.cohort.length, MAX_SANDBOX_COHORT);
});

test("missing service-role and Supabase URL make the configuration not ready", () => {
  const noService = parseVerificationConfig(env({ SUPABASE_SERVICE_ROLE_KEY: "" }));
  assert.equal(noService.problems.includes("missing_service_role"), true);

  const noUrl = parseVerificationConfig(env({ NEXT_PUBLIC_SUPABASE_URL: "" }));
  assert.equal(noUrl.problems.includes("missing_supabase_url"), true);
});

test("cohort membership requires a ready configuration", () => {
  const ready = parseVerificationConfig(env());
  assert.equal(isProjectInVerificationCohort("alpha-app", ready), true);
  assert.equal(isProjectInVerificationCohort("ALPHA-APP", ready), true);
  assert.equal(isProjectInVerificationCohort("other-app", ready), false);

  const disabled = parseVerificationConfig(
    env({ MAVLY_VERIFICATION_SANDBOX_ENABLED: "off" }),
  );
  assert.equal(isProjectInVerificationCohort("alpha-app", disabled), false);
});

test("the flag accepts only the documented truthy spellings", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(
      parseVerificationConfig(env({ MAVLY_VERIFICATION_SANDBOX_ENABLED: value })).requested,
      true,
    );
  }
  for (const value of ["0", "false", "no", "off", "", "enabled"]) {
    assert.equal(
      parseVerificationConfig(env({ MAVLY_VERIFICATION_SANDBOX_ENABLED: value })).requested,
      false,
      value,
    );
  }
});
