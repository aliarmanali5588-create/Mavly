"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeftIcon, LoaderIcon } from "lucide-react";

import { useT } from "@/i18n";
import { runProgress } from "@/lib/agent-progress";

/**
 * ═══ THE IMPORT OVERLAY — a clone or import is landing on this project ═════════
 *
 * A clone or import replaces EVERYTHING underneath: code, data, the running server.
 * There is nothing to work with until it lands, so this covers the workspace for the
 * length of the wait. It renders whenever the operation slot says `import`, which the
 * transfer dialogs stamp before navigating here. A backend lock can restore the stamp
 * after reload; the current Mavly route instead exposes static preview readiness.
 *
 * ⚠️ DELIBERATELY NOT THE PLATFORM'S FIRST-BUILD SCREEN. That one is a four-stage
 * narrative with a 3-D scene and a "Did you know…" tour, written for someone seeing
 * the product for the first time. A clone is the user's OWN project coming back; the
 * only thing they want from this screen is to know it is still going and roughly how
 * long is left. So: one title, one linear bar, one clock, centred.
 *
 * ⚠️ THE BAR IS AN ESTIMATE AND NEVER CLAIMS TO BE DONE. It fills over
 * `IMPORT_ESTIMATE_MS` and stops at the ceiling `runProgress` applies (97 %); the page's
 * watcher — not this component — decides when the import has actually landed and
 * clears the slot. An overrun changes the copy under the bar rather than freezing a
 * full bar on a screen that is still waiting.
 */

/** How long a clone or import usually takes end to end. */
const IMPORT_ESTIMATE_MS = 5 * 60_000;

export interface ImportOverlayProps {
    /** The slot's clock — the server's `startedAt` once adopted, so tabs agree. */
    elapsedMs: number;
    projectId: string;
}

function formatElapsed(elapsedMs: number): string {
    const total = Math.max(0, Math.floor(elapsedMs / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function ImportOverlay({ elapsedMs, projectId }: ImportOverlayProps) {
    const t = useT();
    const progress = runProgress(elapsedMs, IMPORT_ESTIMATE_MS);

    /**
     * ⚠️ THE PAGE UNDERNEATH MUST NOT SCROLL. The overlay is `fixed`, so without
     * this a touch drag scrolls the workspace behind it — which is both confusing
     * and a way to reach controls that are supposed to be unavailable.
     */
    React.useEffect(() => {
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = previous;
        };
    }, []);

    return (
        <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Importing the project"
            aria-busy="true"
            /**
             * ⚠️ ABOVE THE MODALS, NOT BESIDE THEM. A dialog left open when the
             * import started (versions, GitHub…) would otherwise sit on top of this
             * and offer actions the server is refusing.
             */
            className="bg-[var(--clay-base)] fixed inset-0 z-[100] flex items-center justify-center p-6"
        >
            {/*
              ⭐ THE WAY OUT, AT THE TOP. It navigates, it does not cancel — the import
              keeps running and this screen is here again when they come back.
            */}
            <Link
                href="/dashboard"
                className="text-muted-foreground hover:text-foreground bg-card border-[var(--clay-line)] absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-[var(--clay-elev-1)] transition-colors focus-visible:outline-none sm:top-4 sm:left-4"
            >
                <ArrowLeftIcon aria-hidden className="size-3.5" />
                {t("workspace.importRun.backToProjects")}
            </Link>

            <div className="bg-card border-[var(--clay-line)] w-full max-w-md rounded-[var(--clay-r-2xl)] border p-8 text-center shadow-[var(--clay-float)]">
                <LoaderIcon aria-hidden className="text-primary mx-auto size-8 animate-spin" />

                <h1 className="font-display mt-5 text-lg font-semibold">Importing the project</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    <span className="font-mono">{projectId}</span>
                </p>

                {/* ── One linear bar, filled against the five-minute estimate ── */}
                <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.percent}
                    className="bg-muted-foreground/15 mt-6 h-2 w-full overflow-hidden rounded-full"
                >
                    <div
                        className="bg-primary h-full rounded-full transition-[width] duration-1000 ease-linear"
                        style={{ width: `${progress.percent}%` }}
                    />
                </div>

                <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs tabular-nums">
                    <span>{progress.overrun ? "Taking a little longer than usual…" : "Usually about 5 minutes"}</span>
                    <span>{t("workspace.firstRun.elapsed", { time: formatElapsed(elapsedMs) })}</span>
                </div>

                <p className="text-muted-foreground mt-5 text-xs text-pretty">
                    {t("workspace.importRun.subtitle")}
                </p>
            </div>
        </div>
    );
}
