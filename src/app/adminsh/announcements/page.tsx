"use client";

import React, { useState } from "react";
import {
  Megaphone,
  PlusCircle,
  Search,
  Filter,
  Info,
  CheckCircle2,
  AlertTriangle,
  Wrench,
  Calendar,
  Eye,
  Trash2,
  Edit3,
  X,
  Sparkles,
  Send,
  Users,
  Clock,
  Radio,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import { MOCK_ANNOUNCEMENTS_LIST } from "../components/mockData";
import { AnnouncementRecord } from "../components/types";

export default function AnnouncementsAdminPage() {
  const [announcements, setAnnouncements] = useState<AnnouncementRecord[]>(
    MOCK_ANNOUNCEMENTS_LIST
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All");

  // Create Modal
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newType, setNewType] = useState<AnnouncementRecord["type"]>("Information");
  const [newTargetPlan, setNewTargetPlan] = useState("All Plans");
  const [newDismissible, setNewDismissible] = useState(true);

  // Preview target
  const [previewItem, setPreviewItem] = useState<AnnouncementRecord | null>(
    MOCK_ANNOUNCEMENTS_LIST[0] || null
  );

  const filtered = announcements.filter((item) => {
    const matchesSearch =
      item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.targetPlan.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === "All" || item.status === statusFilter;
    const matchesType = typeFilter === "All" || item.type === typeFilter;

    return matchesSearch && matchesStatus && matchesType;
  });

  const handleCreateAnnouncement = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) {
      toast.error("Please enter both title and announcement content.");
      return;
    }

    const created: AnnouncementRecord = {
      id: `ANN-${Math.floor(200 + Math.random() * 800)}`,
      title: newTitle,
      content: newContent,
      type: newType,
      status: "Published",
      targetPlan: newTargetPlan,
      startDate: "Today",
      expiryDate: "In 14 days",
      dismissible: newDismissible,
    };

    setAnnouncements((prev) => [created, ...prev]);
    setPreviewItem(created);
    setIsCreateModalOpen(false);
    setNewTitle("");
    setNewContent("");

    toast.success(`Announcement broadcast published!`, {
      description: `"${created.title}" is now active for users.`,
    });
  };

  const handleDelete = (id: string, title: string) => {
    setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    if (previewItem?.id === id) {
      setPreviewItem(null);
    }
    toast.success(`Deleted broadcast: "${title}"`);
  };

  const handleToggleStatus = (id: string) => {
    setAnnouncements((prev) =>
      prev.map((a) => {
        if (a.id === id) {
          const nextStatus = a.status === "Published" ? "Draft" : "Published";
          toast.info(`Updated status to ${nextStatus}`, {
            description: `"${a.title}" is now ${nextStatus}.`,
          });
          return { ...a, status: nextStatus };
        }
        return a;
      })
    );
  };

  const getTypeBadge = (type: AnnouncementRecord["type"]) => {
    switch (type) {
      case "Information":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200/60 font-mono">
            <Info className="w-3 h-3 text-blue-600" />
            Information
          </span>
        );
      case "Success":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-mono">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
            Success
          </span>
        );
      case "Warning":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200/60 font-mono">
            <AlertTriangle className="w-3 h-3 text-amber-600" />
            Warning
          </span>
        );
      case "Maintenance":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-purple-50 text-purple-700 border border-purple-200/60 font-mono">
            <Wrench className="w-3 h-3 text-purple-600" />
            Maintenance
          </span>
        );
    }
  };

  const getStatusBadge = (status: AnnouncementRecord["status"]) => {
    switch (status) {
      case "Published":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Published
          </span>
        );
      case "Scheduled":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200/60 font-mono">
            <Clock className="w-3 h-3" />
            Scheduled
          </span>
        );
      case "Draft":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--neu-sunken)] text-foreground border border-[var(--neu-line)] font-mono">
            Draft
          </span>
        );
      case "Expired":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200/60 font-mono">
            Expired
          </span>
        );
    }
  };

  return (
    <AdminShell activeNav="Announcements">
      {/* 1. Header Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Total Broadcasts</span>
            <Megaphone className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">{announcements.length}</h3>
          <p className="text-[11px] text-muted-foreground mt-1">Managed across all channels</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Live in Workspaces</span>
            <Radio className="w-3.5 h-3.5 text-emerald-600" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-emerald-700 font-mono mt-1">
            {announcements.filter((a) => a.status === "Published").length}
          </h3>
          <p className="text-[11px] text-muted-foreground mt-1">Active customer banners</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Scheduled</span>
            <Clock className="w-3.5 h-3.5 text-blue-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">
            {announcements.filter((a) => a.status === "Scheduled").length}
          </h3>
          <p className="text-[11px] text-muted-foreground mt-1">Upcoming maintenance windows</p>
        </div>

        <div className="p-4 rounded-xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span>Drafts</span>
            <Edit3 className="w-3.5 h-3.5 text-purple-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground font-mono mt-1">
            {announcements.filter((a) => a.status === "Draft").length}
          </h3>
          <p className="text-[11px] text-muted-foreground mt-1">Pending copy review</p>
        </div>
      </div>

      {/* 2. End-User Workspace Live Banner Simulator */}
      {previewItem && (
        <div className="p-5 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)] space-y-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-muted-foreground" />
              <h4 className="font-semibold text-foreground uppercase tracking-wider text-[11px]">
                End-User Workspace Banner Simulator
              </h4>
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">
              Target Audience: {previewItem.targetPlan}
            </span>
          </div>

          <div
            className={`p-3.5 rounded-xl border flex items-start justify-between gap-3 text-xs ${
              previewItem.type === "Information"
                ? "bg-blue-50/60 border-blue-200 text-blue-950"
                : previewItem.type === "Success"
                ? "bg-emerald-50/60 border-emerald-200 text-emerald-950"
                : previewItem.type === "Warning"
                ? "bg-amber-50/60 border-amber-200 text-amber-950"
                : "bg-purple-50/60 border-purple-200 text-purple-950"
            }`}
          >
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5">
                {previewItem.type === "Information" && <Info className="w-4 h-4 text-blue-600" />}
                {previewItem.type === "Success" && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
                {previewItem.type === "Warning" && <AlertTriangle className="w-4 h-4 text-amber-600" />}
                {previewItem.type === "Maintenance" && <Wrench className="w-4 h-4 text-purple-600" />}
              </div>
              <div>
                <p className="font-semibold text-foreground">{previewItem.title}</p>
                <p className="text-foreground mt-0.5 leading-relaxed">{previewItem.content}</p>
              </div>
            </div>

            {previewItem.dismissible && (
              <span className="p-1 text-muted-foreground hover:text-black cursor-pointer font-bold">
                ✕
              </span>
            )}
          </div>
        </div>
      )}

      {/* 3. Search, Filter & Action Bar */}
      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-[var(--neu-line)]">
          {/* Segmented Filter */}
          <div className="flex flex-wrap items-center gap-1 bg-[var(--neu-sunken)] p-0.5 rounded-lg border border-[var(--neu-line)] text-xs">
            {["All", "Published", "Scheduled", "Draft", "Expired"].map((st) => (
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

          <div className="flex items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search announcements..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-8 pl-8 pr-3 text-xs rounded-lg bg-[var(--neu-sunken)] border border-[var(--neu-line)] text-foreground placeholder:text-muted-foreground focus:bg-card focus:outline-none focus:ring-1 focus:ring-black"
              />
            </div>

            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-primary hover:bg-[var(--neu-brand-hover)] rounded-lg transition-colors shadow-xs"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>New Announcement</span>
            </button>
          </div>
        </div>

        {/* 4. Announcements Grid */}
        <div className="space-y-3">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-xs">
              No announcements match your search criteria.
            </div>
          ) : (
            filtered.map((item) => (
              <div
                key={item.id}
                className="p-4 rounded-xl border border-[var(--neu-line)] hover:border-black/20 transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div className="space-y-1.5 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] font-semibold text-muted-foreground">
                      {item.id}
                    </span>
                    {getStatusBadge(item.status)}
                    {getTypeBadge(item.type)}
                    <span className="text-[11px] text-muted-foreground font-medium flex items-center gap-1 font-mono">
                      <Users className="w-3 h-3 text-muted-foreground" />
                      {item.targetPlan}
                    </span>
                  </div>

                  <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                  <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                    {item.content}
                  </p>

                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground pt-0.5">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      Active: {item.startDate} – {item.expiryDate}
                    </span>
                    <span>·</span>
                    <span>{item.dismissible ? "User Dismissible" : "Sticky Header"}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                  <button
                    onClick={() => setPreviewItem(item)}
                    className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--neu-sunken)] hover:bg-[var(--neu-sunken-deep)] rounded-md transition-colors"
                  >
                    Simulate
                  </button>

                  <button
                    onClick={() => handleToggleStatus(item.id)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
                      item.status === "Published"
                        ? "text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200"
                        : "text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200"
                    }`}
                  >
                    {item.status === "Published" ? "Unpublish" : "Publish"}
                  </button>

                  <button
                    onClick={() => handleDelete(item.id, item.title)}
                    className="p-1.5 text-muted-foreground hover:text-rose-600 transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Create Announcement Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="bg-card rounded-2xl max-w-lg w-full border border-black/[0.1] shadow-2xl p-6 relative space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--neu-line)]">
              <div className="flex items-center gap-2">
                <Megaphone className="w-4 h-4 text-foreground" />
                <h3 className="text-sm font-bold text-foreground">Broadcast Announcement</h3>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1 rounded-lg text-muted-foreground hover:text-black"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateAnnouncement} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-foreground mb-1">
                  Announcement Title
                </label>
                <input
                  type="text"
                  placeholder="e.g. Major Platform Upgrade: DeepSeek V4.1 Ready"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full px-3 py-2 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-xl focus:outline-none focus:bg-card"
                />
              </div>

              <div>
                <label className="block font-semibold text-foreground mb-1">
                  Content Message
                </label>
                <textarea
                  rows={3}
                  placeholder="Describe the upgrade, maintenance schedule, or notice..."
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  className="w-full px-3 py-2 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-xl focus:outline-none focus:bg-card leading-relaxed"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-foreground mb-1">
                    Banner Style
                  </label>
                  <select
                    value={newType}
                    onChange={(e) =>
                      setNewType(e.target.value as AnnouncementRecord["type"])
                    }
                    className="w-full px-3 py-2 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-xl focus:outline-none focus:bg-card"
                  >
                    <option value="Information">Information (Blue)</option>
                    <option value="Success">Success (Green)</option>
                    <option value="Warning">Warning (Amber)</option>
                    <option value="Maintenance">Maintenance (Purple)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-foreground mb-1">
                    Target User Plan
                  </label>
                  <select
                    value={newTargetPlan}
                    onChange={(e) => setNewTargetPlan(e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-xl focus:outline-none focus:bg-card"
                  >
                    <option value="All Plans">All Plans (Global)</option>
                    <option value="Free Tier">Free Tier Only</option>
                    <option value="Pro & Agency">Pro & Agency Only</option>
                    <option value="Agency Tier">Agency Tier</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="dismissibleCheck"
                  checked={newDismissible}
                  onChange={(e) => setNewDismissible(e.target.checked)}
                  className="rounded border-[var(--neu-line-strong)] text-black focus:ring-black"
                />
                <label htmlFor="dismissibleCheck" className="text-foreground font-medium">
                  Allow users to dismiss banner with close icon
                </label>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2 border-t border-[var(--neu-line)]">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-3.5 py-1.5 text-xs font-medium text-foreground bg-[var(--neu-sunken)] hover:bg-[var(--neu-sunken-deep)] rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-semibold text-white bg-primary hover:bg-[var(--neu-brand-hover)] rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Publish Broadcast</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
