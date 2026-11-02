"use client";

import React, { useState } from "react";
import { ShieldCheck, ShieldQuestion, X } from "lucide-react";

import type { AdminPeriod } from "@/lib/admin/overview";
import { AdminNavSection } from "./types";
import { AdminSidebar } from "./AdminSidebar";
import { AdminHeader } from "./AdminHeader";
import { useAdminUserCount } from "./useAdminUserCount";

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
  /**
   * ⚠️ SET ONLY BY A LOADING BOUNDARY.
   *
   * The chrome (sidebar, header, footer, content container) is identical to the
   * real page, so a navigation paints the shell immediately and the skeleton
   * occupies exactly the space the real content will. The one behavioural
   * difference is that the sidebar's user-count fetch is suppressed: a
   * placeholder must not issue a request the real page will duplicate.
   */
  loading?: boolean;
}

/**
 * ═══ WHICH SECTIONS READ REAL DATA ══════════════════════════════════════════
 *
 * Every section in this console now reads the database. The set is kept as an
 * explicit list rather than being inferred, because the ribbon and footer below
 * make a factual claim ("live data" vs "mock telemetry") and that claim must be
 * a deliberate decision per section, not a default.
 *
 * ⚠️ ADDING A SECTION HERE IS A CLAIM THAT IT HAS NO MOCK DATA LEFT. If a page
 * still renders a hardcoded array, it does not belong in this set.
 */
const REAL_DATA_SECTIONS = new Set<AdminNavSection>([
  "Users",
  "Projects",
  "Billing & Revenue",
  "Credits",
  "AI Usage & Cost",
  "Generation Monitor",
  "System Health",
  "Announcements",
  "Audit Logs",
  "Settings",
]);

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
  loading = false,
}: AdminShellProps) {
  const [isOpenMobile, setIsOpenMobile] = useState(false);
  const [showNotice, setShowNotice] = useState(true);
  const isRealDataSection = REAL_DATA_SECTIONS.has(activeNav);
  const showLiveFooter = live || isRealDataSection;

  /**
   * ═══ ONE USER COUNT FOR THE WHOLE CONSOLE ═════════════════════════════════
   *
   * The sidebar badge is fetched here, in the shell every admin page shares, so
   * it agrees with the Users page on every route. A caller that already has an
   * authoritative figure (Overview, from its own payload) passes it in and
   * wins; otherwise the shell's own count is used.
   */
  const fetchedUserCount = useAdminUserCount(!loading);
  const resolvedUserCount = userCount ?? fetchedUserCount;

  return (
    <div className="min-h-screen bg-[var(--clay-base)] text-foreground font-sans flex flex-col lg:flex-row mavly-page-enter antialiased">
      {/* 1. Sidebar */}
      <AdminSidebar
        activeNav={activeNav}
        isOpenMobile={isOpenMobile}
        setIsOpenMobile={setIsOpenMobile}
        live={live}
        userCount={resolvedUserCount}
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
          {!isRealDataSection && showNotice && (
            <div className="px-4 py-2.5 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-2 h-2 rounded-full bg-success shrink-0" />
                <span className="font-bold text-foreground tracking-tight shrink-0">
                  Mavly Admin Console
                </span>
                <span className="text-muted-foreground hidden sm:inline">|</span>
                <span className="text-muted-foreground truncate hidden sm:inline">
                  Active View: <strong>{activeNav}</strong>.{" "}
                  {live
                    ? "Metrics are read from this deployment's database and configured services."
                    : "Reads this deployment's database. Nothing on this page is simulated."}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase ${
                    live ? "bg-success text-success-foreground" : "bg-black text-white"
                  }`}
                >
                  {live ? "LIVE DATA" : "DATABASE-BACKED"}
                </span>
                <button
                  type="button"
                  onClick={() => setShowNotice(false)}
                  className="p-1 text-muted-foreground hover:text-black rounded-lg hover:bg-[var(--clay-sunken)] cursor-pointer"
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
              {showLiveFooter ? (
                <span>Release {version ?? "not set"}</span>
              ) : (
                <span>Release v2.4.0 (Enterprise Suite)</span>
              )}
              <span>·</span>
              <span className={showLiveFooter ? "text-muted-foreground font-medium" : "text-success font-medium"}>
                {showLiveFooter ? "p99: not measured" : "p99: 18ms"}
              </span>
            </div>

            <div className="flex items-center gap-3 text-muted-foreground font-medium">
              {showLiveFooter ? (
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
                    <span>Admin-only access</span>
                  </span>
                  <span>·</span>
                  <span>Every mutation is audited</span>
                </>
              )}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
