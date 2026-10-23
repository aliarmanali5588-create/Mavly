import { NextRequest, NextResponse } from "next/server";
import {
  authorizeProjectRequest,
  backendNotConfigured,
} from "@/app/api/vcaas/_shared";

/**
 * `GET /api/vcaas/env/{projectId}?env=dev|live` — INTENTIONALLY DISCONNECTED.
 *
 * The project `.env` used to be read from Totalum. That integration has been
 * removed: the request shape is still validated, the session and ownership are
 * still checked, and then the route answers an explicit 503. Nothing is read
 * from upstream and no environment values are produced.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const env = req.nextUrl.searchParams.get("env");
  if (env !== "dev" && env !== "live") {
    return NextResponse.json(
      { ok: false, error: "Invalid env", code: "VALIDATION_ERROR" },
      { status: 400 }
    );
  }

  const auth = await authorizeProjectRequest(projectId);
  if ("response" in auth) return auth.response;

  return backendNotConfigured();
}
