"use client";

import React from "react";
import Link from "next/link";
import {
  AlertOctagon,
  ArrowRight,
  CreditCard,
  Megaphone,
  Sparkles,
  Users,
} from "lucide-react";

import type { AdminOverviewPayload } from "@/lib/admin/types";

const numberFormat = new Intl.NumberFormat("en-IN");

/**
 * Every shortcut points at an existing admin route. Broadcast opens the real
 * announcements page; it never sends anything from this card. Counts are the live
 * Overview aggregates (or a loading marker), never hardcoded figures.
 */
export function QuickActionsModal({
  data,
  error = false,
}: {
  data?: AdminOverviewPayload | null;
  error?: boolean;
}) {
  const usersHint = error
    ? "Account count unavailable"
    : data === undefined || data === null
      ? "Loading account count…"
      : `${numberFormat.format(data.users.total)} registered accounts`;

  const queueHint = error
    ? "Queue state unavailable"
    : data === undefined || data === null
      ? "Loading queue state…"
      : `${numberFormat.format(data.queue.running)} running · ${numberFormat.format(
          data.queue.queued
        )} queued`;

  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-[var(--clay-line)]">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-black text-white">
            <Sparkles className="w-4 h-4" />
          </div>
          <h2 className="text-base font-bold text-foreground">Administrative Shortcuts</h2>
        </div>
        <span className="text-xs text-muted-foreground font-medium">Direct Suite Routing</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Shortcut
          href="/adminsh/announcements"
          icon={<Megaphone className="w-5 h-5 text-amber-500 group-hover:text-white transition-colors" />}
          title="Broadcast Announcement"
          hint="Open the announcement workflow"
        />
        <Shortcut
          href="/adminsh/users"
          icon={<Users className="w-5 h-5 text-muted-foreground group-hover:text-white transition-colors" />}
          title="User Management"
          hint={usersHint}
        />
        <Shortcut
          href="/adminsh/generation-monitor"
          icon={<AlertOctagon className="w-5 h-5 text-rose-500 group-hover:text-white transition-colors" />}
          title="Build Queue Monitor"
          hint={queueHint}
        />
        <Shortcut
          href="/adminsh/billing"
          icon={<CreditCard className="w-5 h-5 text-emerald-500 group-hover:text-white transition-colors" />}
          title="Revenue & Invoices"
          hint="No Mavly billing source configured"
        />
      </div>
    </div>
  );
}

function Shortcut({
  href,
  icon,
  title,
  hint,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="p-4 rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)]/70 hover:bg-primary hover:text-primary-foreground group transition-all text-left flex flex-col justify-between h-24 cursor-pointer"
    >
      <div className="flex items-center justify-between w-full">
        {icon}
        <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      <div>
        <p className="text-xs font-bold text-foreground group-hover:text-white">{title}</p>
        <p className="text-[10px] text-muted-foreground group-hover:text-white/70 truncate" title={hint}>
          {hint}
        </p>
      </div>
    </Link>
  );
}
