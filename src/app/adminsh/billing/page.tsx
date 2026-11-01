"use client";

import {
  CreditCard,
  Download,
  Info,
  IndianRupee,
  Search,
  TrendingUp,
} from "lucide-react";
import { AdminShell } from "../components/AdminShell";
import { RevenueChart } from "../components/RevenueChart";

const BILLING_METRICS = [
  "Gross Platform Revenue",
  "Monthly Recurring Revenue",
  "Paid Subscriptions",
  "Churn Rate",
];

export default function BillingAdminPage() {
  return (
    <AdminShell activeNav="Billing & Revenue">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {BILLING_METRICS.map((label, index) => (
          <div
            key={label}
            className="p-5 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]"
          >
            <p className="text-xs font-semibold text-muted-foreground tracking-wide">{label}</p>
            <h3 className="text-2xl sm:text-3xl font-extrabold text-muted-foreground mt-1.5 font-mono">
              —
            </h3>
            <span className="text-[11px] text-muted-foreground font-medium mt-2 inline-flex items-center gap-1">
              {index === 0 ? <IndianRupee className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
              No Mavly platform billing source
            </span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <RevenueChart live unavailable />
        </div>

        <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] flex flex-col justify-between space-y-4">
          <div>
            <h3 className="text-base font-bold text-foreground">Plan Distribution</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Subscription plan data is not available
            </p>
          </div>

          <div className="min-h-40 flex flex-col items-center justify-center px-4 text-center gap-2 rounded-xl border border-dashed border-[var(--clay-line)] bg-[var(--clay-sunken)]">
            <Info className="w-5 h-5 text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">No platform subscription records</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Plan counts, prices and revenue shares cannot be computed from the current database.
            </p>
          </div>

          <div className="p-3 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-[11px] text-muted-foreground">
            <strong>Payment source:</strong> None configured for Mavly platform billing. Customer
            application payments are separate and are not included here.
          </div>
        </div>
      </div>

      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
          <div>
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-[var(--clay-sunken)] text-muted-foreground border border-[var(--clay-line)]">
                <CreditCard className="w-4 h-4" />
              </div>
              <h2 className="text-base font-bold text-foreground">Payment Transactions Ledger</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Mavly platform transaction data unavailable
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                disabled
                placeholder="No billing source to search"
                aria-label="Billing search unavailable"
                className="w-full h-8 pl-8 pr-3 text-xs rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-muted-foreground placeholder:text-muted-foreground cursor-not-allowed shadow-[var(--clay-well-1)]"
              />
            </div>

            <select
              value="unavailable"
              disabled
              title="Platform transaction statuses are unavailable"
              className="h-8 px-2.5 text-xs font-medium bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl text-muted-foreground cursor-not-allowed shadow-[var(--clay-well-1)]"
            >
              <option value="unavailable">Statuses unavailable</option>
            </select>

            <button
              type="button"
              disabled
              title="There are no verified Mavly billing records to export"
              className="h-8 px-3 rounded-xl border border-[var(--clay-line)] bg-card text-xs font-semibold text-muted-foreground flex items-center gap-1.5 cursor-not-allowed opacity-60"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-[var(--clay-line)] bg-card shadow-[var(--clay-elev-1)]">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[var(--clay-sunken)] border-b border-[var(--clay-line)] text-muted-foreground font-bold uppercase tracking-wider text-[10px]">
                <th className="py-2.5 px-4">Invoice ID</th>
                <th className="py-2.5 px-4">Customer</th>
                <th className="py-2.5 px-4">Plan Tier</th>
                <th className="py-2.5 px-4 text-right font-mono">Amount</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Timestamp</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={7} className="py-10 px-4 text-center">
                  <div className="flex flex-col items-center gap-2 max-w-md mx-auto">
                    <Info className="w-5 h-5 text-muted-foreground" />
                    <p className="text-sm font-semibold text-foreground">
                      No Mavly platform billing records are available
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      No subscription, invoice or platform payment source is implemented here.
                      Credit balances are usage accounting, not revenue. Customer-owned Razorpay
                      integrations are excluded.
                    </p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}
