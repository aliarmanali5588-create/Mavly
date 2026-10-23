"use client";

/**
 * ═══ LOCAL SHIM — totalum-platform's shared source-archive cache ════════════
 *
 * The platform keeps every downloaded project archive in one module-level cache so
 * the code editor, the diff viewer and the path picker all share a single download.
 * This app has no such cache: `CodePanel` downloads and decompresses its own archive
 * privately, and nothing else needs one.
 *
 * ⚠️ SO `peekArchive` ALWAYS ANSWERS "NOT IN MEMORY", AND THAT IS CORRECT, NOT A STUB
 * THAT FAILS. Its only caller is `PathPicker`, where it is a pure optimisation: a hit
 * lets the page list appear instantly, a miss falls through to `GET …/files/tree`,
 * which is free and takes a moment. The picker is written for exactly this — see its
 * note on `peekArchive()` being "consulted first".
 *
 * ⚠️ KEEP THE SIGNATURE. `PathPicker` is a verbatim copy of the platform's file
 * (AGENTS.md rule 1); this module exists so it compiles unedited. If this app ever
 * grows a real shared archive cache, replace the body here and the picker gets the
 * speed-up for free.
 */

export interface ProjectArchive {
    /** Every file path in the project, as the tree would report them. */
    paths: string[];
    sha?: string;
}

/** Always `null` here: this app keeps no shared archive. See the note above. */
export function peekArchive(_projectId: string): ProjectArchive | null {
    return null;
}
