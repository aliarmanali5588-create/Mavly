"use client";

import React from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";

import type { AdminServiceState } from "@/lib/admin/console";

/**
 * ═══ SHARED CONSOLE PRIMITIVES ══════════════════════════════════════════════
 *
 * Small, dumb, reusable pieces. They carry no data and invent none: every one
 * of them renders exactly what it is handed, and every one of them has an
 * explicit "we do not have this" rendering so a caller cannot accidentally show
 * a zero where the answer is "unknown".
 */

// ────────────────────────────── card shell ──────────────────────────────────

export function SectionCard({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`bg-card rounded-2xl border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] ${className}`}
    >
      {(title || actions) && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-[var(--clay-line)]">
          <div className="min-w-0">
            {title && (
              <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
            )}
            {description && (
              <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

// ─────────────────────────────── stat card ──────────────────────────────────

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "neutral",
  unavailable = false,
}: {
  label: string;
  /** Pre-formatted. Pass null and `unavailable` when there is no source. */
  value: string | null;
  hint?: string;
  icon?: React.ReactNode;
  tone?: "neutral" | "positive" | "negative" | "warning";
  unavailable?: boolean;
}) {
  const valueClass =
    tone === "positive"
      ? "text-success"
      : tone === "negative"
        ? "text-foreground"
        : tone === "warning"
          ? "text-warning-subtle-foreground"
          : "text-foreground";

  return (
    <div className="p-4 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
      <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
        <span className="truncate">{label}</span>
        {icon}
      </div>
      <h3
        className={`text-xl font-bold tracking-tight font-mono mt-1 ${
          unavailable ? "text-muted-foreground" : valueClass
        }`}
      >
        {unavailable || value === null ? "—" : value}
      </h3>
      {hint && (
        <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{hint}</p>
      )}
    </div>
  );
}

// ──────────────────────────────── badges ────────────────────────────────────

const TONE_CLASS: Record<string, string> = {
  neutral: "bg-[var(--clay-sunken)] text-foreground border-[var(--clay-line)]",
  positive: "bg-success-subtle text-success-subtle-foreground border-success/25",
  negative: "bg-[var(--clay-sunken)] text-foreground border-[var(--clay-line)]",
  warning: "bg-warning-subtle text-warning-subtle-foreground border-warning/25",
  danger: "bg-[var(--clay-sunken)] text-foreground border-[var(--clay-line)]",
};

export function Badge({
  children,
  tone = "neutral",
  icon,
  mono = true,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "positive" | "negative" | "warning" | "danger";
  icon?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border ${
        TONE_CLASS[tone]
      } ${mono ? "font-mono" : ""}`}
    >
      {icon}
      {children}
    </span>
  );
}

const SERVICE_TONE: Record<AdminServiceState, "positive" | "warning" | "danger" | "neutral"> = {
  operational: "positive",
  degraded: "warning",
  down: "danger",
  unknown: "neutral",
  not_configured: "neutral",
};

export function ServiceStateBadge({ state, label }: { state: AdminServiceState; label: string }) {
  return <Badge tone={SERVICE_TONE[state]}>{label}</Badge>;
}

// ────────────────────────────── states ──────────────────────────────────────

export function LoadingBlock({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorBlock({
  message,
  onRetry,
  title = "Could not load this section",
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
      <XCircle className="w-4 h-4 text-warning" />
      <p className="text-xs font-semibold text-foreground">{title}</p>
      <p className="text-[11px] text-muted-foreground max-w-md leading-relaxed">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] border border-[var(--clay-line)] rounded-lg transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyBlock({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 py-10 px-4 text-center">
      <p className="text-xs font-semibold text-foreground">{title}</p>
      {detail && (
        <p className="text-[11px] text-muted-foreground max-w-md leading-relaxed">{detail}</p>
      )}
    </div>
  );
}

/**
 * An explicit "this number has no source" note.
 *
 * ⚠️ USED WHEREVER THE OLD UI SHOWED A PLAUSIBLE NUMBER. Saying so is the whole
 * point: an operator who sees "not recorded" knows to go and look, while one who
 * sees "99.98%" does not.
 */
export function UnavailableNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-[11px] text-muted-foreground leading-relaxed">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
}

// ────────────────────────────── controls ────────────────────────────────────

export function SearchField({
  value,
  onChange,
  placeholder,
  className = "w-full sm:w-60",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full h-8 pl-8 pr-3 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground placeholder:text-muted-foreground focus:bg-card focus:outline-none focus:ring-1 focus:ring-black shadow-[var(--clay-well-1)]"
      />
    </div>
  );
}

export function SegmentedFilter<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 bg-[var(--clay-sunken)] p-0.5 rounded-lg border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={`px-3 py-1 rounded-md text-xs transition-all ${
            value === option.id
              ? "bg-card text-foreground shadow-[var(--clay-elev-1)] font-semibold"
              : "text-muted-foreground hover:text-foreground font-medium"
          }`}
        >
          {option.label}
          {typeof option.count === "number" && (
            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
              {option.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
  icon,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  icon?: React.ReactNode;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-primary hover:bg-[var(--clay-brand-hover)] rounded-lg transition-colors shadow-[var(--clay-elev-ink-1)] disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {icon}
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  icon,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] border border-[var(--clay-line)] rounded-lg transition-colors shadow-[var(--clay-well-1)] disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {icon}
      {children}
    </button>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  loading,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : page * pageSize + 1;
  const last = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-3 border-t border-[var(--clay-line)] text-[11px] text-muted-foreground">
      <span className="font-mono">
        {total === 0 ? "No rows" : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page <= 0 || loading}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--clay-sunken)] border border-[var(--clay-line)] hover:bg-[var(--clay-sunken-deep)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-3 h-3" />
          Prev
        </button>
        <span className="font-mono">
          {page + 1} / {pageCount}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page + 1 >= pageCount || loading}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--clay-sunken)] border border-[var(--clay-line)] hover:bg-[var(--clay-sunken-deep)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Next
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────── modal ──────────────────────────────────────

export function Modal({
  title,
  icon,
  onClose,
  children,
  maxWidth = "max-w-md",
}: {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--clay-scrim)] backdrop-blur-[3px] animate-in fade-in">
      <div
        className={`bg-card rounded-2xl w-full ${maxWidth} border border-[var(--clay-line)] shadow-[var(--clay-float)] p-6 relative space-y-4 max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between pb-3 border-b border-[var(--clay-line)]">
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            <h3 className="text-sm font-bold text-foreground truncate">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-muted-foreground hover:text-black shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────── misc ───────────────────────────────────────

export function DetailRow({
  label,
  value,
  mono = false,
  wrap = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3 py-1 border-b border-[var(--clay-line)] last:border-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span
        className={`text-right ${mono ? "font-mono" : "font-semibold"} text-foreground ${
          wrap ? "break-all" : "truncate"
        }`}
      >
        {value === null || value === undefined || value === "" ? "—" : value}
      </span>
    </div>
  );
}

/** Absolute local timestamp; the console never shows a relative-only time. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
