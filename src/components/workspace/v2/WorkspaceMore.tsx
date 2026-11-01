"use client";

import * as React from "react";
import { LayoutGridIcon } from "lucide-react";
import { EmptyState, Modal } from "@/components/primitives";
import { useT } from "@/i18n";
import { isV2Project } from "@/lib/project-status";
import type { VcaasProject } from "@/lib/vcaas-types";
import { SecretsModal } from "../SecretsModal";
import { MoreView, type MoreSection } from "./MoreView";
import { PaymentsModal } from "./PaymentsModal";
import { ProjectActivityModal } from "./ProjectActivityModal";
import { UsageLimitsModal } from "./UsageLimitsModal";
import { V2ProjectSettings } from "./V2ProjectSettings";
import { ProjectPaymentsIntegration } from "./ProjectPaymentsIntegration";
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
import { ProjectWorkflowPanel } from "./ProjectWorkflowPanel";
import { BackendCenter } from "./BackendCenter";

const noop = () => {};

/**
 * The workspace's "More" tab: every project control of a new-engine project, as the platform's More view shows them
 * — an aside of sections, the chosen one in the main area. Sections use the local Mavly backend where one exists;
 * none of them calls a removed platform endpoint.
 *
 * New-engine projects only. A legacy project gets a notice because its settings and endpoints are a different set.
 */
export function WorkspaceMore({
    project,
    onProjectChanged,
    completionSoundsEnabled,
    completionSoundError,
    onEnableCompletionSounds,
    onDisableCompletionSounds,
    onOpenGithub,
    githubConnected,
}: {
    project: VcaasProject;
    onProjectChanged: () => void;
    completionSoundsEnabled: boolean;
    completionSoundError: string | null;
    onEnableCompletionSounds: () => void | Promise<void>;
    onDisableCompletionSounds: () => void;
    /** Opens the workspace's existing GitHub dialog; this view never reimplements it. */
    onOpenGithub: () => void;
    githubConnected: boolean;
}) {
    const t = useT();
    const [section, setSection] = React.useState<MoreSection>("analytics");
    const projectId = project.projectId;

    if (!isV2Project(project)) {
        return <EmptyState variant="panel" icon={<LayoutGridIcon />} title={t("more.legacyTitle")} description={t("more.legacyBody")} />;
    }

    return (
        <MoreView section={section} onSection={setSection}>
            {section === "analytics" ? (
                <ProjectActivityModal open onOpenChange={noop} projectId={projectId} />
            ) : section === "database" ? (
                /**
                 * The Backend & Source Control Center. GitHub is opened through the
                 * workspace's own dialog rather than duplicated here, so there is one
                 * GitHub surface and one place its state lives.
                 */
                <BackendCenter
                    project={project}
                    onOpenGithub={onOpenGithub}
                    githubConnected={githubConnected}
                />
            ) : section === "usage" ? (
                <UsageLimitsModal open onOpenChange={noop} projectId={projectId} />
            ) : section === "secrets" ? (
                <SecretsModal open onOpenChange={noop} projectId={projectId} secrets={project.secrets ?? []} onChanged={onProjectChanged} />
            ) : section === "memory" ? (
                <ProjectMemoryPanel open onOpenChange={noop} projectId={projectId} />
            ) : section === "workflow" ? (
                <ProjectWorkflowPanel
                    open
                    onOpenChange={noop}
                    projectId={projectId}
                    completionSoundsEnabled={completionSoundsEnabled}
                    completionSoundError={completionSoundError}
                    onEnableCompletionSounds={onEnableCompletionSounds}
                    onDisableCompletionSounds={onDisableCompletionSounds}
                />
            ) : section === "integrations" ? (
                <ProjectPaymentsIntegration open onOpenChange={noop} projectId={projectId} />
            ) : section === "payments" ? (
                <PaymentsModal open onOpenChange={noop} projectId={projectId} />
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
