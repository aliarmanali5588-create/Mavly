"use client";

import * as React from "react";
import { LoaderIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import {
    expectedRunProgress,
    formatDuration,
    RESTART_ESTIMATE_MINUTES,
    runProgress,
} from "@/lib/agent-progress";
import { cn } from "@/lib/utils";

/**
 * ═══ HOW LONG THIS RUN HAS BEEN GOING ═══════════════════════════════════════
 *
 * Under "The agent is working…", which until now was the whole of what the chat
 * said about a process that routinely takes twenty minutes. Three bouncing dots
 * answer "is it alive"; they do not answer "should I wait or go and do something
 * else", which is the question people actually have.
 *
 * ── WHAT IT IS ALLOWED TO CLAIM ─────────────────────────────────────────────
 *
 * ⚠️ THE ESTIMATE IS LABELLED AS AN ESTIMATE, IN THE UI, IN WORDS. The agent
 * reports `init` / `done` and nothing else — there is no real percentage to show
 * — so the label quotes a whole realistic window, "4 to 10 minutes". Dressing that
 * up as a measured percentage would be the same lie the first-build loader
 * deliberately refuses to tell.
 *
 * ⚠️⚠️ AND THE WINDOW EXTENDS ITSELF WHEN A RUN OUTLIVES IT — see
 * `RUN_ESTIMATE_LADDER`. Both numbers in the label come from the SAME call that
 * drives the bar, so the two can never quote different durations.
 *
 * ⚠️⚠️ BOTH NUMBERS ARE READ FROM `@/lib/agent-progress`, NEVER TYPED INTO THE
 * COPY. They are the same constants the first-build loader weights its phase table
 * against (`STAGE_WEIGHTS`), so the two screens cannot drift into quoting different
 * durations for the same run — which is exactly what happened when this said 25.
 *
 * ⚠️ IT STOPS SHORT OF THE END AND THEN CHANGES ITS COPY. At the estimate the fill
 * holds at 97 % and the label becomes "Longer than usual" — see `PROGRESS_CEILING`.
 * A bar sitting full while the run continues is what makes people reload mid-run.
 *
 * ── SIZE ────────────────────────────────────────────────────────────────────
 *
 * ⚠️ ONE LINE OF TEXT AND A 3 PX TRACK. This sits above the composer in a panel
 * that is 320 px wide on a laptop, under a conversation the user is reading. It is
 * a status line, not a dashboard: no card, no border, no icon of its own.
 */
export function RunProgress({
    elapsedMs,
    expectedMinutes,
    className,
}: {
    elapsedMs: number;
    /** The engine's estimate for this run; the bar fills against it when present. */
    expectedMinutes?: number | null;
    className?: string;
}) {
    const t = useT();
    const { ratio, percent, overrun, estimateMs, previousEstimateMs } = expectedMinutes
        ? expectedRunProgress(elapsedMs, expectedMinutes * 60_000)
        : runProgress(elapsedMs);
    /**
     * ⭐ BOTH NUMBERS MOVE NOW. While the run is inside the original window this reads
     * "4 to 10 minutes", exactly as before; once the run outlives it the range walks up
     * the ladder — "10 to 12", then "12 to 15" — so the line beside the clock keeps
     * saying something true instead of freezing on a figure the run has already passed.
     */
    const estimateMinutes = Math.round(estimateMs / 60_000);
    const estimateFloorMinutes = Math.round(previousEstimateMs / 60_000);

    return (
        <div className={cn("mt-1.5 space-y-1", className)}>
            <div className="flex items-baseline justify-between gap-2">
                <p data-tabular className="text-muted-foreground text-2xs">
                    {/* The elapsed time is a FACT; the estimate beside it is a RANGE,
                        and never a deadline. A single "~25 min" read as a promise —
                        and was wrong besides. See `RUN_ESTIMATE_MIN_MS`. */}
                    <span className="text-foreground font-medium">{formatDuration(elapsedMs)}</span>
                    <span className="mx-1">/</span>
                    <span>
                        {t("workspace.chat.progressEstimate", {
                            from: estimateFloorMinutes,
                            minutes: estimateMinutes,
                        })}
                    </span>
                </p>

                <p
                    data-tabular
                    className={cn(
                        "text-2xs shrink-0",
                        overrun ? "text-warning-subtle-foreground font-medium" : "text-muted-foreground"
                    )}
                >
                    {overrun ? t("workspace.chat.progressOverrun") : `${percent}%`}
                </p>
            </div>

            <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                /* ⚠️ Past the estimate there is no meaningful value to announce, so
                   the bar becomes indeterminate to a screen reader rather than
                   repeating "97 per cent" every few seconds for ten minutes. */
                aria-valuenow={overrun ? undefined : percent}
                aria-label={t("workspace.chat.progressLabel")}
                className="bg-border/70 h-[3px] overflow-hidden rounded-full"
            >
                <div
                    className={cn(
                        "relative h-full rounded-full transition-[width] duration-1000 ease-linear",
                        overrun ? "bg-warning" : "bg-primary"
                    )}
                    style={{ width: `${Math.max(2, ratio * 100)}%` }}
                >
                    {/*
                      ⭐ THE HEAD OF THE BAR BREATHES, so a bar that gains 0.07 % a
                      second still reads as moving. `tp-run-shine` lives in
                      globals.css and only exists inside `no-preference`.
                    */}
                    <span aria-hidden className="tp-run-shine" />
                </div>
            </div>
        </div>
    );
}

/**
 * ═══⭐ "THE AGENT LOOKS STUCK" ══════════════════════════════════════════════
 *
 * Shown only when `looksStuck` says so: a run past fifteen minutes that has
 * produced almost no build steps. See that function for why BOTH conditions are
 * required — a long, chatty run is a big job, not a broken one, and offering to
 * throw it away would be the more expensive mistake.
 *
 * ⚠️ IT NAMES THE COST BEFORE THE BUTTON IS PRESSED. Restarting the agent server
 * takes about three minutes during which nothing can be prompted, and a warning
 * that hides that is how you get a second, angrier click.
 *
 * ⚠️ ONE BUTTON, AND IT DOES BOTH HALVES. "Stop the run" and "restart the server"
 * as two controls invites doing one of them: stopping without restarting leaves
 * the broken server in place, and restarting without stopping leaves a dead run
 * marked in flight. The handler does them in that order.
 */
export function AgentStuckNotice({
    onStopAndRestart,
    className,
}: {
    onStopAndRestart: () => Promise<void> | void;
    className?: string;
}) {
    const t = useT();
    const [busy, setBusy] = React.useState(false);
    const mounted = React.useRef(true);

    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    async function handleClick() {
        if (busy) return;
        setBusy(true);
        try {
            await onStopAndRestart();
        } finally {
            /* ⚠️ The button does NOT re-enable on success. The restart is watched
               by the workspace and takes minutes; an enabled button would invite a
               second restart on top of the first. Only a failure gives it back. */
            if (mounted.current) setBusy(false);
        }
    }

    return (
        <div
            role="status"
            className={cn(
                "border-warning/40 bg-warning-subtle text-warning-subtle-foreground mt-2 rounded-lg border p-2.5",
                className
            )}
        >
            <div className="flex items-start gap-2">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className="text-xs leading-snug font-medium">
                        {t("workspace.chat.stuckTitle")}
                    </p>
                    <p className="mt-0.5 text-xs leading-snug opacity-80">
                        {t("workspace.chat.stuckBody", { minutes: RESTART_ESTIMATE_MINUTES })}
                    </p>

                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void handleClick()}
                        className="border-warning/50 bg-card/70 hover:bg-card mt-2 h-7 w-full gap-1.5 text-xs"
                    >
                        {busy ? (
                            <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                        ) : (
                            <RotateCcwIcon className="size-3.5" aria-hidden />
                        )}
                        {busy ? t("workspace.chat.stuckWorking") : t("workspace.chat.stuckAction")}
                    </Button>
                </div>
            </div>
        </div>
    );
}
