"use client";

import React from "react";
import { Activity, ArrowUpRight, Info } from "lucide-react";

import { adminPeriodLabel } from "@/lib/admin/overview";
import type { AdminOverviewPayload } from "@/lib/admin/types";
import { MOCK_AI_MODEL_USAGE } from "./mockData";

/**
 * Live mode binds the panel to `project_runs` aggregates. Tokens are the summed
 * persisted `total_tokens`; cost is provider-reported USD only, never estimated
 * from a rate card.
 */
export function AiUsageSection({
  live = false,
  data,
  error = false,
}: {
  live?: boolean;
  data?: AdminOverviewPayload | null;
  error?: boolean;
}) {
  if (!live) return <DemoAiUsageSection />;
  if (error) return <AiUsageUnavailable />;
  if (!data) return <AiUsageSkeleton />;
  return <LiveAiUsageSection data={data} />;
}

function LiveAiUsageSection({ data }: { data: AdminOverviewPayload }) {
  const ai = data.ai;
  const rows = ai.models;
  const providerHealth = data.health.find((check) => check.id === "ai_provider");
  const providerLabel =
    providerHealth?.state === "not_configured"
      ? "provider not configured"
      : "provider configured; health is not probed";

  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] flex flex-col justify-between space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--neu-line)]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200">
              <Activity className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-foreground">AI Orchestration & Compute</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Runs recorded in this deployment · {adminPeriodLabel(data.period)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-2 py-1 text-[10px] font-bold tracking-wider uppercase bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg">
            {ai.models.length} model{ai.models.length === 1 ? "" : "s"} with usage · {ai.providers.length}{" "}
            provider{ai.providers.length === 1 ? "" : "s"}
          </span>
          <a
            href="/adminsh/ai-usage"
            className="px-2.5 py-1 text-[11px] font-bold text-foreground bg-[var(--neu-sunken)] hover:bg-[var(--neu-sunken-deep)] rounded-lg transition-colors flex items-center gap-1"
          >
            <span>Deep Analytics</span>
            <ArrowUpRight className="w-3 h-3" />
          </a>
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <Stat label="Total Requests" value={ai.totalRequests.toLocaleString("en-IN")} />
        <Stat
          label="Success Rate"
          value={ai.successRate === null ? "—" : `${ai.successRate}%`}
          muted={ai.successRate === null}
        />
        <Stat
          label="Total Tokens"
          value={ai.tokens > 0 ? ai.tokens.toLocaleString("en-IN") : "None recorded"}
          muted={ai.tokens === 0}
          hint="Sum of persisted run token counts"
        />
        <Stat
          label="Provider Cost"
          value={ai.costKnownRuns > 0 ? `$${ai.costUsd.toFixed(2)}` : "Not recorded"}
          muted={ai.costKnownRuns === 0}
          hint="Provider-reported USD for runs where a cost was returned"
        />
      </div>

      {/* Provider/model rows */}
      <div className="space-y-2.5">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-black/[0.1] bg-[var(--neu-sunken)]/50 px-4 py-8 text-center">
            <p className="text-sm font-semibold text-foreground">No generation runs in {adminPeriodLabel(data.period)}</p>
            <p className="text-xs text-muted-foreground mt-1">Provider rows appear once real runs are recorded.</p>
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={`${row.provider}/${row.model}`}
              className="p-3.5 rounded-xl border border-[var(--neu-line)] bg-[var(--neu-sunken)]/50 hover:bg-card hover:border-black/20 transition-all space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-bold text-foreground truncate max-w-[220px]" title={row.label}>
                    {row.label}
                  </span>
                  <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground bg-card border border-[var(--neu-line)] px-1.5 py-0.5 rounded">
                    {row.provider}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[11px] font-semibold text-muted-foreground font-mono">
                  <span>{row.requests.toLocaleString("en-IN")} req</span>
                  <span>·</span>
                  <span className="text-muted-foreground">
                    {row.tokens > 0 ? `${row.tokens.toLocaleString("en-IN")} tok` : "no tokens"}
                  </span>
                  <span>·</span>
                  <span className={row.successRate === null ? "text-muted-foreground" : "text-emerald-700"}>
                    {row.successRate === null ? "—" : `${row.successRate}% ok`}
                  </span>
                  <span className="text-muted-foreground">|</span>
                  <span className="text-muted-foreground">
                    {row.costKnownRuns > 0 ? `$${row.costUsd.toFixed(2)}` : "cost n/a"}
                  </span>
                </div>
              </div>

              <div className="w-full h-1.5 rounded-full bg-[var(--neu-sunken-deep)]/70 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.max(row.sharePercent, row.requests > 0 ? 2 : 0)}%` }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-muted-foreground font-medium">
                <span>{row.sharePercent}% of requests</span>
                <span>
                  {row.failed > 0 ? `${row.failed.toLocaleString("en-IN")} failed` : "No failed runs"}
                  {row.active ? " · catalog model" : " · not in current catalog"}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed flex items-start gap-1.5">
        <Info className="w-3 h-3 mt-0.5 shrink-0" />
        <span>
          Requests count runs started in the period, including in-progress runs. Tokens are the
          persisted provider totals; cost is provider-reported USD only and is never estimated from
          a rate card. OpenRouter: {providerLabel}.
        </span>
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  muted = false,
  hint,
}: {
  label: string;
  value: string;
  muted?: boolean;
  hint?: string;
}) {
  return (
    <div className="p-3 rounded-xl bg-[var(--neu-sunken)] border border-black/[0.05]">
      <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">{label}</span>
      <span
        className={`text-sm font-extrabold font-mono ${muted ? "text-muted-foreground" : "text-foreground"}`}
        title={hint}
      >
        {value}
      </span>
    </div>
  );
}

function AiUsageUnavailable() {
  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-1.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200">
          <Activity className="w-4 h-4" />
        </div>
        <h2 className="text-base font-bold text-foreground">AI Orchestration & Compute</h2>
      </div>
      <div className="rounded-xl border border-dashed border-black/[0.1] bg-[var(--neu-sunken)]/50 px-4 py-10 text-center">
        <p className="text-sm font-semibold text-foreground">Usage data is unavailable</p>
        <p className="text-xs text-muted-foreground mt-1">The admin aggregate could not be read. No metrics are shown.</p>
      </div>
    </div>
  );
}

function AiUsageSkeleton() {
  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4 animate-pulse">
      <div className="h-4 w-56 rounded bg-[var(--neu-sunken)]" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-16 rounded-xl bg-[var(--neu-sunken)]" />
        ))}
      </div>
      <div className="h-24 rounded-xl bg-[var(--neu-sunken)]" />
    </div>
  );
}

function DemoAiUsageSection() {
  const activeModels = MOCK_AI_MODEL_USAGE.filter((m) => m.status === "Healthy");

  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] flex flex-col justify-between space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--neu-line)]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200">
              <Activity className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-foreground">AI Orchestration & Compute</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Live token usage, latency, & provider pool health
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-2 py-1 text-[10px] font-bold tracking-wider uppercase bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg">
            {activeModels.length} Active Models
          </span>
          <a
            href="/adminsh/ai-usage"
            className="px-2.5 py-1 text-[11px] font-bold text-foreground bg-[var(--neu-sunken)] hover:bg-[var(--neu-sunken-deep)] rounded-lg transition-colors flex items-center gap-1"
          >
            <span>Deep Analytics</span>
            <ArrowUpRight className="w-3 h-3" />
          </a>
        </div>
      </div>

      {/* Top Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <div className="p-3 rounded-xl bg-[var(--neu-sunken)] border border-black/[0.05]">
          <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
            Total Prompts
          </span>
          <span className="text-base font-extrabold text-foreground font-mono">
            1,42,500
          </span>
        </div>
        <div className="p-3 rounded-xl bg-[var(--neu-sunken)] border border-black/[0.05]">
          <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
            Success Rate
          </span>
          <span className="text-base font-extrabold text-foreground font-mono">
            97.9%
          </span>
        </div>
        <div className="p-3 rounded-xl bg-[var(--neu-sunken)] border border-black/[0.05]">
          <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
            Tokens Spend
          </span>
          <span className="text-base font-extrabold text-foreground font-mono">
            102.8M
          </span>
        </div>
        <div className="p-3 rounded-xl bg-[var(--neu-sunken)] border border-black/[0.05]">
          <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
            Estimated Cost
          </span>
          <span className="text-base font-extrabold text-foreground font-mono">
            ₹1,03,000
          </span>
        </div>
      </div>

      {/* Model Distribution List */}
      <div className="space-y-2.5 pt-1">
        {MOCK_AI_MODEL_USAGE.map((aiItem) => (
          <div
            key={aiItem.name}
            className="p-3 rounded-xl border border-[var(--neu-line)] bg-[var(--neu-sunken)]/50 hover:bg-card hover:border-black/20 transition-all space-y-1.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-bold text-foreground truncate max-w-[240px]" title={aiItem.name}>
                  {aiItem.name}
                </span>
                <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground bg-card border border-[var(--neu-line)] px-1.5 py-0.5 rounded">
                  {aiItem.provider}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] font-semibold text-muted-foreground font-mono">
                <span>{aiItem.requests}</span>
                <span>·</span>
                <span>{aiItem.cost}</span>
              </div>
            </div>

            {/* Share Progress Bar */}
            <div className="w-full h-1.5 rounded-full bg-[var(--neu-sunken-deep)]/70 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${aiItem.share}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[10px] text-muted-foreground font-medium">
              <span>{aiItem.share}% of total traffic</span>
              <span>{aiItem.avgLatency} latency</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
