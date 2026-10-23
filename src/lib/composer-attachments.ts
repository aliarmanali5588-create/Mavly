"use client";

import type { AgentInputFile } from "@/lib/vcaas-types";

/**
 * ═══ THE COMPOSER'S ATTACHMENTS SURVIVE A RELOAD ════════════════════════════
 *
 * A file attached to the chat composer is ALREADY UPLOADED — `uploadAndAttach` sends
 * it to the project the moment it is picked or pasted, and what the chip holds from
 * then on is a name and the uploaded file's URL. Losing that on a reload is losing
 * nothing but a reference, while making the user find, re-pick and re-upload the file
 * (and pay the upload again). This keeps the reference.
 *
 * ⚠️ ONLY UPLOADED FILES BELONG HERE. The dashboard hero holds real `File` objects,
 * because there is no project yet to upload them to — those are not serialisable and
 * are deliberately not persisted. This module is for the workspace composer only.
 *
 * ⭐ `localStorage`, FOR THE SAME REASON AS THE TEXT DRAFT. An attachment is inert: it
 * populates a chip and waits, and nothing is spent until the user presses send. So the
 * rule that forces `sessionStorage` on a PENDING PROMPT (which starts a billable run
 * the moment it is read) does not apply, and `localStorage` survives the cases people
 * actually lose work to — a closed tab, a browser restart, a crash.
 *
 * ⚠️ KEYED PER PROJECT. Two projects must never show each other's attachments.
 *
 * ⚠️ EVERY FUNCTION IS SAFE IN SSR AND IN PRIVATE MODE. Storage may be absent (server
 * render) or throw (Safari private browsing, quota). Nothing here throws; the worst
 * case is that attachments stop persisting, which is the behaviour before this existed.
 */

const KEY_PREFIX = "totalum:attachments:project:";

/**
 * A week, matching the text draft. Long enough to cover a weekend; short enough that a
 * forgotten attachment does not ambush someone a month later.
 *
 * ⚠️ IT ALSO BOUNDS A DEAD LINK. The stored URL is a signed one. It does not expire
 * anywhere near this soon, but the file itself can be deleted from the project, and a
 * chip whose image no longer loads is worse than no chip — `AttachmentPreview` falls
 * back to the kind plate, and the age limit stops that lingering indefinitely.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Beyond these we stop persisting.
 *
 * ⚠️ A GUARD ON THE STORE, NOT ON THE COMPOSER. The composer itself has no limit and
 * must not grow one because of this file. `localStorage` is ~5 MB for the whole ORIGIN,
 * shared with every other key we own, and a signed URL is ~700 characters, so a long
 * enough list could fill it and start throwing quota errors on unrelated writes.
 */
const MAX_FILES = 20;
const MAX_SERIALISED_LENGTH = 100_000;

interface StoredAttachments {
    files: AgentInputFile[];
    /** Epoch ms. Only ever used to discard something stale. */
    savedAt: number;
}

export function attachmentsKeyForProject(projectId: string): string {
    return `${KEY_PREFIX}${projectId}`;
}

function storage(): Storage | null {
    try {
        if (typeof window === "undefined") return null;
        return window.localStorage;
    } catch {
        return null;
    }
}

/** Everything still valid for this project, or `[]`. Never throws. */
export function loadAttachments(projectId: string): AgentInputFile[] {
    const store = storage();
    if (!store) return [];
    const key = attachmentsKeyForProject(projectId);
    try {
        const raw = store.getItem(key);
        if (!raw) return [];

        const parsed = JSON.parse(raw) as StoredAttachments;
        if (!parsed || !Array.isArray(parsed.files)) {
            store.removeItem(key);
            return [];
        }
        if (!parsed.savedAt || Date.now() - parsed.savedAt > MAX_AGE_MS) {
            store.removeItem(key);
            return [];
        }

        // ⚠️ Trust nothing that came out of storage: another tab, an older build or a
        // hand-edited value could all put a shape here that the chips cannot render.
        return parsed.files
            .filter((file): file is AgentInputFile =>
                !!file && typeof file.name === "string" && typeof file.url === "string"
            )
            .slice(0, MAX_FILES);
    } catch {
        try { store.removeItem(key); } catch { /* nothing left to try */ }
        return [];
    }
}

/** Persist this project's attachments, or clear them when the list is empty. */
export function saveAttachments(projectId: string, files: AgentInputFile[]): void {
    const store = storage();
    if (!store) return;
    const key = attachmentsKeyForProject(projectId);
    try {
        if (!files.length) {
            store.removeItem(key);
            return;
        }
        const payload: StoredAttachments = { files: files.slice(0, MAX_FILES), savedAt: Date.now() };
        const serialised = JSON.stringify(payload);
        if (serialised.length > MAX_SERIALISED_LENGTH) return;
        store.setItem(key, serialised);
    } catch {
        /* Quota or private mode — persisting is a convenience, never a requirement. */
    }
}
