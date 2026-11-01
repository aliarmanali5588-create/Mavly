"use client";

import React, { useState } from "react";
import {
  FileText,
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  Copy,
  ExternalLink,
  Shield,
  Download,
  Terminal,
  X,
  Sparkles,
  User,
  Clock,
  Layers,
  Lock,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import { MOCK_AUDIT_LOGS } from "../components/mockData";
import { AuditLogRecord } from "../components/types";

export default function AuditLogsAdminPage() {
  const [logs] = useState<AuditLogRecord[]>(MOCK_AUDIT_LOGS);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sourceFilter, setSourceFilter] = useState("All");
  const [selectedLog, setSelectedLog] = useState<AuditLogRecord | null>(null);

  const filtered = logs.filter((log) => {
    const matchesSearch =
      log.actor.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.target.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.ip.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === "All" || log.status === statusFilter;
    const matchesSource = sourceFilter === "All" || log.source === sourceFilter;

    return matchesSearch && matchesStatus && matchesSource;
  });

  const handleCopyPayload = (payload: string) => {
    navigator.clipboard?.writeText(payload);
    toast.success("Payload copied to clipboard!", {
      description: "JSON audit event payload copied.",
    });
  };

  const getStatusBadge = (status: AuditLogRecord["status"]) => {
    if (status === "Success") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-success-subtle text-success-subtle-foreground border border-success/25 font-mono">
          <CheckCircle2 className="w-3 h-3 text-success" />
          Success
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-destructive-subtle text-destructive-subtle-foreground border border-destructive/25 font-mono">
        <XCircle className="w-3 h-3 text-destructive" />
        Failed
      </span>
    );
  };

  return (
    <AdminShell activeNav="Audit Logs">
      {/* 1. Audit Metrics Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Security Events</span>
            <Shield className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">4,820</h3>
          <p className="text-[11px] text-muted-foreground mt-1">90-day compliance retention</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Console Actions</span>
            <Lock className="w-3.5 h-3.5 text-success" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">214</h3>
          <p className="text-[11px] text-success font-medium mt-1">100% authenticated & signed</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Edge Mitigations</span>
            <FileText className="w-3.5 h-3.5 text-warning" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-warning-subtle-foreground font-mono mt-1">18</h3>
          <p className="text-[11px] text-muted-foreground mt-1">WAF rate limit triggers blocked</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Cryptographic Chain</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-success" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-success font-mono mt-1">SHA-256 OK</h3>
          <p className="text-[11px] text-muted-foreground mt-1">Tamper-evident event stream</p>
        </div>
      </div>

      {/* 2. Search, Filter & Action Bar */}
      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-[var(--clay-line)]">
          {/* Segmented Status Tabs */}
          <div className="flex flex-wrap items-center gap-1 bg-[var(--clay-sunken)] p-0.5 rounded-lg border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
            {["All", "Success", "Failed"].map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1 rounded-md text-xs transition-all ${
                  statusFilter === st
                    ? "bg-card text-foreground shadow-[var(--clay-elev-1)] font-semibold"
                    : "text-muted-foreground hover:text-foreground font-medium"
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search actor, action, IP..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-8 pl-8 pr-3 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground placeholder:text-muted-foreground focus:bg-card focus:outline-none focus:ring-1 focus:ring-black shadow-[var(--clay-well-1)]"
              />
            </div>

            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="h-8 px-2.5 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground focus:bg-card focus:outline-none shadow-[var(--clay-well-1)]"
            >
              <option value="All">All Sources</option>
              <option value="Admin Console">Admin Console</option>
              <option value="Internal Cron">Internal Cron</option>
              <option value="CertBot Worker">CertBot Worker</option>
              <option value="Edge WAF">Edge WAF</option>
            </select>

            <button
              onClick={() => {
                toast.info("Exporting cryptographic audit log (demo)");
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-lg transition-colors shadow-[var(--clay-well-1)]"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export</span>
            </button>
          </div>
        </div>

        {/* 3. Audit Logs Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--clay-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                <th className="pb-3">Timestamp</th>
                <th className="pb-3">Actor / Principal</th>
                <th className="pb-3">Action Executed</th>
                <th className="pb-3">Target Resource</th>
                <th className="pb-3">Component Source</th>
                <th className="pb-3 font-mono">Origin IP</th>
                <th className="pb-3 text-center">Status</th>
                <th className="pb-3 text-right">Payload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--clay-line)]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted-foreground text-xs">
                    No security audit records match your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((log) => (
                  <tr key={log.id} className="hover:bg-[var(--clay-sunken)] transition-colors">
                    <td className="py-3.5 text-muted-foreground whitespace-nowrap font-mono text-[11px]">
                      {log.timestamp}
                    </td>
                    <td className="py-3.5 font-semibold text-foreground max-w-[180px] truncate" title={log.actor}>
                      {log.actor}
                    </td>
                    <td className="py-3.5 font-medium text-foreground">
                      {log.action}
                    </td>
                    <td className="py-3.5 text-muted-foreground max-w-[200px] truncate font-mono text-[11px]" title={log.target}>
                      {log.target}
                    </td>
                    <td className="py-3.5">
                      <span className="font-mono text-[11px] text-foreground bg-[var(--clay-sunken)] px-2 py-0.5 rounded border border-[var(--clay-line)]">
                        {log.source}
                      </span>
                    </td>
                    <td className="py-3.5 font-mono text-muted-foreground text-[11px]">
                      {log.ip}
                    </td>
                    <td className="py-3.5 text-center">{getStatusBadge(log.status)}</td>
                    <td className="py-3.5 text-right">
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-md transition-colors inline-flex items-center gap-1"
                      >
                        <Terminal className="w-3 h-3" />
                        <span>JSON</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Log Payload Inspection Modal */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--clay-scrim)] backdrop-blur-[3px] animate-in fade-in">
          <div className="bg-card rounded-2xl max-w-lg w-full border border-[var(--clay-line)] shadow-[var(--clay-float)] p-6 relative space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--clay-line)]">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-foreground" />
                <h3 className="text-sm font-bold text-foreground">Audit Event {selectedLog.id}</h3>
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                className="p-1 rounded-lg text-muted-foreground hover:text-black"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2 bg-[var(--clay-sunken)] p-3 rounded-xl border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
                <div>
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Principal Actor</span>
                  <p className="font-semibold text-foreground truncate">{selectedLog.actor}</p>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Client IP</span>
                  <p className="font-mono text-foreground">{selectedLog.ip}</p>
                </div>
                <div className="mt-1">
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Action Name</span>
                  <p className="font-semibold text-foreground">{selectedLog.action}</p>
                </div>
                <div className="mt-1">
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Execution Time</span>
                  <p className="text-foreground">{selectedLog.timestamp}</p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-muted-foreground font-semibold text-[11px] uppercase tracking-wider">
                    Structured Event JSON Payload
                  </span>
                  {selectedLog.payloadJson && (
                    <button
                      onClick={() => handleCopyPayload(selectedLog.payloadJson || "")}
                      className="text-muted-foreground hover:text-black flex items-center gap-1 text-[11px] font-medium"
                    >
                      <Copy className="w-3 h-3" />
                      <span>Copy</span>
                    </button>
                  )}
                </div>

                <pre className="p-3 bg-[var(--clay-sunken-deep)] text-success font-mono text-[11px] rounded-xl overflow-x-auto leading-relaxed border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
                  {selectedLog.payloadJson
                    ? JSON.stringify(JSON.parse(selectedLog.payloadJson), null, 2)
                    : '{"message": "No additional payload recorded."}'}
                </pre>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-[var(--clay-line)]">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-4 py-1.5 text-xs font-semibold text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-lg"
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
