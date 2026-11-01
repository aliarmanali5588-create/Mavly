import { AdminShell } from "../components/AdminShell";
import { BillingSkeleton } from "../components/AdminSkeletons";

/**
 * Billing & Revenue loading boundary.
 *
 * Mirrors `billing/page.tsx`: four metric cards, the 3-column split with the
 * revenue chart spanning two and the Plan Distribution card taking one, then
 * the Payment Transactions Ledger with its toolbar and 7-column table.
 */
export default function BillingLoading() {
  return (
    <AdminShell activeNav="Billing & Revenue" loading>
      <BillingSkeleton />
    </AdminShell>
  );
}
