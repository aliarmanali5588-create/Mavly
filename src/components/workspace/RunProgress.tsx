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

/** Shows elapsed time and a clearly labeled estimate; generation has no measured percentage. */
export function RunProgress({
    elapsedMs,
    expectedMinutes,
    showEstimate = true,
    className,
}: {
    elapsedMs: number;
    /** The engine's estimated duration, when available. */
    expectedMinutes?: number | null;
    /** Hide inferred duration copy when this workspace has no estimate from the engine. */
    showEstimate?: boolean;
    className?: string;
}) {
    const t = useT();
    const progress = typeof expectedMinutes === "number" && expectedMinutes > 0
        ? expectedRunProgress(elapsedMs, expectedMinutes * 60_000)
        : showEstimate
            ? runProgress(elapsedMs)
            : null;

    return (
        <div className={cn("mt-1.5 space-y-1", className)}>
            {progress && (
                <div className="flex items-baseline justify-between gap-2">
                    <p data-tabular className="text-muted-foreground text-2xs">
                        <span className="text-foreground font-medium">{formatDuration(elapsedMs)}</span>
                        <span className="mx-1">/</span>
                        <span>
                            {t("workspace.chat.progressEstimate", {
                                from: Math.round(progress.previousEstimateMs / 60_000),
                                minutes: Math.round(progress.estimateMs / 60_000),
                            })}
                        </span>
                    </p>

                    {progress.overrun && (
                        <p data-tabular className="text-2xs shrink-0 font-medium text-warning-subtle-foreground">
                            {t("workspace.chat.progressOverrun")}
                        </p>
                    )}
                </div>
            )}

            <div
                role="progressbar"
                aria-label={t("workspace.chat.progressLabel")}
                aria-valuetext={t("workspace.chat.progressLabel")}
                className="bg-border/70 h-[3px] overflow-hidden rounded-full"
            >
                <div aria-hidden className={cn(
                    "run-progress-indeterminate h-full rounded-full",
                    progress?.overrun ? "bg-warning" : "bg-primary",
                )} />
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
