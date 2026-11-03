import { createHmac, timingSafeEqual } from "node:crypto";

const ISO_COUNTRY = /^[A-Z]{2}$/;
const COUNTRY_TIMESTAMP_MAX_SKEW_SECONDS = 300;

export function normalizeIsoCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return ISO_COUNTRY.test(normalized) ? normalized : null;
}

export interface TrustedCountryResult {
  countryCode: string | null;
  reliable: boolean;
  source: "signed_ingress" | "vercel_edge" | null;
  reason: "resolved" | "not_configured" | "invalid" | "signature_invalid" | "stale";
}

function safeEqualHex(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

/**
 * Read country only from an explicitly configured ingress contract. A request
 * header by itself is never trusted. The signed contract is:
 *   x-mavly-country, x-mavly-country-timestamp,
 *   x-mavly-country-signature = HMAC_SHA256(country + "." + timestamp, secret)
 */
export function trustedCountryFromHeaders(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): TrustedCountryResult {
  const mode = (env.MAVLY_TRUSTED_COUNTRY_MODE ?? "").trim().toLowerCase();
  if (mode === "signed") {
    const countryCode = normalizeIsoCountry(headers.get("x-mavly-country"));
    const timestampText = headers.get("x-mavly-country-timestamp")?.trim() ?? "";
    const signature = headers.get("x-mavly-country-signature")?.trim() ?? "";
    const timestamp = Number(timestampText);
    const secret = (env.MAVLY_TRUSTED_COUNTRY_SECRET ?? "").trim();
    if (!countryCode || !/^\d{1,12}$/.test(timestampText) || !Number.isSafeInteger(timestamp)) {
      return { countryCode: null, reliable: false, source: null, reason: "invalid" };
    }
    if (Math.abs(nowSeconds - timestamp) > COUNTRY_TIMESTAMP_MAX_SKEW_SECONDS) {
      return { countryCode: null, reliable: false, source: null, reason: "stale" };
    }
    if (secret.length < 32) {
      return { countryCode: null, reliable: false, source: null, reason: "not_configured" };
    }
    const expected = createHmac("sha256", secret)
      .update(`${countryCode}.${timestampText}`)
      .digest("hex");
    if (!safeEqualHex(signature, expected)) {
      return { countryCode: null, reliable: false, source: null, reason: "signature_invalid" };
    }
    return { countryCode, reliable: true, source: "signed_ingress", reason: "resolved" };
  }

  /**
   * Vercel's edge header is accepted only when the operator explicitly states
   * that the origin is locked behind the Vercel edge. Without that deployment
   * fact, a direct origin request could spoof the header and the market remains
   * unresolved.
   */
  if (
    mode === "vercel" &&
    env.VERCEL === "1" &&
    /^(1|true|yes|on)$/i.test((env.MAVLY_COUNTRY_ORIGIN_LOCKED ?? "").trim())
  ) {
    const countryCode = normalizeIsoCountry(headers.get("x-vercel-ip-country"));
    return countryCode
      ? { countryCode, reliable: true, source: "vercel_edge", reason: "resolved" }
      : { countryCode: null, reliable: false, source: null, reason: "invalid" };
  }

  return { countryCode: null, reliable: false, source: null, reason: "not_configured" };
}
