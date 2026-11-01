"use client";

import React, { useState } from "react";
import { IndianRupee, Info, TrendingUp } from "lucide-react";

import type { AdminOverviewPayload } from "@/lib/admin/types";
import { MOCK_REVENUE_MONTHLY } from "./mockData";

/**
 * The demo chart remains available for legacy callers. Live admin surfaces use
 * the unavailable state because no Mavly platform subscription, invoice or
 * payment source exists; the operational credit ledger is not revenue data.
 */
export function RevenueChart({
  live = false,
  data,
  error = false,
  unavailable = false,
}: {
  live?: boolean;
  data?: AdminOverviewPayload | null;
  error?: boolean;
  unavailable?: boolean;
}) {
  if (!live) return <DemoRevenueChart />;
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

function DemoRevenueChart() {
  const [activeMonthIndex, setActiveMonthIndex] = useState<number | null>(5); // default to Oct

  const maxRevenue = 300000;
  const activeMonth =
    activeMonthIndex !== null ? MOCK_REVENUE_MONTHLY[activeMonthIndex] : null;

  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] flex flex-col justify-between space-y-6">
      {/* ── Top Metric Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-success-subtle text-success-subtle-foreground border border-success/25">
              <IndianRupee className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-foreground">Revenue Velocity</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            6-Month gross platform subscription revenue (INR ₹)
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="px-3 py-1.5 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-right shadow-[var(--clay-well-1)]">
            <span className="text-[10px] text-muted-foreground uppercase font-bold block">
              Cumulative
            </span>
            <span className="text-sm font-extrabold text-foreground font-mono">
              ₹14,22,500
            </span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-success-subtle border border-success/25 text-right">
            <span className="text-[10px] text-success uppercase font-bold block">
              Growth
            </span>
            <span className="text-sm font-extrabold text-success-subtle-foreground flex items-center gap-1 font-mono">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>+53.7%</span>
            </span>
          </div>
        </div>
      </div>

      {/* ── Interactive Chart Area ── */}
      <div className="relative pt-6">
        <div className="relative h-52 w-full flex items-end justify-between gap-2 sm:gap-4 px-2">
          {/* Subtle horizontal grid lines */}
          <div className="absolute inset-x-0 top-0 border-b border-dashed border-[var(--clay-line)] flex items-center justify-between text-[10px] font-mono text-muted-foreground pointer-events-none">
            <span>₹3.0L</span>
          </div>
          <div className="absolute inset-x-0 top-1/2 border-b border-dashed border-[var(--clay-line)] flex items-center justify-between text-[10px] font-mono text-muted-foreground pointer-events-none">
            <span>₹1.5L</span>
          </div>

          {MOCK_REVENUE_MONTHLY.map((item, idx) => {
            const heightPercent = Math.round((item.revenue / maxRevenue) * 100);
            const isHovered = activeMonthIndex === idx;

            return (
              <div
                key={item.month}
                onMouseEnter={() => setActiveMonthIndex(idx)}
                className="relative flex-1 h-full flex flex-col items-center justify-end group cursor-pointer z-10"
              >
                {/* Floating Precision Tooltip */}
                {isHovered ? (
                  <div className="absolute -top-11 px-3 py-1.5 rounded-xl bg-black text-white text-[11px] font-bold shadow-[var(--clay-float)] whitespace-nowrap animate-in fade-in zoom-in-95 font-mono z-20">
                    {item.label} · {item.month} 2026
                  </div>
                ) : null}

                {/* Bar Element */}
                <div
                  className={`w-full max-w-[42px] rounded-t-lg transition-all duration-200 ${
                    isHovered
                      ? "bg-black shadow-[var(--clay-elev-ink-2)]"
                      : "bg-foreground hover:bg-black"
                  }`}
                  style={{ height: `${heightPercent}%` }}
                />

                <span
                  className={`mt-2.5 text-xs font-semibold transition-colors ${
                    isHovered ? "text-foreground font-bold" : "text-muted-foreground"
                  }`}
                >
                  {item.month}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Active Month Highlight Footer ── */}
      {activeMonth ? (
        <div className="p-3 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] flex items-center justify-between text-xs shadow-[var(--clay-well-1)]">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Info className="w-3.5 h-3.5 text-muted-foreground" />
            <span>
              Selected Period: <strong className="text-foreground">{activeMonth.month} 2026</strong>
            </span>
          </div>
          <span className="font-extrabold text-foreground font-mono text-sm">
            {activeMonth.label}
          </span>
        </div>
      ) : null}
    </div>
  );
}
