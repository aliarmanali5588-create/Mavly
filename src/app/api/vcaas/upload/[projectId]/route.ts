import { NextRequest } from "next/server";
import {
  authorizeProjectRequest,
  backendNotConfigured,
} from "@/app/api/vcaas/_shared";

/**
 * `POST /api/vcaas/upload/{projectId}` — INTENTIONALLY DISCONNECTED.
 *
 * The multipart upload used to be forwarded to the Totalum VCaaS API. No
 * upstream exists in this runtime, so after the session and ownership checks
 * this route answers an explicit 503. The body is deliberately NOT buffered.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const auth = await authorizeProjectRequest(projectId);
  if ("response" in auth) return auth.response;

  return backendNotConfigured();
}
