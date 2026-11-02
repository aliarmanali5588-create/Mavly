"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const pathname = usePathname();

  const aiPrompt = `There is an error on page "${pathname}", check logs and solve it.`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(aiPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      /* ignore */
    }
  };

  return (
    <div className="flex min-h-[400px] w-full items-center justify-center p-4">
      <div className="w-full max-w-md rounded-[var(--clay-r-xl)] border border-destructive/25 bg-card p-6 shadow-[var(--clay-elev-3)]">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive-subtle shadow-[var(--clay-well-1)]">
            <svg
              className="h-5 w-5 text-destructive dark:text-destructive"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-destructive-subtle-foreground">
              Something went wrong
            </h2>
            <p className="text-sm text-destructive dark:text-destructive">
              An error occurred in this section
            </p>
          </div>
        </div>

        <div className="mb-4 rounded-md bg-destructive-subtle p-3">
          <p data-selectable="true" className="text-sm font-medium text-destructive-subtle-foreground">
            Error: {error.message || "Unknown error"}
          </p>
        </div>

        {/* AI Help Section */}
        <div className="mb-4 rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)] p-4 dark:border-[var(--clay-line-strong)] dark:bg-foreground/50 shadow-[var(--clay-well-1)]">
          <div className="mb-2 flex items-center gap-2">
            <svg className="h-5 w-5 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="text-base font-bold text-foreground">
              Let AI fix this
            </span>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            Copy this and paste it in the AI chat:
          </p>
          <div className="relative">
            <div data-selectable="true" className="rounded-lg border border-[var(--clay-line)] bg-card p-3 pr-12 font-mono text-sm text-foreground dark:border-[var(--clay-line-strong)] dark:bg-[var(--clay-sunken-deep)] shadow-[var(--clay-well-1)]">
              {aiPrompt}
            </div>
            <button
              onClick={handleCopy}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-black p-2 text-white transition-all hover:bg-foreground clay-press dark:bg-card dark:text-black dark:hover:bg-[var(--clay-sunken-deep)] shadow-[var(--clay-elev-ink-1)]"
              title="Copy to clipboard"
            >
              {copied ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
            </button>
          </div>
          {copied && (
            <p className="mt-2 text-center text-sm font-medium text-success dark:text-success">
              Copied!
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <button
            onClick={() => reset()}
            className="w-full rounded-md bg-destructive px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-destructive focus:outline-none focus:ring-2 focus:ring-destructive focus:ring-offset-2"
          >
            Try again
          </button>
          <button
            onClick={() => window.history.back()}
            className="w-full rounded-md border border-destructive/40 bg-card px-4 py-2 text-sm font-medium text-destructive-subtle-foreground transition-colors hover:bg-destructive-subtle focus:outline-none focus:ring-2 focus:ring-destructive focus:ring-offset-2 dark:border-destructive/40 dark:bg-transparent dark:hover:bg-destructive/10 shadow-[var(--clay-elev-1)]"
          >
            Go back
          </button>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="w-full rounded-md border border-destructive/40 bg-card px-4 py-2 text-sm font-medium text-destructive-subtle-foreground transition-colors hover:bg-destructive-subtle focus:outline-none focus:ring-2 focus:ring-destructive focus:ring-offset-2 dark:border-destructive/40 dark:bg-transparent dark:hover:bg-destructive/10 shadow-[var(--clay-elev-1)]"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
        </div>

        {showDetails && (
          <div className="mt-4 rounded-md bg-black p-3">
            <pre className="max-h-48 overflow-auto text-xs text-muted-foreground">
              {error.stack || "No stack trace available"}
            </pre>
            {error.digest && (
              <p data-selectable="true" className="mt-2 text-xs text-muted-foreground">
                Digest: {error.digest}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
