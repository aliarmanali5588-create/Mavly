import * as React from "react";
import { ChevronRightIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The small building blocks the v2 project pages share, so the five of them read as one product: a disclosure for
 * advanced details (native `<details>`: keyboard and screen-reader friendly, no state), a callout for the one thing to
 * know, and a titled card.
 */
export function Disclosure({
    title,
    hint,
    defaultOpen,
    children,
    className,
    testId,
}: {
    title: React.ReactNode;
    hint?: React.ReactNode;
    defaultOpen?: boolean;
    children: React.ReactNode;
    className?: string;
    testId?: string;
}) {
    return (
        <details className={cn("group border-[var(--clay-line)] bg-card rounded-xl border shadow-[var(--clay-elev-1)]", className)} open={defaultOpen} data-testid={testId}>
            <summary className="hover:bg-[var(--clay-sunken)] flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium select-none transition-colors [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
                <span className="min-w-0 flex-1">
                    {title}
                    {hint ? <span className="text-muted-foreground block text-xs font-normal">{hint}</span> : null}
                </span>
            </summary>
            <div className="space-y-4 px-4 pt-1 pb-4">{children}</div>
        </details>
    );
}

export function Callout({ tone = "info", title, children, className, testId }: { tone?: "info" | "warning"; title?: React.ReactNode; children?: React.ReactNode; className?: string; testId?: string }) {
    const Icon = tone === "warning" ? TriangleAlertIcon : InfoIcon;
    return (
        <div
            data-testid={testId}
            className={cn(
                "flex gap-3 rounded-xl border p-3 text-sm",
                tone === "warning" ? "border-warning/40 bg-warning-subtle text-warning-subtle-foreground" : "border-info/20 bg-info-subtle text-info-subtle-foreground",
                className,
            )}
        >
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 space-y-1">
                {title ? <p className="font-medium">{title}</p> : null}
                {children ? <div className="text-[13px] leading-relaxed opacity-90">{children}</div> : null}
            </div>
        </div>
    );
}

export function Card({
    title,
    description,
    aside,
    icon,
    children,
    className,
    testId,
}: {
    title?: React.ReactNode;
    description?: React.ReactNode;
    aside?: React.ReactNode;
    icon?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
    testId?: string;
}) {
    return (
        <section className={cn("border-[var(--clay-line)] bg-card space-y-3 rounded-xl border p-4 shadow-[var(--clay-elev-1)]", className)} data-testid={testId}>
            {title || aside ? (
                <div className="flex items-start gap-3">
                    {icon ? <span className="border-[var(--clay-line)] bg-[var(--clay-sunken)] text-foreground flex size-9 shrink-0 items-center justify-center rounded-xl border shadow-[var(--clay-well-1)] [&_svg]:size-4.5">{icon}</span> : null}
                    <div className="min-w-0 flex-1">
                        {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
                        {description ? <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">{description}</p> : null}
                    </div>
                    {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
                </div>
            ) : null}
            {children}
        </section>
    );
}

/** A segmented choice (Total / Live / Dev …): one `group` of pressed buttons, as the database explorer's env switch. */
export function Segmented<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: { value: T; label: string }[];
    onChange: (value: T) => void;
}) {
    return (
        <div role="group" aria-label={label} className="border-[var(--clay-line)] bg-[var(--clay-sunken)] inline-flex rounded-xl border p-0.5 shadow-[var(--clay-well-1)]">
            {options.map(option => (
                <button
                    key={option.value}
                    type="button"
                    aria-pressed={value === option.value}
                    onClick={() => onChange(option.value)}
                    className={cn(
                        "rounded-lg px-3 py-1 text-xs font-medium transition-[box-shadow,background-color]",
                        value === option.value ? "bg-card text-foreground shadow-[var(--clay-elev-1)]" : "text-muted-foreground hover:text-foreground",
                    )}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
