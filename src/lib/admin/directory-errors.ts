export type AdminDirectoryName = "user" | "project";

export interface AdminDirectoryFailure {
  status: number;
  code: string;
  message: string;
}

export function adminDirectoryFailure(
  directory: AdminDirectoryName,
  databaseCode: string | null | undefined
): AdminDirectoryFailure {
  const label = directory === "project" ? "project" : "user";
  const normalizedCode = databaseCode && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(databaseCode)
    ? databaseCode
    : null;

  if (
    normalizedCode === "PGRST202"
    || normalizedCode === "PGRST203"
    || normalizedCode === "42883"
  ) {
    return {
      status: 503,
      code: `${directory.toUpperCase()}_DIRECTORY_RPC_UNAVAILABLE`,
      message: `The admin ${label} directory RPC is not available. Check that migration 41 is deployed with the expected function signature and that the Supabase API schema cache is current.`,
    };
  }

  if (
    normalizedCode === "PGRST204"
    || normalizedCode === "PGRST205"
    || normalizedCode === "42P01"
    || normalizedCode === "42703"
  ) {
    return {
      status: 503,
      code: `${directory.toUpperCase()}_DIRECTORY_SCHEMA_MISMATCH`,
      message: `The deployed database is missing a table or column required by the admin ${label} directory. Check its prerequisite migrations and deployed schema; applying migration 41 again may not resolve this.`,
    };
  }

  if (normalizedCode === "42501") {
    return {
      status: 403,
      code: "ADMIN_ACCESS_DENIED",
      message: "The database denied access to the admin directory.",
    };
  }

  if (normalizedCode === "57014") {
    return {
      status: 504,
      code: `${directory.toUpperCase()}_DIRECTORY_QUERY_TIMEOUT`,
      message: `The admin ${label} directory query was canceled by the database.`,
    };
  }

  return {
    status: 503,
    code: `${directory.toUpperCase()}_DIRECTORY_QUERY_FAILED`,
    message: normalizedCode
      ? `The admin ${label} directory query failed in the database (${normalizedCode}).`
      : `The admin ${label} directory query failed in the database.`,
  };
}
