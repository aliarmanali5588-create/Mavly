/**
 * Phase 8 memory vocabulary. Pure — safe for the API response model and tests.
 * Memory is context only; nothing here is an authorization or entitlement.
 */

export const MEMORY_CATEGORIES = ["decision", "failure"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_AUTHORITIES = ["user", "observed", "repository"] as const;
export type MemoryAuthority = (typeof MEMORY_AUTHORITIES)[number];

export const MEMORY_STATUSES = ["active", "archived", "proposed", "superseded"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type MemoryApprovalState = "approved" | "proposed" | "not_required";
export type MemoryConfidence = "verified" | "unverified";
export type MemorySourceKind = "user" | "run" | "system";

export interface ProjectMemoryItem {
  id: string;
  category: MemoryCategory;
  content: string;
  provenance: string;
  sourceKind: MemorySourceKind;
  authority: MemoryAuthority;
  approvalState: MemoryApprovalState;
  confidence: MemoryConfidence;
  status: MemoryStatus;
  dedupeKey: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface ProjectMemoryFact {
  key: string;
  value: string;
  /** Always `repository`: facts are derived from the current files, not stored. */
  source: "repository";
}

export interface ProjectMemoryList {
  /** Read-only, derived at request time from the actual project files. */
  facts: ProjectMemoryFact[];
  /** Persisted decisions and observed failure outcomes, newest first. */
  memories: ProjectMemoryItem[];
}

export interface MemoryLimits {
  maxContentChars: number;
  maxItemsPerProject: number;
  maxRetrievalItems: number;
  maxRetrievalChars: number;
  failureRetentionDays: number;
}

export const MEMORY_LIMITS: MemoryLimits = {
  maxContentChars: 2_000,
  maxItemsPerProject: 50,
  maxRetrievalItems: 12,
  maxRetrievalChars: 8_000,
  failureRetentionDays: 30,
};

/** A server-derived terminal run summary; never a raw provider message. */
export interface MemoryRunOutcome {
  runId: string;
  status: "failed" | "dead_letter";
  errorClass: string;
  batchesCompleted?: number;
  filesWritten?: number;
}
