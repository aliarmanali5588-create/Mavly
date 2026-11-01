"use client";

import {
  Cpu,
  Sparkles,
  FolderGit2,
  Zap,
  Megaphone,
  Server,
  ShieldAlert,
  Settings,
  ShieldCheck,
  CheckCircle,
  Clock,
  Filter,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { AdminNavSection } from "./types";
import {
  MOCK_AUDIT_LOGS,
  MOCK_GENERATIONS,
  MOCK_AI_MODEL_USAGE,
  MOCK_SYSTEM_HEALTH,
} from "./mockData";

interface MockDataViewProps {
  section: AdminNavSection;
}

export function MockDataViews({ section }: MockDataViewProps) {
  if (section === "Audit Logs") {
    return (
      <div className="bg-card rounded-2xl p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-5">
        <div className="flex items-center justify-between pb-4 border-b border-[var(--clay-line)]">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-foreground" />
            <h2 className="text-lg font-bold text-foreground">Administrative Audit Trail</h2>
          </div>
          <span className="px-2 py-0.5 text-[10px] font-bold bg-[var(--clay-sunken)] text-muted-foreground rounded-md">
            Immutable Audit Trail (Demo)
          </span>
        </div>

        <div className="space-y-3">
          {MOCK_AUDIT_LOGS.map((log) => (
            <div
              key={log.id}
              className="p-4 rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs shadow-[var(--clay-well-1)]"
            >
              <div>
                <div className="flex items-center gap-2 font-bold text-foreground">
                  <span>{log.action}</span>
                  <span className="text-[10px] text-muted-foreground font-normal">
                    by {log.actor}
                  </span>
                </div>
                <p className="text-muted-foreground mt-1">{log.target}</p>
              </div>

              <div className="flex items-center gap-4 text-muted-foreground text-[11px] shrink-0">
                <span className="font-mono">IP: {log.ip}</span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {log.timestamp}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (section === "Settings") {
    return (
      <div className="bg-card rounded-2xl p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-[var(--clay-line)]">
          <div>
            <h2 className="text-lg font-bold text-foreground">Platform Settings & Controls</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Global system defaults, AI model providers, and rate limits
            </p>
          </div>
          <button
            type="button"
            onClick={() => toast.success("Settings saved (Demo)")}
            className="px-4 py-2 bg-black text-white text-xs font-semibold rounded-xl flex items-center gap-2 shadow-[var(--clay-elev-1)] cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Save Changes</span>
          </button>
        </div>

        <div className="space-y-5 text-xs text-foreground">
          <div className="p-4 rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)] space-y-2 shadow-[var(--clay-well-1)]">
            <h3 className="font-bold text-sm text-foreground">Default AI Model</h3>
            <p className="text-muted-foreground">
              Select default model for newly initialized prompt generation runs.
            </p>
            <select className="mt-2 h-9 px-3 rounded-xl border border-[var(--clay-line)] bg-card text-xs font-semibold text-foreground w-full sm:w-72 shadow-[var(--clay-elev-1)]">
              <option>DeepSeek V4.1 Flash (Recommended)</option>
              <option>Claude 3.5 Sonnet</option>
              <option>Gemini 1.5 Pro</option>
              <option>GPT-4o</option>
            </select>
          </div>

          <div className="p-4 rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)] space-y-3 shadow-[var(--clay-well-1)]">
            <h3 className="font-bold text-sm text-foreground">System Mode & Feature Flags</h3>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="font-semibold text-foreground">Vercel Publishing Deployments</p>
                <p className="text-[11px] text-muted-foreground">
                  Allow one-click custom domain publishing to *.mavly.xyz
                </p>
              </div>
              <input type="checkbox" defaultChecked className="w-4 h-4 accent-black" />
            </div>

            <div className="flex items-center justify-between py-1 border-t border-[var(--clay-line)]">
              <div>
                <p className="font-semibold text-foreground">GitHub Synchronization Integration</p>
                <p className="text-[11px] text-muted-foreground">
                  Bidirectional push and pull for user GitHub repositories
                </p>
              </div>
              <input type="checkbox" defaultChecked className="w-4 h-4 accent-black" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Fallback view for other tabs
  return (
    <div className="bg-card rounded-2xl p-8 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] text-center space-y-3">
      <div className="w-12 h-12 rounded-2xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] mx-auto flex items-center justify-center text-foreground shadow-[var(--clay-well-1)]">
        <Sparkles className="w-6 h-6" />
      </div>
      <h2 className="text-lg font-bold text-foreground">{section} Control Panel</h2>
      <p className="text-xs text-muted-foreground max-w-md mx-auto">
        This panel is a frontend-only visual placeholder for the {section} administration module.
      </p>
      <div className="pt-2">
        <button
          type="button"
          onClick={() => toast.info(`Viewing ${section} analytics (Demo)`)}
          className="px-4 py-2 text-xs font-semibold bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] text-foreground rounded-xl transition-colors cursor-pointer"
        >
          Inspect {section} Metrics
        </button>
      </div>
    </div>
  );
}
