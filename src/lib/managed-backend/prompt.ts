/**
 * ═══ SERVER-AUTHORED CONTRACT FOR THE GENERATED APP ════════════════════════
 *
 * The model never receives a connection string, a credential or free-form SQL.
 * It receives a fixed description of the data gateway that already exists, and
 * is told to build against exactly that. The text is generated from the
 * validated `AppDataModel`, so it cannot name a table or endpoint that was not
 * applied to the database.
 *
 * Pure: no I/O.
 */

import type { AppDataModel } from "./model";

function columnType(column: AppDataModel["tables"][number]["columns"][number]): string {
  const parts: string[] = [column.type];
  if (column.required) parts.push("required");
  if (column.type === "text" && column.maxLength) parts.push(`max ${column.maxLength}`);
  if (column.unique) parts.push("unique");
  return parts.join(", ");
}

export function dataApiBase(origin: string, projectId: string): string {
  return `${origin.replace(/\/+$/, "")}/api/app/v1/apps/${projectId}`;
}

export function dataApiContractBlock(input: {
  origin: string;
  projectId: string;
  model: AppDataModel;
}): string {
  const base = dataApiBase(input.origin, input.projectId);
  const lines: string[] = [
    "",
    "Managed application backend (server-controlled; this is the only data layer):",
    `- Data API base: ${base}`,
    "- Send every data request to this API. Do NOT use a database driver, do NOT read DATABASE_URL, do NOT connect to Postgres, do NOT add a migration runner and do NOT invent tables, columns or endpoints. Only the resources below exist.",
    "- Never put a database credential in client code. There is none to put there.",
  ];

  if (input.model.auth.required) {
    lines.push(
      "- End-user accounts (this app's own users, unrelated to any platform account):",
      `  POST ${base}/auth/signup  { "email": string, "password": string }`,
      `  POST ${base}/auth/login   { "email": string, "password": string }`,
      `  POST ${base}/auth/logout`,
      `  GET  ${base}/auth/session`,
      "- A successful signup/login answers `{ ok: true, data: { user, token, expiresIn } }`. Keep the token in memory and send `Authorization: Bearer <token>` on data requests. The API also sets an HttpOnly cookie for same-site hosting; `credentials: \"include\"` is harmless.",
      "- Never store passwords, never mint your own session tokens, never treat a client-supplied user id as authorization, and never show a signed-in UI before the session endpoint confirms it.",
    );
  } else {
    lines.push(
      "- This app has no end-user accounts. Do not generate a login screen, a signup form or a password field.",
    );
  }

  for (const resource of input.model.resources) {
    const table = input.model.tables.find((entry) => entry.name === resource.table);
    if (!table) continue;
    lines.push(
      `- Resource "${resource.name}" (${resource.ownership === "user" ? "rows belong to the signed-in user" : "public, read-only"}):`,
    );
    if (resource.operations.includes("list")) {
      const filters = resource.filterable.length
        ? `; filterable: ${resource.filterable.join(", ")}; also ?q= for text search`
        : "";
      lines.push(
        `  GET ${base}/data/${resource.name}?limit=20&offset=0${filters}; ordered by ${resource.orderBy.column} ${resource.orderBy.direction}`,
      );
    }
    if (resource.operations.includes("create")) lines.push(`  POST ${base}/data/${resource.name}`);
    if (resource.operations.includes("read")) lines.push(`  GET ${base}/data/${resource.name}/{id}`);
    if (resource.operations.includes("update")) lines.push(`  PATCH ${base}/data/${resource.name}/{id}`);
    if (resource.operations.includes("delete")) lines.push(`  DELETE ${base}/data/${resource.name}/{id}`);
    lines.push(
      `  fields: ${table.columns.map((column) => `${column.name} (${columnType(column)})`).join(", ")}`,
    );
  }

  lines.push(
    "Response shapes:",
    "- list → `{ ok: true, data: { items: [...], limit, offset, count } }`",
    "- one record → `{ ok: true, data: { id, ...fields, created_at, updated_at } }`",
    "- failure → `{ ok: false, code, error }`; render the error and keep the user's input.",
    "- `id` and `created_at` are server-owned; never send them in a create or update body.",
    "",
    "Preview requirement: preview.html is a static design prototype inside an opaque sandbox. It must stay self-contained (no fetch, no cookies) and must be labelled as a prototype; the real data layer is the API above.",
  );

  return lines.join("\n");
}

/** The truthful completion summary for a configured backend. */
export function managedBackendReadySummary(input: {
  model: AppDataModel;
  tableCount: number;
  origin: string;
  projectId: string;
}): string {
  const base = dataApiBase(input.origin, input.projectId);
  return [
    `Managed backend ready: ${input.tableCount} table${input.tableCount === 1 ? "" : "s"} created and verified in the project's Neon database.${
      input.model.auth.required
        ? " End-user registration, sign-in and sessions are available through the app's own auth endpoints."
        : ""
    }`,
    `The generated app talks to the data API at ${base}; no database credential is included in the project files.`,
    "Live end-to-end use still requires a hosting runtime for the generated app; a static preview cannot execute server code.",
  ].join(" ");
}
