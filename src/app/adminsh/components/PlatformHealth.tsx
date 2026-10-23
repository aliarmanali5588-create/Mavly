"use client";

import React from "react";
import { Server, CheckCircle2, ShieldCheck, Activity } from "lucide-react";
import { MOCK_SYSTEM_HEALTH } from "./mockData";

export function PlatformHealth() {
  return (
    <div className="bg-white rounded-2xl p-5 sm:p-6 border border-black/[0.08] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-black/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200">
              <Server className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-gray-950">Platform Health & Infrastructure</h2>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Real-time status of backend services, database connections, and worker queues
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 text-[10px] font-bold tracking-wider uppercase bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>All Systems Operational</span>
          </span>
          <span className="px-2 py-1 text-[10px] font-bold tracking-wider uppercase bg-gray-100 text-gray-500 rounded-lg">
            Demo Statuses
          </span>
        </div>
      </div>

      {/* Grid of Health Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {MOCK_SYSTEM_HEALTH.map((srv) => (
          <div
            key={srv.name}
            className="p-4 rounded-xl border border-black/[0.06] bg-gray-50/50 hover:bg-white hover:border-black/20 transition-all space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-950">{srv.name}</span>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                {srv.status}
              </span>
            </div>

            <p className="text-[11px] text-gray-500 leading-snug">
              {srv.description}
            </p>

            <div className="pt-2 border-t border-black/[0.04] flex items-center justify-between text-[10px] text-gray-400 font-medium">
              <span>
                Uptime: <strong className="text-gray-800">{srv.uptime}</strong>
              </span>
              <span className="flex items-center gap-1">
                <Activity className="w-3 h-3 text-gray-400" />
                Latency: <strong className="text-gray-800">{srv.latency}</strong>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
