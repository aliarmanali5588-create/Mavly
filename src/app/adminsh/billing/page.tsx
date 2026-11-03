"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCard, Info, RefreshCw } from "lucide-react";
import { AdminShell } from "../components/AdminShell";

interface BillingPayload {
  summary: {
    grossRevenueInrPaise: number;
    refundsInrPaise: number;
    netCollectedRevenueInrPaise: number;
    actualAiCostInrPaise: number | null;
    estimatedAiCostInrPaise: number | null;
    successfulPayments: number;
    failedPayments: number;
    refundedPayments: number;
    activeSubscriptions: number;
    pastDueSubscriptions: number;
    cancelledSubscriptions: number;
    creditPackPurchases: number;
    subscriptionPayments: number;
    openReconciliationIssues: number;
  };
  payments: Array<{
    id: string;
    userId: string;
    email: string | null;
    productId: string;
    productType: string;
    provider: string;
    market: string;
    currency: string;
    amountInrPaise: number | null;
    providerAmountMinor: number | null;
    providerCurrency: string | null;
    status: string;
    createdAt: string;
    paidAt: string | null;
  }>;
  subscriptions: Array<Record<string, string | null>>;
  refunds: Array<Record<string, string | number | null>>;
  reconciliation: Array<Record<string, string | number | null>>;
}

function moneyInr(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(Number(paise))) return "Unavailable";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(paise) / 100);
}

export default function BillingAdminPage() {
  const [payload, setPayload] = useState<BillingPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refundingId, setRefundingId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch("/api/adminsh/billing?limit=50", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { ok?: boolean; data?: BillingPayload; error?: string };
        if (!response.ok || body.ok !== true || !body.data) throw new Error(body.error ?? "Billing data could not be loaded.");
        setPayload(body.data);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Billing data could not be loaded."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const refund = async (payment: BillingPayload["payments"][number]) => {
    if (refundingId || payment.status !== "paid" || payment.amountInrPaise === null) return;
    if (!window.confirm("Start a full provider refund for this payment? Purchased credits must still be fully unused.")) return;
    setRefundingId(payment.id);
    setError(null);
    try {
      const response = await fetch("/api/billing/refunds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentId: payment.id, amountMinor: payment.amountInrPaise }),
        cache: "no-store",
      });
      const result = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || result?.ok !== true) throw new Error(result?.error ?? "The refund could not be started.");
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The refund could not be started.");
    } finally {
      setRefundingId(null);
    }
  };
  const summary = payload?.summary;
  const metrics = [
    ["Gross revenue", summary ? moneyInr(summary.grossRevenueInrPaise) : "—"],
    ["Successful payments", summary ? String(summary.successfulPayments) : "—"],
    ["Active subscriptions", summary ? String(summary.activeSubscriptions) : "—"],
    ["Reconciliation issues", summary ? String(summary.openReconciliationIssues) : "—"],
  ];

  return (
    <AdminShell activeNav="Billing & Revenue" live>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-foreground">Billing &amp; Revenue</h1>
          <p className="text-xs text-muted-foreground mt-1">Verified Mavly platform payments only. Customer-app payments are excluded.</p>
        </div>
        <button type="button" onClick={refresh} disabled={loading} className="h-9 px-3 rounded-xl border border-[var(--clay-line)] bg-card text-xs font-semibold flex items-center gap-2 disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error && <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5 text-xs text-destructive">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {metrics.map(([label, value]) => (
          <div key={label} className="p-5 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
            <p className="text-xs font-semibold text-muted-foreground tracking-wide">{label}</p>
            <h3 className="text-xl sm:text-2xl font-extrabold text-foreground mt-2 font-mono">{value}</h3>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-card rounded-2xl p-5 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)]">
          <h2 className="text-base font-bold">Payment mix</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
            {[
              ["Net collected", summary ? moneyInr(summary.netCollectedRevenueInrPaise) : "—"],
              ["Refunds", summary ? moneyInr(summary.refundsInrPaise) : "—"],
              ["Actual AI cost", summary ? moneyInr(summary.actualAiCostInrPaise) : "Unavailable"],
              ["Estimated AI cost", summary ? moneyInr(summary.estimatedAiCostInrPaise) : "Unavailable"],
              ["Credit packs", summary ? String(summary.creditPackPurchases) : "—"],
              ["Plan payments", summary ? String(summary.subscriptionPayments) : "—"],
            ].map(([label, value]) => <div key={label} className="rounded-xl bg-[var(--clay-sunken)] p-3"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 font-bold text-sm">{value}</p></div>)}
          </div>
          <p className="text-[11px] text-muted-foreground mt-5">All platform financial figures are INR paise snapshots. Provider-native currency is retained only for reconciliation.</p>
        </div>
        <div className="bg-card rounded-2xl p-5 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)]">
          <h2 className="text-base font-bold">Subscription state</h2>
          <div className="mt-5 space-y-3 text-xs">
            <p className="flex justify-between"><span>Active</span><strong>{summary?.activeSubscriptions ?? "—"}</strong></p>
            <p className="flex justify-between"><span>Past due</span><strong>{summary?.pastDueSubscriptions ?? "—"}</strong></p>
            <p className="flex justify-between"><span>Cancelled</span><strong>{summary?.cancelledSubscriptions ?? "—"}</strong></p>
          </div>
        </div>
      </div>

      <div className="bg-card rounded-2xl p-5 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex items-center gap-2"><CreditCard className="w-4 h-4" /><h2 className="text-base font-bold">Verified payment ledger</h2></div>
        <div className="overflow-x-auto rounded-xl border border-[var(--clay-line)]">
          <table className="w-full text-left border-collapse text-xs">
            <thead><tr className="bg-[var(--clay-sunken)] border-b border-[var(--clay-line)] text-muted-foreground font-bold uppercase tracking-wider text-[10px]"><th className="py-2.5 px-4">Payment</th><th className="py-2.5 px-4">User</th><th className="py-2.5 px-4">Product</th><th className="py-2.5 px-4">Provider</th><th className="py-2.5 px-4">Amount</th><th className="py-2.5 px-4">Status</th><th className="py-2.5 px-4">Date</th><th className="py-2.5 px-4">Action</th></tr></thead>
            <tbody>{payload?.payments.length ? payload.payments.map((payment) => <tr key={payment.id} className="border-b border-[var(--clay-line)] last:border-0"><td className="py-3 px-4 font-mono">{payment.id.slice(0, 8)}</td><td className="py-3 px-4">{payment.email ?? payment.userId.slice(0, 8)}</td><td className="py-3 px-4">{payment.productId}</td><td className="py-3 px-4 uppercase">{payment.provider}</td><td className="py-3 px-4 font-mono">{moneyInr(payment.amountInrPaise)}</td><td className="py-3 px-4">{payment.status}</td><td className="py-3 px-4">{new Date(payment.createdAt).toLocaleString()}</td><td className="py-3 px-4"><button type="button" disabled={payment.status !== "paid" || refundingId !== null} onClick={() => refund(payment)} className="rounded-lg border border-[var(--clay-line)] px-2 py-1 text-[10px] font-semibold disabled:opacity-40">{refundingId === payment.id ? "Starting…" : "Refund"}</button></td></tr>) : <tr><td colSpan={8} className="py-10 px-4 text-center"><Info className="w-5 h-5 mx-auto text-muted-foreground" /><p className="mt-2 font-semibold">{loading ? "Loading verified payments…" : "No verified Mavly platform payments"}</p></td></tr>}</tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}
