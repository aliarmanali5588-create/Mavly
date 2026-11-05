import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isVercelDeploymentsEnabled,
  readVercelDeploymentConfig,
} from "../src/lib/vercel/config";
import {
  sanitizeVercelDiagnosticText,
  vercelConfigPresence,
} from "../src/lib/vercel/diagnostics";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

const ENABLED = { MAVLY_VERCEL_DEPLOYMENTS_ENABLED: "1" };

test("publishing is off unless the documented flag is enabled", () => {
  assert.equal(isVercelDeploymentsEnabled(env({})), false);
  assert.equal(isVercelDeploymentsEnabled(env({ MAVLY_VERCEL_DEPLOYMENTS_ENABLED: "on" })), true);
  assert.equal(isVercelDeploymentsEnabled(env({ MAVLY_VERCEL_DEPLOYMENTS_ENABLED: "TRUE" })), true);

  assert.equal(readVercelDeploymentConfig(env({})).ok, false);
  assert.equal(
    readVercelDeploymentConfig(
      env({ VERCEL_DEPLOYMENTS_ENABLED: "1", VERCEL_API_TOKEN: "secret-token" }),
    ).ok,
    false,
  );
  assert.equal(
    readVercelDeploymentConfig(
      env({
        NEXT_PUBLIC_MAVLY_VERCEL_DEPLOYMENTS_ENABLED: "1",
        VERCEL_API_TOKEN: "secret-token",
      }),
    ).ok,
    false,
  );
});

test("only VERCEL_API_TOKEN configures the token", () => {
  const legacy = readVercelDeploymentConfig(
    env({ ...ENABLED, VERCEL_TOKEN: "legacy-token" }),
  );
  assert.equal(legacy.ok, false);
  assert.equal(legacy.reason, "missing-token");

  const configured = readVercelDeploymentConfig(
    env({ ...ENABLED, VERCEL_API_TOKEN: "secret-token" }),
  );
  assert.equal(configured.ok, true);
  assert.equal(configured.config.token, "secret-token");
});

test("a Bearer prefix on the configured token is normalized", () => {
  const configured = readVercelDeploymentConfig(
    env({ ...ENABLED, VERCEL_API_TOKEN: "Bearer secret-token" }),
  );
  assert.equal(configured.ok, true);
  assert.equal(configured.config.token, "secret-token");
});

test("VERCEL_ORG_ID and VERCEL_TEAM_ID_SLUG are never used as the team id", () => {
  const configured = readVercelDeploymentConfig(
    env({
      ...ENABLED,
      VERCEL_API_TOKEN: "secret-token",
      VERCEL_ORG_ID: "org_injected_by_vercel",
      VERCEL_TEAM_ID_SLUG: "team-slug",
      VERCEL_PROJECT_NAME_PREFIX: "old-prefix",
    }),
  );
  assert.equal(configured.ok, true);
  assert.equal(configured.config.teamId, null);

  const team = readVercelDeploymentConfig(
    env({ ...ENABLED, VERCEL_API_TOKEN: "secret-token", VERCEL_TEAM_ID: "team_123" }),
  );
  assert.equal(team.ok, true);
  assert.equal(team.config.teamId, "team_123");
});

test("diagnostics redact tokens, Bearer headers and control characters", () => {
  const text = sanitizeVercelDiagnosticText(
    "invalid token\nBearer super-secret-token\u0000 and super-secret-token",
    "super-secret-token",
    200,
  );
  assert.equal(text.includes("super-secret-token"), false);
  assert.equal(text.includes("\n"), false);
  assert.match(text, /Bearer \[redacted\]/);
});

test("configuration presence reports names only, never values", () => {
  const presence = vercelConfigPresence(
    env({
      MAVLY_VERCEL_DEPLOYMENTS_ENABLED: "1",
      VERCEL_API_TOKEN: "super-secret-token",
      VERCEL_TEAM_ID: "team_123",
      VERCEL_ORG_ID: "org_injected_by_vercel",
      VERCEL_TEAM_ID_SLUG: "team-slug",
      VERCEL_TOKEN: "legacy-token",
    }),
  );

  assert.deepEqual(presence, {
    enabled: true,
    tokenConfigured: true,
    teamIdConfigured: true,
    ignoredEnvNames: ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_TEAM_ID_SLUG"],
  });
  const serialized = JSON.stringify(presence);
  assert.equal(serialized.includes("super-secret-token"), false);
  assert.equal(serialized.includes("team_123"), false);
  assert.equal(serialized.includes("org_injected_by_vercel"), false);
});
