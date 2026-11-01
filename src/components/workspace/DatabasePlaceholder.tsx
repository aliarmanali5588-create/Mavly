export function DatabasePlaceholder() {
  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--clay-base)] px-4 py-6 sm:px-8" aria-labelledby="database-heading">
      <div className="mx-auto w-full max-w-5xl">
        <h1 id="database-heading" className="text-xl font-semibold tracking-tight text-foreground">Database</h1>
        <p className="mt-1 text-sm text-muted-foreground">View and manage the data stored in your app.</p>
        <div
          className="mt-6 min-h-[260px] rounded-xl border border-[var(--clay-line)] bg-card shadow-[var(--clay-elev-1)]"
          aria-label="Database placeholder"
        />
      </div>
    </section>
  );
}
