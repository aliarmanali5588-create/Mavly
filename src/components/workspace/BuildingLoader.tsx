"use client";

import Image from "next/image";
import {
  generationStepStatuses,
  stageText,
  type RunStage,
} from "@/lib/run-progress";
import { PreviewGenerationTimeline } from "@/components/workspace/PreviewGenerationTimeline";

export function BuildingLoader({
  stage = null,
  retrying = false,
  previewReady = false,
}: {
  stage?: RunStage | null;
  retrying?: boolean;
  previewReady?: boolean;
}) {
  const currentLabel = retrying
    ? "Retrying a generation step"
    : stage
      ? stage === "done" && !previewReady
        ? "Waiting for the preview to be ready"
        : stageText(stage)
      : "Waiting for generation status";
  const stageStatuses = generationStepStatuses(stage, previewReady);
  const activeStageIndex = stageStatuses.indexOf("active");
  const completedStageCount = stageStatuses.filter((status) => status === "completed").length;
  const assemblyStage =
    activeStageIndex >= 0
      ? String(activeStageIndex)
      : completedStageCount > 0
        ? String(Math.min(completedStageCount - 1, 4))
        : "idle";

  return (
    <div
      data-testid="building-loader"
      aria-busy="true"
      className="preview-loader absolute inset-0 overflow-y-auto bg-background px-4 py-5 sm:px-6"
    >
      <div className="preview-loader-content">
        <div className="preview-loader-brand">
          <span className="preview-loader-mark">
            <Image
              src="/logo/Mavly.png"
              alt="Mavly"
              width={25}
              height={25}
              className="h-full w-full rounded object-contain"
            />
          </span>
          <span>MAVLY <i /> GENERATION</span>
        </div>

        <div className="preview-morph" data-stage={assemblyStage} aria-hidden="true">
          <span className="preview-morph-mark">
            <Image
              src="/logo/Mavly.png"
              alt=""
              width={38}
              height={38}
              className="h-full w-full rounded object-contain"
            />
          </span>
          <div className="preview-morph-layout">
            <span className="preview-morph-nav preview-morph-line" />
            <span className="preview-morph-nav-action preview-morph-outline" />
            <span className="preview-morph-heading preview-morph-line" />
            <span className="preview-morph-heading-short preview-morph-line" />
            <span className="preview-morph-copy preview-morph-line" />
            <span className="preview-morph-copy-short preview-morph-line" />
            <span className="preview-morph-image preview-morph-outline" />
            <span className="preview-morph-divider" />
            <span className="preview-morph-panel preview-morph-outline" />
            <span className="preview-morph-panel preview-morph-panel-middle preview-morph-outline" />
            <span className="preview-morph-panel preview-morph-panel-last preview-morph-outline" />
          </div>
        </div>

        <section className="preview-loader-progress" aria-label="Website generation progress">
          <div className="preview-loader-status">
            <span className="preview-loader-status-mark">
              <Image
                src="/logo/Mavly.png"
                alt="Mavly"
                width={30}
                height={30}
                className="h-full w-full rounded object-contain"
              />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Your website is taking shape</p>
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="mt-0.5 truncate text-xs text-muted-foreground"
              >
                {currentLabel}
              </p>
            </div>
          </div>
          <PreviewGenerationTimeline stage={stage} previewReady={previewReady} />
        </section>
      </div>
    </div>
  );
}
