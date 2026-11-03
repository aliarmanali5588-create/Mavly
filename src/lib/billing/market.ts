import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeIsoCountry, trustedCountryFromHeaders } from "./country";
import type { BillingMarketResolution } from "./types";

const UNSUPPORTED_COUNTRIES = new Set(["AA", "ZZ", "XX", "UN"]);

export function marketForCountry(countryCode: string | null): "india" | "global" | null {
  if (!countryCode) return null;
  if (UNSUPPORTED_COUNTRIES.has(countryCode)) return null;
  return countryCode === "IN" ? "india" : "global";
}

export function resolveMarket(input: {
  verifiedCountry?: unknown;
  trustedRequestCountry?: unknown;
}): BillingMarketResolution {
  const verified = normalizeIsoCountry(input.verifiedCountry);
  const request = normalizeIsoCountry(input.trustedRequestCountry);

  if (verified) {
    const market = marketForCountry(verified);
    if (!market) {
      return {
        market: null,
        countryCode: verified,
        source: null,
        conflict: false,
        reason: "unsupported_country",
      };
    }
    return {
      market,
      countryCode: verified,
      source: "verified_profile",
      conflict: !!request && request !== verified,
      reason: "resolved",
    };
  }

  if (request) {
    const market = marketForCountry(request);
    if (!market) {
      return {
        market: null,
        countryCode: request,
        source: null,
        conflict: false,
        reason: "unsupported_country",
      };
    }
    return {
      market,
      countryCode: request,
      source: "trusted_request",
      conflict: false,
      reason: "resolved",
    };
  }

  return {
    market: null,
    countryCode: null,
    source: null,
    conflict: false,
    reason: input.verifiedCountry || input.trustedRequestCountry ? "invalid_country" : "unresolved_country",
  };
}

export async function resolveMarketForRequest(
  client: SupabaseClient,
  headers: Headers,
): Promise<BillingMarketResolution> {
  const profile = await client
    .from("billing_profiles")
    .select("country_code,verification_status")
    .maybeSingle();
  const verifiedCountry =
    profile.error || profile.data?.verification_status !== "verified"
      ? null
      : profile.data.country_code;
  const trusted = trustedCountryFromHeaders(headers);
  return resolveMarket({
    verifiedCountry,
    trustedRequestCountry: trusted.reliable ? trusted.countryCode : null,
  });
}
