"use client";

import * as React from "react";
import {
    BotIcon,
    CheckIcon,
    RefreshCwIcon,
    RocketIcon,
    ShieldCheckIcon,
    Volume2Icon,
    WorkflowIcon,
    XIcon,
} from "lucide-react";
import {
    ConfirmDialog,
    EmptyState,
    Modal,
    StatusPill,
    type StatusTone,
} from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/lib/toast";
import { vcaasApi } from "@/lib/vcaas";
import type {
    AgentRole,
    AgentTaskStatus,
    AgentVerificationStatus,
    WorkflowEvidenceStatus,
    AgentWorkflowStatus,
    DeploymentProposalList,
    DeploymentProposalStatus,
    DeploymentProposalView,
    WorkflowState,
} from "@/lib/vcaas-types";
import { Callout, Card, Disclosure } from "./page-bits";

/**
 * ═══ AGENTS & APPROVALS (PHASE 10) ══════════════════════════════════════════
 *
 * Two truthful, read-mostly surfaces:
 *
 *   · the durable workflow the worker recorded for the latest run — task state,
 *     recorded checks and reported cost only;
 *   · the deployment proposal/approval chain, which is the ONLY way a project
 *     covered by the approval gate can reach production.
 *
 * ⚠️ NOTHING HERE FABRICATES PROGRESS. A pending build check is not a pass, a
 * model's summary is not verification, and creating/approving a proposal never
 * deploys. `Deploy` sends the approval id; the server re-derives the source and
 * atomically consumes the approval, so one approval can ship one exact source.
 */

const TASK_TONE: Record<AgentTaskStatus, StatusTone> = {
    pending: "neutral",
    waiting_for_dependency: "neutral",
    queued: "info",
    running: "info",
    completed: "success",
    failed: "danger",
    skipped: "neutral",
    cancelled: "neutral",
};

const WORKFLOW_TONE: Record<WorkflowState, StatusTone> = {
    queued: "neutral",
    planning: "info",
    executing: "info",
    verifying: "info",
    waiting_for_dependency: "warning",
    retrying: "warning",
    awaiting_approval: "warning",
    completed: "success",
    failed: "danger",
    cancelled: "neutral",
};

const PROPOSAL_TONE: Record<DeploymentProposalStatus, StatusTone> = {
    proposed: "info",
    approved: "success",
    revoked: "neutral",
    consumed: "neutral",
    expired: "warning",
};

const CHECK_TONE: Record<AgentVerificationStatus, StatusTone> = {
    passed: "success",
    failed: "danger",
    pending: "warning",
    skipped: "neutral",
    unavailable: "warning",
};

const EVIDENCE_TONE: Record<WorkflowEvidenceStatus, StatusTone> = {
    passed: "success",
    failed: "danger",
    pending: "warning",
    skipped: "neutral",
    unavailable: "warning",
    not_started: "neutral",
};

const ROLE_LABEL: Record<AgentRole, string> = {
    planner: "Planner",
    ui_ux: "UI/UX",
    coding: "Coding",
    qa: "QA",
    repair: "Repair",
    security: "Security",
    deployment: "Deployment",
};

function when(value: string | null | undefined): string {
    if (!value) return "—";
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : "unknown time";
}

function costLabel(costUsd: number | null, costKnown: boolean): string {
    if (!costKnown || typeof costUsd !== "number") return "Cost not reported";
    return `$${costUsd.toFixed(4)} reported`;
}

function durationLabel(durationMs: number | null): string {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return "duration —";
    if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} ms`;
    return `${(durationMs / 1_000).toFixed(1)} s`;
}

function summaryRecord(proposal: DeploymentProposalView): Record<string, unknown> {
    return proposal.summary && typeof proposal.summary === "object" ? proposal.summary : {};
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A proposal is deployable only in exactly this recorded state. */
function isDeployable(proposal: DeploymentProposalView, nowMs = Date.now()): boolean {
    if (proposal.status !== "approved" || proposal.consumedAt) return false;
    const expires = Date.parse(proposal.expiresAt);
    return Number.isFinite(expires) && expires > nowMs;
}

export function ProjectWorkflowPanel({
    open,
    onOpenChange,
    projectId,
    onDeployWithApproval,
    deploying = false,
    completionSoundsEnabled,
    completionSoundError,
    onEnableCompletionSounds,
    onDisableCompletionSounds,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectId: string;
    /** The page owns the deploy; this panel only supplies the approved proposal id. */
    onDeployWithApproval?: (approvalId: string) => void | Promise<void>;
    deploying?: boolean;
    completionSoundsEnabled: boolean;
    completionSoundError: string | null;
    onEnableCompletionSounds: () => void | Promise<void>;
    onDisableCompletionSounds: () => void;
}) {
    const [status, setStatus] = React.useState<AgentWorkflowStatus | null>(null);
    const [proposals, setProposals] = React.useState<DeploymentProposalList | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [workflowError, setWorkflowError] = React.useState<string | null>(null);
    const [proposalError, setProposalError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [revoking, setRevoking] = React.useState<DeploymentProposalView | null>(null);

    const load = React.useCallback(async () => {
        const [workflowResponse, proposalResponse] = await Promise.all([
            vcaasApi.agent.workflow(projectId),
            vcaasApi.deployments.proposals.list(projectId),
        ]);
        if (workflowResponse.ok) {
            setStatus(workflowResponse.data);
            setWorkflowError(null);
        } else {
            setStatus(null);
            setWorkflowError(workflowResponse.error || "The workflow record could not be read.");
        }
        if (proposalResponse.ok) {
            setProposals(proposalResponse.data);
            setProposalError(null);
        } else {
            setProposals(null);
            setProposalError(proposalResponse.error || "Deployment proposals could not be read.");
        }
        setLoading(false);
    }, [projectId]);

    React.useEffect(() => {
        if (!open) return;
        setLoading(true);
        void load();
    }, [open, load]);

    async function createProposal() {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.deployments.proposals.create(projectId, {});
        setBusy(false);
        if (response.ok) {
            toast.success("Deployment proposal recorded. Approve it to allow the exact source to be published.");
            void load();
        } else {
            toast.error("Could not create a deployment proposal", { description: response.error || undefined });
        }
    }

    async function approveProposal(proposal: DeploymentProposalView) {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.deployments.proposals.approve(projectId, proposal.id);
        setBusy(false);
        if (response.ok) {
            toast.success("Proposal approved. It can now ship exactly the source it names, once.");
            void load();
        } else {
            toast.error("Could not approve that proposal", { description: response.error || undefined });
            void load();
        }
    }

    async function revokeProposal(proposal: DeploymentProposalView) {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.deployments.proposals.revoke(projectId, proposal.id, "Revoked from the workspace");
        setBusy(false);
        if (response.ok) {
            toast.success("Deployment approval revoked.");
            void load();
        } else {
            toast.error("Could not revoke that approval", { description: response.error || undefined });
            void load();
        }
    }

    async function cancelWorkflow() {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.agent.cancelWorkflow(projectId);
        setBusy(false);
        if (response.ok) {
            setStatus(response.data);
            toast.success("Workflow record cancelled. The generation run itself is stopped with Stop, not here.");
        } else {
            toast.error("Could not cancel the workflow record", { description: response.error || undefined });
            void load();
        }
    }

    async function deploy(proposal: DeploymentProposalView) {
        if (!onDeployWithApproval || busy || deploying) return;
        await onDeployWithApproval(proposal.id);
        void load();
    }

    const workflow = status?.workflow ?? null;
    const proposalList = proposals?.proposals ?? [];

    return (
        <>
            <Modal
                open={open}
                onOpenChange={onOpenChange}
                size="lg"
                title="Agents & approvals"
                description="The durable specialist workflow for your latest generation, and the owner approval that production deployment requires."
            >
                {loading ? (
                    <Skeleton className="h-48 w-full rounded-xl" />
                ) : (
                    <div className="space-y-4 text-sm">
                        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
                            <Volume2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                                {completionSoundError
                                    ? "Task completion sounds need browser permission."
                                    : `Task completion sounds are ${completionSoundsEnabled ? "on" : "off"} for this browser.`}
                            </p>
                            <Button
                                size="sm"
                                variant={completionSoundsEnabled && !completionSoundError ? "ghost" : "outline"}
                                aria-pressed={completionSoundsEnabled && !completionSoundError}
                                onClick={() => {
                                    if (completionSoundsEnabled && !completionSoundError) onDisableCompletionSounds();
                                    else void onEnableCompletionSounds();
                                }}
                            >
                                {completionSoundsEnabled && !completionSoundError ? "Turn off" : "Enable sounds"}
                            </Button>
                            {completionSoundError ? (
                                <p role="status" className="basis-full text-xs text-destructive">
                                    {completionSoundError}
                                </p>
                            ) : null}
                        </div>
                        <Callout>
                            Agent summaries are not proof. Only recorded checks count: a pending build or runtime check is not a
                            pass, and nothing here deploys automatically. Production requires a proposal bound to the exact source
                            plus your explicit approval, and one approval can be used once.
                        </Callout>

                        {workflowError ? (
                            <Callout tone="warning" title="Workflow record unavailable">
                                {workflowError}
                            </Callout>
                        ) : null}

                        <Card
                            title="Specialist workflow"
                            description={
                                workflow
                                    ? "Recorded for this project's latest run by the durable worker."
                                    : "No workflow has been recorded for this project yet."
                            }
                            aside={
                                <Button size="icon" variant="ghost" aria-label="Refresh workflow" onClick={() => void load()}>
                                    <RefreshCwIcon className="size-4" aria-hidden />
                                </Button>
                            }
                            icon={<WorkflowIcon />}
                        >
                            {status && !status.enabled ? (
                                <p className="text-muted-foreground text-xs">
                                    Multi-agent orchestration is not enabled for this project on this deployment. The existing
                                    generation pipeline still runs; nothing here is simulated.
                                </p>
                            ) : null}
                            {status?.migrationRequired ? (
                                <Callout tone="warning" title="Migration required">
                                    {status.note ?? "Apply supabase/migrations/29_multi_agent_orchestration.sql to record workflows."}
                                </Callout>
                            ) : null}

                            {workflow ? (
                                <div className="space-y-4">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <StatusPill tone={WORKFLOW_TONE[workflow.state]} dot>
                                            {workflow.state.replaceAll("_", " ")}
                                        </StatusPill>
                                        <span className="text-muted-foreground text-xs">
                                            {workflow.complexity} · started {when(workflow.startedAt)}
                                            {workflow.finishedAt ? ` · finished ${when(workflow.finishedAt)}` : ""}
                                        </span>
                                        <span className="min-w-0 flex-1" />
                                        <span className="text-muted-foreground text-xs">
                                            {workflow.providerCalls} model call(s) · {costLabel(workflow.reportedCostUsd, workflow.costKnown)}
                                        </span>
                                    </div>

                                     {workflow.summary ? (
                                         <p className="text-xs whitespace-pre-wrap">{workflow.summary}</p>
                                     ) : null}
                                     <div className="rounded-lg border p-3">
                                         <div className="mb-2 flex flex-wrap items-center gap-2">
                                             <span className="text-xs font-medium">Evidence status</span>
                                             <StatusPill tone={workflow.verification.fullyVerified ? "success" : "warning"}>
                                                 {workflow.verification.fullyVerified ? "fully verified" : "not fully verified"}
                                             </StatusPill>
                                         </div>
                                         <div className="grid gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
                                             {([
                                                 ["Generated", workflow.verification.generated],
                                                 ["Structurally valid", workflow.verification.structurallyValid],
                                                 ["Compiled", workflow.verification.compiled],
                                                 ["Rendered", workflow.verification.rendered],
                                                 ["Functionally verified", workflow.verification.functionallyVerified],
                                                 ["Security reviewed", workflow.verification.securityReviewed],
                                                 ["Deployment verified", workflow.verification.deploymentVerified],
                                             ] as const).map(([label, evidence]) => (
                                                 <div key={label} className="flex items-center gap-1.5">
                                                     <StatusPill tone={EVIDENCE_TONE[evidence]}>{evidence.replaceAll("_", " ")}</StatusPill>
                                                     <span className="text-muted-foreground">{label}</span>
                                                 </div>
                                             ))}
                                         </div>
                                     </div>
                                     {workflow.errorClass ? (
                                         <p className="text-destructive text-xs">Error class: {workflow.errorClass}</p>
                                     ) : null}

                                    {workflow.tasks.length === 0 ? (
                                        <p className="text-muted-foreground text-xs">No specialist tasks were recorded.</p>
                                    ) : (
                                        <ul className="divide-[var(--clay-line)] divide-y">
                                            {workflow.tasks.map(task => (
                                                <li key={task.key} className="space-y-1.5 py-2">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <StatusPill tone={TASK_TONE[task.status]} dot={task.status === "running"}>
                                                            {task.status.replaceAll("_", " ")}
                                                        </StatusPill>
                                                        <span className="text-xs font-medium">{task.title}</span>
                                                         <span className="text-muted-foreground text-[11px]">
                                                             {ROLE_LABEL[task.role]} · attempt {task.attempt}/{task.maxAttempts} · retries {task.retryCount}
                                                             {task.required ? " · required" : " · optional"}
                                                         </span>
                                                         <span className="text-muted-foreground text-[11px]">
                                                             {task.eligible ? "eligible" : "ineligible"} · {task.scheduleReason ?? "not scheduled"}
                                                         </span>
                                                     </div>
                                                     <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                                                         <span>{task.scheduled ? (task.startedAt ? "executed" : "scheduled") : "not scheduled"}</span>
                                                         <span>{durationLabel(task.durationMs)}</span>
                                                         <span>{task.provider ?? "provider —"}</span>
                                                         <span className="font-mono">{task.model ?? "model —"}</span>
                                                         <span>output {task.outputProduced ? "produced" : "not produced"}</span>
                                                         <span>output {task.outputConsumed ? "consumed" : "not consumed"}</span>
                                                     </div>
                                                     {!task.eligible && task.eligibilityReason ? (
                                                         <p className="text-muted-foreground text-[11px]">Eligibility: {task.eligibilityReason}</p>
                                                     ) : null}
                                                     {task.skipReason ? (
                                                         <p className="text-muted-foreground text-[11px]">Skip reason: {task.skipReason}</p>
                                                     ) : null}
                                                     {task.failureReason ? (
                                                         <p className="text-destructive text-[11px]">Failure reason: {task.failureReason}</p>
                                                     ) : null}
                                                     {task.summary ? (
                                                        <p className="text-muted-foreground text-xs whitespace-pre-wrap">{task.summary}</p>
                                                    ) : null}
                                                    {task.errorClass ? (
                                                        <p className="text-destructive text-[11px]">Error class: {task.errorClass}</p>
                                                    ) : null}
                                                    {task.filesChanged.length > 0 ? (
                                                        <p className="text-muted-foreground text-[11px]">
                                                            Files changed: <span className="font-mono">{task.filesChanged.join(", ")}</span>
                                                        </p>
                                                    ) : null}
                                                    {task.verification ? (
                                                        <div className="space-y-1">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <StatusPill tone={CHECK_TONE[task.verification.status]}>
                                                                    verification: {task.verification.status}
                                                                </StatusPill>
                                                                <span className="text-muted-foreground text-[11px]">
                                                                    {task.verification.summary}
                                                                </span>
                                                            </div>
                                                            <ul className="space-y-1">
                                                                {task.verification.checks.map(check => (
                                                                    <li key={check.id} className="flex flex-wrap items-start gap-2 text-[11px]">
                                                                        <StatusPill tone={CHECK_TONE[check.status]}>{check.status}</StatusPill>
                                                                        <span className="min-w-0 flex-1">
                                                                            <span className="font-medium">{check.label}</span>
                                                                            {check.detail ? (
                                                                                <span className="text-muted-foreground"> — {check.detail}</span>
                                                                            ) : null}
                                                                        </span>
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        </div>
                                                    ) : null}
                                                    {task.findings.length > 0 ? (
                                                        <ul className="space-y-1">
                                                            {task.findings.slice(0, 12).map(finding => (
                                                                <li key={finding.id} className="flex flex-wrap items-start gap-2 text-[11px]">
                                                                    <StatusPill
                                                                        tone={
                                                                            finding.severity === "critical" || finding.severity === "high"
                                                                                ? "danger"
                                                                                : finding.severity === "medium"
                                                                                    ? "warning"
                                                                                    : "neutral"
                                                                        }
                                                                    >
                                                                        {finding.severity}
                                                                    </StatusPill>
                                                                    <span className="min-w-0 flex-1">
                                                                        <span className="font-medium">{finding.title}</span>
                                                                        {finding.path ? (
                                                                            <span className="text-muted-foreground font-mono"> {finding.path}{finding.line ? `:${finding.line}` : ""}</span>
                                                                        ) : null}
                                                                        <span className="text-muted-foreground"> — {finding.detail}</span>
                                                                    </span>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    ) : null}
                                                </li>
                                            ))}
                                        </ul>
                                    )}

                                    {workflow.state !== "completed" && workflow.state !== "failed" && workflow.state !== "cancelled" ? (
                                        <div className="flex justify-end">
                                            <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancelWorkflow()}>
                                                <XIcon className="size-4" aria-hidden />
                                                Cancel workflow record
                                            </Button>
                                        </div>
                                    ) : null}
                                </div>
                            ) : !workflowError && !status?.migrationRequired ? (
                                <EmptyState
                                    variant="panel"
                                    icon={<BotIcon />}
                                    title="No recorded workflow"
                                    description="Orchestration records appear after a durable-worker generation for this project. Inline runs keep the existing pipeline and record nothing here."
                                />
                            ) : null}
                        </Card>

                        <Card
                            title="Deployment approval"
                            description={
                                proposals?.approvalRequired
                                    ? "This project cannot publish without an owner-approved proposal for the exact source."
                                    : "The approval gate is not enabled for this project. Proposals can still be recorded, but a deploy does not require one."
                            }
                            icon={<ShieldCheckIcon />}
                        >
                            {proposalError ? (
                                <Callout tone="warning" title="Deployment approvals unavailable">
                                    {proposalError}
                                </Callout>
                            ) : (
                                <div className="space-y-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Button size="sm" disabled={busy} onClick={() => void createProposal()}>
                                            <RocketIcon className="size-4" aria-hidden />
                                            Create proposal from current source
                                        </Button>
                                        <span className="text-muted-foreground text-[11px]">
                                            The server derives the target, snapshot and hash. This does not deploy.
                                        </span>
                                    </div>

                                    {proposalList.length === 0 ? (
                                        <p className="text-muted-foreground text-xs">No deployment proposals yet.</p>
                                    ) : (
                                        <ul className="divide-[var(--clay-line)] divide-y">
                                            {proposalList.map(proposal => {
                                                const summary = summaryRecord(proposal);
                                                const risks = stringList(summary.risks);
                                                const deployable = isDeployable(proposal);
                                                return (
                                                    <li key={proposal.id} className="space-y-2 py-2">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <StatusPill tone={PROPOSAL_TONE[proposal.status]}>
                                                                {proposal.status}
                                                            </StatusPill>
                                                            <span className="text-xs font-medium">{proposal.target}</span>
                                                            <span className="text-muted-foreground text-[11px]">
                                                                created {when(proposal.createdAt)} · expires {when(proposal.expiresAt)}
                                                            </span>
                                                            <span className="min-w-0 flex-1" />
                                                            {proposal.status === "proposed" ? (
                                                                <>
                                                                    <Button
                                                                        size="sm"
                                                                        disabled={busy}
                                                                        onClick={() => void approveProposal(proposal)}
                                                                    >
                                                                        <CheckIcon className="size-4" aria-hidden />
                                                                        Approve
                                                                    </Button>
                                                                    <Button
                                                                        size="sm"
                                                                        variant="ghost"
                                                                        disabled={busy}
                                                                        onClick={() => setRevoking(proposal)}
                                                                    >
                                                                        Revoke
                                                                    </Button>
                                                                </>
                                                            ) : null}
                                                            {proposal.status === "approved" ? (
                                                                <>
                                                                    <Button
                                                                        size="sm"
                                                                        disabled={busy || deploying || !deployable || !onDeployWithApproval}
                                                                        onClick={() => void deploy(proposal)}
                                                                    >
                                                                        <RocketIcon className="size-4" aria-hidden />
                                                                        Deploy this approval
                                                                    </Button>
                                                                    <Button
                                                                        size="sm"
                                                                        variant="ghost"
                                                                        disabled={busy}
                                                                        onClick={() => setRevoking(proposal)}
                                                                    >
                                                                        Revoke
                                                                    </Button>
                                                                </>
                                                            ) : null}
                                                        </div>

                                                        <dl className="text-muted-foreground grid gap-1 text-[11px] sm:grid-cols-2">
                                                            <div>
                                                                <dt className="inline">Source hash: </dt>
                                                                <dd className="inline font-mono break-all">{proposal.sourceHash.slice(0, 16)}…</dd>
                                                            </div>
                                                            <div>
                                                                <dt className="inline">Snapshot: </dt>
                                                                <dd className="inline font-mono break-all">{proposal.snapshotId ?? "none (static file set)"}</dd>
                                                            </div>
                                                            {summary.fileCount !== undefined ? (
                                                                <div>
                                                                    <dt className="inline">Files: </dt>
                                                                    <dd className="inline">{String(summary.fileCount)}</dd>
                                                                </div>
                                                            ) : null}
                                                            {summary.entryPoint !== undefined ? (
                                                                <div>
                                                                    <dt className="inline">Entry point: </dt>
                                                                    <dd className="inline font-mono">{String(summary.entryPoint)}</dd>
                                                                </div>
                                                            ) : null}
                                                            {summary.verification !== undefined ? (
                                                                <div>
                                                                    <dt className="inline">Verification: </dt>
                                                                    <dd className="inline">{String(summary.verification)}</dd>
                                                                </div>
                                                            ) : null}
                                                        </dl>

                                                        {proposal.status === "approved" && !deployable && !proposal.consumedAt ? (
                                                            <p className="text-muted-foreground text-[11px]">
                                                                This approval is expired. Create and approve a fresh proposal.
                                                            </p>
                                                        ) : null}
                                                        {risks.length > 0 ? (
                                                            <ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-[11px]">
                                                                {risks.map(risk => <li key={risk}>{risk}</li>)}
                                                            </ul>
                                                        ) : null}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </div>
                            )}
                        </Card>

                        <Disclosure title="What these agents can and cannot do" hint="Scoped roles, no automatic deploy">
                            <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs leading-relaxed">
                                <li>The planner and UI/UX roles produce advisory context for the existing generation pipeline.</li>
                                <li>Coding is the existing generation engine; it remains the only writer of project files.</li>
                                <li>QA delegates to the isolated verification sandbox. Until that records passed, build and runtime stay pending or unavailable.</li>
                                <li>The security role is a deterministic static scan. A clean scan is not a runtime proof.</li>
                                <li>The repair role is diagnostic only: it proposes fixes and never writes source in this phase.</li>
                                <li>The deployment role can only propose. Approval is yours, and the server consumes it atomically.</li>
                            </ul>
                        </Disclosure>
                    </div>
                )}
            </Modal>

            <ConfirmDialog
                open={!!revoking}
                onOpenChange={next => { if (!next) setRevoking(null); }}
                tone="danger"
                title="Revoke this deployment approval?"
                description="The proposal can no longer be used to deploy. Already-published sites and project files are not touched."
                confirmLabel="Revoke"
                onConfirm={async () => { if (revoking) await revokeProposal(revoking); }}
            />
        </>
    );
}
