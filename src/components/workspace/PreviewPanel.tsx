"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { Monitor, Archive, AlertTriangle } from "lucide-react";
import { BuildingLoader } from "@/components/workspace/BuildingLoader";
import type { RunStage } from "@/lib/run-progress";
import type { VcaasPreviewState } from "@/lib/vcaas-types";

interface PreviewPanelProps {
  previewUrl: string | null;
  onRefresh: () => void;
  loading?: boolean;
  mobilePreview?: boolean;
  iframePath?: string;
  cached?: boolean;
  /**
   * ═══⭐⭐ THE SAME-ORIGIN PREVIEW, AND WHY IT EXISTS ═══════════════════════
   *
   * ⚠️ THE VISUAL EDITOR CANNOT WORK ON A CROSS-ORIGIN FRAME. It selects elements,
   * reads computed styles and applies live text edits by SCRIPTING the previewed
   * document, and the browser forbids all of that across origins — no amount of
   * `sandbox` flags changes it. `/api/preview/{projectId}` re-serves the project
   * through this app, so the document becomes same-origin and scriptable.
   *
   * ⚠️ IT IS USED ONLY WHILE THE EDITOR IS OPEN. Normal viewing keeps the direct
   * URL: the proxy costs a round trip per asset and rewrites the HTML, and neither
   * is worth paying for a preview nobody is editing.
   */
  proxiedSrc?: string | null;
  /** The editor needs the element to `postMessage` to its injected agent. */
  frameRef?: RefObject<HTMLIFrameElement | null>;
  /** The run's stage in words (new engine), shown under the building loader. */
  buildStage?: RunStage | null;
  buildRetrying?: boolean;
  previewReady?: boolean;
  /** Why a source that exists cannot be previewed (for example, it needs a build). */
  emptyMessage?: string | null;
  /**
   * ⚠️ THE SERVER'S HONEST PREVIEW STATE. Readiness is a fact about saved
   * content plus the durable run, not about a URL being present. `stale` means a
   * usable older preview is shown while the newest generation is running or
   * after it failed.
   */
  previewState?: VcaasPreviewState | null;
  /** Manual recovery, only offered when the API can actually resume the run. */
  onResumeGeneration?: () => void;
  resumingGeneration?: boolean;
}

export function PreviewPanel({ previewUrl, onRefresh, loading, mobilePreview = false, iframePath = "/", cached = false, proxiedSrc, frameRef, buildStage, buildRetrying, previewReady, emptyMessage, previewState, onResumeGeneration, resumingGeneration = false }: PreviewPanelProps) {
  const [iframeLoading, setIframeLoading] = useState(true);
  const [canvasSessionActive, setCanvasSessionActive] = useState(
    () => Boolean(loading && !previewUrl),
  );
  const [canvasRevealing, setCanvasRevealing] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  /** ⚠️ The proxy wins when present — see `proxiedSrc`. */
  const base = (proxiedSrc || previewUrl || "").replace(/\/$/, "");
  const path = iframePath && iframePath !== "/"
    ? (iframePath.startsWith("/") ? iframePath : `/${iframePath}`)
    : "/";
  /**
   * ⚠️ THE ROOT KEEPS ITS TRAILING SLASH. Without it, a relative `style.css`
   * resolves to `/api/preview/style.css` instead of `/api/preview/{id}/style.css`.
   */
  const fullIframeUrl = base ? `${base}${path}` : null;

  useEffect(() => {
    if (fullIframeUrl) {
      setIframeLoading(true);
      setCanvasRevealing(false);
    }
  }, [fullIframeUrl]);

  useEffect(() => {
    if (loading && !previewUrl) setCanvasSessionActive(true);
    if (!loading && !fullIframeUrl) {
      setCanvasSessionActive(false);
      setCanvasRevealing(false);
    }
  }, [loading, previewUrl, fullIframeUrl]);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(!document.hidden);
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  const showCanvas =
    (canvasSessionActive || Boolean(loading && !previewUrl)) &&
    (loading || Boolean(fullIframeUrl));
  const canvasMotionActive = Boolean(loading && !previewReady && !previewUrl);
  /**
   * A saved preview can be shown while it is no longer the newest one. Saying so
   * is the difference between "this is your app" and "this may be an older
   * version" — and it never hides output that is still usable.
   */
  const showStalePreview = Boolean(previewUrl) && previewState?.status === "stale";
  const emptyTitle =
    previewState?.status === "unavailable"
      ? "Preview unavailable"
      : previewState?.status === "incomplete"
        ? "Preview incomplete"
        : "No preview yet";
  const emptyText =
    previewState?.reason ??
    emptyMessage ??
    "Send a prompt or import a static site with an index.html";

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {/* iframe - no URL bar here, it's in the header now */}
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden relative" style={{ background: "var(--neu-surface)" }}>
        {/* Cached snapshot indicator: shown when the dev server is not active and
            we're displaying the cachedDevelopmentUrl static snapshot */}
        {previewUrl && cached && (
          <div className={`absolute ${showStalePreview ? "top-12" : "top-2"} left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-700 text-[11px] font-medium px-2.5 py-1 rounded-full shadow-sm`}>
            <Archive className="w-3 h-3" />
            <span>Cached snapshot · server sleeping</span>
          </div>
        )}
        {showStalePreview && (
          <div
            role="status"
            className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex max-w-[92%] items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-800 text-[11px] font-medium px-2.5 py-1 rounded-full shadow-sm"
          >
            <AlertTriangle className="w-3 h-3 shrink-0" />
            <span className="truncate">
              {previewState?.reason ?? "This preview may be out of date."}
            </span>
            {previewState?.canResume && onResumeGeneration && (
              <button
                type="button"
                onClick={onResumeGeneration}
                disabled={resumingGeneration}
                className="ml-1 shrink-0 underline underline-offset-2 disabled:opacity-60"
              >
                {resumingGeneration ? "Resuming…" : "Resume"}
              </button>
            )}
          </div>
        )}
        {!previewUrl ? (
          showCanvas ? (
            <BuildingLoader
              stage={buildStage}
              retrying={buildRetrying}
              previewReady={previewReady}
              motionActive={canvasMotionActive}
              motionPaused={!pageVisible}
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-center px-8">
              <Monitor className="w-10 h-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium text-muted-foreground mb-1">{emptyTitle}</p>
              <p className="text-xs text-muted-foreground max-w-sm">{emptyText}</p>
              {previewState?.canResume && onResumeGeneration && (
                <button
                  type="button"
                  onClick={onResumeGeneration}
                  disabled={resumingGeneration}
                  className="mt-4 rounded-full border border-[var(--neu-line-strong)] px-3 py-1.5 text-xs font-medium text-foreground hover:bg-[var(--neu-sunken)] disabled:opacity-60"
                >
                  {resumingGeneration ? "Resuming…" : "Resume generation"}
                </button>
              )}
            </div>
          )
        ) : (
          <div className={`preview-panel-enter bg-card transition-all duration-300 relative ${
            mobilePreview ? "w-[375px] h-[667px] rounded-[2rem] border-[8px] border-white/10 overflow-hidden shadow-2xl" : "w-full h-full"
          }`}>
            <div className="absolute inset-0">
              <iframe
                /* ⚠️ REMOUNT WHEN THE ORIGIN CHANGES. Swapping the `src` between the direct
                   URL and the proxy without a new element leaves the old document (and its
                   injected agent, or lack of one) in place. */
                key={proxiedSrc ? "proxy" : "direct"}
                ref={frameRef}
                src={fullIframeUrl || undefined}
                className={`preview-frame-content h-full w-full border-0 transition-opacity duration-300 ${
                  iframeLoading ? "opacity-0" : "opacity-100"
                }`}
                title="Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                onLoad={() => {
                  setIframeLoading(false);
                  if (!canvasSessionActive) return;
                  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                    setCanvasSessionActive(false);
                    return;
                  }
                  setCanvasRevealing(true);
                }}
              />
              {!showCanvas && (
                <div
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  aria-hidden={!iframeLoading}
                  className={`preview-frame-loading absolute inset-0 z-10 flex items-center justify-center bg-card ${
                    iframeLoading ? "opacity-100" : "pointer-events-none opacity-0"
                  }`}
                >
                  <span className="preview-frame-loading-mark">
                    <Image
                      src="/logo/Mavly.png"
                      alt=""
                      width={30}
                      height={30}
                      className="h-full w-full object-contain"
                    />
                  </span>
                  <span className="sr-only">Loading website preview</span>
                </div>
              )}
              {showCanvas && (
                <div
                  className={`preview-canvas-reveal absolute inset-0 z-20 ${
                    canvasRevealing ? "preview-canvas-revealing" : ""
                  }`}
                  onTransitionEnd={(event) => {
                    if (event.target !== event.currentTarget || event.propertyName !== "opacity") return;
                    setCanvasSessionActive(false);
                    setCanvasRevealing(false);
                  }}
                >
                  <BuildingLoader
                    stage={buildStage}
                    retrying={buildRetrying}
                    previewReady={previewReady}
                    motionActive={canvasMotionActive}
                    motionPaused={!pageVisible}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
