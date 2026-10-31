"use client";

import React from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  RefreshCw,
  Sparkles,
  Users,
} from "lucide-react";

import { percentChange } from "@/lib/admin/overview";
import type { AdminOverviewPayload } from "@/lib/admin/types";

const ICON_MAP = {
  users: Users,
  revenue: Banknote,
  generations: Sparkles,
  rate: Activity,
} as const;

const numberFormat = new Intl.NumberFormat("en-IN");

interface KpiCardsProps {
  data: AdminOverviewPayload | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  periodLabel: string;
}

interface CardModel {
  id: keyof typeof ICON_MAP;
  title: string;
  value: string;
  context: string;
  delta: number | null;
  deltaSuffix: string;
  muted?: boolean;
}

export function KpiCards({ data, loading, error, onRetry, periodLabel }: KpiCardsProps) {
  if (loading && !data) return <KpiSkeletons />;

  if (error && !data) {
    return (
      <div className="bg-card rounded-2xl p-5 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-foreground">Overview metrics are unavailable</p>
          <p className="text-xs text-muted-foreground mt-1">{error}</p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-black/[0.1] text-xs font-semibold text-foreground hover:bg-[var(--clay-sunken)]"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Try again</span>
        </button>
      </div>
    );
  }

  if (!data) return <KpiSkeletons />;

  const rate = data.runs.successRate;
  const previousRate = data.runs.previousSuccessRate;
  const rateDelta =
    rate !== null && previousRate !== null ? Math.round((rate - previousRate) * 10) / 10 : null;

  const cards: CardModel[] = [
    {
      id: "users",
      title: "Total Users",
      value: numberFormat.format(data.users.total),
      context: `${numberFormat.format(data.users.new)} registered in ${periodLabel} · all-time accounts`,
      delta: percentChange(data.users.new, data.users.previousNew),
      deltaSuffix: "vs previous period",
    },
    {
      id: "revenue",
      title: "Monthly Revenue",
      value: "—",
      context: "No Mavly billing source is configured",
      delta: null,
      deltaSuffix: "",
      muted: true,
    },
    {
      id: "generations",
      title: "Successful Generations",
      value: numberFormat.format(data.runs.completed),
      context: `${numberFormat.format(data.runs.total)} runs started in ${periodLabel}`,
      delta: percentChange(data.runs.completed, data.runs.previousCompleted),
      deltaSuffix: "vs previous period",
    },
    {
      id: "rate",
      title: "Generation Success Rate",
      value: rate === null ? "—" : `${rate.toFixed(1)}%`,
      context:
        rate === null
          ? "No terminal runs in this period"
          : `${numberFormat.format(data.runs.completed)} completed · ${numberFormat.format(
              data.runs.failed + data.runs.cancelled + data.runs.interrupted
            )} failed, cancelled or interrupted`,
      delta: rateDelta,
      deltaSuffix: "points vs previous period",
    },
  ];

  return (
    <div className="space-y-3">
      {error ? (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
          <span>Showing the last successful refresh. {error}</span>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 font-semibold hover:underline self-start sm:self-auto"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = ICON_MAP[card.id];
        const positive = card.delta !== null && card.delta > 0;
        const negative = card.delta !== null && card.delta < 0;

        return (
          <div
            key={card.id}
            className="group relative bg-card rounded-2xl p-5 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] hover:shadow-[var(--clay-elev-3)] hover:border-black/20 transition-all duration-200 overflow-hidden flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground tracking-wide">{card.title}</span>
                <div className="p-2 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground group-hover:bg-black group-hover:text-white transition-colors duration-200 shrink-0">
                  <Icon className="w-4 h-4" />
                </div>
              </div>

              <div className="mt-2 flex items-baseline justify-between">
                <h3
                  className={`text-2xl sm:text-3xl font-extrabold tracking-tight font-sans tabular-nums ${
                    card.muted ? "text-muted-foreground" : "text-foreground"
                  }`}
                >
                  {card.value}
                </h3>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-[var(--clay-line)] flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                {card.delta !== null ? (
                  <span
                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-bold border font-mono ${
                      positive
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200/60"
                        : negative
                          ? "bg-rose-50 text-rose-700 border-rose-200/60"
                          : "bg-[var(--clay-sunken)] text-muted-foreground border-[var(--clay-line)]"
                    }`}
                  >
                    {positive ? (
                      <ArrowUpRight className="w-3 h-3" />
                    ) : negative ? (
                      <ArrowDownRight className="w-3 h-3" />
                    ) : null}
                    <span>
                      {card.delta > 0 ? "+" : ""}
                      {card.delta}
                      {card.id === "rate" ? " pts" : "%"}
                    </span>
                  </span>
                ) : (
                  <span className="text-[11px] font-bold font-mono text-muted-foreground">No comparable period</span>
                )}
                {card.deltaSuffix ? (
                  <span className="text-[11px] text-muted-foreground font-medium">{card.deltaSuffix}</span>
                ) : null}
              </div>
              <p className="text-[11px] text-muted-foreground font-medium">{card.context}</p>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

function KpiSkeletons() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="bg-card rounded-2xl p-5 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] animate-pulse"
        >
          <div className="flex items-center justify-between">
            <div className="h-3 w-24 rounded bg-[var(--clay-sunken)]" />
            <div className="h-8 w-8 rounded-xl bg-[var(--clay-sunken)]" />
          </div>
          <div className="mt-4 h-8 w-28 rounded bg-[var(--clay-sunken)]" />
          <div className="mt-4 pt-3 border-t border-[var(--clay-line)] h-3 w-36 rounded bg-[var(--clay-sunken)]" />
        </div>
      ))}
    </div>
  );
}
