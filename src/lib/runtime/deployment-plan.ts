/**
 * ═══ FULL-STACK DEPLOYMENT PROFILE — WHAT MAY RUN SERVER CODE? ══════════════
 *
 * Verification already answers "does this build?". Phase 5 needs a second,
 * narrower answer before a build is allowed onto a public runtime:
 *
 *   · is this the one supported production profile (Next.js App Router)?
 *   · does package.json still declare the accepted install/build/start shape?
 *   · is the project explicitly NOT a static export (which would silently drop
 *     every route handler)?
 *   · does it fit the deployment file/size budget?
 *
 * ⚠️ NOTHING HERE GUESSES. An unknown format returns `unsupported_runtime`; an
 * oversized or path-unsafe file set returns `invalid_snapshot`. The caller must
 * never substitute a static publish for a refused full-stack deployment.
 *
 * This module is pure (no Supabase, no provider, no env) so the profile rules
 * are unit-tested directly.
 */

import { hashSource } from "@/lib/mavly/source-hash";
import { isAgentControlPath } from "@/lib/project-rules/rules";

import { planNextAppRouter } from "./next-app-router";
import type { SourceFile } from "./profile";

export type FullstackDeploymentPlan = {
  profile: "next-app-router";
  nodeImage: string;
  sourceHash: string;
  fileCount: number;
  totalBytes: number;
  /** The route-handler path pattern (`app/.../route.{ts,js}`) — real server request handlers. */
  serverRoutePaths: string[];
  /** A root (or src/) middleware module. */
  hasMiddleware: boolean;
  /** Any module declaring a server-action directive. */
  usesServerActions: boolean;
  /**
   * The generated source references `DATABASE_URL`. The deployment is refused
   * unless a configured, synced database contract exists — a build that can
   * only fail at request time is not a supported deployment.
   */
  requiresDatabase: boolean;
  files: SourceFile[];
};

export type FullstackProfileCode =
  "unsupported_runtime" | "invalid_manifest" | "invalid_lockfile" | "invalid_snapshot";

export type FullstackResolution =
  | { ok: true; plan: FullstackDeploymentPlan }
  | {
      ok: false;
      code: FullstackProfileCode;
      summary: string;
      diagnostics: string[];
    };

/** Deliberately bounded: a generated project is small, and a deployment is not a CDN upload. */
export const FULLSTACK_MAX_FILES = 1_200;
export const FULLSTACK_MAX_TOTAL_BYTES = 12_000_000;
export const FULLSTACK_MAX_FILE_BYTES = 2_000_000;

/** Scan bound for "does this project use a server-side database?" detection. */
const DATABASE_REFERENCE_SCAN_BYTES = 400_000;

const ROUTE_HANDLER = /^app\/(?:.+\/)?route\.(?:ts|js|tsx|jsx)$/;
const MIDDLEWARE = /^(?:src\/)?middleware\.(?:ts|js)$/;
const NEXT_CONFIG = /^(?:next\.config\.(?:js|mjs|cjs|ts)|next\.config)$/;
const STATIC_EXPORT = /output\s*:\s*["']export["']/;
const SERVER_ACTION = /["']use server["']/;
const DATABASE_REFERENCE = /\bDATABASE_URL\b/;

function failure(
  code: FullstackProfileCode,
  summary: string,
  diagnostics: string[] = [],
): FullstackResolution {
  return { ok: false, code, summary, diagnostics };
}

/**
 * A path that must never reach a provider build. Generated files are already
 * sanitized on write; this re-checks the snapshot because a snapshot is read
 * back from the database and is therefore not automatically trusted.
 */
export function unsafeDeploymentPath(path: string): boolean {
  if (!path || path.length > 512) return true;
  if (path.startsWith("/") || path.startsWith("\\")) return true;
  if (path.includes("\\")) return true;
  if (path.includes("\u0000")) return true;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return true;
  }
  // `.env*`, private keys and VCS internals are never deployed from a snapshot.
  return segments.some(
    (segment) =>
      segment === ".git" ||
      segment === "node_modules" ||
      segment.startsWith(".env") ||
      segment === ".npmrc" ||
      segment === "id_rsa" ||
      segment === "id_ed25519",
  );
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function isHttpSafePath(path: string): boolean {
  return ROUTE_HANDLER.test(path);
}

function scan(file: SourceFile, pattern: RegExp): boolean {
  return pattern.test(
    file.content.length > DATABASE_REFERENCE_SCAN_BYTES
      ? file.content.slice(0, DATABASE_REFERENCE_SCAN_BYTES)
      : file.content,
  );
}

/**
 * Resolve a snapshot into a deployable full-stack plan, or explain precisely
 * why it is not one. The source hash returned here is the hash of the exact
 * file set that will be uploaded, so the caller can bind the deployment to it.
 */
export function planFullstackDeployment(
  files: readonly SourceFile[]): FullstackResolution {
  if (files.length === 0) {
    return failure("invalid_snapshot", "The verified snapshot has no files.");
  }
  if (files.length > FULLSTACK_MAX_FILES) {
    return failure(
      "invalid_snapshot",
      `This snapshot has ${files.length} files; a deployment supports at most ${FULLSTACK_MAX_FILES}.`,
    );
  }

  /**
   * ⚠️ `.mavly` IS HASHED BUT NEVER UPLOADED. The control files are part of the
   * snapshot (so restore and the verification hash stay consistent), but they
   * are Mavly's server-owned notes, not website source. They are excluded from
   * the provider upload without changing the hash the verification recorded.
   */
  const deployable = files.filter((file) => !isAgentControlPath(file.path));
  if (deployable.length === 0) {
    return failure("invalid_snapshot", "The verified snapshot has no deployable files.");
  }

  let totalBytes = 0;
  for (const file of deployable) {
    if (unsafeDeploymentPath(file.path)) {
      return failure(
        "invalid_snapshot",
        "The snapshot contains a path that cannot be deployed safely.",
        [`Refused path: ${file.path.slice(0, 200)}`],
      );
    }
    const size = byteLength(file.content);
    if (size > FULLSTACK_MAX_FILE_BYTES) {
      return failure(
        "invalid_snapshot",
        `A snapshot file is larger than ${FULLSTACK_MAX_FILE_BYTES} bytes.`,
        [`Refused path: ${file.path.slice(0, 200)}`],
      );
    }
    totalBytes += size;
    if (totalBytes > FULLSTACK_MAX_TOTAL_BYTES) {
      return failure(
        "invalid_snapshot",
        `The snapshot is larger than ${FULLSTACK_MAX_TOTAL_BYTES} bytes.`,
      );
    }
  }

  /**
   * A static export cannot run route handlers, server actions or middleware.
   * Deploying it would look like success and serve a site with every backend
   * endpoint missing, so it is refused here rather than discovered later.
   */
  const nextConfig = deployable.find((file) => NEXT_CONFIG.test(file.path));
  if (nextConfig && STATIC_EXPORT.test(nextConfig.content)) {
    return failure(
      "unsupported_runtime",
      "This project is configured as a static export (output: 'export'), so server routes cannot run.",
      ["Remove the static export configuration to deploy a full-stack application."],
    );
  }

  const resolved = planNextAppRouter(deployable);
  if ("code" in resolved) {
    return failure(resolved.code, resolved.summary, resolved.diagnostics);
  }

  const serverRoutePaths = deployable
    .map((file) => file.path)
    .filter((path) => isHttpSafePath(path))
    .sort();

  return {
    ok: true,
    plan: {
      profile: "next-app-router",
      nodeImage: resolved.plan.nodeImage,
      /** The full snapshot hash, including the control files the verification saw. */
      sourceHash: hashSource(files),
      fileCount: deployable.length,
      totalBytes,
      serverRoutePaths,
      hasMiddleware: deployable.some((file) => MIDDLEWARE.test(file.path)),
      usesServerActions: deployable.some(
        (file) => /\.(?:ts|tsx|js|jsx)$/.test(file.path) && scan(file, SERVER_ACTION),
      ),
      requiresDatabase: deployable.some(
        (file) =>
          /\.(?:ts|tsx|js|jsx)$/.test(file.path) && scan(file, DATABASE_REFERENCE),
      ),
      files: deployable.map((file) => ({ path: file.path, content: file.content })),
    },
  };
}

/**
 * A snapshot is deployable only when its re-computed hash equals the hash the
 * verification recorded. This is the integrity join between phases: the bytes
 * that passed the build are the bytes that are deployed.
 */
export function snapshotHashMatches(
  computed: string,
  verified: string | null | undefined,
): boolean {
  return Boolean(computed) && Boolean(verified) && computed === verified;
}
