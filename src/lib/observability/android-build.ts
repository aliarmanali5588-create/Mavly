/**
 * Content-free Android build events. Never include source, logs, object paths,
 * bucket names, credentials or provider bodies.
 */

export type AndroidBuildEventName =
  | "android_build.recovered"
  | "android_build.claimed"
  | "android_build.stage"
  | "android_build.completed"
  | "android_build.retry"
  | "android_build.lease_lost"
  | "android_build.cleanup"
  | "android_build.artifact_expired"
  | "android_build.unavailable"
  | "android_build.error";

export interface AndroidBuildEventFields {
  buildId?: string | null;
  projectId?: string | null;
  workerId?: string | null;
  status?: string | null;
  stage?: string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
  errorClass?: string | null;
  durationMs?: number | null;
  sizeBytes?: number | null;
  outcome?: string | null;
  reason?: string | null;
}

const ALLOWED_KEYS: readonly (keyof AndroidBuildEventFields)[] = [
  "buildId",
  "projectId",
  "workerId",
  "status",
  "stage",
  "attempt",
  "maxAttempts",
  "errorClass",
  "durationMs",
  "sizeBytes",
  "outcome",
  "reason",
];

function safeValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  return value.slice(0, 160).replace(/[\u0000-\u001f\u007f]/g, "");
}

export function emitAndroidBuildEvent(
  event: AndroidBuildEventName,
  fields: AndroidBuildEventFields = {},
): void {
  const line: Record<string, unknown> = { event, at: new Date().toISOString() };
  for (const key of ALLOWED_KEYS) {
    const value = safeValue(fields[key]);
    if (value !== null) line[key] = value;
  }
  const serialized = JSON.stringify(line);
  try {
    if (event === "android_build.error" || event === "android_build.lease_lost") {
      console.error(`[android-build] ${serialized}`);
    } else if (event === "android_build.unavailable") {
      console.warn(`[android-build] ${serialized}`);
    } else {
      console.info(`[android-build] ${serialized}`);
    }
  } catch {
    // A console transport failure is not a build failure.
  }
}
