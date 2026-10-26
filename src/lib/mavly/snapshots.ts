/**
 * ═══ RESTORE POINTS — Mavly's own source recovery ═══════════════════════════
 *
 * A snapshot is a COMPLETE, restorable copy of a project's source files. It is
 * what the chat's "Restore Code" action restores, and it works with no GitHub
 * connection, no deployment and no external service: the content lives in
 * Supabase, next to the project it belongs to.
 *
 * ⚠️ WHAT IS STORED. The full text of every project file, one row per path.
 * A diff could not be replayed onto a state that has since diverged; a file set
 * can. That is why this is not a patch table.
 *
 * ⚠️ WHAT IS NOT STORED. `project_files` never contains an environment file or
 * a credential: the agent's path sanitiser refuses `.env*`, private keys and
 * dependency directories before anything is written (`sanitizeProjectPath`), and
 * the file writer refuses unsafe paths too. A snapshot is a copy of that table,
 * so a snapshot cannot leak a secret that the project does not already contain.
 *
 * ⚠️ EVERYTHING HERE USES THE CALLER'S RLS-SCOPED CLIENT. There is no
 * service-role path: `public.project_snapshots` inherits ownership from
 * `public.projects`, exactly like `project_files` and `project_messages`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";

import { hashSource } from "./source-hash";

export { hashSource };

/** One file of a project, as stored in `project_files` and in a snapshot. */
export interface SnapshotFile {
  path: string;
  content: string;
}

export type SnapshotKind =
  | "baseline"
  | "result"
  | "pre_restore"
  | "import"
  | "manual"
  | "repair";

export const SNAPSHOT_KINDS: readonly SnapshotKind[] = [
  "baseline",
  "result",
  "pre_restore",
  "import",
  "manual",
  "repair",
];

/** The metadata of one snapshot. It never carries file content. */
export interface SnapshotSummary {
  id: string;
  projectId: string;
  userId: string;
  runId: string | null;
  kind: SnapshotKind;
  description: string;
  sourceHash: string;
  fileCount: number;
  changedPaths: string[];
  status: "ready" | "failed";
  restoredAt: string | null;
  restoreOfSnapshotId: string | null;
  createdAt: string;
}

export interface SnapshotWithFiles extends SnapshotSummary {
  files: SnapshotFile[];
}

export type SnapshotFailureCode =
  | "store_unavailable"
  | "snapshot_missing"
  | "snapshot_not_ready"
  | "source_conflict";

export type SnapshotResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: SnapshotFailureCode };

export function isSnapshotFailure<T>(
  result: SnapshotResult<T>,
): result is { ok: false; error: string; code: SnapshotFailureCode } {
  return result.ok === false;
}

/** The paths a snapshot changed relative to another one. */
export interface SourceDiff {
  added: string[];
  modified: string[];
  removed: string[];
  /** True when nothing at all changed. */
  unchanged: boolean;
}

const SNAPSHOT_SELECT =
  "id,project_id,user_id,run_id,kind,description,source_hash,file_count,changed_paths,status,restored_at,restore_of_snapshot_id,created_at";

/** The difference between two source states. */
export function diffSource(
  before: readonly SnapshotFile[],
  after: readonly SnapshotFile[],
): SourceDiff {
  const beforeMap = new Map(before.map((file) => [file.path, file.content]));
  const afterMap = new Map(after.map((file) => [file.path, file.content]));

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, content] of afterMap) {
    const previous = beforeMap.get(path);
    if (previous === undefined) added.push(path);
    else if (previous !== content) modified.push(path);
  }
  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) removed.push(path);
  }

  const sort = (paths: string[]) => paths.sort((a, b) => a.localeCompare(b));
  return {
    added: sort(added),
    modified: sort(modified),
    removed: sort(removed),
    unchanged: added.length === 0 && modified.length === 0 && removed.length === 0,
  };
}

/** Every path a diff touched, sorted. */
export function diffPaths(diff: SourceDiff): string[] {
  return [...diff.added, ...diff.modified, ...diff.removed].sort((a, b) => a.localeCompare(b));
}

interface SnapshotRow {
  id: string;
  project_id: string;
  user_id: string;
  run_id: string | null;
  kind: string;
  description: string;
  source_hash: string;
  file_count: number;
  changed_paths: unknown;
  status: string;
  restored_at: string | null;
  restore_of_snapshot_id: string | null;
  created_at: string;
}

function toSummary(row: SnapshotRow): SnapshotSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    runId: row.run_id,
    kind: (SNAPSHOT_KINDS.includes(row.kind as SnapshotKind) ? row.kind : "manual") as SnapshotKind,
    description: row.description ?? "",
    sourceHash: row.source_hash ?? "",
    fileCount: Number(row.file_count ?? 0),
    changedPaths: parseChangedPaths(row.changed_paths),
    status: row.status === "failed" ? "failed" : "ready",
    restoredAt: row.restored_at,
    restoreOfSnapshotId: row.restore_of_snapshot_id,
    createdAt: row.created_at,
  };
}

function parseChangedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export interface CreateSnapshotInput {
  userId: string;
  projectId: string;
  kind: SnapshotKind;
  description: string;
  files: readonly SnapshotFile[];
  /** The run this snapshot belongs to, when it has one. */
  runId?: string | null;
  /** The paths this snapshot changed, when the producer knows them. */
  changedPaths?: readonly string[];
  /** For a 'pre_restore' snapshot: the snapshot it was taken for. */
  restoreOfSnapshotId?: string | null;
}

/**
 * Store one snapshot: the metadata row and every file of it.
 *
 * ⚠️ A PARTIAL WRITE IS A FAILURE, NOT A SNAPSHOT. The file rows are inserted
 * after the metadata row; if that insert fails the snapshot is marked 'failed'
 * and the caller is told. A snapshot that claims to be restorable but is not
 * would be worse than no snapshot at all.
 */
export async function createSnapshot(
  input: CreateSnapshotInput,
  injected?: SupabaseClient | null,
): Promise<SnapshotResult<SnapshotSummary>> {
  const supabase = injected ?? (await createSupabaseServerClient());
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured", code: "store_unavailable" };
  }

  const files = input.files.map((file) => ({
    path: file.path,
    content: file.content,
    bytes: Buffer.byteLength(file.content, "utf8"),
  }));
  const sourceHash = hashSource(files);

  const { data, error } = await supabase
    .from("project_snapshots")
    .insert({
      project_id: input.projectId,
      user_id: input.userId,
      run_id: input.runId ?? null,
      kind: input.kind,
      description: input.description.slice(0, 500),
      source_hash: sourceHash,
      file_count: files.length,
      changed_paths: [...(input.changedPaths ?? [])].slice(0, 500),
      status: "ready",
      restore_of_snapshot_id: input.restoreOfSnapshotId ?? null,
    })
    .select(SNAPSHOT_SELECT)
    .single();

  if (error || !data) {
    console.error("[mavly] snapshot create failed:", error?.message ?? "insert failed");
    return { ok: false, error: "Could not save the recovery point", code: "store_unavailable" };
  }

  const row = data as SnapshotRow;
  if (files.length > 0) {
    const { error: filesError } = await supabase
      .from("project_snapshot_files")
      .upsert(
        files.map((file) => ({
          snapshot_id: row.id,
          path: file.path,
          content: file.content,
          bytes: file.bytes,
        })),
        { onConflict: "snapshot_id,path" },
      );

    if (filesError) {
      console.error("[mavly] snapshot content write failed:", filesError.message);
      // The metadata row stays, marked as NOT restorable. It is never presented
      // as a working recovery point.
      await supabase
        .from("project_snapshots")
        .update({ status: "failed" })
        .eq("id", row.id);
      return {
        ok: false,
        error: "Could not save the recovery point content",
        code: "store_unavailable",
      };
    }
  }

  return { ok: true, data: toSummary(row) };
}

/** The recoverable snapshots of one project, newest first. */
export async function listSnapshots(
  projectId: string,
  options: { limit?: number } = {},
  injected?: SupabaseClient | null,
): Promise<SnapshotResult<SnapshotSummary[]>> {
  const supabase = injected ?? (await createSupabaseServerClient());
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured", code: "store_unavailable" };
  }

  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const { data, error } = await supabase
    .from("project_snapshots")
    .select(SNAPSHOT_SELECT)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[mavly] snapshot list failed:", error.message);
    return { ok: false, error: "Could not load the recovery points", code: "store_unavailable" };
  }
  return { ok: true, data: ((data ?? []) as SnapshotRow[]).map(toSummary) };
}

/**
 * One snapshot with its files.
 *
 * ⚠️ SCOPED TO THE PROJECT. The project id is part of the query, so a snapshot
 * belonging to another project is simply not found — the caller never learns
 * whether that id exists elsewhere.
 */
export async function getSnapshot(
  projectId: string,
  snapshotId: string,
  injected?: SupabaseClient | null,
): Promise<SnapshotResult<SnapshotWithFiles>> {
  const supabase = injected ?? (await createSupabaseServerClient());
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured", code: "store_unavailable" };
  }

  const { data, error } = await supabase
    .from("project_snapshots")
    .select(SNAPSHOT_SELECT)
    .eq("id", snapshotId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) {
    console.error("[mavly] snapshot read failed:", error.message);
    return { ok: false, error: "Could not load the recovery point", code: "store_unavailable" };
  }
  if (!data) {
    return { ok: false, error: "Recovery point not found", code: "snapshot_missing" };
  }

  const row = data as SnapshotRow;
  const { data: fileRows, error: filesError } = await supabase
    .from("project_snapshot_files")
    .select("path,content")
    .eq("snapshot_id", row.id)
    .order("path", { ascending: true });

  if (filesError) {
    console.error("[mavly] snapshot files read failed:", filesError.message);
    return { ok: false, error: "Could not load the recovery point", code: "store_unavailable" };
  }

  const files = ((fileRows ?? []) as { path: string; content: string }[]).map((file) => ({
    path: file.path,
    content: file.content,
  }));

  return { ok: true, data: { ...toSummary(row), files } };
}

/** Record that a snapshot was restored. */
export async function markSnapshotRestored(snapshotId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return;
  const { error } = await supabase
    .from("project_snapshots")
    .update({ restored_at: new Date().toISOString() })
    .eq("id", snapshotId);
  if (error) console.error("[mavly] snapshot restore marker failed:", error.message);
}
