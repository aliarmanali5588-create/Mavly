import { createHash } from "node:crypto";
import { contentTypeForPath, isSafePublishedSegment } from "@/lib/hosting/published-version";
import { readAwsFrontendHostingConfig } from "./config";
import { uploadToS3, verifyS3Object, type S3RequestOptions } from "./s3-client";

const MAX_FILES = 1_000;
const MAX_BYTES = 8_000_000;
const MAX_CONCURRENCY = 5;

export interface PublishableFile {
  path: string;
  content: string;
  contentType: string;
}

export interface S3PublicationResult {
  ok: true;
  projectId: string;
  versionId: string;
  uploadedCount: number;
  totalBytes: number;
  manifestHash: string;
  durationMs: number;
}

export interface S3PublicationFailure {
  ok: false;
  projectId: string;
  versionId: string;
  code: "INVALID_MANIFEST" | "S3_OBJECT_CONFLICT" | "S3_UPLOAD_FAILED";
  uploadedCount: number;
  failedCount: number;
}

export type S3PublicationOutcome = S3PublicationResult | S3PublicationFailure;

export class AwsPublicationLeaseLostError extends Error {
  constructor() {
    super("The AWS publication lease was lost while accessing S3.");
    this.name = "AwsPublicationLeaseLostError";
  }
}

export interface S3PublicationOptions extends S3RequestOptions {
  assertLease?: () => void;
}

function assertLease(options: S3PublicationOptions): void {
  options.assertLease?.();
  if (options.abortSignal?.aborted) throw new AwsPublicationLeaseLostError();
}

function validId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function validFilePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("%")) {
    return false;
  }
  const segments = path.split("/");
  return (
    segments.every(isSafePublishedSegment) &&
    segments.every((segment) => !/[?#]/.test(segment)) &&
    path === segments.join("/")
  );
}

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function validatePublishPath(path: string): { valid: true } | { valid: false; reason: string } {
  return validFilePath(path)
    ? { valid: true }
    : { valid: false, reason: "The path is not a safe relative published-file path." };
}

export function buildS3ObjectKey(
  projectId: string,
  versionId: string,
  filePath: string,
): string {
  if (!validId(projectId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId)) {
    throw new Error("Invalid immutable publication identity.");
  }
  if (!validFilePath(filePath)) throw new Error("Invalid published-file path.");
  return `${projectId}/${versionId}/${filePath}`;
}

function manifestHash(files: readonly PublishableFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(hashContent(file.content));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function validateFiles(files: readonly PublishableFile[]): boolean {
  if (files.length === 0 || files.length > MAX_FILES) return false;
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (
      !validFilePath(file.path) ||
      seen.has(file.path) ||
      contentTypeForPath(file.path) === "application/octet-stream" ||
      file.contentType !== contentTypeForPath(file.path)
    ) {
      return false;
    }
    seen.add(file.path);
    bytes += Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_BYTES) return false;
  }
  return true;
}

export async function publishToS3(
  projectId: string,
  versionId: string,
  files: PublishableFile[],
  options: S3PublicationOptions = {},
): Promise<S3PublicationOutcome> {
  const config = readAwsFrontendHostingConfig();
  if (
    !config.enabled ||
    config.problem !== null ||
    !config.bucket ||
    !validId(projectId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId) ||
    !validateFiles(files)
  ) {
    return {
      ok: false,
      projectId,
      versionId,
      code: "INVALID_MANIFEST",
      uploadedCount: 0,
      failedCount: files.length,
    };
  }

  const startedAt = Date.now();
  let nextIndex = 0;
  let uploadedCount = 0;
  let conflictCount = 0;
  let failureCount = 0;

  async function uploadWorker(): Promise<void> {
    while (true) {
      assertLease(options);
      const index = nextIndex++;
      if (index >= files.length) return;
      const file = files[index];
      const sha256 = hashContent(file.content);
      const sizeBytes = Buffer.byteLength(file.content, "utf8");
      const key = buildS3ObjectKey(projectId, versionId, file.path);
      try {
        const existing = await verifyS3Object(config.bucket!, key, {
          sha256,
          sizeBytes,
          contentType: file.contentType,
          projectId,
          versionId,
        }, options);
        if (existing.exists) {
          if (existing.matches) {
            uploadedCount += 1;
          } else {
            conflictCount += 1;
          }
          continue;
        }

        await uploadToS3(
          config.bucket!,
          key,
          file.content,
          file.contentType,
          sha256,
          projectId,
          versionId,
          options,
        );
        const verified = await verifyS3Object(config.bucket!, key, {
          sha256,
          sizeBytes,
          contentType: file.contentType,
          projectId,
          versionId,
        }, options);
        assertLease(options);
        if (!verified.exists || !verified.matches) {
          failureCount += 1;
        } else {
          uploadedCount += 1;
        }
      } catch (error) {
        if (error instanceof AwsPublicationLeaseLostError) throw error;
        assertLease(options);
        failureCount += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, files.length) }, uploadWorker),
  );

  if (conflictCount > 0) {
    return {
      ok: false,
      projectId,
      versionId,
      code: "S3_OBJECT_CONFLICT",
      uploadedCount,
      failedCount: conflictCount + failureCount,
    };
  }
  if (failureCount > 0 || uploadedCount !== files.length) {
    return {
      ok: false,
      projectId,
      versionId,
      code: "S3_UPLOAD_FAILED",
      uploadedCount,
      failedCount: Math.max(failureCount, files.length - uploadedCount),
    };
  }

  return {
    ok: true,
    projectId,
    versionId,
    uploadedCount,
    totalBytes: files.reduce(
      (total, file) => total + Buffer.byteLength(file.content, "utf8"),
      0,
    ),
    manifestHash: manifestHash(files),
    durationMs: Date.now() - startedAt,
  };
}

export async function verifyS3Publication(
  projectId: string,
  versionId: string,
  files: readonly PublishableFile[],
  expectedManifestHash: string,
  options: S3PublicationOptions = {},
): Promise<boolean> {
  const config = readAwsFrontendHostingConfig();
  if (!config.enabled || config.problem !== null || !config.bucket) {
    return false;
  }
  if (!validId(projectId) || !validateFiles(files)) return false;

  const expectedHash = manifestHash(files);
  for (const file of files) {
    assertLease(options);
    const object = await verifyS3Object(
      config.bucket,
      buildS3ObjectKey(projectId, versionId, file.path),
      {
        sha256: hashContent(file.content),
        sizeBytes: Buffer.byteLength(file.content, "utf8"),
        contentType: file.contentType,
        projectId,
        versionId,
      },
      options,
    );
    if (!object.exists || !object.matches) return false;
  }
  assertLease(options);
  return expectedHash === expectedManifestHash;
}
