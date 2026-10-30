/**
 * ═══ PARAMETERIZED QUERY BUILDER ═══════════════════════════════════════════
 *
 * Every identifier here comes from the validated `AppDataModel`; every user
 * value is a bind parameter. There is no string interpolation of a value, a
 * table name, a column name, an order direction or a limit.
 *
 * Ownership is not a caller option: a user-owned table ALWAYS carries
 * `owner_id = $n`, and the caller cannot choose the id. A resource that is
 * `public` is read-only by construction (the model validator refuses writes).
 *
 * Pure: no I/O.
 */

import { quoteIdentifier, type AppDataColumnType } from "@/lib/managed-backend/model";

export interface DataColumn {
  name: string;
  type: AppDataColumnType;
  required: boolean;
  maxLength: number | null;
}

export interface SqlQuery {
  text: string;
  values: unknown[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DATA_LIST_DEFAULT_LIMIT = 20;
export const DATA_LIST_MAX_LIMIT = 100;
export const DATA_LIST_MAX_OFFSET = 10_000;
export const DATA_SEARCH_MAX_LENGTH = 100;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** `%` and `_` are ILIKE wildcards; a search term is literal text. */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function selectList(columns: readonly DataColumn[]): string {
  return [
    quoteIdentifier("id"),
    ...columns.map((column) => quoteIdentifier(column.name)),
    quoteIdentifier("created_at"),
    quoteIdentifier("updated_at"),
  ].join(", ");
}

/**
 * ⚠️ FAIL CLOSED, NOT OPEN. A user-owned table without a resolved session would
 * otherwise produce an unfiltered `select` over every user's rows. Throwing is
 * the only safe default; the gateway checks the session first, and this is the
 * second line of defence.
 */
function ownerClause(
  userOwned: boolean,
  userId: string | null,
  values: unknown[],
): string | null {
  if (!userOwned) return null;
  if (!userId) throw new Error("owner required");
  values.push(userId);
  return `${quoteIdentifier("owner_id")} = $${values.length}`;
}

export interface ListQueryInput {
  table: string;
  columns: readonly DataColumn[];
  userOwned: boolean;
  userId: string | null;
  orderBy: { column: string; direction: "asc" | "desc" };
  filterable: readonly string[];
  /** Already type-validated values, keyed by declared column name. */
  filters: Record<string, unknown>;
  /** Literal search text, already length-bounded. */
  search: string | null;
  limit: number;
  offset: number;
}

export function buildListQuery(input: ListQueryInput): SqlQuery {
  const values: unknown[] = [];
  const where: string[] = [];

  const owner = ownerClause(input.userOwned, input.userId, values);
  if (owner) where.push(owner);

  const byName = new Map(input.columns.map((column) => [column.name, column]));
  for (const [name, value] of Object.entries(input.filters)) {
    if (!input.filterable.includes(name)) continue;
    const column = byName.get(name);
    if (!column || value === undefined || value === null) continue;
    values.push(value);
    where.push(`${quoteIdentifier(column.name)} = $${values.length}`);
  }

  if (input.search) {
    const textColumns = input.filterable
      .map((name) => byName.get(name))
      .filter((column): column is DataColumn => column?.type === "text");
    if (textColumns.length > 0) {
      values.push(`%${escapeLike(input.search)}%`);
      where.push(
        `(${textColumns
          .map((column) => `${quoteIdentifier(column.name)} ilike $${values.length}`)
          .join(" or ")})`,
      );
    }
  }

  const orderColumn =
    input.orderBy.column === "created_at" || byName.has(input.orderBy.column)
      ? input.orderBy.column
      : "created_at";
  const direction = input.orderBy.direction === "asc" ? "asc" : "desc";

  const limit = Math.min(
    DATA_LIST_MAX_LIMIT,
    Math.max(1, Math.floor(input.limit)),
  );
  const offset = Math.min(
    DATA_LIST_MAX_OFFSET,
    Math.max(0, Math.floor(input.offset)),
  );
  values.push(limit, offset);

  return {
    text: [
      `select ${selectList(input.columns)}`,
      `from ${quoteIdentifier(input.table)}`,
      where.length > 0 ? `where ${where.join(" and ")}` : "",
      `order by ${quoteIdentifier(orderColumn)} ${direction}`,
      `limit $${values.length - 1} offset $${values.length}`,
    ]
      .filter(Boolean)
      .join(" "),
    values,
  };
}

export interface WriteQueryInput {
  table: string;
  columns: readonly DataColumn[];
  userOwned: boolean;
  userId: string | null;
  /** Already type-validated values for declared columns only. */
  values: Record<string, unknown>;
  id?: string;
}

export function buildCreateQuery(input: WriteQueryInput): SqlQuery {
  const byName = new Map(input.columns.map((column) => [column.name, column]));
  const names: string[] = [];
  const values: unknown[] = [];

  if (input.userOwned) {
    if (!input.userId) throw new Error("owner required");
    names.push(quoteIdentifier("owner_id"));
    values.push(input.userId);
  }

  for (const [name, value] of Object.entries(input.values)) {
    if (!byName.has(name) || value === undefined) continue;
    names.push(quoteIdentifier(name));
    values.push(value);
  }
  if (names.length === 0 || (values.length === 0 && !input.userOwned)) {
    throw new Error("no writable columns");
  }

  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
  return {
    text: `insert into ${quoteIdentifier(input.table)} (${names.join(", ")}) values (${placeholders}) returning ${selectList(input.columns)}`,
    values,
  };
}

export function buildReadQuery(input: {
  table: string;
  columns: readonly DataColumn[];
  userOwned: boolean;
  userId: string | null;
  id: string;
}): SqlQuery {
  if (!isUuid(input.id)) throw new Error("invalid id");
  const values: unknown[] = [input.id];
  const where = [`${quoteIdentifier("id")} = $1`];
  const owner = ownerClause(input.userOwned, input.userId, values);
  if (owner) where.push(owner);
  return {
    text: `select ${selectList(input.columns)} from ${quoteIdentifier(input.table)} where ${where.join(" and ")} limit 1`,
    values,
  };
}

export function buildUpdateQuery(input: WriteQueryInput): SqlQuery {
  if (!input.id || !isUuid(input.id)) throw new Error("invalid id");
  const byName = new Map(input.columns.map((column) => [column.name, column]));
  const values: unknown[] = [];
  const assignments: string[] = [];

  for (const [name, value] of Object.entries(input.values)) {
    if (!byName.has(name) || value === undefined) continue;
    values.push(value);
    assignments.push(`${quoteIdentifier(name)} = $${values.length}`);
  }
  if (assignments.length === 0) throw new Error("no writable columns");

  values.push(input.id);
  const where = [`${quoteIdentifier("id")} = $${values.length}`];
  const owner = ownerClause(input.userOwned, input.userId, values);
  if (owner) where.push(owner);

  return {
    text: `update ${quoteIdentifier(input.table)} set ${assignments.join(", ")}, ${quoteIdentifier("updated_at")} = now() where ${where.join(" and ")} returning ${selectList(input.columns)}`,
    values,
  };
}

export function buildDeleteQuery(input: {
  table: string;
  columns: readonly DataColumn[];
  userOwned: boolean;
  userId: string | null;
  id: string;
}): SqlQuery {
  if (!isUuid(input.id)) throw new Error("invalid id");
  const values: unknown[] = [input.id];
  const where = [`${quoteIdentifier("id")} = $1`];
  const owner = ownerClause(input.userOwned, input.userId, values);
  if (owner) where.push(owner);
  return {
    text: `delete from ${quoteIdentifier(input.table)} where ${where.join(" and ")} returning ${quoteIdentifier("id")}`,
    values,
  };
}
