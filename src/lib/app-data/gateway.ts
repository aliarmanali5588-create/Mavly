/**
 * ═══ GENERATED-APP DATA API ════════════════════════════════════════════════
 *
 * Real, persisted CRUD over the customer's Neon database, executed entirely
 * server-side by Mavly. The generated browser code never sees a database
 * credential and never builds SQL:
 *
 *   browser ──fetch──▶ /api/app/v1/apps/<project>/data/<resource>
 *                         │  session token (Bearer or scoped cookie)
 *                         │  validated data model
 *                         ▼
 *                      parameterized SQL ──▶ customer Neon database
 *
 * The only tables and columns reachable are the ones in the applied data model,
 * and the only operations are the ones the resource declares. There is no
 * generic admin endpoint and no way to name a table in a request.
 *
 * ⚠️ AUTHORIZATION IS SERVER-SIDE. For a user-owned resource the session's user
 * id is bound as `owner_id`; a client-supplied id is never accepted as proof of
 * ownership, and the query builder throws rather than run unfiltered.
 */

import {
  appDataResourceByName,
  appDataTableByName,
  type AppDataColumnType,
  type AppDataModel,
} from "@/lib/managed-backend/model";

import { resolveSessionUser, type AuthUser } from "./auth-service";
import { originAllowed } from "./cors";
import {
  admit,
  gatewayFail,
  gatewayOk,
  resolveApp,
  withDatabase,
  type GatewayResponse,
  type ResolvedApp,
} from "./context";
import {
  buildCreateQuery,
  buildDeleteQuery,
  buildListQuery,
  buildReadQuery,
  buildUpdateQuery,
  DATA_LIST_DEFAULT_LIMIT,
  DATA_LIST_MAX_LIMIT,
  DATA_LIST_MAX_OFFSET,
  DATA_SEARCH_MAX_LENGTH,
  isUuid,
  type DataColumn,
} from "./query";

const NOT_FOUND = gatewayFail(404, "not_found", "Not found.");
const UNAUTHORIZED = gatewayFail(
  401,
  "authentication_required",
  "Sign in to access this resource.",
);

interface DataAccess {
  app: ResolvedApp;
  resource: NonNullable<ReturnType<typeof appDataResourceByName>>;
  table: NonNullable<ReturnType<typeof appDataTableByName>>;
  columns: DataColumn[];
  user: AuthUser | null;
}

async function loadAccess(input: {
  projectId: string;
  resourceName: string;
  operation: "list" | "read" | "create" | "update" | "delete";
  /** Admission happens before any customer-database work, including a session read. */
  limitAction: "read" | "write";
  sessionToken: string | null;
}): Promise<{ ok: true; access: DataAccess } | { ok: false; response: GatewayResponse }> {
  const resolved = await resolveApp(input.projectId);
  if (resolved.ok === false) return { ok: false, response: resolved.response };
  const app = resolved.app;

  const resource = appDataResourceByName(app.model, input.resourceName);
  if (!resource || !resource.operations.includes(input.operation)) {
    return { ok: false, response: NOT_FOUND };
  }
  const table = appDataTableByName(app.model, resource.table);
  if (!table) return { ok: false, response: NOT_FOUND };

  const limited = await admit(app.projectId, input.limitAction);
  if (limited) return { ok: false, response: limited };

  const user = table.userOwned
    ? await resolveSessionUser(app, input.sessionToken)
    : null;
  if (table.userOwned && !user) {
    return { ok: false, response: UNAUTHORIZED };
  }

  return {
    ok: true,
    access: {
      app,
      resource,
      table,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        required: column.required,
        maxLength: column.maxLength,
      })),
      user,
    },
  };
}

// ── Input coercion ──────────────────────────────────────────────────────────

const INTEGER_PATTERN = /^-?[0-9]{1,15}$/;
const BIGINT_PATTERN = /^-?[0-9]{1,18}$/;
const NUMERIC_PATTERN = /^-?[0-9]{1,18}(?:\.[0-9]{1,6})?$/;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

type CoercedValue = { ok: true; value: unknown } | { ok: false };

function coerceValue(column: DataColumn, raw: unknown): CoercedValue {
  switch (column.type as AppDataColumnType) {
    case "text": {
      if (typeof raw !== "string") return { ok: false };
      if (raw.includes("\u0000")) return { ok: false };
      const limit = column.maxLength ?? 4_000;
      if (raw.length > limit) return { ok: false };
      return { ok: true, value: raw };
    }
    case "integer": {
      if (typeof raw === "number") {
        return Number.isSafeInteger(raw) && Math.abs(raw) <= 9_000_000_000_000
          ? { ok: true, value: raw }
          : { ok: false };
      }
      if (typeof raw === "string" && INTEGER_PATTERN.test(raw)) {
        return { ok: true, value: Number(raw) };
      }
      return { ok: false };
    }
    case "bigint": {
      if (typeof raw === "number" && Number.isSafeInteger(raw)) {
        return { ok: true, value: String(raw) };
      }
      if (typeof raw === "string" && BIGINT_PATTERN.test(raw)) {
        return { ok: true, value: raw };
      }
      return { ok: false };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false };
    }
    case "numeric": {
      const value = typeof raw === "number" ? String(raw) : raw;
      if (typeof value !== "string" || !NUMERIC_PATTERN.test(value)) {
        return { ok: false };
      }
      return { ok: true, value };
    }
    case "timestamptz": {
      if (typeof raw !== "string" || raw.length > 40) return { ok: false };
      const parsed = Date.parse(raw);
      if (!Number.isFinite(parsed)) return { ok: false };
      return { ok: true, value: new Date(parsed).toISOString() };
    }
    case "date": {
      if (typeof raw !== "string" || !DATE_PATTERN.test(raw)) return { ok: false };
      const parsed = Date.parse(`${raw}T00:00:00.000Z`);
      if (!Number.isFinite(parsed)) return { ok: false };
      return { ok: true, value: raw };
    }
    case "jsonb": {
      if (!raw || typeof raw !== "object") return { ok: false };
      let encoded: string;
      try {
        encoded = JSON.stringify(raw);
      } catch {
        return { ok: false };
      }
      if (encoded.length > 8_000) return { ok: false };
      return { ok: true, value: encoded };
    }
    default:
      return { ok: false };
  }
}

function parseWriteBody(
  columns: readonly DataColumn[],
  body: unknown,
  mode: "create" | "update",
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "A JSON object is required." };
  }
  const record = body as Record<string, unknown>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  const values: Record<string, unknown> = {};

  for (const key of Object.keys(record)) {
    const column = byName.get(key);
    if (!column) {
      /**
       * `id`, `owner_id`, `created_at` and any system/undeclared field are not
       * writable. Rejecting is clearer than silently ignoring a client bug.
       */
      return { ok: false, error: "An unknown field was supplied." };
    }
    const raw = record[key];
    if (raw === undefined) continue;
    if (raw === null) {
      if (column.required) return { ok: false, error: "A required field is missing." };
      values[key] = null;
      continue;
    }
    const coerced = coerceValue(column, raw);
    if (!coerced.ok) return { ok: false, error: "A field has an invalid value." };
    values[key] = coerced.value;
  }

  if (mode === "create") {
    for (const column of columns) {
      if (!column.required) continue;
      const value = values[column.name];
      if (value === undefined || value === null) {
        return { ok: false, error: "A required field is missing." };
      }
    }
  } else if (Object.keys(values).length === 0) {
    return { ok: false, error: "No fields to update." };
  }

  return { ok: true, values };
}

// ── Handlers ────────────────────────────────────────────────────────────────

function limitedInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export async function handleDataList(input: {
  projectId: string;
  resourceName: string;
  searchParams: URLSearchParams;
  sessionToken: string | null;
}): Promise<GatewayResponse> {
  const loaded = await loadAccess({
    projectId: input.projectId,
    resourceName: input.resourceName,
    operation: "list",
    limitAction: "read",
    sessionToken: input.sessionToken,
  });
  if (loaded.ok === false) return loaded.response;
  const { app, resource, columns, user } = loaded.access;

  const filters: Record<string, unknown> = {};
  for (const name of resource.filterable) {
    const raw = input.searchParams.get(name);
    if (raw === null) continue;
    const column = columns.find((entry) => entry.name === name);
    if (!column) continue;
    const coerced = coerceValue(column, raw);
    if (!coerced.ok) {
      return gatewayFail(422, "invalid_input", "A filter value is not valid.");
    }
    filters[name] = coerced.value;
  }

  const search = (input.searchParams.get("q") ?? "").trim().slice(0, DATA_SEARCH_MAX_LENGTH);
  const limit = limitedInt(
    input.searchParams.get("limit"),
    DATA_LIST_DEFAULT_LIMIT,
    1,
    DATA_LIST_MAX_LIMIT,
  );
  const offset = limitedInt(input.searchParams.get("offset"), 0, 0, DATA_LIST_MAX_OFFSET);

  const outcome = await withDatabase(app.connectionUri, async (client) => {
    const query = buildListQuery({
      table: resource.table,
      columns,
      userOwned: loaded.access.table.userOwned,
      userId: user?.id ?? null,
      orderBy: resource.orderBy,
      filterable: resource.filterable,
      filters,
      search: search || null,
      limit,
      offset,
    });
    const result = await client.query(query.text, query.values);
    return result.rows as Record<string, unknown>[];
  });
  if (outcome.ok === false) return outcome.response;

  return gatewayOk({
    items: outcome.data,
    limit,
    offset,
    count: outcome.data.length,
  });
}

export async function handleDataRead(input: {
  projectId: string;
  resourceName: string;
  id: string;
  sessionToken: string | null;
}): Promise<GatewayResponse> {
  if (!isUuid(input.id)) return NOT_FOUND;
  const loaded = await loadAccess({
    projectId: input.projectId,
    resourceName: input.resourceName,
    operation: "read",
    limitAction: "read",
    sessionToken: input.sessionToken,
  });
  if (loaded.ok === false) return loaded.response;
  const { app, resource, columns, user, table } = loaded.access;

  const outcome = await withDatabase(app.connectionUri, async (client) => {
    const query = buildReadQuery({
      table: resource.table,
      columns,
      userOwned: table.userOwned,
      userId: user?.id ?? null,
      id: input.id,
    });
    const result = await client.query(query.text, query.values);
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  });
  if (outcome.ok === false) return outcome.response;
  if (!outcome.data) return gatewayFail(404, "not_found", "Not found.");

  return gatewayOk(outcome.data);
}

export async function handleDataCreate(input: {
  projectId: string;
  resourceName: string;
  origin: string | null;
  body: unknown;
  sessionToken: string | null;
}): Promise<GatewayResponse> {
  if (input.origin !== null && !originAllowed(input.projectId, input.origin)) {
    return gatewayFail(403, "origin_not_allowed", "This origin is not allowed.");
  }
  const loaded = await loadAccess({
    projectId: input.projectId,
    resourceName: input.resourceName,
    operation: "create",
    limitAction: "write",
    sessionToken: input.sessionToken,
  });
  if (loaded.ok === false) return loaded.response;
  const { app, resource, columns, user, table } = loaded.access;
  if (!table.userOwned || !user) {
    return gatewayFail(403, "forbidden", "This resource does not accept writes.");
  }

  const parsed = parseWriteBody(columns, input.body, "create");
  if (parsed.ok === false) return gatewayFail(422, "invalid_input", parsed.error);

  const outcome = await withDatabase(app.connectionUri, async (client) => {
    const query = buildCreateQuery({
      table: resource.table,
      columns,
      userOwned: true,
      userId: user.id,
      values: parsed.values,
    });
    const result = await client.query(query.text, query.values);
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  });
  if (outcome.ok === false) return outcome.response;
  if (!outcome.data) return gatewayFail(500, "error", "The record could not be created.");

  return gatewayOk(outcome.data, 201);
}

export async function handleDataUpdate(input: {
  projectId: string;
  resourceName: string;
  id: string;
  origin: string | null;
  body: unknown;
  sessionToken: string | null;
}): Promise<GatewayResponse> {
  if (!isUuid(input.id)) return NOT_FOUND;
  if (input.origin !== null && !originAllowed(input.projectId, input.origin)) {
    return gatewayFail(403, "origin_not_allowed", "This origin is not allowed.");
  }
  const loaded = await loadAccess({
    projectId: input.projectId,
    resourceName: input.resourceName,
    operation: "update",
    limitAction: "write",
    sessionToken: input.sessionToken,
  });
  if (loaded.ok === false) return loaded.response;
  const { app, resource, columns, user, table } = loaded.access;
  if (!table.userOwned || !user) {
    return gatewayFail(403, "forbidden", "This resource does not accept writes.");
  }

  const parsed = parseWriteBody(columns, input.body, "update");
  if (parsed.ok === false) return gatewayFail(422, "invalid_input", parsed.error);

  const outcome = await withDatabase(app.connectionUri, async (client) => {
    const query = buildUpdateQuery({
      table: resource.table,
      columns,
      userOwned: true,
      userId: user.id,
      values: parsed.values,
      id: input.id,
    });
    const result = await client.query(query.text, query.values);
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  });
  if (outcome.ok === false) return outcome.response;
  if (!outcome.data) return gatewayFail(404, "not_found", "Not found.");

  return gatewayOk(outcome.data);
}

export async function handleDataDelete(input: {
  projectId: string;
  resourceName: string;
  id: string;
  origin: string | null;
  sessionToken: string | null;
}): Promise<GatewayResponse> {
  if (!isUuid(input.id)) return NOT_FOUND;
  if (input.origin !== null && !originAllowed(input.projectId, input.origin)) {
    return gatewayFail(403, "origin_not_allowed", "This origin is not allowed.");
  }
  const loaded = await loadAccess({
    projectId: input.projectId,
    resourceName: input.resourceName,
    operation: "delete",
    limitAction: "write",
    sessionToken: input.sessionToken,
  });
  if (loaded.ok === false) return loaded.response;
  const { app, resource, columns, user, table } = loaded.access;
  if (!table.userOwned || !user) {
    return gatewayFail(403, "forbidden", "This resource does not accept writes.");
  }

  const outcome = await withDatabase(app.connectionUri, async (client) => {
    const query = buildDeleteQuery({
      table: resource.table,
      columns,
      userOwned: true,
      userId: user.id,
      id: input.id,
    });
    const result = await client.query(query.text, query.values);
    return result.rowCount ?? 0;
  });
  if (outcome.ok === false) return outcome.response;
  if (outcome.data === 0) return gatewayFail(404, "not_found", "Not found.");

  return gatewayOk({ deleted: true });
}

/** Exposed for the planner prompt and tests: resources are declared, not guessed. */
export function dataResourceSummary(model: AppDataModel): string[] {
  return model.resources.map(
    (resource) =>
      `${resource.name} (${resource.ownership}; ${resource.operations.join(", ")})`,
  );
}
