/**
 * The only domain status vocabulary and transition table.
 *
 * Pure and client-safe. The database enforces the columns and the worker writes
 * terminal state; this module keeps the UI honest and gives the tests one place
 * to pin every allowed transition.
 */

import type { DomainStatus } from "./types";

export type DomainTone = "success" | "info" | "warning" | "danger" | "neutral";

export const DOMAIN_STATUS_TONES: Record<DomainStatus, DomainTone> = {
  pending: "neutral",
  verification_required: "warning",
  verifying: "info",
  verified: "info",
  provisioning: "info",
  active: "success",
  misconfigured: "danger",
  ssl_pending: "warning",
  ssl_failed: "danger",
  disabled: "neutral",
  removing: "warning",
  removed: "neutral",
};

export const DOMAIN_STATUS_LABELS: Record<DomainStatus, string> = {
  pending: "Pending",
  verification_required: "Verification required",
  verifying: "Verifying",
  verified: "Verified",
  provisioning: "Provisioning",
  active: "Active",
  misconfigured: "DNS misconfigured",
  ssl_pending: "SSL pending",
  ssl_failed: "SSL failed",
  disabled: "Disabled",
  removing: "Removing",
  removed: "Removed",
};

export const DOMAIN_STATUS_HELP: Record<DomainStatus, string> = {
  pending: "This address has not been provisioned yet. It becomes active after routing and HTTPS are confirmed.",
  verification_required:
    "Add the TXT verification record at your DNS provider, then run verification. Ownership is never assumed.",
  verifying: "We are reading your DNS records. Propagation can take a few minutes to a few hours.",
  verified:
    "Ownership is proven. Routing and the HTTPS certificate are being provisioned next; the address is not serving yet.",
  provisioning:
    "Routing and the HTTPS certificate are being provisioned. Wait for the status to become Active.",
  active: "This address is verified, has HTTPS, and resolves to the published project.",
  misconfigured:
    "The DNS records no longer point at Mavly, or ownership could not be confirmed. Fix the records and retry.",
  ssl_pending: "The DNS records are visible; the HTTPS certificate is still being issued.",
  ssl_failed:
    "The certificate could not be issued. Check that the routing record is correct, then retry provisioning.",
  disabled: "Serving is disabled for this address. Re-enable it deliberately before it can resolve again.",
  removing: "Routing is being removed. The address will stop resolving before the row is removed.",
  removed: "This address is no longer attached. Its history is retained.",
};

/** Only `active` means the hostname may serve the project. */
export function isDomainActive(status: DomainStatus): boolean {
  return status === "active";
}

/** True while the owner should keep polling; false when waiting cannot help. */
export function isDomainSettling(status: DomainStatus): boolean {
  return ["pending", "verifying", "verified", "provisioning", "ssl_pending", "removing"].includes(
    status,
  );
}

export function domainStatusLabel(status: DomainStatus): string {
  return DOMAIN_STATUS_LABELS[status] ?? "Unknown";
}

export function domainStatusTone(status: DomainStatus): DomainTone {
  return DOMAIN_STATUS_TONES[status] ?? "neutral";
}

export function domainStatusHelp(status: DomainStatus): string {
  return DOMAIN_STATUS_HELP[status] ?? "The server did not recognise this domain state.";
}

/**
 * The worker may only move a row through these edges. A transition not listed
 * here is a bug, and the test file asserts the public ones.
 */
export const DOMAIN_TRANSITIONS: Record<DomainStatus, readonly DomainStatus[]> = {
  pending: ["verification_required", "provisioning", "verifying", "disabled", "removing"],
  verification_required: ["verifying", "misconfigured", "removing", "disabled"],
  verifying: ["verified", "misconfigured", "verification_required", "removing"],
  verified: ["provisioning", "ssl_pending", "ssl_failed", "removing"],
  provisioning: ["active", "ssl_pending", "ssl_failed", "misconfigured", "removing"],
  active: ["provisioning", "misconfigured", "ssl_failed", "disabled", "removing"],
  misconfigured: ["verifying", "provisioning", "verification_required", "removing", "disabled"],
  ssl_pending: ["active", "ssl_failed", "provisioning", "misconfigured", "removing"],
  ssl_failed: ["provisioning", "ssl_pending", "misconfigured", "removing", "disabled"],
  disabled: ["provisioning", "verification_required", "removing"],
  removing: ["removed", "active", "misconfigured"],
  removed: [],
};

export function canTransitionDomain(from: DomainStatus, to: DomainStatus): boolean {
  if (from === to) return true;
  return DOMAIN_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * A deterministic 0-100 progress number for the row's progress bar. It is
 * derived only from the server's status; it never claims work that has not
 * happened.
 */
export function domainProgressPercent(status: DomainStatus): number {
  switch (status) {
    case "pending":
      return 10;
    case "verification_required":
      return 20;
    case "verifying":
      return 40;
    case "verified":
      return 60;
    case "provisioning":
    case "ssl_pending":
      return 70;
    case "active":
    case "disabled":
      return 100;
    case "misconfigured":
    case "ssl_failed":
      return 100;
    case "removing":
      return 50;
    case "removed":
      return 100;
  }
}
