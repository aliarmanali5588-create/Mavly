"use client";

import React, { useState } from "react";
import {
  Users,
  Search,
  Filter,
  Plus,
  ShieldCheck,
  UserCheck,
  UserX,
  Trash2,
  Edit,
  Eye,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  X,
  CreditCard,
  FolderGit2,
  Mail,
  Calendar,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import { MOCK_USERS_LIST } from "../components/mockData";
import { UserRecord } from "../components/types";

export default function UsersAdminPage() {
  const [users, setUsers] = useState<UserRecord[]>(MOCK_USERS_LIST);
  const [searchQuery, setSearchQuery] = useState("");
  const [planFilter, setPlanFilter] = useState<string>("All");
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [currentPage, setCurrentPage] = useState(1);
  const usersPerPage = 5;

  // Selected User for details dialog
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);

  // Edit Plan Dialog
  const [editingPlanUser, setEditingPlanUser] = useState<UserRecord | null>(null);
  const [selectedNewPlan, setSelectedNewPlan] = useState<UserRecord["plan"]>("Pro");

  // Confirm Delete Dialog
  const [deletingUser, setDeletingUser] = useState<UserRecord | null>(null);

  // Invite User Modal
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [invitePlan, setInvitePlan] = useState<UserRecord["plan"]>("Starter");

  // Filtering
  const filteredUsers = users.filter((u) => {
    const matchesSearch =
      u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (u.role && u.role.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesPlan = planFilter === "All" || u.plan === planFilter;
    const matchesStatus = statusFilter === "All" || u.status === statusFilter;

    return matchesSearch && matchesPlan && matchesStatus;
  });

  // Pagination
  const totalPages = Math.ceil(filteredUsers.length / usersPerPage) || 1;
  const paginatedUsers = filteredUsers.slice(
    (currentPage - 1) * usersPerPage,
    currentPage * usersPerPage
  );

  // Actions
  const handleToggleStatus = (user: UserRecord) => {
    const nextStatus = user.status === "Active" ? "Suspended" : "Active";
    setUsers((prev) =>
      prev.map((u) => (u.id === user.id ? { ...u, status: nextStatus } : u))
    );
    toast.success(`Account status updated for ${user.name}`, {
      description: `Status changed to ${nextStatus} (Demo state only).`,
    });
  };

  const handleUpdatePlan = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPlanUser) return;
    setUsers((prev) =>
      prev.map((u) =>
        u.id === editingPlanUser.id ? { ...u, plan: selectedNewPlan } : u
      )
    );
    toast.success(`Plan updated for ${editingPlanUser.name}`, {
      description: `Plan switched to ${selectedNewPlan} (Demo only).`,
    });
    setEditingPlanUser(null);
  };

  const handleDeleteUser = () => {
    if (!deletingUser) return;
    setUsers((prev) => prev.filter((u) => u.id !== deletingUser.id));
    toast.success(`User removed: ${deletingUser.name}`, {
      description: "Record removed from local frontend state.",
    });
    setDeletingUser(null);
  };

  const handleInviteUser = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim() || !inviteName.trim()) {
      toast.error("Please provide both name and email.");
      return;
    }
    const newUser: UserRecord = {
      id: `usr-${Date.now().toString().slice(-4)}`,
      name: inviteName,
      email: inviteEmail,
      plan: invitePlan,
      projectsCount: 0,
      creditsRemaining: invitePlan === "Agency" ? 5000 : invitePlan === "Pro" ? 2000 : 500,
      joinedDate: "Today",
      status: "Active",
      role: "Invited Member",
      lastActive: "Just now",
    };
    setUsers([newUser, ...users]);
    toast.success(`Invitation Sent to ${inviteEmail}`, {
      description: `New demo account created with ${invitePlan} tier.`,
    });
    setInviteEmail("");
    setInviteName("");
    setShowInviteModal(false);
  };

  const getPlanBadge = (plan: UserRecord["plan"]) => {
    switch (plan) {
      case "Agency":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
            Agency
          </span>
        );
      case "Pro":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-black text-white">
            Pro
          </span>
        );
      case "Creator":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
            Creator
          </span>
        );
      case "Starter":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-800 border border-black/[0.08]">
            Starter
          </span>
        );
      case "Free":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-50 text-gray-500 border border-black/[0.05]">
            Free
          </span>
        );
    }
  };

  return (
    <AdminShell activeNav="Users">
      {/* ── Summary Counters Strip ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <p className="text-xs font-semibold text-gray-500 tracking-wide">Total Users</p>
          <h3 className="text-2xl sm:text-3xl font-extrabold text-gray-950 mt-1.5 font-mono">12,480</h3>
          <span className="text-[11px] text-emerald-600 font-semibold mt-2 inline-block">
            +14.2% growth this month
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <p className="text-xs font-semibold text-gray-500 tracking-wide">Active Tenants</p>
          <h3 className="text-2xl sm:text-3xl font-extrabold text-gray-950 mt-1.5 font-mono">9,840</h3>
          <span className="text-[11px] text-emerald-600 font-semibold mt-2 inline-block">
            Active in last 7 days
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <p className="text-xs font-semibold text-gray-500 tracking-wide">Paid Subscribers</p>
          <h3 className="text-2xl sm:text-3xl font-extrabold text-gray-950 mt-1.5 font-mono">2,840</h3>
          <span className="text-[11px] text-gray-400 font-medium mt-2 inline-block">
            22.7% paid conversion
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <p className="text-xs font-semibold text-gray-500 tracking-wide">Account Health SLA</p>
          <h3 className="text-2xl sm:text-3xl font-extrabold text-emerald-700 mt-1.5 font-mono">99.8%</h3>
          <span className="text-[11px] text-gray-400 font-medium mt-2 inline-block">
            16 suspended accounts
          </span>
        </div>
      </div>

      {/* ── Table & Command Bar Container ── */}
      <div className="bg-white rounded-2xl p-5 sm:p-6 border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
        {/* Controls Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-black/[0.06]">
          <div>
            <h2 className="text-base font-bold text-gray-950">Customer Directory</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Showing {filteredUsers.length} total matched customer accounts
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search user, email, role..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full h-8 pl-8 pr-3 text-xs rounded-xl bg-gray-50 border border-black/[0.08] text-gray-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>

            {/* Plan Filter */}
            <select
              value={planFilter}
              onChange={(e) => {
                setPlanFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="h-8 px-2.5 text-xs font-medium bg-gray-50 border border-black/[0.08] rounded-xl text-gray-800 focus:outline-none focus:ring-2 focus:ring-black cursor-pointer"
            >
              <option value="All">All Plans</option>
              <option value="Agency">Agency</option>
              <option value="Pro">Pro</option>
              <option value="Creator">Creator</option>
              <option value="Starter">Starter</option>
              <option value="Free">Free</option>
            </select>

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="h-8 px-2.5 text-xs font-medium bg-gray-50 border border-black/[0.08] rounded-xl text-gray-800 focus:outline-none focus:ring-2 focus:ring-black cursor-pointer"
            >
              <option value="All">All Statuses</option>
              <option value="Active">Active Only</option>
              <option value="Suspended">Suspended Only</option>
            </select>

            {/* Invite Button */}
            <button
              type="button"
              onClick={() => setShowInviteModal(true)}
              className="h-8 px-3 rounded-xl bg-black hover:bg-neutral-800 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Invite Member</span>
            </button>
          </div>
        </div>

        {/* ── High-Density Directory Table ── */}
        <div className="overflow-x-auto rounded-xl border border-black/[0.06]">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-gray-50/60 border-b border-black/[0.06] text-gray-400 font-bold uppercase tracking-wider text-[10px]">
                <th className="py-2.5 px-4">User</th>
                <th className="py-2.5 px-4">Role</th>
                <th className="py-2.5 px-4">Plan</th>
                <th className="py-2.5 px-4 text-center">Projects</th>
                <th className="py-2.5 px-4 text-right font-mono">Credits Remaining</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Last Active</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.04]">
              {paginatedUsers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-gray-400">
                    No users found matching your search or filters.
                  </td>
                </tr>
              ) : (
                paginatedUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-gray-900 text-white flex items-center justify-center font-bold text-[10px] shrink-0">
                          {user.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-bold text-gray-950 leading-tight">{user.name}</p>
                          <p className="text-[11px] text-gray-400 leading-tight">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-gray-600 font-medium">
                      {user.role || "Member"}
                    </td>
                    <td className="py-2.5 px-4">{getPlanBadge(user.plan)}</td>
                    <td className="py-2.5 px-4 text-center font-mono font-semibold text-gray-700">
                      {user.projectsCount}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono font-bold text-gray-950">
                      {user.creditsRemaining.toLocaleString()}
                    </td>
                    <td className="py-2.5 px-4">
                      {user.status === "Active" ? (
                        <span className="text-emerald-700 font-semibold text-xs flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          Active
                        </span>
                      ) : (
                        <span className="text-rose-600 font-semibold text-xs flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                          Suspended
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-gray-400 whitespace-nowrap">
                      {user.lastActive || "Recently"}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setSelectedUser(user)}
                          className="px-2 py-1 rounded-lg text-[11px] font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPlanUser(user);
                            setSelectedNewPlan(user.plan);
                          }}
                          className="px-2 py-1 rounded-lg text-[11px] font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
                        >
                          Plan
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleStatus(user)}
                          className={`p-1 rounded-lg transition-colors ${
                            user.status === "Active"
                              ? "text-amber-600 hover:bg-amber-50"
                              : "text-emerald-600 hover:bg-emerald-50"
                          }`}
                          title={user.status === "Active" ? "Suspend Account" : "Activate Account"}
                        >
                          {user.status === "Active" ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        <div className="flex items-center justify-between pt-3 border-t border-black/[0.06] text-xs text-gray-500">
          <div>
            Showing {(currentPage - 1) * usersPerPage + 1} to{" "}
            {Math.min(currentPage * usersPerPage, filteredUsers.length)} of{" "}
            {filteredUsers.length} records
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className="p-1.5 rounded-lg border border-black/[0.08] hover:bg-gray-100 disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2.5 font-semibold text-gray-800">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              className="p-1.5 rounded-lg border border-black/[0.08] hover:bg-gray-100 disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ── User Details Modal ── */}
      {selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-md bg-white rounded-2xl border border-black/[0.08] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-black text-white flex items-center justify-center font-bold text-xs">
                  {selectedUser.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-base font-bold text-gray-950">{selectedUser.name}</h3>
                  <p className="text-xs text-gray-400 font-mono">{selectedUser.id}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedUser(null)}
                className="p-1 text-gray-400 hover:text-black rounded-lg hover:bg-black/5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs bg-gray-50 p-4 rounded-xl border border-black/[0.04]">
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Email:</span>
                <span className="font-mono text-gray-800">{selectedUser.email}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Role:</span>
                <span className="font-semibold text-gray-900">{selectedUser.role || "Member"}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Current Plan:</span>
                <span>{getPlanBadge(selectedUser.plan)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Credits Remaining:</span>
                <span className="font-mono font-extrabold text-gray-950">
                  {selectedUser.creditsRemaining.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Active Projects:</span>
                <span className="font-mono font-bold text-gray-900">{selectedUser.projectsCount}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Account Status:</span>
                <span className="font-semibold text-emerald-700">{selectedUser.status}</span>
              </div>
              <div className="flex justify-between pt-1">
                <span className="text-gray-500">Joined Date:</span>
                <span className="text-gray-700">{selectedUser.joinedDate}</span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setDeletingUser(selectedUser)}
                className="px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 rounded-xl transition-colors"
              >
                Delete Account
              </button>
              <button
                type="button"
                onClick={() => setSelectedUser(null)}
                className="mavly-btn-secondary px-4 py-2 text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Plan Modal ── */}
      {editingPlanUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-black/[0.08] shadow-2xl p-6 space-y-4">
            <h3 className="text-base font-bold text-gray-950">
              Change Plan for {editingPlanUser.name}
            </h3>
            <form onSubmit={handleUpdatePlan} className="space-y-4 text-xs">
              <div>
                <label className="block text-gray-700 font-semibold mb-1">Select New Tier</label>
                <select
                  value={selectedNewPlan}
                  onChange={(e) => setSelectedNewPlan(e.target.value as UserRecord["plan"])}
                  className="w-full h-9 px-3 text-xs rounded-xl border border-black/[0.1] bg-white text-gray-900"
                >
                  <option value="Free">Free Starter (₹0)</option>
                  <option value="Starter">Starter Tier (₹399/mo)</option>
                  <option value="Creator">Creator Tier (₹599/mo)</option>
                  <option value="Pro">Pro Enterprise (₹899/mo)</option>
                  <option value="Agency">Agency Tier (₹1,999/mo)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingPlanUser(null)}
                  className="px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-bold text-white bg-black hover:bg-neutral-800 rounded-xl"
                >
                  Confirm Change
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Invite Member Modal ── */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-md bg-white rounded-2xl border border-black/[0.08] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-black/[0.06]">
              <h3 className="text-base font-bold text-gray-950">Invite Team Member</h3>
              <button
                type="button"
                onClick={() => setShowInviteModal(false)}
                className="p-1 text-gray-400 hover:text-black rounded-lg hover:bg-black/5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleInviteUser} className="space-y-4 text-xs">
              <div>
                <label className="block text-gray-700 font-semibold mb-1">Full Name</label>
                <input
                  type="text"
                  placeholder="e.g. Vikram Malhotra"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  className="w-full h-9 px-3 text-xs rounded-xl border border-black/[0.1] focus:ring-2 focus:ring-black text-gray-900"
                />
              </div>

              <div>
                <label className="block text-gray-700 font-semibold mb-1">Email Address</label>
                <input
                  type="email"
                  placeholder="vikram@enterprise.in"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="w-full h-9 px-3 text-xs rounded-xl border border-black/[0.1] focus:ring-2 focus:ring-black text-gray-900"
                />
              </div>

              <div>
                <label className="block text-gray-700 font-semibold mb-1">Assigned Plan Tier</label>
                <select
                  value={invitePlan}
                  onChange={(e) => setInvitePlan(e.target.value as UserRecord["plan"])}
                  className="w-full h-9 px-3 text-xs rounded-xl border border-black/[0.1] bg-white text-gray-900"
                >
                  <option value="Starter">Starter Tier (₹399/mo)</option>
                  <option value="Creator">Creator Tier (₹599/mo)</option>
                  <option value="Pro">Pro Enterprise (₹899/mo)</option>
                  <option value="Agency">Agency Tier (₹1,999/mo)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-bold text-white bg-black hover:bg-neutral-800 rounded-xl shadow-sm"
                >
                  Send Invitation
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
