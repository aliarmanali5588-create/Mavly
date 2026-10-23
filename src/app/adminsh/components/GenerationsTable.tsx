"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Sparkles, Search, RotateCcw, Terminal, Filter, ArrowRight, X, Clock } from "lucide-react";
import { toast } from "sonner";
import { MOCK_GENERATIONS } from "./mockData";
import { GenerationRecord } from "./types";

export function GenerationsTable() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [selectedGen, setSelectedGen] = useState<GenerationRecord | null>(null);

  const filteredGenerations = MOCK_GENERATIONS.filter((gen) => {
    const matchesSearch =
      gen.project.toLowerCase().includes(searchQuery.toLowerCase()) ||
      gen.owner.toLowerCase().includes(searchQuery.toLowerCase()) ||
      gen.model.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus =
      statusFilter === "All" || gen.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: GenerationRecord["status"]) => {
    switch (status) {
      case "Completed":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Completed
          </span>
        );
      case "Running":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            Running
          </span>
        );
      case "Failed":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            Failed
          </span>
        );
      case "Queued":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Queued
          </span>
        );
    }
  };

  const handleRerun = (project: string) => {
    toast.info(`Triggered mock re-run for "${project}"`, {
      description: "Frontend simulation updated.",
    });
  };

  return (
    <div className="bg-white rounded-2xl p-5 sm:p-6 border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
      {/* ── Table Header Controls ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-black/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200">
              <Sparkles className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-gray-950">Generation Operations Stream</h2>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Active and completed AI prompt compilation runs
          </p>
        </div>

        <Link
          href="/adminsh/generation-monitor"
          className="text-xs font-bold text-black hover:underline inline-flex items-center gap-1 self-start sm:self-auto"
        >
          <span>Open Full Monitor</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* ── Filter & Search Toolbar ── */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search by project, owner, or model..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-8 pr-3 text-xs rounded-xl bg-gray-50 border border-black/[0.08] focus:bg-white focus:outline-none focus:ring-2 focus:ring-black text-gray-900 placeholder:text-gray-400"
          />
        </div>

        <div className="flex items-center gap-1 bg-gray-50 p-1 rounded-xl border border-black/[0.06] text-xs">
          {["All", "Completed", "Running", "Failed"].map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                statusFilter === status
                  ? "bg-white text-black shadow-xs font-bold"
                  : "text-gray-500 hover:text-black"
              }`}
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      {/* ── High-Density Data Table ── */}
      <div className="overflow-x-auto rounded-xl border border-black/[0.06]">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-gray-50/60 border-b border-black/[0.06] text-gray-400 font-bold uppercase tracking-wider text-[10px]">
              <th className="py-2.5 px-4">Project</th>
              <th className="py-2.5 px-4">Owner</th>
              <th className="py-2.5 px-4">Model Engine</th>
              <th className="py-2.5 px-4">Status</th>
              <th className="py-2.5 px-4 font-mono">Duration</th>
              <th className="py-2.5 px-4">Started</th>
              <th className="py-2.5 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.04]">
            {filteredGenerations.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-gray-400">
                  No generation records match your filter criteria.
                </td>
              </tr>
            ) : (
              filteredGenerations.map((gen) => (
                <tr key={gen.id} className="hover:bg-gray-50/60 transition-colors">
                  <td className="py-2.5 px-4 font-bold text-gray-950 max-w-[200px] truncate">
                    {gen.project}
                  </td>
                  <td className="py-2.5 px-4 text-gray-600 max-w-[160px] truncate">
                    {gen.owner}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[11px] text-gray-700">
                    {gen.model}
                  </td>
                  <td className="py-2.5 px-4">{getStatusBadge(gen.status)}</td>
                  <td className="py-2.5 px-4 font-mono text-gray-600">{gen.duration}</td>
                  <td className="py-2.5 px-4 text-gray-400 whitespace-nowrap">
                    {gen.createdAt}
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSelectedGen(gen)}
                        className="px-2 py-1 rounded-lg text-[11px] font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
                      >
                        Inspect
                      </button>
                      {gen.status === "Failed" && (
                        <button
                          type="button"
                          onClick={() => handleRerun(gen.project)}
                          className="p-1 rounded-lg text-rose-600 hover:bg-rose-50 transition-colors"
                          title="Retry Generation"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Inspection Modal ── */}
      {selectedGen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-black/[0.08] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-black/[0.06]">
              <div>
                <h3 className="text-base font-bold text-gray-950">{selectedGen.project}</h3>
                <p className="text-xs text-gray-400 font-mono">Job ID: {selectedGen.id}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedGen(null)}
                className="p-1 text-gray-400 hover:text-black rounded-lg hover:bg-black/5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs bg-gray-50 p-4 rounded-xl border border-black/[0.04]">
              <div className="flex justify-between">
                <span className="text-gray-500">Status:</span>
                <span>{getStatusBadge(selectedGen.status)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Owner:</span>
                <span className="font-semibold text-gray-900">{selectedGen.owner}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Model Engine:</span>
                <span className="font-mono text-gray-800">{selectedGen.model}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Duration:</span>
                <span className="font-mono text-gray-800">{selectedGen.duration}</span>
              </div>
              <div className="pt-2 border-t border-black/[0.04]">
                <span className="text-gray-500 block mb-1 font-bold">Prompt Snippet:</span>
                <p className="bg-white p-2.5 rounded-lg border border-black/[0.06] text-gray-800 font-mono text-[11px]">
                  {selectedGen.promptSnippet || "Generate a modern responsive website with hero, features, and pricing."}
                </p>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setSelectedGen(null)}
                className="mavly-btn-secondary px-4 py-2 text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
