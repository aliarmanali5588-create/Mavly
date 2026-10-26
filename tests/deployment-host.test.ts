import { test } from "node:test";
import assert from "node:assert/strict";

import { MAVLY_PUBLIC_DOMAIN, mavlyHostname } from "../src/lib/mavly-hostname";
import { deploymentHost, wireDeploymentStatus } from "../src/lib/deployments/service";
import type { DeploymentRow } from "../src/lib/deployments/store";

/**
 * ═══ THE PUBLISHED ADDRESS IS DERIVED, NOT STORED ═══════════════════════════
 *
 * Two pure functions decide where a published project says it lives:
 *
 *   · `mavlyHostname` — `<project-id>.mavly.xyz`, derived only from the immutable
 *     owned project id;
 *   · `deploymentHost` / `wireDeploymentStatus` — the verified Mavly hostname, or
 *     the legacy Vercel project host, and NEVER `row.url`.
 *
 * ⚠️ `row.url` IS VERCEL'S PER-DEPLOYMENT URL. It is set after the deployment is
 * created (`target: "production"`), cleared when a re-publish claims the row, and
 * rewritten when the next deployment is recorded. It is not the production alias
 * and it is not stable across publishes. These tests pin that down so a future
 * "just use the saved URL" change cannot quietly turn the public address into a
 * dead deployment host — or make an unverified hostname look live.
 *
 * Nothing here talks to Vercel, Supabase, DNS or Cloudflare. A 522 at a custom
 * hostname is an edge/origin problem outside this repository; these tests only
 * cover what the repository actually owns.
 */

const PROJECT_ID = "meri-ek-car-ki";
const MAVLY_HOST = "meri-ek-car-ki.mavly.xyz";
const VERCEL_PROJECT_NAME = "mavly-meri-ek-car-ki-1a2b3c4d";

function row(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    project_id: PROJECT_ID,
    provider: "vercel",
    vercel_project_id: "prj_example",
    vercel_project_name: VERCEL_PROJECT_NAME,
    vercel_deployment_id: "dpl_example",
    status: "ready",
    // A deployment-specific host, deliberately unlike the project host below.
    url: "meri-ek-car-ki-9f8e7d-mavly.vercel.app",
    error_code: null,
    error_message: null,
    mavly_hostname: MAVLY_HOST,
    mavly_domain_status: "verified",
    mavly_domain_error: null,
    mavly_domain_checked_at: "2026-10-25T00:00:00.000Z",
    created_at: "2026-10-24T00:00:00.000Z",
    updated_at: "2026-10-25T00:00:00.000Z",
    last_published_at: "2026-10-25T00:00:00.000Z",
    last_unpublished_at: null,
    ...overrides,
  };
}

// ── hostname derivation ─────────────────────────────────────────────────────

test("a project id derives exactly one Mavly hostname", () => {
  assert.equal(MAVLY_PUBLIC_DOMAIN, "mavly.xyz");
  assert.equal(mavlyHostname(PROJECT_ID), MAVLY_HOST);
  // One project label plus the two domain labels — nothing appended.
  assert.equal(mavlyHostname(PROJECT_ID)?.split(".").length, 3);
});

test("case and surrounding whitespace are normalised before validation", () => {
  assert.equal(mavlyHostname("  Meri-Ek-Car-Ki  "), MAVLY_HOST);
  assert.equal(mavlyHostname("MERI-EK-CAR-KI"), MAVLY_HOST);
});

test("a project id that cannot be routed gets no hostname", () => {
  const rejected = [
    "",
    "   ",
    "meri_ek_car_ki",
    "meri.ek",
    "meri/ek",
    "-meri",
    "meri-",
    "meri--ek",
    "meri ek",
    "meri?ek",
    "meri#ek",
    "meri:ek",
    "..",
    "meri.ek.mavly.xyz",
    `${"a".repeat(64)}`,
  ];

  for (const value of rejected) {
    assert.equal(mavlyHostname(value), null, `expected no hostname for ${JSON.stringify(value)}`);
  }
});

test("a hostname is never taken from user-shaped input", () => {
  // A full hostname pasted as a project id must not be accepted as one.
  assert.equal(mavlyHostname("meri-ek-car-ki.mavly.xyz"), null);
  // Nor may a project id smuggle another label in front of the Mavly domain.
  assert.equal(mavlyHostname("evil.example"), null);
});

// ── deploymentHost ──────────────────────────────────────────────────────────

test("no deployment row means no published host", () => {
  assert.equal(deploymentHost(null), "");
});

test("the Mavly hostname is exposed only after Vercel verifies it", () => {
  assert.equal(deploymentHost(row({ mavly_domain_status: "verified" })), MAVLY_HOST);
  assert.equal(deploymentHost(row({ mavly_domain_status: "pending" })), "");
  assert.equal(deploymentHost(row({ mavly_domain_status: "error" })), "");
  // Defensive: a hostname without a state is not evidence of verification.
  assert.equal(deploymentHost(row({ mavly_domain_status: null })), "");
});

test("a legacy row keeps its Vercel project host", () => {
  const legacy = row({ mavly_hostname: null, mavly_domain_status: null });
  assert.equal(deploymentHost(legacy), `${VERCEL_PROJECT_NAME}.vercel.app`);
  assert.equal(deploymentHost(legacy).includes("://"), false);
});

test("row.url is never the published address", () => {
  const misleading = "https://attacker.example/not-the-site";

  assert.equal(
    deploymentHost(row({ url: misleading, mavly_domain_status: "verified" })),
    MAVLY_HOST,
  );
  assert.equal(
    deploymentHost(row({ url: misleading, mavly_hostname: null, mavly_domain_status: null })),
    `${VERCEL_PROJECT_NAME}.vercel.app`,
  );

  const wire = wireDeploymentStatus(
    row({ url: "wrong-deployment-host.vercel.app", mavly_domain_status: "verified" }),
  );
  assert.equal(JSON.stringify(wire).includes("wrong-deployment-host"), false);
});

// ── wireDeploymentStatus ────────────────────────────────────────────────────

test("a ready deployment with a verified Mavly host is the only success path", () => {
  const wire = wireDeploymentStatus(row());

  assert.equal(wire.status, "success");
  assert.equal(wire.step, "success");
  assert.equal(wire.liveUrl, `https://${MAVLY_HOST}`);
  assert.equal(wire.createdAt, "2026-10-25T00:00:00.000Z");
});

test("a ready deployment with a pending Mavly host is still deploying", () => {
  const wire = wireDeploymentStatus(row({ mavly_domain_status: "pending" }));

  assert.equal(wire.status, "deploying");
  assert.equal(wire.step, "domain");
  assert.equal(wire.liveUrl, undefined);
});

test("a domain error on a ready deployment is a domain failure, not a success", () => {
  const wire = wireDeploymentStatus(
    row({
      mavly_domain_status: "error",
      mavly_domain_error: "Vercel could not verify the Mavly address.",
      error_code: "domain_not_found",
    }),
  );

  assert.equal(wire.status, "error");
  assert.equal(wire.liveUrl, undefined);
  assert.equal(wire.errorDetails?.stage, "domain");
  assert.match(wire.errorDetails?.message ?? "", /could not verify/i);
});

test("a legacy row reaches success on the Vercel project host", () => {
  const wire = wireDeploymentStatus(row({ mavly_hostname: null, mavly_domain_status: null }));

  assert.equal(wire.status, "success");
  assert.equal(wire.liveUrl, `https://${VERCEL_PROJECT_NAME}.vercel.app`);
});

test("a deployment that is not ready cannot report success, even with a verified host", () => {
  const building = wireDeploymentStatus(row({ status: "building" }));
  assert.equal(building.status, "deploying");
  assert.equal(building.step, "building");
  assert.equal(building.liveUrl, undefined);

  const failed = wireDeploymentStatus(row({ status: "error", error_message: "build failed" }));
  assert.equal(failed.status, "error");
  assert.equal(failed.liveUrl, undefined);
  assert.equal(failed.errorDetails?.stage, "build");
});

test("a pending domain does not become an error from an unrelated code", () => {
  const wire = wireDeploymentStatus(
    row({ mavly_domain_status: "pending", error_code: "deployment_stalled" }),
  );

  // `wireDeploymentStatus` only reports a domain failure when the domain state
  // itself is `error`; a stale unrelated code must not fabricate one.
  assert.equal(wire.status, "deploying");
  assert.equal(wire.step, "domain");
  assert.equal(wire.liveUrl, undefined);
});

// ── unpublish states ────────────────────────────────────────────────────────

test("an unpublished row exposes no public address at all", () => {
  const unpublished = row({
    status: "unpublished",
    vercel_deployment_id: null,
    url: null,
    last_unpublished_at: "2026-10-26T00:00:00.000Z",
  });

  assert.equal(deploymentHost(unpublished), "");

  const wire = wireDeploymentStatus(unpublished);
  assert.equal(wire.status, "unpublished");
  assert.equal(wire.step, "unpublished");
  assert.equal(wire.liveUrl, undefined);
  assert.equal(wire.deploymentId, undefined);
  assert.equal(wire.canUnpublish, false);
  // The timestamp describes the takedown, not the original publish.
  assert.equal(wire.createdAt, "2026-10-26T00:00:00.000Z");
});

test("an in-flight unpublish cannot be started twice", () => {
  const wire = wireDeploymentStatus(
    row({ status: "unpublishing", updated_at: new Date().toISOString() }),
  );

  assert.equal(wire.status, "unpublishing");
  assert.equal(wire.step, "unpublishing");
  assert.equal(wire.liveUrl, undefined);
  assert.equal(wire.canUnpublish, false);
  // The old deployment id is still recorded (and still being removed).
  assert.equal(wire.deploymentId, "dpl_example");
});

test("a live deployment can be unpublished", () => {
  assert.equal(wireDeploymentStatus(row()).canUnpublish, true);
});

test("a failed republish with evidence it reached Vercel can still be unpublished", () => {
  // A previous production deployment can keep serving at the same host while
  // the newest attempt is `error`; that site still needs a real takedown.
  assert.equal(
    wireDeploymentStatus(row({ status: "error", error_message: "build failed" })).canUnpublish,
    true,
  );
  assert.equal(
    wireDeploymentStatus(
      row({
        status: "canceled",
        mavly_hostname: null,
        mavly_domain_status: null,
        vercel_deployment_id: "dpl_still_live",
      }),
    ).canUnpublish,
    true,
  );
});

test("a first publish that failed before reaching Vercel offers no unpublish", () => {
  const neverDeployed = row({
    status: "error",
    error_message: "The project has no static files to publish.",
    vercel_deployment_id: null,
    mavly_hostname: null,
    mavly_domain_status: null,
    url: null,
  });

  assert.equal(wireDeploymentStatus(neverDeployed).canUnpublish, false);
});
