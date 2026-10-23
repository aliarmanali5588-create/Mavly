"use client";

import React, { useState } from "react";
import { TrendingUp, IndianRupee, Info, ArrowUpRight } from "lucide-react";
import { MOCK_REVENUE_MONTHLY } from "./mockData";

export function RevenueChart() {
  const [activeMonthIndex, setActiveMonthIndex] = useState<number | null>(5); // default to Oct

  const maxRevenue = 300000;
  const activeMonth =
    activeMonthIndex !== null ? MOCK_REVENUE_MONTHLY[activeMonthIndex] : null;

  return (
    <div className="bg-white rounded-2xl p-5 sm:p-6 border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)] flex flex-col justify-between space-y-6">
      {/* ── Top Metric Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-black/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200">
              <IndianRupee className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-gray-950">Revenue Velocity</h2>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            6-Month gross platform subscription revenue (INR ₹)
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="px-3 py-1.5 rounded-xl bg-gray-50 border border-black/[0.05] text-right">
            <span className="text-[10px] text-gray-400 uppercase font-bold block">
              Cumulative
            </span>
            <span className="text-sm font-extrabold text-gray-950 font-mono">
              ₹14,22,500
            </span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200/60 text-right">
            <span className="text-[10px] text-emerald-700 uppercase font-bold block">
              Growth
            </span>
            <span className="text-sm font-extrabold text-emerald-800 flex items-center gap-1 font-mono">
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
          <div className="absolute inset-x-0 top-0 border-b border-dashed border-gray-100 flex items-center justify-between text-[10px] font-mono text-gray-400 pointer-events-none">
            <span>₹3.0L</span>
          </div>
          <div className="absolute inset-x-0 top-1/2 border-b border-dashed border-gray-100 flex items-center justify-between text-[10px] font-mono text-gray-400 pointer-events-none">
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
                  <div className="absolute -top-11 px-3 py-1.5 rounded-xl bg-black text-white text-[11px] font-bold shadow-xl whitespace-nowrap animate-in fade-in zoom-in-95 font-mono z-20">
                    {item.label} · {item.month} 2026
                  </div>
                ) : null}

                {/* Bar Element */}
                <div
                  className={`w-full max-w-[42px] rounded-t-lg transition-all duration-200 ${
                    isHovered
                      ? "bg-black shadow-[0_4px_16px_rgba(0,0,0,0.2)]"
                      : "bg-gray-800 hover:bg-gray-950"
                  }`}
                  style={{ height: `${heightPercent}%` }}
                />

                <span
                  className={`mt-2.5 text-xs font-semibold transition-colors ${
                    isHovered ? "text-gray-950 font-bold" : "text-gray-500"
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
        <div className="p-3 rounded-xl bg-gray-50 border border-black/[0.04] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-gray-600">
            <Info className="w-3.5 h-3.5 text-gray-400" />
            <span>
              Selected Period: <strong className="text-gray-900">{activeMonth.month} 2026</strong>
            </span>
          </div>
          <span className="font-extrabold text-gray-950 font-mono text-sm">
            {activeMonth.label}
          </span>
        </div>
      ) : null}
    </div>
  );
}
