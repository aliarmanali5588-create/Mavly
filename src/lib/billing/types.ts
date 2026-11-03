export type BillingMarket = "india" | "global";
export type BillingCurrency = "INR";
export type BillingProvider = "razorpay" | "dodo";
export type BillingProductType = "subscription" | "credit_pack";
export type BillingInterval = "monthly" | "yearly" | "one_time";

export type BillingPaymentStatus =
  | "pending"
  | "processing"
  | "authorized"
  | "paid"
  | "failed"
  | "cancelled"
  | "refunded"
  | "partially_refunded"
  | "disputed";

export type BillingSubscriptionStatus =
  | "pending"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired"
  | "failed"
  | "refunded";

export type BillingCountrySource = "verified_profile" | "trusted_request";

export interface BillingMarketResolution {
  market: BillingMarket | null;
  countryCode: string | null;
  source: BillingCountrySource | null;
  conflict: boolean;
  reason:
    | "resolved"
    | "unsupported_country"
    | "invalid_country"
    | "unresolved_country"
    | "conflicting_country_signals";
}

export interface BillingCatalogProduct {
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
  catalogVersion: string;
  razorpayProductId: string | null;
  dodoProductId: string | null;
}

export interface ResolvedBillingPrice extends BillingCatalogProduct {
  provider: BillingProvider;
}

export interface BillingEntitlements {
  planId: string;
  projectLimit: number | null;
  monthlyCredits: number;
  purchasedCredits: number;
  availableCredits: number;
  subscriptionStatus: BillingSubscriptionStatus | null;
  currentPeriodEnd: string | null;
  features: Record<string, boolean>;
}
