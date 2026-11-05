/** ═══ E2B ADAPTER (Cloudflare Workers) ══════════════════════════════════════════════════
 * Adapted from E2B SDK v2.62.0 API contract.
 * The SDK itself uses globalThis.fetch and is Cloudflare Workers compatible
 * (runtime detection returns 'cloudflare-worker').
 *
 * All credentials (E2B_API_KEY) are server-side only; never sent to browser.
 * This adapter replaces the earlier `not_implemented` stub and provides
 * full verification lifecycle: create, reconnect, upload, exec, startDetached,
 * readFile, destroy.
 *
 * ⚠️ E2B_API_KEY must be available as a Cloudflare secret at
 * `globalThis.__E2B_API_KEY__` (set by the worker binding, never exposed
 * to the browser or logs).
 */

import type { SandboxAdapter, SandboxResult } from "./adapter";
import { sandboxError } from "./adapter";

import { e2bCreateSandbox } from "../cloudflare/e2b";
import { e2bReconnectSandbox } from "../cloudflare/e2b";
import { e2bUploadFiles } from "../cloudflare/e2b";
import { e2bStartDetached } from "../cloudflare/e2b";
import { e2bExec } from "../cloudflare/e2b";
import { e2bReadFile } from "../cloudflare/e2b";
import { e2bDestroySandbox } from "../cloudflare/e2b";

export function createE2bSandboxAdapter(): SandboxAdapter {
  // NOTE: The individual ops below will surface their own error if
  // E2B_API_KEY is missing from the runtime environment. The adapter
  // does not pre-check it so the failure mode is consistent with the
  // rest of the system: a provider_error from the first API call.

  return {
    provider: "e2b",
    create: (options) => e2bCreateSandbox(options),
    reconnect: (sandboxId) => e2bReconnectSandbox(sandboxId),
    upload: (session, files) => e2bUploadFiles(session, files),
    startDetached: (session, script) => e2bStartDetached(session, script),
    exec: (session, cmd, args) => e2bExec(session, cmd, args),
    readFile: (session, path, maxBytes) => e2bReadFile(session, path, maxBytes),
    destroy: (session) => e2bDestroySandbox(session),
  };
}