"use client";

import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { stageText, type RunStage } from "@/lib/run-progress";

export function generationStatusText(
  stage: RunStage | null,
  retrying = false,
): string {
  if (retrying) return "Retrying a generation step";
  return stage ? stageText(stage) : "Waiting for generation status";
}

export function GenerationIndicator({
  className = "",
  active = true,
}: {
  className?: string;
  active?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={`generation-indicator relative inline-flex shrink-0 items-center justify-center ${className}`}
    >
      <span className="absolute inset-0 rounded-full border border-primary/15" />
      <span className="absolute inset-[3px] rounded-full border border-primary/25" />
      <span
        data-active={active}
        className="generation-indicator-orbit absolute inset-0"
      >
        <span className="absolute left-1/2 top-[1px] size-1 -translate-x-1/2 rounded-full bg-primary shadow-[0_0_6px_color-mix(in_oklab,var(--primary)_55%,transparent)]" />
      </span>
    </span>
  );
}

export interface ActivityChecklistStage {
  label: string;
  status: "pending" | "active" | "completed";
}

export function PremiumAiActivity({
  title,
  stages = [],
  active = true,
  className = "",
  meta,
  children,
}: {
  title: string;
  stages?: ActivityChecklistStage[];
  active?: boolean;
  className?: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label="AI activity"
      aria-busy={active}
      data-testid="run-activity"
      className={`mt-3 rounded-xl border border-border bg-card p-3 shadow-xs ${className}`}
    >
      <div className="flex items-center gap-2">
        <GenerationIndicator className="size-6" active={active} />
        <p role="status" aria-live="polite" aria-atomic="true" data-testid="run-activity-stage" className="min-w-0 flex-1 truncate text-sm font-medium">
          {title}
        </p>
        {meta}
      </div>
      {stages.length > 0 && (
        <ol aria-label="Generation stages" className="grid grid-cols-2 gap-x-3 gap-y-2 pt-2 text-left">
          {stages.map(({ label, status }) => {
            const complete = status === "completed";
            const current = status === "active";
            return (
              <li
                key={label}
                aria-current={current ? "step" : undefined}
                className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight"
              >
                <span
                  aria-hidden
                  className={[
                    "flex size-3 shrink-0 items-center justify-center rounded-full transition-colors duration-300 motion-reduce:transition-none",
                    complete
                      ? "bg-primary text-primary-foreground"
                      : current
                        ? "bg-primary/15 ring-2 ring-primary/30"
                        : "bg-muted-foreground/20",
                  ].join(" ")}
                >
                  <CheckIcon
                    className={`size-2 transition-[transform,opacity] duration-200 motion-reduce:transition-none ${
                      complete ? "scale-100 opacity-100" : "scale-0 opacity-0"
                    }`}
                  />
                </span>
                <span className={complete || current ? "text-foreground" : "text-muted-foreground"}>
                  <span className="sr-only">{status}: </span>
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {children}
    </section>
  );
}
