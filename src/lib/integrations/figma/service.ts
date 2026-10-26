/**
 * Figma connection service.
 *
 * A connection is a user's personal access token, validated against Figma's
 * `GET /v1/me` before it is encrypted and stored for one project. Status can
 * optionally re-verify the token; a revoked token is surfaced, not swallowed or
 * deleted. Design reads are server-side and bounded; the token never leaves the
 * server or reaches the model.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { VcaasErrorCode } from "@/lib/vcaas-errors";
import type { FigmaAccount, FigmaStatus } from "@/lib/vcaas-types";
import {
  extractFigmaReferences,
  getFigmaDesign,
  getFigmaMe,
  type FigmaApiFailure,
} from "./api";
import { figmaCryptoConfig } from "./config";
import { decryptFigmaToken, encryptFigmaToken } from "./crypto";
import {
  deleteFigmaConnection,
  getFigmaConnection,
  isFigmaStoreFailure,
  saveFigmaConnection,
  touchFigmaConnection,
  type FigmaConnectionRow,
} from "./store";

const MAX_DESIGN_CONTEXT_CHARS = 30_000;
const VALIDATE_LIMIT = 10;
const VALIDATE_WINDOW_MS = 60_000;

export interface FigmaServiceFailure {
  ok: false;
  status: number;
  code: VcaasErrorCode;
  error: string;
}

export type FigmaServiceResult<T> = { ok: true; data: T } | FigmaServiceFailure;

export interface FigmaConnectResult {
  connected: true;
  account: FigmaAccount;
}

export interface FigmaValidateResult {
  valid: true;
  account: FigmaAccount;
}

function failure(status: number, code: VcaasErrorCode, error: string): FigmaServiceFailure {
  return { ok: false, status, code, error };
}

function fromApiFailure(api: FigmaApiFailure): FigmaServiceFailure {
  if (api.code === "invalid_token" || api.code === "invalid_reference" || api.code === "missing_node") {
    return failure(400, "VALIDATION", api.error);
  }
  if (api.code === "forbidden") return failure(403, "UNKNOWN", api.error);
  if (api.code === "not_found") return failure(404, "UNKNOWN", api.error);
  if (api.code === "rate_limited") return failure(429, "RATE_LIMITED", api.error);
  return failure(502, "UNKNOWN", api.error);
}

function normalizeToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  if (token.length < 8 || token.length > 4_096) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(token)) return null;
  return token;
}

function accountFromRow(row: FigmaConnectionRow): FigmaAccount {
  return {
    id: row.account_id,
    handle: row.account_handle,
    ...(row.account_email ? { email: row.account_email } : {}),
    ...(row.account_img_url ? { imgUrl: row.account_img_url } : {}),
  };
}

/**
 * Every endpoint that makes an outbound Figma call with a caller-supplied token
 * (account validation, project connect and launch-with-Figma) shares a
 * best-effort per-user ceiling. Serverless instances do not share this map;
 * Figma's own rate limits remain the authority.
 */
const validationWindows = new Map<string, { count: number; resetAt: number }>();

export function consumeFigmaValidationAllowance(userId: string): boolean {
  const now = Date.now();
  if (validationWindows.size > 5_000) {
    for (const [key, window] of validationWindows) {
      if (window.resetAt <= now) validationWindows.delete(key);
    }
  }

  const current = validationWindows.get(userId);
  if (!current || current.resetAt <= now) {
    validationWindows.set(userId, { count: 1, resetAt: now + VALIDATE_WINDOW_MS });
    return true;
  }
  if (current.count >= VALIDATE_LIMIT) return false;
  current.count += 1;
  return true;
}

export async function validateFigmaToken(
  tokenInput: unknown,
): Promise<FigmaServiceResult<FigmaValidateResult>> {
  const token = normalizeToken(tokenInput);
  if (!token) return failure(400, "VALIDATION", "Paste a valid Figma access token.");

  const me = await getFigmaMe(token);
  if (me.ok === false) return fromApiFailure(me);
  return { ok: true, data: { valid: true, account: me.data } };
}

export async function connectFigma(
  projectId: string,
  userId: string,
  tokenInput: unknown,
): Promise<FigmaServiceResult<FigmaConnectResult>> {
  const token = normalizeToken(tokenInput);
  if (!token) return failure(400, "VALIDATION", "Paste a valid Figma access token.");
  if (!consumeFigmaValidationAllowance(userId)) {
    return failure(429, "RATE_LIMITED", "Too many Figma checks. Wait a minute and try again.");
  }

  const config = figmaCryptoConfig();
  if (config.ok === false) return failure(503, "BACKEND_NOT_CONFIGURED", config.error);

  const me = await getFigmaMe(token);
  if (me.ok === false) return fromApiFailure(me);

  const saved = await saveFigmaConnection({
    projectId,
    userId,
    accessTokenCiphertext: encryptFigmaToken(
      config.config.encryptionKey,
      token,
      projectId,
      userId,
    ),
    account: me.data,
  });
  if (isFigmaStoreFailure(saved)) {
    return failure(500, "UNKNOWN", "Could not save the Figma connection.");
  }

  return { ok: true, data: { connected: true, account: me.data } };
}

export async function getFigmaStatus(
  projectId: string,
  userId: string,
  verify: boolean,
): Promise<FigmaServiceResult<FigmaStatus>> {
  const connection = await getFigmaConnection(projectId, userId);
  if (isFigmaStoreFailure(connection)) {
    return failure(500, "UNKNOWN", "Could not check the Figma connection.");
  }
  if (!connection.data) return { ok: true, data: { connected: false } };

  const row = connection.data;
  const account = accountFromRow(row);
  if (!verify) {
    return {
      ok: true,
      data: {
        connected: true,
        account,
        connectedAt: row.connected_at,
      },
    };
  }

  const config = figmaCryptoConfig();
  if (config.ok === false) {
    return {
      ok: true,
      data: {
        connected: true,
        account,
        connectedAt: row.connected_at,
        tokenValid: false,
        tokenError: config.error,
      },
    };
  }

  const token = decryptFigmaToken(
    config.config.encryptionKey,
    row.access_token_ciphertext,
    projectId,
    userId,
  );
  if (!token) {
    return {
      ok: true,
      data: {
        connected: true,
        account,
        connectedAt: row.connected_at,
        tokenValid: false,
        tokenError: "This Figma connection can no longer be read. Paste a new token to reconnect.",
      },
    };
  }

  const me = await getFigmaMe(token);
  if (me.ok === false) {
    /**
     * A dead token is a connection problem the user can fix. A Figma outage or
     * rate limit is not: surfacing that as `tokenValid: false` would tell them
     * to regenerate a token that is still fine.
     */
    if (me.code === "rate_limited" || me.code === "upstream") {
      return fromApiFailure(me);
    }
    return {
      ok: true,
      data: {
        connected: true,
        account,
        connectedAt: row.connected_at,
        tokenValid: false,
        tokenError: me.error,
      },
    };
  }

  await touchFigmaConnection(projectId, userId, me.data);
  return {
    ok: true,
    data: {
      connected: true,
      account: me.data,
      connectedAt: row.connected_at,
      tokenValid: true,
    },
  };
}

export async function disconnectFigma(
  projectId: string,
  userId: string,
): Promise<FigmaServiceResult<{ disconnected: true }>> {
  const deleted = await deleteFigmaConnection(projectId, userId);
  if (isFigmaStoreFailure(deleted)) {
    return failure(500, "UNKNOWN", "Could not disconnect Figma.");
  }
  return { ok: true, data: { disconnected: true } };
}

async function readFigmaToken(
  projectId: string,
  userId: string,
  client?: SupabaseClient | null,
): Promise<FigmaServiceResult<string>> {
  const connection = await getFigmaConnection(projectId, userId, client);
  if (isFigmaStoreFailure(connection)) {
    return failure(500, "UNKNOWN", "Could not read the Figma connection.");
  }
  if (!connection.data) {
    return failure(
      400,
      "VALIDATION",
      "This project does not have Figma connected. Connect Figma and retry the prompt.",
    );
  }

  const config = figmaCryptoConfig();
  if (config.ok === false) return failure(503, "BACKEND_NOT_CONFIGURED", config.error);

  const token = decryptFigmaToken(
    config.config.encryptionKey,
    connection.data.access_token_ciphertext,
    projectId,
    userId,
  );
  if (!token) {
    return failure(
      400,
      "VALIDATION",
      "This Figma connection can no longer be read. Paste a new token to reconnect.",
    );
  }
  return { ok: true, data: token };
}

/**
 * Read every Figma frame referenced by the prompt and return a bounded text
 * context for the generator. No reference means no Figma call and no error.
 */
export async function loadFigmaDesignContext(input: {
  projectId: string;
  userId: string;
  prompt: string;
  /** The generation worker's verified service-role client. */
  client?: SupabaseClient | null;
}): Promise<FigmaServiceResult<string | null>> {
  const references = extractFigmaReferences(input.prompt);
  if (references.ok === false) return fromApiFailure(references);
  if (references.data.length === 0) return { ok: true, data: null };

  const token = await readFigmaToken(input.projectId, input.userId, input.client);
  if (token.ok === false) return token;

  const blocks: string[] = [];
  let used = 0;
  for (const reference of references.data) {
    const design = await getFigmaDesign(token.data, reference);
    if (design.ok === false) return fromApiFailure(design);

    const header = `## ${design.data.fileName}${design.data.nodeId ? ` — frame ${design.data.nodeId}` : ""}`;
    const block = `${header}\n${design.data.context}`;
    if (used + block.length > MAX_DESIGN_CONTEXT_CHARS) {
      blocks.push(
        "[Additional Figma references were omitted to fit the model context. Select one frame for a detailed build.]",
      );
      break;
    }
    blocks.push(block);
    used += block.length;
    if (used >= MAX_DESIGN_CONTEXT_CHARS) break;
  }

  return { ok: true, data: blocks.join("\n\n") };
}
