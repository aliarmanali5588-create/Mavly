import { NextRequest, NextResponse } from "next/server";
import {
  authorizeProjectRequest,
  backendNotConfigured,
} from "@/app/api/vcaas/_shared";

/**
 * `GET /api/vcaas/git-diff?projectId=…` — INTENTIONALLY DISCONNECTED.
 *
 * The unified diff used to be downloaded from a Totalum-controlled storage
 * host. With the upstream integration removed there is nothing to download:
 * after the project id is checked and the caller is authenticated and owns the
 * project, this route answers an explicit 503. It does not fetch any URL.
 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");

  if (!projectId) {
    return NextResponse.json(
      { ok: false, error: "Missing `projectId` query parameter" },
      { status: 400 }
    );
  }

  const auth = await authorizeProjectRequest(projectId);
  if ("response" in auth) return auth.response;

  return backendNotConfigured();
}
