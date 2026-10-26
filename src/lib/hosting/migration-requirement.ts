/**
 * ═══ MISSING SHARED-HOSTING SCHEMA → AN ACTIONABLE MIGRATION REQUIREMENT ═════
 *
 * Shared hosting depends on two migrations:
 *
 *   14_shared_hosting.sql              published versions/files + the RPC surface;
 *   15_shared_hosting_attempt_state.sql separate live serving state from the
 *                                      latest publish attempt.
 *
 * A deployment that reaches the publish route before those migrations are applied
 * must fail closed with `503 BACKEND_NOT_CONFIGURED` naming the prerequisite,
 * never with a generic 500 or a fabricated success.
 *
 * ⚠️ ONLY MISSING SHARED-HOSTING OBJECTS QUALIFY. A connection failure, a timeout
 * or an unrelated missing relation is NOT a missing migration and must stay a
 * server error. The message must name one of the objects this subsystem owns.
 */

export interface DatabaseFailureLike {
  code?: string | null;
  message?: string | null;
}

export type SharedHostingMigration =
  | "14_shared_hosting.sql"
  | "15_shared_hosting_attempt_state.sql";

/**
 * Objects introduced by the two migrations. Matching the message against this
 * list is what keeps an unrelated `42P01`/`42703` from being mislabelled.
 */
const SHARED_HOSTING_OBJECTS = [
  "active_version_id",
  "project_published_versions",
  "project_published_files",
  "resolve_published_tenant",
  "read_published_file",
  "activate_published_version",
  "activate_shared_publication",
  "deactivate_published_version",
  "shared_hosting_schema_version",
] as const;

/** PostgreSQL / PostgREST codes that mean "this object is not in the schema". */
const MISSING_OBJECT_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42883", // undefined_function
  "PGRST202", // PostgREST could not find the function
  "PGRST204", // PostgREST could not find the column
  "PGRST205", // PostgREST could not find the table
]);

export function isMissingDatabaseObject(failure: DatabaseFailureLike): boolean {
  const code = (failure.code ?? "").trim().toUpperCase();
  const message = (failure.message ?? "").toLowerCase();

  const looksMissing =
    MISSING_OBJECT_CODES.has(code) ||
    message.includes("does not exist") ||
    message.includes("could not find the function") ||
    message.includes("could not find the table") ||
    message.includes("could not find the column") ||
    message.includes("schema cache");

  if (!looksMissing) return false;
  return SHARED_HOSTING_OBJECTS.some((name) => message.includes(name.toLowerCase()));
}

/**
 * Which migration is missing, when the error identifies one.
 *
 * The attempt-state marker/function belongs to migration 15; every published
 * version table, the deployment link and the migration-14 RPCs belong to 14.
 * `null` means "not a recognisable missing shared-hosting object" and must not be
 * translated into a migration error.
 */
export function requiredMigrationFor(
  failure: DatabaseFailureLike,
): SharedHostingMigration | null {
  if (!isMissingDatabaseObject(failure)) return null;

  const message = (failure.message ?? "").toLowerCase();
  if (
    message.includes("activate_shared_publication") ||
    message.includes("shared_hosting_schema_version")
  ) {
    return "15_shared_hosting_attempt_state.sql";
  }
  return "14_shared_hosting.sql";
}

export function migrationRequirementMessage(migration: SharedHostingMigration): string {
  return `Shared hosting requires ${migration}. Apply it, then try again.`;
}

/**
 * The preflight cannot always tell WHICH migration is absent (the marker itself
 * arrives with 15). It therefore names both, in the order they must be applied.
 */
export const SHARED_HOSTING_INSTALL_MESSAGE =
  "Shared hosting is not installed. Apply migration 14_shared_hosting.sql, then 15_shared_hosting_attempt_state.sql.";
