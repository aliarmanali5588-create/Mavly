/**
 * Server-only read of the owner-scoped AWS hosting eligibility RPC.
 *
 * Kept apart from `eligibility.ts` so the pure rules and their tests never load a
 * Next.js server module. The caller is always the authenticated owner's
 * RLS-scoped client; this module never creates a service-role client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isMissingDatabaseObject } from "@/lib/hosting/migration-requirement";
import {
  isAwsHostingEligibilityReason,
  type AwsHostingCapacity,
  type AwsHostingEligibility,
} from "./eligibility";

export type AwsHostingEligibilityResult =
  | { ok: true; data: AwsHostingEligibility }
  | { ok: false; code: string; error: string };

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function parseCapacity(value: unknown): AwsHostingCapacity {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    activeCount: nonNegativeInteger(record.activeCount),
    queuedCount: nonNegativeInteger(record.queuedCount),
    maxActive: nonNegativeInteger(record.maxActive),
    maxQueued: nonNegativeInteger(record.maxQueued),
  };
}

function parseEligibility(value: unknown): AwsHostingEligibility | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const reason = record.reason;
  if (!isAwsHostingEligibilityReason(reason)) return null;
  if (record.eligible !== (reason === "eligible")) return null;
  return {
    eligible: reason === "eligible",
    reason,
    planId: typeof record.planId === "string" ? record.planId : "free",
    projectLimit: nullableInteger(record.projectLimit),
    publishedSiteLimit: nullableInteger(record.publishedSiteLimit),
    publishedSiteCount: nonNegativeInteger(record.publishedSiteCount),
    creditsRequired:
      typeof record.creditsRequired === "number" ? record.creditsRequired : 0,
    availableCredits: nonNegativeInteger(record.availableCredits),
    capacity: parseCapacity(record.capacity),
  };
}

const MIGRATION_MESSAGE =
  "Apply migration 61_aws_hosting_eligibility.sql before enabling AWS hosting.";

function eligibilityFailure(
  code: string | undefined,
  message: string,
): AwsHostingEligibilityResult {
  if (
    isMissingDatabaseObject({ code, message }) ||
    message.toLowerCase().includes("aws_hosting_eligibility")
  ) {
    return { ok: false, code: "MIGRATION_REQUIRED", error: MIGRATION_MESSAGE };
  }
  return { ok: false, code: code ?? "DATABASE_ERROR", error: message };
}

/**
 * The authoritative eligibility read for the authenticated owner.
 *
 * Fails closed: a missing migration, an RPC error or an invalid payload never
 * becomes `eligible: true` and never a fabricated plan limit.
 */
export async function readAwsHostingEligibility(
  projectId: string,
  client?: SupabaseClient,
): Promise<AwsHostingEligibilityResult> {
  const supabase = client ?? (await createSupabaseServerClient());
  if (!supabase) {
    return {
      ok: false,
      code: "UNAVAILABLE",
      error: "Supabase is not configured.",
    };
  }
  const { data, error } = await supabase.rpc("aws_hosting_eligibility", {
    p_project_id: projectId,
  });
  if (error) return eligibilityFailure(error.code, error.message);
  const parsed = parseEligibility(data);
  if (!parsed) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: "The AWS hosting eligibility response was invalid.",
    };
  }
  return { ok: true, data: parsed };
}
