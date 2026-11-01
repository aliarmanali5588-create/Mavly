"use client";

import { IndianRupee, Info, TrendingUp } from "lucide-react";

import type { AdminOverviewPayload } from "@/lib/admin/types";

/**
 * No verified Mavly platform billing source exists, so this chart never
 * substitutes demonstration values for revenue.
 */
export function RevenueChart({
  data,
  error = false,
  unavailable = false,
}: {
  live?: boolean;
  data?: AdminOverviewPayload | null;
  error?: boolean;
  unavailable?: boolean;
}) {
  if (error || unavailable) return <UnavailableRevenueChart />;
  if (!data) return <RevenueSkeleton />;
  return <UnavailableRevenueChart />;
}

function UnavailableRevenueChart() {
  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] flex flex-col justify-between space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-[var(--clay-sunken)] text-muted-foreground border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
              <IndianRupee className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-foreground">Revenue Velocity</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Platform subscription revenue (INR ₹) — unavailable
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="px-3 py-1.5 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-right shadow-[var(--clay-well-1)]">
            <span className="text-[10px] text-muted-foreground uppercase font-bold block">Cumulative</span>
            <span className="text-sm font-extrabold text-muted-foreground font-mono">—</span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-right shadow-[var(--clay-well-1)]">
            <span className="text-[10px] text-muted-foreground uppercase font-bold block">Growth</span>
            <span className="text-sm font-extrabold text-muted-foreground flex items-center gap-1 font-mono">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>—</span>
            </span>
          </div>
        </div>
      </div>

      <div className="h-52 w-full rounded-xl border border-dashed border-[var(--clay-line)] bg-[var(--clay-sunken)] flex flex-col items-center justify-center px-6 text-center gap-2 shadow-[var(--clay-well-1)]">
        <Info className="w-5 h-5 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">No Mavly revenue source is configured</p>
        <p className="text-xs text-muted-foreground max-w-md leading-relaxed">
          No Mavly platform subscription, invoice or payment source is available. The operational
          credit ledger does not represent revenue, and customer-app payments are excluded. Monthly
          revenue and growth are not estimated, and no historical months are fabricated.
        </p>
      </div>

      <div className="p-3 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-xs text-muted-foreground flex items-center gap-2 shadow-[var(--clay-well-1)]">
        <Info className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span>Revenue appears here only after a real billing source is connected.</span>
      </div>
    </div>
  );
}

function RevenueSkeleton() {
  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-6 animate-pulse">
      <div className="flex items-center justify-between pb-4 border-b border-[var(--clay-line)]">
        <div className="h-4 w-40 rounded bg-[var(--clay-sunken)]" />
        <div className="h-8 w-24 rounded-xl bg-[var(--clay-sunken)]" />
      </div>
      <div className="h-52 rounded-xl bg-[var(--clay-sunken)]" />
    </div>
  );
}
