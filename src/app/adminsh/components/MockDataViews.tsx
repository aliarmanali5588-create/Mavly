"use client";

import React, { useState } from "react";
import {
  Users,
  CreditCard,
  Cpu,
  Sparkles,
  FolderGit2,
  Zap,
  Megaphone,
  Server,
  ShieldAlert,
  Settings,
  Search,
  Plus,
  ShieldCheck,
  CheckCircle,
  Clock,
  MoreVertical,
  Filter,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { AdminNavSection } from "./types";
import {
  MOCK_USERS_LIST,
  MOCK_AUDIT_LOGS,
  MOCK_GENERATIONS,
  MOCK_TRANSACTIONS,
  MOCK_AI_MODEL_USAGE,
  MOCK_SYSTEM_HEALTH,
} from "./mockData";

interface MockDataViewProps {
  section: AdminNavSection;
}

export function MockDataViews({ section }: MockDataViewProps) {
  const [searchTerm, setSearchTerm] = useState("");

  if (section === "Users") {
    const users = MOCK_USERS_LIST.filter(
      (u) =>
        u.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        u.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
        u.plan.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
      <div className="bg-white rounded-2xl p-6 border border-black/[0.08] shadow-xs space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-black/[0.06]">
          <div>
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-gray-900" />
              <h2 className="text-lg font-bold text-gray-950">User Management</h2>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Overview of 12,480 registered accounts and subscription tiers
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search user email or name..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-9 pl-8 pr-3 text-xs rounded-xl bg-gray-50 border border-black/[0.08] text-gray-900 w-60"
              />
            </div>
            <button
              type="button"
              onClick={() => toast.info("Demo Action: Invite User")}
              className="h-9 px-3 bg-black text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Invite User</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-black/[0.06] text-gray-400 font-semibold uppercase text-[10px]">
                <th className="pb-3">User</th>
                <th className="pb-3">Plan</th>
                <th className="pb-3">Projects</th>
                <th className="pb-3">Credits</th>
                <th className="pb-3">Joined Date</th>
                <th className="pb-3">Status</th>
                <th className="pb-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.04]">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50/80 transition-colors">
                  <td className="py-3.5">
                    <p className="font-bold text-gray-950">{u.name}</p>
                    <p className="text-[10px] text-gray-400">{u.email}</p>
                  </td>
                  <td className="py-3.5">
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-gray-100 border border-black/[0.06]">
                      {u.plan}
                    </span>
                  </td>
                  <td className="py-3.5 font-bold">{u.projectsCount}</td>
                  <td className="py-3.5 font-mono text-gray-700">{u.creditsRemaining}</td>
                  <td className="py-3.5 text-gray-400">{u.joinedDate}</td>
                  <td className="py-3.5">
                    <span
                      className={`px-2 py-0.5 text-[10px] font-semibold rounded-full ${
                        u.status === "Active"
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td className="py-3.5 text-right">
                    <button
                      type="button"
                      onClick={() => toast.info(`User settings for ${u.name} (Demo)`)}
                      className="p-1.5 text-gray-400 hover:text-black rounded-lg"
                    >
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (section === "Audit Logs") {
    return (
      <div className="bg-white rounded-2xl p-6 border border-black/[0.08] shadow-xs space-y-5">
        <div className="flex items-center justify-between pb-4 border-b border-black/[0.06]">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-gray-900" />
            <h2 className="text-lg font-bold text-gray-950">Administrative Audit Trail</h2>
          </div>
          <span className="px-2 py-0.5 text-[10px] font-bold bg-gray-100 text-gray-600 rounded-md">
            Immutable Audit Trail (Demo)
          </span>
        </div>

        <div className="space-y-3">
          {MOCK_AUDIT_LOGS.map((log) => (
            <div
              key={log.id}
              className="p-4 rounded-xl border border-black/[0.06] bg-gray-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
            >
              <div>
                <div className="flex items-center gap-2 font-bold text-gray-950">
                  <span>{log.action}</span>
                  <span className="text-[10px] text-gray-400 font-normal">
                    by {log.actor}
                  </span>
                </div>
                <p className="text-gray-500 mt-1">{log.details}</p>
              </div>

              <div className="flex items-center gap-4 text-gray-400 text-[11px] shrink-0">
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
      <div className="bg-white rounded-2xl p-6 border border-black/[0.08] shadow-xs space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-black/[0.06]">
          <div>
            <h2 className="text-lg font-bold text-gray-950">Platform Settings & Controls</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Global system defaults, AI model providers, and rate limits
            </p>
          </div>
          <button
            type="button"
            onClick={() => toast.success("Settings saved (Demo)")}
            className="px-4 py-2 bg-black text-white text-xs font-semibold rounded-xl flex items-center gap-2 shadow-sm cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Save Changes</span>
          </button>
        </div>

        <div className="space-y-5 text-xs text-gray-800">
          <div className="p-4 rounded-xl border border-black/[0.06] bg-gray-50/50 space-y-2">
            <h3 className="font-bold text-sm text-gray-950">Default AI Model</h3>
            <p className="text-gray-500">
              Select default model for newly initialized prompt generation runs.
            </p>
            <select className="mt-2 h-9 px-3 rounded-xl border border-black/[0.1] bg-white text-xs font-semibold text-gray-900 w-full sm:w-72">
              <option>DeepSeek V4.1 Flash (Recommended)</option>
              <option>Claude 3.5 Sonnet</option>
              <option>Gemini 1.5 Pro</option>
              <option>GPT-4o</option>
            </select>
          </div>

          <div className="p-4 rounded-xl border border-black/[0.06] bg-gray-50/50 space-y-3">
            <h3 className="font-bold text-sm text-gray-950">System Mode & Feature Flags</h3>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="font-semibold text-gray-900">Vercel Publishing Deployments</p>
                <p className="text-[11px] text-gray-400">
                  Allow one-click custom domain publishing to *.mavly.xyz
                </p>
              </div>
              <input type="checkbox" defaultChecked className="w-4 h-4 accent-black" />
            </div>

            <div className="flex items-center justify-between py-1 border-t border-black/[0.04]">
              <div>
                <p className="font-semibold text-gray-900">GitHub Synchronization Integration</p>
                <p className="text-[11px] text-gray-400">
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
    <div className="bg-white rounded-2xl p-8 border border-black/[0.08] shadow-xs text-center space-y-3">
      <div className="w-12 h-12 rounded-2xl bg-gray-100 border border-black/[0.08] mx-auto flex items-center justify-center text-gray-700">
        <Sparkles className="w-6 h-6" />
      </div>
      <h2 className="text-lg font-bold text-gray-950">{section} Control Panel</h2>
      <p className="text-xs text-gray-500 max-w-md mx-auto">
        This panel is a frontend-only visual placeholder for the {section} administration module.
      </p>
      <div className="pt-2">
        <button
          type="button"
          onClick={() => toast.info(`Viewing ${section} analytics (Demo)`)}
          className="px-4 py-2 text-xs font-semibold bg-gray-100 hover:bg-gray-200 text-gray-900 rounded-xl transition-colors cursor-pointer"
        >
          Inspect {section} Metrics
        </button>
      </div>
    </div>
  );
}
