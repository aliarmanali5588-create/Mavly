import type { BillingCatalogProduct } from "./types";

export async function fetchPublicBillingCatalog(): Promise<BillingCatalogProduct[]> {
  const response = await fetch("/api/billing/catalog", { cache: "no-store" });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: Array<Record<string, unknown>>;
  } | null;
  if (!response.ok || body?.ok !== true || !Array.isArray(body.data)) {
    throw new Error("Billing catalog unavailable");
  }

  return body.data.flatMap((row): BillingCatalogProduct[] => {
    const amountMinor = row.amountMinor === null ? null : Number(row.amountMinor);
    const credits = row.credits === null ? null : Number(row.credits);
    const projectLimit = row.projectLimit === null ? null : Number(row.projectLimit);
    if (
      typeof row.productId !== "string" ||
      (row.productType !== "subscription" && row.productType !== "credit_pack") ||
      (row.market !== "india" && row.market !== "global") ||
      row.currency !== "INR" ||
      (row.interval !== "monthly" && row.interval !== "yearly" && row.interval !== "one_time") ||
      typeof row.catalogVersion !== "string" ||
      (amountMinor !== null && !Number.isSafeInteger(amountMinor)) ||
      (credits !== null && !Number.isSafeInteger(credits)) ||
      (projectLimit !== null && !Number.isSafeInteger(projectLimit))
    ) {
      return [];
    }
    return [{
      productId: row.productId,
      productType: row.productType,
      planId: typeof row.planId === "string" ? row.planId : null,
      market: row.market,
      currency: row.currency,
      interval: row.interval,
      amountMinor,
      credits,
      projectLimit,
      active: true,
      approved: true,
      catalogVersion: row.catalogVersion,
      razorpayProductId: null,
      dodoProductId: null,
    } as BillingCatalogProduct];
  });
}
