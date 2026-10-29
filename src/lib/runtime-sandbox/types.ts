/**
 * ═══ LIVE RUNTIME SANDBOX — SHARED TYPES ════════════════════════════════════
 *
 * Phase 13 adds a real development server for a generated React + Vite project:
 * Mavly's authoritative `project_files` are materialized into an isolated E2B
 * sandbox, dependencies are installed, a Vite dev server is started and its
 * readiness is verified before the workspace may call it "live".
 *
 * ⚠️ THIS MODULE IS PURE AND CLIENT-SAFE. It carries the lifecycle vocabulary,
 * the durable-session view the API returns, and the lifecycle transition table.
 * It imports nothing server-only (no `node:*`, no provider SDK, no Supabase), so
 * the workspace component and the server both use the same definitions.
 *
 * ⚠️ THIS IS NOT THE VERIFICATION SANDBOX. `src/lib/sandbox/` builds a snapshot
 * in a provider microVM and records build/runtime/health checks for a run. This
 * module is the long-lived PREVIEW runtime: one sandbox per project, reused
 * across refreshes, stopped explicitly or by expiry. They share no table, no
 * lease and no state. A ready preview here is not a passed verification, and a
 * passed verification is not a running preview.
 */

/**
 * The persisted lifecycle. Every state is written by the server; no browser can
 * choose one.
 *
 *   provisioning → syncing → installing → starting → ready
 *                                              ↘ failed
 *   any active state → stopping → stopped
 *   any active state → expired (provider lifetime or idle policy elapsed)
 *
 * `ready` means only one thing: the validated dev-server process was started,
 * the provider reported the port, and a server-side readiness request to the
 * provider's preview host received a 2xx/3xx response. It is not a build pass,
 * not a correctness check and not a deployment.
 */
export const RUNTIME_SANDBOX_STATES = [
  "provisioning",
  "syncing",
  "installing",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "expired",
  "failed",
] as const;

export type RuntimeSandboxState = (typeof RUNTIME_SANDBOX_STATES)[number];

/** A state whose sandbox may still be alive and therefore must be reused/stopped. */
export const ACTIVE_RUNTIME_SANDBOX_STATES: readonly RuntimeSandboxState[] = [
  "provisioning",
  "syncing",
  "installing",
  "starting",
  "ready",
  "stopping",
];

export const TERMINAL_RUNTIME_SANDBOX_STATES: readonly RuntimeSandboxState[] = [
  "stopped",
  "expired",
  "failed",
];

export function isRuntimeSandboxState(value: unknown): value is RuntimeSandboxState {
  return (
    typeof value === "string" &&
    (RUNTIME_SANDBOX_STATES as readonly string[]).includes(value)
  );
}

export function isActiveRuntimeState(state: RuntimeSandboxState): boolean {
  return ACTIVE_RUNTIME_SANDBOX_STATES.includes(state);
}

export function isTerminalRuntimeState(state: RuntimeSandboxState): boolean {
  return TERMINAL_RUNTIME_SANDBOX_STATES.includes(state);
}

/**
 * The ONLY legal transitions. A state machine that accepts anything is not a
 * state machine, and `ready` must never be reachable by a command merely being
 * submitted.
 */
const RUNTIME_TRANSITIONS: Record<RuntimeSandboxState, readonly RuntimeSandboxState[]> = {
  provisioning: ["syncing", "stopping", "failed", "expired"],
  syncing: ["installing", "stopping", "failed", "expired"],
  installing: ["starting", "stopping", "failed", "expired"],
  starting: ["ready", "stopping", "failed", "expired"],
  ready: ["stopping", "failed", "expired"],
  stopping: ["stopped", "failed"],
  stopped: [],
  expired: [],
  failed: [],
};

export function canTransitionRuntimeState(
  from: RuntimeSandboxState,
  to: RuntimeSandboxState,
): boolean {
  if (from === to) return true;
  return RUNTIME_TRANSITIONS[from].includes(to);
}

/**
 * The runtime profile this phase actually executes. There is deliberately one
 * member: claiming a broader matrix than the code supports is the failure mode
 * this union exists to prevent.
 */
export const RUNTIME_FRAMEWORKS = ["react_vite"] as const;
export type RuntimeFramework = (typeof RUNTIME_FRAMEWORKS)[number];

export function isRuntimeFramework(value: unknown): value is RuntimeFramework {
  return typeof value === "string" && (RUNTIME_FRAMEWORKS as readonly string[]).includes(value);
}

/** Why a project cannot be previewed live. Each reason has its own copy in the UI. */
export type RuntimeUnsupportedReason =
  | "android_project"
  | "missing_package_json"
  | "invalid_package_json"
  | "missing_react_dependency"
  | "missing_vite_dependency"
  | "missing_index_html"
  | "missing_entry_module"
  | "unsupported_package_manager"
  | "unsupported_framework"
  | "too_many_files";

export interface RuntimeProjectSupport {
  supported: boolean;
  framework: RuntimeFramework | null;
  /** `null` when supported; otherwise the exact reason the UI may display. */
  reason: RuntimeUnsupportedReason | null;
  /** Plain-language detail, safe to show. Never contains file content. */
  detail: string | null;
  /** Server-only validation facts; never sent to the browser directly. */
  entryHtml: string | null;
  hasLockfile: boolean;
  hasViteConfig: boolean;
  /**
   * Package scripts Mavly will NOT execute but the Security Agent may review:
   * pre/post-install hooks and a `dev` script that is not a plain Vite command.
   */
  scriptWarnings: string[];
}

// ── Provider-neutral operations ──────────────────────────────────────────────

export type RuntimeProviderErrorCode =
  | "not_configured"
  | "not_found"
  | "timeout"
  | "rate_limited"
  | "invalid_input"
  | "provider_error";

export interface RuntimeProviderError {
  code: RuntimeProviderErrorCode;
  /** Sanitized. Never a provider body, request headers or API key. */
  message: string;
}

export type RuntimeProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RuntimeProviderError };

export function runtimeProviderError(
  code: RuntimeProviderErrorCode,
  message: string,
): RuntimeProviderError {
  return { code, message };
}

/**
 * Explicit success guard. This project compiles with `strictNullChecks: false`,
 * so a bare `if (!result.ok)` does not narrow the union.
 */
export function isRuntimeProviderOk<T>(
  result: RuntimeProviderResult<T>,
): result is { ok: true; value: T } {
  return result.ok === true;
}

/**
 * A structured command. Callers never pass browser input: every command is
 * produced by `policy.ts` from a fixed operation, and arguments are a fixed
 * vector plus a numeric port. The adapter still shell-quotes every argument.
 */
export interface RuntimeCommandSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

export interface RuntimeCommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RuntimeBackgroundHandle {
  pid: number;
}

export interface RuntimeCreateOptions {
  template: string;
  timeoutMs: number;
  metadata: Record<string, string>;
}

/** The typed provider surface. One vendor (E2B) is implemented behind it. */
export interface RuntimeSandboxProvider {
  readonly name: "e2b";
  create(options: RuntimeCreateOptions): Promise<RuntimeProviderResult<{ sandboxId: string }>>;
  connect(
    sandboxId: string,
    options?: { timeoutMs?: number },
  ): Promise<RuntimeProviderResult<{ sandboxId: string }>>;
  isRunning(sandboxId: string): Promise<RuntimeProviderResult<boolean>>;
  writeFiles(
    sandboxId: string,
    directory: string,
    files: readonly { path: string; content: string }[],
  ): Promise<RuntimeProviderResult<{ written: number }>>;
  removeFiles(
    sandboxId: string,
    directory: string,
    paths: readonly string[],
  ): Promise<RuntimeProviderResult<{ removed: number }>>;
  run(
    sandboxId: string,
    command: RuntimeCommandSpec,
  ): Promise<RuntimeProviderResult<RuntimeCommandOutcome>>;
  startBackground(
    sandboxId: string,
    command: RuntimeCommandSpec,
    logPath: string,
  ): Promise<RuntimeProviderResult<RuntimeBackgroundHandle>>;
  killProcess(sandboxId: string, pid: number): Promise<RuntimeProviderResult<boolean>>;
  listProcesses(
    sandboxId: string,
  ): Promise<RuntimeProviderResult<{ pid: number; command: string }[]>>;
  readText(
    sandboxId: string,
    path: string,
    maxBytes: number,
  ): Promise<RuntimeProviderResult<string | null>>;
  /** The provider's externally reachable host for one port. */
  previewHost(sandboxId: string, port: number): Promise<RuntimeProviderResult<string>>;
  /**
   * Deny outbound traffic after installation. The dev server serves inbound
   * requests; it has no legitimate reason to reach the internet, so the runtime
   * is isolated from the network once dependencies exist.
   */
  denyEgress(sandboxId: string): Promise<RuntimeProviderResult<void>>;
  setLifetime(sandboxId: string, timeoutMs: number): Promise<RuntimeProviderResult<void>>;
  destroy(sandboxId: string): Promise<RuntimeProviderResult<"deleted" | "absent">>;
}

// ── Durable session view ────────────────────────────────────────────────────

export interface RuntimeSandboxRecord {
  id: string;
  projectId: string;
  runId: string | null;
  provider: "e2b";
  /** Provider reference (not a credential); the owner API does not return it. */
  sandboxId: string | null;
  framework: RuntimeFramework;
  state: RuntimeSandboxState;
  sourceHash: string | null;
  syncedPaths: string[];
  port: number | null;
  previewUrl: string | null;
  failureCode: string | null;
  failureReason: string | null;
  /** Bounded, redacted terminal output. Owner-visible. */
  logs: string;
  diagnostics: Record<string, unknown>;
  installMs: number | null;
  startupMs: number | null;
  commandCount: number;
  maxLifetimeSeconds: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  stoppedAt: string | null;
}

/** What the authenticated browser may see. No provider id, no tokens. */
export interface RuntimeSandboxView {
  id: string;
  state: RuntimeSandboxState;
  framework: RuntimeFramework;
  port: number | null;
  /** The provider preview host, already validated server-side. */
  previewUrl: string | null;
  failureCode: string | null;
  failureReason: string | null;
  /** Bounded and redacted on the server before it is stored. */
  logs: string;
  checks: RuntimeCheck[];
  installMs: number | null;
  startupMs: number | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export interface RuntimeCheck {
  id: "install" | "dev_server" | "readiness" | "build";
  label: string;
  status: "passed" | "failed" | "pending" | "unavailable" | "skipped";
  detail: string | null;
}

/** The GET answer. `available: false` means the UI must keep the static preview. */
export interface RuntimeSandboxStatus {
  capability: {
    available: boolean;
    /** Stable reason code; `null` when available. */
    reason: string | null;
    /** Actionable sentence for the workspace, never a secret. */
    message: string | null;
    provider: "e2b" | null;
    framework: RuntimeFramework | null;
  };
  support: {
    supported: boolean;
    reason: RuntimeUnsupportedReason | null;
    detail: string | null;
  };
  session: RuntimeSandboxView | null;
  /** True when a start/stop request is already durably in flight. */
  pending: boolean;
}

export interface RuntimeEvidence {
  status: "ready" | "failed" | "unavailable";
  state: RuntimeSandboxState | null;
  framework: RuntimeFramework | null;
  port: number | null;
  /** The source state this session actually ran; used to reject stale evidence. */
  sourceHash: string | null;
  checks: RuntimeCheck[];
  /** Sanitized, bounded diagnostic lines. */
  diagnostics: string[];
  failureCode: string | null;
  observedAt: string;
}

export function runtimeCapabilityReasonMessage(reason: string | null): string | null {
  switch (reason) {
    case "disabled":
      return "Live runtime previews are switched off for this deployment.";
    case "project_not_enabled":
      return "Live runtime previews are restricted by this deployment's project list.";
    case "misconfigured":
      return "Live runtime previews are enabled but not fully configured. An operator must finish the provider setup.";
    case "migration_required":
      return "Live runtime previews need database migration 34. Apply supabase/migrations/34_runtime_sandboxes.sql.";
    case "unsupported_project_type":
      return "Live runtime previews are available for website projects only.";
    default:
      return reason ? "Live runtime previews are unavailable." : null;
  }
}
