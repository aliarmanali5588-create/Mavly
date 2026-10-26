/**
 * ═══ RUNTIME PROFILES — WHAT CAN MAVLY ACTUALLY BUILD? ══════════════════════
 *
 * A runtime profile answers three questions for the sandbox:
 *
 *   1. Is this project a format we can build without guessing?
 *   2. Which Node image and package manager does it need?
 *   3. Which install and build commands are allowed?
 *
 * ⚠️ THIS IS NOT THE FUTURE RUNTIME-PROFILE SYSTEM. There is exactly one
 * supported profile today — the Next.js App Router project the generator
 * produces (`package.json`, `app/layout.tsx`, `app/page.tsx`). Anything else
 * resolves to `unsupported_runtime`; nothing is guessed or executed.
 *
 * ⚠️ THE BUILD SCRIPT IS VALIDATED, NOT TRUSTED. A generated `package.json`
 * can contain any command. Only a narrow `next build` shape is accepted, so a
 * manifest cannot turn verification into a general-purpose command runner.
 */

export interface SourceFile {
  path: string;
  content: string;
}

export type RuntimeProfileId = "next-app-router";

export interface RuntimeCommand {
  cmd: string;
  args: string[];
}

export interface RuntimePlan {
  profile: RuntimeProfileId;
  /** The managed Node image that satisfies the project's declared engines. */
  nodeImage: string;
  packageName: string | null;
  install: RuntimeCommand;
  build: RuntimeCommand;
  /** The exact package.json build script that was accepted. */
  buildScript: string;
  lockfile: "npm" | null;

  /**
   * The production start command, derived only from the fixed profile — never
   * from an arbitrary generated `start` script. It binds loopback so the
   * runtime is unreachable from outside the microVM.
   */
  runtime: RuntimeCommand;
  /** The accepted `start` script text, or null when the default applies. */
  startScript: string | null;
  /** Loopback port. Fixed per profile; never taken from the manifest. */
  runtimePort: number;
  /** The only path health-checked, always a constant. */
  runtimeHealthPath: string;
}

export type RuntimeFailureCode = "unsupported_runtime" | "invalid_manifest" | "invalid_lockfile";

export type RuntimeResolution =
  | { ok: true; plan: RuntimePlan }
  | {
      ok: false;
      code: RuntimeFailureCode;
      summary: string;
      diagnostics: string[];
    };

export const SUPPORTED_NODE_IMAGES = [
  "vercel/sandbox/node:22",
  "vercel/sandbox/node:24",
  "vercel/sandbox/node:26",
] as const;

export const DEFAULT_NODE_IMAGE = "vercel/sandbox/node:22";

/**
 * The runtime's fixed loopback port and health path. Both are profile
 * constants, not manifest values, so a generated project cannot point the
 * health check at another host, port or path.
 */
export const RUNTIME_PORT = 3000;
export const RUNTIME_HEALTH_PATH = "/";
