/**
 * Persistence for the Figma integration.
 *
 * Every query uses the caller's RLS-scoped Supabase client. The table's policy
 * requires both the owning user and an owned project row. Ciphertext never
 * leaves server-side integration code; no route returns it.
 */

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { FigmaAccount } from "./api";

export interface FigmaConnectionRow {
  project_id: string;
  user_id: string;
  access_token_ciphertext: string;
  account_id: string;
  account_handle: string;
  account_email: string | null;
  account_img_url: string | null;
  connected_at: string;
  last_verified_at: string | null;
  updated_at: string;
}

export type FigmaStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "store_unavailable" | "not_connected" };

export function isFigmaStoreFailure<T>(
  result: FigmaStoreResult<T>,
): result is { ok: false; code: "store_unavailable" | "not_connected" } {
  return result.ok === false;
}

const COLUMNS =
  "project_id,user_id,access_token_ciphertext,account_id,account_handle,account_email,account_img_url,connected_at,last_verified_at,updated_at";

export async function getFigmaConnection(
  projectId: string,
  userId: string,
): Promise<FigmaStoreResult<FigmaConnectionRow | null>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { data, error } = await supabase
    .from("figma_connections")
    .select(COLUMNS)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[figma] connection lookup failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: (data as FigmaConnectionRow | null) ?? null };
}

export async function saveFigmaConnection(input: {
  projectId: string;
  userId: string;
  accessTokenCiphertext: string;
  account: FigmaAccount;
}): Promise<FigmaStoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const now = new Date().toISOString();
  const { error } = await supabase.from("figma_connections").upsert(
    {
      project_id: input.projectId,
      user_id: input.userId,
      access_token_ciphertext: input.accessTokenCiphertext,
      account_id: input.account.id,
      account_handle: input.account.handle,
      account_email: input.account.email ?? null,
      account_img_url: input.account.imgUrl ?? null,
      connected_at: now,
      last_verified_at: now,
      updated_at: now,
    },
    { onConflict: "project_id" },
  );

  if (error) {
    console.error("[figma] connection save failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}

/** Best-effort metadata refresh after a successful live verification. */
export async function touchFigmaConnection(
  projectId: string,
  userId: string,
  account: FigmaAccount,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return;

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("figma_connections")
    .update({
      account_id: account.id,
      account_handle: account.handle,
      account_email: account.email ?? null,
      account_img_url: account.imgUrl ?? null,
      last_verified_at: now,
      updated_at: now,
    })
    .eq("project_id", projectId)
    .eq("user_id", userId);

  if (error) console.error("[figma] connection verification update failed");
}

export async function deleteFigmaConnection(
  projectId: string,
  userId: string,
): Promise<FigmaStoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { error } = await supabase
    .from("figma_connections")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId);

  if (error) {
    console.error("[figma] connection delete failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}
