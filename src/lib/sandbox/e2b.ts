/**
 * ═══ E2B ADAPTER — DELIBERATELY NOT IMPLEMENTED ═════════════════════════════
 *
 * Phase 3 chose Vercel Sandbox because Mavly already deploys through Vercel and
 * the SDK covers the microVM lifecycle this phase needs. E2B would add a second
 * vendor, account and credential for no demonstrated benefit.
 *
 * This module exists only so the provider selection is explicit and honest: if
 * an operator sets `MAVLY_VERIFICATION_SANDBOX_PROVIDER=e2b`, configuration is
 * not-ready and every operation returns `not_implemented`. Nothing is stubbed
 * with a fake success.
 */

import type { SandboxAdapter, SandboxResult } from "./adapter";
import { sandboxError } from "./adapter";

function notImplemented<T>(): Promise<SandboxResult<T>> {
  return Promise.resolve({
    ok: false,
    error: sandboxError(
      "not_implemented",
      "The E2B sandbox provider is not implemented in this build.",
    ),
  });
}

export function createE2bSandboxAdapter(): SandboxAdapter {
  return {
    provider: "e2b",
    create: () => notImplemented(),
    reconnect: () => notImplemented(),
    upload: () => notImplemented(),
    startDetached: () => notImplemented(),
    exec: () => notImplemented(),
    readFile: () => notImplemented(),
    destroy: () => notImplemented(),
  };
}
