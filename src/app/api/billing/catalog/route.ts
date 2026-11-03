import { NextResponse } from "next/server";

import { createSupabaseBillingClient } from "@/lib/supabase/worker";
import { platformBillingEnabled } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!platformBillingEnabled()) return NextResponse.json({ ok: false, code: "BILLING_DISABLED", error: "Platform billing is not enabled on this deployment.", data: null }, { status: 503, headers: { "cache-control": "public, no-store" } });
  const client = createSupabaseBillingClient();
  if (!client) return NextResponse.json({ ok: false, code: "BACKEND_NOT_CONFIGURED", error: "Billing catalog is not configured.", data: null }, { status: 503, headers: { "cache-control": "public, max-age=60" } });
  const { data, error } = await client
    .from("price_catalog")
    .select("product_id,product_type,plan_id,market,currency,billing_interval,amount_minor,credits,project_limit,active,approved,version_id,price_catalog_versions!inner(version,status)")
    .eq("active", true)
    .eq("approved", true)
    .eq("price_catalog_versions.status", "active");
  if (error) return NextResponse.json({ ok: false, code: "BILLING_UNAVAILABLE", error: "The billing catalog could not be loaded.", data: null }, { status: 503, headers: { "cache-control": "public, no-store" } });
  return NextResponse.json({ ok: true, data: (data ?? []).map((row) => ({
    productId: row.product_id,
    productType: row.product_type,
    planId: row.plan_id,
    market: row.market,
    currency: row.currency,
    interval: row.billing_interval,
    amountMinor: row.amount_minor,
    credits: row.credits,
    projectLimit: row.project_limit,
    catalogVersion: Array.isArray(row.price_catalog_versions) ? row.price_catalog_versions[0]?.version ?? null : (row.price_catalog_versions as { version?: string } | null)?.version ?? null,
  })) }, { headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" } });
}
