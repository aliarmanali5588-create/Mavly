import type { BillingCurrency, BillingMarket, BillingProvider } from "./types";

export function providerForMarket(market: BillingMarket): BillingProvider {
  return market === "india" ? "razorpay" : "dodo";
}

export function currencyForMarket(_market: BillingMarket): BillingCurrency {
  return "INR";
}

export function validateGatewayRoute(input: {
  market: BillingMarket | null;
  currency: string;
  provider: string;
}): { ok: true; provider: BillingProvider; currency: BillingCurrency } | { ok: false; reason: string } {
  if (!input.market) return { ok: false, reason: "unknown_market" };
  const provider = providerForMarket(input.market);
  const currency = currencyForMarket(input.market);
  if (input.provider !== provider) return { ok: false, reason: "provider_market_mismatch" };
  if (input.currency !== currency) return { ok: false, reason: "currency_market_mismatch" };
  return { ok: true, provider, currency };
}
