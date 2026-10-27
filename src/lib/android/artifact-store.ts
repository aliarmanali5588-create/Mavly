/**
 * ═══ PRIVATE ANDROID ARTIFACT STORAGE ═══════════════════════════════════════
 *
 * The APK lives in a private Supabase Storage bucket. Only the confined
 * service-role client uploads or deletes it; a user-facing request first proves
 * project ownership and then receives a SHORT-LIVED signed URL, never the
 * bucket, object key, or a permanent public link.
 *
 * The object key is always server-derived:
 *   <project-id>/<build-id>/<sha256>.apk
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type AndroidArtifactStoreCode =
  | "not_configured"
  | "invalid_path"
  | "upload_failed"
  | "sign_failed"
  | "delete_failed";

export type AndroidArtifactStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: AndroidArtifactStoreCode; error: string };

export interface AndroidArtifactStore {
  upload(input: {
    path: string;
    bytes: Buffer;
    contentType: string;
  }): Promise<AndroidArtifactStoreResult<void>>;
  sign(path: string, expiresInSeconds: number): Promise<
    AndroidArtifactStoreResult<{ url: string; expiresAt: string }>
  >;
  remove(path: string): Promise<AndroidArtifactStoreResult<"deleted" | "absent">>;
}

const PATH_PATTERN = /^[A-Za-z0-9._-]+\/[a-f0-9-]{36}\/[a-f0-9]{64}\.apk$/;
const MAX_SIGNED_URL_SECONDS = 900;
const MIN_SIGNED_URL_SECONDS = 60;

function pathSafe(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("..") &&
    PATH_PATTERN.test(path)
  );
}

export function createAndroidArtifactStore(
  client: SupabaseClient,
  bucket: string,
): AndroidArtifactStore {
  return {
    async upload({ path, bytes, contentType }) {
      if (!pathSafe(path)) {
        return { ok: false, code: "invalid_path", error: "The artifact object key is not valid." };
      }
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return { ok: false, code: "upload_failed", error: "There are no artifact bytes to upload." };
      }
      const { error } = await client.storage.from(bucket).upload(path, bytes, {
        contentType,
        cacheControl: "0",
        upsert: true,
      });
      if (error) {
        return { ok: false, code: "upload_failed", error: "The artifact could not be stored." };
      }
      return { ok: true, data: undefined };
    },

    async sign(path, expiresInSeconds) {
      if (!pathSafe(path)) {
        return { ok: false, code: "invalid_path", error: "The artifact object key is not valid." };
      }
      const expires = Math.max(
        MIN_SIGNED_URL_SECONDS,
        Math.min(MAX_SIGNED_URL_SECONDS, Math.floor(expiresInSeconds)),
      );
      const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expires);
      if (error || !data?.signedUrl) {
        return { ok: false, code: "sign_failed", error: "The artifact download could not be authorized." };
      }
      return {
        ok: true,
        data: {
          url: data.signedUrl,
          expiresAt: new Date(Date.now() + expires * 1000).toISOString(),
        },
      };
    },

    async remove(path) {
      if (!pathSafe(path)) {
        return { ok: false, code: "invalid_path", error: "The artifact object key is not valid." };
      }
      const { error } = await client.storage.from(bucket).remove([path]);
      if (error) {
        return { ok: false, code: "delete_failed", error: "The artifact could not be removed." };
      }
      // Storage remove is idempotent for an already-absent object.
      return { ok: true, data: "deleted" };
    },
  };
}
