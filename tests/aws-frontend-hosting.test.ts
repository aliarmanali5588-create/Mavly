import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  UpdateKeysCommand,
  type CloudFrontKeyValueStoreClient,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import {
  buildS3ObjectKey,
  hashContent,
  publishToS3,
  validatePublishPath,
} from "@/lib/aws/s3-publisher";
import {
  isAwsFrontendHostingProject,
  readAwsFrontendHostingConfig,
} from "@/lib/aws/config";
import {
  resetS3Client,
  setS3ClientForTests,
} from "@/lib/aws/s3-client";
import {
  activateAwsTenantMapping,
  readAwsTenantMapping,
  removeAwsTenantMapping,
  resetAwsTenantMappingClient,
  restoreAwsTenantMapping,
  setTenantMappingClientForTests,
} from "@/lib/aws/tenant-mapping";

const AWS_ENV_KEYS = [
  "MAVLY_AWS_FRONTEND_HOSTING_ENABLED",
  "MAVLY_AWS_S3_BUCKET",
  "MAVLY_AWS_REGION",
  "MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN",
  "MAVLY_AWS_FRONTEND_HOSTING_PROJECTS",
] as const;

const AWS_ENV = {
  MAVLY_AWS_FRONTEND_HOSTING_ENABLED: "true",
  MAVLY_AWS_S3_BUCKET: "mavly-test-assets",
  MAVLY_AWS_REGION: "eu-north-1",
  MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN:
    "arn:aws:cloudfront::123456789012:key-value-store/12345678-1234-1234-1234-123456789012",
  MAVLY_AWS_FRONTEND_HOSTING_PROJECTS: "proj-alpha",
} satisfies Record<(typeof AWS_ENV_KEYS)[number], string>;

async function withAwsEnvironment<T>(work: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of AWS_ENV_KEYS) {
    previous.set(key, process.env[key]);
    process.env[key] = AWS_ENV[key];
  }
  try {
    return await work();
  } finally {
    for (const key of AWS_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface FakeS3Object {
  contentLength: number;
  contentType: string;
  metadata: Record<string, string>;
  checksum: string | undefined;
}

function fakeS3Client(
  objects: Map<string, FakeS3Object>,
  options: { failPut?: boolean; corruptChecksum?: boolean } = {},
): {
  client: S3Client;
  putCount: () => number;
  lastPut: () => PutObjectCommand["input"] | null;
} {
  let putCount = 0;
  let lastPut: PutObjectCommand["input"] | null = null;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        const key = String((command as HeadObjectCommand).input.Key);
        const object = objects.get(key);
        if (!object) throw Object.assign(new Error("missing"), { name: "NotFound" });
        return {
          ContentLength: object.contentLength,
          ContentType: object.contentType,
          Metadata: object.metadata,
          ChecksumSHA256: object.checksum,
          ETag: '"etag"',
        };
      }
      if (command instanceof PutObjectCommand) {
        putCount += 1;
        if (options.failPut) throw new Error("simulated upload failure");
        const input = (command as PutObjectCommand).input;
        lastPut = input;
        const key = String(input.Key);
        const body = Buffer.from(input.Body as Uint8Array);
        objects.set(key, {
          contentLength: body.byteLength,
          contentType: String(input.ContentType),
          metadata: { ...(input.Metadata as Record<string, string>) },
          checksum: options.corruptChecksum
            ? undefined
            : String(input.ChecksumSHA256),
        });
        return { ETag: '"etag"' };
      }
      throw new Error("unexpected S3 command");
    },
    destroy: () => {},
  } as unknown as S3Client;
  return { client, putCount: () => putCount, lastPut: () => lastPut };
}

function fakeKvsClient(
  values: Map<string, string>,
  options: { conflictOnce?: boolean } = {},
): { client: CloudFrontKeyValueStoreClient; updateCount: () => number } {
  let etag = "etag-1";
  let updateCount = 0;
  let conflictPending = options.conflictOnce === true;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof DescribeKeyValueStoreCommand) {
        return { ETag: etag };
      }
      if (command instanceof GetKeyCommand) {
        const key = String((command as GetKeyCommand).input.Key);
        const value = values.get(key);
        if (value === undefined) {
          throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        }
        return { Value: value };
      }
      if (command instanceof UpdateKeysCommand) {
        updateCount += 1;
        const input = (command as UpdateKeysCommand).input;
        if (conflictPending) {
          conflictPending = false;
          throw Object.assign(new Error("etag conflict"), {
            name: "PreconditionFailedException",
          });
        }
        if (input.IfMatch !== etag) {
          throw Object.assign(new Error("etag conflict"), {
            name: "PreconditionFailedException",
          });
        }
        for (const put of input.Puts ?? []) {
          if (put.Key && put.Value !== undefined) values.set(put.Key, put.Value);
        }
        etag = `etag-${updateCount + 1}`;
        return {};
      }
      throw new Error("unexpected KVS command");
    },
    destroy: () => {},
  } as unknown as CloudFrontKeyValueStoreClient;
  return { client, updateCount: () => updateCount };
}

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

test("AWS cohort authorization is explicit and never wildcard-based", () => {
  assert.equal(isAwsFrontendHostingProject("proj-alpha", AWS_ENV), true);
  assert.equal(isAwsFrontendHostingProject("proj-beta", AWS_ENV), false);
  assert.equal(
    isAwsFrontendHostingProject("proj-alpha", {
      ...AWS_ENV,
      MAVLY_AWS_FRONTEND_HOSTING_PROJECTS: "*",
    }),
    false,
  );
});

test("AWS configuration fails closed for each missing or malformed prerequisite", () => {
  const complete = { ...AWS_ENV };
  const cases = [
    ["MAVLY_AWS_S3_BUCKET", "", "missing_bucket"],
    ["MAVLY_AWS_S3_BUCKET", "bad bucket", "invalid_bucket"],
    ["MAVLY_AWS_REGION", "", "missing_region"],
    ["MAVLY_AWS_REGION", "not-a-region", "invalid_region"],
    ["MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN", "not-an-arn", "missing_key_value_store"],
    ["MAVLY_AWS_FRONTEND_HOSTING_PROJECTS", "", "missing_cohort"],
    ["MAVLY_AWS_FRONTEND_HOSTING_PROJECTS", "*", "invalid_cohort"],
  ] as const;
  for (const [key, value, problem] of cases) {
    assert.equal(readAwsFrontendHostingConfig({ ...complete, [key]: value }).problem, problem);
  }
});

test("S3 publication uploads immutable objects and reuses exact matches", async () => {
  await withAwsEnvironment(async () => {
    const objects = new Map<string, FakeS3Object>();
    const fake = fakeS3Client(objects);
    setS3ClientForTests(fake.client);
    try {
      const versionId = "550e8400-e29b-41d4-a716-446655440001";
      const files = [{
        path: "index.html",
        content: "<h1>hello</h1>",
        contentType: "text/html; charset=utf-8",
      }];
      const first = await publishToS3("proj-alpha", versionId, files);
      assert.equal(first.ok, true);
      assert.equal(fake.putCount(), 1);
      assert.equal(fake.lastPut()?.ContentType, "text/html; charset=utf-8");
      assert.deepEqual(fake.lastPut()?.Metadata, {
        sha256: hashContent(files[0].content),
        "mavly-project-id": "proj-alpha",
        "mavly-version-id": versionId,
      });
      assert.equal(typeof fake.lastPut()?.ChecksumSHA256, "string");
      const second = await publishToS3("proj-alpha", versionId, files);
      assert.equal(second.ok, true);
      assert.equal(fake.putCount(), 1);
    } finally {
      resetS3Client();
    }
  });
});

test("S3 publication rejects immutable conflicts and checksum failures", async () => {
  await withAwsEnvironment(async () => {
    const versionId = "550e8400-e29b-41d4-a716-446655440001";
    const key = buildS3ObjectKey("proj-alpha", versionId, "index.html");
    const objects = new Map<string, FakeS3Object>([
      [key, {
        contentLength: 3,
        contentType: "text/html; charset=utf-8",
        metadata: {
          sha256: "0".repeat(64),
          "mavly-project-id": "proj-alpha",
          "mavly-version-id": versionId,
        },
        checksum: undefined,
      }],
    ]);
    const fake = fakeS3Client(objects);
    setS3ClientForTests(fake.client);
    try {
      const conflict = await publishToS3("proj-alpha", versionId, [{
        path: "index.html",
        content: "<h1>hello</h1>",
        contentType: "text/html; charset=utf-8",
      }]);
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.code, "S3_OBJECT_CONFLICT");

      objects.clear();
      const corrupt = fakeS3Client(objects, { corruptChecksum: true });
      setS3ClientForTests(corrupt.client);
      const failed = await publishToS3("proj-alpha", versionId, [{
        path: "index.html",
        content: "<h1>hello</h1>",
        contentType: "text/html; charset=utf-8",
      }]);
      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal(failed.code, "S3_UPLOAD_FAILED");

      objects.clear();
      const uploadFailure = fakeS3Client(objects, { failPut: true });
      setS3ClientForTests(uploadFailure.client);
      const uploadFailed = await publishToS3("proj-alpha", versionId, [{
        path: "index.html",
        content: "<h1>hello</h1>",
        contentType: "text/html; charset=utf-8",
      }]);
      assert.equal(uploadFailed.ok, false);
      if (!uploadFailed.ok) assert.equal(uploadFailed.code, "S3_UPLOAD_FAILED");
    } finally {
      resetS3Client();
    }
  });
});

test("KVS routing handles missing keys, ETag retry, generation fencing and tombstones", async () => {
  await withAwsEnvironment(async () => {
    const values = new Map<string, string>();
    const fake = fakeKvsClient(values, { conflictOnce: true });
    setTenantMappingClientForTests(fake.client);
    try {
      assert.equal(await readAwsTenantMapping("proj-alpha"), null);
      const mapping = {
        projectId: "proj-alpha",
        versionId: "550e8400-e29b-41d4-a716-446655440001",
        entryPath: "index.html",
        spaFallback: true,
        generation: 2,
      };
      await activateAwsTenantMapping(mapping);
      assert.equal(fake.updateCount(), 2);
      assert.deepEqual(await readAwsTenantMapping("proj-alpha"), mapping);

      await assert.rejects(
        () => activateAwsTenantMapping({ ...mapping, generation: 1 }),
        /newer tenant route generation/i,
      );
      await assert.rejects(
        () => activateAwsTenantMapping({
          ...mapping,
          versionId: "550e8400-e29b-41d4-a716-446655440002",
        }),
        /already assigned/i,
      );
      await restoreAwsTenantMapping({
        ...mapping,
        versionId: "550e8400-e29b-41d4-a716-446655440002",
      });
      await removeAwsTenantMapping("proj-alpha", 3);
      assert.equal(await readAwsTenantMapping("proj-alpha"), null);
    } finally {
      resetAwsTenantMappingClient();
    }
  });
});

test("CloudFront edge routing uses KVS and has no Supabase dependency", () => {
  const template = readFileSync("infra/aws-frontend-hosting/template.yaml", "utf8");
  assert.match(template, /AWS::CloudFront::KeyValueStore/);
  assert.match(template, /cf\.kvs\(\)/);
  assert.match(template, /route\.spaFallback && !hasExtension/);
  assert.match(template, /request\.uri = '\/' \+ projectId \+ '\/' \+ route\.versionId/);
  assert.doesNotMatch(template, /Supabase|PostgREST|resolve_published_tenant/i);
  assert.match(template, /ViewerAlias/);
  assert.match(template, /CreateFrontendBucket/);
  assert.match(template, /CreateTenantRouteStore/);
  assert.match(template, /DeletionPolicy: Retain/);
  assert.match(template, /StagingAliasMustBeExact/);
  assert.match(template, /ViewerAlias, "\*\.mavly\.xyz"/);
  assert.match(template, /s3:GetObject/);
  assert.match(template, /s3:PutObject/);
  assert.doesNotMatch(template, /s3:DeleteObject/);
});

test("CloudFront routing contract covers tenant hosts, SPA fallback and traversal defense", () => {
  const template = readFileSync("infra/aws-frontend-hosting/template.yaml", "utf8");
  assert.match(template, /hostHeader/);
  assert.match(template, /const match = \/\^\(\[a-z\]/);
  assert.match(template, /-\(\?=\[a-z0-9\]\)/);
  assert.match(template, /\{0,62\}\)\\\.mavly\\\.xyz/);
  assert.match(template, /decodeURIComponent/);
  assert.match(template, /segment === '\.' \|\| segment === '\.\.'/);
  assert.match(template, /%\\\\\?#/);
  assert.match(template, /request\.uri = '\/' \+ projectId \+ '\/' \+ route\.versionId/);
  assert.match(template, /route\.spaFallback && !hasExtension/);
  assert.match(template, /trailingSlash/);
  assert.match(template, /statusCode: 404/);
  assert.match(template, /statusCode: 503/);
});

test("the single generation worker keeps AWS as an idle side queue", () => {
  const generationWorker = readFileSync("src/lib/generation/worker.ts", "utf8");
  const publicationWorker = readFileSync("src/lib/aws/publication-worker.ts", "utf8");
  const entrypoint = readFileSync("workers/aws-generation-worker.ts", "utf8");
  assert.match(generationWorker, /runAwsFrontendPublicationTick/);
  assert.ok(
    generationWorker.indexOf("runVerificationSafely") <
      generationWorker.indexOf("runAndroidBuildSafely") &&
      generationWorker.indexOf("runAndroidBuildSafely") <
        generationWorker.indexOf("runAwsPublicationSafely"),
  );
  assert.match(entrypoint, /workers\/register-node-ts-resolver\.mjs/);
  assert.doesNotMatch(entrypoint, /setInterval\([^)]*publication/i);
  assert.match(publicationWorker, /readAwsFrontendSchemaVersion/);
  assert.match(publicationWorker, /schema\.data < 51/);
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
  assert.match(migration, /on delete cascade/gi);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/);
  assert.match(migration, /grant execute on function public\.claim_aws_frontend_publication\(\)\s+to service_role/);
  assert.match(migration, /grant execute on function public\.claim_aws_frontend_unpublish\(\)\s+to service_role/);
  assert.match(migration, /lease_expires_at <= now\(\)/);
  assert.match(migration, /routing_generation = v_job\.routing_generation/);
  assert.match(migration, /guard_aws_project_deletion/);
  assert.match(migration, /AWS_PUBLICATION_MUST_BE_UNPUBLISHED/);
  assert.match(migration, /guard_aws_deployment_mutations/);
  assert.match(migration, /AWS_ACTIVE_VERSION_WORKER_ONLY/);
  assert.match(migration, /AWS_DEPLOYMENT_STATE_WORKER_ONLY/);
  assert.match(migration, /AWS_DEPLOYMENT_MIGRATION_REQUIRED/);
  assert.match(migration, /shared_hosting_schema_version\(\)/);
  assert.match(migration, /generation_worker_schema_version\(\)/);
  assert.match(migration, /AWS_FRONTEND_PREREQUISITE_MISSING/);
});
