"use client";

import React, { useState } from "react";
import {
  CreditCard,
  IndianRupee,
  TrendingUp,
  Search,
  Filter,
  Download,
  CheckCircle2,
  Clock,
  RotateCcw,
  Eye,
  FileText,
  X,
  PieChart,
  Calendar,
  Layers,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import { RevenueChart } from "../components/RevenueChart";
import { MOCK_TRANSACTIONS } from "../components/mockData";
import { TransactionRecord } from "../components/types";

export default function BillingAdminPage() {
  const [transactions, setTransactions] = useState<TransactionRecord[]>(MOCK_TRANSACTIONS);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [selectedTxn, setSelectedTxn] = useState<TransactionRecord | null>(null);

  const filteredTxns = transactions.filter((t) => {
    const matchesSearch =
      t.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.customer.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.plan.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === "All" || t.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleRefund = (txn: TransactionRecord) => {
    if (txn.status === "Refunded") {
      toast.info("This transaction has already been refunded.");
      return;
    }
    setTransactions((prev) =>
      prev.map((t) => (t.id === txn.id ? { ...t, status: "Refunded" } : t))
    );
    toast.success(`Refund issued for ${txn.id}`, {
      description: `Amount of ${txn.amount} marked as refunded (Demo state).`,
    });
  };

  const getPlanBadge = (plan: TransactionRecord["plan"]) => {
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
      case "Starter":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[var(--neu-sunken)] text-foreground border border-[var(--neu-line)]">
            Starter
          </span>
        );
      case "Free":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[var(--neu-sunken)] text-muted-foreground border border-black/[0.05]">
            Free
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
            {plan}
          </span>
        );
    }
  };

  const getStatusBadge = (status: TransactionRecord["status"]) => {
    switch (status) {
      case "Paid":
        return (
          <span className="text-emerald-700 font-semibold text-xs flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Paid
          </span>
        );
      case "Processing":
        return (
          <span className="text-amber-600 font-semibold text-xs flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Processing
          </span>
        );
      case "Refunded":
        return (
          <span className="text-muted-foreground font-medium text-xs flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
            Refunded
          </span>
        );
    }
  };

  return (
    <AdminShell activeNav="Billing & Revenue">
      {/* ── Metric Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <p className="text-xs font-semibold text-muted-foreground tracking-wide">Gross Platform Revenue</p>
          <h3 className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1.5 font-mono">₹14,22,500</h3>
          <span className="text-[11px] text-emerald-600 font-semibold mt-2 inline-flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> +53.7% vs last 6 months
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <p className="text-xs font-semibold text-muted-foreground tracking-wide">Monthly Recurring (MRR)</p>
          <h3 className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1.5 font-mono">₹2,84,500</h3>
          <span className="text-[11px] text-emerald-600 font-semibold mt-2 inline-block">
            +18.6% acceleration
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <p className="text-xs font-semibold text-muted-foreground tracking-wide">Active Paid Subscriptions</p>
          <h3 className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1.5 font-mono">3,420</h3>
          <span className="text-[11px] text-muted-foreground font-medium mt-2 inline-block">
            Starter, Pro &amp; Agency
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)]">
          <p className="text-xs font-semibold text-muted-foreground tracking-wide">Gross Churn Rate</p>
          <h3 className="text-2xl sm:text-3xl font-extrabold text-emerald-700 mt-1.5 font-mono">0.82%</h3>
          <span className="text-[11px] text-muted-foreground font-medium mt-2 inline-block">
            Benchmark &lt; 2.0%
          </span>
        </div>
      </div>

      {/* ── Revenue Chart & Plan Breakdown Grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <RevenueChart />
        </div>

        {/* Plan Revenue Breakdown */}
        <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] flex flex-col justify-between space-y-4">
          <div>
            <h3 className="text-base font-bold text-foreground">Plan Distribution</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Share of monthly subscription MRR</p>
          </div>

          <div className="space-y-3.5">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-bold text-foreground">Agency Tier (₹1,999/mo)</span>
                <span className="font-mono text-foreground">48%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-[var(--neu-sunken)] overflow-hidden">
                <div className="h-full bg-purple-600 rounded-full" style={{ width: "48%" }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-bold text-foreground">Pro Tier (₹899/mo)</span>
                <span className="font-mono text-foreground">32%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-[var(--neu-sunken)] overflow-hidden">
                <div className="h-full bg-black rounded-full" style={{ width: "32%" }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-bold text-foreground">Creator Tier (₹599/mo)</span>
                <span className="font-mono text-foreground">12%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-[var(--neu-sunken)] overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: "12%" }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-bold text-foreground">Starter Tier (₹399/mo)</span>
                <span className="font-mono text-foreground">8%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-[var(--neu-sunken)] overflow-hidden">
                <div className="h-full bg-amber-400 rounded-full" style={{ width: "8%" }} />
              </div>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)] text-[11px] text-muted-foreground">
            <strong>Payment Gateway:</strong> Razorpay auto-debit &amp; UPI Mandates configured.
          </div>
        </div>
      </div>

      {/* ── Transactions Table Container ── */}
      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-[var(--neu-line)]">
          <div>
            <h2 className="text-base font-bold text-foreground">Payment Transactions Ledger</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Showing {filteredTxns.length} payment records
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search invoice ID, customer, email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-8 pl-8 pr-3 text-xs rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)] text-foreground focus:bg-card focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-8 px-2.5 text-xs font-medium bg-[var(--neu-sunken)] border border-[var(--neu-line)] rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-black cursor-pointer"
            >
              <option value="All">All Statuses</option>
              <option value="Paid">Paid</option>
              <option value="Processing">Processing</option>
              <option value="Refunded">Refunded</option>
            </select>

            <button
              type="button"
              onClick={() => toast.info("Demo CSV download initiated")}
              className="h-8 px-3 rounded-xl border border-[var(--neu-line)] bg-card hover:bg-[var(--neu-sunken)] text-xs font-semibold text-foreground flex items-center gap-1.5 shadow-xs"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* ── Dense Table ── */}
        <div className="overflow-x-auto rounded-xl border border-[var(--neu-line)]">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[var(--neu-sunken)]/60 border-b border-[var(--neu-line)] text-muted-foreground font-bold uppercase tracking-wider text-[10px]">
                <th className="py-2.5 px-4">Invoice ID</th>
                <th className="py-2.5 px-4">Customer</th>
                <th className="py-2.5 px-4">Plan Tier</th>
                <th className="py-2.5 px-4 text-right font-mono">Amount (INR)</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Timestamp</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.04]">
              {filteredTxns.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-muted-foreground">
                    No transactions match your search.
                  </td>
                </tr>
              ) : (
                filteredTxns.map((tx) => (
                  <tr key={tx.id} className="hover:bg-[var(--neu-sunken)]/60 transition-colors">
                    <td className="py-2.5 px-4 font-mono font-medium text-muted-foreground">
                      {tx.id}
                    </td>
                    <td className="py-2.5 px-4">
                      <div>
                        <p className="font-bold text-foreground">{tx.customer}</p>
                        <p className="text-[11px] text-muted-foreground">{tx.email}</p>
                      </div>
                    </td>
                    <td className="py-2.5 px-4">{getPlanBadge(tx.plan)}</td>
                    <td className="py-2.5 px-4 text-right font-mono font-bold text-foreground">
                      {tx.amount}
                    </td>
                    <td className="py-2.5 px-4">{getStatusBadge(tx.status)}</td>
                    <td className="py-2.5 px-4 text-muted-foreground whitespace-nowrap">{tx.date}</td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setSelectedTxn(tx)}
                          className="px-2 py-1 rounded-lg text-[11px] font-semibold text-foreground bg-[var(--neu-sunken)] hover:bg-gray-200 transition-colors"
                        >
                          Invoice
                        </button>
                        {tx.status === "Paid" && (
                          <button
                            type="button"
                            onClick={() => handleRefund(tx)}
                            className="px-2 py-1 rounded-lg text-[11px] font-semibold text-rose-600 hover:bg-rose-50 transition-colors"
                          >
                            Refund
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Invoice Details Modal ── */}
      {selectedTxn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-md bg-card rounded-2xl border border-[var(--neu-line)] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--neu-line)]">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-foreground" />
                <h3 className="text-base font-bold text-foreground">Invoice Details</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTxn(null)}
                className="p-1 text-muted-foreground hover:text-black rounded-lg hover:bg-black/5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs bg-[var(--neu-sunken)] p-4 rounded-xl border border-[var(--neu-line)]">
              <div className="flex justify-between py-1 border-b border-[var(--neu-line)]">
                <span className="text-muted-foreground">Invoice Number:</span>
                <span className="font-mono font-bold text-foreground">{selectedTxn.id}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-[var(--neu-line)]">
                <span className="text-muted-foreground">Customer:</span>
                <span className="font-semibold text-foreground">{selectedTxn.customer}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-[var(--neu-line)]">
                <span className="text-muted-foreground">Billing Email:</span>
                <span className="font-mono text-foreground">{selectedTxn.email}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-[var(--neu-line)]">
                <span className="text-muted-foreground">Subscription Tier:</span>
                <span>{getPlanBadge(selectedTxn.plan)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-[var(--neu-line)]">
                <span className="text-muted-foreground">Total Billed:</span>
                <span className="font-mono font-extrabold text-foreground text-sm">
                  {selectedTxn.amount}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-[var(--neu-line)]">
                <span className="text-muted-foreground">Settlement Status:</span>
                <span>{getStatusBadge(selectedTxn.status)}</span>
              </div>
              <div className="flex justify-between pt-1">
                <span className="text-muted-foreground">Gateway Provider:</span>
                <span className="text-foreground font-semibold">Razorpay India UPI / Cards</span>
              </div>
            </div>

            <div className="flex justify-between items-center pt-2">
              {selectedTxn.status === "Paid" ? (
                <button
                  type="button"
                  onClick={() => {
                    handleRefund(selectedTxn);
                    setSelectedTxn(null);
                  }}
                  className="px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 rounded-xl"
                >
                  Issue Refund (Demo)
                </button>
              ) : (
                <div />
              )}
              <button
                type="button"
                onClick={() => setSelectedTxn(null)}
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
