"use client";

import React from "react";
import { Users, Banknote, Sparkles, Activity, TrendingUp, ArrowUpRight } from "lucide-react";
import { MOCK_KPI_DATA } from "./mockData";

const ICON_MAP: Record<string, React.ElementType> = {
  users: Users,
  revenue: Banknote,
  sparkles: Sparkles,
  activity: Activity,
};

// Subtle sparklines for Tier-1 SaaS feel
const SPARKLINE_DATA: Record<string, string> = {
  kpi_1: "0,25 10,22 20,26 30,18 40,20 50,14 60,18 70,10 80,12 90,4 100,2",
  kpi_2: "0,28 10,24 20,20 30,22 40,16 50,14 60,12 70,8 80,10 90,6 100,2",
  kpi_3: "0,20 10,25 20,18 30,22 40,15 50,18 60,12 70,14 80,8 90,4 100,2",
  kpi_4: "0,15 10,18 20,14 30,12 40,16 50,10 60,8 70,12 80,6 90,4 100,2",
};

export function KpiCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {MOCK_KPI_DATA.map((card) => {
        const Icon = ICON_MAP[card.icon] || TrendingUp;
        const sparkline = SPARKLINE_DATA[card.id] || "0,20 50,10 100,2";

        return (
          <div
            key={card.id}
            className="group relative bg-white rounded-2xl p-5 border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] hover:border-black/20 transition-all duration-200 overflow-hidden flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 tracking-wide">
                  {card.title}
                </span>
                <div className="p-2 rounded-xl bg-gray-50 border border-black/[0.04] text-gray-700 group-hover:bg-black group-hover:text-white transition-colors duration-200 shrink-0">
                  <Icon className="w-4 h-4" />
                </div>
              </div>

              <div className="mt-2 flex items-baseline justify-between">
                <h3 className="text-2xl sm:text-3xl font-extrabold text-gray-950 tracking-tight font-sans tabular-nums">
                  {card.value}
                </h3>
              </div>
            </div>

            {/* Bottom Row: Delta & Micro Sparkline */}
            <div className="mt-4 pt-3 border-t border-black/[0.04] flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-mono">
                  <TrendingUp className="w-3 h-3 text-emerald-600" />
                  <span>{card.change}</span>
                </span>
                <span className="text-[11px] text-gray-400 font-medium">
                  {card.timeframe}
                </span>
              </div>

              {/* Inline SVG Sparkline */}
              <div className="w-16 h-6 opacity-60 group-hover:opacity-100 transition-opacity">
                <svg className="w-full h-full overflow-visible" viewBox="0 0 100 30">
                  <polyline
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={sparkline}
                  />
                </svg>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
