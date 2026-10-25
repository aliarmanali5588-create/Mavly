"use client";

import * as React from "react";
import { CheckCircle2Icon, GlobeIcon, InfoIcon } from "lucide-react";
import { Modal, StatusPill } from "@/components/primitives";
import { useT } from "@/i18n";
import type { VcaasProject } from "@/lib/vcaas-types";

/**
 * The domain feature this build actually has: the `<project-id>.mavly.xyz` address
 * created by an opt-in Vercel publish. Custom-domain purchase/attachment and DNS
 * management have no local provider or billing path, so they are described truthfully
 * rather than driven through unsupported v2 endpoints.
 */
export function ProjectDomainPanel({
    project,
    open = true,
    onOpenChange = () => {},
}: {
    project: VcaasProject;
    onChanged?: () => void;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}) {
    const t = useT();
    const liveHost = project.productionProjectUrl?.trim() ?? "";
    const deployment = project.deployment;

    return (
        <Modal open={open} onOpenChange={onOpenChange} size="lg" title={t("engineV2.address.title")} description={t("engineV2.address.intro")}>
            <div className="space-y-5">
                <section className="border-border space-y-2 rounded-xl border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <GlobeIcon className="text-muted-foreground size-4" aria-hidden />
                        <span className="text-sm font-medium">{t("engineV2.domains.liveAddress")}</span>
                        {deployment ? (
                            <StatusPill tone={deployment.status === "success" ? "success" : deployment.status === "error" ? "danger" : "warning"}>
                                {deployment.status}
                            </StatusPill>
                        ) : null}
                    </div>
                    {liveHost ? (
                        <p className="flex items-center gap-1.5 font-mono text-sm" data-testid="mavly-address">
                            <CheckCircle2Icon className="text-success size-4" aria-hidden />
                            {liveHost}
                        </p>
                    ) : (
                        <p className="text-muted-foreground text-sm">{t("engineV2.address.notPublished")}</p>
                    )}
                    {project.lastDeployError ? (
                        <p className="text-destructive text-xs">
                            {project.lastDeployError.title}: {project.lastDeployError.message}
                        </p>
                    ) : null}
                </section>

                <section className="border-border space-y-2 border-t pt-4">
                    <h3 className="text-sm font-medium">{t("engineV2.address.customTitle")}</h3>
                    <div className="flex gap-2 text-xs">
                        <InfoIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                        <p className="text-muted-foreground leading-relaxed">{t("engineV2.address.customUnavailable")}</p>
                    </div>
                </section>
            </div>
        </Modal>
    );
}
