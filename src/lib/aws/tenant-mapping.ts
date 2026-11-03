import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  UpdateKeysCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import { mavlyHostname } from "@/lib/mavly-hostname";
import { readAwsFrontendHostingConfig } from "./config";

const CLOUDFRONT_CONTROL_REGION = "us-east-1";
const MAX_ETAG_RETRIES = 3;

export interface AwsTenantMapping {
  projectId: string;
  versionId: string;
  entryPath: string;
  spaFallback: boolean;
  generation: number;
}

let client: CloudFrontKeyValueStoreClient | null = null;

/** Injectable only so unit tests can exercise KVS fencing without AWS calls. */
export function setTenantMappingClientForTests(
  next: CloudFrontKeyValueStoreClient | null,
): void {
  client?.destroy();
  client = next;
}

function getClient(): CloudFrontKeyValueStoreClient {
  if (!client) {
    client = new CloudFrontKeyValueStoreClient({
      region: CLOUDFRONT_CONTROL_REGION,
    });
  }
  return client;
}

function validateMapping(mapping: AwsTenantMapping): void {
  const hostname = mavlyHostname(mapping.projectId);
  if (
    !hostname ||
    !Number.isSafeInteger(mapping.generation) ||
    mapping.generation < 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mapping.versionId) ||
    !mapping.entryPath ||
    mapping.entryPath.startsWith("/") ||
    mapping.entryPath.includes("\\") ||
    mapping.entryPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid AWS tenant mapping.");
  }
}

function storedGeneration(value: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CloudFront KeyValueStore contains an invalid tenant mapping.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CloudFront KeyValueStore contains an invalid tenant mapping.");
  }
  const generation = (parsed as Record<string, unknown>).generation;
  if (generation === undefined) return 0;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    throw new Error("CloudFront KeyValueStore contains an invalid route generation.");
  }
  return generation as number;
}

function isMissingKey(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "ResourceNotFoundException" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function updateMapping(
  projectId: string,
  value: string,
  options: { allowWhenDisabled?: boolean; allowSameGenerationOverride?: boolean } = {},
): Promise<void> {
  const config = readAwsFrontendHostingConfig();
  if (
    (!(options.allowWhenDisabled && config.keyValueStoreArn) &&
      (!config.enabled || config.problem !== null)) ||
    !config.keyValueStoreArn
  ) {
    throw new Error(`AWS frontend hosting is not configured: ${config.problem ?? "disabled"}`);
  }

  const storeArn = config.keyValueStoreArn;
  for (let attempt = 0; attempt < MAX_ETAG_RETRIES; attempt += 1) {
    const description = await getClient().send(
      new DescribeKeyValueStoreCommand({ KvsARN: storeArn }),
    );
    if (!description.ETag) throw new Error("CloudFront KeyValueStore returned no ETag.");

    let existing: string | null = null;
    try {
      const current = await getClient().send(
        new GetKeyCommand({ KvsARN: storeArn, Key: projectId }),
      );
      existing = current.Value ?? null;
    } catch (error) {
      if (!isMissingKey(error)) throw error;
    }

    if (existing === value) return;
    if (existing !== null) {
      const currentGeneration = storedGeneration(existing);
      const nextGeneration = storedGeneration(value);
      if (currentGeneration > nextGeneration) {
        throw new Error("A newer tenant route generation is already active.");
      }
      if (
        currentGeneration === nextGeneration &&
        !options.allowSameGenerationOverride
      ) {
        throw new Error("The tenant route generation is already assigned.");
      }
    }

    try {
      await getClient().send(
        new UpdateKeysCommand({
          KvsARN: storeArn,
          IfMatch: description.ETag,
          Puts: [{ Key: projectId, Value: value }],
        }),
      );
      return;
    } catch (error) {
      if (!isEtagConflict(error) || attempt === MAX_ETAG_RETRIES - 1) throw error;
    }
  }
}

function isEtagConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === "PreconditionFailedException" ||
    candidate.$metadata?.httpStatusCode === 412
  );
}

export async function readAwsTenantMapping(
  projectId: string,
): Promise<AwsTenantMapping | null> {
  const config = readAwsFrontendHostingConfig();
  if (!config.enabled || config.problem !== null || !config.keyValueStoreArn) {
    throw new Error(`AWS frontend hosting is not configured: ${config.problem ?? "disabled"}`);
  }
  try {
    const result = await getClient().send(
      new GetKeyCommand({ KvsARN: config.keyValueStoreArn, Key: projectId }),
    );
    if (!result.Value) return null;
    const value: unknown = JSON.parse(result.Value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.disabled === true) return null;
    if (
      typeof record.projectId !== "string" ||
      typeof record.versionId !== "string" ||
      typeof record.entryPath !== "string" ||
      typeof record.spaFallback !== "boolean" ||
      typeof record.generation !== "number" ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 1
    ) {
      return null;
    }
    const mapping = {
      projectId: record.projectId,
      versionId: record.versionId,
      entryPath: record.entryPath,
      spaFallback: record.spaFallback,
      generation: record.generation,
    };
    validateMapping(mapping);
    return mapping;
  } catch (error) {
    if (isMissingKey(error)) return null;
    throw error;
  }
}

export async function activateAwsTenantMapping(
  mapping: AwsTenantMapping,
): Promise<void> {
  validateMapping(mapping);
  await updateMapping(
    mapping.projectId,
    JSON.stringify({
      projectId: mapping.projectId,
      versionId: mapping.versionId,
      entryPath: mapping.entryPath,
      spaFallback: mapping.spaFallback,
      generation: mapping.generation,
    }),
  );
}

export async function restoreAwsTenantMapping(
  mapping: AwsTenantMapping,
): Promise<void> {
  validateMapping(mapping);
  await updateMapping(
    mapping.projectId,
    JSON.stringify({
      projectId: mapping.projectId,
      versionId: mapping.versionId,
      entryPath: mapping.entryPath,
      spaFallback: mapping.spaFallback,
      generation: mapping.generation,
    }),
    { allowWhenDisabled: true, allowSameGenerationOverride: true },
  );
}

export async function removeAwsTenantMapping(
  projectId: string,
  generation: number,
): Promise<void> {
  if (
    !mavlyHostname(projectId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new Error("Invalid AWS tenant route removal.");
  }
  await updateMapping(
    projectId,
    JSON.stringify({ projectId, generation, disabled: true }),
    { allowWhenDisabled: true },
  );
}

export async function verifyAwsTenantRoute(input: {
  projectId: string;
  versionId: string;
  hostname: string;
}): Promise<boolean> {
  const expectedHost = mavlyHostname(input.projectId);
  if (!expectedHost || input.hostname !== expectedHost) return false;
  const mapping = await readAwsTenantMapping(input.projectId);
  if (!mapping || mapping.versionId !== input.versionId) return false;
  return verifyAwsPublicTenantRoute(input);
}

export async function verifyAwsPublicTenantRoute(input: {
  projectId: string;
  versionId: string;
  hostname: string;
}): Promise<boolean> {
  const expectedHost = mavlyHostname(input.projectId);
  if (!expectedHost || input.hostname !== expectedHost) return false;
  try {
    const response = await fetch(`https://${expectedHost}/`, {
      method: "HEAD",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    return (
      response.status === 200 &&
      response.headers.get("content-type")?.toLowerCase().startsWith("text/html") === true &&
      response.headers.get("x-amz-meta-mavly-project-id") === input.projectId &&
      response.headers.get("x-amz-meta-mavly-version-id") === input.versionId
    );
  } catch {
    return false;
  }
}

export async function verifyAwsPublicTenantRouteRemoved(
  projectId: string,
): Promise<boolean> {
  const hostname = mavlyHostname(projectId);
  if (!hostname) return false;
  try {
    const response = await fetch(`https://${hostname}/`, {
      method: "HEAD",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    return response.status === 404;
  } catch {
    return false;
  }
}

export function resetAwsTenantMappingClient(): void {
  client?.destroy();
  client = null;
}
