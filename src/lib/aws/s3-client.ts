import {
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { readAwsFrontendHostingConfig } from "./config";

let client: S3Client | null = null;

/** Injectable only so unit tests can exercise the exact AWS command contract. */
export function setS3ClientForTests(next: S3Client | null): void {
  client?.destroy();
  client = next;
}

export function getS3Client(): S3Client {
  if (client) return client;
  const config = readAwsFrontendHostingConfig();
  if (!config.enabled || config.problem !== null || !config.region) {
    throw new Error(`AWS frontend hosting is not configured: ${config.problem ?? "disabled"}`);
  }
  client = new S3Client({
    region: config.region,
    // The durable publication lease retries the whole job; the SDK retry budget
    // handles transient transport failures for one object without duplicating a
    // publication attempt or requiring DeleteObject permission.
    maxAttempts: 3,
  });
  return client;
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export interface S3ObjectExpectation {
  sha256: string;
  sizeBytes: number;
  contentType: string;
  projectId: string;
  versionId: string;
}

export interface S3RequestOptions {
  abortSignal?: AbortSignal;
}

export async function inspectS3Object(
  bucket: string,
  key: string,
  options: S3RequestOptions = {},
): Promise<{ exists: false } | { exists: true; etag: string | null; matches: boolean }> {
  try {
    const response = await getS3Client().send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        ChecksumMode: "ENABLED",
      }),
      options,
    );
    return {
      exists: true,
      etag: response.ETag ?? null,
      matches: false,
    };
  } catch (error) {
    if (isMissingObject(error)) return { exists: false };
    throw error;
  }
}

export async function verifyS3Object(
  bucket: string,
  key: string,
  expected: S3ObjectExpectation,
  options: S3RequestOptions = {},
): Promise<{ exists: false } | { exists: true; etag: string | null; matches: boolean }> {
  try {
    const response = await getS3Client().send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        ChecksumMode: "ENABLED",
      }),
      options,
    );
    const expectedChecksum = Buffer.from(expected.sha256, "hex").toString("base64");
    const metadataHash = response.Metadata?.sha256;
    const checksumMatches =
      response.ChecksumSHA256 === expectedChecksum ||
      (!response.ChecksumSHA256 && metadataHash === expected.sha256);
    return {
      exists: true,
      etag: response.ETag ?? null,
      matches:
        response.ContentLength === expected.sizeBytes &&
        response.ContentType === expected.contentType &&
        response.Metadata?.["mavly-project-id"] === expected.projectId &&
        response.Metadata?.["mavly-version-id"] === expected.versionId &&
        checksumMatches,
    };
  } catch (error) {
    if (isMissingObject(error)) return { exists: false };
    throw error;
  }
}

export async function uploadToS3(
  bucket: string,
  key: string,
  content: string,
  contentType: string,
  sha256: string,
  projectId: string,
  versionId: string,
  options: S3RequestOptions = {},
): Promise<string | null> {
  const body = Buffer.from(content, "utf8");
  const expectedChecksum = Buffer.from(sha256, "hex").toString("base64");
  const result = await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: contentType,
      ChecksumAlgorithm: "SHA256",
      ChecksumSHA256: expectedChecksum,
      ServerSideEncryption: "AES256",
      Metadata: {
        sha256,
        "mavly-project-id": projectId,
        "mavly-version-id": versionId,
      },
      }),
      options,
  );
  return result.ETag ?? null;
}

export async function verifyS3BucketAccess(bucket: string): Promise<void> {
  await getS3Client().send(new HeadBucketCommand({ Bucket: bucket }));
}

export function resetS3Client(): void {
  client?.destroy();
  client = null;
}
