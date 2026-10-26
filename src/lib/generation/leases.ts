/**
 * ═══ WORKER LEASES AND BOUNDED RETRY TIMING ══════════════════════════════════
 *
 * A lease is a time-bounded, exclusive claim on one durable job. The database
 * stores a random `lease_token`; every worker write presents that token, so a
 * worker whose lease expired cannot finish a run another worker now owns.
 *
 * ⚠️ WHY IT IS LONGER THAN THE ROUTE. The generation budget is 240 s and one
 * provider call may take 120 s. A 420 s lease covers a full attempt plus
 * scheduling and persistence, so a healthy worker is never recovered out from
 * under itself. The worker still renews it periodically; the length is a
 * backstop, not a substitute for heartbeats.
 *
 * ⚠️ THESE NUMBERS ARE MIRRORED IN MIGRATION 16. The SQL clamps to the same
 * 60–900 s range and uses the same 15 s-doubling-25 s-cap schedule. Changing
 * one side without the other would make the row's state disagree with the
 * worker's expectations.
 */

import { timingSafeEqual } from "node:crypto";

export const WORKER_LEASE_SECONDS = 420;
export const MIN_LEASE_SECONDS = 60;
export const MAX_LEASE_SECONDS = 900;
export const LEASE_RENEW_INTERVAL_MS = 120_000;

export const RETRY_BASE_SECONDS = 15;
export const RETRY_MAX_SECONDS = 300;

export function clampLeaseSeconds(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return WORKER_LEASE_SECONDS;
  return Math.trunc(Math.max(MIN_LEASE_SECONDS, Math.min(MAX_LEASE_SECONDS, value)));
}

export function leaseExpiresAt(nowMs: number, leaseSeconds: number): number {
  return nowMs + clampLeaseSeconds(leaseSeconds) * 1_000;
}

export function isLeaseExpired(expiresAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!expiresAt) return true;
  const parsed = Date.parse(expiresAt);
  return !Number.isFinite(parsed) || parsed <= nowMs;
}

/**
 * Exponential backoff with up to 25 % jitter:
 *
 *   attempt 1 → 15 s, attempt 2 → 30 s, attempt 3 → 60 s … capped at 300 s.
 *
 * `attempt` is the number of the job attempt that just failed (1-based). The
 * jitter spreads retries so a provider outage does not release every job at
 * the same instant.
 */
export function retryDelaySeconds(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(5, Math.trunc(attempt) - 1));
  const base = Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** exponent);
  const jitter = Math.floor(base * 0.25 * Math.min(1, Math.max(0, random())));
  return Math.min(RETRY_MAX_SECONDS, base + jitter);
}

/**
 * A constant-time comparison for the worker bearer secret. The length check is
 * unavoidable (timingSafeEqual throws on different lengths), but a length
 * mismatch alone reveals nothing usable for a high-entropy secret.
 */
export function timingSafeStringEqual(provided: unknown, expected: unknown): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** A log-safe worker identity: bounded, printable, no whitespace or secrets. */
export function sanitizeWorkerId(raw: unknown, fallback = "generation-worker"): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120)
    .replace(/^-+|-+$/g, "");
  return cleaned.length >= 3 ? cleaned : fallback;
}
