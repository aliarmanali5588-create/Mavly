/**
 * ═══ DETERMINISTIC SCHEMA COMPILER ═════════════════════════════════════════
 *
 * The AI never writes SQL for a managed database. It writes a validated
 * `AppDataModel`; this module compiles that model into a fixed set of
 * versioned, additive steps. That is the whole safety argument:
 *
 *   · identifiers come from `quoteIdentifier`, which only accepts lowercase
 *     `[a-z][a-z0-9_]*` — never model-supplied punctuation, never an expression;
 *   · types come from a closed allowlist;
 *   · every step is idempotent (`if not exists`) and additive. There is no
 *     `drop`, `truncate`, `alter column`, `grant`, extension install, function
 *     body or `do` block in the compiler at all;
 *   · destructive changes are therefore impossible by construction, not by
 *     hoping a validator noticed.
 *
 * Removed columns stay in the customer's database. Deleting customer data is an
 * owner-approved lifecycle action (migration 35's `cleanup_pending`), never a
 * side effect of a generation.
 *
 * Pure (only `node:crypto` for a stable checksum): no connection, no clock.
 */

import { createHash } from "node:crypto";

import {
  APP_DATA_MAX_TEXT_LENGTH,
  quoteIdentifier,
  type AppDataModel,
  type AppDataTable,
} from "./model";

export const SCHEMA_LEDGER_TABLE = "mavly_schema_migrations";
export const AUTH_USERS_TABLE = "_mavly_auth_users";
export const AUTH_SESSIONS_TABLE = "_mavly_auth_sessions";

export interface SchemaStep {
  /** Stable ledger key. Re-running the same name+checksum is a no-op. */
  name: string;
  checksum: string;
  sql: string;
}

export interface ExpectedColumn {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
}

export interface SchemaPlan {
  steps: SchemaStep[];
  /** The schema the runner reads back and compares before it reports success. */
  expected: ExpectedColumn[];
  /** Table/column count for the owner-visible status. */
  tableCount: number;
  columnCount: number;
}

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function step(name: string, statements: string[]): SchemaStep {
  const sql = `${statements.join("\n")}\n`;
  return { name, checksum: checksumOf(sql), sql };
}

const POSTGRES_TYPE: Record<string, string> = {
  text: "text",
  integer: "integer",
  bigint: "bigint",
  boolean: "boolean",
  timestamptz: "timestamptz",
  date: "date",
  numeric: "numeric(20,6)",
  jsonb: "jsonb",
};

/** `information_schema.columns.data_type` reports the base type, not the typmod. */
const VERIFY_TYPE: Record<string, string> = {
  text: "text",
  integer: "integer",
  bigint: "bigint",
  boolean: "boolean",
  timestamptz: "timestamp with time zone",
  date: "date",
  numeric: "numeric",
  jsonb: "jsonb",
};

function columnDefinition(column: AppDataTable["columns"][number]): string {
  const parts = [quoteIdentifier(column.name), POSTGRES_TYPE[column.type] ?? "text"];
  if (column.required) parts.push("not null");
  if (column.type === "text") {
    parts.push(
      `check (length(${quoteIdentifier(column.name)}) <= ${Math.min(
        APP_DATA_MAX_TEXT_LENGTH,
        column.maxLength ?? APP_DATA_MAX_TEXT_LENGTH,
      )})`,
    );
  }
  return parts.join(" ");
}

/** A column added to an existing table: same type and check, deliberately nullable. */
function addedColumnDefinition(column: AppDataTable["columns"][number]): string {
  const parts = [quoteIdentifier(column.name), POSTGRES_TYPE[column.type] ?? "text"];
  if (column.type === "text") {
    parts.push(
      `check (length(${quoteIdentifier(column.name)}) <= ${Math.min(
        APP_DATA_MAX_TEXT_LENGTH,
        column.maxLength ?? APP_DATA_MAX_TEXT_LENGTH,
      )})`,
    );
  }
  return parts.join(" ");
}

function authStep(): SchemaStep {
  return step("auth:init", [
    `create table if not exists ${quoteIdentifier(AUTH_USERS_TABLE)} (`,
    `  ${quoteIdentifier("id")} uuid primary key default gen_random_uuid(),`,
    `  ${quoteIdentifier("email")} text not null,`,
    `  ${quoteIdentifier("password_hash")} text not null,`,
    `  ${quoteIdentifier("created_at")} timestamptz not null default now(),`,
    `  ${quoteIdentifier("updated_at")} timestamptz not null default now()`,
    `);`,
    `create unique index if not exists ${quoteIdentifier(
      `${AUTH_USERS_TABLE}_email_key`,
    )} on ${quoteIdentifier(AUTH_USERS_TABLE)} (lower(${quoteIdentifier("email")}));`,
    `create table if not exists ${quoteIdentifier(AUTH_SESSIONS_TABLE)} (`,
    `  ${quoteIdentifier("id")} uuid primary key default gen_random_uuid(),`,
    `  ${quoteIdentifier("user_id")} uuid not null references ${quoteIdentifier(
      AUTH_USERS_TABLE,
    )}(${quoteIdentifier("id")}) on delete cascade,`,
    `  ${quoteIdentifier("token_hash")} text not null,`,
    `  ${quoteIdentifier("created_at")} timestamptz not null default now(),`,
    `  ${quoteIdentifier("expires_at")} timestamptz not null,`,
    `  ${quoteIdentifier("revoked_at")} timestamptz`,
    `);`,
    `create unique index if not exists ${quoteIdentifier(
      `${AUTH_SESSIONS_TABLE}_token_key`,
    )} on ${quoteIdentifier(AUTH_SESSIONS_TABLE)} (${quoteIdentifier("token_hash")});`,
    `create index if not exists ${quoteIdentifier(
      `${AUTH_SESSIONS_TABLE}_user_idx`,
    )} on ${quoteIdentifier(AUTH_SESSIONS_TABLE)} (${quoteIdentifier("user_id")});`,
  ]);
}

function tableStep(table: AppDataTable): SchemaStep {
  const tableName = quoteIdentifier(table.name);
  const statements: string[] = [];
  const definitions = [
    `${quoteIdentifier("id")} uuid primary key default gen_random_uuid()`,
  ];
  if (table.userOwned) {
    definitions.push(
      `${quoteIdentifier("owner_id")} uuid not null references ${quoteIdentifier(
        AUTH_USERS_TABLE,
      )}(${quoteIdentifier("id")}) on delete cascade`,
    );
  }
  for (const column of table.columns) {
    definitions.push(columnDefinition(column));
  }
  definitions.push(
    `${quoteIdentifier("created_at")} timestamptz not null default now()`,
  );
  definitions.push(
    `${quoteIdentifier("updated_at")} timestamptz not null default now()`,
  );
  statements.push(
    `create table if not exists ${tableName} (\n  ${definitions.join(",\n  ")}\n);`,
  );

  /**
   * An existing table from an earlier model revision gains new columns. Nothing
   * is ever removed or retyped; a drift that changes a column's meaning is a
   * failure the runner reports, not a silent rewrite.
   *
   * ⚠️ AN ADDED COLUMN IS NULLABLE ON PURPOSE. `add column ... not null` fails
   * on a table that already holds rows, and back-filling an invented value into
   * a customer's records would be fabricated data. So the additive step
   * succeeds without touching existing rows, and `required` stays a gateway
   * input rule instead of a retroactive constraint. The runner therefore
   * verifies presence and type for a pre-existing table, and exact nullability
   * only for a table it created in this run.
   */
  for (const column of table.columns) {
    statements.push(
      `alter table ${tableName} add column if not exists ${addedColumnDefinition(
        column,
      )};`,
    );
    if (column.unique) {
      statements.push(
        `create unique index if not exists ${quoteIdentifier(
          `${table.name}_${column.name}_key`,
        )} on ${tableName} (${quoteIdentifier(column.name)});`,
      );
    }
  }
  statements.push(
    `create index if not exists ${quoteIdentifier(
      `${table.name}_created_at_idx`,
    )} on ${tableName} (${quoteIdentifier("created_at")});`,
  );
  if (table.userOwned) {
    statements.push(
      `create index if not exists ${quoteIdentifier(
        `${table.name}_owner_idx`,
      )} on ${tableName} (${quoteIdentifier("owner_id")});`,
    );
  }
  return step(`table:${table.name}`, statements);
}

/**
 * Compile the model. Ordering is auth first, then tables by name, so the same
 * model always produces byte-identical SQL and the same checksums.
 */
export function buildSchemaPlan(model: AppDataModel): SchemaPlan {
  const steps: SchemaStep[] = [];
  if (model.auth.required) steps.push(authStep());
  for (const table of [...model.tables].sort((a, b) => a.name.localeCompare(b.name))) {
    steps.push(tableStep(table));
  }

  const expected: ExpectedColumn[] = [];
  if (model.auth.required) {
    for (const [column, type] of [
      ["id", "uuid"],
      ["email", "text"],
      ["password_hash", "text"],
    ] as const) {
      expected.push({ table: AUTH_USERS_TABLE, column, type, nullable: false });
    }
    for (const [column, type] of [
      ["id", "uuid"],
      ["user_id", "uuid"],
      ["token_hash", "text"],
      ["expires_at", "timestamp with time zone"],
    ] as const) {
      expected.push({ table: AUTH_SESSIONS_TABLE, column, type, nullable: false });
    }
  }
  for (const table of model.tables) {
    expected.push({ table: table.name, column: "id", type: "uuid", nullable: false });
    if (table.userOwned) {
      expected.push({
        table: table.name,
        column: "owner_id",
        type: "uuid",
        nullable: false,
      });
    }
    for (const column of table.columns) {
      expected.push({
        table: table.name,
        column: column.name,
        type: VERIFY_TYPE[column.type] ?? "text",
        nullable: !column.required,
      });
    }
    expected.push({
      table: table.name,
      column: "created_at",
      type: "timestamp with time zone",
      nullable: false,
    });
    expected.push({
      table: table.name,
      column: "updated_at",
      type: "timestamp with time zone",
      nullable: false,
    });
  }

  return {
    steps,
    expected,
    tableCount: model.tables.length + (model.auth.required ? 2 : 0),
    columnCount: expected.length,
  };
}

/** Ledger bootstrap. Created before the first step, never dropped. */
export function schemaLedgerSql(): string {
  return [
    `create table if not exists ${quoteIdentifier(SCHEMA_LEDGER_TABLE)} (`,
    `  ${quoteIdentifier("name")} text not null,`,
    `  ${quoteIdentifier("checksum")} text not null,`,
    `  ${quoteIdentifier("applied_at")} timestamptz not null default now(),`,
    `  primary key (${quoteIdentifier("name")}, ${quoteIdentifier("checksum")})`,
    `);`,
  ].join("\n");
}
