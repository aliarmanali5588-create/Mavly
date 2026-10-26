/**
 * ═══ VERIFICATION SANDBOX POLICY ════════════════════════════════════════════
 *
 * Everything between "a snapshot exists" and "a provider may run it":
 *
 *   · the snapshot is re-validated as untrusted data;
 *   · the upload is bounded and contains no credential-shaped file;
 *   · the runtime is recognized, never guessed;
 *   · the provider egress is an explicit allowlist;
 *   · diagnostics are bounded and redacted before they are persisted.
 *
 * ⚠️ NOTHING HERE EXECUTES ANYTHING. The returned script text is handed to the
 * adapter, which runs it only inside the isolated sandbox.
 */

import { sanitizeProjectPath } from "@/lib/ai/agent";
import { hashSource } from "@/lib/mavly/source-hash";
import { planNextAppRouter } from "@/lib/runtime/next-app-router";
import type { RuntimePlan } from "@/lib/runtime/profile";

import type {
  VerificationErrorClass,
  VerificationStage,
} from "./state";
import {
  MAX_DIAGNOSTIC_CHARS,
  MAX_DIAGNOSTIC_LINE_CHARS,
  MAX_DIAGNOSTIC_LINES,
} from "./state";

// ── Upload limits ───────────────────────────────────────────────────────────

/** Matches the generator's own limits, so a verifiable project is a normal one. */
export const VERIFICATION_MAX_FILES = 80;
export const VERIFICATION_MAX_FILE_BYTES = 256 * 1024;
export const VERIFICATION_MAX_TOTAL_BYTES = 1_500_000;

export interface VerificationFile {
  path: string;
  content: string;
  bytes: number;
}

export interface VerificationBundle {
  plan: RuntimePlan;
  files: VerificationFile[];
  totalBytes: number;
  sourceHash: string;
}

export interface PreparationFailure {
  ok: false;
  stage: Extract<VerificationStage, "unsupported_runtime" | "failed" | "configuration_error">;
  errorClass: VerificationErrorClass;
  summary: string;
  diagnostics: string[];
}

export type PreparationResult =
  | { ok: true; bundle: VerificationBundle }
  | PreparationFailure;

// ── Reserved sandbox paths ──────────────────────────────────────────────────

/** The sandbox writes its own markers here; project content may not occupy it. */
export const MARKER_DIRECTORY = ".mavly";
export const INSTALL_EXIT_MARKER = `${MARKER_DIRECTORY}/install.exit`;
export const INSTALL_LOG_MARKER = `${MARKER_DIRECTORY}/install.log`;
export const BUILD_EXIT_MARKER = `${MARKER_DIRECTORY}/build.exit`;
export const BUILD_LOG_MARKER = `${MARKER_DIRECTORY}/build.log`;
export const RUNTIME_EXIT_MARKER = `${MARKER_DIRECTORY}/runtime.exit`;
export const RUNTIME_LOG_MARKER = `${MARKER_DIRECTORY}/runtime.log`;
export const RUNTIME_PID_MARKER = `${MARKER_DIRECTORY}/runtime.pid`;

const SECRET_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".netrc",
  ".git-credentials",
  ".gitconfig",
  ".pypirc",
  ".envrc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "secrets.json",
  "service-account.json",
]);

const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|der|ppk)$/i;

/** Whether a snapshot file must be refused before it could be uploaded. */
export function isSecretPath(path: string): boolean {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (!base) return true;
  if (base === ".env.example") return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (SECRET_BASENAMES.has(base)) return true;
  if (SECRET_EXTENSIONS.test(base)) return true;
  return false;
}

function invalid(summary: string, diagnostics: string[] = []): PreparationFailure {
  return {
    ok: false,
    stage: "failed",
    errorClass: "validation_failed",
    summary,
    diagnostics,
  };
}

function unsupported(
  errorClass: VerificationErrorClass,
  summary: string,
  diagnostics: string[] = [],
): PreparationFailure {
  return { ok: false, stage: "unsupported_runtime", errorClass, summary, diagnostics };
}

/**
 * Re-validate an immutable snapshot and turn it into an upload bundle.
 *
 * The content is treated as untrusted even though it was written by Mavly:
 * a database row can be changed outside this process, and the hash is what
 * ties the upload to the snapshot the user was shown.
 */
export function prepareVerification(
  files: readonly { path: string; content: string }[],
  expectedSourceHash: string,
): PreparationResult {
  if (files.length === 0) {
    return unsupported("unsupported_runtime", "This snapshot has no files to verify.");
  }
  if (files.length > VERIFICATION_MAX_FILES) {
    return unsupported(
      "unsupported_runtime",
      `This snapshot has more than ${VERIFICATION_MAX_FILES} files; verification is bounded to that size.`,
    );
  }

  const seen = new Set<string>();
  const accepted: VerificationFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const safe = sanitizeProjectPath(file.path);
    if (!safe || safe !== file.path) {
      return invalid(
        "A snapshot path is not a safe relative project path, so nothing was uploaded.",
        [`refused path: ${String(file.path).slice(0, 200)}`],
      );
    }
    const segments = safe.split("/");
    if (segments.some((segment) => segment.toLowerCase() === MARKER_DIRECTORY)) {
      return invalid(
        "A snapshot path uses the sandbox's reserved .mavly directory.",
        [`refused path: ${safe.slice(0, 200)}`],
      );
    }
    if (isSecretPath(safe)) {
      return invalid(
        "A snapshot contains a credential-shaped file, so nothing was uploaded.",
        [`refused path: ${safe.slice(0, 200)}`],
      );
    }

    const key = safe.toLowerCase();
    if (seen.has(key)) {
      return invalid(
        "A snapshot contains the same path twice, so nothing was uploaded.",
        [`duplicate path: ${safe.slice(0, 200)}`],
      );
    }
    seen.add(key);

    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > VERIFICATION_MAX_FILE_BYTES) {
      return unsupported(
        "unsupported_runtime",
        `A file exceeds the ${VERIFICATION_MAX_FILE_BYTES}-byte verification limit.`,
        [`path: ${safe.slice(0, 200)}`],
      );
    }
    totalBytes += bytes;
    if (totalBytes > VERIFICATION_MAX_TOTAL_BYTES) {
      return unsupported(
        "unsupported_runtime",
        `The snapshot exceeds the ${VERIFICATION_MAX_TOTAL_BYTES}-byte verification limit.`,
      );
    }

    accepted.push({ path: safe, content: file.content, bytes });
  }

  const sourceHash = hashSource(accepted);
  if (!expectedSourceHash || sourceHash !== expectedSourceHash) {
    return {
      ok: false,
      stage: "configuration_error",
      errorClass: "snapshot_mismatch",
      summary:
        "The snapshot content no longer matches the hash recorded when it was created, so it was not verified.",
      diagnostics: [],
    };
  }

  const plan = planNextAppRouter(accepted);
  if (plan.ok === false) {
    if (plan.code === "unsupported_runtime") {
      return unsupported("unsupported_runtime", plan.summary, plan.diagnostics);
    }
    return {
      ok: false,
      stage: "failed",
      errorClass: plan.code,
      summary: plan.summary,
      diagnostics: plan.diagnostics,
    };
  }

  return {
    ok: true,
    bundle: {
      plan: plan.plan,
      files: accepted,
      totalBytes,
      sourceHash,
    },
  };
}

/** The exact bytes handed to the provider. Paths are already validated. */
export function encodeVerificationFiles(
  files: readonly VerificationFile[],
): { path: string; content: Buffer }[] {
  return files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.content, "utf8"),
  }));
}

// ── Commands ────────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A fail-soft shell wrapper for one detached stage.
 *
 * The exit status is written to a marker file, so a later worker tick can read
 * the outcome without reopening the detached command (the provider has no
 * reattach-by-command-id operation).
 */
export function detachedStageScript(stage: "install" | "build", plan: RuntimePlan): string {
  const command = stage === "install" ? plan.install : plan.build;
  const log = stage === "install" ? INSTALL_LOG_MARKER : BUILD_LOG_MARKER;
  const exit = stage === "install" ? INSTALL_EXIT_MARKER : BUILD_EXIT_MARKER;
  const invocation = [command.cmd, ...command.args].map(shellQuote).join(" ");
  return [
    "set +e",
    `mkdir -p ${shellQuote(MARKER_DIRECTORY)}`,
    `${invocation} > ${shellQuote(log)} 2>&1`,
    "code=$?",
    `printf '%s' "$code" > ${shellQuote(exit)}`,
    "exit 0",
  ].join("\n");
}

/**
 * Start the validated production runtime detached and record its pid and exit
 * status. The command comes from the fixed runtime profile, never from the
 * generated `start` script. The pid file is what lets a later tick stop it
 * without a provider reattach-by-command capability.
 */
export function detachedRuntimeScript(plan: RuntimePlan): string {
  const invocation = [plan.runtime.cmd, ...plan.runtime.args]
    .map(shellQuote)
    .join(" ");
  return [
    "set +e",
    `mkdir -p ${shellQuote(MARKER_DIRECTORY)}`,
    `rm -f ${shellQuote(RUNTIME_EXIT_MARKER)} ${shellQuote(RUNTIME_PID_MARKER)}`,
    `${invocation} > ${shellQuote(RUNTIME_LOG_MARKER)} 2>&1 &`,
    "pid=$!",
    `printf '%s' "$pid" > ${shellQuote(RUNTIME_PID_MARKER)}`,
    'wait "$pid"',
    "code=$?",
    `printf '%s' "$code" > ${shellQuote(RUNTIME_EXIT_MARKER)}`,
    "exit 0",
  ].join("\n");
}

/**
 * ⚠️ SANDBOX-LOCAL ONLY. The request targets a constant host, port and path;
 * nothing from the project or the browser reaches it. No response body is
 * read, so a generated page cannot flood the worker with output.
 */
const HEALTH_SCRIPT = [
  'const http=require("http");',
  'const port=Number(process.argv[1]);',
  'const path=String(process.argv[2]||"/");',
  'const timeout=Number(process.argv[3]||5000);',
  'if(!port||!timeout){process.stdout.write("error:bad_args");process.exit(0);}',
  'let done=false;',
  'const finish=function(value){if(done)return;done=true;process.stdout.write(value);process.exit(0);};',
  'const req=http.get({host:"127.0.0.1",port:port,path:path,timeout:timeout,headers:{"user-agent":"mavly-verification"}},function(res){res.resume();finish("status:"+res.statusCode);});',
  'req.on("timeout",function(){try{req.destroy();}catch(e){}finish("timeout");});',
  'req.on("error",function(e){finish("error:"+String((e&&e.code)||"unknown"));});',
].join("");

export function runtimeHealthCommand(
  plan: RuntimePlan,
  requestTimeoutMs: number,
): { cmd: "node"; args: string[] } {
  return {
    cmd: "node",
    args: [
      "-e",
      HEALTH_SCRIPT,
      String(plan.runtimePort),
      plan.runtimeHealthPath,
      String(Math.max(1_000, Math.min(10_000, requestTimeoutMs))),
    ],
  };
}

export type HealthObservation =
  | { kind: "status"; status: number }
  | { kind: "timeout" }
  | { kind: "unreachable"; code: string }
  | { kind: "unknown" };

export function parseHealthOutput(raw: string | null | undefined): HealthObservation {
  const value = (raw ?? "").trim().slice(0, 80);
  if (/^status:\d{3}$/.test(value)) {
    return { kind: "status", status: Number.parseInt(value.slice(7), 10) };
  }
  if (value === "timeout") return { kind: "timeout" };
  if (/^error:[A-Za-z0-9_.-]{1,40}$/.test(value)) {
    return { kind: "unreachable", code: value.slice(6) };
  }
  return { kind: "unknown" };
}

/** A redirect still proves the server is listening; a 4xx/5xx does not. */
export function isHealthyHttpStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

/**
 * Environment for both stages. Telemetry is disabled; no secret is injected.
 *
 * ⚠️ `NODE_ENV` IS DELIBERATELY NOT SET HERE. `npm ci`/`npm install` treats
 * `NODE_ENV=production` as `--omit=dev`, which would drop the devDependencies a
 * Next.js build needs (TypeScript, Tailwind, @types). `next build` sets its own
 * production mode.
 */
export function verificationStageEnv(): Record<string, string> {
  return {
    NEXT_TELEMETRY_DISABLED: "1",
    CI: "1",
  };
}

// ── Network egress ──────────────────────────────────────────────────────────

/**
 * The only hosts a verification build may reach. Dependency lifecycle scripts
 * run inside the microVM, so the allowlist is what keeps their effects local.
 */
export const VERIFICATION_ALLOWED_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

export interface VerificationNetworkPolicy {
  mode: "allowlist";
  allowedHosts: readonly string[];
}

export function verificationNetworkPolicy(): VerificationNetworkPolicy {
  return { mode: "allowlist", allowedHosts: VERIFICATION_ALLOWED_HOSTS };
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_LIKE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const OPENAI_TOKEN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const NPM_AUTH = /\b(?:_authToken|_auth|_password)\s*=\s*\S+/gi;
const KEY_VALUE_SECRET =
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[^\s"',;]{4,}/gi;
const URL_CREDENTIALS = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

function redactLine(line: string): string {
  return line
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARS, "")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(JWT_LIKE, "[redacted]")
    .replace(BEARER_LIKE, "$1 [redacted]")
    .replace(GITHUB_TOKEN, "[redacted]")
    .replace(OPENAI_TOKEN, "[redacted]")
    .replace(AWS_KEY, "[redacted]")
    .replace(NPM_AUTH, "[redacted]")
    .replace(KEY_VALUE_SECRET, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      const key = match.slice(0, match.indexOf(separator));
      return `${key}${separator}[redacted]`;
    })
    .trim();
}

export interface SanitizedDiagnostics {
  lines: string[];
  truncated: boolean;
}

/**
 * Bound and redact command output before it is persisted.
 *
 * Only the tail is kept: a compiler reports the error after the noise, and the
 * tail is also what a human needs. Nothing here guesses at the project's
 * correctness.
 */
export function sanitizeDiagnostics(raw: string | null | undefined): SanitizedDiagnostics {
  if (!raw) return { lines: [], truncated: false };

  const rawLines = raw
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/)
    .map(redactLine)
    .filter((line) => line.length > 0);

  const truncated = rawLines.length > MAX_DIAGNOSTIC_LINES;
  const tail = truncated ? rawLines.slice(-MAX_DIAGNOSTIC_LINES) : rawLines;

  const lines: string[] = [];
  let used = 0;
  for (const line of tail) {
    const clipped =
      line.length > MAX_DIAGNOSTIC_LINE_CHARS
        ? `${line.slice(0, MAX_DIAGNOSTIC_LINE_CHARS)}…`
        : line;
    if (used + clipped.length + 1 > MAX_DIAGNOSTIC_CHARS) break;
    lines.push(clipped);
    used += clipped.length + 1;
  }

  return { lines, truncated: truncated || lines.length < tail.length };
}

/** A one-line, sanitized human summary for the status API. */
export function summarizeDiagnostics(sanitized: SanitizedDiagnostics): string | null {
  const first = sanitized.lines[0];
  if (!first) return null;
  return first.slice(0, MAX_DIAGNOSTIC_LINE_CHARS);
}

// ── Failure classification ──────────────────────────────────────────────────

const DEPENDENCY_RESOLUTION = [
  /\bE404\b/i,
  /\bETARGET\b/i,
  /\bERESOLVE\b/i,
  /\bEINTEGRITY\b/i,
  /No matching version found/i,
  /Could not resolve dependency/i,
  /notarget/i,
  /certificate has expired/i,
];

const MISSING_DEPENDENCY = [
  /Cannot find module ['"]?(?:next|react|react-dom)['"]?/i,
  /next: not found/i,
  /ERR_MODULE_NOT_FOUND/i,
];

/**
 * Map a failed stage to an allowlisted reason. The raw text is never the
 * class; it only informs which of a few fixed classes applies.
 */
export function classifyStageFailure(
  stage: "install" | "build",
  output: SanitizedDiagnostics,
): VerificationErrorClass {
  const text = output.lines.join("\n");
  if (stage === "install") {
    return DEPENDENCY_RESOLUTION.some((pattern) => pattern.test(text))
      ? "dependency_resolution_failed"
      : "install_failed";
  }
  if (MISSING_DEPENDENCY.some((pattern) => pattern.test(text))) {
    return "dependency_resolution_failed";
  }
  return "build_failed";
}

const PORT_BINDING = [
  /\bEADDRINUSE\b/i,
  /address already in use/i,
  /\bEACCES\b/i,
  /permission denied.*(?:port|bind)/i,
];

/**
 * A non-zero runtime exit is either an environment/port problem or an
 * application startup failure. Only the latter is repair-eligible.
 */
export function classifyRuntimeStartFailure(
  output: SanitizedDiagnostics,
): VerificationErrorClass {
  const text = output.lines.join("\n");
  return PORT_BINDING.some((pattern) => pattern.test(text))
    ? "runtime_port_unavailable"
    : "runtime_start_failed";
}
