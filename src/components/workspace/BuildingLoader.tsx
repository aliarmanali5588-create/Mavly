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
          <div className="preview-assembly-browser">
            <div className="preview-assembly-chrome">
              <span className="preview-assembly-window-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="preview-assembly-address">
                <span />
              </span>
              <span className="preview-assembly-menu">
                <i />
                <i />
              </span>
            </div>
            <div className="preview-assembly-page">
              <div className="preview-assembly-nav preview-assembly-piece">
                <span className="preview-assembly-nav-brand" />
                <span className="preview-assembly-nav-links">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="preview-assembly-nav-action" />
              </div>
              <div className="preview-assembly-hero">
                <div className="preview-assembly-hero-copy">
                  <span className="preview-assembly-eyebrow preview-assembly-piece" />
                  <span className="preview-assembly-title preview-assembly-piece" />
                  <span className="preview-assembly-title preview-assembly-title-short preview-assembly-piece" />
                  <span className="preview-assembly-copy-line preview-assembly-piece" />
                  <span className="preview-assembly-copy-line preview-assembly-copy-short preview-assembly-piece" />
                  <span className="preview-assembly-cta preview-assembly-piece" />
                </div>
                <div className="preview-assembly-art preview-assembly-piece">
                  <span className="preview-assembly-art-orbit" />
                  <span className="preview-assembly-art-card preview-assembly-art-card-back" />
                  <span className="preview-assembly-art-card preview-assembly-art-card-front">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="preview-assembly-art-spark preview-assembly-art-spark-one" />
                  <span className="preview-assembly-art-spark preview-assembly-art-spark-two" />
                </div>
              </div>
              <div className="preview-assembly-cards">
                <span className="preview-assembly-card preview-assembly-piece">
                  <i />
                  <b />
                  <em />
                  <em />
                </span>
                <span className="preview-assembly-card preview-assembly-piece">
                  <i />
                  <b />
                  <em />
                  <em />
                </span>
                <span className="preview-assembly-card preview-assembly-piece">
                  <i />
                  <b />
                  <em />
                  <em />
                </span>
              </div>
            </div>
            <span className="preview-assembly-light" />
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
