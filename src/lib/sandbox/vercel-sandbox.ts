/**
 * ═══ VERCEL SANDBOX ADAPTER ═════════════════════════════════════════════════
 *
 * The real provider for Phase 3. It is a managed microVM, not a local process:
 * `Sandbox.create` starts it, `writeFiles` uploads the validated snapshot, and
 * `runCommand({detached:true})` starts install/build. The SDK has no per-command
 * timeout, so the worker's stage deadline plus the sandbox's own lifetime bound
 * it. A later tick reconnects by the sandbox name persisted in
 * `project_verifications.sandbox_id`.
 *
 * ⚠️ AUTHENTICATION IS SERVER-ONLY. Either the Vercel OIDC token in the
 * environment or an access-token triple is used; an OIDC-only deployment lets
 * the SDK resolve its own credentials from the process environment. No token is
 * stored, returned, logged or uploaded into the sandbox.
 *
 * ⚠️ NO LOCAL FALLBACK EXISTS. If the SDK is missing, credentials are wrong or
 * the provider times out, the operation returns a typed error; it never runs
 * npm or Next.js on the Mavly server.
 */

import { randomUUID } from "node:crypto";

import { APIError, Sandbox, type NetworkPolicy } from "@vercel/sandbox";

import {
  boundOutput,
  sandboxError,
  sandboxIdSafe,
  withTimeout,
  type SandboxAdapter,
  type SandboxCreateOptions,
  type SandboxError,
  type SandboxExecution,
  type SandboxResult,
  type SandboxSession,
  type UploadFile,
} from "./adapter";

export interface VercelSandboxCredentials {
  /** Kept out of the config object once the SDK reads the process env. */
  oidcToken: string | null;
  token: string | null;
  teamId: string | null;
  projectId: string | null;
}

const CREATE_TIMEOUT_MS = 90_000;
const RECONNECT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_MS = 20_000;
const DESTROY_TIMEOUT_MS = 30_000;

/** One small app on one vCPU; the session lifetime bounds the cost. */
const VERIFICATION_VCPUS = 1;

function mapProviderError(error: unknown): SandboxError {
  if (error instanceof APIError) {
    const status = error.response?.status;
    if (status === 404) {
      return sandboxError("not_found", "The sandbox no longer exists.");
    }
    if (status === 401 || status === 403) {
      return sandboxError(
        "not_configured",
        "The sandbox provider rejected the configured credentials.",
      );
    }
  }
  return sandboxError("provider_error", "The sandbox provider rejected the operation.");
}

function networkPolicyFor(options: SandboxCreateOptions): NetworkPolicy {
  const allow: Record<string, []> = {};
  for (const host of options.network.allowedHosts) {
    allow[host] = [];
  }
  return { allow };
}

export function createVercelSandboxAdapter(
  credentials: VercelSandboxCredentials,
): SandboxAdapter {
  // Instances are cached only for this adapter's lifetime (one worker tick).
  const live = new Map<string, Sandbox>();

  const accessToken =
    credentials.token && credentials.teamId && credentials.projectId
      ? {
          token: credentials.token,
          teamId: credentials.teamId,
          projectId: credentials.projectId,
        }
      : null;
  const hasOidc = Boolean(credentials.oidcToken);
  const configured = hasOidc || accessToken !== null;

  async function open(name: string): Promise<SandboxResult<Sandbox>> {
    const result = await withTimeout(
      // `Sandbox.get` is name-only; the SDK resolves authentication from the
      // same server environment the access-token triple or OIDC token came from.
      (signal) => Sandbox.get({ name, signal }),
      RECONNECT_TIMEOUT_MS,
      mapProviderError,
    );
    if (result.ok) live.set(name, result.value);
    return result;
  }

  async function ensure(session: SandboxSession): Promise<SandboxResult<Sandbox>> {
    const cached = live.get(session.id);
    if (cached) return { ok: true, value: cached };
    return open(session.id);
  }

  return {
    provider: "vercel",

    async create(options) {
      if (!configured) {
        return {
          ok: false,
          error: sandboxError("not_configured", "Vercel Sandbox credentials are not configured."),
        };
      }

      const name = `mavly-verify-${randomUUID().replace(/-/g, "")}`;
      const base = {
        name,
        image: options.image,
        timeout: options.timeoutMs,
        resources: { vcpus: VERIFICATION_VCPUS },
        networkPolicy: networkPolicyFor(options),
        env: { ...options.env },
        persistent: false,
        tags: { "mavly-purpose": "verification" },
      };

      const result = await withTimeout(
        (signal) =>
          accessToken
            ? Sandbox.create({ ...base, ...accessToken, signal })
            : Sandbox.create({ ...base, signal }),
        CREATE_TIMEOUT_MS,
        mapProviderError,
      );
      if (!result.ok) return result;

      live.set(result.value.name, result.value);
      return { ok: true, value: { id: result.value.name, provider: "vercel" } };
    },

    async reconnect(sandboxId) {
      if (!configured) {
        return {
          ok: false,
          error: sandboxError("not_configured", "Vercel Sandbox credentials are not configured."),
        };
      }
      if (!sandboxIdSafe(sandboxId)) {
        return {
          ok: false,
          error: sandboxError("invalid_input", "The sandbox reference is not valid."),
        };
      }
      if (!live.has(sandboxId)) {
        const opened = await open(sandboxId);
        if (!opened.ok) return opened;
      }
      return { ok: true, value: { id: sandboxId, provider: "vercel" } };
    },

    async upload(session, files: readonly UploadFile[]) {
      const sandbox = await ensure(session);
      if (!sandbox.ok) return sandbox;

      const payload = files.map((file) => ({
        path: file.path,
        content: file.content,
      }));
      const result = await withTimeout(
        async (signal) => {
          await sandbox.value.writeFiles(payload, { signal });
        },
        UPLOAD_TIMEOUT_MS,
        mapProviderError,
      );
      return result.ok ? { ok: true, value: undefined } : result;
    },

    async startDetached(session, script) {
      const sandbox = await ensure(session);
      if (!sandbox.ok) return sandbox;

      const result = await withTimeout(
        async (signal) => {
          await sandbox.value.runCommand({
            cmd: "sh",
            args: ["-c", script],
            cwd: "/vercel/sandbox",
            detached: true,
            signal,
          });
        },
        START_TIMEOUT_MS,
        mapProviderError,
      );
      return result.ok ? { ok: true, value: undefined } : result;
    },

    async exec(session, cmd, args) {
      const sandbox = await ensure(session);
      if (!sandbox.ok) return sandbox;

      return withTimeout<SandboxExecution>(
        async (signal) => {
          const finished = await sandbox.value.runCommand({
            cmd,
            args: [...args],
            cwd: "/vercel/sandbox",
            signal,
          });
          const [stdout, stderr] = await Promise.all([
            finished.stdout({ signal }),
            finished.stderr({ signal }),
          ]);
          return {
            exitCode: finished.exitCode,
            stdout: boundOutput(stdout),
            stderr: boundOutput(stderr),
          };
        },
        EXEC_TIMEOUT_MS + 5_000,
        mapProviderError,
      );
    },

    async destroy(session) {
      if (!sandboxIdSafe(session.id)) {
        return {
          ok: false,
          error: sandboxError("invalid_input", "The sandbox reference is not valid."),
        };
      }

      const sandbox = await ensure(session);
      if (!sandbox.ok) {
        // A sandbox the provider no longer knows is already clean.
        return sandbox.error.code === "not_found"
          ? { ok: true, value: "absent" }
          : { ok: false, error: sandbox.error };
      }

      const result = await withTimeout<"deleted" | "absent">(
        async (signal) => {
          try {
            await sandbox.value.delete({ signal });
            return "deleted";
          } catch (error) {
            if (error instanceof APIError && error.response?.status === 404) {
              return "absent";
            }
            throw error;
          }
        },
        DESTROY_TIMEOUT_MS,
        mapProviderError,
      );

      if (result.ok) live.delete(session.id);
      return result;
    },
  };
}
