/**
 * ═══ AWS HOSTING ELIGIBILITY — DATABASE-DRIVEN, NOT AN ALLOWLIST ════════════
 *
 * Every eligible Mavly customer may publish a generated website without an
 * operator adding their project id to an environment variable. The authority is
 * Supabase data, evaluated server-side by migration 61:
 *
 *   · the project exists and is owned by the authenticated caller;
 *   · the account is not suspended;
 *   · the project is a website with completed generated source;
 *   · the canonical billing plan grants a project ceiling (`price_catalog`);
 *   · the number of already-published sites is below that ceiling;
 *   · platform-wide publication capacity is available and enabled.
 *
 * ⚠️ THE BROWSER NEVER SUPPLIES ANY OF THESE FACTS. This module is pure: it has
 * no Supabase client and no environment access, so it can be exercised directly.
 * The owner-scoped SECURITY DEFINER RPC is called from `eligibility-store.ts`.
 *
 * ⚠️ PUBLISHING DOES NOT CONSUME GENERATION CREDITS. The eligibility result
 * reports the caller's available credits for transparency and `creditsRequired`
 * is always 0; nothing here reserves or charges credits.
 *
 * The reasons are structured and safe to return to the owner. No bucket, region,
 * ARN, key or internal address is ever part of this module's output.
 */

export const AWS_HOSTING_ELIGIBILITY_REASONS = [
  "eligible",
  "project_not_found",
  "ownership_mismatch",
  "project_not_publishable",
  "generation_incomplete",
  "plan_not_allowed",
  "project_limit_reached",
  "user_suspended",
  "hosting_capacity_exceeded",
  "platform_hosting_disabled",
] as const;

export type AwsHostingEligibilityReason =
  (typeof AWS_HOSTING_ELIGIBILITY_REASONS)[number];

export function isAwsHostingEligibilityReason(
  value: unknown,
): value is AwsHostingEligibilityReason {
  return (
    typeof value === "string" &&
    (AWS_HOSTING_ELIGIBILITY_REASONS as readonly string[]).includes(value)
  );
}

export interface AwsHostingCapacity {
  activeCount: number;
  queuedCount: number;
  maxActive: number;
  maxQueued: number;
}

export interface AwsHostingEligibilityFacts {
  /** Platform feature flag AND a fully valid AWS resource configuration. */
  platformEnabled: boolean;
  project: {
    exists: boolean;
    ownedByCaller: boolean;
    projectType: string | null;
  };
  userSuspended: boolean;
  generation: {
    hasFiles: boolean;
    latestStage: string | null;
    hasCompletedRun: boolean;
    activeRun: boolean;
  };
  plan: {
    projectLimit: number | null;
    publishedSiteLimit: number | null;
    publishedSiteCount: number;
  };
  capacity: AwsHostingCapacity;
}

export interface AwsHostingEligibilityDecision {
  eligible: boolean;
  reason: AwsHostingEligibilityReason;
}

/**
 * Apply the eligibility rules in priority order.
 *
 * Ownership and suspension outrank plan and capacity: a caller must never learn
 * capacity details for a project they do not own. Platform disablement outranks
 * everything operational so an operator kill switch is reported truthfully.
 */
export function evaluateAwsHostingEligibility(
  facts: AwsHostingEligibilityFacts,
): AwsHostingEligibilityDecision {
  if (!facts.platformEnabled) {
    return { eligible: false, reason: "platform_hosting_disabled" };
  }
  if (!facts.project.exists) {
    return { eligible: false, reason: "project_not_found" };
  }
  if (!facts.project.ownedByCaller) {
    return { eligible: false, reason: "ownership_mismatch" };
  }
  if (facts.userSuspended) {
    return { eligible: false, reason: "user_suspended" };
  }
  if ((facts.project.projectType ?? "website") !== "website") {
    return { eligible: false, reason: "project_not_publishable" };
  }

  const generation = facts.generation;
  if (
    !generation.hasFiles ||
    generation.activeRun ||
    (generation.latestStage !== null &&
      generation.latestStage !== "completed" &&
      !generation.hasCompletedRun)
  ) {
    return { eligible: false, reason: "generation_incomplete" };
  }

  const projectLimit = facts.plan.projectLimit;
  if (projectLimit === null || projectLimit < 1) {
    return { eligible: false, reason: "plan_not_allowed" };
  }

  const siteLimit = facts.plan.publishedSiteLimit ?? projectLimit;
  if (facts.plan.publishedSiteCount >= siteLimit) {
    return { eligible: false, reason: "project_limit_reached" };
  }

  const capacity = facts.capacity;
  if (capacity.maxQueued < 1 || capacity.queuedCount >= capacity.maxQueued) {
    return { eligible: false, reason: "hosting_capacity_exceeded" };
  }

  return { eligible: true, reason: "eligible" };
}

export interface AwsHostingEligibility extends AwsHostingEligibilityDecision {
  planId: string;
  projectLimit: number | null;
  publishedSiteLimit: number | null;
  publishedSiteCount: number;
  /** Publishing never charges credits; this is informational only. */
  creditsRequired: number;
  availableCredits: number;
  capacity: AwsHostingCapacity;
}

/** A short, secret-free owner-facing explanation for one reason code. */
export function awsHostingEligibilityMessage(
  reason: AwsHostingEligibilityReason,
): string {
  switch (reason) {
    case "eligible":
      return "This project can be published on Mavly hosting.";
    case "project_not_found":
      return "Project not found.";
    case "ownership_mismatch":
      return "You do not have access to this project.";
    case "project_not_publishable":
      return "Only website projects can be published on Mavly hosting.";
    case "generation_incomplete":
      return "Finish generating this website before publishing it.";
    case "plan_not_allowed":
      return "Your current plan does not include website hosting.";
    case "project_limit_reached":
      return "You have reached the published-website limit included in your plan. Unpublish a site or upgrade to publish another.";
    case "user_suspended":
      return "This account is suspended. Contact customer support for a review.";
    case "hosting_capacity_exceeded":
      return "Mavly is at its publishing capacity right now. Try again shortly.";
    case "platform_hosting_disabled":
      return "Website publishing is temporarily unavailable.";
  }
}
