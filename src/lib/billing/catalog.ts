import type { BillingCatalogProduct, BillingCurrency, BillingInterval, BillingMarket, BillingProductType } from "./types";

export const BILLING_CATALOG_VERSION = "2026-11-03-inr-initial";

/**
 * Current repository commercial values. Global checkout uses the same locked
 * INR catalog through Dodo; no alternate financial currency is permitted.
 */
export const INDIA_PLANS = [
  { id: "free", amountMinor: 0, credits: 10, projectLimit: 1 },
  { id: "starter", amountMinor: 39_900, credits: 100, projectLimit: 5 },
  { id: "creator", amountMinor: 59_900, credits: 200, projectLimit: 15 },
  { id: "pro", amountMinor: 199_900, credits: 600, projectLimit: 50 },
] as const;

export const INDIA_CREDIT_PACKS = [
  ["starter-pack", 19_900, 90],
  ["growth-pack", 29_900, 300],
  ["power-pack", 79_900, 1000],
] as const;

export function productTypeFor(productId: string): BillingProductType | null {
  if (["starter-pack", "growth-pack", "power-pack"].includes(productId)) return "credit_pack";
  if (["starter", "creator", "pro"].includes(productId)) return "subscription";
  return null;
}

export function intervalFor(productId: string): BillingInterval {
  return ["starter-pack", "growth-pack", "power-pack"].includes(productId) ? "one_time" : "monthly";
}

export function catalogSeedRows(): Array<{
  productId: string;
  productType: BillingProductType;
  planId: string | null;
  market: BillingMarket;
  currency: BillingCurrency;
  interval: BillingInterval;
  amountMinor: number | null;
  credits: number | null;
  projectLimit: number | null;
  active: boolean;
  approved: boolean;
}> {
  const rows = INDIA_PLANS.filter((plan) => plan.id !== "free").map((plan) => ({
    productId: plan.id,
    productType: "subscription" as const,
    planId: plan.id,
    market: "india" as const,
    currency: "INR" as const,
    interval: "monthly" as const,
    amountMinor: plan.amountMinor,
    credits: plan.credits,
    projectLimit: plan.projectLimit,
    active: true,
    approved: true,
  }));
  const packs = INDIA_CREDIT_PACKS.map(([productId, amountMinor, credits]) => ({
    productId,
    productType: "credit_pack" as const,
    planId: null,
    market: "india" as const,
    currency: "INR" as const,
    interval: "one_time" as const,
    amountMinor,
    credits,
    projectLimit: null,
    active: true,
    approved: true,
  }));
  const globalRows = [...rows, ...packs].map((row) => ({
    ...row,
    market: "global" as const,
    currency: "INR" as const,
  }));
  return [...rows, ...packs, ...globalRows];
}

export function isValidActivePrice(row: Pick<BillingCatalogProduct, "amountMinor" | "active" | "approved">): boolean {
  return row.active && row.approved && row.amountMinor !== null && Number.isSafeInteger(row.amountMinor) && row.amountMinor > 0;
}
