"use client";

import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderGit2,
  Globe,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import type {
  AdminProjectDirectoryResponse,
  AdminProjectDirectoryRow,
  AdminProjectGenerationStatus,
} from "@/lib/admin/directory";

const PROJECTS_PER_PAGE = 10;

const STATUS_FILTERS: Array<{ value: AdminProjectGenerationStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

function formatDate(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function safeHttpsUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export default function ProjectsAdminPage() {
  const [directory, setDirectory] = useState<AdminProjectDirectoryResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AdminProjectGenerationStatus>("all");
  const [visibilityFilter, setVisibilityFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedProject, setSelectedProject] = useState<AdminProjectDirectoryRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        search: searchQuery,
        status: statusFilter,
        visibility: visibilityFilter,
        page: String(currentPage),
        pageSize: String(PROJECTS_PER_PAGE),
      });

      try {
        const response = await fetch(`/api/adminsh/projects?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || !result.ok || !result.data) {
          throw new Error(result.error || "The project directory could not be loaded.");
        }
        setDirectory(result.data as AdminProjectDirectoryResponse);
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setDirectory(null);
        setError(
          requestError instanceof Error
            ? requestError.message
            : "The project directory could not be loaded."
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, statusFilter, visibilityFilter, currentPage, refreshKey]);

  const projects = directory?.rows ?? [];
  const total = directory?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PROJECTS_PER_PAGE));
  const metrics = directory?.metrics;

  const getStatusBadge = (status: AdminProjectDirectoryRow["generationStatus"]) => {
    const label = status === "no_run"
      ? "No run"
      : status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    const isFailure = status === "failed" || status === "interrupted";
    const isActive = status === "queued" || status === "running";
    const isCompleted = status === "completed";
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium border font-mono ${
          isFailure
            ? "bg-destructive-subtle text-destructive-subtle-foreground border-destructive/25"
            : isActive
              ? "bg-[var(--clay-sunken)] text-foreground border-[var(--clay-line)]"
              : isCompleted
                ? "bg-success-subtle text-success-subtle-foreground border-success/25"
                : "bg-[var(--clay-sunken)] text-muted-foreground border-[var(--clay-line)]"
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${isFailure ? "bg-destructive" : isActive ? "bg-warning" : isCompleted ? "bg-success" : "bg-muted-foreground"}`} />
        {label}
      </span>
    );
  };

  const copyProjectId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      toast.success("Project ID copied");
    } catch {
      toast.error("Project ID could not be copied.");
    }
  };

  return (
    <AdminShell activeNav="Projects">
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {[
          ["Total Projects", metrics?.total, "Across all workspaces"],
          [
            "Created in Last 7 Days",
            metrics?.createdLast7Days,
            metrics ? `${metrics.createdThisMonth.toLocaleString()} created this month` : "Recorded project creation",
          ],
          ["Published Records", metrics?.published, "Active version or recorded ready state"],
          ["Verified Mavly Domains", metrics?.verifiedMavlyDomains, "Verified mavly.xyz hostname"],
        ].map(([label, value, description]) => (
          <div
            key={String(label)}
            className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]"
          >
            <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
              <span>{label}</span>
              {label === "Created in Last 7 Days" ? (
                <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground" />
              ) : label === "Published Records" ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-success" />
              ) : label === "Verified Mavly Domains" ? (
                <Globe className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <FolderGit2 className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </div>
            <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">
              {loading && value === undefined ? "…" : typeof value === "number" ? value.toLocaleString() : "—"}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-1">
              {error ? "Unavailable" : description}
            </p>
          </div>
        ))}
      </div>

      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-[var(--clay-line)]">
          <div className="flex flex-wrap items-center gap-1 bg-[var(--clay-sunken)] p-0.5 rounded-lg border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
            {STATUS_FILTERS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setStatusFilter(value);
                  setCurrentPage(1);
                }}
                className={`px-3 py-1 rounded-md text-xs transition-all ${
                  statusFilter === value
                    ? "bg-card text-foreground shadow-[var(--clay-elev-1)] font-semibold"
                    : "text-muted-foreground hover:text-foreground font-medium"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                maxLength={120}
                placeholder="Search project, owner, domain..."
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setCurrentPage(1);
                }}
                className="w-full h-8 pl-8 pr-3 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground placeholder:text-muted-foreground focus:bg-card focus:outline-none focus:ring-1 focus:ring-black shadow-[var(--clay-well-1)]"
              />
            </div>

            <label className="relative">
              <span className="sr-only">Filter project visibility</span>
              <select
                value={visibilityFilter}
                onChange={(event) => {
                  setVisibilityFilter(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-8 appearance-none pl-2.5 pr-7 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground focus:bg-card focus:outline-none shadow-[var(--clay-well-1)]"
              >
                <option value="all">All Visibility</option>
                <option value="custom_domain">Verified Mavly Domain</option>
                <option value="preview_url">Published URL</option>
                <option value="draft">Draft</option>
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            </label>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-destructive/25 bg-destructive-subtle px-4 py-3 text-xs text-destructive-subtle-foreground" role="alert">
            <div className="flex items-center justify-between gap-3">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setRefreshKey((value) => value + 1)}
                className="font-semibold underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--clay-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                <th className="pb-3">Project Title &amp; ID</th>
                <th className="pb-3">Workspace Owner</th>
                <th className="pb-3">Model Engine</th>
                <th className="pb-3 text-center">Generation Status</th>
                <th className="pb-3">Visibility / URL</th>
                <th className="pb-3 text-right">Routes</th>
                <th className="pb-3 text-right">Last Updated</th>
                <th className="pb-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--clay-line)]">
              {projects.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted-foreground text-xs">
                    {loading ? "Loading projects…" : error ? "Project records are unavailable." : "No projects match your query."}
                  </td>
                </tr>
              ) : (
                projects.map((project) => {
                  const publishedUrl = safeHttpsUrl(project.publishedUrl);
                  return (
                    <tr key={project.id} className="hover:bg-[var(--clay-sunken)] transition-colors">
                      <td className="py-3.5">
                        <div className="flex items-center gap-1.5">
                          <p className="font-semibold text-foreground">{project.name ?? "Name not recorded"}</p>
                          <button
                            type="button"
                            onClick={() => void copyProjectId(project.id)}
                            className="p-1 text-muted-foreground hover:text-black transition-colors"
                            title="Copy ID"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        </div>
                        <p className="text-[10px] font-mono text-muted-foreground">{project.id}</p>
                      </td>
                      <td className="py-3.5">
                        <p className="font-medium text-foreground">{project.owner ?? "Name not recorded"}</p>
                        <p className="text-[11px] text-muted-foreground">{project.ownerEmail ?? "No email recorded"}</p>
                      </td>
                      <td className="py-3.5">
                        <span className="font-mono text-[11px] text-foreground bg-[var(--clay-sunken)] px-2 py-0.5 rounded border border-[var(--clay-line)]">
                          {project.model ?? "Not recorded"}
                        </span>
                      </td>
                      <td className="py-3.5 text-center">{getStatusBadge(project.generationStatus)}</td>
                      <td className="py-3.5">
                        {publishedUrl ? (
                          <a
                            href={publishedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground hover:underline"
                          >
                            <Globe className="w-3 h-3 text-muted-foreground" />
                            {new URL(publishedUrl).hostname}
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                            <Globe className="w-3 h-3" />
                            {project.visibility === "draft" ? "Draft" : "URL unavailable"}
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 text-right font-mono text-muted-foreground" title="Route counts are not persisted">
                        Not recorded
                      </td>
                      <td className="py-3.5 text-right text-muted-foreground whitespace-nowrap">{formatDate(project.updatedAt)}</td>
                      <td className="py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setSelectedProject(project)}
                            className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-md transition-colors"
                          >
                            Inspect
                          </button>
                          {publishedUrl ? (
                            <a
                              href={publishedUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                              title="Open recorded published URL"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          ) : (
                            <button
                              type="button"
                              disabled
                              title="No safe published URL is recorded"
                              className="p-1 text-muted-foreground opacity-40 cursor-not-allowed"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            disabled
                            title="Project deletion is not supported"
                            className="p-1 text-muted-foreground opacity-40 cursor-not-allowed"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-[var(--clay-line)] text-xs text-muted-foreground">
          <span>
            Showing {total === 0 ? 0 : (currentPage - 1) * PROJECTS_PER_PAGE + 1} to{" "}
            {Math.min(currentPage * PROJECTS_PER_PAGE, total)} of {total.toLocaleString()} projects
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={currentPage === 1 || loading}
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              className="p-1.5 rounded-lg border border-[var(--clay-line)] hover:bg-[var(--clay-sunken)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2.5 font-semibold text-foreground">{currentPage} / {totalPages}</span>
            <button
              type="button"
              disabled={currentPage >= totalPages || loading}
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              className="p-1.5 rounded-lg border border-[var(--clay-line)] hover:bg-[var(--clay-sunken)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {selectedProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--clay-scrim)] backdrop-blur-[3px] animate-in fade-in">
          <div className="w-full max-w-md bg-card rounded-2xl border border-[var(--clay-line)] shadow-[var(--clay-float)] p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--clay-line)]">
              <div className="flex items-center gap-2">
                <FolderGit2 className="w-4 h-4 text-foreground" />
                <div>
                  <h3 className="text-sm font-bold text-foreground">{selectedProject.name ?? "Name not recorded"}</h3>
                  <p className="text-[10px] font-mono text-muted-foreground">{selectedProject.id}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedProject(null)}
                aria-label="Close project details"
                className="p-1 text-muted-foreground hover:text-black rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
              <div><span className="text-muted-foreground block text-[10px] uppercase font-bold">Owner</span><span className="font-semibold text-foreground">{selectedProject.owner ?? "Name not recorded"}</span></div>
              <div><span className="text-muted-foreground block text-[10px] uppercase font-bold">Owner email</span><span className="break-all font-mono text-foreground">{selectedProject.ownerEmail ?? "Not recorded"}</span></div>
              <div><span className="text-muted-foreground block text-[10px] uppercase font-bold">Generation</span>{getStatusBadge(selectedProject.generationStatus)}</div>
              <div><span className="text-muted-foreground block text-[10px] uppercase font-bold">Model</span><span className="font-mono text-foreground">{selectedProject.model ?? "Not recorded"}</span></div>
              <div><span className="text-muted-foreground block text-[10px] uppercase font-bold">Published state</span><span className="font-mono text-foreground">{selectedProject.deploymentStatus}</span></div>
              <div><span className="text-muted-foreground block text-[10px] uppercase font-bold">Latest attempt</span><span className="font-mono text-foreground">{selectedProject.deploymentAttemptStatus ?? "Not recorded"}</span></div>
              <div><span className="text-muted-foreground block text-[10px] uppercase font-bold">Routes</span><span className="font-mono text-foreground">Not recorded</span></div>
              <div><span className="text-muted-foreground block text-[10px] uppercase font-bold">Visibility</span><span className="font-mono text-foreground">{selectedProject.visibility.replace(/_/g, " ")}</span></div>
              <div className="col-span-2"><span className="text-muted-foreground block text-[10px] uppercase font-bold">Last updated</span><span className="text-foreground">{formatDate(selectedProject.updatedAt)}</span></div>
              <div className="col-span-2"><span className="text-muted-foreground block text-[10px] uppercase font-bold">Created</span><span className="text-foreground">{formatDate(selectedProject.createdAt)}</span></div>
              {selectedProject.publishedUrl && (
                <div className="col-span-2"><span className="text-muted-foreground block text-[10px] uppercase font-bold">Recorded URL</span><span className="break-all font-mono text-foreground">{safeHttpsUrl(selectedProject.publishedUrl) ?? "Unavailable"}</span></div>
              )}
            </div>
            <div className="pt-2 flex items-center justify-end border-t border-[var(--clay-line)]">
              <button
                type="button"
                onClick={() => setSelectedProject(null)}
                className="px-4 py-1.5 bg-black text-white text-xs font-semibold rounded-lg shadow-[var(--clay-elev-ink-1)]"
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
