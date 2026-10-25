"use client";

import * as React from "react";
import { DownloadIcon, ImageIcon, InfoIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import {
    IMAGE_ASPECT_RATIOS,
    IMAGE_OUTPUT_FORMATS,
    IMAGE_PROMPT_MAX_LENGTH,
    imageExtensionFor,
    isImageAspectRatio,
    isImageOutputFormat,
    type ImageAspectRatio,
    type ImageOutputFormat,
} from "@/lib/image-generation-options";
import { vcaasApi } from "@/lib/vcaas";
import type { ImageGenerationResult } from "@/lib/vcaas-types";

/**
 * ═══ IMAGE GENERATION — ONE IMAGE, NOTHING SAVED ════════════════════════════
 *
 * The request goes through the project's authenticated `/api/vcaas` path; the
 * browser never sees `OPENROUTER_API_KEY` and never calls OpenRouter itself.
 * Only confirmed model options are offered — see `image-generation-options.ts`.
 *
 * ⚠️ THE IMAGE LIVES ONLY IN THIS COMPONENT'S STATE. There is no image-asset
 * storage in this build, so switching sections loses it; the panel says so and
 * offers a download. Do not describe it as saved to the project.
 *
 * ⚠️ A SECOND SUBMIT IS BLOCKED BY A REF, NOT ONLY BY `generating`. Two clicks
 * in the same frame both read the pre-update state, and each request costs a
 * real provider call. The ref closes that window; the disabled button is the
 * visible affordance.
 */
export function ImageGenerationPanel({ projectId }: { projectId: string }) {
    const t = useT();
    const [prompt, setPrompt] = React.useState("");
    const [aspectRatio, setAspectRatio] = React.useState<ImageAspectRatio>("1:1");
    const [outputFormat, setOutputFormat] = React.useState<ImageOutputFormat>("png");
    const [generating, setGenerating] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [result, setResult] = React.useState<ImageGenerationResult | null>(null);
    const inFlight = React.useRef(false);

    const trimmed = prompt.trim();
    const canSubmit = trimmed.length > 0 && !generating;

    const generate = async () => {
        if (inFlight.current) return;
        if (!trimmed) {
            setError(t("more.imageGeneration.emptyPrompt"));
            return;
        }

        inFlight.current = true;
        setGenerating(true);
        setError(null);

        try {
            const response = await vcaasApi.images.generate(projectId, {
                prompt: trimmed,
                aspectRatio,
                outputFormat,
            });
            if (!response.ok) {
                setError(response.error || t("more.imageGeneration.failed"));
                return;
            }
            if (!response.data) {
                setError(t("more.imageGeneration.failed"));
                return;
            }
            setResult(response.data);
        } catch (err) {
            setError(err instanceof Error ? err.message : t("more.imageGeneration.failed"));
        } finally {
            inFlight.current = false;
            setGenerating(false);
        }
    };

    const source = result ? `data:${result.mediaType};base64,${result.imageBase64}` : null;

    return (
        <div className="space-y-5">
            <section className="border-border bg-card/60 space-y-3 rounded-2xl border p-4 shadow-sm">
                <div className="space-y-1">
                    <label htmlFor="image-prompt" className="text-sm font-medium">
                        {t("more.imageGeneration.promptLabel")}
                    </label>
                    <p className="text-muted-foreground text-xs">{t("more.imageGeneration.promptHint")}</p>
                </div>
                <Textarea
                    id="image-prompt"
                    value={prompt}
                    rows={4}
                    maxLength={IMAGE_PROMPT_MAX_LENGTH}
                    disabled={generating}
                    placeholder={t("more.imageGeneration.promptPlaceholder")}
                    onChange={(event) => setPrompt(event.target.value)}
                />

                <div className="flex flex-col gap-3 sm:flex-row">
                    <div className="flex-1 space-y-1.5">
                        <span id="image-aspect-label" className="text-muted-foreground text-xs font-medium">
                            {t("more.imageGeneration.aspectRatio")}
                        </span>
                        <Select
                            value={aspectRatio}
                            disabled={generating}
                            onValueChange={(value) => {
                                if (isImageAspectRatio(value)) setAspectRatio(value);
                            }}
                        >
                            <SelectTrigger className="w-full" aria-labelledby="image-aspect-label">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {IMAGE_ASPECT_RATIOS.map((ratio) => (
                                    <SelectItem key={ratio} value={ratio}>
                                        {ratio}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex-1 space-y-1.5">
                        <span id="image-format-label" className="text-muted-foreground text-xs font-medium">
                            {t("more.imageGeneration.format")}
                        </span>
                        <Select
                            value={outputFormat}
                            disabled={generating}
                            onValueChange={(value) => {
                                if (isImageOutputFormat(value)) setOutputFormat(value);
                            }}
                        >
                            <SelectTrigger className="w-full" aria-labelledby="image-format-label">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {IMAGE_OUTPUT_FORMATS.map((format) => (
                                    <SelectItem key={format} value={format}>
                                        {format.toUpperCase()}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                    <p className="text-muted-foreground text-xs">
                        {t("more.imageGeneration.model", { model: "FLUX.2 Klein 4B" })}
                    </p>
                    <Button size="sm" onClick={() => void generate()} disabled={!canSubmit}>
                        {generating ? (
                            <>
                                <Loader2Icon className="size-4 animate-spin" aria-hidden />
                                {t("more.imageGeneration.generating")}
                            </>
                        ) : (
                            <>
                                <SparklesIcon className="size-4" aria-hidden />
                                {t("more.imageGeneration.generate")}
                            </>
                        )}
                    </Button>
                </div>

                {error ? (
                    <p role="alert" className="text-destructive text-sm">
                        {error}
                    </p>
                ) : null}
            </section>

            <section className="space-y-3" aria-live="polite">
                {source && result ? (
                    <div className="border-border bg-card/60 overflow-hidden rounded-2xl border shadow-sm">
                        {/* A data: URL is not an optimisable remote asset, so next/image would
                            need `unoptimized`; a plain img is the honest primitive here. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={source}
                            alt={t("more.imageGeneration.resultAlt")}
                            className="bg-muted/40 mx-auto block max-h-[28rem] w-auto max-w-full"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
                            <div className="text-muted-foreground text-xs">
                                <p>{t("more.imageGeneration.resultMeta", {
                                    format: result.format.toUpperCase(),
                                    size: formatBytes(result.bytes),
                                })}</p>
                                <p className="font-mono">{result.model}</p>
                            </div>
                            <Button asChild size="sm" variant="outline">
                                <a
                                    href={source}
                                    download={`mavly-image.${imageExtensionFor(result.format)}`}
                                >
                                    <DownloadIcon className="size-4" aria-hidden />
                                    {t("more.imageGeneration.download")}
                                </a>
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="border-border text-muted-foreground flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-10 text-center">
                        <ImageIcon className="size-6" aria-hidden />
                        <p className="text-sm">{t("more.imageGeneration.emptyState")}</p>
                    </div>
                )}

                <div className="border-border flex gap-2 border-t pt-4 text-xs">
                    <InfoIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                    <p className="text-muted-foreground leading-relaxed">
                        {t("more.imageGeneration.notSaved")}
                    </p>
                </div>
            </section>
        </div>
    );
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
