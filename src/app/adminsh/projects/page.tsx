"use client";

import React, { useState } from "react";
import {
  FolderGit2,
  Search,
  Filter,
  Globe,
  Eye,
  Trash2,
  ExternalLink,
  Sparkles,
  Layers,
  X,
  Calendar,
  CheckCircle2,
  AlertCircle,
  Clock,
  Copy,
  ArrowUpRight,
  Code2,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import { MOCK_PROJECTS_LIST } from "../components/mockData";
import { ProjectRecord } from "../components/types";

export default function ProjectsAdminPage() {
  const [projects, setProjects] = useState<ProjectRecord[]>(MOCK_PROJECTS_LIST);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [visibilityFilter, setVisibilityFilter] = useState("All");
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | null>(null);

  const filtered = projects.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.owner.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.domain && p.domain.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus = statusFilter === "All" || p.status === statusFilter;
    const matchesVisibility =
      visibilityFilter === "All" || p.visibility === visibilityFilter;

    return matchesSearch && matchesStatus && matchesVisibility;
  });

  const handleDeleteProject = (proj: ProjectRecord) => {
    setProjects((prev) => prev.filter((p) => p.id !== proj.id));
    toast.success(`Project deleted: ${proj.name}`, {
      description: "Removed from local frontend state.",
    });
  };

  const handleCopyProjectId = (id: string) => {
    navigator.clipboard?.writeText(id);
    toast.success(`Copied Project ID: ${id}`);
  };

  const getStatusBadge = (status: ProjectRecord["status"]) => {
    switch (status) {
      case "Ready":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-success-subtle text-success-subtle-foreground border border-success/25 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            Ready
          </span>
        );
      case "Building":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--clay-sunken)] text-foreground border border-[var(--clay-line)] font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
            Building
          </span>
        );
      case "Failed":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-destructive-subtle text-destructive-subtle-foreground border border-destructive/25 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
            Failed
          </span>
        );
    }
  };

  return (
    <AdminShell activeNav="Projects">
      {/* 1. Projects Statistics Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Total Projects</span>
            <FolderGit2 className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">16,840</h3>
          <p className="text-[11px] text-muted-foreground mt-1">Across all workspace tenants</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Weekly Velocity</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-success" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">+420</h3>
          <div className="flex items-center gap-1 mt-1 text-[11px] text-success font-medium">
            <span>+18.4% acceleration</span>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Deployed & Live</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-success" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-success font-mono mt-1">16,210</h3>
          <p className="text-[11px] text-muted-foreground mt-1">96.2% operational health</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Custom Domains</span>
            <Globe className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">1,890</h3>
          <p className="text-[11px] text-muted-foreground mt-1">Auto-SSL on mavly.xyz</p>
        </div>
      </div>

      {/* 2. Projects Table & Filter Toolbar */}
      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-[var(--clay-line)]">
          {/* Segmented Status Tabs */}
          <div className="flex flex-wrap items-center gap-1 bg-[var(--clay-sunken)] p-0.5 rounded-lg border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
            {["All", "Ready", "Building", "Failed"].map((st) => (
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
                placeholder="Search project, owner, domain..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-8 pl-8 pr-3 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground placeholder:text-muted-foreground focus:bg-card focus:outline-none focus:ring-1 focus:ring-black shadow-[var(--clay-well-1)]"
              />
            </div>

            <select
              value={visibilityFilter}
              onChange={(e) => setVisibilityFilter(e.target.value)}
              className="h-8 px-2.5 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground focus:bg-card focus:outline-none shadow-[var(--clay-well-1)]"
            >
              <option value="All">All Visibility</option>
              <option value="Custom Domain">Custom Domain</option>
              <option value="Preview URL">Preview URL</option>
              <option value="Draft">Draft</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--clay-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                <th className="pb-3">Project Title & ID</th>
                <th className="pb-3">Workspace Owner</th>
                <th className="pb-3">Model Engine</th>
                <th className="pb-3 text-center">Status</th>
                <th className="pb-3">Visibility / URL</th>
                <th className="pb-3 text-right">Routes</th>
                <th className="pb-3 text-right">Last Updated</th>
                <th className="pb-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--clay-line)]">
              {filtered.length > 0 ? (
                filtered.map((proj) => (
                  <tr key={proj.id} className="hover:bg-[var(--clay-sunken)] transition-colors">
                    <td className="py-3.5">
                      <div className="flex items-center gap-1.5">
                        <p className="font-semibold text-foreground">{proj.name}</p>
                        <button
                          type="button"
                          onClick={() => handleCopyProjectId(proj.id)}
                          className="p-1 text-muted-foreground hover:text-black transition-colors"
                          title="Copy ID"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>
                      <p className="text-[10px] font-mono text-muted-foreground">{proj.id}</p>
                    </td>
                    <td className="py-3.5">
                      <p className="font-medium text-foreground">{proj.owner}</p>
                      <p className="text-[11px] text-muted-foreground">{proj.ownerEmail}</p>
                    </td>
                    <td className="py-3.5">
                      <span className="font-mono text-[11px] text-foreground bg-[var(--clay-sunken)] px-2 py-0.5 rounded border border-[var(--clay-line)]">
                        {proj.model}
                      </span>
                    </td>
                    <td className="py-3.5 text-center">{getStatusBadge(proj.status)}</td>
                    <td className="py-3.5">
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground">
                        <Globe className="w-3 h-3 text-muted-foreground" />
                        {proj.domain || "Local Draft"}
                      </span>
                    </td>
                    <td className="py-3.5 text-right font-mono font-bold text-foreground">{proj.pagesCount}</td>
                    <td className="py-3.5 text-right text-muted-foreground whitespace-nowrap">{proj.lastUpdated}</td>
                    <td className="py-3.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setSelectedProject(proj)}
                          className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-md transition-colors"
                        >
                          Inspect
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            toast.info(`Opening preview sandbox for "${proj.name}" (Demo)`)
                          }
                          className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                          title="Preview App"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteProject(proj)}
                          className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                          title="Delete Project"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted-foreground text-xs">
                    No projects found matching your query.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Project Detail Dialog */}
      {selectedProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--clay-scrim)] backdrop-blur-[3px] animate-in fade-in">
          <div className="w-full max-w-md bg-card rounded-2xl border border-[var(--clay-line)] shadow-[var(--clay-float)] p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--clay-line)]">
              <div className="flex items-center gap-2">
                <FolderGit2 className="w-4 h-4 text-foreground" />
                <div>
                  <h3 className="text-sm font-bold text-foreground">{selectedProject.name}</h3>
                  <p className="text-[10px] font-mono text-muted-foreground">{selectedProject.id}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedProject(null)}
                className="p-1 text-muted-foreground hover:text-black rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs">
              <div className="grid grid-cols-2 gap-2 bg-[var(--clay-sunken)] p-3 rounded-xl border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
                <div>
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Owner</span>
                  <span className="font-semibold text-foreground">{selectedProject.owner}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Status</span>
                  <span>{getStatusBadge(selectedProject.status)}</span>
                </div>
                <div className="mt-1">
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Framework</span>
                  <span className="font-mono text-foreground">Next.js 16 (App Router)</span>
                </div>
                <div className="mt-1">
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">AI Engine</span>
                  <span className="font-mono text-foreground">{selectedProject.model}</span>
                </div>
                <div className="mt-1">
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Routes Count</span>
                  <span className="font-mono font-bold text-foreground">{selectedProject.pagesCount} pages</span>
                </div>
                <div className="mt-1">
                  <span className="text-muted-foreground block text-[10px] uppercase font-bold">Domain Binding</span>
                  <span className="font-mono text-foreground">{selectedProject.domain || "Draft Preview"}</span>
                </div>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-end gap-2 border-t border-[var(--clay-line)]">
              <button
                type="button"
                onClick={() => setSelectedProject(null)}
                className="px-4 py-1.5 bg-black text-white text-xs font-semibold rounded-lg shadow-[var(--clay-elev-ink-1)]"
              >
                Close Drawer
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
