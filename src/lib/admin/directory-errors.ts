export type AdminDirectoryName = "user" | "project";

export interface AdminDirectoryFailure {
  status: number;
  code: string;
  message: string;
  /** The raw database code, when one was supplied. Never invented. */
  databaseCode: string | null;
}

/** Postgres SQLSTATEs and PostgREST codes this module can name precisely. */
const KNOWN_CODES: Record<string, { status: number; code: string; message: string }> = {
  // ── The RPC itself cannot be resolved ────────────────────────────────────
  PGRST202: {
    status: 503,
    code: "DIRECTORY_RPC_NOT_FOUND",
    message:
      "PostgREST could not find the directory function with these arguments. The function is missing, or its parameter list differs from the call.",
  },
  PGRST203: {
    status: 503,
    code: "DIRECTORY_RPC_AMBIGUOUS",
    message:
      "PostgREST found more than one directory function matching these arguments. An older overload is still installed alongside the current one.",
  },
  "42883": {
    status: 503,
    code: "DIRECTORY_RPC_NOT_FOUND",
    message:
      "PostgreSQL reports the directory function does not exist with this signature. The migration that defines it has not been applied, or an older signature is installed.",
  },

  // ── A relation or column the query needs is absent ───────────────────────
  "42P01": {
    status: 503,
    code: "DIRECTORY_TABLE_MISSING",
    message:
      "A table the directory query reads does not exist in the deployed database. This is a missing prerequisite migration, not a fault in the directory itself.",
  },
  "42703": {
    status: 503,
    code: "DIRECTORY_COLUMN_MISSING",
    message:
      "A column the directory query reads does not exist on the deployed table. A prerequisite migration added it; the deployed schema is behind that migration.",
  },
  PGRST204: {
    status: 503,
    code: "DIRECTORY_COLUMN_MISSING",
    message:
      "PostgREST could not find a column the directory response requires. The deployed schema is behind the migration that adds it.",
  },
  PGRST205: {
    status: 503,
    code: "DIRECTORY_TABLE_MISSING",
    message:
      "PostgREST could not find a table the directory reads. The deployed schema is missing that migration.",
  },

  // ── Permission and policy ────────────────────────────────────────────────
  "42501": {
    status: 403,
    code: "ADMIN_ACCESS_DENIED",
    message:
      "The database denied the directory query. The caller is not authorized, or EXECUTE on the function is not granted to the authenticated role.",
  },

  // ── Execution ────────────────────────────────────────────────────────────
  "57014": {
    status: 504,
    code: "DIRECTORY_QUERY_TIMEOUT",
    message: "The database canceled the directory query (statement timeout).",
  },
  "22023": {
    status: 400,
    code: "DIRECTORY_INVALID_ARGUMENT",
    message: "The directory rejected a filter argument as invalid.",
  },
};

/**
 * ═══ A TRUTHFUL DIRECTORY FAILURE ═══════════════════════════════════════════
 *
 * ⚠️ THIS USED TO GUESS. Four distinct database codes (`PGRST204`, `PGRST205`,
 * `42P01`, `42703`) were collapsed into one message claiming a missing table or
 * column, and it told the operator that "applying migration 41 again may not
 * resolve this" — advice that is only true for some of those codes and
 * actively misleading for the rest.
 *
 * A directory failure now reports the code it actually received, the specific
 * condition that code means, and the diagnostic that identifies the real cause.
 * When the code is not one this module knows, it says so and shows the raw code
 * instead of inventing an explanation.
 */
export function adminDirectoryFailure(
  directory: AdminDirectoryName,
  databaseCode: string | null | undefined
): AdminDirectoryFailure {
  const label = directory === "project" ? "project" : "user";
  const normalizedCode =
    databaseCode && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(databaseCode) ? databaseCode : null;

  if (!normalizedCode) {
    return {
      status: 503,
      code: `${directory.toUpperCase()}_DIRECTORY_QUERY_FAILED`,
      message: `The admin ${label} directory query failed in the database and no database error code was returned, so the cause is not identified. Check the server log for this request.`,
      databaseCode: null,
    };
  }

  const known = KNOWN_CODES[normalizedCode];
  if (known) {
    return {
      status: known.status,
      code: known.code,
      message: `${known.message} (database code ${normalizedCode})`,
      databaseCode: normalizedCode,
    };
  }

  return {
    status: 503,
    code: `${directory.toUpperCase()}_DIRECTORY_QUERY_FAILED`,
    message: `The admin ${label} directory query failed in the database with code ${normalizedCode}. This code has no specific explanation here; check the server log for the full error.`,
    databaseCode: normalizedCode,
  };
}
