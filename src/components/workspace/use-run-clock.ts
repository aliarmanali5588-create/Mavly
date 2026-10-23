"use client";

import * as React from "react";
import {
    clearRunStart,
    readRunStart,
    resolveRunStart,
    writeRunStart,
} from "@/lib/agent-progress";

/**
 * ═══ THE RUN CLOCK ══════════════════════════════════════════════════════════
 *
 * One second of state for the whole chat: when the current run started, and how
 * long ago that was. The rules it exists to enforce live in `@/lib/agent-progress`
 * — read `resolveRunStart` before changing anything here.
 *
 * ⚠️ IT SURVIVES A RELOAD, WHICH IS THE ENTIRE POINT. The workspace used to keep a
 * SECOND run clock (`runElapsedMs` in `WorkspaceShell`, feeding the first-build
 * loader) that restarted from zero on every reload, because it stamped `Date.now()`
 * when `isRunning` flips — and `isRunning` flips on every fresh load of a project
 * whose run is already going. Reloading four minutes into a first build put the
 * user back on "Step 1 of 4". That clock is gone: the shell calls this hook too, so
 * there is one answer to "how long has this run been going" and it prefers the
 * server's own `startedAt`, with a local stamp only as a fallback.
 *
 * ⚠️ THE STREAM CAN CORRECT US LATER, AND MUST BE ALLOWED TO. On a fresh load the
 * conversation arrives a moment after `isRunning` is already true, so the first
 * resolution is the persisted stamp (or `now`) and the authoritative timestamp
 * turns up a beat afterwards. Whenever the stream reports an EARLIER start than
 * the one in hand, it wins — later is never right, since a run cannot have begun
 * after its own first message.
 */
export interface RunClock {
    /** Epoch ms, or `null` when nothing is running. */
    startedAt: number | null;
    /** Ms since `startedAt`, ticking once a second. `0` when idle. */
    elapsedMs: number;
}

export function useRunClock({
    projectId,
    isRunning,
    startedAtFromStream,
}: {
    projectId: string;
    isRunning: boolean;
    /** `createdAt` of the in-flight run's `starting` message, in epoch ms. */
    startedAtFromStream: number | null;
}): RunClock {
    const [startedAt, setStartedAt] = React.useState<number | null>(null);
    const [elapsedMs, setElapsedMs] = React.useState(0);

    /**
     * ⚠️ A RUN THAT ENDS MUST FORGET ITS STAMP. Leaving it behind means the next
     * time this project is opened — possibly days later — the clock resolves to a
     * start time from the last run. `resolveRunStart` also rejects anything older
     * than six hours, but two guards on a value that decides whether we accuse the
     * agent of being stuck is the right number of guards.
     */
    React.useEffect(() => {
        if (isRunning) return;
        setStartedAt(null);
        setElapsedMs(0);
        clearRunStart(projectId);
    }, [isRunning, projectId]);

    React.useEffect(() => {
        if (!isRunning) return;

        const now = Date.now();
        const resolved = resolveRunStart({
            fromStream: startedAtFromStream,
            persisted: readRunStart(projectId),
            now,
        });

        setStartedAt(current => {
            // Earlier wins — see the header note on late-arriving stream data.
            const next = current === null ? resolved : Math.min(current, resolved);
            writeRunStart(projectId, next);
            return next;
        });
    }, [isRunning, projectId, startedAtFromStream]);

    /**
     * The tick. Separate from the resolution above so a late correction from the
     * stream does not restart the interval, and so the interval's identity does
     * not depend on a value that changes every second.
     */
    React.useEffect(() => {
        if (!isRunning || startedAt === null) return;

        setElapsedMs(Date.now() - startedAt);
        const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
        return () => clearInterval(timer);
    }, [isRunning, startedAt]);

    return { startedAt, elapsedMs };
}
