/**
 * Pure helpers behind the v2 project pages (Usage & limits, Payments).
 * No React, no fetch — pure so they can be tested directly.
 *
 * Everything here turns an API answer into plain words or a simple shape; the numbers themselves stay the server's.
 */

import type { V2Usage } from "@/lib/vcaas-types";

// ─────────────────────────────── Usage ───────────────────────────────

/** The groups a non-technical reader recognises; every usage dimension falls in exactly one (unknown → `other`). */
export const USAGE_GROUPS = [
    "building", "actions", "hosting", "database", "files", "ai", "web", "browser", "email", "scan", "pdf",
    "realtime", "vectors", "mobile", "cron", "fees", "other",
] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

const GROUP_OF: Record<string, UsageGroup> = {
    agent_runs: "building", visual_edit: "building",
    create_project: "actions", deploy: "actions", get_source_code: "actions", recover_version: "actions",
    rebuild_project: "actions", export_project: "actions", import_project: "actions", legacy_migration: "actions", upload_file: "actions",
    database_export: "actions", turso_migration: "actions", start_server: "actions", update_file: "actions",
    lifecycle_pause: "actions", lifecycle_resume: "actions", backup_create: "database", backup_restore: "database",
    requests: "hosting", cpu_ms: "hosting", cron_runs: "cron",
    rows_read: "database", rows_written: "database", db_storage_gb_month: "database", d1_usage: "database", turso_usage: "database",
    r2_gb_month: "files", r2_class_a: "files", r2_class_b: "files", storage_monthly: "files",
    ai_chat: "ai", image_generation: "ai", image_edit: "ai", ai_video: "ai", ai_embed: "ai", ai_rerank: "ai",
    ai_speech_stt: "ai", ai_speech_tts: "ai",
    web_scraper: "web", web_search: "web", web_extract: "web",
    browser_session: "browser", browser_proxy: "browser", browser_captcha: "browser",
    email: "email", document_scan: "scan", pdf: "pdf", screenshot: "pdf",
    realtime_room_minutes: "realtime", realtime_messages: "realtime", realtime_storage_bytes: "realtime",
    vectors: "vectors", vectors_storage: "vectors",
    mobile_build_android: "mobile", mobile_build_ios_cloud: "mobile", mobile_build_ios_project: "mobile",
    project_monthly_fee: "fees", custom_domain_monthly_fee: "fees", add_custom_domain: "fees",
};

export function usageGroupOf(dimension: string): UsageGroup {
    return GROUP_OF[dimension] ?? "other";
}

/** Credits per group, biggest first, zero groups dropped. Sums the server's per-dimension credits (never invents one). */
export function usageByGroup(usage: V2Usage | null | undefined): { group: UsageGroup; credits: number }[] {
    const sums = new Map<UsageGroup, number>();
    for (const [dimension, entry] of Object.entries(usage?.totals?.byDimension ?? {})) {
        const credits = typeof entry?.credits === "number" ? entry.credits : 0;
        if (credits <= 0) continue;
        const group = usageGroupOf(dimension);
        sums.set(group, (sums.get(group) ?? 0) + credits);
    }
    return [...sums.entries()]
        .map(([group, credits]) => ({ group, credits: Math.round(credits * 10_000) / 10_000 }))
        .sort((a, b) => b.credits - a.credits);
}

/** A credit amount a person can read: `42`, `3.5`, `0.07`, `< 0.01` for a tiny non-zero amount, `0` for none. */
export function formatCreditAmount(credits: number | null | undefined, locale: "en" | "es"): string {
    if (typeof credits !== "number" || !Number.isFinite(credits) || credits === 0) return "0";
    const intl = locale === "es" ? "es-ES" : "en-GB";
    if (Math.abs(credits) < 0.01) return `< ${new Intl.NumberFormat(intl).format(0.01)}`;
    const digits = Math.abs(credits) >= 100 ? 0 : Math.abs(credits) >= 10 ? 1 : 2;
    return new Intl.NumberFormat(intl, { maximumFractionDigits: digits }).format(credits);
}

/** How full a budget is: `null` without a cap; `warn` from 80 %, `reached` at 100 %. */
export function budgetState(used: number, cap: number | null | undefined): { percent: number; level: "ok" | "warn" | "reached" } | null {
    if (typeof cap !== "number") return null;
    if (cap <= 0) return { percent: 100, level: "reached" };
    const percent = Math.min(100, Math.round((used / cap) * 100));
    return { percent, level: used >= cap ? "reached" : percent >= 80 ? "warn" : "ok" };
}

/** The first day of next month (UTC): when every monthly budget starts again. */
export function nextMonthStart(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** The three permission choices of "Create a key"; `custom` = any other set (advanced). */
export const SCOPE_PRESETS = {
    read: ["db:read"],
    readWrite: ["db:read", "db:write", "integrations:*"],
    full: ["db:read", "db:write", "db:schema", "integrations:*"],
} as const;
export type ScopePreset = keyof typeof SCOPE_PRESETS | "custom";

export function presetOf(scopes: readonly string[]): ScopePreset {
    const set = [...scopes].sort().join(",");
    for (const [name, list] of Object.entries(SCOPE_PRESETS)) if ([...list].sort().join(",") === set) return name as ScopePreset;
    return "custom";
}
