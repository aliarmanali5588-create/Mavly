/**
 * ═══ E2B RUNTIME PROVIDER ADAPTER ══════════════════════════════════════════
 *
 * The only real implementation of `RuntimeSandboxProvider`. It uses the official
 * E2B JavaScript SDK (`e2b` 2.x) and nothing else: no HTTP calls of its own, no
 * second vendor, no local execution fallback.
 *
 * Verified against `e2b@2.62.0`'s type definitions:
 *   · `Sandbox.create({ template, timeoutMs, metadata, network, apiKey })`
 *   · `Sandbox.connect(sandboxId, { timeoutMs, apiKey })`
 *   · `sandbox.commands.run(cmd, { cwd, timeoutMs, background })` →
 *     `CommandResult { exitCode, stdout, stderr }` or a `CommandHandle { pid }`
 *   · `sandbox.commands.kill(pid)` / `sandbox.commands.list()`
 *   · `sandbox.files.write([{ path, data }])`, `files.read(path)`, `files.remove(path)`
 *   · `sandbox.getHost(port)`, `sandbox.setTimeout(ms)`, `sandbox.kill()`
 *
 * ⚠️ ERRORS ARE NORMALIZED. A provider exception can carry a request URL or a
 * response body, so it is classified and replaced with a fixed message. No
 * exception, key or provider body ever reaches a route, a store or a log line.
 *
 * ⚠️ NO BROWSER INPUT REACHES A COMMAND. Every command is produced by
 * `policy.ts`; arguments are shell-quoted here as defence in depth, and the
 * working directory is fixed by the caller.
 */

import { CommandExitError, Sandbox, type CommandHandle } from "e2b";

import {
  commandLine,
  quoteShellArg,
} from "./policy";
import {
  isRuntimeProviderOk,
  runtimeProviderError,
  type RuntimeCommandOutcome,
  type RuntimeCommandSpec,
  type RuntimeCreateOptions,
  type RuntimeProviderError,
  type RuntimeProviderResult,
  type RuntimeSandboxProvider,
} from "./types";

export interface E2bProviderOptions {
  apiKey: string;
  template: string;
  /** E2B API domain (default e2b.app). Never a preview host. */
  domain?: string | null;
}

const MAX_CAPTURED_CHARS = 64 * 1024;

function bound(value: string | null | undefined): string {
  if (!value) return "";
  return value.length > MAX_CAPTURED_CHARS ? value.slice(0, MAX_CAPTURED_CHARS) : value;
}

/**
 * Classify a provider failure WITHOUT forwarding its message. E2B classes are
 * imported by the SDK; status codes are also checked so a version skew still
 * yields a truthful classification.
 */
function classify(error: unknown): RuntimeProviderError {
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name : "";
  const status =
    typeof record.statusCode === "number" ? record.statusCode : undefined;

  if (name === "SandboxNotFoundError" || name === "NotFoundError" || status === 404) {
    return runtimeProviderError("not_found", "The runtime sandbox no longer exists.");
  }
  if (name === "TimeoutError" || name === "SandboxUnreachableError" || status === 408) {
    return runtimeProviderError("timeout", "The runtime provider timed out.");
  }
  if (name === "RateLimitError" || status === 429) {
    return runtimeProviderError("rate_limited", "The runtime provider is rate limiting requests.");
  }
  if (name === "InvalidArgumentError" || status === 400) {
    return runtimeProviderError("invalid_input", "The runtime provider rejected the request.");
  }
  if (name === "AuthenticationError" || status === 401 || status === 403) {
    return runtimeProviderError(
      "not_configured",
      "The runtime provider credentials were rejected.",
    );
  }
  return runtimeProviderError("provider_error", "The runtime provider rejected the operation.");
}

async function guard<T>(
  operation: () => Promise<T>,
): Promise<RuntimeProviderResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: classify(error) };
  }
}

export function createE2bRuntimeProvider(options: E2bProviderOptions): RuntimeSandboxProvider {
  const defaults = options.domain ? { domain: options.domain } : {};

  /**
   * ⚠️ THE KEY IS PASSED EXPLICITLY ON EVERY CONNECT. Mavly reads it from its own
   * server-side configuration; relying on the SDK's `E2B_API_KEY` environment
   * lookup would make a correctly configured deployment fail depending on how
   * the process was started.
   */
  function connection(sandboxId: string) {
    return Sandbox.connect(sandboxId, { ...defaults, apiKey: options.apiKey });
  }

  return {
    name: "e2b",

    async create(create: RuntimeCreateOptions) {
      return guard(async () => {
        const sandbox = await Sandbox.create({
          ...defaults,
          apiKey: options.apiKey,
          template: create.template,
          timeoutMs: create.timeoutMs,
          metadata: create.metadata,
        });
        return { sandboxId: sandbox.sandboxId };
      });
    },

    async connect(sandboxId, connectOptions) {
      return guard(async () => {
        const sandbox = await Sandbox.connect(sandboxId, {
          ...defaults,
          apiKey: options.apiKey,
          ...(connectOptions?.timeoutMs ? { timeoutMs: connectOptions.timeoutMs } : {}),
        });
        return { sandboxId: sandbox.sandboxId };
      });
    },

    async isRunning(sandboxId) {
      return guard(async () => {
        const sandbox = await connection(sandboxId);
        return sandbox.isRunning();
      });
    },

    async writeFiles(sandboxId, directory, files) {
      return guard(async () => {
        if (!directory.startsWith("/")) {
          throw new Error("invalid directory");
        }
        /** The adapter re-checks every relative path; a caller bug cannot escape. */
        for (const file of files) {
          if (
            !file.path ||
            file.path.startsWith("/") ||
            file.path.includes("\\") ||
            file.path.split("/").some((segment) => segment === ".." || segment === "")
          ) {
            throw new Error("invalid file path");
          }
        }
        const sandbox = await connection(sandboxId);
        await sandbox.files.makeDir(directory);
        if (files.length === 0) return { written: 0 };
        await sandbox.files.write(
          files.map((file) => ({
            path: `${directory}/${file.path}`,
            data: file.content,
          })),
        );
        return { written: files.length };
      });
    },

    async removeFiles(sandboxId, directory, paths) {
      return guard(async () => {
        const sandbox = await connection(sandboxId);
        let removed = 0;
        for (const path of paths.slice(0, 50)) {
          if (!path || path.startsWith("/") || path.includes("..") || path.includes("\\")) continue;
          try {
            await sandbox.files.remove(`${directory}/${path}`);
            removed += 1;
          } catch {
            // A file that is already gone is not a sync failure.
          }
        }
        return { removed };
      });
    },

    async run(sandboxId, command: RuntimeCommandSpec) {
      return guard(async () => {
        const sandbox = await connection(sandboxId);
        const started = Date.now();
        try {
          const result = await sandbox.commands.run(commandLine(command), {
            cwd: command.cwd,
            timeoutMs: command.timeoutMs,
          });
          const outcome: RuntimeCommandOutcome = {
            exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
            stdout: bound(result.stdout),
            stderr: bound(result.stderr),
            durationMs: Date.now() - started,
          };
          return outcome;
        } catch (error) {
          /**
           * ⚠️ A NON-ZERO EXIT IS A RESULT, NOT A TRANSPORT FAILURE. The SDK
           * throws `CommandExitError` from `run()`; without this branch a
           * normal failing install would be classified as a provider error and
           * its output would be lost.
           */
          if (error instanceof CommandExitError) {
            return {
              exitCode: error.exitCode,
              stdout: bound(error.stdout),
              stderr: bound(error.stderr),
              durationMs: Date.now() - started,
            };
          }
          throw error;
        }
      });
    },

    async startBackground(sandboxId, command, logPath) {
      return guard(async () => {
        if (!logPath.startsWith("/") || logPath.includes("..")) {
          throw new Error("invalid log path");
        }
        const sandbox = await connection(sandboxId);
        /** The redirect target's directory must exist before the shell opens it. */
        const logDir = logPath.slice(0, logPath.lastIndexOf("/"));
        if (logDir) await sandbox.files.makeDir(logDir);
        const line = `${commandLine(command)} > ${quoteShellArg(logPath)} 2>&1`;
        const handle = (await sandbox.commands.run(line, {
          cwd: command.cwd,
          background: true,
          // 0 disables the per-command timeout; the sandbox lifetime bounds it.
          timeoutMs: 0,
        })) as CommandHandle;
        return { pid: handle.pid };
      });
    },

    async killProcess(sandboxId, pid) {
      return guard(async () => {
        const sandbox = await connection(sandboxId);
        return sandbox.commands.kill(pid);
      });
    },

    async listProcesses(sandboxId) {
      return guard(async () => {
        const sandbox = await connection(sandboxId);
        const processes = await sandbox.commands.list();
        return processes.slice(0, 100).map((process) => ({
          pid: process.pid,
          command: bound(`${process.cmd} ${(process.args ?? []).join(" ")}`).slice(0, 300),
        }));
      });
    },

    async readText(sandboxId, path, maxBytes) {
      return guard(async () => {
        if (!path.startsWith("/") || path.includes("..")) return null;
        const sandbox = await connection(sandboxId);
        if (!(await sandbox.files.exists(path))) return null;
        const text = await sandbox.files.read(path);
        if (typeof text !== "string") return null;
        const limit = Math.max(256, Math.min(maxBytes, 256 * 1024));
        return text.length > limit ? text.slice(text.length - limit) : text;
      });
    },

    async previewHost(sandboxId, port) {
      return guard(async () => {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new Error("invalid port");
        }
        const sandbox = await connection(sandboxId);
        return sandbox.getHost(port);
      });
    },

    async denyEgress(sandboxId) {
      return guard(async () => {
        const sandbox = await connection(sandboxId);
        await sandbox.updateNetwork({ denyOut: ["0.0.0.0/0"] });
      });
    },

    async setLifetime(sandboxId, timeoutMs) {
      return guard(async () => {
        const sandbox = await connection(sandboxId);
        await sandbox.setTimeout(Math.max(60_000, Math.min(timeoutMs, 86_400_000)));
      });
    },

    async destroy(sandboxId) {
      try {
        const sandbox = await connection(sandboxId);
        const killed = await sandbox.kill();
        return { ok: true, value: killed ? ("deleted" as const) : ("absent" as const) };
      } catch (error) {
        const classified = classify(error);
        /** A sandbox the provider already dropped is a completed cleanup. */
        if (classified.code === "not_found") {
          return { ok: true, value: "absent" as const };
        }
        return { ok: false, error: classified };
      }
    },
  };
}

export { isRuntimeProviderOk };
