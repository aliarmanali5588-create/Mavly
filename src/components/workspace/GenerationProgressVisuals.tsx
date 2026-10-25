"use client";

import { CheckIcon } from "lucide-react";
import {
  GENERATION_STAGE_LABELS,
  generationStepStatuses,
  stageText,
  type RunStage,
} from "@/lib/run-progress";

export function generationStatusText(
  stage: RunStage | null,
  retrying = false,
): string {
  if (retrying) return "Retrying a generation step";
  return stage ? stageText(stage) : "Waiting for generation status";
}

export function GenerationIndicator({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`generation-indicator relative inline-flex shrink-0 items-center justify-center ${className}`}
    >
      <span className="absolute inset-0 rounded-full border border-primary/15" />
      <span className="generation-indicator-orbit absolute inset-[3px] rounded-full border-2 border-primary/20 border-t-primary border-r-primary/50" />
      <span className="absolute inset-[10px] rounded-full bg-primary/15" />
      <span className="generation-indicator-core size-2 rounded-full bg-primary" />
    </span>
  );
}

export function GenerationStages({
  stage,
  previewReady = false,
  compact = false,
}: {
  stage: RunStage | null;
  previewReady?: boolean;
  compact?: boolean;
}) {
  const statuses = generationStepStatuses(stage, previewReady);

  return (
    <ol
      aria-label="Generation stages"
      className={`grid gap-x-3 gap-y-2 pt-1 text-left ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-5"}`}
    >
      {GENERATION_STAGE_LABELS.map((label, index) => {
        const status = statuses[index] ?? "pending";
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
              {complete && <CheckIcon className="size-2" />}
            </span>
            <span className={complete || current ? "text-foreground" : "text-muted-foreground"}>
              <span className="sr-only">{status}: </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
