"use client";

import * as React from "react";
import { GlobeIcon, InfoIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { getPublishedHost } from "@/lib/project-status";
import { toast } from "@/lib/toast";
import { vcaasApi } from "@/lib/vcaas";
import type { VcaasProject } from "@/lib/vcaas-types";

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2_000;

/**
 * The real project settings this build supports: the owner-editable name and description
 * (PATCH /projects/{id}) and the published Mavly address. The platform's agent prompt, MCP
 * and pause controls have no local backend, so they are stated as unavailable instead of
 * sending requests that can only fail.
 */
export function V2ProjectSettings({ project, onChanged }: { project: VcaasProject; onChanged: () => void }) {
    const t = useT();
    const [label, setLabel] = React.useState(project.label ?? "");
    const [description, setDescription] = React.useState(project.description ?? "");
    const [saving, setSaving] = React.useState(false);

    const save = async () => {
        setSaving(true);
        const response = await vcaasApi.projects.update(project.projectId, {
            label: label.trim() || null,
            description: description.trim(),
        });
        setSaving(false);
        if (!response.ok) return void toast.error(response.error || t("engineV2.common.failed"));
        if (response.data) {
            setLabel(response.data.label ?? "");
            setDescription(response.data.description);
        }
        toast.success(t("common.saved"));
        onChanged();
    };

    return (
        <div className="space-y-5">
            <section className="space-y-3">
                <SectionTitle icon={SettingsIcon} title={t("engineV2.projectSettings.name")} description={t("engineV2.projectSettings.nameHint")} />
                <Input
                    value={label}
                    maxLength={NAME_MAX}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder={project.projectId}
                    aria-label={t("engineV2.projectSettings.name")}
                />
            </section>

            <section className="space-y-3">
                <SectionTitle icon={SettingsIcon} title={t("engineV2.projectSettings.description")} description={t("engineV2.projectSettings.descriptionHint")} />
                <Textarea
                    value={description}
                    maxLength={DESCRIPTION_MAX}
                    rows={4}
                    onChange={(event) => setDescription(event.target.value)}
                    aria-label={t("engineV2.projectSettings.description")}
                />
            </section>

            <div className="flex justify-end">
                <Button size="sm" onClick={() => void save()} disabled={saving}>
                    {saving ? t("common.saving") : t("engineV2.projectSettings.save")}
                </Button>
            </div>

            <section className="border-[var(--clay-line)] space-y-2 border-t pt-5">
                <SectionTitle icon={GlobeIcon} title={t("engineV2.domains.liveAddress")} description={t("engineV2.domains.liveAddressHint")} />
                <p className="font-mono text-xs">{getPublishedHost(project, project.projectId)}</p>
            </section>

            <section className="border-[var(--clay-line)] flex gap-2 border-t pt-4 text-xs">
                <InfoIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                <p className="text-muted-foreground leading-relaxed">{t("engineV2.projectSettings.unavailable")}</p>
            </section>
        </div>
    );
}

function SectionTitle({ icon: Icon, title, description }: { icon: typeof SettingsIcon; title: string; description?: string }) {
    return (
        <div>
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <Icon className="text-muted-foreground size-4" aria-hidden />
                {title}
            </h3>
            {description ? <p className="text-muted-foreground mt-0.5 text-xs">{description}</p> : null}
        </div>
    );
}
