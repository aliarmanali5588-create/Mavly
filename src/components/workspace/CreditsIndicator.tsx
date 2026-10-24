"use client";

import * as React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * FRONTEND-ONLY DEMONSTRATION PLACEHOLDER.
 *
 * This value is strictly for frontend demonstration in the workspace navigation bar.
 * It is not connected to any backend, database, balance calculations, or payment logic.
 */
export const DEMO_CREDITS_COUNT = 10;

export interface CreditsIndicatorProps {
  className?: string;
  credits?: number;
}

/**
 * Compact Credits indicator positioned immediately to the left of the Publish button
 * in the Mavly project workspace top navigation bar.
 */
export function CreditsIndicator({
  className,
  credits = DEMO_CREDITS_COUNT,
}: CreditsIndicatorProps) {
  return (
    <div
      data-testid="workspace-credits-indicator"
      aria-label={`Credits: ${credits}`}
      title="Credits"
      className={cn(
        "flex items-center gap-1.5 h-7 px-2 rounded-lg shrink-0 select-none",
        "border border-gray-200/60 dark:border-gray-700/60",
        "bg-black/[0.02] dark:bg-white/[0.04]",
        "text-gray-700 dark:text-gray-200",
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
        {credits}
      </span>
    </div>
  );
}
