/**
 * ═══ LIVE RUNTIME POLICY — PURE ════════════════════════════════════════════
 *
 * This phase executes ONE framework: React + Vite. Everything below is
 * deterministic and testable without a provider, a database or a network:
 *
 *   · which persisted project is a runnable React + Vite app;
 *   · the exact, fixed commands for install / dev server / build;
 *   · the provider preview host shape the workspace may embed;
 *   · bounded, redacted terminal output.
 *
 * ⚠️ NO PACKAGE SCRIPT IS EXECUTED. Mavly never runs `npm run dev` or any
 * lifecycle hook from the generated project: it runs the installed Vite binary
 * directly with fixed arguments. Dependency installation uses `--ignore-scripts`,
 * so `preinstall`/`install`/`postinstall`/`prepare` from generated code do not
 * run. The compatibility tradeoff is documented in the Phase 13 doc: a project
 * whose install genuinely needs a native build step is refused/failed honestly
 * instead of silently executing untrusted code.
 */

import type { RuntimeProjectSupport, RuntimeUnsupportedReason } from "./types";
import {
  RUNTIME_DEV_LOG,
  RUNTIME_INSTALL_LOG,
  RUNTIME_PROJECT_DIR,
  type SyncSourceFile,
} from "./paths";

export { RUNTIME_DEV_LOG, RUNTIME_INSTALL_LOG, RUNTIME_PROJECT_DIR };

/** Only E2B Cloud hosts are accepted for embedding. */
export const E2B_PREVIEW_DOMAIN = "e2b.app";

export const VITE_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
] as const;

export const LOCKFILES = {
  npm: "package-lock.json",
  yarn: "yarn.lock",
  pnpm: "pnpm-lock.yaml",
  bun: "bun.lockb",
} as const;

function unsupported(
  reason: RuntimeUnsupportedReason,
  detail: string,
): RuntimeProjectSupport {
  return {
    supported: false,
    framework: null,
    reason,
    detail,
    entryHtml: null,
    hasLockfile: false,
    hasViteConfig: false,
    scriptWarnings: [],
  };
}

function dependencyMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The `<script type="module" src="...">` entry declared by index.html, resolved
 * to a repo-relative path. A URL, a data: URL or a path outside the project is
 * not an entry this runtime can serve.
 */
export function moduleEntryFromHtml(html: string): string | null {
  const tags = html.match(/<script\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!src) continue;
    const value = src[1].trim();
    if (!value || /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("data:")) continue;
    const withoutQuery = value.split(/[?#]/)[0];
    const normalized = withoutQuery.startsWith("/")
      ? withoutQuery.slice(1)
      : withoutQuery;
    if (!normalized || normalized.includes("..")) continue;
    return normalized;
  }
  return null;
}

/**
 * Detect a supported project from AUTHORITATIVE persisted files. The planner's
 * claim that a project is "vite" is never trusted on its own.
 */
export function detectRuntimeProject(files: readonly SyncSourceFile[]): RuntimeProjectSupport {
  const byPath = new Map(files.map((file) => [file.path, file.content]));

  const packageJson = byPath.get("package.json");
  if (!packageJson) {
    return unsupported("missing_package_json", "This project has no package.json at its root.");
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(packageJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return unsupported("invalid_package_json", "package.json is not a JSON object.");
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    return unsupported("invalid_package_json", "package.json could not be parsed as JSON.");
  }

  const dependencies = {
    ...dependencyMap(manifest.dependencies),
    ...dependencyMap(manifest.devDependencies),
  };
  if (!dependencies.react) {
    return unsupported(
      "missing_react_dependency",
      "package.json does not declare the `react` dependency.",
    );
  }
  if (!dependencies.vite) {
    return unsupported(
      "missing_vite_dependency",
      "package.json does not declare the `vite` dependency.",
    );
  }

  if (byPath.has(LOCKFILES.yarn) || byPath.has(LOCKFILES.pnpm) || byPath.has(LOCKFILES.bun)) {
    return unsupported(
      "unsupported_package_manager",
      "Only npm projects are supported by the isolated runtime. yarn/pnpm/bun lockfiles are refused rather than converted.",
    );
  }

  const indexHtml = byPath.get("index.html");
  if (!indexHtml) {
    return unsupported("missing_index_html", "This project has no root index.html entry point.");
  }

  const entry = moduleEntryFromHtml(indexHtml);
  if (!entry) {
    return unsupported(
      "missing_entry_module",
      "index.html does not reference a local `<script type=\"module\">` entry.",
    );
  }
  if (!byPath.has(entry)) {
    return unsupported(
      "missing_entry_module",
      `index.html references ${entry}, which is not part of the project.`,
    );
  }

  const scripts = dependencyMap(manifest.scripts);
  const warnings: string[] = [];
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    if (typeof scripts[hook] === "string" && scripts[hook].trim()) {
      warnings.push(`package.json declares a \`${hook}\` lifecycle script; Mavly does not execute it.`);
    }
  }
  if (typeof scripts.dev === "string" && !/^\s*vite(\s|$)/.test(scripts.dev)) {
    warnings.push("package.json's `dev` script is not a plain Vite command; Mavly runs the local Vite binary directly instead.");
  }

  return {
    supported: true,
    framework: "react_vite",
    reason: null,
    detail: null,
    entryHtml: "index.html",
    hasLockfile: byPath.has(LOCKFILES.npm),
    hasViteConfig: VITE_CONFIG_FILES.some((file) => byPath.has(file)),
    scriptWarnings: warnings,
  };
}

// ── Fixed commands ──────────────────────────────────────────────────────────

export interface RuntimeCommand {
  command: string;
  args: readonly string[];
  cwd: string;
}

/**
 * Install dependencies with npm. `--ignore-scripts` is the security decision:
 * generated lifecycle scripts never run. `npm ci` is used only when a lockfile
 * exists, so the resolved tree matches what the project committed.
 */
export function installCommand(input: { hasLockfile: boolean }): RuntimeCommand {
  const args = input.hasLockfile
    ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress"]
    : ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress"];
  return { command: "npm", args, cwd: RUNTIME_PROJECT_DIR };
}

/** The validated dev server. `--strictPort` makes a busy port fail instead of moving silently. */
export function devServerCommand(input: { port: number }): RuntimeCommand {
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) {
    throw new Error("Invalid runtime port");
  }
  return {
    command: "./node_modules/.bin/vite",
    args: ["--host", "0.0.0.0", "--port", String(input.port), "--strictPort"],
    cwd: RUNTIME_PROJECT_DIR,
  };
}

export function buildCommand(): RuntimeCommand {
  return { command: "./node_modules/.bin/vite", args: ["build"], cwd: RUNTIME_PROJECT_DIR };
}

/** A fixed command that flushes the log file; no shell interpolation is accepted. */
export function readLogCommand(logPath: string): RuntimeCommand {
  if (logPath !== RUNTIME_DEV_LOG && logPath !== RUNTIME_INSTALL_LOG) {
    throw new Error("Unknown runtime log");
  }
  return { command: "tail", args: ["-c", "65536", logPath], cwd: RUNTIME_PROJECT_DIR };
}

/** Shell-quote one already-trusted argument. The adapter calls this. */
export function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(command: RuntimeCommand): string {
  return [command.command, ...command.args].map(quoteShellArg).join(" ");
}

// ── Preview URL ─────────────────────────────────────────────────────────────

/**
 * Validate the provider-derived host and build the URL that may be embedded.
 * A redirect target, a client-supplied URL, a different provider's domain or a
 * host with a path/query is refused. This is the only place a preview URL is
 * constructed.
 */
export function previewUrlFromProvider(
  host: string,
  expectedDomain: string = E2B_PREVIEW_DOMAIN,
): string | null {
  if (typeof host !== "string") return null;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed || trimmed.length > 240) return null;
  if (trimmed.includes("/") || trimmed.includes("?") || trimmed.includes("#")) return null;
  const suffix = `.${expectedDomain.toLowerCase()}`;
  if (!trimmed.endsWith(suffix)) return null;
  const label = trimmed.slice(0, -suffix.length);
  if (!label || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(expectedDomain.toLowerCase())) return null;
  return `https://${trimmed}`;
}

/** Parse a stored preview URL back into the host that produced it, or null. */
export function previewHostFromUrl(
  url: string | null,
  expectedDomain: string = E2B_PREVIEW_DOMAIN,
): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    return null;
  }
  if (!previewUrlFromProvider(parsed.hostname, expectedDomain)) return null;
  return parsed.hostname;
}

// ── Logs ────────────────────────────────────────────────────────────────────

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SECRET_PATTERN =
  /\b(?:e2b_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,})\b/g;

/**
 * Bound and redact terminal output before it is stored or shown. The last
 * bytes win: a failing install says why at the end, and unbounded logs are not
 * persisted.
 */
export function sanitizeTerminalOutput(raw: unknown, maxChars = 16_384): string {
  if (typeof raw !== "string" || !raw) return "";
  const withoutAnsi = raw.replace(ANSI_PATTERN, "");
  const lines = withoutAnsi
    .split(/\r?\n/)
    .slice(-600)
    .map((line) =>
      line
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(SECRET_PATTERN, "[redacted-secret]")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
        .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[url]")
        .slice(0, 1_000),
    )
    .filter((line) => line.length > 0);
  const joined = lines.join("\n");
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/** Join additional output onto an existing bounded log. */
export function appendTerminalOutput(
  existing: string,
  addition: string,
  maxChars = 16_384,
): string {
  return sanitizeTerminalOutput([existing, addition].filter(Boolean).join("\n"), maxChars);
}

/**
 * A ready preview is proven by one server-side request to the provider host.
 * Only a 2xx/3xx answer counts; a TCP port alone is not an application.
 */
export function isReadyStatus(status: number): boolean {
  return status >= 200 && status < 400;
}
