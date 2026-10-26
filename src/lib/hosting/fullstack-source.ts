/**
 * ═══ WHICH BYTES MAY BE DEPLOYED? ═══════════════════════════════════════════
 *
 * Phase 5 deploys a VERIFIED, IMMUTABLE snapshot — never the live draft in
 * `project_files`, and never "whatever was last generated".
 *
 * The join is deliberately narrow:
 *
 *   project_verifications.status = 'passed'
 *     AND (effective_snapshot_id, effective_source_hash)   ← Phase 4 repair aware
 *     AND the snapshot belongs to this project
 *     AND the snapshot is still 'ready'
 *     AND the hash recomputed from project_snapshot_files equals the verified hash
 *
 * If any link is missing the deployment is refused with an actionable message.
 * A passing build in a microVM is NOT a deployment, but a deployment may not
 * skip it.
 */

import { getSnapshot, hashSource, isSnapshotFailure, listSnapshots } from "@/lib/mavly/snapshots";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface VerifiedSource {
  snapshotId: string;
  sourceHash: string;
  verificationId: string;
  runtimeProfile: string | null;
  files: { path: string; content: string }[];
}

export type VerifiedSourceFailureCode =
  | "verification_required"
  | "snapshot_missing"
  | "snapshot_mismatch"
  | "migration_required"
  | "unavailable";

export type VerifiedSourceResult =
  | { ok: true; source: VerifiedSource }
  | { ok: false; code: VerifiedSourceFailureCode; error: string };

interface VerificationRow {
  id: string;
  snapshot_id: string;
  source_hash: string;
  effective_snapshot_id: string | null;
  effective_source_hash: string | null;
  runtime_profile: string | null;
  finished_at: string | null;
}

const VERIFICATION_COLUMNS =
  "id,snapshot_id,source_hash,effective_snapshot_id,effective_source_hash,runtime_profile,finished_at";

function failure(
  code: VerifiedSourceFailureCode,
  error: string,
): VerifiedSourceResult {
  return { ok: false, code, error };
}

function missingSchema(error: { code?: string | null; message?: string | null }): boolean {
  const code = (error.code ?? "").toUpperCase();
  const message = (error.message ?? "").toLowerCase();
  return (
    code === "42703" ||
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("effective_snapshot_id") ||
    message.includes("effective_source_hash") ||
    message.includes("project_verifications") ||
    message.includes("schema cache")
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Resolve the deployable source. `requestedSnapshotId` lets an operator pin an
 * older verified snapshot; it is not trusted on its own — the same verification
 * and hash join still applies.
 */
export async function resolveVerifiedSource(
  projectId: string,
  requestedSnapshotId?: string | null,
): Promise<VerifiedSourceResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  let row: VerificationRow | null = null;

  if (requestedSnapshotId) {
    if (!isUuid(requestedSnapshotId)) {
      return failure("snapshot_missing", "That snapshot id is not valid.");
    }
    const snapshot = await getSnapshot(projectId, requestedSnapshotId);
    if (isSnapshotFailure(snapshot)) {
      return failure(
        snapshot.code === "snapshot_missing" ? "snapshot_missing" : "unavailable",
        snapshot.code === "snapshot_missing"
          ? "That snapshot does not belong to this project."
          : snapshot.error,
      );
    }
    const computed = hashSource(snapshot.data.files);
    const { data, error } = await supabase
      .from("project_verifications")
      .select(VERIFICATION_COLUMNS)
      .eq("project_id", projectId)
      .eq("status", "passed")
      .or(
        `and(effective_snapshot_id.eq.${requestedSnapshotId},effective_source_hash.eq.${computed}),and(snapshot_id.eq.${requestedSnapshotId},source_hash.eq.${computed})`,
      )
      .order("finished_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (missingSchema(error)) {
        return failure(
          "migration_required",
          "Verification schema 19 is not installed. Apply supabase/migrations/19_runtime_verification.sql.",
        );
      }
      return failure("unavailable", "Could not read the verification record.");
    }
    row = (data as VerificationRow | null) ?? null;
    if (!row) {
      return failure(
        "verification_required",
        "That snapshot has no passed build verification. Verify the project, then deploy.",
      );
    }
  } else {
    const { data, error } = await supabase
      .from("project_verifications")
      .select(VERIFICATION_COLUMNS)
      .eq("project_id", projectId)
      .eq("status", "passed")
      .order("finished_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (missingSchema(error)) {
        return failure(
          "migration_required",
          "Verification schema 19 is not installed. Apply supabase/migrations/19_runtime_verification.sql.",
        );
      }
      return failure("unavailable", "Could not read the verification record.");
    }
    row = (data as VerificationRow | null) ?? null;
    if (!row) {
      return failure(
        "verification_required",
        "This project has no passed build verification yet. A full-stack deployment requires one.",
      );
    }
  }

  const snapshotId = row.effective_snapshot_id || row.snapshot_id;
  const verifiedHash = row.effective_source_hash || row.source_hash;
  if (!snapshotId || !verifiedHash) {
    return failure("verification_required", "The verification record is incomplete.");
  }

  const snapshot = await getSnapshot(projectId, snapshotId);
  if (isSnapshotFailure(snapshot)) {
    return failure(
      snapshot.code === "snapshot_missing" ? "snapshot_missing" : "unavailable",
      snapshot.code === "snapshot_missing"
        ? "The verified snapshot no longer exists."
        : snapshot.error,
    );
  }
  if (snapshot.data.status !== "ready") {
    return failure("snapshot_missing", "The verified snapshot is not readable.");
  }

  const files = snapshot.data.files.map((file) => ({
    path: file.path,
    content: file.content,
  }));
  const computed = hashSource(files);
  if (computed !== verifiedHash) {
    return failure(
      "snapshot_mismatch",
      "The snapshot content no longer matches its verified hash, so it cannot be deployed.",
    );
  }

  return {
    ok: true,
    source: {
      snapshotId,
      sourceHash: computed,
      verificationId: row.id,
      runtimeProfile: row.runtime_profile,
      files,
    },
  };
}

/**
 * A lightweight list for the workspace: the verified snapshots an operator may
 * choose from, newest first. Metadata only — never file content.
 */
export async function listDeployableSnapshots(
  projectId: string,
  limit = 10,
): Promise<
  | { ok: true; data: { snapshotId: string; sourceHash: string; verifiedAt: string | null }[] }
  | { ok: false; error: string }
> {
  const snapshots = await listSnapshots(projectId, { limit: 50 });
  if (isSnapshotFailure(snapshots)) return { ok: false, error: snapshots.error };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured." };

  const { data, error } = await supabase
    .from("project_verifications")
    .select("id,effective_snapshot_id,effective_source_hash,snapshot_id,source_hash,finished_at")
    .eq("project_id", projectId)
    .eq("status", "passed")
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(Math.max(1, Math.min(limit, 50)));

  if (error) return { ok: false, error: "Could not read the verification records." };

  const known = new Set(snapshots.data.map((snapshot) => snapshot.id));
  const rows = (data ?? []) as {
    effective_snapshot_id: string | null;
    effective_source_hash: string | null;
    snapshot_id: string;
    source_hash: string;
    finished_at: string | null;
  }[];

  const seen = new Set<string>();
  const result: { snapshotId: string; sourceHash: string; verifiedAt: string | null }[] = [];
  for (const row of rows) {
    const snapshotId = row.effective_snapshot_id || row.snapshot_id;
    const sourceHash = row.effective_source_hash || row.source_hash;
    if (!snapshotId || !sourceHash || seen.has(snapshotId) || !known.has(snapshotId)) continue;
    seen.add(snapshotId);
    result.push({ snapshotId, sourceHash, verifiedAt: row.finished_at });
  }
  return { ok: true, data: result };
}
