import { NextRequest, NextResponse } from "next/server";
import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";

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

  // Generate environment file content with project-specific values
  const lines = [
    `# Mavly project environment - ${env === "dev" ? "development" : "production"}`,
    `PROJECT_ID=${projectId}`,
    `ENVIRONMENT=${env}`,
    `NODE_ENV=${env === "dev" ? "development" : "production"}`,
    `NEXT_PUBLIC_APP_URL=${env === "dev" ? `http://localhost:3000` : `https://${projectId}.mavly.app`}`,
  ];

  const body = lines.join("\n") + "\n";
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store, max-age=0",
    },
  });
}
