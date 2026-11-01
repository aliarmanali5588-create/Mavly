/**
 * ═══ SQL CLASSIFICATION FOR THE SUPABASE BROKER ══════════════════════════════
 *
 * Pure. No network, no database, no `process.env`, no Node built-ins. That is
 * deliberate: the orchestration layer (`src/lib/orchestration/tools.ts`) needs to
 * refuse a blocked statement at validation time, and importing the broker to get
 * this function would drag the Management API client, the token store and the
 * encryption key into a module that has no business holding any of them.
 *
 * ⚠️ THIS IS A HEURISTIC, NOT A PARSER, AND IT FAILS CLOSED. A statement that
 * matches neither the read pattern nor the destructive pattern is treated as
 * destructive, so an unrecognised statement needs approval rather than slipping
 * through as a read.
 */

export type SqlRisk = "read" | "write" | "destructive" | "blocked";

export interface SqlClassification {
  risk: SqlRisk;
  /** Why it was blocked, when it was. Never includes the statement. */
  reason: string | null;
}

/**
 * Statements that are never allowed through this broker, whatever the approval.
 *
 * ⚠️ THESE ARE NOT "DESTRUCTIVE WITH APPROVAL" — THEY ARE REFUSED. A customer
 * database is not ours to restructure wholesale, and several of these can end a
 * project's ability to serve at all. The user can still do them in Supabase's own
 * SQL editor, where they are the only actor.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bcreate\s+(or\s+replace\s+)?extension\b/i, reason: "extension_management_not_allowed" },
  { pattern: /\bdrop\s+(database|schema)\b/i, reason: "schema_drop_not_allowed" },
  { pattern: /\balter\s+system\b/i, reason: "system_catalog_not_allowed" },
  { pattern: /\bcreate\s+(role|user)\b/i, reason: "role_management_not_allowed" },
  { pattern: /\balter\s+(role|user)\b/i, reason: "role_management_not_allowed" },
  { pattern: /\bgrant\b|\brevoke\b/i, reason: "permission_management_not_allowed" },
  { pattern: /\bpg_read_file\b|\bpg_write_file\b|\bcopy\s+.*\bfrom\s+program\b/i, reason: "filesystem_access_not_allowed" },
  { pattern: /\bdblink\b|\bpostgres_fdw\b/i, reason: "foreign_access_not_allowed" },
  { pattern: /\bset\s+session\s+authorization\b/i, reason: "identity_switch_not_allowed" },
];

/** Statements that destroy data or structure and therefore need approval. */
const DESTRUCTIVE_PATTERN =
  /\b(drop|truncate|delete|alter)\b|\bupdate\b|\binsert\b|\bcreate\b|\breplace\b|\brename\b/i;

/** A statement that only reads. */
const READ_PATTERN = /^\s*(select|with|explain|show|describe|table)\b/i;

/**
 * Classify a SQL statement.
 *
 * ⚠️ MULTI-STATEMENT INPUT IS REFUSED OUTRIGHT. A single approval must not cover
 * a batch whose later statements nobody read.
 */
export function classifySql(statement: unknown): SqlClassification {
  if (typeof statement !== "string") {
    return { risk: "blocked", reason: "statement_required" };
  }
  const sql = statement.trim();
  if (!sql) return { risk: "blocked", reason: "statement_required" };
  if (sql.length > 20_000) return { risk: "blocked", reason: "statement_too_long" };

  /**
   * A semicolon anywhere but the very end means more than one statement. Trailing
   * whitespace and a single terminator are tolerated.
   */
  const withoutTrailing = sql.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return { risk: "blocked", reason: "multiple_statements_not_allowed" };
  }

  for (const entry of BLOCKED_PATTERNS) {
    if (entry.pattern.test(withoutTrailing)) {
      return { risk: "blocked", reason: entry.reason };
    }
  }

  if (READ_PATTERN.test(withoutTrailing)) {
    return { risk: "read", reason: null };
  }
  if (DESTRUCTIVE_PATTERN.test(withoutTrailing)) {
    return { risk: "destructive", reason: null };
  }
  /**
   * Unrecognised: fail closed. Approval is required rather than assumed.
   */
  return { risk: "destructive", reason: null };
}

/** Does this statement need the user to confirm it before it runs? */
export function sqlRequiresApproval(classification: SqlClassification): boolean {
  return classification.risk === "destructive";
}
