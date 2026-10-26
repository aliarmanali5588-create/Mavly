/**
 * ═══ SANDBOX ADAPTER CONTRACT ═══════════════════════════════════════════════
 *
 * A deliberately small, provider-neutral surface:
 *
 *   create → upload → startDetached → (poll via exec) → destroy
 *
 * ⚠️ EVERY OPERATION HAS ITS OWN TIMEOUT AND RETURNS A TYPED ERROR. No adapter
 * throws into the worker, and no operation falls back to running commands on
 * the Mavly server. A misconfigured provider is a `configuration_error`, never
 * a local build.
 *
 * ⚠️ `destroy` IS THE ONLY CLEANUP. There is no implicit stop: a terminal path
 * must call it and record whether the provider confirmed the sandbox is gone.
 */

import type { VerificationNetworkPolicy } from "./policy";
import type { VerificationProvider } from "./state";

export type SandboxErrorCode =
  | "not_configured"
  | "not_implemented"
  | "not_found"
  | "timeout"
  | "provider_error"
  | "invalid_input";

export interface SandboxError {
  code: SandboxErrorCode;
  /** Sanitized. Never a token, URL with credentials, or provider body. */
  message: string;
}

export type SandboxResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SandboxError };

/**
 * Explicit success guard for a `SandboxResult<T>`.
 *
 * This project compiles with `strictNullChecks: false`, where a bare
 * `if (!result.ok)` does not reliably narrow the union (the same workaround is
 * used in `src/lib/hosting/serve.ts`). A user-defined type predicate narrows by
 * declaration, so a branch that reads `.error` or `.value` is checked against
 * the member that actually has that property.
 */
export function isSandboxOk<T>(
  result: SandboxResult<T>,
): result is { ok: true; value: T } {
  return result.ok === true;
}

export interface SandboxSession {
  id: string;
  provider: VerificationProvider;
}

export interface SandboxExecution {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SandboxCreateOptions {
  image: string;
  /** Total sandbox lifetime. The provider destroys it when this elapses. */
  timeoutMs: number;
  /** Non-secret environment only. */
  env: Record<string, string>;
  network: VerificationNetworkPolicy;
}

export interface UploadFile {
  path: string;
  content: Buffer;
}

export interface SandboxAdapter {
  readonly provider: VerificationProvider;
  create(options: SandboxCreateOptions): Promise<SandboxResult<SandboxSession>>;
  /** Reconnect to a live sandbox; `not_found` means it is gone. */
  reconnect(sandboxId: string): Promise<SandboxResult<SandboxSession>>;
  upload(session: SandboxSession, files: readonly UploadFile[]): Promise<SandboxResult<void>>;
  /**
   * Start a bounded shell script. The adapter never waits for it to finish;
   * the worker's stage timeout and the sandbox's own session lifetime bound it.
   */
  startDetached(
    session: SandboxSession,
    script: string,
  ): Promise<SandboxResult<void>>;
  /** Run one short, blocking command (marker read). Output is bounded. */
  exec(
    session: SandboxSession,
    cmd: string,
    args: readonly string[],
  ): Promise<SandboxResult<SandboxExecution>>;
  /** Delete the sandbox. `absent` is a confirmed cleanup. */
  destroy(session: SandboxSession): Promise<SandboxResult<"deleted" | "absent">>;
}

export const MAX_EXEC_OUTPUT_BYTES = 8 * 1024;
export const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** Bound provider output before it can reach diagnostics. */
export function boundOutput(value: string | null | undefined): string {
  if (!value) return "";
  return value.length > MAX_EXEC_OUTPUT_BYTES
    ? value.slice(0, MAX_EXEC_OUTPUT_BYTES)
    : value;
}

export function sandboxError(code: SandboxErrorCode, message: string): SandboxError {
  return { code, message };
}

export function sandboxIdSafe(value: string): boolean {
  return SANDBOX_ID_PATTERN.test(value);
}

/**
 * Race a provider promise against a timeout. The abort signal is best-effort:
 * the provider may ignore it, which is why every session also has a provider
 * side lifetime.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  mapError?: (error: unknown) => SandboxError,
): Promise<SandboxResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SandboxResult<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        error: sandboxError("timeout", "The sandbox operation exceeded its time limit."),
      });
    }, timeoutMs);
  });

  const result = operation(controller.signal).then(
    (value): SandboxResult<T> => ({ ok: true, value }),
    (error): SandboxResult<T> => ({
      ok: false,
      // Never forward a provider message: it can contain a URL or request body.
      error: mapError
        ? mapError(error)
        : sandboxError("provider_error", "The sandbox provider rejected the operation."),
    }),
  );

  try {
    return await Promise.race([result, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
