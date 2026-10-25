/**
 * Generation activity for one project. This is real Mavly data (`project_runs`), not visitor
 * analytics: the published static site is served by the hosting provider, so Mavly has no
 * request log to count visits from.
 */

export type ProjectActivityRange = "7d" | "30d" | "90d" | "all";

export type ProjectActivityOutcome =
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "active"
    | "queued";

export interface ProjectActivityDay {
    date: string;
    runs: number;
    completed: number;
    failed: number;
    filesWritten: number;
    tokens: number;
}

export interface ProjectActivityRun {
    id: string;
    outcome: ProjectActivityOutcome;
    stage: string;
    model: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    filesWritten: number;
    totalTokens: number | null;
    errorCode: string | null;
}

export interface ProjectActivity {
    range: {
        key: ProjectActivityRange;
        from: string | null;
        to: string;
    };
    totals: {
        runs: number;
        completed: number;
        failed: number;
        active: number;
        filesWritten: number;
        tokens: number;
    };
    days: ProjectActivityDay[];
    recent: ProjectActivityRun[];
    /** True when the query hit the run limit, so older runs are not aggregated. */
    truncated: boolean;
}

const RANGE_DAYS: Record<Exclude<ProjectActivityRange, "all">, number> = {
    "7d": 7,
    "30d": 30,
    "90d": 90,
};

export const PROJECT_ACTIVITY_LIMIT = 500;

export function projectActivityRangeOf(
    key: ProjectActivityRange,
    now = Date.now(),
): { key: ProjectActivityRange; from: string | null; to: string } {
    const to = new Date(now).toISOString();
    if (key === "all") return { key, from: null, to };
    return { key, from: new Date(now - RANGE_DAYS[key] * 86_400_000).toISOString(), to };
}
