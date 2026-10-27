/**
 * ═══ ANDROID BUILD POLICY ═══════════════════════════════════════════════════
 *
 * Everything between an immutable snapshot and a verified APK:
 *
 *   · re-validate the snapshot source against the Android contract;
 *   · upload exactly that source, never live project files;
 *   · run one fixed Gradle task with a pinned toolchain and no network;
 *   · bound and redact the log;
 *   · validate the APK archive, package id, size and checksum.
 *
 * ⚠️ NOTHING HERE RUNS ON A MAVLY HOST. The returned scripts are handed to the
 * isolated provider adapter and executed only inside its microVM.
 */

import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

import { hashSource } from "@/lib/mavly/source-hash";
import { sanitizeDiagnostics, summarizeDiagnostics } from "@/lib/sandbox/policy";

import {
  androidMainActivityPath,
  validateAndroidProject,
  type AndroidSourceFile,
} from "./contract";
import { ANDROID_ARTIFACT_MAX_BYTES } from "./build-config";
import type { AndroidBuildErrorClass } from "./build-state";

export const ANDROID_BUILD_MARKER_DIR = ".mavly";
export const ANDROID_BUILD_EXIT_MARKER = ".mavly/build.exit";
export const ANDROID_BUILD_LOG = ".mavly/build.log";
export const ANDROID_BUILD_TAIL = ".mavly/build.tail";
export const ANDROID_ARTIFACT_PATH = "app/build/outputs/apk/debug/app-debug.apk";
export const ANDROID_ARTIFACT_COPY = ".mavly/artifact.apk";
export const ANDROID_ARTIFACT_FILE_NAME = "app-debug.apk";
export const ANDROID_ARTIFACT_CONTENT_TYPE = "application/vnd.android.package-archive";
export const ANDROID_ARTIFACT_MAX_UNCOMPRESSED_BYTES = 400 * 1024 * 1024;
export const ANDROID_ARTIFACT_MAX_ENTRIES = 5_000;
export const ANDROID_LOG_TAIL_MAX_BYTES = 262_144;
export const ANDROID_LOG_EXCERPT_MAX_CHARS = 32_768;

/** Exactly one Gradle task, offline, with no daemon and no user-supplied args. */
export const ANDROID_BUILD_COMMAND =
  "gradle :app:assembleDebug --no-daemon --offline --stacktrace --console=plain";

export interface AndroidBuildBundle {
  files: AndroidSourceFile[];
  sourceHash: string;
  packageName: string;
  applicationId: string;
  mainActivityPath: string;
}

export type AndroidBuildPreparation =
  | { ok: true; bundle: AndroidBuildBundle }
  | { ok: false; errorClass: AndroidBuildErrorClass; summary: string; diagnostics: string[] };

/**
 * Re-validate the snapshot as untrusted data and prove it is the exact source
 * the build row recorded. The caller passes files read from the immutable
 * snapshot through the service-role client.
 */
export function prepareAndroidBuildSource(
  files: readonly AndroidSourceFile[],
  expectedHash: string,
  expectedPackage: string,
): AndroidBuildPreparation {
  const actualHash = hashSource(files);
  if (!expectedHash || actualHash !== expectedHash) {
    return {
      ok: false,
      errorClass: "snapshot_mismatch",
      summary: "The build snapshot no longer matches the hash recorded when it was queued.",
      diagnostics: [],
    };
  }

  const contract = validateAndroidProject(files, expectedPackage);
  if (contract.ok === false) {
    return {
      ok: false,
      errorClass: "source_invalid",
      summary: contract.error,
      diagnostics: contract.violations.slice(0, 20),
    };
  }

  return {
    ok: true,
    bundle: {
      files: files.map((file) => ({ path: file.path, content: file.content })),
      sourceHash: actualHash,
      packageName: contract.contract.packageName,
      applicationId: contract.contract.applicationId,
      mainActivityPath:
        contract.contract.mainActivityPath ?? androidMainActivityPath(contract.contract.packageName),
    },
  };
}

/** A fail-soft detached build that always writes an exit marker. */
export function androidBuildScript(): string {
  return [
    "set +e",
    `mkdir -p ${ANDROID_BUILD_MARKER_DIR}`,
    `rm -f ${ANDROID_BUILD_EXIT_MARKER} ${ANDROID_BUILD_LOG}`,
    `${ANDROID_BUILD_COMMAND} > ${ANDROID_BUILD_LOG} 2>&1`,
    "code=$?",
    `printf '%s' "$code" > ${ANDROID_BUILD_EXIT_MARKER}`,
    "exit 0",
  ].join("\n");
}

/** Copy only a bounded tail before reading, so a huge log cannot exhaust the worker. */
export function androidLogTailScript(): string {
  return `set +e; mkdir -p ${ANDROID_BUILD_MARKER_DIR}; tail -c ${ANDROID_LOG_TAIL_MAX_BYTES} ${ANDROID_BUILD_LOG} > ${ANDROID_BUILD_TAIL} 2>/dev/null; true`;
}

/**
 * The package line from aapt, bounded by the adapter's exec output cap. The
 * caller runs it against a copy written from the exact bytes it will upload, so
 * a background build process cannot swap the package identity after validation.
 */
export function androidAaptCommand(path: string = ANDROID_ARTIFACT_COPY): { cmd: "sh"; args: string[] } {
  if (path !== ANDROID_ARTIFACT_COPY && path !== ANDROID_ARTIFACT_PATH) {
    throw new Error("INVALID_AAPT_PATH");
  }
  return {
    cmd: "sh",
    args: ["-c", `aapt dump badging ${path} 2>/dev/null | grep -m1 '^package:'`],
  };
}

/**
 * Report the artifact size before the bytes are read. `readFile` buffers the
 * whole provider file before it can enforce its limit, so an oversized or
 * specially crafted output must be refused from metadata alone.
 */
export function androidArtifactSizeCommand(
  path: string = ANDROID_ARTIFACT_PATH,
): { cmd: "sh"; args: string[] } {
  if (path !== ANDROID_ARTIFACT_PATH) {
    throw new Error("INVALID_ARTIFACT_PATH");
  }
  return {
    cmd: "sh",
    args: ["-c", `wc -c < ${path} 2>/dev/null || echo 0`],
  };
}

export function parseArtifactSize(raw: string | null | undefined): number | null {
  const value = (raw ?? "").trim();
  if (!/^\d{1,12}$/.test(value)) return null;
  const size = Number.parseInt(value, 10);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

export function parseAaptPackage(output: string | null | undefined): {
  applicationId: string | null;
  versionCode: string | null;
  versionName: string | null;
} {
  const text = (output ?? "").slice(0, 8_000);
  const name = /package:\s+name='([^']+)'/.exec(text)?.[1] ?? null;
  const versionCode = /versionCode='([^']+)'/.exec(text)?.[1] ?? null;
  const versionName = /versionName='([^']+)'/.exec(text)?.[1] ?? null;
  return { applicationId: name, versionCode, versionName };
}

export function parseBuildExit(raw: string | null | undefined): number | null {
  const value = (raw ?? "").trim();
  if (!/^-?\d{1,3}$/.test(value)) return null;
  const code = Number.parseInt(value, 10);
  return Number.isFinite(code) ? code : null;
}

export function buildEnvironment(): Record<string, string> {
  return {
    CI: "1",
    GRADLE_OPTS: "-Xmx2g -Dorg.gradle.daemon=false",
  };
}

export function androidBuildNetworkPolicy(): {
  mode: "deny-all";
  allowedHosts: readonly string[];
} {
  /**
   * The pinned image must contain the Gradle dependency cache. The build runs
   * with `--offline` and no network, so a cache miss fails truthfully instead
   * of reaching an arbitrary repository.
   */
  return { mode: "deny-all", allowedHosts: [] };
}

export interface BuildDiagnostics {
  lines: string[];
  truncated: boolean;
  summary: string | null;
}

export function buildDiagnostics(raw: string | null | undefined): BuildDiagnostics {
  const sanitized = sanitizeDiagnostics(raw);
  return {
    lines: sanitized.lines,
    truncated: sanitized.truncated,
    summary: summarizeDiagnostics(sanitized),
  };
}

export function buildLogExcerpt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const sanitized = sanitizeDiagnostics(raw);
  return sanitized.lines.join("\n").slice(0, ANDROID_LOG_EXCERPT_MAX_CHARS) || null;
}

export type ApkValidation =
  | {
      ok: true;
      sha256: string;
      sizeBytes: number;
      entries: number;
      uncompressedBytes: number;
    }
  | { ok: false; summary: string };

/**
 * Validate the archive without extracting it to disk. The filter refuses
 * traversal, duplicate/oversized entries, unsupported compression and a zip
 * bomb BEFORE fflate decompresses the payload.
 */
export function validateApkArchive(buffer: Buffer): ApkValidation {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, summary: "The build produced no APK bytes." };
  }
  if (buffer.length > ANDROID_ARTIFACT_MAX_BYTES) {
    return { ok: false, summary: "The APK exceeds the artifact size limit." };
  }

  const seen = new Set<string>();
  let entries = 0;
  let uncompressedBytes = 0;

  try {
    unzipSync(buffer, {
      filter: (file) => {
        entries += 1;
        if (entries > ANDROID_ARTIFACT_MAX_ENTRIES) {
          throw new Error("TOO_MANY_ENTRIES");
        }
        const name = file.name;
        if (
          !name ||
          name.length > 512 ||
          name.startsWith("/") ||
          name.includes("\\") ||
          /[\u0000-\u001f\u007f]/.test(name)
        ) {
          throw new Error("UNSAFE_ENTRY");
        }
        const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
        if (!trimmed) throw new Error("UNSAFE_ENTRY");
        const segments = trimmed.split("/");
        if (segments.some((segment) => segment === ".." || segment === "")) {
          throw new Error("UNSAFE_ENTRY");
        }
        const normalized = segments.filter((segment) => segment !== ".").join("/");
        if (seen.has(normalized.toLowerCase())) throw new Error("DUPLICATE_ENTRY");
        seen.add(normalized.toLowerCase());
        if (file.compression !== 0 && file.compression !== 8) {
          throw new Error("UNSUPPORTED_COMPRESSION");
        }
        uncompressedBytes += Math.max(0, Number(file.originalSize) || 0);
        if (uncompressedBytes > ANDROID_ARTIFACT_MAX_UNCOMPRESSED_BYTES) {
          throw new Error("ARCHIVE_TOO_LARGE");
        }
        // Never decompress artifact payloads. Central-directory metadata and
        // names are enough for this policy, and refusing extraction removes the
        // zip-bomb memory risk entirely.
        return false;
      },
    });

    if (!seen.has("androidmanifest.xml")) {
      return { ok: false, summary: "The APK has no AndroidManifest.xml." };
    }
    if (!seen.has("classes.dex")) {
      return { ok: false, summary: "The APK has no classes.dex." };
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_ARCHIVE";
    return { ok: false, summary: `The APK archive is invalid (${code}).` };
  }

  return {
    ok: true,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: buffer.length,
    entries,
    uncompressedBytes,
  };
}

export function artifactObjectPath(
  projectId: string,
  buildId: string,
  sha256: string,
): string {
  return `${projectId}/${buildId}/${sha256}.apk`;
}

export function artifactExpiryIso(days: number, nowMs: number = Date.now()): string {
  return new Date(nowMs + Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
}

/** A bounded, allowlisted reason from a failed stage. */
export function classifyGradleFailure(
  diagnostics: BuildDiagnostics,
): AndroidBuildErrorClass {
  const text = diagnostics.lines.join("\n");
  if (/Could not resolve|Could not find|No cached version|offline mode/i.test(text)) {
    return "build_failed";
  }
  return "build_failed";
}
