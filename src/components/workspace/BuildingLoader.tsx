"use client";

import {
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

  return (
    <div
      data-testid="building-loader"
      aria-busy="true"
      className="preview-loader absolute inset-0 overflow-y-auto bg-background px-4 py-5 sm:px-6"
    >
      <div className="preview-loader-content">
        <p className="preview-loader-eyebrow">THE LIVING CANVAS</p>

        <div className="living-canvas" aria-hidden="true">
          <div className="living-browser">
            <div className="living-browser-chrome">
              <span className="living-browser-dots"><i /><i /><i /></span>
              <span className="living-browser-address" />
              <span className="living-browser-control" />
            </div>
            <div className="living-site">
              <nav className="living-nav">
                <span className="living-brand-mark" />
                <span className="living-brand-name" />
                <span className="living-nav-links"><i /><i /><i /></span>
                <span className="living-nav-action" />
              </nav>
              <section className="living-hero">
                <div className="living-hero-copy">
                  <span className="living-eyebrow" />
                  <span className="living-heading"><i /><i /></span>
                  <span className="living-supporting"><i /><i /></span>
                  <span className="living-cta" />
                </div>
                <div className="living-artwork">
                  <span className="living-artwork-sun" />
                  <span className="living-artwork-hill living-artwork-hill-back" />
                  <span className="living-artwork-hill living-artwork-hill-front" />
                  <span className="living-artwork-card" />
                </div>
              </section>
              <div className="living-cards">
                <div className="living-card"><i /><span /><b /></div>
                <div className="living-card"><i /><span /><b /></div>
                <div className="living-card"><i /><span /><b /></div>
              </div>
            </div>
          </div>
        </div>

        <section className="preview-loader-progress" aria-label="Website generation progress">
          <div className="preview-loader-status">
            <span className="preview-loader-status-mark" aria-hidden="true">
              <span />
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
