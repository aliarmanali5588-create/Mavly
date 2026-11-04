/**
 * ═══ PUBLISHED VERSIONS — PERSISTENCE ═══════════════════════════════════════
 *
 * Owner-scoped writes go through the caller's RLS client, exactly like
 * `project_files`. Public reads go through the cookie-free anon client and the
 * two published-only RPCs from migration 14.
 *
 * ⚠️ THE WRITE ORDER IS THE SAFETY PROPERTY. A version is inserted as `draft`,
 * its files are written, and ONLY THEN is `activate_shared_publication` called.
 * A failure anywhere before activation leaves the previously active version
 * untouched and publicly resolvable, so a failed republish never takes the site
 * down or publishes a partial artifact.
 */

import { createHash } from "node:crypto";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabasePublicClient } from "@/lib/supabase/public";

import {
  SHARED_HOSTING_INSTALL_MESSAGE,
  isMissingDatabaseObject,
} from "./migration-requirement";
import { isSafePublishedSegment } from "./published-version";

export type HostingStoreFailure = { ok: false; error: string; code?: string };
export type HostingStoreResult<T> = { ok: true; data: T } | HostingStoreFailure;

export function isHostingStoreFailure<T>(
  result: HostingStoreResult<T>,
): result is HostingStoreFailure {
  return result.ok === false;
}

export interface PublishedFileInput {
  path: string;
  content: string;
}

export interface PublishedFileRow extends PublishedFileInput {
  contentType: string;
  sha256: string;
  sizeBytes: number;
}

export interface PreparedPublishedFiles {
  rows: PublishedFileRow[];
  contentHash: string;
  fileCount: number;
  byteCount: number;
}

export interface PublishedVersionRecord {
  id: string;
  contentHash: string;
  fileCount: number;
  byteCount: number;
}

export interface ResolvedPublishedTenant {
  projectId: string;
  versionId: string;
  publishedAt: string | null;
  contentHash: string;
  entryPath: string;
  spaFallback: boolean;
}

export interface StoredPublishedFile {
  path: string;
  content: string;
  contentType: string;
  sha256: string;
}

/** Same shape the atomic activation RPC uses: path NUL hash NUL … sorted. */
export function publishedContentHash(
  files: readonly { path: string; sha256: string }[],
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.sha256);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/**
 * Validate, hash and measure the exact file set a publish will release.
 *
 * A path that escapes the version root is refused BEFORE any row is written.
 * `staticPublishFiles` already produces safe relative paths; this is the second,
 * independent check at the storage boundary.
 */
export function preparePublishedFiles(
  files: readonly PublishedFileInput[],
  contentTypeFor: (path: string) => string,
): HostingStoreResult<PreparedPublishedFiles> {
  if (files.length === 0) {
    return { ok: false, error: "This publish has no files.", code: "VALIDATION" };
  }

  const rows: PublishedFileRow[] = [];
  const seen = new Set<string>();
  let byteCount = 0;

  for (const file of files) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("\\")) {
      return { ok: false, error: "Unsafe published file path.", code: "VALIDATION" };
    }
    const segments = file.path.split("/");
    if (segments.length === 0 || !segments.every(isSafePublishedSegment)) {
      return { ok: false, error: "Unsafe published file path.", code: "VALIDATION" };
    }
    if (seen.has(file.path)) {
      return { ok: false, error: "Duplicate published file path.", code: "VALIDATION" };
    }
    seen.add(file.path);

    const sizeBytes = Buffer.byteLength(file.content, "utf8");
    byteCount += sizeBytes;
    rows.push({
      path: file.path,
      content: file.content,
      contentType: contentTypeFor(file.path),
      sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
      sizeBytes,
    });
  }

  return {
    ok: true,
    data: {
      rows,
      contentHash: publishedContentHash(rows),
      fileCount: rows.length,
      byteCount,
    },
  };
}

/**
 * Insert bounds. The row cap keeps one PostgREST statement small, and the byte
 * cap keeps a publish of a few large documents from exceeding the API gateway's
 * request-body limit. The whole artifact is still capped at 8 MB by the caller.
 */
const FILE_INSERT_CHUNK = 250;
const FILE_INSERT_BYTES = 512 * 1024;

function fileInsertChunks(
  rows: readonly { size_bytes: number }[],
): { start: number; end: number }[] {
  const chunks: { start: number; end: number }[] = [];
  let start = 0;
  let bytes = 0;

  for (let index = 0; index < rows.length; index++) {
    const size = Math.max(0, Number(rows[index].size_bytes) || 0);
    const wouldExceed =
      index > start && (index - start >= FILE_INSERT_CHUNK || bytes + size > FILE_INSERT_BYTES);
    if (wouldExceed) {
      chunks.push({ start, end: index });
      start = index;
      bytes = 0;
    }
    bytes += size;
  }

  if (start < rows.length) chunks.push({ start, end: rows.length });
  return chunks;
}

/**
 * Insert a draft version and its files. Never activates it.
 *
 * A failure marks the version `failed` (best effort) so an orphaned draft can
 * never be mistaken for a publishable artifact.
 */
export async function createPublishedVersion(input: {
  projectId: string;
  prepared: PreparedPublishedFiles;
  entryPath: string;
  spaFallback: boolean;
}): Promise<HostingStoreResult<PublishedVersionRecord>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
    .from("project_published_versions")
    .insert({
      project_id: input.projectId,
      status: "draft",
      content_hash: input.prepared.contentHash,
      entry_path: input.entryPath,
      spa_fallback: input.spaFallback,
      file_count: input.prepared.fileCount,
      byte_count: input.prepared.byteCount,
    })
    .select("id")
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: error?.message ?? "Could not record the published version.",
      code: error?.code,
    };
  }

  const versionId = String((data as Record<string, unknown>).id);
  const rows = input.prepared.rows.map((row) => ({
    version_id: versionId,
    path: row.path,
    content: row.content,
    content_type: row.contentType,
    sha256: row.sha256,
    size_bytes: row.sizeBytes,
  }));

  for (const chunk of fileInsertChunks(rows)) {
    const { error: fileError } = await supabase
      .from("project_published_files")
      .insert(rows.slice(chunk.start, chunk.end));
    if (fileError) {
      await markPublishedVersionFailed(versionId);
      return {
        ok: false,
        error: fileError.message,
        code: fileError.code,
      };
    }
  }

  return {
    ok: true,
    data: {
      id: versionId,
      contentHash: input.prepared.contentHash,
      fileCount: input.prepared.fileCount,
      byteCount: input.prepared.byteCount,
    },
  };
}

/**
 * ═══ PREFLIGHT — IS THE ATTEMPT-STATE MIGRATION INSTALLED? ═══════════════════
 *
 * The publish path calls this once, before it writes any row. It is deliberately
 * an RPC: a missing function is the unambiguous signal that the database has not
 * been migrated. A connection/timeout failure is NOT treated as a missing
 * migration — only recognised missing-object errors are.
 *
 * This is one extra round trip per shared publish (not per tenant request).
 */
export async function readSharedHostingSchemaVersion(): Promise<HostingStoreResult<number>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase.rpc("shared_hosting_schema_version");

  if (!error) {
    const version = typeof data === "number" ? data : Number(data);
    return { ok: true, data: Number.isFinite(version) ? version : 0 };
  }

  if (isMissingDatabaseObject({ code: error.code, message: error.message })) {
    return {
      ok: false,
      error: SHARED_HOSTING_INSTALL_MESSAGE,
      code: "MIGRATION_REQUIRED",
    };
  }
  return { ok: false, error: error.message, code: error.code };
}

/**
 * Activate a shared publication atomically (migration 15).
 *
 * One SQL transaction supersedes the previous active version, activates the new
 * one, and records the successful attempt (`status = 'ready'`, `active_version_id`,
 * hostname, `mavly_domain_status = 'pending'`). It never stores `verified`; the
 * caller probes the runtime after this returns.
 *
 * A failure before this call leaves the previous live version untouched.
 */
export async function activateSharedPublication(
  projectId: string,
  versionId: string,
  hostname: string,
): Promise<HostingStoreResult<void>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { error } = await supabase.rpc("activate_shared_publication", {
    p_project_id: projectId,
    p_version_id: versionId,
    p_hostname: hostname,
  });

  if (!error) return { ok: true, data: undefined };

  const message = error.message ?? "activation failed";
  if (isMissingDatabaseObject({ code: error.code, message })) {
    return {
      ok: false,
      error:
        "Shared hosting attempt state is not installed. Apply migration 15_shared_hosting_attempt_state.sql.",
      code: "MIGRATION_REQUIRED",
    };
  }
  if (error.code === "42501" || /FORBIDDEN/i.test(message)) {
    return { ok: false, error: "You don't have access to this project.", code: "FORBIDDEN" };
  }
  if (error.code === "P0002" || /VERSION_NOT_FOUND/i.test(message)) {
    return { ok: false, error: "The published version could not be found.", code: "NOT_FOUND" };
  }
  if (error.code === "22023" || /INVALID_(HOSTNAME|ARGUMENT)/i.test(message)) {
    return { ok: false, error: "This project cannot be published on a Mavly address.", code: "VALIDATION" };
  }
  return { ok: false, error: message, code: error.code };
}

/**
 * @deprecated Kept only because migration 14 still defines the RPC. Do not use it
 * for a shared publish: it does not record the successful attempt (hostname,
 * `status = 'ready'`, `last_published_at`) and does not create the migration-15
 * preflight contract. `activateSharedPublication` is the only supported path.
 */
export async function activatePublishedVersion(
  projectId: string,
  versionId: string,
): Promise<HostingStoreResult<void>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { error } = await supabase.rpc("activate_published_version", {
    p_project_id: projectId,
    p_version_id: versionId,
  });

  if (!error) return { ok: true, data: undefined };

  const message = error.message ?? "activation failed";
  if (/function .*does not exist|Could not find the function/i.test(message) ||
      error.code === "PGRST202" || error.code === "42883") {
    return {
      ok: false,
      error: "Published-version storage is not installed. Apply migration 14.",
      code: "MIGRATION_REQUIRED",
    };
  }
  if (error.code === "42501" || /FORBIDDEN/i.test(message)) {
    return { ok: false, error: "You don't have access to this project.", code: "FORBIDDEN" };
  }
  if (error.code === "P0002" || /VERSION_NOT_FOUND/i.test(message)) {
    return { ok: false, error: "The published version could not be found.", code: "NOT_FOUND" };
  }
  return { ok: false, error: message, code: error.code };
}

export async function deactivatePublishedVersion(
  projectId: string,
): Promise<HostingStoreResult<void>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { error } = await supabase.rpc("deactivate_published_version", {
    p_project_id: projectId,
  });

  if (!error) return { ok: true, data: undefined };

  const message = error.message ?? "deactivation failed";
  if (/function .*does not exist|Could not find the function/i.test(message) ||
      error.code === "PGRST202" || error.code === "42883") {
    return {
      ok: false,
      error: "Published-version storage is not installed. Apply migration 14.",
      code: "MIGRATION_REQUIRED",
    };
  }
  return { ok: false, error: message, code: error.code };
}

/**
 * Best effort: never turns a failed publish into a misleading activation.
 *
 * The metadata row is kept as `failed` for audit, but its bytes are removed: a
 * failed attempt must not consume the project's storage, and it can never be
 * activated because the status is no longer `draft`.
 */
export async function markPublishedVersionFailed(versionId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return;

  const { error } = await supabase
    .from("project_published_versions")
    .update({ status: "failed" })
    .eq("id", versionId)
    .eq("status", "draft");
  if (error) {
    console.error("[hosting] could not mark version failed:", error.message);
    return;
  }

  const { error: cleanupError } = await supabase
    .from("project_published_files")
    .delete()
    .eq("version_id", versionId);
  if (cleanupError) {
    console.error("[hosting] could not clear a failed version's files:", cleanupError.message);
  }
}

/**
 * Retention: keep the most recent `keep` superseded versions per project and
 * delete the rest. The active version is never touched, and a failed cleanup is
 * logged rather than failing an otherwise successful publish.
 */
export async function pruneSupersededVersions(
  projectId: string,
  keep: number,
): Promise<number> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return 0;

  const { data, error } = await supabase
    .from("project_published_versions")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "superseded")
    .order("created_at", { ascending: false })
    .range(Math.max(0, keep), 999);

  if (error) {
    console.error("[hosting] could not list versions for retention:", error.message);
    return 0;
  }

  const ids = ((data ?? []) as Record<string, unknown>[])
    .map((row) => (typeof row.id === "string" ? row.id : ""))
    .filter(Boolean);
  if (ids.length === 0) return 0;

  const { error: deleteError } = await supabase
    .from("project_published_versions")
    .delete()
    .in("id", ids);

  if (deleteError) {
    console.error("[hosting] could not prune old versions:", deleteError.message);
    return 0;
  }
  return ids.length;
}

// ═══ PUBLIC READ CONTRACT ═══════════════════════════════════════════════════
// Only these two functions talk to the tenant runtime. They never accept a
// project id from the caller.

export async function resolvePublishedTenant(
  hostname: string,
): Promise<HostingStoreResult<ResolvedPublishedTenant | null>> {
  const supabase = createSupabasePublicClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase.rpc("resolve_published_tenant", {
    p_hostname: hostname,
  });

  if (error) {
    return { ok: false, error: error.message, code: error.code };
  }

  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || typeof row.project_id !== "string" || typeof row.version_id !== "string") {
    return { ok: true, data: null };
  }

  return {
    ok: true,
    data: {
      projectId: row.project_id,
      versionId: row.version_id,
      publishedAt: typeof row.published_at === "string" ? row.published_at : null,
      contentHash: typeof row.content_hash === "string" ? row.content_hash : "",
      entryPath: typeof row.entry_path === "string" ? row.entry_path : "index.html",
      spaFallback: row.spa_fallback === true,
    },
  };
}

export async function readPublishedFile(
  hostname: string,
  versionId: string,
  path: string,
): Promise<HostingStoreResult<StoredPublishedFile | null>> {
  const supabase = createSupabasePublicClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase.rpc("read_published_file", {
    p_hostname: hostname,
    p_version_id: versionId,
    p_path: path,
  });

  if (error) {
    return { ok: false, error: error.message, code: error.code };
  }

  return normalizePublishedFileRow(data);
}

/**
 * ═══ DOMAIN HOSTNAMES (aliases + customer-owned) ════════════════════════════
 *
 * `resolve_published_tenant` only understands `<project-id>.mavly.xyz`. A Mavly
 * alias or a customer hostname resolves through `resolve_public_domain`, which
 * additionally requires the row to be `active` with ready DNS and an active
 * certificate. Both halves are needed: the resolver proves which version to
 * serve, and the read RPC repeats the same gate before returning a byte.
 *
 * ⚠️ THE HOSTNAME IS STILL THE ONLY IDENTITY. Nothing here accepts a project id
 * from the caller, and an inactive/unverified/disabled row resolves to `null`,
 * which the runtime answers as 404 rather than falling back to a default site.
 */
export async function resolvePublicDomain(
  hostname: string,
): Promise<HostingStoreResult<ResolvedPublishedTenant | null>> {
  const supabase = createSupabasePublicClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase.rpc("resolve_public_domain", {
    p_hostname: hostname,
  });

  if (error) {
    return { ok: false, error: error.message, code: error.code };
  }

  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (!record) return { ok: true, data: null };
  if (typeof record.projectId !== "string" || typeof record.versionId !== "string") {
    return { ok: true, data: null };
  }

  return {
    ok: true,
    data: {
      projectId: record.projectId,
      versionId: record.versionId,
      publishedAt: null,
      contentHash: "",
      entryPath: typeof record.entryPath === "string" ? record.entryPath : "index.html",
      spaFallback: record.spaFallback === true,
    },
  };
}

export async function readPublicDomainFile(
  hostname: string,
  versionId: string,
  path: string,
): Promise<HostingStoreResult<StoredPublishedFile | null>> {
  const supabase = createSupabasePublicClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase.rpc("read_public_domain_file", {
    p_hostname: hostname,
    p_version_id: versionId,
    p_path: path,
  });

  if (error) {
    return { ok: false, error: error.message, code: error.code };
  }

  return normalizePublishedFileRow(data);
}

function normalizePublishedFileRow(
  data: unknown,
): HostingStoreResult<StoredPublishedFile | null> {
  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || typeof row.content !== "string" || typeof row.path !== "string") {
    return { ok: true, data: null };
  }

  return {
    ok: true,
    data: {
      path: row.path,
      content: row.content,
      contentType:
        typeof row.content_type === "string"
          ? row.content_type
          : "application/octet-stream",
      sha256: typeof row.sha256 === "string" ? row.sha256 : "",
    },
  };
}
