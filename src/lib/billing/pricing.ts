import type { BillingCatalogProduct, BillingMarket, ResolvedBillingPrice } from "./types";
import { currencyForMarket, providerForMarket } from "./gateway";
import { isValidActivePrice } from "./catalog";

export function resolvePrice(
  rows: readonly BillingCatalogProduct[],
  input: { productId: string; market: BillingMarket; interval: BillingCatalogProduct["interval"] },
): { ok: true; price: ResolvedBillingPrice } | { ok: false; code: string; message: string } {
  const row = rows.find(
    (candidate) =>
      candidate.productId === input.productId &&
      candidate.market === input.market &&
      candidate.interval === input.interval,
  );
  if (!row) return { ok: false, code: "PRICE_NOT_FOUND", message: "That product is not available in this market." };
  if (!isValidActivePrice(row)) {
    return { ok: false, code: "PRICE_NOT_CONFIGURED", message: "This product is not configured for checkout." };
  }
  const currency = currencyForMarket(input.market);
  if (row.currency !== currency) return { ok: false, code: "CURRENCY_MISMATCH", message: "The price currency does not match the market." };
  return { ok: true, price: { ...row, provider: providerForMarket(input.market) } };
}

export function formatMinorAmount(amountMinor: number, currency: "INR"): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}
