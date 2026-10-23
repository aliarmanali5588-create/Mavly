"use client";

import type { AgentInputFile } from "@/lib/vcaas-types";
import { vcaasApi } from "@/lib/vcaas";

/**
 * ═══ UPLOADING AN ATTACHMENT ════════════════════════════════════════════════
 *
 * Multipart uploads can't go through `api.*` (JSON only), so `vcaasApi.upload` uses raw
 * fetch — the one documented exception.
 *
 * ⚠️ A FAILED UPLOAD MUST BE REPORTED, NOT SWALLOWED. Returning `null` and letting the
 * caller ignore it is how attaching four photos quietly attached one: everything over
 * about 1 MB is refused by a proxy in front of the API, and the user was told nothing at
 * all. Every function here reports which files failed and why, so a surface can say so.
 *
 * ⚠️ AND A REFUSAL IS NOT RETRIED. Retrying a file that is too large just spends three
 * round trips to arrive at the same answer, and delays the message the user needs. Only
 * `retryable` failures (5xx, 429) and outright network errors go round again — the case
 * the retry was added for is a just-created project whose storage is not writable yet.
 */

/**
 * ⭐ THE SAME 8 MB THE API ENFORCES — CHECKED HERE FIRST.
 *
 * The server is still the authority (`MAX_UPLOAD_BYTES` in the API's `vcaas.routes.ts`,
 * with nginx sitting above it at 12 MB so this JSON refusal is the one people see). This
 * copy exists so an oversized file is refused INSTANTLY and locally, instead of being
 * pushed over the wire for several seconds to be rejected at the far end.
 *
 * ⚠️ KEEP IT IN STEP WITH THE API. If they ever disagree, be the SMALLER of the two: a
 * client that lets through what the server refuses just recreates the silent-drop bug.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

/**
 * What to tell someone whose file is too big. There IS a way through, and saying so is
 * the difference between "impossible" and "not by this route": `inputFiles` accepts any
 * publicly reachable URL, so a hosted file needs no upload at all.
 */
export const TOO_LARGE_ADVICE =
    `Files must be under ${MAX_UPLOAD_MB} MB. For something bigger, host it somewhere public and paste the link in your message instead.`;

/** Split a selection into what can be uploaded and what is over the limit. */
export function splitBySize(files: File[]): { allowed: File[]; tooLarge: File[] } {
    const allowed: File[] = [];
    const tooLarge: File[] = [];
    for (const file of files) (file.size > MAX_UPLOAD_BYTES ? tooLarge : allowed).push(file);
    return { allowed, tooLarge };
}

export interface UploadFailure {
    name: string;
    reason: string;
}

export interface UploadOutcome {
    /** Uploaded files, in the order they were given. */
    uploaded: AgentInputFile[];
    /** Everything that did not make it, with a reason worth showing. */
    failed: UploadFailure[];
}

export async function uploadFileToProject(
    projectId: string,
    file: File,
    opts: { retries?: number; delayMs?: number } = {}
): Promise<{ file: AgentInputFile } | { error: string }> {
    const retries = opts.retries ?? 3;
    const delayMs = opts.delayMs ?? 1500;

    let lastError = "Upload failed";

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const formData = new FormData();
            formData.append("file", file);
            const json = await vcaasApi.upload(projectId, formData);

            if (json.ok && json.data?.url) {
                return { file: { name: file.name, url: json.data.url, imageDescription: file.name } };
            }

            lastError = json.error || lastError;
            // ⚠️ A definitive refusal ends it here — see the note above.
            if (json.retryable === false) return { error: lastError };
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
        if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }

    return { error: lastError };
}

/** Upload several files, keeping both halves of the answer. */
export async function uploadFilesToProjectDetailed(
    projectId: string,
    files: File[],
    opts?: { retries?: number; delayMs?: number }
): Promise<UploadOutcome> {
    const uploaded: AgentInputFile[] = [];
    const failed: UploadFailure[] = [];

    for (const file of files) {
        const result = await uploadFileToProject(projectId, file, opts);
        if ("file" in result) uploaded.push(result.file);
        else failed.push({ name: file.name, reason: result.error });
    }

    return { uploaded, failed };
}

/**
 * The successful uploads only.
 *
 * ⚠️ PREFER `uploadFilesToProjectDetailed` ON ANY SURFACE THAT CAN SHOW A MESSAGE.
 * This shape cannot tell the caller that anything went missing, which is the bug the
 * detailed version exists to prevent.
 */
export async function uploadFilesToProject(
    projectId: string,
    files: File[],
    opts?: { retries?: number; delayMs?: number }
): Promise<AgentInputFile[]> {
    const { uploaded } = await uploadFilesToProjectDetailed(projectId, files, opts);
    return uploaded;
}
