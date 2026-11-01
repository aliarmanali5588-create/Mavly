import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * The 404 is a page like any other, so it gets the same clay: a warm canvas,
 * one raised slab carrying the message, and a pressable way back. It used to
 * be bare text floating on white.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--clay-base)] px-4">
      <div className="w-full max-w-md rounded-[var(--clay-r-2xl)] border border-[var(--clay-line)] bg-card p-8 sm:p-10 text-center shadow-[var(--clay-elev-3)]">
        <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-[var(--clay-r-xl)] border border-[var(--clay-line)] bg-[var(--clay-sunken)] font-mono text-lg font-bold text-foreground shadow-[var(--clay-well-2)]">
          404
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Sorry, we couldn&apos;t find the page you&apos;re looking for. Please
          check the URL or navigate back to the homepage.
        </p>
        <div className="mt-8">
          <Link href="/">
            <Button size="lg">Go back home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
