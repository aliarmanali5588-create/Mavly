"use client";

import React, { useState } from "react";
import { ShieldCheck, ShieldQuestion, X } from "lucide-react";

import type { AdminPeriod } from "@/lib/admin/overview";
import { AdminNavSection } from "./types";
import { AdminSidebar } from "./AdminSidebar";
import { AdminHeader } from "./AdminHeader";

interface AdminShellProps {
  activeNav: AdminNavSection;
  children: React.ReactNode;
  /** Overview uses live mode; other admin pages keep the original demo chrome. */
  live?: boolean;
  period?: AdminPeriod;
  onPeriodChange?: (period: AdminPeriod) => void;
  statusSummary?: string;
  statusTone?: "ok" | "warn" | "unknown";
  environment?: string;
  version?: string | null;
  userCount?: number | null;
}

export function AdminShell({
  activeNav,
  children,
  live = false,
  period,
  onPeriodChange,
  statusSummary,
  statusTone,
  environment,
  version,
  userCount,
}: AdminShellProps) {
  const [isOpenMobile, setIsOpenMobile] = useState(false);
  const [showNotice, setShowNotice] = useState(true);

  return (
    <div className="min-h-screen bg-[var(--clay-base)] text-foreground font-sans flex flex-col lg:flex-row mavly-page-enter antialiased">
      {/* 1. Sidebar */}
      <AdminSidebar
        activeNav={activeNav}
        isOpenMobile={isOpenMobile}
        setIsOpenMobile={setIsOpenMobile}
        live={live}
        userCount={userCount}
        environment={environment}
      />

      {/* 2. Main Content Canvas */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Sticky Top Header */}
        <AdminHeader
          activeNav={activeNav}
          onOpenMobileSidebar={() => setIsOpenMobile(true)}
          live={live}
          period={period}
          onPeriodChange={onPeriodChange}
          statusSummary={statusSummary}
          statusTone={statusTone}
          environment={environment}
        />

        {/* Main Content Scroll Area */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl w-full mx-auto">
          {/* Environment ribbon */}
          {showNotice && (
            <div className="px-4 py-2.5 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <span className="font-bold text-foreground tracking-tight shrink-0">
                  {live ? "Live Admin Console" : "Visual Admin Console"}
                </span>
                <span className="text-muted-foreground hidden sm:inline">|</span>
                <span className="text-muted-foreground truncate hidden sm:inline">
                  Active View: <strong>{activeNav}</strong>.{" "}
                  {live
                    ? "Metrics are read from this deployment's database and configured services."
                    : "High-fidelity frontend simulation with isolated mock telemetry."}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase ${
                    live ? "bg-emerald-700 text-white" : "bg-black text-white"
                  }`}
                >
                  {live ? "LIVE DATA" : "MOCK TELEMETRY"}
                </span>
                <button
                  type="button"
                  onClick={() => setShowNotice(false)}
                  className="p-1 text-muted-foreground hover:text-black rounded-lg hover:bg-black/5 cursor-pointer"
                  title="Dismiss notice"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Page-Specific Content Body */}
          {children}
        </main>

        {/* Enterprise System Footer */}
        <footer className="py-5 px-6 lg:px-8 border-t border-[var(--clay-line)] bg-card/60 text-xs text-muted-foreground">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground">Mavly Cloud Admin</span>
              <span>·</span>
              {live ? (
                <span>Release {version ?? "not set"}</span>
              ) : (
                <span>Release v2.4.0 (Enterprise Suite)</span>
              )}
              <span>·</span>
              <span className={live ? "text-muted-foreground font-medium" : "text-emerald-600 font-medium"}>
                {live ? "p99: not measured" : "p99: 18ms"}
              </span>
            </div>

            <div className="flex items-center gap-3 text-muted-foreground font-medium">
              {live ? (
                <>
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground" />
                    <span>Admin-only read access</span>
                  </span>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <ShieldQuestion className="w-3.5 h-3.5 text-muted-foreground" />
                    <span>No historical uptime tracked</span>
                  </span>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground" />
                    <span>Strict Frontend Scope Lock Active</span>
                  </span>
                  <span>·</span>
                  <span>Zero Real Backend Mutations</span>
                </>
              )}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
