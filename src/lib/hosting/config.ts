/**
 * ═══ HOSTING MODE — WHICH PUBLISH PATH A PROJECT USES ═══════════════════════
 *
 * Two hosting paths coexist deliberately:
 *
 *   legacy / `vercel`  — one Vercel project and one exact project domain per
 *                        website (the current production path);
 *   `shared`           — an immutable published version inside Mavly, served by
 *                        the shared tenant runtime at `<project-id>.mavly.xyz`.
 *
 * ⚠️ THE DEFAULT IS THE LEGACY PATH. Shared hosting is enabled only by an
 * explicit server-side flag AND an explicit project cohort, because it depends
 * on operator-side wildcard DNS/TLS that this repository cannot configure or
 * verify. Turning the flag on must never move existing published websites.
 *
 *   MAVLY_HOSTING_MODE=shared
 *   MAVLY_SHARED_HOSTING_PROJECTS=<project-id>,<project-id>   (or `*`)
 *
 * An empty/absent cohort list means NO project uses shared hosting, even when
 * the mode is `shared`. `*` is the explicit "all projects" opt-in, intended for
 * after the cohort has been verified.
 *
 * ⚠️ SERVER-ONLY. This module is read by route handlers and the publish
 * service. It holds no secret, but it must not be imported into a client
 * component: the browser must never decide which hosting path is authoritative.
 */

export type HostingMode = "vercel" | "shared";

export interface HostingConfig {
  /** The configured mode. `vercel` unless explicitly opted in. */
  mode: HostingMode;
  /** `"*"` for every project, otherwise the explicit project-id cohort. */
  cohort: ReadonlySet<string> | "*";
}

const SHARED_VALUES = new Set(["1", "true", "yes", "on", "shared"]);

function parseCohort(raw: string | undefined): ReadonlySet<string> | "*" {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return new Set<string>();
  if (trimmed === "*") return "*";
  return new Set(
    trimmed
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function readHostingConfig(env: NodeJS.ProcessEnv = process.env): HostingConfig {
  const raw = (env.MAVLY_HOSTING_MODE ?? "").trim().toLowerCase();
  const mode: HostingMode = SHARED_VALUES.has(raw) ? "shared" : "vercel";
  return { mode, cohort: parseCohort(env.MAVLY_SHARED_HOSTING_PROJECTS) };
}

/** True only for an explicitly opted-in project in `shared` mode. */
export function isSharedHostingProject(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const config = readHostingConfig(env);
  if (config.mode !== "shared") return false;
  if (config.cohort === "*") return true;
  return config.cohort.has(projectId.trim().toLowerCase());
}

/**
 * Whether the public tenant runtime may serve at all. This is intentionally the
 * SAME `shared` mode switch: a deployment that has not opted in must answer 404
 * for every tenant host rather than start serving because a Host header
 * appeared. Rolling the mode back therefore disables public tenant serving
 * without deleting any published version.
 */
export function isSharedHostingRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readHostingConfig(env).mode === "shared";
}

/** Deterministic display name for a row whose provider is `shared`. */
export function sharedDeploymentName(projectId: string): string {
  return `mavly-shared-${projectId}`.slice(0, 100);
}

/**
 * How many superseded versions are retained per project. The active version is
 * always kept; this bound applies to history only, so a project cannot grow
 * without limit and a rollback still has recent targets.
 */
export const PUBLISHED_VERSION_RETENTION = 5;
