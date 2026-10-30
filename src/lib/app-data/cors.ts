/**
 * The gateway is called cross-origin by a generated application served from its
 * own Mavly hostname. The allowed origin is DERIVED from the public project id
 * (`https://<project-id>.mavly.xyz`), never from a client-supplied value, so a
 * project cannot claim another project's browser context.
 *
 * ⚠️ Origin is not authorization. It only stops a foreign page from reading a
 * response or driving a cookie-authenticated mutation; every data read/write is
 * still scoped by the session's user id in trusted SQL.
 *
 * The development-only localhost allowance is deliberately narrow: it exists so
 * a generated app can be exercised with `next dev`, and it disappears in a
 * production build.
 */

import { mavlyHostname } from "@/lib/mavly-hostname";
import { isRoutableProjectSlug } from "@/lib/project-slug";

export function appOriginFor(projectId: string): string | null {
  if (!isRoutableProjectSlug(projectId)) return null;
  const host = mavlyHostname(projectId);
  return host ? `https://${host}` : null;
}

export function originAllowed(
  projectId: string,
  origin: string | null,
  nodeEnv: string = process.env.NODE_ENV ?? "development",
): boolean {
  if (!origin) return false;
  const expected = appOriginFor(projectId);
  if (expected && origin === expected) return true;
  if (nodeEnv === "production") return false;
  return /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{2,5})?$/.test(origin);
}

/** CORS headers for a real response. No `*`, and credentials are allowed. */
export function corsHeaders(
  projectId: string,
  requestOrigin: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Credentials": "true",
  };
  if (originAllowed(projectId, requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin as string;
  }
  return headers;
}

export function preflightHeaders(
  projectId: string,
  requestOrigin: string | null,
): Record<string, string> {
  const headers = corsHeaders(projectId, requestOrigin);
  if (headers["Access-Control-Allow-Origin"]) {
    headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "authorization, content-type";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}
