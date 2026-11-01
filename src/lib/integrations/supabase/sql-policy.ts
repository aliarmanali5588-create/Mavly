/**
 * ═══ SQL CLASSIFICATION FOR THE SUPABASE BROKER ══════════════════════════════
 *
 * Pure. No network, no database, no `process.env`, no Node built-ins. That is
 * deliberate: the orchestration layer (`src/lib/orchestration/tools.ts`) needs to
 * refuse a blocked statement at validation time, and importing the broker to get
 * this function would drag the Management API client, the token store and the
 * encryption key into a module that has no business holding any of them.
 *
 * ═══ WHY THIS IS NOT A FIRST-KEYWORD CHECK ANY MORE ══════════════════════════
 *
 * The previous version returned `read` as soon as the statement STARTED with
 * `select`, `with`, `explain`, `show`, `describe` or `table`. Three real bypasses
 * followed from that, all of which reached the database with no approval:
 *
 *   · `WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d`
 *     — a data-modifying CTE. Starts with `with`, so it was "read".
 *   · `EXPLAIN ANALYZE DELETE FROM orders`
 *     — `EXPLAIN ANALYZE` EXECUTES the statement. Starts with `explain`.
 *   · `select 1; delete from orders`
 *     — the old semicolon check tolerated a trailing `;` and then only looked at
 *     the first keyword, so the second statement rode along.
 *
 * The fix is a change of shape, not another pattern: the statement is LEXED
 * first (comments and string literals removed), then scanned in full for any
 * data-modifying keyword. A statement is read-only only when it starts with a
 * read keyword AND contains no modifying keyword anywhere. Everything else needs
 * approval, and anything that cannot be lexed is refused outright.
 *
 * ⚠️ THIS IS STILL A HEURISTIC, NOT A POSTGRESQL PARSER, AND IT FAILS CLOSED.
 * No suitable parser dependency exists in this repository (`pg` is a wire
 * protocol client, not a grammar). Where the lexer cannot establish that a
 * statement is read-only, it does not guess: it returns `destructive` (approval
 * required) or `blocked` (refused).
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
  /**
   * ⚠️ SERVER-SIDE FILE AND PROCESS ACCESS. `lo_import`/`lo_export` read and write
   * files on the database host, and the `pg_ls_dir`/`pg_stat_file` family exposes
   * its filesystem. None of these belong in a customer-app query, and none is a
   * read of the customer's data.
   */
  { pattern: /\blo_import\b|\blo_export\b|\bpg_ls_dir\b|\bpg_stat_file\b/i, reason: "filesystem_access_not_allowed" },
  /**
   * ⚠️ TERMINATING ANOTHER SESSION IS NOT A QUERY. It can end the pooler's
   * connections and take the project down, and no legitimate generated-app read
   * needs it.
   */
  { pattern: /\bpg_terminate_backend\b|\bpg_cancel_backend\b/i, reason: "session_control_not_allowed" },
  /**
   * ⚠️ ADVISORY AND TRANSACTION LOCKS ARE NOT READS. They can block other
   * sessions indefinitely, which is a denial of service dressed as a SELECT.
   */
  { pattern: /\bpg_advisory_lock\b|\bpg_try_advisory_lock\b|\bpg_advisory_xact_lock\b/i, reason: "lock_management_not_allowed" },
];

/**
 * ⚠️ ANY OF THESE ANYWHERE IN THE STATEMENT MAKES IT NON-READ-ONLY.
 *
 * Scanned over the whole lexed statement, not just the first word, so a
 * data-modifying CTE, a nested CTE or a second statement cannot hide behind a
 * leading `select`.
 *
 * `\b` boundaries mean `updated_at` and `deleted_at` do not match. A column
 * genuinely named `delete` would, and would require approval — the correct
 * direction to be wrong in.
 */
const MODIFYING_KEYWORD =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|replace|rename|comment|copy|vacuum|reindex|cluster|refresh|call|do|grant|revoke|set|reset|lock|listen|notify|unlisten|prepare|deallocate|discard|checkpoint|import|security|analyze)\b/i;

/**
 * ⚠️ `SELECT ... INTO new_table` CREATES A TABLE. It starts with `select` and
 * contains no modifying keyword, so the keyword scan alone would call it a read.
 * This is the one leading-read form that writes, and it is matched explicitly.
 *
 * `INTO` is also used by `INSERT INTO` and `MERGE INTO`, but those statements do
 * not start with a read keyword, so they never reach this check as a read.
 */
const SELECT_INTO_PATTERN = /^\s*select\b[\s\S]*?\binto\b/i;

/**
 * A statement that only reads. This is a PRECONDITION, not a verdict: the
 * modifying-keyword scan still has to come back clean.
 *
 * ⚠️ `table` IS NOT IN THIS LIST. `TABLE foo` is a read in PostgreSQL, but it is
 * rare enough that treating an unrecognised leading keyword as destructive costs
 * nothing, and it keeps the read set small.
 */
const READ_PATTERN = /^\s*(select|with|explain|show|describe|desc|values)\b/i;

/**
 * ═══ LEXING ═════════════════════════════════════════════════════════════════
 *
 * Strip comments and string literals so a keyword cannot be hidden inside them
 * and a keyword inside a literal cannot trigger a false positive.
 *
 * Returns `null` when the input cannot be lexed safely (an unterminated string,
 * comment or dollar-quote). A caller must treat that as a refusal, never as
 * "probably fine".
 */
export function lexSql(input: string): { scrubbed: string; statements: string[] } | null {
  let out = "";
  let index = 0;
  const length = input.length;

  while (index < length) {
    const char = input[index];
    const next = input[index + 1];

    // ── Line comment: -- ... to end of line ────────────────────────────────
    if (char === "-" && next === "-") {
      while (index < length && input[index] !== "\n") index += 1;
      out += " ";
      continue;
    }

    // ── Block comment: /* ... */, which PostgreSQL NESTS ───────────────────
    if (char === "/" && next === "*") {
      let depth = 0;
      while (index < length) {
        if (input[index] === "/" && input[index + 1] === "*") {
          depth += 1;
          index += 2;
          continue;
        }
        if (input[index] === "*" && input[index + 1] === "/") {
          depth -= 1;
          index += 2;
          if (depth === 0) break;
          continue;
        }
        index += 1;
      }
      if (depth !== 0) return null; // unterminated
      out += " ";
      continue;
    }

    // ── Single-quoted string, with '' as the escape ────────────────────────
    if (char === "'") {
      index += 1;
      let closed = false;
      while (index < length) {
        if (input[index] === "'") {
          if (input[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return null; // unterminated
      out += " '' ";
      continue;
    }

    // ── Double-quoted identifier: content is a name, not a keyword ─────────
    if (char === '"') {
      index += 1;
      let closed = false;
      while (index < length) {
        if (input[index] === '"') {
          if (input[index + 1] === '"') {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return null;
      out += " ident ";
      continue;
    }

    // ── Dollar-quoted string: $tag$ ... $tag$ ──────────────────────────────
    if (char === "$") {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(index));
      if (match) {
        const tag = match[0];
        const close = input.indexOf(tag, index + tag.length);
        if (close === -1) return null; // unterminated
        index = close + tag.length;
        out += " '' ";
        continue;
      }
    }

    out += char;
    index += 1;
  }

  /**
   * Split on top-level semicolons. Strings and comments are already gone, so a
   * `;` here is a real statement separator.
   */
  const statements = out
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return { scrubbed: out, statements };
}

/**
 * Are the parentheses in a lexed statement balanced?
 *
 * ⚠️ RUN ON THE LEXED BODY, NOT THE RAW INPUT. Strings, quoted identifiers and
 * comments are already gone, so a `(` inside a literal cannot skew the count.
 *
 * An unbalanced statement is refused rather than guessed at: it is either
 * malformed or spliced, and neither is something to classify as a read.
 */
export function hasBalancedParens(body: string): boolean {
  let depth = 0;
  for (const char of body) {
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

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

  const lexed = lexSql(sql);
  /**
   * ⚠️ UNLEXABLE IS REFUSED, NOT ASSUMED HARMLESS. An unterminated string or
   * comment means we cannot see the whole statement, so we cannot classify it.
   */
  if (!lexed) return { risk: "blocked", reason: "statement_not_parseable" };

  /**
   * ⚠️ ONE STATEMENT PER APPROVAL. `select 1; delete from orders` is two
   * statements, and the approval the user gave covered the first one.
   */
  if (lexed.statements.length > 1) {
    return { risk: "blocked", reason: "multiple_statements_not_allowed" };
  }
  if (lexed.statements.length === 0) {
    return { risk: "blocked", reason: "statement_required" };
  }

  const body = lexed.statements[0];

  for (const entry of BLOCKED_PATTERNS) {
    if (entry.pattern.test(body)) {
      return { risk: "blocked", reason: entry.reason };
    }
  }

  /**
   * ═══ THE CORE RULE ══════════════════════════════════════════════════════
   *
   * Read-only requires BOTH: it starts like a read, AND no modifying keyword
   * appears anywhere in the statement. The second half is what closes the
   * data-modifying-CTE and `EXPLAIN ANALYZE` bypasses.
   *
   * `EXPLAIN` without `ANALYZE` does not execute its inner statement, so this is
   * stricter than PostgreSQL for that one case. Requiring approval for a plan is
   * an acceptable cost for not having to reason about which EXPLAIN forms execute.
   */
  const startsAsRead = READ_PATTERN.test(body);
  const modifies = MODIFYING_KEYWORD.test(body);

  /**
   * ⚠️ UNBALANCED PARENTHESES ARE REFUSED. The lexer strips strings and comments,
   * so a paren count here is meaningful. An unbalanced statement is one we cannot
   * reason about — and it is also the shape a truncated or spliced statement takes.
   */
  if (!hasBalancedParens(body)) {
    return { risk: "blocked", reason: "statement_not_parseable" };
  }

  /**
   * ⚠️ `SELECT ... INTO` WRITES. Checked before the read verdict, because it is a
   * leading read keyword with no modifying keyword in it.
   */
  if (startsAsRead && SELECT_INTO_PATTERN.test(body)) {
    return { risk: "destructive", reason: null };
  }

  if (startsAsRead && !modifies) {
    return { risk: "read", reason: null };
  }

  /**
   * Everything else needs approval: a modifying keyword anywhere, or a statement
   * whose leading keyword we do not recognise. Fail closed, never assume a read.
   */
  return { risk: "destructive", reason: null };
}

/** Does this statement need the user to confirm it before it runs? */
export function sqlRequiresApproval(classification: SqlClassification): boolean {
  return classification.risk === "destructive";
}
