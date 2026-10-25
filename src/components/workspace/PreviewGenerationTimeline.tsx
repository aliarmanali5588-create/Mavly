"use client";

import { CheckIcon } from "lucide-react";
import {
  GENERATION_STAGE_LABELS,
  generationStepStatuses,
  type RunStage,
} from "@/lib/run-progress";

export function PreviewGenerationTimeline({
  stage,
  previewReady = false,
}: {
  stage: RunStage | null;
  previewReady?: boolean;
}) {
  const statuses = generationStepStatuses(stage, previewReady);
  if (previewReady && stage === "preparing-preview") {
    statuses[statuses.length - 1] = "completed";
  }

  return (
    <ol aria-label="Generation stages" className="preview-loader-timeline">
      {GENERATION_STAGE_LABELS.map((label, index) => {
        const status = statuses[index] ?? "pending";
        const complete = status === "completed";
        const active = status === "active";

        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className={`preview-loader-step preview-loader-step-${status}`}
          >
            <span className="preview-loader-step-marker" aria-hidden>
              {complete ? <CheckIcon className="size-3" strokeWidth={2.25} /> : null}
            </span>
            <span className="preview-loader-step-label">
              <span className="sr-only">{status}: </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
