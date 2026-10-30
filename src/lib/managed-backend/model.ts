/**
 * ═══ APPLICATION DATA MODEL — THE ONLY SHAPE THE BACKEND WILL BUILD ═════════
 *
 * The planner proposes tables, columns, resources and whether the generated app
 * needs end-user accounts. This module is the server's validator: nothing from
 * the model reaches SQL, a resource router or a query builder until it has been
 * normalized here.
 *
 * The model is deliberately small: no free-form SQL, no expressions, no
 * defaults, no foreign keys, no extension types. A column is an identifier plus
 * one allowlisted type. That is what makes the deterministic migration compiler
 * and the parameterized data gateway safe to build on top of model output.
 *
 * ⚠️ `_mavly_*`, `pg_*` and Mavly's own bookkeeping column names are reserved.
 * A model cannot claim them, so it cannot reach the auth tables or the migration
 * ledger through a data resource.
 *
 * Pure: no I/O, no clock, no environment.
 */

export const APP_DATA_MODEL_VERSION = 1 as const;
export const APP_DATA_MAX_TABLES = 12;
export const APP_DATA_MAX_COLUMNS_PER_TABLE = 24;
export const APP_DATA_MAX_RESOURCES = 12;
export const APP_DATA_MAX_TEXT_LENGTH = 4_000;
export const APP_DATA_MAX_JSON_BYTES = 8_000;

export const APP_DATA_COLUMN_TYPES = [
  "text",
  "integer",
  "bigint",
  "boolean",
  "timestamptz",
  "date",
  "numeric",
  "jsonb",
] as const;

export type AppDataColumnType = (typeof APP_DATA_COLUMN_TYPES)[number];

export const APP_DATA_OPERATIONS = [
  "list",
  "read",
  "create",
  "update",
  "delete",
] as const;

export type AppDataOperation = (typeof APP_DATA_OPERATIONS)[number];

export const APP_DATA_RESERVED_TABLE_NAMES = [
  "public",
  "auth",
  "storage",
  "information_schema",
  "pg_catalog",
  "mavly_schema_migrations",
] as const;

export const APP_DATA_SYSTEM_COLUMNS = [
  "id",
  "owner_id",
  "created_at",
  "updated_at",
] as const;

export interface AppDataColumn {
  name: string;
  type: AppDataColumnType;
  required: boolean;
  /** Text-only bound, applied by the migration and enforced by the gateway. */
  maxLength: number | null;
  unique: boolean;
}

export interface AppDataTable {
  name: string;
  columns: AppDataColumn[];
  /** True when the table belongs to one generated-app end user. */
  userOwned: boolean;
}

export interface AppDataResource {
  /** URL segment: `/api/app/v1/data/<name>`. */
  name: string;
  table: string;
  operations: AppDataOperation[];
  /** `user` rows are owner-scoped; `public` rows are read-only for everyone. */
  ownership: "user" | "public";
  /** Columns accepted for equality/ILIKE filtering. Never free-text SQL. */
  filterable: string[];
  orderBy: { column: string; direction: "asc" | "desc" };
}

export interface AppDataAuth {
  required: boolean;
  /** Whether the generated app exposes self-service registration. */
  allowSignup: boolean;
}

export interface AppDataModel {
  version: typeof APP_DATA_MODEL_VERSION;
  tables: AppDataTable[];
  resources: AppDataResource[];
  auth: AppDataAuth;
}

export type AppDataModelResult =
  | { ok: true; model: AppDataModel }
  | { ok: false; error: string };

const TABLE_NAME = /^[a-z][a-z0-9_]{1,40}$/;
const COLUMN_NAME = /^[a-z][a-z0-9_]{0,40}$/;

export function isSafeAppIdentifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

/**
 * Quote one identifier that is known to be a bare lowercase name.
 *
 * A leading underscore is allowed because Mavly's own auth tables are named
 * `_mavly_auth_*`. Model-supplied names still cannot start with `_`: the model
 * validator requires `^[a-z]`, so this does not widen what a planner can reach.
 */
export function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,63}$/.test(value)) {
    throw new Error("unsafe identifier");
  }
  return `"${value}"`;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function reservedColumn(name: string): boolean {
  return (
    (APP_DATA_SYSTEM_COLUMNS as readonly string[]).includes(name) ||
    name.startsWith("_mavly")
  );
}

function reservedTable(name: string): boolean {
  return (
    (APP_DATA_RESERVED_TABLE_NAMES as readonly string[]).includes(name) ||
    name.startsWith("_mavly") ||
    name.startsWith("pg_") ||
    name.startsWith("sql_")
  );
}

function parseColumn(raw: unknown): AppDataColumn | string {
  const record = recordOf(raw);
  if (!record) return "a column is not an object";
  const name = record.name;
  if (!isSafeAppIdentifier(name, COLUMN_NAME)) return "a column name is invalid";
  if (reservedColumn(name)) return `column "${name}" is reserved`;
  const type = record.type;
  if (!(APP_DATA_COLUMN_TYPES as readonly unknown[]).includes(type)) {
    return `column "${name}" has an unsupported type`;
  }
  const unique = record.unique === true;
  if (unique && (type === "jsonb" || type === "timestamptz" || type === "date")) {
    return `column "${name}" cannot be unique with type "${String(type)}"`;
  }
  const rawMax = record.maxLength;
  const maxLength =
    type === "text"
      ? Math.min(
          APP_DATA_MAX_TEXT_LENGTH,
          Math.max(1, boundedInt(rawMax, APP_DATA_MAX_TEXT_LENGTH)),
        )
      : null;
  return {
    name,
    type: type as AppDataColumnType,
    required: record.required === true,
    maxLength,
    unique,
  };
}

function parseTable(raw: unknown): AppDataTable | string {
  const record = recordOf(raw);
  if (!record) return "a table is not an object";
  const name = record.name;
  if (!isSafeAppIdentifier(name, TABLE_NAME)) return "a table name is invalid";
  if (reservedTable(name)) return `table "${name}" is reserved`;
  const columns = Array.isArray(record.columns) ? record.columns : [];
  if (columns.length === 0) return `table "${name}" has no columns`;
  if (columns.length > APP_DATA_MAX_COLUMNS_PER_TABLE) {
    return `table "${name}" has too many columns`;
  }
  const parsed: AppDataColumn[] = [];
  const seen = new Set<string>();
  for (const entry of columns) {
    const column = parseColumn(entry);
    if (typeof column === "string") return `${column} in table "${name}"`;
    if (seen.has(column.name)) return `table "${name}" repeats column "${column.name}"`;
    seen.add(column.name);
    parsed.push(column);
  }
  return {
    name,
    columns: parsed,
    userOwned: record.userOwned === true,
  };
}

function parseResource(
  raw: unknown,
  tables: ReadonlyMap<string, AppDataTable>,
): AppDataResource | string {
  const record = recordOf(raw);
  if (!record) return "a resource is not an object";
  const name = record.name;
  if (!isSafeAppIdentifier(name, TABLE_NAME)) return "a resource name is invalid";
  const tableName = record.table;
  const table = typeof tableName === "string" ? tables.get(tableName) : undefined;
  if (!table) return `resource "${name}" does not reference a declared table`;

  const rawOperations = Array.isArray(record.operations) ? record.operations : [];
  const operations: AppDataOperation[] = [];
  for (const entry of rawOperations) {
    if (!(APP_DATA_OPERATIONS as readonly unknown[]).includes(entry)) {
      return `resource "${name}" has an unsupported operation`;
    }
    if (!operations.includes(entry as AppDataOperation)) {
      operations.push(entry as AppDataOperation);
    }
  }
  if (operations.length === 0) return `resource "${name}" declares no operations`;

  const ownership = record.ownership === "public" ? "public" : "user";
  if (ownership === "public") {
    const write = operations.find((operation) =>
      ["create", "update", "delete"].includes(operation),
    );
    if (write) {
      return `public resource "${name}" cannot declare "${write}"`;
    }
  }
  if (ownership === "user" && !table.userOwned) {
    return `resource "${name}" is user-scoped but its table is not`;
  }

  const columnNames = new Set(table.columns.map((column) => column.name));
  const filterable: string[] = [];
  for (const entry of Array.isArray(record.filterable) ? record.filterable : []) {
    if (typeof entry !== "string" || !columnNames.has(entry)) {
      return `resource "${name}" filters on an unknown column`;
    }
    if (!filterable.includes(entry)) filterable.push(entry);
  }

  const rawOrder = recordOf(record.orderBy);
  const orderColumn =
    rawOrder && typeof rawOrder.column === "string" ? rawOrder.column : null;
  const orderBy =
    orderColumn === "created_at"
      ? { column: orderColumn, direction: (rawOrder?.direction === "asc" ? "asc" : "desc") as "asc" | "desc" }
      : orderColumn && columnNames.has(orderColumn)
        ? {
            column: orderColumn,
            direction: rawOrder?.direction === "asc" ? ("asc" as const) : ("desc" as const),
          }
        : { column: "created_at", direction: "desc" as const };

  return { name, table: table.name, operations, ownership, filterable, orderBy };
}

function parseAuth(raw: unknown): AppDataAuth {
  const record = recordOf(raw);
  return {
    required: record?.required === true,
    allowSignup: record?.required === true && record?.allowSignup !== false,
  };
}

export function parseAppDataModel(raw: unknown): AppDataModelResult {
  const record = recordOf(raw);
  if (!record) return { ok: false, error: "The data model is not an object." };
  if (record.version !== undefined && record.version !== APP_DATA_MODEL_VERSION) {
    return { ok: false, error: "The data model version is not supported." };
  }
  const rawTables = Array.isArray(record.tables) ? record.tables : [];
  if (rawTables.length > APP_DATA_MAX_TABLES) {
    return { ok: false, error: "The data model has too many tables." };
  }
  const tables: AppDataTable[] = [];
  const byName = new Map<string, AppDataTable>();
  for (const entry of rawTables) {
    const table = parseTable(entry);
    if (typeof table === "string") return { ok: false, error: table };
    if (byName.has(table.name)) {
      return { ok: false, error: `table "${table.name}" is declared twice` };
    }
    tables.push(table);
    byName.set(table.name, table);
  }
  if (tables.length === 0) {
    return { ok: false, error: "The data model declares no tables." };
  }

  const rawResources = Array.isArray(record.resources) ? record.resources : [];
  if (rawResources.length > APP_DATA_MAX_RESOURCES) {
    return { ok: false, error: "The data model has too many resources." };
  }
  const resources: AppDataResource[] = [];
  const resourceNames = new Set<string>();
  for (const entry of rawResources) {
    const resource = parseResource(entry, byName);
    if (typeof resource === "string") return { ok: false, error: resource };
    if (resourceNames.has(resource.name)) {
      return { ok: false, error: `resource "${resource.name}" is declared twice` };
    }
    resourceNames.add(resource.name);
    resources.push(resource);
  }

  /**
   * A table is either user-owned or public, never both. Mixing would let one
   * resource read rows another resource cannot write, and vice versa.
   */
  const ownershipByTable = new Map<string, "user" | "public">();
  for (const resource of resources) {
    const previous = ownershipByTable.get(resource.table);
    if (previous && previous !== resource.ownership) {
      return {
        ok: false,
        error: `table "${resource.table}" is used with mixed ownership`,
      };
    }
    ownershipByTable.set(resource.table, resource.ownership);
  }
  for (const table of tables) {
    const declared = ownershipByTable.get(table.name);
    const shouldBeUserOwned = declared === "user";
    if (table.userOwned !== shouldBeUserOwned) {
      return {
        ok: false,
        error: `table "${table.name}" ownership does not match its resources`,
      };
    }
  }

  const auth = parseAuth(record.auth);
  /**
   * An owner-scoped table without end-user accounts would have an `owner_id`
   * that no session can ever produce. Refuse the model rather than mint an
   * unusable table.
   */
  if (!auth.required && tables.some((table) => table.userOwned)) {
    return {
      ok: false,
      error: "The data model has owner-scoped tables but no end-user authentication.",
    };
  }

  return {
    ok: true,
    model: {
      version: APP_DATA_MODEL_VERSION,
      tables,
      resources,
      auth,
    },
  };
}

export function appDataResourceByName(
  model: AppDataModel,
  name: string,
): AppDataResource | null {
  return model.resources.find((resource) => resource.name === name) ?? null;
}

export function appDataTableByName(
  model: AppDataModel,
  name: string,
): AppDataTable | null {
  return model.tables.find((table) => table.name === name) ?? null;
}

/** Deterministic, dependency-free checksum of the normalized model. */
export function appDataModelFingerprint(model: AppDataModel): string {
  const canonical = JSON.stringify({
    version: model.version,
    auth: model.auth,
    tables: [...model.tables]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((table) => ({
        name: table.name,
        userOwned: table.userOwned,
        columns: [...table.columns]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((column) => [
            column.name,
            column.type,
            column.required,
            column.maxLength,
            column.unique,
          ]),
      })),
    resources: [...model.resources]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((resource) => [
        resource.name,
        resource.table,
        [...resource.operations].sort(),
        resource.ownership,
        [...resource.filterable].sort(),
        resource.orderBy.column,
        resource.orderBy.direction,
      ]),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
