/**
 * A stable hash of a whole source state.
 *
 * Kept in its own module so the verification sandbox can prove that the files
 * it uploads are exactly the snapshot it claims to verify, without importing
 * the Supabase-backed snapshot store.
 */

import { createHash } from "node:crypto";

export interface HashableFile {
  path: string;
  content: string;
}

/**
 * ⚠️ THE PATHS ARE PART OF THE HASH, and they are sorted first: the hash must
 * answer "is this the same source?", and two projects whose files were written
 * in a different order are the same source.
 */
export function hashSource(files: readonly HashableFile[]): string {
  const hash = createHash("sha256");
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of ordered) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.content);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}
