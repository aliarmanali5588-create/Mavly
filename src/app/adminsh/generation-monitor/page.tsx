"use client";

import React, { useState } from "react";
import {
  Sparkles,
  Search,
  Filter,
  RotateCcw,
  StopCircle,
  Eye,
  CheckCircle2,
  Clock,
  AlertCircle,
  X,
  FileCode,
  Terminal,
  Cpu,
  Layers,
  Copy,
  ExternalLink,
  ChevronRight,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import { MOCK_GENERATIONS } from "../components/mockData";
import { GenerationRecord } from "../components/types";

export default function GenerationMonitorAdminPage() {
  const [generations, setGenerations] = useState<GenerationRecord[]>(MOCK_GENERATIONS);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [selectedJob, setSelectedJob] = useState<GenerationRecord | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"overview" | "prompt" | "logs">("overview");

  const filtered = generations.filter((g) => {
    const matchesSearch =
      g.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      g.project.toLowerCase().includes(searchQuery.toLowerCase()) ||
      g.owner.toLowerCase().includes(searchQuery.toLowerCase()) ||
      g.model.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === "All" || g.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleRetryJob = (job: GenerationRecord) => {
    setGenerations((prev) =>
      prev.map((g) =>
        g.id === job.id ? { ...g, status: "Running", duration: "1.2s", errorLog: undefined } : g
      )
    );
    toast.success(`Job ${job.id} re-queued`, {
      description: `Re-running generation pipeline for "${job.project}".`,
    });
  };

  const handleCancelJob = (job: GenerationRecord) => {
    setGenerations((prev) =>
      prev.map((g) =>
        g.id === job.id
          ? { ...g, status: "Failed", errorLog: "Execution aborted by administrator" }
          : g
      )
    );
    toast.info(`Job ${job.id} cancelled`, {
      description: "Process halted.",
    });
  };

  const handleCopyId = (id: string) => {
    navigator.clipboard?.writeText(id);
    toast.success(`Copied Job ID: ${id}`);
  };

  const getStatusBadge = (status: GenerationRecord["status"]) => {
    switch (status) {
      case "Completed":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Completed
          </span>
        );
      case "Running":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200/60 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            Running
          </span>
        );
      case "Failed":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200/60 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            Failed
          </span>
        );
      case "Queued":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200/60 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Queued
          </span>
        );
    }
  };

  return (
    <AdminShell activeNav="Generation Monitor">
      {/* 1. Worker Telemetry & Pipeline Status */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
        <div className="flex items-start sm:items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-black text-white flex items-center justify-center shrink-0">
            <Terminal className="w-5 h-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-foreground">
                AI Generation & Build Queue Engine
              </h2>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Worker Pool: 4/4 Available
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Live AST file synthesis, code generation stream, and static preview bundling
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono self-start md:self-auto">
          <div>
            <span className="text-muted-foreground block text-[10px] uppercase font-semibold">Active Jobs</span>
            <span className="font-bold text-foreground">6 Running</span>
          </div>
          <div className="h-6 w-px bg-black/[0.08]" />
          <div>
            <span className="text-muted-foreground block text-[10px] uppercase font-semibold">Queue Depth</span>
            <span className="font-bold text-amber-700">14 in Buffer</span>
          </div>
          <div className="h-6 w-px bg-black/[0.08]" />
          <div>
            <span className="text-muted-foreground block text-[10px] uppercase font-semibold">Avg Latency</span>
            <span className="font-bold text-emerald-700">12.4s</span>
          </div>
        </div>
      </div>

      {/* 2. Real-Time Generation Queue & Jobs Table */}
      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-[var(--neu-line)]">
          {/* Segmented Filter Buttons */}
          <div className="flex flex-wrap items-center gap-1 bg-[var(--neu-sunken)] p-0.5 rounded-lg border border-[var(--neu-line)] text-xs">
            {["All", "Running", "Queued", "Completed", "Failed"].map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1 rounded-md text-xs transition-all ${
                  statusFilter === st
                    ? "bg-card text-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground font-medium"
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative w-full lg:w-72">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Filter by Job ID, project, user..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-8 pl-8 pr-3 text-xs rounded-lg bg-[var(--neu-sunken)] border border-[var(--neu-line)] text-foreground placeholder:text-muted-foreground focus:bg-card focus:outline-none focus:ring-1 focus:ring-black"
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--neu-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                <th className="pb-3">Job Identifier</th>
                <th className="pb-3">Target Project</th>
                <th className="pb-3">Initiator / User</th>
                <th className="pb-3">AI Model Engine</th>
                <th className="pb-3 text-center">Status</th>
                <th className="pb-3 text-right">Duration</th>
                <th className="pb-3 text-right">Created</th>
                <th className="pb-3 text-right">Job Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.04]">
              {filtered.length > 0 ? (
                filtered.map((job) => (
                  <tr key={job.id} className="hover:bg-[var(--neu-sunken)]/70 transition-colors">
                    <td className="py-3.5">
                      <div className="flex items-center gap-1.5 font-mono">
                        <span className="font-semibold text-foreground">{job.id}</span>
                        <button
                          type="button"
                          onClick={() => handleCopyId(job.id)}
                          className="p-1 text-muted-foreground hover:text-black transition-colors"
                          title="Copy Job ID"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                    <td className="py-3.5 max-w-[220px]">
                      <p className="font-semibold text-foreground truncate">{job.project}</p>
                      {job.promptSnippet && (
                        <p className="text-[11px] text-muted-foreground truncate italic">
                          &ldquo;{job.promptSnippet}&rdquo;
                        </p>
                      )}
                    </td>
                    <td className="py-3.5 font-mono text-[11px] text-muted-foreground">
                      {job.owner}
                    </td>
                    <td className="py-3.5">
                      <span className="font-mono text-[11px] text-foreground bg-[var(--neu-sunken)] px-2 py-0.5 rounded border border-[var(--neu-line)]">
                        {job.model}
                      </span>
                    </td>
                    <td className="py-3.5 text-center">{getStatusBadge(job.status)}</td>
                    <td className="py-3.5 text-right font-mono text-muted-foreground">
                      {job.duration}
                    </td>
                    <td className="py-3.5 text-right text-muted-foreground whitespace-nowrap">
                      {job.createdAt}
                    </td>
                    <td className="py-3.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedJob(job);
                            setInspectorTab("overview");
                          }}
                          className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--neu-sunken)] hover:bg-[var(--neu-sunken-deep)] rounded-md transition-colors"
                        >
                          Inspect
                        </button>
                        {job.status === "Running" ? (
                          <button
                            type="button"
                            onClick={() => handleCancelJob(job)}
                            className="px-2 py-1 text-[11px] font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200/60 rounded-md transition-colors"
                          >
                            Cancel
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleRetryJob(job)}
                            className="p-1 text-muted-foreground hover:text-black transition-colors"
                            title="Re-run Job"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted-foreground text-xs">
                    No generation jobs found matching your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Enterprise Job Inspector Drawer */}
      {selectedJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-xl bg-card rounded-2xl border border-black/[0.1] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--neu-line)]">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-foreground" />
                <div>
                  <h3 className="text-sm font-bold text-foreground">Generation Execution Inspector</h3>
                  <p className="text-[11px] font-mono text-muted-foreground">{selectedJob.id} · {selectedJob.project}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedJob(null)}
                className="p-1 text-muted-foreground hover:text-black rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Segmented Inspector Tabs */}
            <div className="flex items-center gap-1 bg-[var(--neu-sunken)] p-0.5 rounded-lg border border-[var(--neu-line)] text-xs">
              <button
                type="button"
                onClick={() => setInspectorTab("overview")}
                className={`flex-1 py-1 text-center rounded-md font-medium transition-all ${
                  inspectorTab === "overview" ? "bg-card text-foreground shadow-xs font-semibold" : "text-muted-foreground"
                }`}
              >
                Job Metadata
              </button>
              <button
                type="button"
                onClick={() => setInspectorTab("prompt")}
                className={`flex-1 py-1 text-center rounded-md font-medium transition-all ${
                  inspectorTab === "prompt" ? "bg-card text-foreground shadow-xs font-semibold" : "text-muted-foreground"
                }`}
              >
                User Prompt Input
              </button>
              <button
                type="button"
                onClick={() => setInspectorTab("logs")}
                className={`flex-1 py-1 text-center rounded-md font-medium transition-all ${
                  inspectorTab === "logs" ? "bg-card text-foreground shadow-xs font-semibold" : "text-muted-foreground"
                }`}
              >
                Console & Errors
              </button>
            </div>

            {/* Tab Contents */}
            {inspectorTab === "overview" && (
              <div className="space-y-2.5 text-xs">
                <div className="grid grid-cols-2 gap-2 bg-[var(--neu-sunken)] p-3 rounded-xl border border-[var(--neu-line)]">
                  <div>
                    <span className="text-muted-foreground block text-[10px] uppercase font-bold">Project Name</span>
                    <span className="font-semibold text-foreground">{selectedJob.project}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[10px] uppercase font-bold">Execution Status</span>
                    <span>{getStatusBadge(selectedJob.status)}</span>
                  </div>
                  <div className="mt-1">
                    <span className="text-muted-foreground block text-[10px] uppercase font-bold">Model Engine</span>
                    <span className="font-mono text-foreground">{selectedJob.model}</span>
                  </div>
                  <div className="mt-1">
                    <span className="text-muted-foreground block text-[10px] uppercase font-bold">Execution Duration</span>
                    <span className="font-mono text-foreground">{selectedJob.duration}</span>
                  </div>
                  <div className="mt-1">
                    <span className="text-muted-foreground block text-[10px] uppercase font-bold">Tokens Consumed</span>
                    <span className="font-mono text-foreground">{selectedJob.tokensUsed || "7,420 tokens"}</span>
                  </div>
                  <div className="mt-1">
                    <span className="text-muted-foreground block text-[10px] uppercase font-bold">Created At</span>
                    <span className="text-foreground">{selectedJob.createdAt}</span>
                  </div>
                </div>
              </div>
            )}

            {inspectorTab === "prompt" && (
              <div className="space-y-2 text-xs">
                <span className="text-muted-foreground text-[10px] uppercase font-bold block">
                  Natural Language Prompt Context
                </span>
                <div className="p-3 bg-black text-white/80 font-mono text-[11px] rounded-xl overflow-x-auto leading-relaxed border border-black/10">
                  {selectedJob.promptSnippet || "Create modern landing page with pricing calculator and dark mode toggle."}
                </div>
              </div>
            )}

            {inspectorTab === "logs" && (
              <div className="space-y-2 text-xs">
                <span className="text-muted-foreground text-[10px] uppercase font-bold block">
                  Diagnostic Log Stream
                </span>
                {selectedJob.errorLog ? (
                  <div className="p-3 bg-rose-950/20 border border-rose-300 text-rose-800 font-mono text-[11px] rounded-xl space-y-1">
                    <p className="font-bold flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" /> Error Log Output:
                    </p>
                    <p className="break-all">{selectedJob.errorLog}</p>
                  </div>
                ) : (
                  <div className="p-3 bg-black text-emerald-400 font-mono text-[11px] rounded-xl space-y-1">
                    <p>&gt; [AST Engine] Parsed 14 React components successfully.</p>
                    <p>&gt; [Bundler] Static preview.html compiled (184 KB).</p>
                    <p>&gt; [Status] Pipeline exit code 0 — Completed.</p>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-[var(--neu-line)]">
              {selectedJob.status === "Failed" ? (
                <button
                  type="button"
                  onClick={() => handleRetryJob(selectedJob)}
                  className="px-3 py-1.5 bg-black text-white text-xs font-semibold rounded-lg flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Re-run Job</span>
                </button>
              ) : <div />}

              <button
                type="button"
                onClick={() => setSelectedJob(null)}
                className="px-4 py-1.5 bg-[var(--neu-sunken)] hover:bg-[var(--neu-sunken-deep)] text-foreground text-xs font-semibold rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
