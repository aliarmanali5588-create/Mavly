/**
 * ═══ RUNTIME PROVIDER FACTORY ══════════════════════════════════════════════
 *
 * One place maps configuration to a real adapter. An unready configuration
 * returns `null`, and the caller must treat that as `configuration_error`.
 *
 * ⚠️ THE E2B SDK IS LOADED LAZILY. Unit tests exercise the service through a
 * mocked provider and never need the vendor SDK, and a deployment with the runtime
 * flag off never loads it at all.
 */

import type { RuntimeSandboxConfig } from "./config";
import type { RuntimeSandboxProvider } from "./types";

export async function createRuntimeSandboxProvider(
  config: RuntimeSandboxConfig,
): Promise<RuntimeSandboxProvider | null> {
  if (!config.ready || !config.apiKey) return null;
  const { createE2bRuntimeProvider } = await import("./e2b-provider");
  return createE2bRuntimeProvider({
    apiKey: config.apiKey,
    template: config.template,
  });
}
