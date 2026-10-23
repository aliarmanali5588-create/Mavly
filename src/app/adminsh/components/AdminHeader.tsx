"use client";

import React, { useState } from "react";
import {
  Bell,
  Menu,
  ChevronDown,
  Calendar,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  X,
  Search,
  Activity,
  Layers,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { AdminNavSection } from "./types";

interface AdminHeaderProps {
  activeNav: AdminNavSection;
  onOpenMobileSidebar: () => void;
}

const SECTION_DESCRIPTIONS: Record<AdminNavSection, string> = {
  Overview: "Real-time platform telemetry, MRR performance, and active generation traffic.",
  Users: "Manage registered user accounts, workspace memberships, and tier entitlements.",
  "Billing & Revenue": "Track subscription revenue, invoice settlement, and payment performance.",
  "AI Usage & Cost": "Monitor token consumption, provider latency, and model margin economics.",
  "Generation Monitor": "Live telemetry of active, queued, and completed project build workers.",
  Projects: "Overview of all generated project sandboxes, repositories, and custom domains.",
  Credits: "Manage credit ledger transactions, allowance pools, and adjustment grants.",
  Announcements: "Broadcast global announcements and operational notice banners to users.",
  "System Health": "Real-time service health, server uptime SLAs, and database connection metrics.",
  "Audit Logs": "Cryptographic security audit trail of operator actions and system mutations.",
  Settings: "Configure global system defaults, models, regional currency, and security policies.",
};

export function AdminHeader({
  activeNav,
  onOpenMobileSidebar,
}: AdminHeaderProps) {
  const [timeRange, setTimeRange] = useState("30D");
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(2);

  const notifications = [
    {
      id: "n1",
      title: "Model Spike Detected",
      time: "10m ago",
      desc: "DeepSeek V4.1 usage increased by +24% across builder prompt queues.",
      icon: Sparkles,
      color: "text-amber-500",
    },
    {
      id: "n2",
      title: "Automated Backup Completed",
      time: "1h ago",
      desc: "Daily PostgreSQL database snapshot successfully verified and encrypted.",
      icon: CheckCircle2,
      color: "text-emerald-500",
    },
    {
      id: "n3",
      title: "Generation Timeout Alert",
      time: "2h ago",
      desc: "1 project build job timed out and was automatically compensated.",
      icon: AlertCircle,
      color: "text-red-500",
    },
  ];

  const handleTimeChange = (range: string) => {
    setTimeRange(range);
    toast.success(`Filter updated: ${range}`, { duration: 1200 });
  };

  return (
    <header className="sticky top-0 z-20 bg-white/90 backdrop-blur-md border-b border-black/[0.08] px-4 sm:px-6 lg:px-8 h-16 sm:h-20 flex items-center justify-between select-none">
      {/* ── Left: Mobile Toggle & Page Title Hierarchy ── */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          className="lg:hidden p-2 rounded-xl text-gray-600 hover:text-black hover:bg-black/5 transition-colors cursor-pointer"
          aria-label="Open Sidebar"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="space-y-0.5">
          {/* Breadcrumb line */}
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-gray-400">
            <span>Admin</span>
            <span>/</span>
            <span className="text-gray-900 font-semibold">{activeNav}</span>
            <span className="hidden sm:inline-block">·</span>
            <span className="hidden sm:inline-flex items-center gap-1 text-emerald-600 font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>99.98% Operational</span>
            </span>
          </div>

          <h1 className="text-lg sm:text-xl font-extrabold tracking-tight text-gray-950">
            {activeNav}
          </h1>
        </div>
      </div>

      {/* ── Right: Refined Segmented Time Selector & Profile Controls ── */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Segmented Time Range Selector */}
        <div className="hidden sm:flex items-center p-1 rounded-xl bg-gray-100/80 border border-black/[0.06] text-xs font-semibold text-gray-600">
          {["7D", "30D", "3M", "YTD"].map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => handleTimeChange(opt)}
              className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                timeRange === opt
                  ? "bg-white text-gray-950 shadow-xs font-bold"
                  : "hover:text-black"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>

        {/* Notifications Popover Trigger */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setShowNotifications(!showNotifications);
              if (unreadCount > 0) setUnreadCount(0);
            }}
            className="relative p-2 rounded-xl text-gray-600 hover:text-black hover:bg-black/5 transition-colors cursor-pointer"
            aria-label="Notifications"
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 ? (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500 ring-2 ring-white" />
            ) : null}
          </button>

          {showNotifications ? (
            <div className="absolute right-0 mt-2 w-80 sm:w-92 bg-white rounded-2xl border border-black/[0.08] shadow-[0_20px_50px_rgba(0,0,0,0.1)] p-4 z-50 animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center justify-between pb-3 border-b border-black/[0.06] mb-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-bold text-gray-950">System Notifications</h3>
                  <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold bg-black text-white rounded">
                    3
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNotifications(false)}
                  className="p-1 text-gray-400 hover:text-black rounded-lg hover:bg-black/5"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="space-y-2">
                {notifications.map((n) => {
                  const Icon = n.icon;
                  return (
                    <div
                      key={n.id}
                      className="p-2.5 rounded-xl bg-gray-50/80 hover:bg-gray-100/80 transition-colors flex items-start gap-2.5"
                    >
                      <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${n.color}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-gray-900">{n.title}</p>
                          <span className="text-[10px] text-gray-400 font-mono">{n.time}</span>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">
                          {n.desc}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 pt-2.5 border-t border-black/[0.06] text-center">
                <button
                  type="button"
                  onClick={() => {
                    setShowNotifications(false);
                    toast.success("All notifications cleared");
                  }}
                  className="text-[11px] font-semibold text-gray-500 hover:text-black cursor-pointer"
                >
                  Mark all as acknowledged
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Environment Badge Pill */}
        <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-50 border border-black/[0.06] text-[10px] font-bold text-gray-700">
          <ShieldCheck className="w-3.5 h-3.5 text-gray-500" />
          <span>PRODUCTION</span>
        </div>
      </div>
    </header>
  );
}
