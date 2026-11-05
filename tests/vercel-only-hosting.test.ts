import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * Static invariants for the Phase 18 cleanup: AWS customer frontend hosting is
 * removed, Vercel is the only customer hosting provider, and the AWS EC2
 * generation worker is untouched.
 *
 * These read source, manifests and migration text. They do not call Vercel,
 * AWS, Supabase or the database.
 */

const read = (path: string): string => readFileSync(path, "utf8");

test("the AWS frontend hosting implementation and dependencies are gone", () => {
  assert.equal(existsSync("src/lib/aws"), false);
  assert.equal(existsSync("src/lib/domains/aws-provider.ts"), false);
  assert.equal(existsSync("infra/aws-frontend-hosting"), false);

  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies["@aws-sdk/client-s3"], undefined);
  assert.equal(pkg.dependencies["@aws-sdk/client-cloudfront-keyvaluestore"], undefined);

  const lock = JSON.parse(read("package-lock.json")) as {
    packages: Record<string, unknown>;
  };
  assert.equal(lock.packages["node_modules/@aws-sdk/client-s3"], undefined);
  assert.equal(
    lock.packages["node_modules/@aws-sdk/client-cloudfront-keyvaluestore"],
    undefined,
  );
});

test("no active hosting code imports AWS hosting modules or reads its flags", () => {
  const files = [
    "src/lib/deployments/service.ts",
    "src/lib/deployments/store.ts",
    "src/lib/mavly/api.ts",
    "src/lib/domains/active-provider.ts",
    "src/lib/domains/worker.ts",
    "src/lib/domains/service.ts",
    "src/lib/domains/config.ts",
    "src/lib/domains/store.ts",
    "src/lib/generation/worker.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /@\/lib\/aws\//, file);
    assert.doesNotMatch(
      source,
      /MAVLY_AWS_FRONTEND_HOSTING|MAVLY_AWS_S3_BUCKET|MAVLY_AWS_REGION|MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN/,
      file,
    );
    assert.doesNotMatch(
      source,
      /awsDomainRoutingProvider|runAwsFrontendPublicationTick|readAwsHostingEligibility/,
      file,
    );
  }
});

test("a new publication never selects AWS, and an archived row is refused truthfully", () => {
  const service = read("src/lib/deployments/service.ts");
  assert.doesNotMatch(
    service,
    /enqueueAwsPublication|unpublishAwsProject|awsDeploymentStatus|existingAwsDeployment/,
  );
  assert.match(service, /if \(existing\.data\?\.provider === "aws"\)/);
  assert.match(service, /HOSTING_PROVIDER_RETIRED/);
  assert.match(service, /it has NOT been reported as unpublished/);
  // The stored status of an archived row is returned, never overwritten.
  assert.match(
    service,
    /if \(row\.data\.provider === "aws"\) \{[\s\S]*?wireDeploymentStatus\(row\.data\)/,
  );
});

test("Vercel is the only domain routing provider", () => {
  const active = read("src/lib/domains/active-provider.ts");
  assert.match(active, /vercelDomainRoutingProvider/);
  assert.doesNotMatch(active, /aws-provider|awsDomainRoutingProvider/);

  const provider = read("src/lib/domains/provider.ts");
  assert.match(provider, /readonly id: "vercel"/);
  assert.doesNotMatch(provider, /aws_cloudfront/);

  const worker = read("src/lib/domains/worker.ts");
  assert.doesNotMatch(worker, /from "\.\/aws-provider"/);
  assert.match(worker, /vercelProjectTarget/);
});

test("an archived AWS route is never reported as removed", () => {
  const worker = read("src/lib/domains/worker.ts");
  assert.match(worker, /routingProvider === "aws_cloudfront"/);
  assert.match(worker, /DOMAIN_ROUTING_PROVIDER_RETIRED/);
  assert.match(worker, /has not reported the address as removed/);
});

test("the AWS EC2 generation worker and its configuration are preserved", () => {
  for (const path of [
    "workers/aws-generation-worker.ts",
    "infra/aws-generation-worker/mavly-aws-worker.service",
    "docs/runbooks/aws-generation-worker.md",
    "src/lib/generation/worker.ts",
  ]) {
    assert.equal(existsSync(path), true, path);
  }
  assert.match(read("workers/aws-generation-worker.ts"), /MAVLY_AWS_WORKER/);
  assert.match(
    read("src/lib/generation/worker-config.ts"),
    /AWS_WORKER_ENV = "MAVLY_AWS_WORKER"/,
  );

  const env = read(".env.example");
  assert.match(env, /^MAVLY_AWS_WORKER=/m);
  assert.match(env, /^MAVLY_RENDER_WORKER_DISABLED=/m);
  assert.doesNotMatch(
    env,
    /^MAVLY_AWS_FRONTEND_HOSTING_ENABLED=|^MAVLY_AWS_S3_BUCKET=|^MAVLY_AWS_REGION=|^MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN=|^MAVLY_AWS_FRONTEND_HOSTING_PROJECTS=/m,
  );
});

test("Vercel configuration is still declared and never public", () => {
  const env = read(".env.example");
  assert.match(env, /^MAVLY_VERCEL_DEPLOYMENTS_ENABLED=/m);
  assert.match(env, /^VERCEL_API_TOKEN=/m);
  assert.match(env, /^VERCEL_PROJECT_PREFIX=/m);
  assert.doesNotMatch(env, /NEXT_PUBLIC_VERCEL/);
});

test("migration 65 retires AWS hosting without deleting history", () => {
  const migration = read("supabase/migrations/65_retire_aws_frontend_hosting.sql");
  assert.match(migration, /aws_frontend_hosting_retirement_schema_version/);
  assert.match(migration, /aws_hosting_retired/);
  assert.match(migration, /where provider = 'aws'/);
  assert.match(migration, /status in \('queued', 'building', 'unpublishing'\)/);
  assert.doesNotMatch(migration, /drop\s+table/i);
  assert.doesNotMatch(migration, /delete\s+from/i);
  assert.doesNotMatch(migration, /truncate/i);
  assert.doesNotMatch(migration, /drop\s+column/i);
  assert.doesNotMatch(migration, /set\s+provider\s*=/i);
});
