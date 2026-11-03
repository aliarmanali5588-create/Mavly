import { NextResponse } from "next/server";

import { createSupabaseServerClient, getRequestUser } from "@/lib/supabase/server";

export const BILLING_NO_STORE = { "cache-control": "private, no-store, max-age=0" } as const;

export function billingJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: BILLING_NO_STORE });
}

export function billingError(status: number, code: string, error: string): NextResponse {
  return billingJson({ ok: false, code, error, data: null }, status);
}

export async function requireBillingUser() {
  const user = await getRequestUser();
  if (!user) return { ok: false as const, response: billingError(401, "UNAUTHENTICATED", "Sign in required.") };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false as const, response: billingError(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.") };
  return { ok: true as const, user, supabase };
}

export function safeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key) ? key : null;
}

export function safeReturnUrl(): string | null {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  try {
    const url = new URL(configured);
    if (url.protocol === "https:" || (url.protocol === "http:" && process.env.NODE_ENV !== "production")) {
      url.pathname = "/billing/return";
      url.search = "";
      return url.toString();
    }
  } catch {
    // Fail closed to a relative return path. Providers receive a configured
    // absolute URL only when the operator supplied a valid canonical origin.
  }
  return null;
}

export function platformBillingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.MAVLY_PLATFORM_BILLING_ENABLED ?? "").trim());
}

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
