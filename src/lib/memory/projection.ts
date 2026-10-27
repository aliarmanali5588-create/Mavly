/**
 * Public projection of a memory row. Internal ownership/dedupe internals stay
 * out of the response; provenance, authority, approval and revision are included
 * so the owner can judge and safely edit a record.
 */

import type { MemoryRow } from "./store";
import type { ProjectMemoryItem } from "./types";

export function toProjectMemoryItem(row: MemoryRow): ProjectMemoryItem {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    provenance: row.provenance,
    sourceKind: row.source_kind,
    authority: row.authority,
    approvalState: row.approval_state,
    confidence: row.confidence,
    status: row.status,
    dedupeKey: row.dedupe_key,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}
