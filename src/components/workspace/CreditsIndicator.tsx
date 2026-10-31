"use client";

import * as React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { vcaasApi } from "@/lib/vcaas";

/**
 * Compact available-credit indicator for the workspace navigation bar.
 *
 * ⚠️ THE OLD COMPONENT RENDERED A HARDCODED `10`. There is now a real credit
 * account, so this component reads it from `GET /vcaas/credits` — the same
 * authoritative number the ledger and the run pipeline use.
 *
 * It shows AVAILABLE credits (balance − active holds), which is what a new
 * generation can actually spend. A disabled deployment or a failed read shows
 * "—", never a fabricated number.
 *
 * The value is refreshed when `refreshKey` changes (the workspace passes the
 * run state, so a finished run updates the balance) and once on mount.
 */
export interface CreditsIndicatorProps {
  className?: string;
  /** Explicit value, for a caller that already has the account. */
  credits?: number;
  /** Change this token to refetch, e.g. when a generation run ends. */
  refreshKey?: string | number;
}

export function CreditsIndicator({ className, credits, refreshKey }: CreditsIndicatorProps) {
  const explicit = typeof credits === "number";
  /** `undefined` = still loading; `null` = known unavailable. */
  const [accountCredits, setAccountCredits] = React.useState<number | null | undefined>(undefined);

  React.useEffect(() => {
    if (explicit) return;
    let active = true;
    setAccountCredits(undefined);

    vcaasApi
      .credits()
      .then((result) => {
        if (!active) return;
        const available = result.ok ? result.data?.available : null;
        setAccountCredits(
          result.ok && result.data?.enabled && typeof available === "number" ? available : null,
        );
      })
      .catch(() => {
        if (active) setAccountCredits(null);
      });

    return () => {
      active = false;
    };
  }, [explicit, refreshKey]);

  const value = explicit ? credits : accountCredits;
  const label = value === undefined ? "…" : value === null ? "—" : String(value);
  const title =
    value === null
      ? "Credits are unavailable"
      : value === undefined
        ? "Loading credits"
        : "Available credits";

  return (
    <div
      data-testid="workspace-credits-indicator"
      aria-label={`Credits: ${label}`}
      title={title}
      className={cn(
        "flex items-center gap-1.5 h-7 px-2 rounded-lg shrink-0 select-none",
        "border border-[var(--neu-line)]/60 ",
        "bg-black/[0.02] dark:bg-white/[0.04]",
        "text-foreground ",
        "transition-colors",
        className
      )}
    >
      <Image
        src="/svg/credit.svg"
        alt=""
        width={16}
        height={16}
        className="w-4 h-4 shrink-0 object-contain dark:invert"
        priority
        unoptimized
      />
      <span className="text-xs font-medium tabular-nums leading-none">
        {label}
      </span>
    </div>
  );
}
