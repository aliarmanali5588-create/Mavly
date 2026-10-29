/**
 * ═══ IMAGE ASSET STORAGE — SERVER ONLY ══════════════════════════════════════
 *
 * Generated images are uploaded to the project's Storage bucket. The caller
 * supplies the run's existing Supabase client: the owner's RLS client on the
 * inline path, the confined worker client when a durable worker owns the run.
 * No provider URL is ever fetched, and no user-supplied string becomes a path.
 *
 * ⚠️ THE PATH IS SERVER-DERIVED. `<project_id>/<run_id>/<asset_key>.<ext>`:
 *
 *   · `project_id` is the immutable, owned project slug (`projects` RLS and the
 *     storage policy both key on its first folder segment);
 *   · `run_id` is a UUID minted by the database;
 *   · `asset_key` is the validated plan id (`^[a-z0-9][a-z0-9_-]{0,63}$`);
 *   · the extension comes from the SNIFFED bytes, never from the provider.
 *
 * ⚠️ OVERWRITE IS INTENTIONAL. `upsert: true` makes a retried upload of the same
 * deterministic path idempotent instead of failing with an "already exists"
 * conflict after a crash between upload and the completion write.
 *
 * ⚠️ THE BUCKET IS PUBLIC-READ BY DESIGN (migration 33). Generated site imagery
 * is public website content; paths are unguessable and there is no listing.
 * Project files, secrets, keys and credentials are not in this bucket.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ImageOutputFormat } from "@/lib/image-generation-options";

/** Mirrors the bucket's `file_size_limit` in migration 33. */
export const IMAGE_STORAGE_MAX_BYTES = 6_000_000;

const PROJECT_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RUN_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type ImageUploadFailureCode = "INVALID_PATH" | "TOO_LARGE" | "STORAGE";

export type ImageUploadResult =
  | { ok: true; storagePath: string; publicUrl: string; bytes: number }
  | { ok: false; code: ImageUploadFailureCode; error: string };

export interface UploadImageAssetInput {
  bucket: string;
  projectId: string;
  runId: string;
  assetKey: string;
  mediaType: "image/png" | "image/jpeg";
  format: ImageOutputFormat;
  /** Decoded bytes; the caller already validated the signature. */
  bytes: Uint8Array;
}

/** The only path builder. Returns null when any segment is not safe. */
export function imageStoragePath(input: {
  projectId: string;
  runId: string;
  assetKey: string;
  format: ImageOutputFormat;
}): string | null {
  if (!PROJECT_SEGMENT.test(input.projectId)) return null;
  if (!RUN_SEGMENT.test(input.runId)) return null;
  if (!ASSET_SEGMENT.test(input.assetKey)) return null;
  const extension = input.format === "jpeg" ? "jpg" : "png";
  return `${input.projectId}/${input.runId}/${input.assetKey}.${extension}`;
}

/** The public URL for a stored object, derived by the Storage SDK. */
export function publicImageUrl(
  client: SupabaseClient,
  bucket: string,
  storagePath: string,
): string | null {
  const { data } = client.storage.from(bucket).getPublicUrl(storagePath);
  const url = data?.publicUrl?.trim();
  return url && /^https?:\/\//i.test(url) ? url : null;
}

export async function uploadImageAsset(
  client: SupabaseClient,
  input: UploadImageAssetInput,
): Promise<ImageUploadResult> {
  const storagePath = imageStoragePath(input);
  if (!storagePath) {
    return { ok: false, code: "INVALID_PATH", error: "The image storage path is invalid." };
  }
  if (input.bytes.length === 0 || input.bytes.length > IMAGE_STORAGE_MAX_BYTES) {
    return {
      ok: false,
      code: "TOO_LARGE",
      error: "The generated image is empty or larger than the storage limit.",
    };
  }

  const { error } = await client.storage.from(input.bucket).upload(storagePath, input.bytes, {
    contentType: input.mediaType,
    upsert: true,
    cacheControl: "31536000",
  });
  if (error) {
    return {
      ok: false,
      code: "STORAGE",
      error: "The generated image could not be stored.",
    };
  }

  const publicUrl = publicImageUrl(client, input.bucket, storagePath);
  if (!publicUrl) {
    return {
      ok: false,
      code: "STORAGE",
      error: "The stored image has no readable URL.",
    };
  }

  return { ok: true, storagePath, publicUrl, bytes: input.bytes.length };
}
