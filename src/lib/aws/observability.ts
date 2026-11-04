/**
 * Secret-free AWS publication events.
 *
 * Publication logs may be emitted by the long-lived EC2 worker. Keep the
 * allowlist here so a provider error, lease token, file body, or credential
 * cannot accidentally become part of an operator-visible log line.
 */

export type AwsPublicationEvent =
  | "publication_claimed"
  | "publication_started"
  | "s3_upload_completed"
  | "s3_verification_completed"
  | "kvs_activation_completed"
  | "publication_completed"
  | "unpublish_started"
  | "unpublish_completed"
  | "publication_retry"
  | "publication_failed"
  | "lease_lost"
  | "route_recovery_failed"
  | "outcome_persistence_failed"
  | "eligibility_accepted"
  | "eligibility_rejected"
  | "capacity_throttled";

type AwsPublicationFieldValue = string | number | boolean | null;

export interface AwsPublicationEventFields {
  projectId?: string;
  versionId?: string;
  status?: string;
  reason?: string;
  code?: string;
  attempt?: number;
  generation?: number;
  uploadedCount?: number;
  failedCount?: number;
  totalBytes?: number;
  durationMs?: number;
  plan?: string;
  activeCount?: number;
  queuedCount?: number;
  maxActive?: number;
  maxQueued?: number;
}

const ALLOWED_FIELDS = new Set<keyof AwsPublicationEventFields>([
  "projectId",
  "versionId",
  "status",
  "reason",
  "code",
  "attempt",
  "generation",
  "uploadedCount",
  "failedCount",
  "totalBytes",
  "durationMs",
  "plan",
  "activeCount",
  "queuedCount",
  "maxActive",
  "maxQueued",
]);

function sanitizedFields(
  fields: AwsPublicationEventFields,
): Record<string, AwsPublicationFieldValue> {
  const output: Record<string, AwsPublicationFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key as keyof AwsPublicationEventFields)) continue;
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean" &&
      value !== null
    ) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

export function emitAwsPublicationEvent(
  event: AwsPublicationEvent,
  fields: AwsPublicationEventFields = {},
): void {
  console.info(
    "[aws-publication]",
    JSON.stringify({ event, ...sanitizedFields(fields) }),
  );
}
