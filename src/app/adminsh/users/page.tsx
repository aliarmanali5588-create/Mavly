"use client";

import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import { AdminShell } from "../components/AdminShell";
import type {
  AdminUserDirectoryResponse,
  AdminUserDirectoryRow,
} from "@/lib/admin/directory";

const USERS_PER_PAGE = 5;

function formatDate(value: string | null, empty = "Not recorded") {
  if (!value) return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function formatCredits(value: string | null) {
  if (value === null) return "Not recorded";
  if (!/^-?\d+$/.test(value)) return "Unavailable";
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export default function UsersAdminPage() {
  const [directory, setDirectory] = useState<AdminUserDirectoryResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedUser, setSelectedUser] = useState<AdminUserDirectoryRow | null>(null);
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
        page: String(currentPage),
        pageSize: String(USERS_PER_PAGE),
      });

      try {
        const response = await fetch(`/api/adminsh/users?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || !result.ok || !result.data) {
          throw new Error(result.error || "The user directory could not be loaded.");
        }
        setDirectory(result.data as AdminUserDirectoryResponse);
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setDirectory(null);
        setError(
          requestError instanceof Error
            ? requestError.message
            : "The user directory could not be loaded."
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, statusFilter, currentPage, refreshKey]);

  const users = directory?.rows ?? [];
  const total = directory?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / USERS_PER_PAGE));
  const metrics = directory?.metrics;

  const getPlanBadge = () => (
    <span
      className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--clay-sunken)] text-muted-foreground border border-[var(--clay-line)]"
      title="No Mavly subscription plan is recorded"
    >
      Not recorded
    </span>
  );

  return (
    <AdminShell activeNav="Users">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          ["Total Users", metrics?.total],
          ["Created This Month", metrics?.createdThisMonth],
          ["Created in Last 7 Days", metrics?.createdLast7Days],
          ["Currently Banned", metrics?.banned],
        ].map(([label, value]) => (
          <div
            key={label}
            className="p-5 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]"
          >
            <p className="text-xs font-semibold text-muted-foreground tracking-wide">{label}</p>
            <h3 className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1.5 font-mono">
              {loading && value === undefined ? "…" : typeof value === "number" ? value.toLocaleString() : "—"}
            </h3>
            <span className="text-[11px] text-muted-foreground font-medium mt-2 inline-block">
              {error ? "Unavailable" : "From Supabase Auth"}
            </span>
          </div>
        ))}
      </div>

      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
          <div>
            <h2 className="text-base font-bold text-foreground">Customer Directory</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {loading ? "Loading accounts…" : `Showing ${total.toLocaleString()} matching accounts`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                maxLength={120}
                placeholder="Search user, email, or ID..."
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setCurrentPage(1);
                }}
                className="w-full h-8 pl-8 pr-3 text-xs rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground focus:bg-card focus:outline-none focus:ring-2 focus:ring-black shadow-[var(--clay-well-1)]"
              />
            </div>

            <select
              value="unavailable"
              disabled
              title="Mavly subscription plans are not stored"
              className="h-8 px-2.5 text-xs font-medium bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl text-muted-foreground cursor-not-allowed shadow-[var(--clay-well-1)]"
            >
              <option value="unavailable">Plans unavailable</option>
            </select>

            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setCurrentPage(1);
              }}
              className="h-8 px-2.5 text-xs font-medium bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-black cursor-pointer shadow-[var(--clay-well-1)]"
            >
              <option value="all">All Statuses</option>
              <option value="not_banned">Not Banned</option>
              <option value="banned">Banned</option>
            </select>

            <button
              type="button"
              disabled
              title="Invitations are not implemented"
              className="h-8 px-3 rounded-xl bg-primary text-white/70 font-bold text-xs flex items-center gap-1.5 opacity-60 cursor-not-allowed shadow-[var(--clay-elev-ink-1)]"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Invite Member</span>
            </button>
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

        <div className="overflow-x-auto rounded-xl border border-[var(--clay-line)] bg-card shadow-[var(--clay-elev-1)]">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[var(--clay-sunken)] border-b border-[var(--clay-line)] text-muted-foreground font-bold uppercase tracking-wider text-[10px]">
                <th className="py-2.5 px-4">User</th>
                <th className="py-2.5 px-4">Role</th>
                <th className="py-2.5 px-4">Plan</th>
                <th className="py-2.5 px-4 text-center">Projects</th>
                <th className="py-2.5 px-4 text-right font-mono">Credits Remaining</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Last Sign-In</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--clay-line)]">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted-foreground">
                    {loading ? "Loading users…" : error ? "User records are unavailable." : "No users match the selected filters."}
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id} className="hover:bg-[var(--clay-sunken)] transition-colors">
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-black text-white flex items-center justify-center font-bold text-[10px] shrink-0 shadow-[var(--clay-elev-ink-1)]">
                          {user.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-bold text-foreground leading-tight">{user.name}</p>
                          <p className="text-[11px] text-muted-foreground leading-tight">{user.email ?? "No email recorded"}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-muted-foreground font-medium">{user.role ?? "Not recorded"}</td>
                    <td className="py-2.5 px-4">{getPlanBadge()}</td>
                    <td className="py-2.5 px-4 text-center font-mono font-semibold text-foreground">
                      {user.projectCount.toLocaleString()}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono font-bold text-foreground">
                      {formatCredits(user.availableCredits)}
                    </td>
                    <td className="py-2.5 px-4">
                      {user.status === "Not Banned" ? (
                        <span className="text-success font-semibold text-xs flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-success" />
                          Not Banned
                        </span>
                      ) : (
                        <span className="text-destructive font-semibold text-xs flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
                          Banned
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-muted-foreground whitespace-nowrap">
                      {formatDate(user.lastSignInAt, "No recorded sign-in")}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setSelectedUser(user)}
                          className="px-2 py-1 rounded-lg text-[11px] font-semibold text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] transition-colors"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          disabled
                          title="Plan changes are not supported"
                          className="px-2 py-1 rounded-lg text-[11px] font-semibold text-muted-foreground bg-[var(--clay-sunken)] cursor-not-allowed opacity-60"
                        >
                          Plan
                        </button>
                        <button
                          type="button"
                          disabled
                          title="Account status changes are not supported"
                          className="p-1 rounded-lg text-muted-foreground cursor-not-allowed opacity-60"
                        >
                          {user.status === "Not Banned" ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-[var(--clay-line)] text-xs text-muted-foreground">
          <div>
            Showing {total === 0 ? 0 : (currentPage - 1) * USERS_PER_PAGE + 1} to{" "}
            {Math.min(currentPage * USERS_PER_PAGE, total)} of {total.toLocaleString()} records
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={currentPage === 1 || loading}
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              className="p-1.5 rounded-lg border border-[var(--clay-line)] hover:bg-[var(--clay-sunken)] disabled:opacity-40 disabled:pointer-events-none transition-colors shadow-[var(--clay-well-1)]"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2.5 font-semibold text-foreground">{currentPage} / {totalPages}</span>
            <button
              type="button"
              disabled={currentPage >= totalPages || loading}
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              className="p-1.5 rounded-lg border border-[var(--clay-line)] hover:bg-[var(--clay-sunken)] disabled:opacity-40 disabled:pointer-events-none transition-colors shadow-[var(--clay-well-1)]"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--clay-scrim)] backdrop-blur-[3px] animate-in fade-in">
          <div className="w-full max-w-md bg-card rounded-2xl border border-[var(--clay-line)] shadow-[var(--clay-float)] p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--clay-line)]">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-black text-white flex items-center justify-center font-bold text-xs shadow-[var(--clay-elev-ink-1)]">
                  {selectedUser.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">{selectedUser.name}</h3>
                  <p className="text-xs text-muted-foreground font-mono">{selectedUser.id}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedUser(null)}
                aria-label="Close user details"
                className="p-1 text-muted-foreground hover:text-black rounded-lg hover:bg-[var(--clay-sunken)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5 text-xs bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
              <div className="flex justify-between gap-4 py-1 border-b border-[var(--clay-line)]"><span className="text-muted-foreground">Email</span><span className="font-mono text-foreground">{selectedUser.email ?? "Not recorded"}</span></div>
              <div className="flex justify-between gap-4 py-1 border-b border-[var(--clay-line)]"><span className="text-muted-foreground">Auth role</span><span className="font-semibold text-foreground">{selectedUser.role ?? "Not recorded"}</span></div>
              <div className="flex justify-between gap-4 py-1 border-b border-[var(--clay-line)]"><span className="text-muted-foreground">Subscription plan</span><span className="text-muted-foreground">Unavailable</span></div>
              <div className="flex justify-between gap-4 py-1 border-b border-[var(--clay-line)]"><span className="text-muted-foreground">Available credits</span><span className="font-mono font-bold text-foreground">{formatCredits(selectedUser.availableCredits)}</span></div>
              <div className="flex justify-between gap-4 py-1 border-b border-[var(--clay-line)]"><span className="text-muted-foreground">Projects</span><span className="font-mono font-bold text-foreground">{selectedUser.projectCount.toLocaleString()}</span></div>
              <div className="flex justify-between gap-4 py-1 border-b border-[var(--clay-line)]"><span className="text-muted-foreground">Account status</span><span className="font-semibold text-foreground">{selectedUser.status}{selectedUser.bannedUntil ? ` until ${formatDate(selectedUser.bannedUntil)}` : ""}</span></div>
              <div className="flex justify-between gap-4 pt-1"><span className="text-muted-foreground">Joined</span><span className="text-foreground">{formatDate(selectedUser.createdAt)}</span></div>
            </div>
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                disabled
                title="Account deletion is not supported"
                className="px-3 py-1.5 text-xs font-semibold text-muted-foreground rounded-xl cursor-not-allowed opacity-60"
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
    </AdminShell>
  );
}
