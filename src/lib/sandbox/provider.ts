/**
 * ═══ PROVIDER FACTORY ═══════════════════════════════════════════════════════
 *
 * One place that maps configuration to a real adapter. There is no default
 * provider and no implicit fallback: an unready configuration yields `null`,
 * and the caller must treat that as `configuration_error`.
 */

import type { SandboxAdapter } from "./adapter";
import type { VerificationSandboxConfig } from "./config";
import { createE2bSandboxAdapter } from "./e2b";
import { createVercelSandboxAdapter } from "./vercel-sandbox";

export function sandboxAdapterFor(
  config: VerificationSandboxConfig,
): SandboxAdapter | null {
  if (!config.ready || !config.provider) return null;
  if (config.provider === "vercel") {
    return createVercelSandboxAdapter(config.credentials);
  }
  if (config.provider === "e2b") {
    return createE2bSandboxAdapter();
  }
  return null;
}
