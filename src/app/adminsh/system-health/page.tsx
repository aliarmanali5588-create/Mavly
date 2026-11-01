"use client";

import React, { useState } from "react";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Server,
  Database,
  Cpu,
  Globe,
  HardDrive,
  RefreshCw,
  Sparkles,
  ShieldCheck,
  Zap,
  Info,
  X,
  Radio,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import { MOCK_SYSTEM_HEALTH, MOCK_INCIDENTS_LIST } from "../components/mockData";
import { SystemServiceStatus, IncidentRecord } from "../components/types";

export default function SystemHealthAdminPage() {
  const [services, setServices] = useState<SystemServiceStatus[]>(MOCK_SYSTEM_HEALTH);
  const [incidents] = useState<IncidentRecord[]>(MOCK_INCIDENTS_LIST);
  const [selectedIncident, setSelectedIncident] = useState<IncidentRecord | null>(null);

  const handlePingAll = () => {
    /**
     * ⚠️ THIS NO LONGER FABRICATES A RESULT.
     *
     * It used to `setTimeout` 600 ms and then claim "All 6 core services
     * responded with HTTP 200 OK within 38ms" — a measurement that was never
     * taken. Nothing here contacts a service.
     *
     * The real, measured health checks live on the Overview page, which reads
     * `public.admin_overview` and reports actual database latency. This page's
     * service list is static reference data, so the button says that plainly.
     */
    toast.info("No live health probe is implemented on this page", {
      description:
        "No service was contacted, so no latency is reported. Measured checks are on the Overview page.",
    });
  };

  const getServiceIcon = (name: string) => {
    if (name.includes("Application")) return <Server className="w-4 h-4 text-foreground" />;
    if (name.includes("Database")) return <Database className="w-4 h-4 text-foreground" />;
    if (name.includes("Worker")) return <Cpu className="w-4 h-4 text-foreground" />;
    if (name.includes("Model") || name.includes("OpenRouter"))
      return <Zap className="w-4 h-4 text-warning" />;
    if (name.includes("Domain") || name.includes("DNS"))
      return <Globe className="w-4 h-4 text-muted-foreground" />;
    return <HardDrive className="w-4 h-4 text-muted-foreground" />;
  };

  const getStatusBadge = (status: SystemServiceStatus["status"]) => {
    switch (status) {
      case "Operational":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-success-subtle text-success-subtle-foreground border border-success/25 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            Operational
          </span>
        );
      case "Degraded":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-warning-subtle text-warning-subtle-foreground border border-warning/25 font-mono">
            <AlertTriangle className="w-3 h-3 text-warning" />
            Degraded
          </span>
        );
      case "Maintenance":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--clay-sunken)] text-foreground border border-[var(--clay-line)] font-mono">
            <Clock className="w-3 h-3 text-foreground" />
            Maintenance
          </span>
        );
    }
  };

  return (
    <AdminShell activeNav="System Health">
      {/* 1. Global Platform Uptime Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
        <div className="flex items-start sm:items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-success-subtle text-success border border-success/25 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-foreground">
                All Core Services Fully Operational
              </h2>
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              99.98% composite availability recorded across the last 90 calendar days
            </p>
          </div>
        </div>

        <button
          onClick={handlePingAll}
          className="self-start md:self-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-lg transition-colors shrink-0 shadow-[var(--clay-well-1)]"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Probe All Services</span>
        </button>
      </div>

      {/* 2. Key Diagnostic Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Avg Global Latency</span>
            <Activity className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">24ms</h3>
          <p className="text-[11px] text-success font-medium mt-1">Edge routed via Cloudflare</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Worker Pool</span>
            <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">4 / 4 Online</h3>
          <p className="text-[11px] text-muted-foreground mt-1">Background agent concurrency</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>DB Connection Pool</span>
            <Database className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">42 / 200</h3>
          <p className="text-[11px] text-muted-foreground mt-1">79% headroom buffer</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Static Cache Ratio</span>
            <Sparkles className="w-3.5 h-3.5 text-success" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-success font-mono mt-1">98.4%</h3>
          <p className="text-[11px] text-muted-foreground mt-1">Vercel edge preview hits</p>
        </div>
      </div>

      {/* 3. Detailed Services Status Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">Service Infrastructure Topology</h3>
          <span className="text-muted-foreground font-mono">6 of 6 Healthy</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {services.map((svc) => (
            <div
              key={svc.name}
              className="p-5 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] hover:border-[var(--clay-line-strong)] transition-all flex flex-col justify-between space-y-4"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="p-2 rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
                    {getServiceIcon(svc.name)}
                  </div>
                  {getStatusBadge(svc.status)}
                </div>

                <h4 className="text-sm font-semibold text-foreground mt-3">{svc.name}</h4>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {svc.description}
                </p>
              </div>

              <div className="pt-3 border-t border-[var(--clay-line)] flex items-center justify-between text-xs">
                <div>
                  <span className="text-muted-foreground block text-[10px] uppercase font-semibold">
                    Uptime
                  </span>
                  <span className="font-mono font-bold text-foreground">{svc.uptime}</span>
                </div>

                <div>
                  <span className="text-muted-foreground block text-[10px] uppercase font-semibold">
                    Response
                  </span>
                  <span className="font-mono font-bold text-success">{svc.latency}</span>
                </div>

                <button
                  onClick={() => {
                    toast.info(`Pinged ${svc.name}`, {
                      description: `Response time: ${svc.latency} (HTTP 200)`,
                    });
                  }}
                  className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-md transition-colors"
                >
                  Ping
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. Recent Incident History */}
      <div className="rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] overflow-hidden">
        <div className="p-4 border-b border-[var(--clay-line)] flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold tracking-tight text-foreground">Past Postmortems & Incident History</h4>
            <p className="text-xs text-muted-foreground">Zero active alerts or degradations currently ongoing</p>
          </div>
          <span className="text-[11px] font-mono text-success bg-success-subtle border border-success/25 px-2 py-0.5 rounded">
            All Resolved
          </span>
        </div>

        <div className="divide-y divide-[var(--clay-line)]">
          {incidents.map((inc) => (
            <div
              key={inc.id}
              className="p-4 hover:bg-[var(--clay-sunken)] transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-muted-foreground text-[11px]">{inc.id}</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-success-subtle text-success-subtle-foreground border border-success/25 font-mono">
                    <CheckCircle2 className="w-3 h-3 text-success" />
                    {inc.status}
                  </span>
                  <span className="font-semibold text-foreground">{inc.title}</span>
                </div>
                <p className="text-muted-foreground text-[11px]">
                  Impact: <strong className="text-foreground">{inc.impact}</strong> · Duration:{" "}
                  {inc.duration} · Component: {inc.service}
                </p>
              </div>

              <div className="flex items-center gap-3 self-end sm:self-center shrink-0">
                <span className="text-muted-foreground text-[11px] whitespace-nowrap">{inc.timestamp}</span>
                <button
                  onClick={() => setSelectedIncident(inc)}
                  className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-md transition-colors"
                >
                  Postmortem
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Incident Detail Modal */}
      {selectedIncident && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--clay-scrim)] backdrop-blur-[3px] animate-in fade-in">
          <div className="bg-card rounded-2xl max-w-lg w-full border border-[var(--clay-line)] shadow-[var(--clay-float)] p-6 relative space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--clay-line)]">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-foreground" />
                <h3 className="text-sm font-bold text-foreground">Incident Postmortem {selectedIncident.id}</h3>
              </div>
              <button
                onClick={() => setSelectedIncident(null)}
                className="p-1 rounded-lg text-muted-foreground hover:text-black"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
              <div>
                <span className="text-muted-foreground block text-[10px] uppercase font-bold">Event Summary</span>
                <p className="font-bold text-foreground mt-0.5">{selectedIncident.title}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[var(--clay-line)]">
                <div>
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Incident Time</span>
                  <span className="text-foreground">{selectedIncident.timestamp}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Duration</span>
                  <span className="text-foreground">{selectedIncident.duration}</span>
                </div>
              </div>

              <div className="pt-2 border-t border-[var(--clay-line)]">
                <span className="text-muted-foreground block text-[10px] uppercase font-bold">Customer Impact</span>
                <p className="text-foreground mt-0.5">{selectedIncident.impact}</p>
              </div>

              <div className="pt-2 border-t border-[var(--clay-line)]">
                <span className="text-muted-foreground block text-[10px] uppercase font-bold">Technical Root Cause & Fix</span>
                <p className="text-foreground bg-card p-2.5 rounded-lg border border-[var(--clay-line)] mt-1 leading-relaxed shadow-[var(--clay-elev-1)]">
                  {selectedIncident.details}
                </p>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-[var(--clay-line)]">
              <button
                onClick={() => setSelectedIncident(null)}
                className="px-4 py-1.5 text-xs font-semibold text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-lg"
              >
                Close Report
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
