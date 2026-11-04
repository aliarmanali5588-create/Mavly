/**
 * Secret-free domain events.
 *
 * The raw verification token, DNS answers, provider credentials and certificate
 * material are never fields here. A verification failure is logged with a
 * bounded classification only.
 */

export type DomainEvent =
  | "domain_reserved"
  | "domain_registered"
  | "domain_verification_requested"
  | "domain_verified"
  | "domain_verification_failed"
  | "domain_provisioning_requested"
  | "domain_active"
  | "domain_provisioning_failed"
  | "domain_removal_requested"
  | "domain_removed"
  | "domain_rate_limited"
  | "domain_security_rejection"
  | "domain_routing_synced"
  | "domain_job_retry"
  | "domain_job_failed";

export interface DomainEventFields {
  projectId?: string;
  domainId?: string;
  hostname?: string;
  domainType?: string;
  status?: string;
  action?: string;
  reason?: string;
  code?: string;
  attempt?: number;
  durationMs?: number;
  provider?: string;
  plan?: string;
}

const ALLOWED = new Set<keyof DomainEventFields>([
  "projectId",
  "domainId",
  "hostname",
  "domainType",
  "status",
  "action",
  "reason",
  "code",
  "attempt",
  "durationMs",
  "provider",
  "plan",
]);

type FieldValue = string | number | boolean | null;

function sanitize(fields: DomainEventFields): Record<string, FieldValue> {
  const output: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key as keyof DomainEventFields)) continue;
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

export function emitDomainEvent(
  event: DomainEvent,
  fields: DomainEventFields = {},
): void {
  console.info("[domains]", JSON.stringify({ event, ...sanitize(fields) }));
}
