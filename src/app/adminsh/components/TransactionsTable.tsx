"use client";

import React, { useState } from "react";
import Link from "next/link";
import { CreditCard, Search, ArrowUpRight, Download, ArrowRight, X, FileText } from "lucide-react";
import { toast } from "sonner";
import { MOCK_TRANSACTIONS } from "./mockData";
import { TransactionRecord } from "./types";

export function TransactionsTable() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTx, setSelectedTx] = useState<TransactionRecord | null>(null);

  const filtered = MOCK_TRANSACTIONS.filter(
    (t) =>
      t.customer.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.plan.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
          <span className="text-gray-400 font-medium text-xs flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
            Refunded
          </span>
        );
    }
  };

  return (
    <div className="bg-white rounded-2xl p-5 sm:p-6 border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
      {/* ── Table Header Controls ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-black/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200">
              <CreditCard className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-gray-950">Recent Billing Transactions</h2>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Customer subscription renewals and platform invoice charges (INR ₹)
          </p>
        </div>

        <Link
          href="/adminsh/billing"
          className="text-xs font-bold text-black hover:underline inline-flex items-center gap-1 self-start sm:self-auto"
        >
          <span>All Billing Data</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* ── Search Bar ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search invoice ID, customer, email, or plan..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-8 pr-3 text-xs rounded-xl bg-gray-50 border border-black/[0.08] focus:bg-white focus:outline-none focus:ring-2 focus:ring-black text-gray-900 placeholder:text-gray-400"
          />
        </div>

        <button
          type="button"
          onClick={() => toast.info("Demo CSV Export initiated")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-black/[0.08] text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <Download className="w-3.5 h-3.5 text-gray-500" />
          <span>Export CSV</span>
        </button>
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto rounded-xl border border-black/[0.06]">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-gray-50/60 border-b border-black/[0.06] text-gray-400 font-bold uppercase tracking-wider text-[10px]">
              <th className="py-2.5 px-4">Invoice</th>
              <th className="py-2.5 px-4">Customer</th>
              <th className="py-2.5 px-4">Plan Tier</th>
              <th className="py-2.5 px-4 text-right font-mono">Amount (INR)</th>
              <th className="py-2.5 px-4">Payment Status</th>
              <th className="py-2.5 px-4">Date</th>
              <th className="py-2.5 px-4 text-right">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.04]">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-gray-400">
                  No transaction records match your search.
                </td>
              </tr>
            ) : (
              filtered.map((tx) => (
                <tr key={tx.id} className="hover:bg-gray-50/60 transition-colors">
                  <td className="py-2.5 px-4 font-mono font-medium text-gray-600">
                    {tx.id}
                  </td>
                  <td className="py-2.5 px-4">
                    <div>
                      <p className="font-bold text-gray-950">{tx.customer}</p>
                      <p className="text-[11px] text-gray-400">{tx.email}</p>
                    </div>
                  </td>
                  <td className="py-2.5 px-4">{getPlanBadge(tx.plan)}</td>
                  <td className="py-2.5 px-4 text-right font-mono font-bold text-gray-950">
                    {tx.amount}
                  </td>
                  <td className="py-2.5 px-4">{getStatusBadge(tx.status)}</td>
                  <td className="py-2.5 px-4 text-gray-500 whitespace-nowrap">{tx.date}</td>
                  <td className="py-2.5 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => setSelectedTx(tx)}
                      className="px-2 py-1 rounded-lg text-[11px] font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
                    >
                      Receipt
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Transaction Receipt Modal ── */}
      {selectedTx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-md bg-white rounded-2xl border border-black/[0.08] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-black/[0.06]">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-gray-700" />
                <h3 className="text-base font-bold text-gray-950">Invoice Receipt</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTx(null)}
                className="p-1 text-gray-400 hover:text-black rounded-lg hover:bg-black/5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs bg-gray-50 p-4 rounded-xl border border-black/[0.04]">
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Invoice ID:</span>
                <span className="font-mono font-bold text-gray-950">{selectedTx.id}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Customer:</span>
                <span className="font-semibold text-gray-900">{selectedTx.customer}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Email:</span>
                <span className="font-mono text-gray-700">{selectedTx.email}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Plan:</span>
                <span>{getPlanBadge(selectedTx.plan)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Total Billed:</span>
                <span className="font-mono font-extrabold text-gray-950 text-sm">
                  {selectedTx.amount}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-black/[0.04]">
                <span className="text-gray-500">Status:</span>
                <span>{getStatusBadge(selectedTx.status)}</span>
              </div>
              <div className="flex justify-between pt-1">
                <span className="text-gray-500">Payment Gateway:</span>
                <span className="text-gray-700 font-semibold">Razorpay India</span>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setSelectedTx(null)}
                className="mavly-btn-secondary px-4 py-2 text-xs font-semibold"
              >
                Close Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
