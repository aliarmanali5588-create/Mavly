/**
 * ═══ SCHEMA RUNNER — ONE TRANSACTION, ONE LOCK, ADDITIVE STEPS ONLY ════════
 *
 * This is the only code in Mavly that issues DDL against a customer database.
 *
 * Postgres DDL is transactional, so the whole run is ONE transaction:
 *
 *   1. `begin`
 *   2. `pg_advisory_xact_lock(...)` — released automatically at commit/rollback,
 *      and safe on Neon's pooled endpoint because the entire run is one
 *      transaction and therefore one backend session;
 *   3. create the ledger (`mavly_schema_migrations`) if absent;
 *   4. run each compiled step whose (name, checksum) is not recorded yet;
 *   5. read the real schema back from `information_schema` and compare it to the
 *      model's expectations;
 *   6. `commit` only when every step applied and the read-back matched.
 *
 * All-or-nothing is the recovery strategy: a failure leaves no partial schema
 * and no partial ledger, and a retry re-applies the idempotent steps. Nothing
 * here knows the connection URI's contents beyond passing it to `pg`, and no
 * error message, log line or result carries the URI, a statement body or a
 * provider credential.
 */

import { Client } from "pg";

import {
  SCHEMA_LEDGER_TABLE,
  schemaLedgerSql,
  type ExpectedColumn,
  type SchemaPlan,
} from "./migrations";
import { quoteIdentifier } from "./model";

const CONNECT_TIMEOUT_MS = 8_000;
const STATEMENT_TIMEOUT_MS = 15_000;
/** Stable transaction advisory-lock key. Scoped to the customer database. */
const SCHEMA_ADVISORY_LOCK = 51_500_311_001;

export interface SchemaVerifyResult {
  verified: boolean;
  problems: string[];
  /** Ledger state, safe to show an owner. */
  appliedSteps: number;
}

export type SchemaApplyResult =
  | {
      ok: true;
      applied: string[];
      skipped: string[];
      verified: true;
      problems: string[];
      appliedSteps: number;
    }
  | {
      ok: false;
      code:
        | "SCHEMA_CONNECTION_FAILED"
        | "SCHEMA_APPLY_FAILED"
        | "SCHEMA_VERIFICATION_FAILED"
        /**
         * Migration 38. The authorization recheck ran immediately before COMMIT
         * and refused, so the whole transaction was rolled back. This is a
         * distinct code because it is NOT a schema failure: the DDL was valid and
         * the run was stopped on purpose.
         */
        | "SCHEMA_AUTHORIZATION_REVOKED";
      /** Sanitized step name, or null when the failure was not step-specific. */
      step: string | null;
      problems: string[];
    };

type PgError = { code?: unknown };

function safeSqlState(error: unknown): string | null {
  const code = (error as PgError | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function createClient(connectionUri: string): Client {
  return new Client({
    connectionString: connectionUri,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: "mavly-schema-runner",
  });
}

async function closeClient(client: Client): Promise<void> {
  await Promise.race([
    client.end().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
}

async function readAppliedSteps(
  client: Client,
): Promise<Array<{ name: string; checksum: string }>> {
  const result = await client.query<{ name: string; checksum: string }>(
    `select ${quoteIdentifier("name")}, ${quoteIdentifier("checksum")} from ${quoteIdentifier(
      SCHEMA_LEDGER_TABLE,
    )}`,
  );
  return result.rows;
}

/** Tables that already existed before this run started. */
async function readExistingTables(
  client: Client,
  expected: readonly ExpectedColumn[],
): Promise<Set<string>> {
  const tables = [...new Set(expected.map((entry) => entry.table))];
  if (tables.length === 0) return new Set();
  const result = await client.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = current_schema()
        and table_name = any($1::text[])`,
    [tables],
  );
  return new Set(result.rows.map((row) => row.table_name));
}

/**
 * `strictNullability` is the set of tables whose declared nullability must match
 * exactly — the tables this run created from scratch. A column added later to a
 * populated table is nullable by design (see the compiler), so for a pre-existing
 * table only presence and type are assertions.
 */
async function verifySchema(
  client: Client,
  expected: readonly ExpectedColumn[],
  strictNullability: ReadonlySet<string> | null,
): Promise<string[]> {
  const tables = [...new Set(expected.map((entry) => entry.table))];
  if (tables.length === 0) return [];
  const result = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = current_schema()
        and table_name = any($1::text[])`,
    [tables],
  );
  const actual = new Map<string, { type: string; nullable: boolean }>();
  for (const row of result.rows) {
    actual.set(`${row.table_name}.${row.column_name}`, {
      type: row.data_type,
      nullable: row.is_nullable === "YES",
    });
  }
  const problems: string[] = [];
  for (const entry of expected) {
    const found = actual.get(`${entry.table}.${entry.column}`);
    if (!found) {
      problems.push(`${entry.table}.${entry.column} is missing`);
      continue;
    }
    if (found.type !== entry.type) {
      problems.push(`${entry.table}.${entry.column} has an unexpected type`);
      continue;
    }
    if (
      (strictNullability === null || strictNullability.has(entry.table)) &&
      found.nullable !== entry.nullable
    ) {
      problems.push(`${entry.table}.${entry.column} has unexpected nullability`);
    }
  }
  return problems;
}

/**
 * ═══ THE COMMIT GATE, AS A PURE DECISION ════════════════════════════════════
 *
 * Split out of `applySchemaPlan` so the one rule that matters can be tested
 * without a database: an authorization check that cannot answer is a REFUSAL.
 *
 * A callback that returns anything other than exactly `true`, or that throws,
 * denies. That asymmetry is deliberate — the failure mode of "permission by
 * accident" is a stranded customer database, and the failure mode of "refusal by
 * accident" is a retried run.
 */
export async function commitGateAllows(
  authorize: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (!authorize) return true;
  try {
    return (await authorize()) === true;
  } catch {
    return false;
  }
}

/**
 * Apply every unrecorded step and verify, atomically. The advisory lock is
 * transaction-scoped; the connection is always closed.
 */
export async function applySchemaPlan(input: {
  connectionUri: string;
  plan: SchemaPlan;
  /** Stop before applying another step past this many milliseconds. */
  timeBudgetMs?: number;
  /**
   * ═══ MIGRATION 38: THE COMMIT-TIME AUTHORIZATION CHECK ════════════════════
   *
   * Every step runs inside ONE transaction, so a revocation that lands mid-apply
   * cannot un-commit DDL that already committed — but it CAN stop the commit.
   * This callback is awaited after every step has run and after the schema has
   * been verified, and immediately before `commit`.
   *
   * Returning false rolls the whole transaction back, so a revoked project leaves
   * no partial schema behind. That is the strongest guarantee available without
   * splitting the run into per-step transactions, which would trade atomicity for
   * a narrower window and is a worse deal.
   *
   * Absent means "no recheck", which is what the pure tests and any non-managed
   * caller get.
   */
  authorizeBeforeCommit?: () => Promise<boolean>;
}): Promise<SchemaApplyResult> {
  const deadline =
    typeof input.timeBudgetMs === "number" && Number.isFinite(input.timeBudgetMs)
      ? Date.now() + Math.max(1_000, input.timeBudgetMs)
      : null;
  const client = createClient(input.connectionUri);
  let inTransaction = false;
  let currentStep: string | null = null;

  try {
    try {
      await client.connect();
    } catch {
      return {
        ok: false,
        code: "SCHEMA_CONNECTION_FAILED",
        step: null,
        problems: ["The managed database could not be reached."],
      };
    }

    try {
      await client.query("begin");
      inTransaction = true;
      await client.query("select pg_advisory_xact_lock($1::bigint)", [
        SCHEMA_ADVISORY_LOCK,
      ]);
      await client.query(schemaLedgerSql());

      const appliedRows = await readAppliedSteps(client);
      const applied = new Set(appliedRows.map((row) => `${row.name}:${row.checksum}`));
      const newlyApplied: string[] = [];
      const skipped: string[] = [];

      /**
       * ⚠️ READ BEFORE ANY STEP RUNS. Inside this transaction a table created
       * by a step is immediately visible, so a post-step read could not tell a
       * fresh table from an existing one — and only a fresh table has strict
       * nullability.
       */
      const existingTables = await readExistingTables(client, input.plan.expected);

      for (const step of input.plan.steps) {
        if (applied.has(`${step.name}:${step.checksum}`)) {
          skipped.push(step.name);
          continue;
        }
        if (deadline !== null && Date.now() > deadline) {
          await client.query("rollback");
          inTransaction = false;
          return {
            ok: false,
            code: "SCHEMA_APPLY_FAILED",
            step: step.name,
            problems: ["The schema run exceeded its time budget before this step."],
          };
        }
        currentStep = step.name;
        await client.query(step.sql);
        await client.query(
          `insert into ${quoteIdentifier(SCHEMA_LEDGER_TABLE)} (${quoteIdentifier(
            "name",
          )}, ${quoteIdentifier("checksum")}) values ($1, $2)
           on conflict (${quoteIdentifier("name")}, ${quoteIdentifier(
             "checksum",
           )}) do nothing`,
          [step.name, step.checksum],
        );
        newlyApplied.push(step.name);
      }

      const createdHere = new Set(
        [...new Set(input.plan.expected.map((entry) => entry.table))].filter(
          (table) => !existingTables.has(table),
        ),
      );
      const problems = await verifySchema(client, input.plan.expected, createdHere);
      if (problems.length > 0) {
        await client.query("rollback");
        inTransaction = false;
        return {
          ok: false,
          code: "SCHEMA_VERIFICATION_FAILED",
          step: null,
          problems: problems.slice(0, 10),
        };
      }

      /**
       * ⚠️ THE LAST MOMENT AUTHORIZATION CAN BE ENFORCED. Everything above is
       * inside the transaction and nothing has committed yet, so a refusal here
       * costs the run its schema and costs the customer nothing.
       *
       * A THROWING callback is treated as a refusal: an authorization check that
       * cannot answer must not be read as permission.
       */
      if (input.authorizeBeforeCommit) {
        const permitted = await commitGateAllows(input.authorizeBeforeCommit);
        if (!permitted) {
          await client.query("rollback");
          inTransaction = false;
          return {
            ok: false,
            code: "SCHEMA_AUTHORIZATION_REVOKED",
            step: null,
            problems: [
              "Authorization was withdrawn before the schema could be committed. Nothing was applied.",
            ],
          };
        }
      }

      await client.query("commit");
      inTransaction = false;

      return {
        ok: true,
        applied: newlyApplied,
        skipped,
        verified: true,
        problems: [],
        appliedSteps: appliedRows.length + newlyApplied.length,
      };
    } catch (error) {
      if (inTransaction) {
        await client.query("rollback").catch(() => undefined);
        inTransaction = false;
      }
      const state = safeSqlState(error);
      return {
        ok: false,
        code: "SCHEMA_APPLY_FAILED",
        step: currentStep,
        problems: [
          state
            ? `The migration step failed with SQLSTATE ${state}.`
            : "The migration step failed.",
        ],
      };
    }
  } finally {
    await closeClient(client);
  }
}

/** Read-only verification for status/readiness. Never issues DDL. */
export async function inspectSchema(input: {
  connectionUri: string;
  expected: readonly ExpectedColumn[];
}): Promise<SchemaVerifyResult> {
  const client = createClient(input.connectionUri);
  try {
    await client.connect();
    const applied = await readAppliedSteps(client).catch(() => []);
    /**
     * Read-only readiness re-check: presence and type only. Nullability is a
     * compile-time intent, not a drift signal — an additive column on a table
     * that already held rows is nullable by design, and reporting that as a
     * problem would make a healthy backend look broken forever.
     */
    const problems = await verifySchema(client, input.expected, null);
    return {
      verified: problems.length === 0,
      problems: problems.slice(0, 10),
      appliedSteps: applied.length,
    };
  } catch {
    return {
      verified: false,
      problems: ["The managed database could not be reached."],
      appliedSteps: 0,
    };
  } finally {
    await closeClient(client);
  }
}
