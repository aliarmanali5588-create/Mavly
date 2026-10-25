"use client";

import { stageText, type RunStage } from "@/lib/run-progress";
import { PreviewGenerationTimeline } from "@/components/workspace/PreviewGenerationTimeline";

/**
 * Compact preview-only loading state. Stage data is projected from the durable run
 * lifecycle; the chat uses its separate RunActivity presentation.
 */
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

  return (
    <div
      data-testid="building-loader"
      aria-busy="true"
      className="preview-loader absolute inset-0 overflow-y-auto bg-background px-4 py-5 sm:px-6"
    >
      <div className="preview-loader-glow" aria-hidden />
      <div className="preview-loader-content">
        <div className="preview-loader-browser" aria-hidden>
          <div className="preview-loader-browser-chrome">
            <span className="preview-loader-dot" />
            <span className="preview-loader-dot" />
            <span className="preview-loader-dot" />
            <span className="preview-loader-address preview-skeleton-shimmer" />
          </div>
          <div className="preview-loader-browser-body">
            <span className="preview-skeleton-shimmer preview-loader-line preview-loader-line-title" />
            <span className="preview-skeleton-shimmer preview-loader-line preview-loader-line-wide" />
            <span className="preview-skeleton-shimmer preview-loader-line preview-loader-line-short" />
            <div className="preview-loader-cards">
              <span className="preview-skeleton-shimmer preview-loader-card" />
              <span className="preview-skeleton-shimmer preview-loader-card" />
            </div>
            <span className="preview-skeleton-shimmer preview-loader-button" />
          </div>
        </div>

        <section className="preview-loader-progress" aria-label="Website generation progress">
          <div className="preview-loader-status">
            <span className="preview-loader-ring" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Building your app</p>
              <p role="status" aria-live="polite" aria-atomic="true" className="mt-0.5 truncate text-xs text-muted-foreground">
                {currentLabel}
              </p>
            </div>
          </div>
          <div
            role="progressbar"
            aria-label="Website generation"
            aria-valuetext={currentLabel}
            className="preview-loader-track"
          >
            <span className="preview-loader-track-indicator" aria-hidden />
          </div>
          <PreviewGenerationTimeline stage={stage} previewReady={previewReady} />
        </section>
      </div>
    </div>
  );
}
