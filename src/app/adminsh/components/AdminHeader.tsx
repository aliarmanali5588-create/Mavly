"use client";

import React, { useState } from "react";
import {
  Bell,
  Menu,
  X,
  Layers,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { toast } from "sonner";

import { ADMIN_PERIODS, type AdminPeriod } from "@/lib/admin/overview";
import { AdminNavSection } from "./types";

interface AdminHeaderProps {
  activeNav: AdminNavSection;
  onOpenMobileSidebar: () => void;
  /**
   * Live mode is used by the Overview page: the period selector is controlled
   * by the page, and status/environment reflect measured/configured values.
   * Other admin pages keep the original demo header.
   */
  live?: boolean;
  period?: AdminPeriod;
  onPeriodChange?: (period: AdminPeriod) => void;
  statusSummary?: string;
  statusTone?: "ok" | "warn" | "unknown";
  environment?: string;
}

const STATUS_DOT: Record<NonNullable<AdminHeaderProps["statusTone"]>, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  unknown: "bg-gray-400",
};

const STATUS_TEXT: Record<NonNullable<AdminHeaderProps["statusTone"]>, string> = {
  ok: "text-emerald-700",
  warn: "text-amber-700",
  unknown: "text-muted-foreground",
};

export function AdminHeader({
  activeNav,
  onOpenMobileSidebar,
  live = false,
  period = "30d",
  onPeriodChange,
  statusSummary = "Status unavailable",
  statusTone = "unknown",
  environment = "unknown",
}: AdminHeaderProps) {
  const [timeRange, setTimeRange] = useState("30D");
  const [showNotifications, setShowNotifications] = useState(false);

  const handleTimeChange = (range: string) => {
    if (live) {
      const match = ADMIN_PERIODS.find((entry) => entry.label === range);
      if (match) onPeriodChange?.(match.id);
      return;
    }
    setTimeRange(range);
    toast.success(`Filter updated: ${range}`, { duration: 1200 });
  };

  return (
    <header className="sticky top-0 z-20 bg-card/90 backdrop-blur-md border-b border-[var(--neu-line)] px-4 sm:px-6 lg:px-8 h-16 sm:h-20 flex items-center justify-between select-none">
      {/* ── Left: Mobile Toggle & Page Title Hierarchy ── */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          className="lg:hidden p-2 rounded-xl text-muted-foreground hover:text-black hover:bg-black/5 transition-colors cursor-pointer"
          aria-label="Open Sidebar"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="space-y-0.5">
          {/* Breadcrumb line */}
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <span>Admin</span>
            <span>/</span>
            <span className="text-foreground font-semibold">{activeNav}</span>
            <span className="hidden sm:inline-block">·</span>
            <span
              className={`hidden sm:inline-flex items-center gap-1 font-semibold ${STATUS_TEXT[statusTone]}`}
              title={live ? "Measured/configured service state" : undefined}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[statusTone]}`} />
              <span>{live ? statusSummary : "99.98% Operational"}</span>
            </span>
          </div>

          <h1 className="text-lg sm:text-xl font-extrabold tracking-tight text-foreground">
            {activeNav}
          </h1>
        </div>
      </div>

      {/* ── Right: Refined Segmented Time Selector & Profile Controls ── */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Segmented Time Range Selector */}
        <div
          className="hidden sm:flex items-center p-1 rounded-xl bg-[var(--neu-sunken)]/80 border border-[var(--neu-line)] text-xs font-semibold text-muted-foreground"
          role="group"
          aria-label="Dashboard period"
        >
          {ADMIN_PERIODS.map((option) => {
            const selected = live ? period === option.id : timeRange === option.label;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => handleTimeChange(option.label)}
                aria-pressed={selected}
                title={option.description}
                className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                  selected ? "bg-card text-foreground shadow-xs font-bold" : "hover:text-black"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {/* Notifications Popover Trigger */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowNotifications(!showNotifications)}
            className="relative p-2 rounded-xl text-muted-foreground hover:text-black hover:bg-black/5 transition-colors cursor-pointer"
            aria-label="Notifications"
          >
            <Bell className="w-4 h-4" />
            {!live ? (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500 ring-2 ring-white" />
            ) : null}
          </button>

          {showNotifications ? (
            <div className="absolute right-0 mt-2 w-80 sm:w-92 bg-card rounded-2xl border border-[var(--neu-line)] shadow-[0_20px_50px_rgba(0,0,0,0.1)] p-4 z-50 animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center justify-between pb-3 border-b border-[var(--neu-line)] mb-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-bold text-foreground">System Notifications</h3>
                  {!live ? (
                    <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold bg-black text-white rounded">
                      3
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setShowNotifications(false)}
                  className="p-1 text-muted-foreground hover:text-black rounded-lg hover:bg-black/5"
                  aria-label="Close notifications"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {live ? (
                <div className="py-6 text-center space-y-1">
                  <ShieldQuestion className="w-5 h-5 text-muted-foreground mx-auto" />
                  <p className="text-xs font-semibold text-foreground">Notifications are unavailable</p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed px-4">
                    This deployment has no notification store. No alerts are fabricated.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {[
                    {
                      title: "Model Spike Detected",
                      time: "10m ago",
                      desc: "DeepSeek V4.1 usage increased by +24% across builder prompt queues.",
                    },
                    {
                      title: "Automated Backup Completed",
                      time: "1h ago",
                      desc: "Daily PostgreSQL database snapshot successfully verified and encrypted.",
                    },
                    {
                      title: "Generation Timeout Alert",
                      time: "2h ago",
                      desc: "1 project build job timed out and was automatically compensated.",
                    },
                  ].map((n) => (
                    <div
                      key={n.title}
                      className="p-2.5 rounded-xl bg-[var(--neu-sunken)]/80 hover:bg-[var(--neu-sunken)]/80 transition-colors flex items-start gap-2.5"
                    >
                      <Layers className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-foreground">{n.title}</p>
                          <span className="text-[10px] text-muted-foreground font-mono">{n.time}</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{n.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Environment Badge Pill */}
        <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--neu-sunken)] border border-[var(--neu-line)] text-[10px] font-bold text-foreground">
          <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="uppercase">{live ? environment : "PRODUCTION"}</span>
        </div>
      </div>
    </header>
  );
}
