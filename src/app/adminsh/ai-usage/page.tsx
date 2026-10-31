"use client";

import React, { useState } from "react";
import {
  Cpu,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Coins,
  TrendingUp,
  BarChart3,
  Calendar,
  Layers,
  Sparkles,
  ArrowUpRight,
  ExternalLink,
  Activity,
  Play,
  X,
  Clock,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import { MOCK_AI_MODEL_USAGE } from "../components/mockData";

export default function AiUsageAdminPage() {
  const [timeRange, setTimeRange] = useState("30D");
  const [selectedModel, setSelectedModel] = useState<string>("DeepSeek V4.1 Flash");
  const [isTestPingOpen, setIsTestPingOpen] = useState(false);
  const [pingStatus, setPingStatus] = useState<"idle" | "running" | "done">("idle");
  const [pingResult, setPingResult] = useState<{ latency: number; provider: string; ok: boolean } | null>(null);

  const modelTableData = [
    {
      provider: "OpenRouter",
      model: "DeepSeek V4.1 Flash",
      gateway: "openrouter.ai/v1",
      requests: "64,200",
      successful: "63,050",
      failed: "1,150",
      promptTokens: "28.4M",
      completionTokens: "14.4M",
      tokens: "42.8M",
      cost: "₹38,400",
      p50: "1.1s",
      p95: "1.9s",
      successRate: 98.2,
      tier: "Default Primary",
    },
    {
      provider: "Anthropic",
      model: "Claude 3.5 Sonnet",
      gateway: "api.anthropic.com/v1",
      requests: "40,300",
      successful: "39,250",
      failed: "1,050",
      promptTokens: "20.8M",
      completionTokens: "10.4M",
      tokens: "31.2M",
      cost: "₹42,100",
      p50: "1.8s",
      p95: "2.7s",
      successRate: 97.4,
      tier: "High Accuracy Failover",
    },
    {
      provider: "Google AI Studio",
      model: "Gemini 1.5 Pro",
      gateway: "generativelanguage.googleapis.com",
      requests: "25,800",
      successful: "25,540",
      failed: "260",
      promptTokens: "12.3M",
      completionTokens: "6.2M",
      tokens: "18.5M",
      cost: "₹15,200",
      p50: "0.9s",
      p95: "1.6s",
      successRate: 99.0,
      tier: "Reasoning & Analysis",
    },
    {
      provider: "OpenAI",
      model: "GPT-4o",
      gateway: "api.openai.com/v1",
      requests: "12,200",
      successful: "11,770",
      failed: "430",
      promptTokens: "6.9M",
      completionTokens: "3.4M",
      tokens: "10.3M",
      cost: "₹7,100",
      p50: "1.4s",
      p95: "2.3s",
      successRate: 96.5,
      tier: "Secondary Fallback",
    },
  ];

  const handleRunPingTest = (modelName: string) => {
    setIsTestPingOpen(true);
    setPingStatus("running");
    setPingResult(null);

    setTimeout(() => {
      setPingStatus("done");
      setPingResult({
        latency: Math.floor(38 + Math.random() * 24),
        provider: modelName,
        ok: true,
      });
      toast.success(`Upstream health probe OK: ${modelName}`, {
        description: `Verified HTTP 200 via OpenRouter gateway (simulated).`,
      });
    }, 650);
  };

  return (
    <AdminShell activeNav="AI Usage & Cost">
      {/* 1. Gateway Status & Period Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
        <div className="flex items-start sm:items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-black text-white flex items-center justify-center shrink-0">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-foreground">
                AI Orchestration & Compute Telemetry
              </h2>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Active Gateway: OpenRouter (DeepSeek V4.1)
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Token throughput, latency percentiles, and multi-provider cost tracking
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 self-start md:self-auto">
          {/* Segmented Timeframe Switcher */}
          <div className="flex items-center bg-[var(--neu-sunken)] p-0.5 rounded-lg border border-[var(--neu-line)]">
            {["7D", "30D", "3M", "YTD"].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTimeRange(t);
                  toast.info(`Switched view to ${t}`);
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                  timeRange === t
                    ? "bg-card text-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => handleRunPingTest("DeepSeek V4.1 Flash")}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-[var(--neu-sunken)] hover:bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-lg transition-colors"
          >
            <Activity className="w-3.5 h-3.5 text-muted-foreground" />
            <span>Probe Gateway</span>
          </button>
        </div>
      </div>

      {/* 2. Precision Enterprise KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
        <div className="p-4 rounded-xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Total Requests</span>
            <Zap className="w-3.5 h-3.5 text-amber-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">1,42,500</h3>
          <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-600 font-medium">
            <ArrowUpRight className="w-3 h-3" />
            <span>+24.2% vs last {timeRange}</span>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Success Rate</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">96.84%</h3>
          <p className="text-[11px] text-muted-foreground mt-1">1,38,000 successful runs</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Error Rate</span>
            <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-rose-600 font-mono mt-1">3.16%</h3>
          <p className="text-[11px] text-muted-foreground mt-1">4,500 timeouts / rate caps</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Tokens Consumed</span>
            <Coins className="w-3.5 h-3.5 text-blue-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">102.8M</h3>
          <p className="text-[11px] text-muted-foreground mt-1">68.4M prompt · 34.4M compl</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)] col-span-2 sm:col-span-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Est. Upstream Cost</span>
            <TrendingUp className="w-3.5 h-3.5 text-purple-600" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">₹1,02,800</h3>
          <p className="text-[11px] text-muted-foreground mt-1">~₹0.72 per build run</p>
        </div>
      </div>

      {/* 3. Provider Share Visual Distribution */}
      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-[var(--neu-line)]">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Provider Workload Distribution & Unit Economics
            </h3>
            <p className="text-xs text-muted-foreground">
              Breakdown of generation volume, latency benchmarks, and billable compute
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
            <span>Total Requests: <strong>1,42,500</strong></span>
            <span>·</span>
            <span>Active Tier: <strong>Standard Production</strong></span>
          </div>
        </div>

        {/* Multi-segment Progress Bar */}
        <div className="space-y-2">
          <div className="h-3 w-full bg-[var(--neu-sunken)] rounded-full overflow-hidden flex">
            <div className="bg-gray-950 h-full w-[45%]" title="DeepSeek V4.1: 45%" />
            <div className="bg-blue-600 h-full w-[28%]" title="Claude 3.5 Sonnet: 28%" />
            <div className="bg-purple-600 h-full w-[18%]" title="Gemini 1.5 Pro: 18%" />
            <div className="bg-emerald-600 h-full w-[9%]" title="GPT-4o: 9%" />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs pt-1 text-muted-foreground font-medium">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-gray-950" />
              <span>DeepSeek V4.1 (45%)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-600" />
              <span>Claude 3.5 (28%)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-600" />
              <span>Gemini 1.5 Pro (18%)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-600" />
              <span>GPT-4o (9%)</span>
            </div>
          </div>
        </div>

        {/* Detailed Model Progress Rows */}
        <div className="space-y-3.5 pt-2">
          {MOCK_AI_MODEL_USAGE.map((m) => (
            <div
              key={m.name}
              className={`p-3 rounded-xl border transition-all ${
                selectedModel === m.name
                  ? "bg-[var(--neu-sunken)]/80 border-black/20"
                  : "bg-card border-[var(--neu-line)] hover:border-black/10"
              }`}
              onClick={() => setSelectedModel(m.name)}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground">{m.name}</span>
                  <span className="text-[11px] text-muted-foreground font-mono">({m.requests} calls)</span>
                </div>
                <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground">
                  <span>Tokens: <strong className="text-foreground">{m.tokens}</strong></span>
                  <span>Avg Latency: <strong className="text-foreground">{m.avgLatency}</strong></span>
                  <span>Success: <strong className="text-emerald-700">{m.successRate}</strong></span>
                  <span className="font-bold text-foreground">{m.cost}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. Model Comparison & Gateway Matrix */}
      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-[var(--neu-line)]">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Upstream Gateway & Model Audit Matrix
            </h3>
            <p className="text-xs text-muted-foreground">
              Real-time latency percentiles (p50 / p95) and token split ratio
            </p>
          </div>
          <span className="text-xs font-mono text-muted-foreground bg-[var(--neu-sunken)] px-2.5 py-1 rounded-md border border-[var(--neu-line)]">
            Server-side OpenRouter Proxy
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--neu-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                <th className="pb-3">Model & Provider</th>
                <th className="pb-3">Gateway Endpoint</th>
                <th className="pb-3 text-right">Requests</th>
                <th className="pb-3 text-right">Prompt / Compl</th>
                <th className="pb-3 text-right">Total Tokens</th>
                <th className="pb-3 text-center">p50 / p95</th>
                <th className="pb-3 text-center">Success Rate</th>
                <th className="pb-3 text-right">Est. Cost</th>
                <th className="pb-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.04]">
              {modelTableData.map((row) => (
                <tr key={row.model} className="hover:bg-[var(--neu-sunken)]/70 transition-colors">
                  <td className="py-3.5">
                    <p className="font-semibold text-foreground">{row.model}</p>
                    <p className="text-[11px] text-muted-foreground">{row.provider} · {row.tier}</p>
                  </td>
                  <td className="py-3.5 font-mono text-[11px] text-muted-foreground">
                    {row.gateway}
                  </td>
                  <td className="py-3.5 text-right font-mono font-medium text-foreground">
                    {row.requests}
                  </td>
                  <td className="py-3.5 text-right font-mono text-[11px] text-muted-foreground">
                    {row.promptTokens} / {row.completionTokens}
                  </td>
                  <td className="py-3.5 text-right font-mono font-medium text-foreground">
                    {row.tokens}
                  </td>
                  <td className="py-3.5 text-center font-mono text-muted-foreground">
                    {row.p50} / {row.p95}
                  </td>
                  <td className="py-3.5 text-center">
                    <span className="inline-flex items-center gap-1 font-mono font-semibold text-emerald-700">
                      {row.successRate}%
                    </span>
                  </td>
                  <td className="py-3.5 text-right font-mono font-bold text-foreground">
                    {row.cost}
                  </td>
                  <td className="py-3.5 text-right">
                    <button
                      type="button"
                      onClick={() => handleRunPingTest(row.model)}
                      className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--neu-sunken)] hover:bg-gray-200 rounded-md transition-colors"
                    >
                      Probe
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Upstream Health Probe Modal */}
      {isTestPingOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-md bg-card rounded-2xl border border-black/[0.1] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--neu-line)]">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-foreground" />
                <h3 className="text-sm font-bold text-foreground">Gateway Health Probe</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsTestPingOpen(false)}
                className="p-1 text-muted-foreground hover:text-black rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 rounded-xl bg-gray-950 text-gray-200 font-mono text-xs space-y-2">
              <p className="text-muted-foreground">
                &gt; Pinging OpenRouter endpoint: <span className="text-white">https://openrouter.ai/api/v1</span>
              </p>
              {pingStatus === "running" ? (
                <div className="flex items-center gap-2 text-amber-400 py-2">
                  <Activity className="w-4 h-4 animate-spin" />
                  <span>Measuring SSL handshake and token stream TTL...</span>
                </div>
              ) : pingResult ? (
                <div className="space-y-1.5 text-emerald-400 py-1">
                  <p>✔ HTTP 200 OK — Ready</p>
                  <p className="text-gray-300">Model: {pingResult.provider}</p>
                  <p className="text-gray-300">Round-trip Latency: {pingResult.latency}ms</p>
                  <p className="text-gray-300">Auth Header: Bearer [REDACTED]</p>
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => handleRunPingTest("DeepSeek V4.1 Flash")}
                disabled={pingStatus === "running"}
                className="px-3 py-1.5 text-xs font-medium text-foreground bg-[var(--neu-sunken)] hover:bg-gray-200 rounded-lg transition-colors"
              >
                Re-test
              </button>
              <button
                type="button"
                onClick={() => setIsTestPingOpen(false)}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-black hover:bg-neutral-800 rounded-lg"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
