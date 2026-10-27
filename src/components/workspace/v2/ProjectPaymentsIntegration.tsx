"use client";

import * as React from "react";
import {
    CreditCardIcon,
    FlaskConicalIcon,
    LoaderIcon,
    RefreshCwIcon,
    ShieldCheckIcon,
} from "lucide-react";
import {
    ConfirmDialog,
    CopyButton,
    EmptyState,
    Modal,
    StatusPill,
    type StatusTone,
} from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/lib/toast";
import { vcaasApi } from "@/lib/vcaas";
import type { PaymentsIntegrationStatus } from "@/lib/vcaas-types";
import { Callout, Card, Disclosure } from "./page-bits";

/**
 * Business integrations → Payments (Razorpay).
 *
 * ⚠️ EVERY STATE HERE COMES FROM THE SERVER. There is no optimistic "connected"
 * badge: the key pair is tested by Razorpay before it is stored, the status is
 * re-read after every action, and a refusal (flag/cohort/migration) is shown as
 * the server's own message. Secret values are never rendered after saving — the
 * API has no read-back path at all.
 */

const TONE: Record<PaymentsIntegrationStatus["status"], StatusTone> = {
    verified: "success",
    configured: "info",
    error: "danger",
    disabled: "neutral",
    not_configured: "neutral",
};

const PAYMENT_TONE: Record<string, StatusTone> = {
    paid: "success",
    authorized: "info",
    pending: "info",
    created: "neutral",
    creating: "neutral",
    failed: "danger",
    cancelled: "warning",
    expired: "warning",
    unknown: "warning",
};

function amountLabel(minor: number, currency: string): string {
    return `${(minor / 100).toFixed(2)} ${currency}`;
}

export function ProjectPaymentsIntegration({
    open,
    onOpenChange,
    projectId,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectId: string;
}) {
    const [status, setStatus] = React.useState<PaymentsIntegrationStatus | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [confirmDisable, setConfirmDisable] = React.useState(false);
    const [confirmLiveSave, setConfirmLiveSave] = React.useState(false);
    const [keyId, setKeyId] = React.useState("");
    const [keySecret, setKeySecret] = React.useState("");
    const [webhookSecret, setWebhookSecret] = React.useState("");

    const load = React.useCallback(async () => {
        const response = await vcaasApi.paymentsIntegration.status(projectId);
        if (response.ok) {
            setStatus(response.data);
            setKeyId(current => current || response.data.keyId || "");
            setLoadError(null);
        } else {
            setStatus(null);
            setLoadError(response.error || "The payments integration could not be read.");
        }
        setLoading(false);
    }, [projectId]);

    React.useEffect(() => {
        if (!open) return;
        setLoading(true);
        void load();
    }, [open, load]);

    function clearForm() {
        setKeyId("");
        setKeySecret("");
        setWebhookSecret("");
    }

    async function doSave() {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.paymentsIntegration.save(projectId, {
            provider: "razorpay",
            keyId: keyId.trim(),
            keySecret,
            webhookSecret,
            enabled: true,
        });
        setBusy(false);
        if (response.ok) {
            setStatus(response.data);
            clearForm();
            toast.success("Razorpay connected. The key pair was accepted and stored encrypted.");
        } else {
            toast.error("Could not connect Razorpay", { description: response.error || undefined });
        }
    }

    function save(event: React.FormEvent) {
        event.preventDefault();
        if (busy) return;
        // ⚠️ Live keys are never enabled by a single click. Test keys move no
        // money, so they may be enabled directly; live keys need an explicit
        // confirmation that names the consequence.
        if (keyId.trim().startsWith("rzp_live_")) {
            setConfirmLiveSave(true);
            return;
        }
        void doSave();
    }

    async function testConnection() {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.paymentsIntegration.test(projectId);
        setBusy(false);
        if (response.ok) {
            if (response.data.verified) {
                toast.success("Razorpay accepted the stored credentials.");
            } else {
                toast.error("Razorpay did not accept the stored credentials", {
                    description: response.data.lastError || undefined,
                });
            }
            void load();
        } else {
            toast.error("Could not test Razorpay", { description: response.error || undefined });
        }
    }

    async function disable() {
        if (busy) return;
        setBusy(true);
        const response = await vcaasApi.paymentsIntegration.disable(projectId);
        setBusy(false);
        if (response.ok) {
            setStatus(response.data);
            setKeyId(current => current || response.data.keyId || "");
            toast.success("Payments stopped. New orders are refused; in-flight webhooks are still recorded.");
        } else {
            toast.error("Could not stop payments", { description: response.error || undefined });
        }
    }

    const configured = Boolean(status?.configured);
    const showForm = !configured || !status?.enabled;

    return (
        <>
            <Modal
                open={open}
                onOpenChange={onOpenChange}
                size="lg"
                title="Payments (Razorpay)"
                description="Let your published app create and confirm real Razorpay orders. This is separate from Mavly's own billing."
            >
                {loading ? (
                    <Skeleton className="h-40 w-full rounded-xl" />
                ) : loadError ? (
                    <Callout tone="warning" title="Payments are not available">
                        {loadError}
                    </Callout>
                ) : status ? (
                    <div className="space-y-4 text-sm">
                        <Card
                            title="Integration status"
                            aside={
                                <div className="flex items-center gap-2">
                                    <StatusPill tone={TONE[status.status]}>{status.status.replace("_", " ")}</StatusPill>
                                    <Button size="icon" variant="ghost" aria-label="Refresh status" onClick={() => void load()}>
                                        <RefreshCwIcon className="size-4" aria-hidden />
                                    </Button>
                                </div>
                            }
                        >
                            <dl className="grid gap-2 text-xs sm:grid-cols-2">
                                <div>
                                    <dt className="text-muted-foreground">Mode</dt>
                                    <dd className="font-medium">
                                        {status.mode === "test" ? "Test keys (no real money)" : status.mode === "live" ? "Live keys (real money)" : "Not configured"}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-muted-foreground">Key id</dt>
                                    <dd className="truncate font-mono">{status.keyId || "—"}</dd>
                                </div>
                                <div className="sm:col-span-2">
                                    <dt className="text-muted-foreground">Last provider check</dt>
                                    <dd>
                                        {status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString() : "Never"}
                                        <span className="text-muted-foreground">
                                            {" "}— re-test after changing any credential in Secrets.
                                        </span>
                                    </dd>
                                </div>
                                {status.lastError ? (
                                    <div className="sm:col-span-2">
                                        <dt className="text-muted-foreground">Last error</dt>
                                        <dd className="text-destructive">{status.lastError}</dd>
                                    </div>
                                ) : null}
                            </dl>

                            {status.enabled && !status.credentialsPresent ? (
                                <Callout tone="warning">
                                    One or more stored credential values are missing (they may have been renamed or deleted in
                                    Secrets). Re-save the three values before taking payments.
                                </Callout>
                            ) : null}

                            <div className="mt-3 flex flex-wrap gap-2">
                                <Button size="sm" variant="outline" disabled={busy} onClick={() => void testConnection()}>
                                    {busy ? <LoaderIcon className="size-4 animate-spin" aria-hidden /> : <ShieldCheckIcon className="size-4" aria-hidden />}
                                    Test connection
                                </Button>
                                {status.enabled ? (
                                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDisable(true)}>
                                        Stop payments
                                    </Button>
                                ) : null}
                            </div>
                        </Card>

                        {status.enabled ? (
                            <Card title="Razorpay webhook">
                                <p className="text-muted-foreground text-xs leading-relaxed">
                                    Add this address in the Razorpay dashboard for <code>payment.authorized</code>,{" "}
                                    <code>payment.captured</code>, <code>payment.failed</code> and <code>order.paid</code>, with
                                    the same webhook secret you saved here. The connection test verifies the key pair;
                                    the webhook secret is proven when Razorpay sends its first signed event.
                                </p>
                                {status.webhookUrl ? (
                                    <div className="mt-2 flex items-center gap-2">
                                        <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-xs">
                                            {status.webhookUrl}
                                        </code>
                                        <CopyButton value={status.webhookUrl} size="sm" />
                                    </div>
                                ) : (
                                    <p className="text-warning mt-2 text-xs">
                                        This Mavly deployment has no canonical app URL configured, so the webhook address cannot be shown.
                                    </p>
                                )}
                            </Card>
                        ) : null}

                        {showForm ? (
                            <Card title={configured ? "Re-enable payments" : "Connect Razorpay"}>
                                <form onSubmit={save} className="space-y-3">
                                    <p className="text-muted-foreground text-xs leading-relaxed">
                                        Use your own Razorpay keys. Test keys start with <code>rzp_test_</code> and never
                                        move real money. The key pair is checked with Razorpay before anything is stored.
                                    </p>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="space-y-1.5">
                                            <Label htmlFor="razorpay-key-id" className="text-xs">Key id</Label>
                                            <Input
                                                id="razorpay-key-id"
                                                value={keyId}
                                                onChange={event => setKeyId(event.target.value)}
                                                placeholder="rzp_test_…"
                                                autoComplete="off"
                                                spellCheck={false}
                                                className="h-8 font-mono text-xs"
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label htmlFor="razorpay-key-secret" className="text-xs">Key secret</Label>
                                            <Input
                                                id="razorpay-key-secret"
                                                type="password"
                                                value={keySecret}
                                                onChange={event => setKeySecret(event.target.value)}
                                                autoComplete="off"
                                                spellCheck={false}
                                                className="h-8 font-mono text-xs"
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label htmlFor="razorpay-webhook-secret" className="text-xs">Webhook secret</Label>
                                        <Input
                                            id="razorpay-webhook-secret"
                                            type="password"
                                            value={webhookSecret}
                                            onChange={event => setWebhookSecret(event.target.value)}
                                            autoComplete="off"
                                            spellCheck={false}
                                            className="h-8 font-mono text-xs"
                                        />
                                    </div>
                                    <Button type="submit" size="sm" disabled={busy || !keyId.trim() || !keySecret || !webhookSecret}>
                                        {busy ? <LoaderIcon className="size-4 animate-spin" aria-hidden /> : <CreditCardIcon className="size-4" aria-hidden />}
                                        Test and save
                                    </Button>
                                    <p className="text-muted-foreground text-xs">
                                        The three values are stored as encrypted project secrets ({status.credentialNames.join(", ")}).
                                        A full-stack published app can also receive them in its production environment. Mavly never
                                        shows them again.
                                    </p>
                                </form>
                            </Card>
                        ) : null}

                        <Card title="Recent orders">
                            {status.transactions.length === 0 ? (
                                <EmptyState
                                    variant="panel"
                                    icon={<FlaskConicalIcon />}
                                    title="No payment orders yet"
                                    description="Orders appear here after your published app calls the payments gateway."
                                />
                            ) : (
                                <ul className="divide-border divide-y">
                                    {status.transactions.map(transaction => (
                                        <li key={`${transaction.orderId ?? transaction.receipt}-${transaction.createdAt}`} className="flex flex-wrap items-center gap-2 py-2">
                                            <code className="min-w-0 flex-1 truncate font-mono text-xs">
                                                {transaction.orderId ?? transaction.receipt}
                                            </code>
                                            <span className="text-xs">{amountLabel(transaction.amountMinor, transaction.currency)}</span>
                                            <StatusPill tone={PAYMENT_TONE[transaction.status] ?? "neutral"}>
                                                {transaction.status}
                                            </StatusPill>
                                            <span className="text-muted-foreground text-xs">
                                                {new Date(transaction.createdAt).toLocaleString()}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>

                        <Disclosure title="How your app uses this" hint="Server-side calls only">
                            <div className="space-y-2 text-xs leading-relaxed">
                                <p>
                                    Your app needs server-side code (a full-stack published project). Create a project API
                                    key with the <code>integrations:*</code> scope and a live or both environment, keep it
                                    on the server, and call these endpoints from server code:
                                </p>
                                <ul className="list-disc space-y-1 pl-4 font-mono">
                                    <li>POST /api/app/v1/payments/orders</li>
                                    <li>POST /api/app/v1/payments/verify</li>
                                    <li>GET /api/app/v1/payments/{"{orderId}"}</li>
                                </ul>
                                <p className="text-muted-foreground">
                                    Use the canonical Mavly origin (not your app&apos;s own tenant host) and send{" "}
                                    <code>Authorization: Bearer &lt;project API key&gt;</code>. The browser receives only
                                    the publishable key id, the order id and the amount. A redirect never marks an order paid:
                                    the verify endpoint checks the signature and Razorpay&apos;s API.
                                </p>
                            </div>
                        </Disclosure>

                        <Callout>
                            This build supports one-time orders only. Refunds, subscriptions and payouts are not implemented, and
                            no Mavly fee is charged.
                        </Callout>
                    </div>
                ) : null}
            </Modal>

            <ConfirmDialog
                open={confirmLiveSave}
                onOpenChange={setConfirmLiveSave}
                tone="danger"
                title="Enable live payments?"
                description="These are live Razorpay keys. After this, your published app can charge real cards and move real money through this integration. Use test keys (rzp_test_…) until you are ready."
                confirmLabel="Enable live payments"
                onConfirm={doSave}
            />

            <ConfirmDialog
                open={confirmDisable}
                onOpenChange={setConfirmDisable}
                tone="danger"
                title="Stop accepting payments?"
                description="New orders through the Mavly gateway will be refused. The webhook address stays the same, so in-flight payments are still recorded. Your stored credentials stay encrypted until you delete them in Secrets."
                confirmLabel="Stop payments"
                onConfirm={disable}
            />
        </>
    );
}
