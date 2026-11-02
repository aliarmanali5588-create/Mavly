import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildS3ObjectKey,
  hashContent,
  validatePublishPath,
} from "@/lib/aws/s3-publisher";
import { readAwsFrontendHostingConfig } from "@/lib/aws/config";

test("AWS publisher accepts safe version-relative paths", () => {
  assert.deepEqual(validatePublishPath("index.html"), { valid: true });
  assert.deepEqual(validatePublishPath("assets/app.js"), { valid: true });
  assert.equal(
    buildS3ObjectKey(
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440001",
      "assets/app.js",
    ),
    "550e8400-e29b-41d4-a716-446655440000/550e8400-e29b-41d4-a716-446655440001/assets/app.js",
  );
});

test("AWS publisher rejects ambiguous and traversing paths", () => {
  for (const path of [
    "../index.html",
    "assets/../../secret",
    "/index.html",
    "assets\\app.js",
    "assets/%2e%2e/secret",
    "assets/app.js?download=1",
    "assets/#fragment",
  ]) {
    assert.equal(validatePublishPath(path).valid, false, path);
  }
});

test("publication keys require a safe project ID and UUID version", () => {
  assert.throws(() => buildS3ObjectKey("../tenant", "invalid", "index.html"));
  assert.throws(() =>
    buildS3ObjectKey(
      "tenant",
      "550e8400-e29b-41d4-a716-446655440001",
      "../index.html",
    ),
  );
});

test("content SHA-256 is stable across string and byte inputs", () => {
  assert.equal(hashContent("hello"), hashContent(Buffer.from("hello")));
  assert.notEqual(hashContent("hello"), hashContent("world"));
  assert.match(hashContent("hello"), /^[a-f0-9]{64}$/);
});

test("AWS hosting stays opt-in and requires its complete private-hosting config", () => {
  const disabled = readAwsFrontendHostingConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
  assert.equal(disabled.enabled, false);

  const enabled = readAwsFrontendHostingConfig({
    NODE_ENV: "test",
    MAVLY_AWS_FRONTEND_HOSTING_ENABLED: "true",
    MAVLY_AWS_S3_BUCKET: "mavly-test-assets",
    MAVLY_AWS_REGION: "us-west-2",
    MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN:
      "arn:aws:cloudfront::123456789012:key-value-store/12345678-1234-1234-1234-123456789012",
    MAVLY_AWS_FRONTEND_HOSTING_PROJECTS: "550e8400-e29b-41d4-a716-446655440000",
  });
  assert.equal(enabled.problem, null);

  const wildcard = readAwsFrontendHostingConfig({
    NODE_ENV: "test",
    MAVLY_AWS_FRONTEND_HOSTING_ENABLED: "true",
    MAVLY_AWS_S3_BUCKET: "mavly-test-assets",
    MAVLY_AWS_REGION: "us-west-2",
    MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN:
      "arn:aws:cloudfront::123456789012:key-value-store/12345678-1234-1234-1234-123456789012",
    MAVLY_AWS_FRONTEND_HOSTING_PROJECTS: "*",
  });
  assert.equal(wildcard.problem, "invalid_cohort");
});

test("CloudFront edge routing uses KVS and has no Supabase dependency", () => {
  const template = readFileSync("infra/aws-frontend-hosting/template.yaml", "utf8");
  assert.match(template, /AWS::CloudFront::KeyValueStore/);
  assert.match(template, /cf\.kvs\(\)/);
  assert.match(template, /route\.spaFallback && !hasExtension/);
  assert.match(template, /request\.uri = '\/' \+ projectId \+ '\/' \+ route\.versionId/);
  assert.doesNotMatch(template, /Supabase|PostgREST|resolve_published_tenant/i);
});

test("AWS migration uses existing shared-publication tables without migration-50 dependency", () => {
  const migration = readFileSync(
    "supabase/migrations/51_aws_frontend_deployment.sql",
    "utf8",
  );
  const worker = readFileSync("src/lib/aws/publication-worker.ts", "utf8");
  const deploymentService = readFileSync("src/lib/deployments/service.ts", "utf8");
  assert.match(migration, /aws_frontend_publications/);
  assert.match(migration, /renew_aws_frontend_publication/);
  assert.match(migration, /enqueue_aws_frontend_unpublish/);
  assert.match(migration, /claim_aws_frontend_unpublish/);
  assert.match(migration, /fail_aws_frontend_unpublish/);
  assert.match(migration, /complete_aws_frontend_unpublish/);
  assert.match(worker, /claimAwsFrontendUnpublish/);
  assert.match(worker, /removeAwsTenantMapping/);
  assert.match(worker, /verifyAwsPublicTenantRouteRemoved/);
  assert.match(worker, /completeAwsFrontendUnpublish/);
  assert.doesNotMatch(deploymentService, /removeAwsTenantMapping/);
  assert.doesNotMatch(migration, /50_admin_console_backend/);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.project_deployments\s*\(/i);
});
