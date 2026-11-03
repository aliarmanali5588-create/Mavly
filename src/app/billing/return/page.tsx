import Link from "next/link";

export default function BillingReturnPage() {
  return (
    <main className="min-h-screen bg-[var(--clay-base)] text-foreground flex items-center justify-center px-6">
      <section className="max-w-md w-full clay-panel p-8 text-center">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Mavly billing</p>
        <h1 className="mt-3 text-2xl font-black tracking-tight">Checkout returned</h1>
        <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
          Your provider payment is still verified server-side. Credits or plan access appear only after the signed provider event is committed.
        </p>
        <Link href="/dashboard" className="mavly-btn-primary inline-flex mt-6 px-5 py-2.5 text-xs font-semibold">
          Return to dashboard
        </Link>
      </section>
    </main>
  );
}
