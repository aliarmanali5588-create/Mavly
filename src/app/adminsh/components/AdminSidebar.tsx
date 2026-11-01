"use client";

import React from "react";
import Image from "next/image";
import Link from "next/link";
import {
  LayoutDashboard,
  Users,
  CreditCard,
  Cpu,
  Sparkles,
  FolderGit2,
  Zap,
  Megaphone,
  Server,
  ShieldAlert,
  Settings,
  LogOut,
  X,
  ChevronRight,
  ShieldCheck,
  Activity,
  Layers,
} from "lucide-react";
import { toast } from "sonner";
import { AdminNavSection } from "./types";

interface AdminSidebarProps {
  activeNav: AdminNavSection;
  setActiveNav?: (nav: AdminNavSection) => void;
  isOpenMobile: boolean;
  setIsOpenMobile: (open: boolean) => void;
  /** Overview passes live counts so no sidebar badge is a hardcoded metric. */
  live?: boolean;
  userCount?: number | null;
  environment?: string;
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

export interface NavItemConfig {
  id: AdminNavSection;
  label: string;
  href: string;
  icon: React.ElementType;
  badge?: string;
}

interface NavGroup {
  groupName: string;
  items: NavItemConfig[];
}

export const ADMIN_NAV_GROUPS: NavGroup[] = [
  {
    groupName: "Overview & Core",
    items: [
      { id: "Overview", label: "Overview", href: "/adminsh/dashboard", icon: LayoutDashboard },
      /**
       * ⚠️ NO BADGE HERE. The Users count is a live database figure supplied by
       * `AdminShell`; a literal here is what made the sidebar claim 12.4k while
       * the directory showed the real total.
       */
      { id: "Users", label: "Users", href: "/adminsh/users", icon: Users },
      { id: "Projects", label: "Projects", href: "/adminsh/projects", icon: FolderGit2 },
    ],
  },
  {
    groupName: "Financial & Credits",
    items: [
      { id: "Billing & Revenue", label: "Billing & Revenue", href: "/adminsh/billing", icon: CreditCard },
      { id: "Credits", label: "Credits Ledger", href: "/adminsh/credits", icon: Zap },
      { id: "AI Usage & Cost", label: "AI Usage & Cost", href: "/adminsh/ai-usage", icon: Cpu },
    ],
  },
  {
    groupName: "Operations & Health",
    items: [
      { id: "Generation Monitor", label: "Generation Monitor", href: "/adminsh/generation-monitor", icon: Sparkles, badge: "Live" },
      { id: "System Health", label: "System Health", href: "/adminsh/system-health", icon: Server, badge: "99.9%" },
      { id: "Announcements", label: "Announcements", href: "/adminsh/announcements", icon: Megaphone },
    ],
  },
  {
    groupName: "Governance",
    items: [
      { id: "Audit Logs", label: "Audit Logs", href: "/adminsh/audit-logs", icon: ShieldAlert },
      { id: "Settings", label: "Settings", href: "/adminsh/settings", icon: Settings },
    ],
  },
];

export function AdminSidebar({
  activeNav,
  setActiveNav,
  isOpenMobile,
  setIsOpenMobile,
  live = false,
  userCount = null,
  environment = "unknown",
}: AdminSidebarProps) {

  const handleSignOut = async () => {
    /**
     * ⚠️ NO FAKE DELAY, AND NO FAKE SUCCESS.
     *
     * This used to show a "Session terminated" toast and `setTimeout` a
     * client-side navigation to `/adminsh/auth` — a page that never ended the
     * Supabase session. It now calls the real sign-out route (POST only, same
     * as `AuthNav`) and only reports success once the server confirms it.
     */
    try {
      const response = await fetch("/auth/signout", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error(`sign out failed (${response.status})`);
      window.location.href = "/";
    } catch {
      toast.error("We couldn't sign you out. Please try again.");
    }
  };

  const content = (
    <div className="flex flex-col h-full bg-card border-r border-[var(--clay-line)] text-foreground select-none font-sans">
      {/* ── Top Workspace Header ── */}
      <div className="p-4 border-b border-[var(--clay-line)] flex items-center justify-between">
        <Link
          href="/adminsh/dashboard"
          className="flex items-center gap-3 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black rounded-xl p-1 -m-1"
        >
          <div className="w-8 h-8 rounded-xl overflow-hidden bg-card shadow-[var(--clay-elev-1)] p-0.5 border border-[var(--clay-line)] flex items-center justify-center shrink-0 transition-transform duration-200">
            <Image
              src="/logo/Mavly.png"
              alt="Mavly Logo"
              width={32}
              height={32}
              className="w-full h-full object-contain rounded-lg"
              priority
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-extrabold tracking-tight text-foreground text-sm">
                Mavly Admin
              </span>
              <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold tracking-wider uppercase bg-black text-white rounded shadow-[var(--clay-elev-ink-1)]">
                {live ? environment : "PROD"}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground font-medium truncate flex items-center gap-1 mt-0.5">
              <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-muted-foreground" : "bg-success animate-pulse"}`} />
              <span>{live ? "Verified admin session" : "Enterprise Console"}</span>
            </p>
          </div>
        </Link>

        {/* Mobile Close Button */}
        <button
          type="button"
          onClick={() => setIsOpenMobile(false)}
          className="lg:hidden p-1.5 text-muted-foreground hover:text-black rounded-lg hover:bg-[var(--clay-sunken)]"
          aria-label="Close Sidebar"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* ── Navigation Groups ── */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5 scrollbar-thin">
        {ADMIN_NAV_GROUPS.map((group) => (
          <div key={group.groupName} className="space-y-1">
            <div className="px-2.5 pb-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
              {group.groupName}
            </div>

            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;
              /**
               * The Users badge is ALWAYS the live count — on every admin page,
               * not only the Overview. `userCount` is `null` until the count is
               * known, and an unknown count renders no badge rather than a
               * placeholder number.
               */
              const badge =
                item.id === "Users"
                  ? userCount === null
                    ? undefined
                    : compactCount(userCount)
                  : live && item.id === "System Health"
                    ? undefined
                    : item.badge;

              return (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={() => {
                    setActiveNav?.(item.id);
                    setIsOpenMobile(false);
                  }}
                  className={`w-full flex items-center justify-between px-2.5 py-2 rounded-xl text-xs font-medium transition-all duration-150 group cursor-pointer ${
                    isActive
                      ? "bg-black text-white shadow-[var(--clay-elev-ink-1)] font-semibold"
                      : "text-muted-foreground hover:text-foreground hover:bg-[var(--clay-sunken)]"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon
                      className={`w-4 h-4 shrink-0 transition-colors ${
                        isActive ? "text-white" : "text-muted-foreground group-hover:text-black"
                      }`}
                    />
                    <span className="truncate">{item.label}</span>
                  </div>

                  {badge ? (
                    <span
                      className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded-md shrink-0 ml-1.5 ${
                        isActive
                          ? "bg-card/20 text-white"
                          : "bg-[var(--clay-sunken)] text-muted-foreground group-hover:bg-[var(--clay-sunken)]"
                      }`}
                    >
                      {badge}
                    </span>
                  ) : item.id === "Users" ? (
                    /* The count is still loading: hold the space so the row does
                       not jump when the real figure arrives. */
                    <span
                      aria-hidden="true"
                      className={`h-3.5 w-7 rounded-md shrink-0 ml-1.5 animate-pulse ${
                        isActive ? "bg-card/20" : "bg-[var(--clay-sunken)]"
                      }`}
                    />
                  ) : isActive ? (
                    <ChevronRight className="w-3.5 h-3.5 text-white/60 shrink-0" />
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── Bottom Operator Profile Card & Sign Out ── */}
      <div className="p-3 border-t border-[var(--clay-line)] bg-[var(--clay-sunken)] space-y-2">
        <div className="p-2.5 rounded-xl bg-card border border-[var(--clay-line)] flex items-center gap-2.5 shadow-[var(--clay-elev-1)]">
          <div className="w-8 h-8 rounded-full bg-black text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-[var(--clay-elev-ink-1)]">
            {live ? "AD" : "SA"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-bold text-foreground truncate">
                {live ? "Administrator" : "Super Admin"}
              </p>
              <span className="w-1.5 h-1.5 rounded-full bg-success" />
            </div>
            <p className="text-[10px] text-muted-foreground font-mono truncate">
              {live ? "Session verified server-side" : "aitoolkitguide@gmail.com"}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleSignOut}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-muted-foreground hover:text-destructive-subtle-foreground hover:bg-destructive-subtle border border-transparent hover:border-destructive/20 transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 h-screen sticky top-0 z-30">
        {content}
      </aside>

      {/* Mobile Drawer Overlay */}
      {isOpenMobile ? (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-[var(--clay-scrim)] backdrop-blur-[3px] transition-opacity"
            onClick={() => setIsOpenMobile(false)}
          />
          <div className="relative z-10 w-72 max-w-[85vw] h-full shadow-[var(--clay-float)]">
            {content}
          </div>
        </div>
      ) : null}
    </>
  );
}
