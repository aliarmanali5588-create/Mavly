"use client";

import React from "react";
import Link from "next/link";
import { Cpu, Zap, CheckCircle2, AlertTriangle, Coins, ArrowRight } from "lucide-react";
import { MOCK_AI_MODEL_USAGE } from "./mockData";

export function AiUsageSection() {
  return (
    <div className="bg-white rounded-2xl p-5 sm:p-6 border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-6 flex flex-col justify-between">
      {/* ── Top Metric Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-black/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-purple-50 text-purple-700 border border-purple-200">
              <Cpu className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-gray-950">AI Orchestration &amp; Compute</h2>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Model token throughput and provider cost distribution
          </p>
        </div>

        <Link
          href="/adminsh/ai-usage"
          className="text-xs font-bold text-black hover:underline inline-flex items-center gap-1 self-start sm:self-auto"
        >
          <span>Deep Analytics</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* ── Summary Counters ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="p-3 rounded-xl bg-gray-50 border border-black/[0.04]">
          <span className="text-[10px] font-bold uppercase text-gray-400 block">Total Requests</span>
          <p className="text-base font-extrabold text-gray-950 mt-1 font-mono">1,42,500</p>
        </div>
        <div className="p-3 rounded-xl bg-gray-50 border border-black/[0.04]">
          <span className="text-[10px] font-bold uppercase text-gray-400 block">Success Rate</span>
          <p className="text-base font-extrabold text-emerald-700 mt-1 font-mono">99.6%</p>
        </div>
        <div className="p-3 rounded-xl bg-gray-50 border border-black/[0.04]">
          <span className="text-[10px] font-bold uppercase text-gray-400 block">Total Tokens</span>
          <p className="text-base font-extrabold text-gray-950 mt-1 font-mono">102.8M</p>
        </div>
        <div className="p-3 rounded-xl bg-gray-50 border border-black/[0.04]">
          <span className="text-[10px] font-bold uppercase text-gray-400 block">Est. Cost</span>
          <p className="text-base font-extrabold text-gray-950 mt-1 font-mono">₹1,02,800</p>
        </div>
      </div>

      {/* ── Model Breakdown List ── */}
      <div className="space-y-3 pt-1">
        <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-gray-400">
          <span>Active Provider Pool</span>
          <span>Share</span>
        </div>

        <div className="space-y-3">
          {MOCK_AI_MODEL_USAGE.map((model) => (
            <div
              key={model.name}
              className="p-3.5 rounded-xl border border-black/[0.06] bg-gray-50/60 hover:bg-white hover:border-black/20 transition-all space-y-2"
            >
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-gray-950">{model.name}</span>
                  <span className="text-[10px] text-gray-400 font-mono">
                    ({model.provider})
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-gray-500">{model.tokens}</span>
                  <span className="text-gray-300">·</span>
                  <span className="font-bold text-gray-950">{model.cost}</span>
                </div>
              </div>

              {/* Share Meter */}
              <div className="w-full h-1.5 rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full bg-black rounded-full transition-all duration-500"
                  style={{ width: `${model.share}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-[10px] text-gray-400 font-medium">
                <span>{model.requests} prompt jobs ({model.share}%)</span>
                <span className="text-emerald-700 font-bold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  {model.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
