"use client";

import React, { useState } from "react";
import {
  Coins,
  Search,
  Filter,
  ArrowUpRight,
  ArrowDownLeft,
  PlusCircle,
  RefreshCw,
  Download,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  X,
  CreditCard,
  User,
  History,
  TrendingUp,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { AdminShell } from "../components/AdminShell";
import { MOCK_CREDIT_TRANSACTIONS, MOCK_USERS_LIST } from "../components/mockData";
import { CreditTransactionRecord } from "../components/types";

export default function CreditsAdminPage() {
  const [transactions, setTransactions] = useState<CreditTransactionRecord[]>(
    MOCK_CREDIT_TRANSACTIONS
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [selectedTx, setSelectedTx] = useState<CreditTransactionRecord | null>(null);

  // Modal for Adjusting Credits
  const [isAdjustModalOpen, setIsAdjustModalOpen] = useState(false);
  const [targetUserEmail, setTargetUserEmail] = useState(MOCK_USERS_LIST[0]?.email || "");
  const [adjustType, setAdjustType] = useState<"Grant" | "Adjustment" | "Refund">("Grant");
  const [adjustAmount, setAdjustAmount] = useState("500");
  const [adjustReason, setAdjustReason] = useState("Manual promotional credit grant");

  const filtered = transactions.filter((tx) => {
    const matchesSearch =
      tx.user.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tx.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tx.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tx.reason.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesType = typeFilter === "All" || tx.type === typeFilter;
    return matchesSearch && matchesType;
  });

  const handleCreateAdjustment = (e: React.FormEvent) => {
    e.preventDefault();
    const amountNum = parseInt(adjustAmount, 10);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error("Please enter a valid positive credit amount.");
      return;
    }

    const matchedUser = MOCK_USERS_LIST.find((u) => u.email === targetUserEmail);
    const userName = matchedUser ? matchedUser.name : "Custom User";

    const newTx: CreditTransactionRecord = {
      id: `CRD-${Math.floor(100 + Math.random() * 900)}`,
      user: userName,
      email: targetUserEmail,
      type: adjustType,
      amount: amountNum,
      balanceAfter: (matchedUser?.creditsRemaining || 1000) + amountNum,
      timestamp: "Just now",
      reason: adjustReason,
    };

    setTransactions((prev) => [newTx, ...prev]);
    setIsAdjustModalOpen(false);
    toast.success(`Successfully adjusted credits for ${userName}!`, {
      description: `Added ${amountNum} credits (${adjustType}).`,
    });
  };

  const handleCopyTxId = (id: string) => {
    navigator.clipboard?.writeText(id);
    toast.success(`Copied TX ID: ${id}`);
  };

  const getTypeBadge = (type: CreditTransactionRecord["type"]) => {
    switch (type) {
      case "Purchase":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-mono">
            <ArrowUpRight className="w-3 h-3 text-emerald-600" />
            Purchase
          </span>
        );
      case "Grant":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200/60 font-mono">
            <Sparkles className="w-3 h-3 text-blue-600" />
            Grant
          </span>
        );
      case "Usage":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-gray-100 text-gray-700 border border-black/[0.06] font-mono">
            <ArrowDownLeft className="w-3 h-3 text-gray-500" />
            Usage
          </span>
        );
      case "Refund":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-purple-50 text-purple-700 border border-purple-200/60 font-mono">
            <RefreshCw className="w-3 h-3 text-purple-600" />
            Refund
          </span>
        );
      case "Adjustment":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200/60 font-mono">
            <Coins className="w-3 h-3 text-amber-600" />
            Adjustment
          </span>
        );
    }
  };

  return (
    <AdminShell activeNav="Credits">
      {/* 1. Credit Economics Overview Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between text-xs text-gray-500 font-medium">
            <span>Total Issued</span>
            <Coins className="w-3.5 h-3.5 text-amber-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-gray-950 font-mono mt-1">1,842,500</h3>
          <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-600 font-medium">
            <TrendingUp className="w-3 h-3" />
            <span>+14.8% vs last month</span>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between text-xs text-gray-500 font-medium">
            <span>Monthly Consumption</span>
            <ArrowDownLeft className="w-3.5 h-3.5 text-blue-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-gray-950 font-mono mt-1">620,400</h3>
          <p className="text-[11px] text-gray-400 mt-1">Avg 42 credits / prompt run</p>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between text-xs text-gray-500 font-medium">
            <span>Outstanding Balance</span>
            <CreditCard className="w-3.5 h-3.5 text-purple-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-gray-950 font-mono mt-1">1,222,100</h3>
          <p className="text-[11px] text-gray-400 mt-1">Across 2,410 active wallets</p>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between text-xs text-gray-500 font-medium">
            <span>Refunds & Goodwill</span>
            <RefreshCw className="w-3.5 h-3.5 text-emerald-500" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-gray-950 font-mono mt-1">14,250</h3>
          <p className="text-[11px] text-gray-400 mt-1">0.7% dispute reversal rate</p>
        </div>
      </div>

      {/* 2. Credit Allocation Breakdown Bar */}
      <div className="p-5 rounded-2xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-3">
        <div className="flex items-center justify-between text-xs">
          <h4 className="text-sm font-semibold tracking-tight text-gray-950">Active Pool Distribution</h4>
          <span className="text-gray-500 font-mono">100% capacity managed</span>
        </div>
        <div className="h-3 w-full bg-gray-100 rounded-full overflow-hidden flex">
          <div className="bg-gray-950 h-full w-[65%]" title="Agency & Pro: 65%" />
          <div className="bg-blue-600 h-full w-[22%]" title="Starter: 22%" />
          <div className="bg-amber-500 h-full w-[9%]" title="Creator: 9%" />
          <div className="bg-gray-400 h-full w-[4%]" title="Free Trials: 4%" />
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs pt-1 text-gray-600 font-medium">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-gray-950" />
            <span>Agency & Pro (65%)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-600" />
            <span>Starter Tier (22%)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
            <span>Creator (9%)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-gray-400" />
            <span>Free Trials (4%)</span>
          </div>
        </div>
      </div>

      {/* 3. Search, Filter & Action Bar */}
      <div className="bg-white rounded-2xl p-5 sm:p-6 border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-black/[0.06]">
          {/* Segmented Filter */}
          <div className="flex flex-wrap items-center gap-1 bg-gray-100 p-0.5 rounded-lg border border-black/[0.04] text-xs">
            {["All", "Purchase", "Usage", "Grant", "Refund", "Adjustment"].map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => setTypeFilter(tf)}
                className={`px-3 py-1 rounded-md text-xs transition-all ${
                  typeFilter === tf
                    ? "bg-white text-gray-950 shadow-xs font-semibold"
                    : "text-gray-500 hover:text-gray-900 font-medium"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search user, reason, TX..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-8 pl-8 pr-3 text-xs rounded-lg bg-gray-50 border border-black/[0.08] text-gray-900 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-black"
              />
            </div>

            <button
              onClick={() => {
                toast.info("Exporting credit transactions ledger (demo)");
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 border border-black/[0.08] rounded-lg transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV</span>
            </button>

            <button
              onClick={() => setIsAdjustModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-black hover:bg-neutral-800 rounded-lg transition-colors shadow-xs"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>Adjust Credits</span>
            </button>
          </div>
        </div>

        {/* 4. Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-black/[0.06] text-gray-400 font-semibold uppercase text-[10px]">
                <th className="pb-3">TX Hash</th>
                <th className="pb-3">Target User</th>
                <th className="pb-3 text-center">Operation</th>
                <th className="pb-3 text-right">Delta Amount</th>
                <th className="pb-3 text-right">Balance After</th>
                <th className="pb-3">Reason / Context</th>
                <th className="pb-3 text-right">Timestamp</th>
                <th className="pb-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.04]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-gray-400 text-xs">
                    No credit transactions match your criteria.
                  </td>
                </tr>
              ) : (
                filtered.map((tx) => (
                  <tr key={tx.id} className="hover:bg-gray-50/70 transition-colors">
                    <td className="py-3.5 font-mono">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-gray-950">{tx.id}</span>
                        <button
                          type="button"
                          onClick={() => handleCopyTxId(tx.id)}
                          className="p-1 text-gray-400 hover:text-black transition-colors"
                          title="Copy TX ID"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                    <td className="py-3.5">
                      <p className="font-semibold text-gray-950">{tx.user}</p>
                      <p className="text-[11px] text-gray-400">{tx.email}</p>
                    </td>
                    <td className="py-3.5 text-center">{getTypeBadge(tx.type)}</td>
                    <td
                      className={`py-3.5 text-right font-mono font-bold ${
                        tx.amount > 0 ? "text-emerald-600" : "text-gray-950"
                      }`}
                    >
                      {tx.amount > 0 ? `+${tx.amount}` : tx.amount}
                    </td>
                    <td className="py-3.5 text-right font-mono text-gray-600">
                      {tx.balanceAfter.toLocaleString()}
                    </td>
                    <td className="py-3.5 max-w-xs truncate text-gray-600" title={tx.reason}>
                      {tx.reason}
                    </td>
                    <td className="py-3.5 text-right text-gray-400 whitespace-nowrap">
                      {tx.timestamp}
                    </td>
                    <td className="py-3.5 text-right">
                      <button
                        onClick={() => setSelectedTx(tx)}
                        className="px-2.5 py-1 text-[11px] font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Adjust Credits Dialog */}
      {isAdjustModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full border border-black/[0.1] shadow-2xl p-6 relative space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-black/[0.06]">
              <div className="flex items-center gap-2">
                <Coins className="w-4 h-4 text-amber-500" />
                <h3 className="text-sm font-bold text-gray-950">Adjust User Credit Balance</h3>
              </div>
              <button
                onClick={() => setIsAdjustModalOpen(false)}
                className="p-1 rounded-lg text-gray-400 hover:text-black"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateAdjustment} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-gray-700 mb-1">
                  Target User Account
                </label>
                <select
                  value={targetUserEmail}
                  onChange={(e) => setTargetUserEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-50 border border-black/[0.08] rounded-xl focus:outline-none focus:bg-white"
                >
                  {MOCK_USERS_LIST.map((u) => (
                    <option key={u.id} value={u.email}>
                      {u.name} ({u.email}) — Current: {u.creditsRemaining}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-gray-700 mb-1">
                    Action Type
                  </label>
                  <select
                    value={adjustType}
                    onChange={(e) =>
                      setAdjustType(e.target.value as "Grant" | "Adjustment" | "Refund")
                    }
                    className="w-full px-3 py-2 bg-gray-50 border border-black/[0.08] rounded-xl focus:outline-none focus:bg-white"
                  >
                    <option value="Grant">Grant (Bonus)</option>
                    <option value="Adjustment">Adjustment</option>
                    <option value="Refund">Refund Reversal</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-gray-700 mb-1">
                    Amount (Credits)
                  </label>
                  <input
                    type="number"
                    value={adjustAmount}
                    onChange={(e) => setAdjustAmount(e.target.value)}
                    min="1"
                    className="w-full px-3 py-2 bg-gray-50 border border-black/[0.08] rounded-xl focus:outline-none focus:bg-white font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-gray-700 mb-1">
                  Reason / Internal Audit Memo
                </label>
                <textarea
                  rows={2}
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-50 border border-black/[0.08] rounded-xl focus:outline-none focus:bg-white"
                  placeholder="e.g. VIP onboarding gift or service downtime compensation"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2 border-t border-black/[0.06]">
                <button
                  type="button"
                  onClick={() => setIsAdjustModalOpen(false)}
                  className="px-3.5 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-semibold text-white bg-black hover:bg-neutral-800 rounded-lg transition-colors"
                >
                  Apply Credit Adjustment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Transaction Details Modal */}
      {selectedTx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full border border-black/[0.1] shadow-2xl p-6 relative space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-black/[0.06]">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-gray-900" />
                <h3 className="text-sm font-bold text-gray-950">Transaction Details</h3>
              </div>
              <button
                onClick={() => setSelectedTx(null)}
                className="p-1 rounded-lg text-gray-400 hover:text-black"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 bg-gray-50 p-4 rounded-xl border border-black/[0.04] text-xs">
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">TX Hash:</span>
                <span className="font-mono font-semibold text-gray-900">{selectedTx.id}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">User:</span>
                <span className="font-semibold text-gray-900">{selectedTx.user} ({selectedTx.email})</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Operation:</span>
                <span>{getTypeBadge(selectedTx.type)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Delta Amount:</span>
                <span className="font-mono font-bold text-emerald-600">
                  {selectedTx.amount > 0 ? `+${selectedTx.amount}` : selectedTx.amount}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Balance After:</span>
                <span className="font-mono font-bold text-gray-900">{selectedTx.balanceAfter}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Timestamp:</span>
                <span className="text-gray-700">{selectedTx.timestamp}</span>
              </div>
              <div className="pt-1">
                <span className="text-gray-500 block mb-1">Reason / Note:</span>
                <p className="text-gray-900 bg-white p-2 rounded-lg border border-black/[0.06]">
                  {selectedTx.reason}
                </p>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-black/[0.06]">
              <button
                onClick={() => setSelectedTx(null)}
                className="px-4 py-1.5 text-xs font-semibold text-gray-800 bg-gray-100 hover:bg-gray-200 rounded-lg"
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
