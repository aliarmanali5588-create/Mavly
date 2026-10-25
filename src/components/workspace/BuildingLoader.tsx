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
  const assemblyStage = activeStageIndex < 0 ? "idle" : String(activeStageIndex);

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

        <div
          className="preview-assembly"
          data-stage={assemblyStage}
          data-retrying={retrying || undefined}
          aria-hidden="true"
        >
          <div className="preview-canvas">
            <div className="preview-canvas-header preview-assembly-piece">
              <span className="preview-canvas-wordmark" />
              <span className="preview-canvas-navigation">
                <i />
                <i />
                <i />
              </span>
              <span className="preview-canvas-action" />
            </div>
            <div className="preview-canvas-hero">
              <div className="preview-canvas-copy">
                <span className="preview-canvas-kicker preview-assembly-piece" />
                <span className="preview-canvas-heading preview-assembly-piece" />
                <span className="preview-canvas-heading preview-canvas-heading-short preview-assembly-piece" />
                <span className="preview-canvas-description preview-assembly-piece" />
                <span className="preview-canvas-description preview-canvas-description-short preview-assembly-piece" />
                <span className="preview-canvas-button preview-assembly-piece" />
              </div>
              <div className="preview-canvas-image preview-assembly-piece">
                <span className="preview-canvas-image-outline" />
                <span className="preview-canvas-image-detail" />
              </div>
            </div>
            <div className="preview-canvas-rule" />
            <div className="preview-canvas-content">
              <span className="preview-canvas-section-title preview-assembly-piece" />
              <div className="preview-canvas-grid">
                <span className="preview-canvas-card preview-assembly-piece">
                  <i />
                  <b />
                  <em />
                  <em />
                </span>
                <span className="preview-canvas-card preview-assembly-piece">
                  <i />
                  <b />
                  <em />
                  <em />
                </span>
                <span className="preview-canvas-card preview-assembly-piece">
                  <i />
                  <b />
                  <em />
                  <em />
                </span>
              </div>
            </div>
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
