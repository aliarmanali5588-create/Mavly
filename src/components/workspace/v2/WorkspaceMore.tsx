"use client";

import * as React from "react";
import { LayoutGridIcon } from "lucide-react";
import { EmptyState, Modal } from "@/components/primitives";
import { useT } from "@/i18n";
import { getPreviewUrl, isPublished, isV2Project } from "@/lib/project-status";
import type { VcaasProject } from "@/lib/vcaas-types";
import { SupabaseDatabasePanel } from "../database-v2/SupabaseDatabasePanel";
import { SecretsModal } from "../SecretsModal";
import { MoreView, type MoreSection } from "./MoreView";
import { PaymentsModal } from "./PaymentsModal";
import { ProjectActivityModal } from "./ProjectActivityModal";
import { ProjectDomainPanel } from "./ProjectDomainPanel";
import { UsageLimitsModal } from "./UsageLimitsModal";
import { V2ProjectSettings } from "./V2ProjectSettings";
import { ProjectApiKeysModal } from "./ProjectApiKeysModal";
import { ImageGenerationPanel } from "./ImageGenerationPanel";
import { ProjectPaymentsIntegration } from "./ProjectPaymentsIntegration";

const noop = () => {};

/**
 * The workspace's "More" tab: every project control of a new-engine project, as the platform's More view shows them
 * — an aside of sections, the chosen one in the main area. Sections use the local Mavly backend where one exists;
 * the rest state that they are unavailable instead of calling removed platform endpoints.
 *
 * New-engine projects only. A legacy project gets a notice because its settings and endpoints are a different set.
 */
export function WorkspaceMore({
    project,
    onProjectChanged,
    onPublish,
}: {
    project: VcaasProject;
    onProjectChanged: () => void;
    /** Payments asks for a publish once it is set up; the page owns the publish (and its banner). */
    onPublish: () => void;
}) {
    const t = useT();
    const [section, setSection] = React.useState<MoreSection>("database");
    const projectId = project.projectId;
    const published = isPublished(project);

    if (!isV2Project(project)) {
        return <EmptyState variant="panel" icon={<LayoutGridIcon />} title={t("more.legacyTitle")} description={t("more.legacyBody")} />;
    }

    return (
        <MoreView section={section} onSection={setSection}>
            {section === "database" ? (
                <SupabaseDatabasePanel />
            ) : section === "images" ? (
                <Modal open onOpenChange={noop} size="lg" title={t("more.imageGeneration.title")} description={t("more.imageGeneration.description")}>
                    <ImageGenerationPanel projectId={projectId} />
                </Modal>
            ) : section === "analytics" ? (
                <ProjectActivityModal open onOpenChange={noop} projectId={projectId} />
            ) : section === "usage" ? (
                <UsageLimitsModal open onOpenChange={noop} projectId={projectId} />
            ) : section === "apiKeys" ? (
                <ProjectApiKeysModal
                    open
                    onOpenChange={noop}
                    projectId={projectId}
                    previewUrl={getPreviewUrl(project)}
                    onPreviewRotated={onProjectChanged}
                />
            ) : section === "cron" ? (
                <Modal open onOpenChange={noop} size="lg" title={t("engineV2.cron.title")} description={t("engineV2.unavailable.lead")}>
                    <UnavailableSection body={t("engineV2.unavailable.cron")} />
                </Modal>
            ) : section === "secrets" ? (
                <SecretsModal open onOpenChange={noop} projectId={projectId} secrets={project.secrets ?? []} onChanged={onProjectChanged} />
            ) : section === "integrations" ? (
                <ProjectPaymentsIntegration open onOpenChange={noop} projectId={projectId} />
            ) : section === "mobile" ? (
                <Modal open onOpenChange={noop} size="lg" title={t("engineV2.mobile.title")} description={t("engineV2.unavailable.lead")}>
                    <UnavailableSection body={t("engineV2.unavailable.mobile")} />
                </Modal>
            ) : section === "payments" ? (
                <PaymentsModal open onOpenChange={noop} projectId={projectId} published={published} onPublish={onPublish} />
            ) : section === "domain" ? (
                <ProjectDomainPanel project={project} onChanged={onProjectChanged} />
            ) : section === "logs" ? (
                <Modal open onOpenChange={noop} size="xl" title={t("workspace.logs.title")} description={t("workspace.logs.modalDescription")}>
                    <UnavailableSection body={t("engineV2.unavailable.logs")} />
                </Modal>
            ) : (
                <Modal open onOpenChange={noop} size="lg" title={t("workspace.projectSettings.title")} description={t("more.settingsDescription")}>
                    <div className="space-y-5">
                        <V2ProjectSettings project={project} onChanged={onProjectChanged} />
                    </div>
                </Modal>
            )}
        </MoreView>
    );
}

function UnavailableSection({ body }: { body: string }) {
    return (
        <div className="space-y-2 rounded-xl border border-border p-4">
            <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
        </div>
    );
}
