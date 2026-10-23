import { NextRequest } from "next/server";
import {
  authorizeProjectRequest,
  backendNotConfigured,
} from "@/app/api/vcaas/_shared";

/**
 * `GET /api/vcaas/backup-download/{projectId}/{backupId}` — INTENTIONALLY
 * DISCONNECTED.
 *
 * The UI has always linked here for a database backup download, but the route
 * was never implemented locally (it pointed at the platform's own download
 * route). With the Totalum integration removed there is no archive to stream,
 * so the session and ownership checks run first and the answer is the explicit
 * `BACKEND_NOT_CONFIGURED` 503 rather than an opaque framework 404.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; backupId: string }> }
) {
  const { projectId } = await params;

  const auth = await authorizeProjectRequest(projectId);
  if ("response" in auth) return auth.response;

  return backendNotConfigured();
}
