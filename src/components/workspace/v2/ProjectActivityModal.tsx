"use client";

import * as React from "react";
import { ChartColumnIcon, FileCode2Icon, RefreshCwIcon } from "lucide-react";
import { EmptyState, Modal, SpinnerBlock, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import {
    PROJECT_ACTIVITY_LIMIT,
    type ProjectActivity,
    type ProjectActivityOutcome,
    type ProjectActivityRange,
    type ProjectActivityRun,
} from "@/lib/project-activity";
import { vcaasApi } from "@/lib/vcaas";
import { Callout, Card, Segmented } from "./page-bits";

const RANGES: ProjectActivityRange[] = ["7d", "30d", "90d", "all"];

const TONE: Record<ProjectActivityOutcome, "neutral" | "info" | "success" | "danger"> = {
    completed: "success",
    failed: "danger",
    cancelled: "neutral",
    interrupted: "danger",
    active: "info",
    queued: "neutral",
};

/**
 * Real generation activity for one project. Mavly does not collect visitor analytics for a
 * static published site, so this panel reads the persisted `project_runs` rows instead of
 * inventing traffic numbers.
 */
export function ProjectActivityModal({
    open,
    onOpenChange,
    projectId,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectId: string;
}) {
    const t = useT();
    const [range, setRange] = React.useState<ProjectActivityRange>("30d");
    const [data, setData] = React.useState<ProjectActivity | "error" | undefined>(undefined);
    const [reload, setReload] = React.useState(0);

    React.useEffect(() => {
        if (!open) return;
        let live = true;
        setData(undefined);
        void vcaasApi.v2.projectActivity(projectId, range).then((response) => {
            if (!live) return;
            setData(response.ok && response.data ? response.data : "error");
        });
        return () => {
            live = false;
        };
    }, [open, projectId, range, reload]);

    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            size="xl"
            title={t("engineV2.activity.title")}
            description={t("engineV2.activity.intro")}
        >
            <div className="space-y-5" data-testid="project-activity">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-muted-foreground text-xs">{t("engineV2.activity.visitorsNote")}</p>
                    <Segmented<ProjectActivityRange>
                        label={t("engineV2.activity.rangeLabel")}
                        value={range}
                        onChange={setRange}
                        options={RANGES.map((value) => ({
                            value,
                            label: t(`engineV2.activity.range_${value}`),
                        }))}
                    />
                </div>

                {data === undefined ? (
                    <SpinnerBlock />
                ) : data === "error" ? (
                    <Callout tone="warning" title={t("engineV2.activity.unavailable")}>
                        <Button size="sm" variant="outline" className="mt-1" onClick={() => setReload((n) => n + 1)}>
                            <RefreshCwIcon aria-hidden /> {t("engineV2.activity.retry")}
                        </Button>
                    </Callout>
                ) : data.totals.runs === 0 ? (
                    <EmptyState
                        icon={<ChartColumnIcon />}
                        title={t("engineV2.activity.emptyTitle")}
                        description={t("engineV2.activity.emptyBody")}
                    />
                ) : (
                    <>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <Stat label={t("engineV2.activity.runs")} value={data.totals.runs} />
                            <Stat label={t("engineV2.activity.completed")} value={data.totals.completed} />
                            <Stat label={t("engineV2.activity.failed")} value={data.totals.failed} />
                            <Stat label={t("engineV2.activity.files")} value={data.totals.filesWritten} />
                        </div>
                        <DailyRuns days={data.days} title={t("engineV2.activity.chart")} />
                        <div className="space-y-2">
                            <h3 className="text-sm font-medium">{t("engineV2.activity.recent")}</h3>
                            <ul className="space-y-1.5">
                                {data.recent.map((run) => (
                                    <RunRow key={run.id} run={run} />
                                ))}
                            </ul>
                        </div>
                        {data.truncated ? (
                            <p className="text-muted-foreground text-xs">
                                {t("engineV2.activity.truncated", { count: PROJECT_ACTIVITY_LIMIT })}
                            </p>
                        ) : null}
                    </>
                )}
            </div>
        </Modal>
    );
}

function Stat({ label, value }: { label: string; value: number }) {
    return (
        <Card className="space-y-1">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
            <p className="font-display text-3xl font-semibold tabular-nums">{value.toLocaleString()}</p>
        </Card>
    );
}

function DailyRuns({ days, title }: { days: ProjectActivity["days"]; title: string }) {
    const max = Math.max(1, ...days.map((day) => day.runs));
    return (
        <Card title={title} icon={<ChartColumnIcon />}>
            <div className="flex h-36 items-end gap-1" role="img" aria-label={title}>
                {days.map((day) => (
                    <div key={day.date} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
                        <div
                            className="bg-primary/70 w-full rounded-t"
                            style={{ height: `${Math.max(4, (day.runs / max) * 100)}%` }}
                            title={`${day.date}: ${day.runs}`}
                        />
                    </div>
                ))}
            </div>
            <div className="text-muted-foreground mt-2 flex justify-between text-[11px]">
                <span>{days[0]?.date}</span>
                <span>{days[days.length - 1]?.date}</span>
            </div>
        </Card>
    );
}

function RunRow({ run }: { run: ProjectActivityRun }) {
    const t = useT();
    const label =
        run.outcome === "completed"
            ? t("engineV2.activity.completed")
            : run.outcome === "failed"
              ? t("engineV2.activity.failed")
              : run.outcome === "active"
                ? t("engineV2.activity.active")
                : run.outcome === "queued"
                  ? t("engineV2.activity.queued")
                  : run.outcome === "cancelled"
                    ? t("engineV2.activity.cancelled")
                    : t("engineV2.activity.interrupted");
    return (
        <li className="border-border flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <StatusPill tone={TONE[run.outcome]}>{label}</StatusPill>
            <span className="text-muted-foreground text-xs">{new Date(run.startedAt).toLocaleString()}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{run.model || "—"}</span>
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <FileCode2Icon className="size-3.5" aria-hidden /> {run.filesWritten}
            </span>
            <span className="text-muted-foreground text-xs">
                {run.durationMs === null
                    ? t("engineV2.activity.inProgress")
                    : `${Math.max(1, Math.round(run.durationMs / 1000))}s`}
            </span>
            {run.errorCode ? <code className="text-destructive text-[11px]">{run.errorCode}</code> : null}
        </li>
    );
}
