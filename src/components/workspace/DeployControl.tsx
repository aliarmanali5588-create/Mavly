"use client";

import * as React from "react";
import {
    ArrowRightIcon,
    CheckIcon,
    ClockIcon,
    CoinsIcon,
    ExternalLinkIcon,
    GlobeIcon,
    LoaderIcon,
    RocketIcon,
    TriangleAlertIcon,
} from "lucide-react";
import { ConfirmDialog, CopyButton, Modal, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { getDomainProgress } from "@/lib/domain-status";
import { engineOf, getPublishedHost } from "@/lib/project-status";
import { usePrice } from "@/components/credits/CreditsProvider";
import { cn } from "@/lib/utils";
import type { DeploymentStatus, VcaasProject } from "@/lib/vcaas-types";
import { DomainPendingBadge, DomainProgressCompact } from "./DomainProgress";

/**
 * ═══ THE PUBLISH DIALOG ═════════════════════════════════════════════════════
 *
 * Publishing is the moment a private sandbox becomes something the world can
 * reach. This is where the user sees, in one place: whether they are already
 * live, at what address, what it costs, how long it takes, and what a custom
 * domain would change.
 *
 * ── WHY THIS IS A DIALOG AND NOT THE POPOVER IT WAS ─────────────────────────
 *
 * The old version was a 320px popover with `p-0` on the container and `p-3`
 * inside it, which produced the specific cramped look this rewrite exists to fix:
 * a 12px gutter around a URL, a button and three lines of fine print, all at 11px,
 * with the live address squeezed into ~200px and truncated. It also inherited the
 * popover's behaviour — it closed on any outside click, so reading the domain
 * notice and glancing at the preview dismissed it.
 *
 * A dialog is the right container for a decision that spends a credit and changes
 * who can see your work: it holds still, it has room, and its footer gives the
 * primary action somewhere to live that is not the middle of the content.
 *
 * ── WHAT THE CONTENT ACTUALLY SAYS NOW ──────────────────────────────────────
 *
 *   · **The address, once, at a readable size**, with copy and open beside it —
 *     not a truncated `<code>` inside a tinted box.
 *   · **What publishing does**, in three lines that answer the three questions
 *     people ask before clicking: what happens, how long, what it costs. The cost
 *     was previously a comment in this file and appeared nowhere on screen.
 *   · **The custom domain** as a row that reads as a setting, with its status,
 *     rather than a second button competing with the primary action.
 *
 * ⚠️ Deploying costs 1 credit (`VCAAS_CREDIT_COSTS.CREATE_DEPLOYMENT`), stated
 * next to the button that spends it.
 *
 * ⚠️ PHASE 10 HOOK — custom domains are a PAID feature. The row is tagged
 * `data-phase="10-paid-domain"` and is deliberately visible and enabled for free
 * accounts: a free user must SEE the feature and understand its value, never meet
 * a dead or invisible control.
 *
 * ── THE UNFINISHED DOMAIN ───────────────────────────────────────────────────
 *
 * ⭐ A DOMAIN THAT IS ATTACHED BUT NOT YET LIVE IS AN UNFINISHED JOB WITH NO HOME.
 * The DNS records sit two clicks away inside a modal, and nothing on the workspace
 * remembered them for you — so people added a domain, closed the dialog, and only
 * found out days later that the records were never added.
 *
 * `DomainPendingBadge` sits directly beside Publish for exactly as long as that is
 * true, and opens the domain modal where the records are. Inside this dialog the
 * same state renders as `DomainProgressCompact` under the domain row: a bar, the
 * step it is on, and how far along it is. Both read `project.customDomain` through
 * `@/lib/domain-status`, so removing the domain removes them.
 */

export interface DeployControlProps {
    projectId: string;
    project: VcaasProject | null;
    /** The authoritative state from `GET deployments/status`, when loaded. */
    deploymentStatus?: DeploymentStatus | null;
    isDeploying: boolean;
    /** True while the unpublish request is in flight (or a previous one is durable). */
    isUnpublishing?: boolean;
    /** Deploying mid-run would publish a half-written build. */
    isRunning: boolean;
    /**
     * ⭐ ANOTHER LONG OPERATION IS IN FLIGHT — a rebuild, a GitHub pull, a server
     * restart — as an already-translated sentence naming which. See
     * `@/lib/project-operation`.
     *
     * ⚠️ THE DIALOG STILL OPENS. Everything in it except the button is READING: the
     * live address, what publishing does, the domain row and its progress. Refusing to
     * open it would deny somebody the URL of their own site because a rebuild is
     * running. Only the button goes dead, with the reason printed above it.
     */
    blockedReason?: string | null;
    onDeploy: () => void;
    onOpenDomain: () => void;
    /** Runs the real unpublish and rejects when the backend did not confirm it. */
    onUnpublish: () => Promise<void>;
    /** Optional controlled state, so a mobile menu item can open the same dialog. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function DeployControl({
    projectId,
    project,
    deploymentStatus = null,
    isDeploying,
    isUnpublishing: isUnpublishingProp = false,
    isRunning,
    blockedReason = null,
    onDeploy,
    onOpenDomain,
    onUnpublish,
    open: openProp,
    onOpenChange,
}: DeployControlProps) {
    const t = useT();
    const price = usePrice();
    const [internalOpen, setInternalOpen] = React.useState(false);
    const [confirmUnpublish, setConfirmUnpublish] = React.useState(false);
    const [unpublishError, setUnpublishError] = React.useState<string | null>(null);
    const open = openProp ?? internalOpen;
    const setOpen = onOpenChange ?? setInternalOpen;

    const wireStatus = deploymentStatus?.status ?? null;
    const projectStatus = project?.deployment?.status ?? null;
    const isPublished = wireStatus === "success" || (wireStatus === null && projectStatus === "success");
    const isUnpublishing = isUnpublishingProp || wireStatus === "unpublishing";
    const isPublishing = isDeploying || wireStatus === "deploying";
    const isFailed =
        !isPublished &&
        !isPublishing &&
        !isUnpublishing &&
        (wireStatus === "error" || (wireStatus === null && projectStatus === "error"));
    const isUnpublished = wireStatus === "unpublished";
    const canUnpublish =
        !isUnpublishing && !isPublishing && (Boolean(deploymentStatus?.canUnpublish) || isPublished);
    const domain = project?.customDomain;
    const domainProgress = getDomainProgress(domain);

    /**
     * The host the project serves on once published.
     *
     * ⚠️ SHARED WITH THE JUST-PUBLISHED DIALOG through `getPublishedHost`. The two
     * screens name the same address seconds apart — "it will be live at X" and then
     * "it is live at X" — so a second copy of this fallback chain is a second chance
     * for them to disagree.
     */
    const publishedHost = getPublishedHost(project, projectId);

    const liveUrl = `https://${publishedHost}`;

    async function handleUnpublish() {
        setUnpublishError(null);
        try {
            await onUnpublish();
            setOpen(false);
        } catch (error) {
            /**
             * The confirmation stays open on purpose: the user must be able to
             * read the backend's reason and retry without guessing what happened.
             */
            setUnpublishError(
                error instanceof Error && error.message
                    ? error.message
                    : t("workspace.deploy.unpublishFailed"),
            );
            throw error;
        }
    }

    return (
        <>
            {/*
              ⭐ THE PENDING-DOMAIN BADGE. Before Publish rather than after it: it is
              a state, and the button is the action — and on a narrow header the
              action must never be the thing that gets pushed off the edge.
            */}
            <DomainPendingBadge domain={domain} onOpen={onOpenDomain} className="mr-1" />

            <Button
                size="sm"
                className="h-7 shrink-0 gap-1.5 px-2.5"
                disabled={isRunning}
                onClick={() => setOpen(true)}
            >
                {isPublishing ? (
                    <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                ) : (
                    <RocketIcon className="size-3.5" aria-hidden />
                )}
                <span className="hidden sm:inline">
                    {isUnpublishing
                        ? t("workspace.deploy.unpublishing")
                        : isPublishing
                          ? t("workspace.deploy.deploying")
                          : t("workspace.deploy.publish")}
                </span>
            </Button>

            <Modal
                open={open}
                onOpenChange={setOpen}
                size="md"
                title={
                    isUnpublishing
                        ? t("workspace.deploy.titleUnpublishing")
                        : isPublished
                          ? t("workspace.deploy.titleLive")
                          : t("workspace.deploy.titleFirst")
                }
                description={
                    isUnpublishing
                        ? t("workspace.deploy.subtitleUnpublishing")
                        : isPublished
                          ? t("workspace.deploy.subtitleLive")
                          : t("workspace.deploy.subtitleFirst")
                }
                headerAside={
                    isUnpublishing ? (
                        <StatusPill tone="warning" dot pulse>
                            {t("workspace.deploy.unpublishing")}
                        </StatusPill>
                    ) : isPublished ? (
                        <StatusPill tone="success" dot>
                            {t("workspace.deploy.live")}
                        </StatusPill>
                    ) : isPublishing ? (
                        <StatusPill tone="info" dot pulse>
                            {t("workspace.deploy.publishing")}
                        </StatusPill>
                    ) : isFailed ? (
                        <StatusPill tone="danger" dot>
                            {t("workspace.deploy.failedShort")}
                        </StatusPill>
                    ) : isUnpublished ? (
                        <StatusPill tone="neutral" dot>
                            {t("workspace.deploy.unpublishedPill")}
                        </StatusPill>
                    ) : null
                }
                footer={
                    <>
                        <Button variant="outline" onClick={() => setOpen(false)}>
                            {t("common.close")}
                        </Button>
                        {canUnpublish ? (
                            <Button
                                variant="outline"
                                className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30"
                                disabled={isPublishing || isUnpublishing}
                                onClick={() => {
                                    setUnpublishError(null);
                                    setConfirmUnpublish(true);
                                }}
                            >
                                <GlobeIcon className="size-4" aria-hidden />
                                {t("workspace.deploy.unpublishAction")}
                            </Button>
                        ) : null}
                        <Button
                            className="gap-2"
                            disabled={isPublishing || isUnpublishing || isRunning || !!blockedReason}
                            onClick={() => {
                                setOpen(false);
                                onDeploy();
                            }}
                        >
                            {isPublishing ? (
                                <LoaderIcon className="size-4 animate-spin" aria-hidden />
                            ) : (
                                <RocketIcon className="size-4" aria-hidden />
                            )}
                            {isPublished
                                ? t("workspace.deploy.deployAgain")
                                : t("workspace.deploy.deployNow")}
                        </Button>
                    </>
                }
            >
                <div className="space-y-5">
                    {/*
                      ⭐ WHY THE BUTTON BELOW IS DEAD, SAID BEFORE IT IS PRESSED.
                      ⚠️ AT THE TOP, NOT NEXT TO THE FOOTER. The footer is sticky and
                      the body scrolls, so a note down there is the one thing in this
                      dialog that can be off screen at the moment it matters.
                    */}
                    {blockedReason ? (
                        <p
                            role="status"
                            className="border-warning/40 bg-warning-subtle text-warning-subtle-foreground flex items-start gap-2 rounded-xl border p-3 text-xs leading-relaxed"
                        >
                            <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                            {blockedReason}
                        </p>
                    ) : null}

                    {/* ── The address ───────────────────────────────────────── */}
                    <section
                        className={cn(
                            "rounded-xl border p-4",
                            isUnpublishing
                                ? "border-warning/40 bg-warning-subtle/40"
                                : isPublished
                                  ? "border-success/30 bg-success-subtle/50"
                                  : canUnpublish
                                    ? "border-warning/30 bg-warning-subtle/30"
                                    : "bg-surface-sunken"
                        )}
                    >
                        <p className="text-muted-foreground text-2xs font-medium tracking-wider uppercase">
                            {isUnpublishing
                                ? t("workspace.deploy.takingDown")
                                : isPublished
                                  ? t("workspace.deploy.liveNow")
                                  : canUnpublish
                                    ? t("workspace.deploy.publicAddress")
                                    : t("workspace.deploy.willBeLiveAt")}
                        </p>

                        {/*
                          ⚠️ THE HOST WRAPS RATHER THAN TRUNCATING. A custom domain
                          on a narrow panel used to be clipped mid-word, which is
                          the one thing an address must never be — it is there to
                          be read and checked.
                        */}
                        <div className="mt-2 flex items-start gap-2">
                            <p data-selectable="true" className="min-w-0 flex-1 font-mono text-sm break-all">
                                {publishedHost}
                            </p>
                            <div className="flex shrink-0 items-center gap-1">
                                {!isUnpublished && !isUnpublishing ? (
                                    <CopyButton value={liveUrl} size="icon" />
                                ) : null}
                                {isPublished ? (
                                    <Button variant="ghost" size="icon" className="size-8" asChild>
                                        <a
                                            href={liveUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            aria-label={t("workspace.deploy.openLive")}
                                            title={t("workspace.deploy.openLive")}
                                        >
                                            <ExternalLinkIcon className="size-4" aria-hidden />
                                        </a>
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    </section>

                    {/* ── What actually happens ─────────────────────────────── */}
                    <section>
                        <h3 className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                            {isPublished
                                ? t("workspace.deploy.whatHappensAgain")
                                : t("workspace.deploy.whatHappens")}
                        </h3>
                        <ul className="mt-2.5 space-y-2.5">
                            <Fact icon={<CheckIcon aria-hidden className="size-4" />}>
                                {isPublished
                                    ? t("workspace.deploy.factReplace")
                                    : t("workspace.deploy.factPublic")}
                            </Fact>
                            <Fact icon={<ClockIcon aria-hidden className="size-4" />}>
                                {t("workspace.deploy.durationNotice")}
                            </Fact>
                            <Fact icon={<CoinsIcon aria-hidden className="size-4" />}>
                                {t("workspace.deploy.costNotice", { price: price("CREATE_DEPLOYMENT", engineOf(project)) })}
                            </Fact>
                        </ul>
                    </section>

                    {/* ── Custom domain ─────────────────────────────────────── */}
                    <section>
                        <h3 className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                            {t("workspace.deploy.domainSection")}
                        </h3>

                        <button
                            type="button"
                            data-phase="10-paid-domain"
                            onClick={() => {
                                setOpen(false);
                                onOpenDomain();
                            }}
                            className={cn(
                                "group hover:border-[var(--clay-line-strong)] hover:bg-accent/40 focus-visible:ring-ring mt-2.5 flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
                            )}
                        >
                            <span
                                aria-hidden
                                className="bg-primary-subtle text-primary grid size-9 shrink-0 place-items-center rounded-lg"
                            >
                                <GlobeIcon className="size-4" />
                            </span>

                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium">
                                    {domain?.hostname
                                        ? t("workspace.deploy.customDomainManage")
                                        : t("workspace.deploy.customDomain")}
                                </span>
                                <span className="text-muted-foreground block truncate text-xs">
                                    {domain?.hostname || t("workspace.deploy.customDomainHint")}
                                </span>
                            </span>

                            {domainProgress ? (
                                <StatusPill
                                    tone={domainProgress.tone}
                                    dot
                                    pulse={domainProgress.isSettling}
                                    className="shrink-0"
                                >
                                    {t(domainProgress.labelKey)}
                                </StatusPill>
                            ) : (
                                <ArrowRightIcon
                                    aria-hidden
                                    className="text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none"
                                />
                            )}
                        </button>

                        {/*
                          ⭐ HOW FAR ALONG, NOT JUST "NOT YET". The bar and the step
                          line replace a bare warning that read identically at minute
                          two and hour four. The notice below it stays, because the
                          bar answers "where are we" and the notice answers "why is
                          this taking so long" — and only the second one stops people
                          concluding it is broken.
                        */}
                        {domain && domainProgress && !domainProgress.isLive ? (
                            <div className="mt-3 space-y-2.5">
                                <DomainProgressCompact domain={domain} />

                                <p className="text-warning-subtle-foreground flex items-start gap-2 text-xs leading-relaxed">
                                    <TriangleAlertIcon
                                        aria-hidden
                                        className="mt-0.5 size-3.5 shrink-0"
                                    />
                                    {domainProgress.isFailed
                                        ? t(domainProgress.helpKey)
                                        : t("workspace.deploy.dnsNotice")}
                                </p>

                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 w-full text-xs"
                                    onClick={() => {
                                        setOpen(false);
                                        onOpenDomain();
                                    }}
                                >
                                    {t("workspace.deploy.domainOpenSetup")}
                                </Button>
                            </div>
                        ) : null}
                    </section>
                </div>
            </Modal>

            {/*
              ⚠️ THE CONFIRMATION IS A SECOND, SMALLER DIALOG on purpose: the publish
              dialog stays open behind it, and a failed unpublish keeps the confirm
              open with the backend's reason instead of closing as if it worked.
            */}
            <ConfirmDialog
                open={confirmUnpublish}
                onOpenChange={setConfirmUnpublish}
                tone="danger"
                title={t("workspace.deploy.unpublishTitle")}
                description={t("workspace.deploy.unpublishDescription")}
                confirmLabel={t("workspace.deploy.unpublishAction")}
                onConfirm={handleUnpublish}
            >
                <div className="border-[var(--clay-line)] bg-card bg-surface-sunken rounded-xl border p-3 shadow-[var(--clay-elev-1)]">
                    <p className="text-muted-foreground text-2xs font-medium tracking-wider uppercase">
                        {t("workspace.deploy.publicAddress")}
                    </p>
                    <p className="mt-1 font-mono text-sm break-all">{publishedHost}</p>
                </div>
                {unpublishError ? (
                    <p
                        role="alert"
                        className="border-destructive/30 bg-destructive/10 text-destructive mt-3 rounded-xl border p-3 text-xs leading-relaxed"
                    >
                        {unpublishError}
                    </p>
                ) : null}
            </ConfirmDialog>
        </>
    );
}

/** One line of "here is what this does", with a muted glyph in its own column. */
function Fact({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <li className="flex items-start gap-2.5">
            <span
                aria-hidden
                className="bg-[var(--clay-sunken)] text-muted-foreground mt-px grid size-6 shrink-0 place-items-center rounded-md shadow-[var(--clay-well-1)]"
            >
                {icon}
            </span>
            <span className="text-muted-foreground min-w-0 flex-1 text-sm leading-relaxed">
                {children}
            </span>
        </li>
    );
}
