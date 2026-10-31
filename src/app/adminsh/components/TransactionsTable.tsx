"use client";

import React from "react";
import Link from "next/link";
import { ArrowRight, CreditCard, Download, Info, Search } from "lucide-react";

/**
 * There is no Mavly subscription, invoice or credit-ledger table in this
 * database (see the audit in docs/ and AGENTS.md), so this section renders an
 * empty, explained state. It does not fall back to demo customers, invoices or
 * amounts, and the search/export controls are disabled rather than pretending to
 * operate on data that does not exist.
 */
export function TransactionsTable() {
  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--neu-line)] shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-4">
      {/* ── Table Header Controls ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--neu-line)]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-[var(--neu-sunken)] text-muted-foreground border border-[var(--neu-line)]">
              <CreditCard className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-foreground">Recent Billing Transactions</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Platform subscription invoices — no billing source configured
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

      {/* ── Search / Export (disabled: no source to query or export) ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
          <input
            type="text"
            disabled
            placeholder="Billing search unavailable"
            aria-label="Billing search unavailable"
            className="w-full h-8 pl-8 pr-3 text-xs rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)] text-muted-foreground placeholder:text-muted-foreground cursor-not-allowed"
          />
        </div>

        <button
          type="button"
          disabled
          title="There are no billing records to export"
          className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-[var(--neu-line)] text-xs font-semibold text-muted-foreground cursor-not-allowed"
        >
          <Download className="w-3.5 h-3.5 text-gray-300" />
          <span>Export CSV</span>
        </button>
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto rounded-xl border border-[var(--neu-line)]">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-[var(--neu-sunken)]/60 border-b border-[var(--neu-line)] text-muted-foreground font-bold uppercase tracking-wider text-[10px]">
              <th className="py-2.5 px-4">Invoice</th>
              <th className="py-2.5 px-4">Customer</th>
              <th className="py-2.5 px-4">Plan Tier</th>
              <th className="py-2.5 px-4 text-right font-mono">Amount</th>
              <th className="py-2.5 px-4">Payment Status</th>
              <th className="py-2.5 px-4">Date</th>
              <th className="py-2.5 px-4 text-right">Receipt</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={7} className="py-10 px-4 text-center">
                <div className="flex flex-col items-center gap-2 max-w-md mx-auto">
                  <Info className="w-5 h-5 text-muted-foreground" />
                  <p className="text-sm font-semibold text-foreground">
                    No Mavly billing records exist in this deployment
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    This application has no subscription, invoice or credit-ledger table. Transactions,
                    customer identities, invoice ids and amounts are not fabricated, and search/export
                    stay disabled until a real billing source is connected.
                  </p>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Razorpay credentials entered per project power generated applications only; they are not a
        Mavly platform billing source and are never surfaced here.
      </p>
    </div>
  );
}
