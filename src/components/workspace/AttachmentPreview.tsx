"use client";

import * as React from "react";
import {
    BoxIcon,
    BracesIcon,
    FileArchiveIcon,
    FileAudioIcon,
    FileCodeIcon,
    FileIcon,
    FileImageIcon,
    FileSpreadsheetIcon,
    FileTextIcon,
    FileVideoIcon,
    PaletteIcon,
    PresentationIcon,
    TypeIcon,
    XIcon,
} from "lucide-react";

import {
    attachmentKind,
    formatBytes,
    isPreviewableImage,
    truncateFileName,
    type AttachmentKind,
} from "@/lib/attachments";
import { cn } from "@/lib/utils";

/**
 * ═══ ATTACHMENT PREVIEWS — THE PICTURE, OR THE RIGHT PLATE ══════════════════
 *
 * One chip renderer for the three places an attachment appears: the dashboard's hero
 * composer (files the browser is still holding), the workspace chat composer (files
 * already uploaded to the project) and the chat history (what was sent with a past
 * prompt). All three used to render the same grey paperclip and a truncated name.
 *
 * ⚠️ A WALL OF IDENTICAL PAPERCLIPS IS UNREADABLE, which is the reason for the kind
 * plates: "did I attach the right zip?" is answerable at a glance next to a red PDF,
 * a green spreadsheet and a violet video, and unanswerable otherwise. The kind
 * detection, the colours and the truncation are totalum-platform's — see
 * `lib/attachments.ts`, copied verbatim, and `AttachmentTray.tsx`, whose `KIND_STYLE`
 * this mirrors.
 *
 * ⚠️ AN IMAGE SHOWS ITSELF. A local `File` is previewed through an object URL created
 * here and revoked when the chip unmounts (a leaked one holds the whole file in memory
 * for the life of the tab); an uploaded file is previewed from its own URL.
 *
 * ⚠️ ONLY A REAL IMAGE. `isPreviewableImage` demands an `image/*` MIME that is not
 * SVG: a file merely NAMED `.png` renders as the browser's broken-image glyph, and an
 * SVG is a document we did not write. Both fall back to the plate.
 *
 * ⚠️⚠️ THE PICTURE IS CONFIRMED WITH `decode()`, NOT WITH `onError`. In React 19 an
 * `<img>` event frequently never fires — the same trap the dashboard's project
 * thumbnails hit — so a chip that waited for `onError` to hide a dead image kept the
 * browser's broken-image glyph instead of showing the file's kind plate. That is worse
 * than no preview: the chip looks like the product is broken. `decode()` resolves on a
 * renderable image and rejects on anything else, which is precisely the question.
 * (totalum-platform uses `onError` because it only ever previews LOCAL blob URLs; the
 * chat composer here previews uploaded files over the network.)
 */

const KIND_STYLE: Record<AttachmentKind, { Icon: typeof FileIcon; plate: string; glyph: string }> = {
    image: { Icon: FileImageIcon, plate: "bg-violet-500/10", glyph: "text-violet-600 dark:text-violet-400" },
    video: { Icon: FileVideoIcon, plate: "bg-fuchsia-500/10", glyph: "text-fuchsia-600 dark:text-fuchsia-400" },
    audio: { Icon: FileAudioIcon, plate: "bg-pink-500/10", glyph: "text-pink-600 dark:text-pink-400" },
    pdf: { Icon: FileTextIcon, plate: "bg-red-500/10", glyph: "text-red-600 dark:text-red-400" },
    sheet: { Icon: FileSpreadsheetIcon, plate: "bg-emerald-500/10", glyph: "text-emerald-600 dark:text-emerald-400" },
    doc: { Icon: FileTextIcon, plate: "bg-sky-500/10", glyph: "text-sky-600 dark:text-sky-400" },
    slides: { Icon: PresentationIcon, plate: "bg-orange-500/10", glyph: "text-orange-600 dark:text-orange-400" },
    text: { Icon: FileTextIcon, plate: "bg-slate-500/10", glyph: "text-slate-600 dark:text-slate-300" },
    code: { Icon: FileCodeIcon, plate: "bg-blue-500/10", glyph: "text-blue-600 dark:text-blue-400" },
    data: { Icon: BracesIcon, plate: "bg-teal-500/10", glyph: "text-teal-600 dark:text-teal-400" },
    archive: { Icon: FileArchiveIcon, plate: "bg-amber-500/10", glyph: "text-amber-600 dark:text-amber-400" },
    model3d: { Icon: BoxIcon, plate: "bg-cyan-500/10", glyph: "text-cyan-600 dark:text-cyan-400" },
    font: { Icon: TypeIcon, plate: "bg-indigo-500/10", glyph: "text-indigo-600 dark:text-indigo-400" },
    design: { Icon: PaletteIcon, plate: "bg-rose-500/10", glyph: "text-rose-600 dark:text-rose-400" },
    file: { Icon: FileIcon, plate: "bg-gray-500/10", glyph: "text-gray-500 dark:text-gray-400" },
};

/** What a chip needs, whichever of the three surfaces it is on. */
export interface AttachmentItem {
    name: string;
    /** The browser's copy, on the dashboard where nothing is uploaded yet. */
    file?: File;
    /** The uploaded location, in the chat composer and in history. */
    url?: string;
    /** MIME when we have it; the extension decides otherwise. */
    type?: string;
    size?: number;
}

/**
 * The URL to actually render, once the browser has confirmed it decodes: an object URL
 * for a local file (revoked on unmount — a leaked one holds the whole file in memory for
 * the life of the tab) or the uploaded file's own URL. `null` for anything that is not a
 * renderable image, which is what puts the kind plate on screen instead.
 */
function usePreviewUrl(item: AttachmentItem): string | null {
    const [ready, setReady] = React.useState<string | null>(null);
    const { file, url, name, type } = item;

    React.useEffect(() => {
        setReady(null);

        const mime = type || file?.type || guessMime(name);
        if (!isPreviewableImage({ name, type: mime })) return;

        const source = file ? URL.createObjectURL(file) : url;
        if (!source) return;

        let cancelled = false;
        const probe = new Image();
        probe.src = source;
        void probe
            .decode()
            .then(() => { if (!cancelled) setReady(source); })
            .catch(() => { /* not renderable — the kind plate stands in */ });

        return () => {
            cancelled = true;
            if (file) URL.revokeObjectURL(source);
        };
    }, [file, url, name, type]);

    return ready;
}

function AttachmentChip({
    item,
    onRemove,
    compact,
}: {
    item: AttachmentItem;
    onRemove?: () => void;
    compact?: boolean;
}) {
    const previewUrl = usePreviewUrl(item);

    const kind = attachmentKind(item.name, item.type || item.file?.type);
    const { Icon, plate, glyph } = KIND_STYLE[kind];
    const size = item.size ?? item.file?.size;
    const thumb = compact ? "size-9" : "size-11";

    const body = (
        <>
            <span
                className={cn(
                    "grid shrink-0 place-items-center overflow-hidden rounded-md",
                    thumb,
                    previewUrl ? "bg-black/5 dark:bg-white/5" : plate
                )}
            >
                {previewUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                        src={previewUrl}
                        alt=""
                        aria-hidden
                        className="size-full object-cover"
                    />
                ) : (
                    <Icon className={cn("size-4", glyph)} aria-hidden />
                )}
            </span>
            <span className="min-w-0 flex-1 text-left leading-tight">
                <span className="block truncate text-[11px] font-medium text-gray-700 dark:text-gray-200">
                    {truncateFileName(item.name, compact ? 20 : 26)}
                </span>
                {size ? (
                    <span className="block text-[10px] text-gray-400">{formatBytes(size)}</span>
                ) : null}
            </span>
        </>
    );

    const shell =
        "flex items-center gap-2 rounded-lg border border-black/5 bg-white/70 p-1.5 pr-2 dark:border-white/10 dark:bg-white/5";
    const width = compact ? "max-w-[190px]" : "max-w-[220px]";

    // In history there is nothing to remove, and the whole chip opens the file.
    if (!onRemove) {
        return (
            <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                title={item.name}
                className={cn(shell, width, "transition-colors hover:bg-white dark:hover:bg-white/10")}
            >
                {body}
            </a>
        );
    }

    return (
        <div className={cn(shell, width)} title={item.name}>
            {body}
            <button
                type="button"
                onClick={onRemove}
                aria-label={`Remove ${item.name}`}
                className="grid size-5 shrink-0 place-items-center rounded-full text-gray-400 transition-colors hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/10"
            >
                <XIcon className="size-3" aria-hidden />
            </button>
        </div>
    );
}

export function AttachmentPreviews({
    items,
    onRemove,
    compact = false,
    className,
}: {
    items: AttachmentItem[];
    /** Absent ⇒ read-only (chat history): each chip becomes a link instead. */
    onRemove?: (index: number) => void;
    compact?: boolean;
    className?: string;
}) {
    if (!items.length) return null;
    return (
        <div className={cn("flex flex-wrap gap-1.5", className)}>
            {items.map((item, index) => (
                <AttachmentChip
                    key={`${item.name}-${index}`}
                    item={item}
                    compact={compact}
                    onRemove={onRemove ? () => onRemove(index) : undefined}
                />
            ))}
        </div>
    );
}

/**
 * A MIME guess for an uploaded file, which arrives as a name and a URL only.
 * Just enough to answer "is this an image the browser can render".
 */
function guessMime(name: string): string {
    const extension = (name.split(".").pop() || "").toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(extension)) return `image/${extension === "jpg" ? "jpeg" : extension}`;
    return "";
}
