"use client";

import * as React from "react";
import { LightbulbIcon, Loader2 } from "lucide-react";

/** Short and true for this builder on the new engine. No prices, no vendor names. */
const TIPS = [
  "Connect your own domain from More → Custom domain.",
  "Sync the code with GitHub from the GitHub button under the chat box.",
  "Browse and edit your app's data in More → Database.",
  "Keep API keys out of your code: add them in More → Secrets.",
  "Every change is saved as a version, so you can always go back.",
  "Open the Code tab to read or edit any file the AI wrote.",
  "Use the pencil in the chat box to edit text and styles right in the preview.",
  "Attach screenshots or a Figma link to show the AI exactly what you want.",
  "Your app comes with a database, file storage and sign-in built in.",
  "Publish puts your app online at its own address in a few minutes.",
];
const TIP_MS = 6_000;
const FADE_MS = 400;
const BUILD_STAGES = [
  "Planning files",
  "Writing project files",
  "Validating generated files",
  "Preparing preview",
] as const;

function stageIndex(stage?: string | null): number {
  switch (stage) {
    case "planning":
    case "starting":
    case "sandbox":
      return 0;
    case "writing-files":
    case "working":
    case "build":
      return 1;
    case "validating-output":
      return 2;
    case "preparing-preview":
    case "deploy":
    case "wrapping-up":
    case "entry-page":
      return 3;
    default:
      return -1;
  }
}

function stageLabel(stage?: string | null): string {
  if (stage === "queued") return "Waiting for generation to start";
  if (stage === "retrying" || stage === "fixing") return "Retrying a generation step";
  const index = stageIndex(stage);
  return index >= 0 ? BUILD_STAGES[index] ?? "Starting generation" : "Starting generation";
}

/**
 * ═══ THE PREVIEW WHILE THE FIRST BUILD RUNS ═════════════════════════════════
 *
 * A wireframe of an app assembling itself (pure CSS, `globals.css` → `.bl-*`) over a
 * soft glow, the current stage, and a rotating "Did you know?" tip. Theme tokens only,
 * so it follows light/dark. With `prefers-reduced-motion` the drawing holds still and
 * the tips swap without the fade.
 */
export function BuildingLoader({ stage }: { stage?: string | null }) {
  const [tip, setTip] = React.useState(0);
  const [shown, setShown] = React.useState(true);
  const activeStage = stageIndex(stage);
  const currentLabel = stageLabel(stage);

  React.useEffect(() => {
    setTip(Math.floor(Math.random() * TIPS.length));
    let swap: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      setShown(false);
      swap = setTimeout(() => { setTip((i) => (i + 1) % TIPS.length); setShown(true); }, FADE_MS);
    }, TIP_MS);
    return () => { clearInterval(id); clearTimeout(swap); };
  }, []);

  return (
    <div data-testid="building-loader" aria-busy="true" className="absolute inset-0 flex flex-col items-center justify-center gap-5 overflow-y-auto bg-background px-4 py-8 text-center sm:gap-7 sm:px-6">
      <div className="bl-glow pointer-events-none absolute left-1/2 top-1/2 size-[420px] -translate-x-1/2 -translate-y-[62%] rounded-full" aria-hidden />

      <div className="bl-window relative w-full max-w-[220px] rounded-2xl border border-border bg-card p-3 shadow-sm" aria-hidden>
        <div className="mb-3 flex gap-1">
          <span className="size-1.5 rounded-full bg-muted-foreground/25" />
          <span className="size-1.5 rounded-full bg-muted-foreground/25" />
          <span className="size-1.5 rounded-full bg-muted-foreground/25" />
        </div>
        <div className="space-y-2">
          <span className="bl-bar block h-2 w-2/3 rounded-full bg-primary/30" style={{ animationDelay: "0ms" }} />
          <span className="bl-bar block h-1.5 w-full rounded-full bg-muted-foreground/15" style={{ animationDelay: "250ms" }} />
          <span className="bl-bar block h-1.5 w-5/6 rounded-full bg-muted-foreground/15" style={{ animationDelay: "500ms" }} />
          <div className="flex gap-2 pt-1">
            <span className="bl-bar block h-10 flex-1 rounded-lg bg-muted-foreground/10" style={{ animationDelay: "750ms" }} />
            <span className="bl-bar block h-10 flex-1 rounded-lg bg-muted-foreground/10" style={{ animationDelay: "900ms" }} />
            <span className="bl-bar block h-10 flex-1 rounded-lg bg-muted-foreground/10" style={{ animationDelay: "1050ms" }} />
          </div>
          <span className="bl-bar block h-5 w-1/3 rounded-md bg-primary/40" style={{ animationDelay: "1300ms" }} />
        </div>
      </div>

      <div className="relative w-full max-w-sm space-y-3">
        <div className="flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
          <p className="text-sm font-medium text-foreground">Building your app</p>
        </div>
        <p role="status" aria-live="polite" aria-atomic="true" className="text-xs text-muted-foreground">
          {currentLabel}
        </p>
        <div
          role="progressbar"
          aria-label="Website generation"
          aria-valuetext={currentLabel}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div aria-hidden className="run-progress-indeterminate h-full rounded-full bg-primary" />
        </div>
        <ol aria-label="Generation stages" className="grid grid-cols-2 gap-x-3 gap-y-2 pt-1 text-left sm:grid-cols-4">
          {BUILD_STAGES.map((label, index) => {
            const complete = activeStage >= 0 && index < activeStage;
            const active = index === activeStage;
            return (
              <li key={label} aria-current={active ? "step" : undefined} className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight">
                <span
                  aria-hidden
                  className={[
                    "size-2 shrink-0 rounded-full transition-colors duration-300 motion-reduce:transition-none",
                    complete ? "bg-primary" : active ? "bg-primary ring-4 ring-primary/15" : "bg-muted-foreground/25",
                  ].join(" ")}
                />
                <span className={active || complete ? "text-foreground" : "text-muted-foreground"}>
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="relative w-full max-w-sm rounded-xl border border-border bg-card/70 px-4 py-3 text-left backdrop-blur-sm">
        <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <LightbulbIcon className="size-3.5" aria-hidden /> Did you know?
        </p>
        <p
          data-testid="building-loader-tip"
          className="min-h-[2.5rem] text-[13px] leading-snug text-foreground transition-opacity duration-400 ease-out motion-reduce:transition-none"
          style={{ opacity: shown ? 1 : 0 }}
        >
          {TIPS[tip]}
        </p>
      </div>
    </div>
  );
}
