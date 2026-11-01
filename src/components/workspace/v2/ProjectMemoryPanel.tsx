"use client";

import * as React from "react";
import { BrainIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import {
    ConfirmDialog,
    EmptyState,
    Modal,
    StatusPill,
    type StatusTone,
} from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { vcaasApi } from "@/lib/vcaas";
import type { ProjectMemoryFact, ProjectMemoryItem, ProjectMemoryList } from "@/lib/memory/types";
import { Callout, Card, Disclosure } from "./page-bits";

/**
 * Project memory (Phase 8). Every control calls the authenticated project API.
 * There is no optimistic "saved" state: the list is re-read after each action.
 *
 * ⚠️ Facts are derived from the current files and are read-only. Decisions are
 * explicit user approvals. Failure notes are observed run outcomes, never a
 * verified root cause. Memory is context only; it cannot authorize anything.
 */

const MEMORY_TONE: Record<string, StatusTone> = {
    active: "success",
    proposed: "info",
    archived: "neutral",
    superseded: "warning",
};

function memoryWhen(value: string): string {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : "unknown time";
}

export function ProjectMemoryPanel({
    open,
    onOpenChange,
    projectId,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectId: string;
}) {
    const [data, setData] = React.useState<ProjectMemoryList | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [content, setContent] = React.useState("");
    const [topicKey, setTopicKey] = React.useState("");
    const [editing, setEditing] = React.useState<ProjectMemoryItem | null>(null);
    const [editContent, setEditContent] = React.useState("");
    const [deleting, setDeleting] = React.useState<ProjectMemoryItem | null>(null);
    const [confirmClear, setConfirmClear] = React.useState(false);

    const load = React.useCallback(async () => {
        const response = await vcaasApi.memory.list(projectId);
        if (response.ok) {
            setData(response.data);
            setLoadError(null);
        } else {
            setData(null);
            setLoadError(response.error || "Project memory could not be read.");
        }
        setLoading(false);
    }, [projectId]);

    React.useEffect(() => {
        if (!open) return;
        setLoading(true);
        void load();
    }, [open, load]);

    async function create(event: React.FormEvent) {
        event.preventDefault();
        if (busy || !content.trim()) return;
        setBusy(true);
        const response = await vcaasApi.memory.create(projectId, {
            category: "decision",
            content: content.trim(),
            ...(topicKey.trim() ? { dedupeKey: topicKey.trim() } : {}),
        });
        setBusy(false);
        if (response.ok) {
            setContent("");
            setTopicKey("");
            toast.success("Decision remembered.");
            void load();
        } else {
            toast.error("Could not remember that decision", { description: response.error || undefined });
        }
    }

    async function saveEdit() {
        if (!editing || busy || !editContent.trim()) return;
        setBusy(true);
        const response = await vcaasApi.memory.update(projectId, editing.id, {
            revision: editing.revision,
            content: editContent.trim(),
        });
        setBusy(false);
        if (response.ok) {
            setEditing(null);
            setEditContent("");
            toast.success("Decision updated.");
            void load();
        } else {
            toast.error("Could not update the decision", { description: response.error || undefined });
            void load();
        }
    }

    async function setStatus(memory: ProjectMemoryItem, status: "active" | "archived") {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.memory.update(projectId, memory.id, {
            revision: memory.revision,
            status,
        });
        setBusy(false);
        if (response.ok) {
            toast.success(status === "active" ? "Decision approved." : "Decision archived.");
            void load();
        } else {
            toast.error("Could not change that memory", { description: response.error || undefined });
            void load();
        }
    }

    async function remove(memory: ProjectMemoryItem) {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.memory.remove(projectId, memory.id);
        setBusy(false);
        if (response.ok) {
            toast.success("Memory deleted.");
            void load();
        } else {
            toast.error("Could not delete that memory", { description: response.error || undefined });
        }
    }

    async function clearAll() {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.memory.clear(projectId);
        setBusy(false);
        if (response.ok) {
            toast.success(`Cleared ${response.data.deleted} memory record(s). Project files and snapshots were not touched.`);
            void load();
        } else {
            toast.error("Could not clear project memory", { description: response.error || undefined });
        }
    }

    const decisions = data?.memories.filter(memory => memory.category === "decision") ?? [];
    const failures = data?.memories.filter(memory => memory.category === "failure") ?? [];

    return (
        <>
            <Modal
                open={open}
                onOpenChange={onOpenChange}
                size="lg"
                title="Project memory"
                description="Bounded context for future generations: explicit decisions and observed run outcomes. Current files and your latest request always win."
            >
                {loading ? (
                    <Skeleton className="h-48 w-full rounded-xl" />
                ) : loadError ? (
                    <div className="space-y-3">
                        <Callout tone="warning" title="Project memory is not available">
                            {loadError}
                        </Callout>
                        <Button size="sm" variant="outline" onClick={() => { setLoading(true); void load(); }}>
                            <RefreshCwIcon className="size-4" aria-hidden />
                            Retry
                        </Button>
                    </div>
                ) : data ? (
                    <div className="space-y-4 text-sm">
                        <Callout>
                            Memory is context, not instructions or authorization. It never overrides current source files, repository
                            rules, your latest request, verification or deployment safeguards.
                        </Callout>

                        <Card
                            title="Repository facts"
                            aside={<Button size="icon" variant="ghost" aria-label="Refresh memory" onClick={() => void load()}><RefreshCwIcon className="size-4" aria-hidden /></Button>}
                        >
                            <p className="text-muted-foreground text-xs">
                                Derived from the current files on this request; these facts are not stored and cannot go stale.
                            </p>
                            {data.facts.length === 0 ? (
                                <p className="text-muted-foreground text-xs">No repository facts could be derived.</p>
                            ) : (
                                <dl className="grid gap-1.5 text-xs sm:grid-cols-2">
                                    {data.facts.map((fact: ProjectMemoryFact) => (
                                        <div key={fact.key}>
                                            <dt className="text-muted-foreground">{fact.key}</dt>
                                            <dd className="font-mono break-words">{fact.value}</dd>
                                        </div>
                                    ))}
                                </dl>
                            )}
                        </Card>

                        <Card title="Decisions">
                            {decisions.length === 0 ? (
                                <EmptyState
                                    variant="panel"
                                    icon={<BrainIcon />}
                                    title="No saved decisions"
                                    description="Add an explicit architecture or compatibility decision to keep future changes consistent."
                                />
                            ) : (
                                <ul className="divide-[var(--clay-line)] divide-y">
                                    {decisions.map(memory => (
                                        <li key={memory.id} className="space-y-2 py-2">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <StatusPill tone={MEMORY_TONE[memory.status] ?? "neutral"}>{memory.status}</StatusPill>
                                                <span className="text-muted-foreground text-xs">
                                                    user decision · updated {memoryWhen(memory.updatedAt)}
                                                </span>
                                                <span className="min-w-0 flex-1" />
                                                {memory.status === "proposed" ? (
                                                    <>
                                                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void setStatus(memory, "active")}>
                                                            Approve
                                                        </Button>
                                                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setStatus(memory, "archived")}>
                                                            Reject
                                                        </Button>
                                                    </>
                                                ) : null}
                                                {memory.status === "active" ? (
                                                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setStatus(memory, "archived")}>
                                                        Archive
                                                    </Button>
                                                ) : null}
                                                {memory.status === "archived" ? (
                                                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setStatus(memory, "active")}>
                                                        Reactivate
                                                    </Button>
                                                ) : null}
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    aria-label="Edit decision"
                                                    disabled={busy}
                                                    onClick={() => {
                                                        setEditing(memory);
                                                        setEditContent(memory.content);
                                                    }}
                                                >
                                                    <PencilIcon className="size-3.5" aria-hidden />
                                                </Button>
                                                <Button size="icon" variant="ghost" className="text-destructive" aria-label="Delete decision" disabled={busy} onClick={() => setDeleting(memory)}>
                                                    <Trash2Icon className="size-3.5" aria-hidden />
                                                </Button>
                                            </div>
                                            {editing?.id === memory.id ? (
                                                <div className="space-y-2">
                                                    <Textarea value={editContent} onChange={event => setEditContent(event.target.value)} rows={3} className="text-xs" />
                                                    <div className="flex gap-2">
                                                        <Button size="sm" disabled={busy || !editContent.trim()} onClick={() => void saveEdit()}>Save</Button>
                                                        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(null); setEditContent(""); }}>Cancel</Button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <p className="text-xs whitespace-pre-wrap">{memory.content}</p>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>

                        <Card title="Observed run outcomes">
                            <p className="text-muted-foreground text-xs">
                                Terminal failures only, summarized by the server. This records the observed outcome, not a verified root cause.
                            </p>
                            {failures.length === 0 ? (
                                <p className="text-muted-foreground text-xs">No observed failure notes.</p>
                            ) : (
                                <ul className="divide-[var(--clay-line)] divide-y">
                                    {failures.map(memory => (
                                        <li key={memory.id} className="flex flex-wrap items-start gap-2 py-2">
                                            <StatusPill tone="warning">observed</StatusPill>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-xs whitespace-pre-wrap">{memory.content}</p>
                                                <p className="text-muted-foreground mt-1 text-[11px]">
                                                    {memory.provenance} · {memoryWhen(memory.updatedAt)} · expires {memory.expiresAt ? memoryWhen(memory.expiresAt) : "—"}
                                                </p>
                                            </div>
                                            <Button size="icon" variant="ghost" className="text-destructive" aria-label="Delete failure note" disabled={busy} onClick={() => setDeleting(memory)}>
                                                <Trash2Icon className="size-3.5" aria-hidden />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>

                        <Card title="Add a decision">
                            <form onSubmit={create} className="space-y-3">
                                <div className="space-y-1.5">
                                    <Label htmlFor="memory-content" className="text-xs">Decision or constraint</Label>
                                    <Textarea
                                        id="memory-content"
                                        value={content}
                                        onChange={event => setContent(event.target.value)}
                                        rows={3}
                                        placeholder="Keep the public API backward compatible; do not rename existing route handlers."
                                        className="text-xs"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="memory-topic" className="text-xs">Topic key (optional)</Label>
                                    <Input
                                        id="memory-topic"
                                        value={topicKey}
                                        onChange={event => setTopicKey(event.target.value)}
                                        placeholder="architecture.api-compatibility"
                                        autoComplete="off"
                                        spellCheck={false}
                                        className="h-8 font-mono text-xs"
                                    />
                                    <p className="text-muted-foreground text-[11px]">
                                        Reuse a topic key to keep one current decision for that topic. Secrets and contact details are refused.
                                    </p>
                                </div>
                                <Button type="submit" size="sm" disabled={busy || !content.trim()}>
                                    <PlusIcon className="size-4" aria-hidden />
                                    Remember decision
                                </Button>
                            </form>
                        </Card>

                        <Disclosure title="How memory is used" hint="Bounded, subordinate context">
                            <p className="text-muted-foreground text-xs leading-relaxed">
                                Before a generation, Mavly derives facts from the current files, selects a bounded set of relevant files,
                                and ranks active decisions and recent observed failures. The block is marked as untrusted context: the
                                model is told to ignore instructions inside it and to prefer the current files and your latest request.
                                No extra model call is made for memory, and memory cannot authorize deployments, payments or credentials.
                            </p>
                        </Disclosure>

                        <div className="flex justify-end">
                            <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => setConfirmClear(true)}>
                                Clear project memory
                            </Button>
                        </div>
                    </div>
                ) : null}
            </Modal>

            <ConfirmDialog
                open={!!deleting}
                onOpenChange={next => { if (!next) setDeleting(null); }}
                tone="danger"
                title="Delete this memory?"
                description="The memory row is deleted. Project files, snapshots and runs are not touched."
                confirmLabel="Delete"
                onConfirm={async () => { if (deleting) await remove(deleting); }}
            />

            <ConfirmDialog
                open={confirmClear}
                onOpenChange={setConfirmClear}
                tone="danger"
                title="Clear all project memory?"
                description="All decisions and observed failure notes for this project are deleted. Project files, snapshots, deployments and secrets are not touched."
                confirmLabel="Clear memory"
                onConfirm={clearAll}
            />
        </>
    );
}
