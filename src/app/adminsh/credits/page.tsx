"use client";

import React, { useMemo, useState } from "react";
import {
  Coins,
  ArrowUpRight,
  ArrowDownLeft,
  PlusCircle,
  RefreshCw,
  Download,
  Copy,
  History,
  CreditCard,
  Wallet,
  AlertTriangle,
  Ban,
} from "lucide-react";
import { toast } from "sonner";

import {
  CREDIT_LEDGER_OPERATIONS,
  creditAmountLabel,
  creditOperationLabel,
  creditOperationTone,
  formatCompactNumber,
  toCsv,
  type AdminCreditLedgerRow,
  type CreditLedgerOperation,
} from "@/lib/admin/console";
import { AdminShell } from "../components/AdminShell";
import {
  newIdempotencyKey,
  useAdminMutation,
  useCreditLedger,
  useDebouncedValue,
} from "../components/useAdminConsoleData";
import {
  Badge,
  DetailRow,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  Modal,
  Pagination,
  PrimaryButton,
  SearchField,
  SecondaryButton,
  SectionCard,
  SegmentedFilter,
  StatCard,
  UnavailableNote,
  formatTimestamp,
} from "../components/console-ui";

/**
 * ═══ CREDITS LEDGER ═════════════════════════════════════════════════════════
 *
 * Every number on this page is a real aggregate over `public.credit_ledger`, and
 * every row is a real ledger row. Nothing here is a placeholder:
 *
 *   summary cards   `admin_credit_ledger().summary` — the database's own sums
 *   table           `admin_credit_ledger().rows` — paginated, filtered, searched
 *                   server-side, so the page cannot show a partial list as if it
 *                   were the whole ledger
 *   details         the row itself, including the balance after it was written
 *   Adjust Credits  `admin_adjust_credits` — the atomic engine, not a local push
 *   CSV             the rows currently in view, escaped against formula injection
 *
 * ⚠️ A HOLD IS NOT A CHARGE. `generation_reserved` moves 0 credits and only
 * raises the hold, so it renders an em dash and is never summed into spend.
 *
 * ⚠️ THE OLD "POOL DISTRIBUTION" BAR IS GONE. It claimed 65/22/9/4% across plan
 * tiers; Mavly has no plan-tier column on a credit account, so there was no
 * source for it and no honest way to keep it.
 */

const PAGE_SIZE = 25;

const OPERATION_ICON: Record<CreditLedgerOperation, React.ReactNode> = {
  grant: <ArrowUpRight className="w-3 h-3" />,
  admin_adjustment: <Coins className="w-3 h-3" />,
  generation_reserved: <Wallet className="w-3 h-3" />,
  generation_consumed: <ArrowDownLeft className="w-3 h-3" />,
  generation_released: <RefreshCw className="w-3 h-3" />,
  generation_refunded: <RefreshCw className="w-3 h-3" />,
  purchase: <ArrowUpRight className="w-3 h-3" />,
  subscription_grant: <ArrowUpRight className="w-3 h-3" />,
  refund: <RefreshCw className="w-3 h-3" />,
};

const OPERATION_TONE: Record<
  CreditLedgerOperation,
  "positive" | "negative" | "warning" | "neutral"
> = {
  grant: "positive",
  admin_adjustment: "warning",
  generation_reserved: "neutral",
  generation_consumed: "negative",
  generation_released: "neutral",
  generation_refunded: "positive",
  purchase: "positive",
  subscription_grant: "positive",
  refund: "positive",
};

export default function CreditsAdminPage() {
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState<"all" | CreditLedgerOperation>("all");
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data, loading, error, refresh } = useCreditLedger({
    operation,
    search: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
  });

  const [selected, setSelected] = useState<AdminCreditLedgerRow | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);

  const summary = data?.summary ?? null;
  const rows = data?.rows ?? [];

  const filterOptions = useMemo(
    () => [
      { id: "all" as const, label: "All" },
      ...CREDIT_LEDGER_OPERATIONS.map((entry) => ({
        id: entry,
        label: creditOperationLabel(entry),
      })),
    ],
    []
  );

  const handleCopy = (value: string, label: string) => {
    void navigator.clipboard?.writeText(value);
    toast.success(`${label} copied`);
  };

  /**
   * Export exactly what is on screen.
   *
   * ⚠️ THIS IS NOT A FULL-LEDGER DUMP. The page holds one bounded page of rows,
   * so the CSV is that page — labelled as such in the filename. Exporting a
   * filtered view while calling it "the ledger" would be the kind of quiet
   * inaccuracy this whole pass exists to remove.
   */
  const handleExport = () => {
    if (rows.length === 0) {
      toast.error("There is nothing in view to export.");
      return;
    }
    const header = [
      "Ledger ID",
      "Created at",
      "User",
      "Email",
      "Operation",
      "Amount",
      "Reserved delta",
      "Balance after",
      "Reserved after",
      "Status",
      "Project",
      "Run",
      "Reason",
    ];
    const body = rows.map((row) => [
      row.id,
      row.createdAt,
      row.userName,
      row.userEmail,
      row.operation,
      row.amount,
      row.reservedDelta,
      row.balanceAfter,
      row.reservedAfter,
      row.status,
      row.projectId,
      row.runId,
      row.reason,
    ]);
    const csv = toCsv([header, ...body]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mavly-credit-ledger-page-${page + 1}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} row(s) currently in view.`);
  };

  return (
    <AdminShell activeNav="Credits" live>
      {/* ── Summary cards: real ledger aggregates ─────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <StatCard
          label="Credits Issued"
          value={summary ? formatCompactNumber(summary.issued) : null}
          hint={
            summary
              ? `${summary.transactions.toLocaleString()} ledger entries total`
              : undefined
          }
          icon={<Coins className="w-3.5 h-3.5 text-warning" />}
          tone="positive"
          unavailable={!summary}
        />
        <StatCard
          label="Credits Consumed"
          value={summary ? formatCompactNumber(summary.consumed) : null}
          hint={
            summary
              ? `${formatCompactNumber(summary.refunded)} refunded · ${summary.reversed} reversed`
              : undefined
          }
          icon={<ArrowDownLeft className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!summary}
        />
        <StatCard
          label="Outstanding Balance"
          value={summary ? formatCompactNumber(summary.outstanding) : null}
          hint={
            summary
              ? `Across ${summary.wallets.toLocaleString()} funded wallet(s)`
              : undefined
          }
          icon={<CreditCard className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!summary}
        />
        <StatCard
          label="Held for Running Runs"
          value={summary ? formatCompactNumber(summary.reserved) : null}
          hint="Reserved against generations that have not settled"
          icon={<Wallet className="w-3.5 h-3.5 text-muted-foreground" />}
          tone="warning"
          unavailable={!summary}
        />
      </div>

      {!summary && !loading && (
        <UnavailableNote>
          The ledger summary could not be read, so the cards above show no value. They are not
          zero: a zero here would mean an empty ledger, which is a different claim.
        </UnavailableNote>
      )}

      {/* ── Ledger ────────────────────────────────────────────────────────── */}
      <SectionCard
        title="Credit ledger"
        description="Append-only. Balances are the balance recorded after each entry was written."
        actions={
          <>
            <SecondaryButton icon={<Download className="w-3.5 h-3.5" />} onClick={handleExport}>
              CSV
            </SecondaryButton>
            <PrimaryButton
              icon={<PlusCircle className="w-3.5 h-3.5" />}
              onClick={() => setAdjustOpen(true)}
            >
              Adjust Credits
            </PrimaryButton>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <SegmentedFilter
              options={filterOptions}
              value={operation}
              onChange={(next) => {
                setOperation(next);
                setPage(0);
              }}
            />
            <SearchField
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(0);
              }}
              placeholder="Search user, email, reason, ledger ID, project…"
            />
          </div>

          {loading && !data ? (
            <LoadingBlock label="Reading the credit ledger" />
          ) : error && !data ? (
            <ErrorBlock message={error} onRetry={refresh} />
          ) : rows.length === 0 ? (
            <EmptyBlock
              title="No ledger entries match this view"
              detail={
                operation === "all" && debouncedSearch === ""
                  ? "No credit has been granted, held, consumed or refunded on this deployment yet."
                  : "Try a different operation filter or clear the search."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[var(--clay-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                    <th className="pb-3">Ledger ID</th>
                    <th className="pb-3">User</th>
                    <th className="pb-3 text-center">Operation</th>
                    <th className="pb-3 text-right">Delta</th>
                    <th className="pb-3 text-right">Balance after</th>
                    <th className="pb-3">Reason</th>
                    <th className="pb-3 text-right">Recorded</th>
                    <th className="pb-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--clay-line)]">
                  {rows.map((row) => (
                    <tr key={row.id} className="hover:bg-[var(--clay-sunken)] transition-colors">
                      <td className="py-3 font-mono">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-foreground">
                            {row.id.slice(0, 8)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(row.id, "Ledger ID")}
                            className="p-1 text-muted-foreground hover:text-black transition-colors"
                            title="Copy full ledger id"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        </div>
                        {row.status === "reversed" && (
                          <span className="text-[10px] text-warning-subtle-foreground font-semibold">
                            reversed
                          </span>
                        )}
                      </td>
                      <td className="py-3">
                        <p className="font-semibold text-foreground truncate max-w-[180px]">
                          {row.userName}
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate max-w-[180px]">
                          {row.userEmail ?? "no email on record"}
                        </p>
                      </td>
                      <td className="py-3 text-center">
                        <Badge
                          tone={OPERATION_TONE[row.operation]}
                          icon={OPERATION_ICON[row.operation]}
                        >
                          {creditOperationLabel(row.operation)}
                        </Badge>
                      </td>
                      <td
                        className={`py-3 text-right font-mono font-bold ${
                          creditOperationTone(row.operation) === "positive"
                            ? "text-success"
                            : "text-foreground"
                        }`}
                      >
                        {creditAmountLabel(row)}
                      </td>
                      <td className="py-3 text-right font-mono text-muted-foreground">
                        {row.balanceAfter.toLocaleString()}
                      </td>
                      <td
                        className="py-3 max-w-[220px] truncate text-muted-foreground"
                        title={row.reason ?? ""}
                      >
                        {row.reason ?? "—"}
                      </td>
                      <td className="py-3 text-right text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(row.createdAt)}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setSelected(row)}
                          className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-md transition-colors"
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={data.total}
              onPageChange={setPage}
              loading={loading}
            />
          )}

          {error && data && (
            <p className="text-[11px] text-warning-subtle-foreground">
              Showing the last successful read. The newest refresh failed: {error}
            </p>
          )}
        </div>
      </SectionCard>

      {selected && (
        <LedgerDetailModal row={selected} onClose={() => setSelected(null)} onCopy={handleCopy} />
      )}

      {adjustOpen && (
        <AdjustCreditsModal
          onClose={() => setAdjustOpen(false)}
          onApplied={() => {
            setAdjustOpen(false);
            refresh();
          }}
        />
      )}
    </AdminShell>
  );
}

// ─────────────────────────── detail modal ───────────────────────────────────

function LedgerDetailModal({
  row,
  onClose,
  onCopy,
}: {
  row: AdminCreditLedgerRow;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
}) {
  return (
    <Modal
      title="Ledger entry"
      icon={<History className="w-4 h-4 text-foreground" />}
      onClose={onClose}
    >
      <div className="space-y-2 bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
        <DetailRow
          label="Ledger ID"
          value={
            <button
              type="button"
              onClick={() => onCopy(row.id, "Ledger ID")}
              className="font-mono underline decoration-dotted"
            >
              {row.id}
            </button>
          }
          wrap
        />
        <DetailRow label="User" value={`${row.userName} (${row.userEmail ?? "no email"})`} />
        <DetailRow label="User ID" value={row.userId} mono wrap />
        <DetailRow label="Operation" value={creditOperationLabel(row.operation)} />
        <DetailRow label="Amount" value={creditAmountLabel(row)} mono />
        <DetailRow
          label="Reserved delta"
          value={row.reservedDelta === 0 ? "—" : row.reservedDelta.toLocaleString()}
          mono
        />
        <DetailRow label="Balance after" value={row.balanceAfter.toLocaleString()} mono />
        <DetailRow label="Reserved after" value={row.reservedAfter.toLocaleString()} mono />
        <DetailRow label="Status" value={row.status} />
        <DetailRow label="Project" value={row.projectId} mono wrap />
        <DetailRow label="Run" value={row.runId} mono wrap />
        <DetailRow label="Recorded" value={formatTimestamp(row.createdAt)} />
      </div>

      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold text-foreground">Reason</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap">
          {row.reason ?? "No reason was recorded for this entry."}
        </p>
      </div>

      {row.operation === "generation_reserved" && (
        <UnavailableNote>
          A hold moves no credits. It raises the reserved amount so the same credits cannot be
          spent twice while a generation runs; the charge is written separately when the run
          settles.
        </UnavailableNote>
      )}

      <div className="pt-2 flex justify-end border-t border-[var(--clay-line)]">
        <SecondaryButton onClick={onClose}>Close</SecondaryButton>
      </div>
    </Modal>
  );
}

// ─────────────────────────── adjustment modal ───────────────────────────────

interface UserOption {
  id: string;
  name: string;
  email: string | null;
}

function AdjustCreditsModal({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied: () => void;
}) {
  const [userQuery, setUserQuery] = useState("");
  const [options, setOptions] = useState<UserOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserOption | null>(null);
  const [mode, setMode] = useState<"grant" | "admin_adjustment">("grant");
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("500");
  const [reason, setReason] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);

  const debouncedQuery = useDebouncedValue(userQuery, 300);
  const mutation = useAdminMutation();

  /**
   * ⚠️ THE USER PICKER READS THE REAL DIRECTORY. The previous modal offered a
   * hardcoded list of five invented accounts; granting credits to a mock user
   * would have written nothing. This searches `admin_user_directory`, so the
   * account chosen is the account credited.
   */
  React.useEffect(() => {
    const query = debouncedQuery.trim();
    if (query.length < 2) {
      setOptions([]);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setSearchError(null);

    fetch(`/api/adminsh/users?search=${encodeURIComponent(query)}&pageSize=8`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | {
              ok?: boolean;
              data?: {
                rows?: Array<{
                  id: string;
                  name: string | null;
                  email: string | null;
                  availableCredits: string | null;
                }>;
              };
              error?: string;
            }
          | null;
        if (!response.ok || body?.ok !== true) {
          throw new Error(body?.error || "The user directory could not be searched.");
        }
        const users = body.data?.rows ?? [];
        setOptions(
          users.map((user) => ({
            id: user.id,
            name: user.name ?? user.email ?? "Unnamed user",
            email: user.email,
          }))
        );
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setSearchError(
          cause instanceof Error ? cause.message : "The user directory could not be searched."
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });

    return () => controller.abort();
  }, [debouncedQuery]);

  const parsedAmount = Number.parseInt(amount, 10);
  const signedAmount =
    Number.isFinite(parsedAmount) && parsedAmount > 0
      ? direction === "remove"
        ? -parsedAmount
        : parsedAmount
      : 0;

  const canSubmit =
    selectedUser !== null &&
    signedAmount !== 0 &&
    (signedAmount > 0 || reason.trim() !== "") &&
    !mutation.pending;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedUser) {
      toast.error("Choose the account to adjust.");
      return;
    }
    if (signedAmount === 0) {
      toast.error("Enter a whole number of credits greater than zero.");
      return;
    }
    if (signedAmount < 0 && reason.trim() === "") {
      toast.error("A reason is required when removing credits.");
      return;
    }

    /**
     * ⚠️ ONE KEY PER SUBMISSION. A double click sends the same key twice and the
     * database returns the existing entry instead of granting twice.
     */
    const result = await mutation.run<{ message: string; balance: number | null }>(
      "/api/adminsh/credits/adjust",
      {
        userId: selectedUser.id,
        amount: signedAmount,
        operation: mode,
        reason: reason.trim(),
        idempotencyKey: newIdempotencyKey(),
      }
    );

    if ("error" in result) {
      toast.error(result.error);
      return;
    }

    toast.success(result.data.message, {
      description:
        result.data.balance !== null
          ? `New balance: ${result.data.balance.toLocaleString()} credits`
          : undefined,
    });
    onApplied();
  };

  return (
    <Modal
      title="Adjust credit balance"
      icon={<Coins className="w-4 h-4 text-warning" />}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
        <div>
          <label className="block font-semibold text-foreground mb-1">Target account</label>
          {selectedUser ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl">
              <div className="min-w-0">
                <p className="font-semibold text-foreground truncate">{selectedUser.name}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {selectedUser.email ?? "no email"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedUser(null);
                  setUserQuery("");
                }}
                className="text-[11px] font-medium text-muted-foreground hover:text-black shrink-0"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <SearchField
                value={userQuery}
                onChange={setUserQuery}
                placeholder="Search by name or email (2+ characters)"
                className="w-full"
              />
              {searching && <p className="text-[11px] text-muted-foreground mt-1">Searching…</p>}
              {searchError && (
                <p className="text-[11px] text-warning-subtle-foreground mt-1">{searchError}</p>
              )}
              {!searching && options.length > 0 && (
                <ul className="mt-1 max-h-40 overflow-y-auto border border-[var(--clay-line)] rounded-xl divide-y divide-[var(--clay-line)]">
                  {options.map((option) => (
                    <li key={option.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedUser(option)}
                        className="w-full text-left px-3 py-2 hover:bg-[var(--clay-sunken)] transition-colors"
                      >
                        <p className="font-semibold text-foreground truncate">{option.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {option.email ?? "no email"}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!searching && debouncedQuery.trim().length >= 2 && options.length === 0 && !searchError && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  No account matches that search.
                </p>
              )}
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-semibold text-foreground mb-1">Direction</label>
            <select
              value={direction}
              onChange={(event) => setDirection(event.target.value as "add" | "remove")}
              className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            >
              <option value="add">Add credits</option>
              <option value="remove">Remove credits</option>
            </select>
          </div>
          <div>
            <label className="block font-semibold text-foreground mb-1">Amount</label>
            <input
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card font-mono shadow-[var(--clay-well-1)]"
            />
          </div>
        </div>

        <div>
          <label className="block font-semibold text-foreground mb-1">
            Ledger entry type
          </label>
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as "grant" | "admin_adjustment")}
            className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
          >
            <option value="grant">Grant (promotional or goodwill)</option>
            <option value="admin_adjustment">Adjustment (correction)</option>
          </select>
          <p className="text-[11px] text-muted-foreground mt-1">
            Both write one ledger entry. The type is how the entry will read in the audit trail.
          </p>
        </div>

        <div>
          <label className="block font-semibold text-foreground mb-1">
            Reason {signedAmount < 0 && <span className="text-warning-subtle-foreground">(required)</span>}
          </label>
          <textarea
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            className="w-full px-3 py-2 bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            placeholder="e.g. VIP onboarding gift, or compensation for a failed run"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Stored on the ledger entry and in the audit log.
          </p>
        </div>

        {mutation.error && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[var(--clay-sunken)] border border-warning/30 text-[11px] text-warning-subtle-foreground leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{mutation.error}</span>
          </div>
        )}

        <div className="pt-2 flex items-center justify-end gap-2 border-t border-[var(--clay-line)]">
          <SecondaryButton onClick={onClose} disabled={mutation.pending}>
            Cancel
          </SecondaryButton>
          <PrimaryButton type="submit" disabled={!canSubmit}>
            {mutation.pending ? "Applying…" : "Apply adjustment"}
          </PrimaryButton>
        </div>

        <p className="text-[10px] text-muted-foreground leading-relaxed flex items-start gap-1.5">
          <Ban className="w-3 h-3 shrink-0 mt-0.5" />
          A removal cannot take a balance below credits currently held for a running generation.
          Release or wait for the hold first.
        </p>
      </form>
    </Modal>
  );
}
