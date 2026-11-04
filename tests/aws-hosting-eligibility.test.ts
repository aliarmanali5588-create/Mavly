import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isAwsFrontendHostingProject,
  readAwsFrontendHostingConfig,
} from "@/lib/aws/config";
import {
  AWS_HOSTING_ELIGIBILITY_REASONS,
  awsHostingEligibilityMessage,
  evaluateAwsHostingEligibility,
  isAwsHostingEligibilityReason,
  type AwsHostingEligibilityFacts,
} from "@/lib/aws/eligibility";

function facts(
  overrides: Partial<AwsHostingEligibilityFacts> = {},
): AwsHostingEligibilityFacts {
  return {
    platformEnabled: true,
    project: { exists: true, ownedByCaller: true, projectType: "website" },
    userSuspended: false,
    generation: {
      hasFiles: true,
      latestStage: "completed",
      hasCompletedRun: true,
      activeRun: false,
    },
    plan: {
      projectLimit: 5,
      publishedSiteLimit: null,
      publishedSiteCount: 1,
    },
    capacity: {
      activeCount: 0,
      queuedCount: 0,
      maxActive: 1,
      maxQueued: 50,
    },
    ...overrides,
  };
}

test("an owned, generated website within plan and capacity is eligible", () => {
  assert.deepEqual(evaluateAwsHostingEligibility(facts()), {
    eligible: true,
    reason: "eligible",
  });
});

test("platform disablement outranks every project-specific rule", () => {
  const decision = evaluateAwsHostingEligibility(
    facts({
      platformEnabled: false,
      project: { exists: false, ownedByCaller: false, projectType: null },
      userSuspended: true,
    }),
  );
  assert.equal(decision.reason, "platform_hosting_disabled");
});

test("missing and foreign projects are refused without leaking a plan reason", () => {
  assert.equal(
    evaluateAwsHostingEligibility(
      facts({ project: { exists: false, ownedByCaller: false, projectType: null } }),
    ).reason,
    "project_not_found",
  );
  assert.equal(
    evaluateAwsHostingEligibility(
      facts({
        project: { exists: true, ownedByCaller: false, projectType: "website" },
        userSuspended: true,
      }),
    ).reason,
    "ownership_mismatch",
  );
});

test("suspended accounts and non-website projects cannot publish", () => {
  assert.equal(
    evaluateAwsHostingEligibility(facts({ userSuspended: true })).reason,
    "user_suspended",
  );
  assert.equal(
    evaluateAwsHostingEligibility(
      facts({ project: { exists: true, ownedByCaller: true, projectType: "android" } }),
    ).reason,
    "project_not_publishable",
  );
});

test("generation must be complete before a project is eligible", () => {
  const incomplete = [
    facts({ generation: { hasFiles: false, latestStage: null, hasCompletedRun: false, activeRun: false } }),
    facts({ generation: { hasFiles: true, latestStage: "generating", hasCompletedRun: true, activeRun: true } }),
    facts({ generation: { hasFiles: true, latestStage: "failed", hasCompletedRun: false, activeRun: false } }),
  ];
  for (const input of incomplete) {
    assert.equal(evaluateAwsHostingEligibility(input).reason, "generation_incomplete");
  }

  // A failed newest attempt does not invalidate an earlier completed build.
  assert.equal(
    evaluateAwsHostingEligibility(
      facts({ generation: { hasFiles: true, latestStage: "failed", hasCompletedRun: true, activeRun: false } }),
    ).eligible,
    true,
  );
});

test("the canonical plan limit gates publishing and is never invented", () => {
  assert.equal(
    evaluateAwsHostingEligibility(facts({ plan: { projectLimit: null, publishedSiteLimit: null, publishedSiteCount: 0 } })).reason,
    "plan_not_allowed",
  );
  assert.equal(
    evaluateAwsHostingEligibility(facts({ plan: { projectLimit: 0, publishedSiteLimit: null, publishedSiteCount: 0 } })).reason,
    "plan_not_allowed",
  );

  // With no platform override, the published-site ceiling is the plan's project limit.
  assert.equal(
    evaluateAwsHostingEligibility(facts({ plan: { projectLimit: 2, publishedSiteLimit: null, publishedSiteCount: 2 } })).reason,
    "project_limit_reached",
  );
  // An explicit platform ceiling replaces it.
  assert.equal(
    evaluateAwsHostingEligibility(facts({ plan: { projectLimit: 10, publishedSiteLimit: 1, publishedSiteCount: 1 } })).reason,
    "project_limit_reached",
  );
});

test("platform capacity refusal is truthful and keeps the work unqueued", () => {
  assert.equal(
    evaluateAwsHostingEligibility(
      facts({ capacity: { activeCount: 1, queuedCount: 50, maxActive: 1, maxQueued: 50 } }),
    ).reason,
    "hosting_capacity_exceeded",
  );
  assert.equal(
    evaluateAwsHostingEligibility(
      facts({ capacity: { activeCount: 0, queuedCount: 0, maxActive: 1, maxQueued: 0 } }),
    ).reason,
    "hosting_capacity_exceeded",
  );
});

test("every reason has a secret-free owner-facing message", () => {
  assert.equal(AWS_HOSTING_ELIGIBILITY_REASONS.length, 10);
  for (const reason of AWS_HOSTING_ELIGIBILITY_REASONS) {
    assert.equal(isAwsHostingEligibilityReason(reason), true);
    const message = awsHostingEligibilityMessage(reason);
    assert.ok(message.length > 10, reason);
    assert.doesNotMatch(message, /arn:|s3:|bucket|eu-north|505384438340/i);
  }
  assert.equal(isAwsHostingEligibilityReason("unknown"), false);
  assert.equal(isAwsHostingEligibilityReason(null), false);
});

test("the optional project restriction is not an onboarding allowlist", () => {
  const base = {
    NODE_ENV: "test",
    MAVLY_AWS_FRONTEND_HOSTING_ENABLED: "true",
    MAVLY_AWS_S3_BUCKET: "mavly-test-assets",
    MAVLY_AWS_REGION: "eu-north-1",
    MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN:
      "arn:aws:cloudfront::123456789012:key-value-store/12345678-1234-1234-1234-123456789012",
  } as const;

  // No restriction: every project is "not excluded"; the database decides.
  const unrestricted: Record<string, string | undefined> = { ...base };
  delete unrestricted.MAVLY_AWS_FRONTEND_HOSTING_PROJECTS;
  const unrestrictedConfig = readAwsFrontendHostingConfig(unrestricted);
  assert.equal(unrestrictedConfig.problem, null);
  assert.equal(unrestrictedConfig.restrictedProjects, null);
  assert.equal(isAwsFrontendHostingProject("a-brand-new-project", base), true);

  // An explicit restriction confines the deployment temporarily.
  const restricted = { ...base, MAVLY_AWS_FRONTEND_HOSTING_PROJECTS: "proj-alpha" };
  assert.equal(isAwsFrontendHostingProject("proj-alpha", restricted), true);
  assert.equal(isAwsFrontendHostingProject("proj-beta", restricted), false);

  // A wildcard is never a safe rollout shortcut.
  const wildcard = readAwsFrontendHostingConfig({
    ...base,
    MAVLY_AWS_FRONTEND_HOSTING_PROJECTS: "*",
  });
  assert.equal(wildcard.problem, "invalid_project_restriction");
  assert.equal(isAwsFrontendHostingProject("proj-alpha", {
    ...base,
    MAVLY_AWS_FRONTEND_HOSTING_PROJECTS: "*",
  }), false);

  // The configuration module no longer has a "missing cohort" failure at all.
  const source = readFileSync(
    new URL("../src/lib/aws/config.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /missing_cohort/);
  assert.match(source, /optional emergency restriction/i);
});

test("migration 61 owns eligibility, capacity and the enqueue guard", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/61_aws_hosting_eligibility.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /create table if not exists public\.hosting_platform_settings/);
  assert.match(migration, /publication_enabled boolean not null default true/);
  assert.match(migration, /max_active_publications/);
  assert.match(migration, /max_queued_publications/);
  assert.match(migration, /create or replace function public\.aws_hosting_eligibility/);
  assert.match(migration, /create or replace function public\.aws_hosting_worker_authorization/);
  assert.match(migration, /public\.account_user_is_restricted\(p_owner_id\)/);
  assert.match(migration, /HOSTING_NOT_ELIGIBLE/);
  assert.match(migration, /public\.billing_user_entitlements\(\)/);
  assert.match(migration, /aws_hosting_eligibility_schema_version/);
  assert.match(
    migration,
    /grant execute on function public\.aws_hosting_worker_authorization\(text, uuid\) to service_role/,
  );
  // It must not rewrite customer data or existing provider rows.
  assert.doesNotMatch(migration, /insert\s+into\s+public\.project_deployments/i);
  assert.doesNotMatch(migration, /update\s+public\.project_published_versions/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.projects/i);
});

test("the publish service and worker use the database eligibility layer", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const service = read("src/lib/deployments/service.ts");
  const worker = read("src/lib/aws/publication-worker.ts");
  const store = read("src/lib/aws/publication-store.ts");

  assert.match(service, /readAwsHostingEligibility/);
  assert.match(service, /awsEligibilityFailure/);
  assert.doesNotMatch(service, /awsCohort/);
  assert.match(service, /HOSTING_NOT_ELIGIBLE:/);

  assert.match(worker, /authorizeAwsHostingWorker/);
  assert.match(worker, /readAwsHostingCapacity/);
  assert.match(worker, /eligibility_rejected/);
  assert.match(worker, /capacity_throttled/);

  assert.match(store, /aws_hosting_worker_authorization/);
  assert.match(store, /aws_hosting_capacity_snapshot/);
  assert.match(store, /61_aws_hosting_eligibility\.sql/);
});

test("automatic eligibility does not touch Vercel or shared provider routing", () => {
  const service = readFileSync(
    new URL("../src/lib/deployments/service.ts", import.meta.url),
    "utf8",
  );
  assert.match(service, /HOSTING_MIGRATION_REQUIRED/);
  assert.match(service, /This project has an existing Vercel deployment/);
  assert.match(service, /This project has an existing shared-hosting publication/);
});
