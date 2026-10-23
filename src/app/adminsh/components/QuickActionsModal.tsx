"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  Megaphone,
  Users,
  AlertOctagon,
  CreditCard,
  X,
  Send,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { AdminNavSection } from "./types";

interface QuickActionsProps {
  onSelectNav?: (nav: AdminNavSection) => void;
}

export function QuickActionsModal({ onSelectNav }: QuickActionsProps) {
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [announcementTitle, setAnnouncementTitle] = useState("");
  const [announcementContent, setAnnouncementContent] = useState("");
  const [targetPlan, setTargetPlan] = useState("All Plans");

  const handlePostAnnouncement = (e: React.FormEvent) => {
    e.preventDefault();
    if (!announcementTitle.trim()) {
      toast.error("Please enter an announcement title.");
      return;
    }

    toast.success(`Announcement Broadcasted: "${announcementTitle}"`, {
      description: `Targeting: ${targetPlan}. (Frontend Simulation)`,
    });

    setAnnouncementTitle("");
    setAnnouncementContent("");
    setShowAnnouncementModal(false);
  };

  return (
    <>
      {/* ── Quick Action Command Bar ── */}
      <div className="bg-white rounded-2xl p-5 sm:p-6 border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-black/[0.06]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-black text-white">
              <Sparkles className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-gray-950">Administrative Shortcuts</h2>
          </div>
          <span className="text-xs text-gray-400 font-medium">Direct Suite Routing</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <button
            type="button"
            onClick={() => setShowAnnouncementModal(true)}
            className="p-4 rounded-xl border border-black/[0.06] bg-gray-50/70 hover:bg-black hover:text-white group transition-all text-left flex flex-col justify-between h-24 cursor-pointer"
          >
            <div className="flex items-center justify-between w-full">
              <Megaphone className="w-5 h-5 text-amber-500 group-hover:text-white transition-colors" />
              <ArrowRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <div>
              <p className="text-xs font-bold text-gray-900 group-hover:text-white">
                Broadcast Announcement
              </p>
              <p className="text-[10px] text-gray-400 group-hover:text-white/70">
                Trigger workspace alert banner
              </p>
            </div>
          </button>

          <Link
            href="/adminsh/users"
            className="p-4 rounded-xl border border-black/[0.06] bg-gray-50/70 hover:bg-black hover:text-white group transition-all text-left flex flex-col justify-between h-24 cursor-pointer"
          >
            <div className="flex items-center justify-between w-full">
              <Users className="w-5 h-5 text-blue-500 group-hover:text-white transition-colors" />
              <ArrowRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <div>
              <p className="text-xs font-bold text-gray-900 group-hover:text-white">
                User Management
              </p>
              <p className="text-[10px] text-gray-400 group-hover:text-white/70">
                Directory of 12,480 accounts
              </p>
            </div>
          </Link>

          <Link
            href="/adminsh/generation-monitor"
            className="p-4 rounded-xl border border-black/[0.06] bg-gray-50/70 hover:bg-black hover:text-white group transition-all text-left flex flex-col justify-between h-24 cursor-pointer"
          >
            <div className="flex items-center justify-between w-full">
              <AlertOctagon className="w-5 h-5 text-rose-500 group-hover:text-white transition-colors" />
              <ArrowRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <div>
              <p className="text-xs font-bold text-gray-900 group-hover:text-white">
                Build Queue Monitor
              </p>
              <p className="text-[10px] text-gray-400 group-hover:text-white/70">
                Inspect 4 active workers
              </p>
            </div>
          </Link>

          <Link
            href="/adminsh/billing"
            className="p-4 rounded-xl border border-black/[0.06] bg-gray-50/70 hover:bg-black hover:text-white group transition-all text-left flex flex-col justify-between h-24 cursor-pointer"
          >
            <div className="flex items-center justify-between w-full">
              <CreditCard className="w-5 h-5 text-emerald-500 group-hover:text-white transition-colors" />
              <ArrowRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <div>
              <p className="text-xs font-bold text-gray-900 group-hover:text-white">
                Revenue &amp; Invoices
              </p>
              <p className="text-[10px] text-gray-400 group-hover:text-white/70">
                Track ₹8.42L MRR performance
              </p>
            </div>
          </Link>
        </div>
      </div>

      {/* ── Broadcast Announcement Modal ── */}
      {showAnnouncementModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-black/[0.08] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-black/[0.06]">
              <div className="flex items-center gap-2">
                <Megaphone className="w-4 h-4 text-amber-500" />
                <h3 className="text-base font-bold text-gray-950">
                  Broadcast Workspace Notice
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAnnouncementModal(false)}
                className="p-1 text-gray-400 hover:text-black rounded-lg hover:bg-black/5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handlePostAnnouncement} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-gray-700 mb-1">
                  Announcement Headline
                </label>
                <input
                  type="text"
                  placeholder="e.g. Scheduled Supabase region maintenance on Sunday"
                  value={announcementTitle}
                  onChange={(e) => setAnnouncementTitle(e.target.value)}
                  className="w-full h-9 px-3 text-xs rounded-xl border border-black/[0.1] focus:ring-2 focus:ring-black text-gray-900"
                />
              </div>

              <div>
                <label className="block font-semibold text-gray-700 mb-1">
                  Target Plan Tier
                </label>
                <select
                  value={targetPlan}
                  onChange={(e) => setTargetPlan(e.target.value)}
                  className="w-full h-9 px-3 text-xs rounded-xl border border-black/[0.1] bg-white text-gray-900"
                >
                  <option>All Plans (Global)</option>
                  <option>Pro &amp; Agency Users Only</option>
                  <option>Free Tier Users Only</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-gray-700 mb-1">
                  Message Details
                </label>
                <textarea
                  rows={3}
                  placeholder="Enter notice details for platform tenants..."
                  value={announcementContent}
                  onChange={(e) => setAnnouncementContent(e.target.value)}
                  className="w-full p-3 text-xs rounded-xl border border-black/[0.1] focus:ring-2 focus:ring-black text-gray-900"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAnnouncementModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-bold text-white bg-black hover:bg-neutral-800 rounded-xl flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Broadcast Notice</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
