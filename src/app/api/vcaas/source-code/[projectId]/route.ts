import { NextResponse, type NextRequest } from "next/server";
import { zipSync, strToU8 } from "fflate";

import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import { isStoreFailure, listFiles } from "@/lib/mavly/store";

export const runtime = "nodejs";

/**
 * `GET /api/vcaas/source-code/{projectId}` — download the generated project.
 *
 * After the session and ownership checks, the files stored in Supabase are
 * zipped in memory and streamed back. No generated code is executed, and the
 * caller only ever sees projects they own (RLS plus the explicit user filter).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const auth = await authorizeProjectRequest(projectId);
  if ("response" in auth) return auth.response;

  const files = await listFiles(projectId);
  if (isStoreFailure(files)) {
    return NextResponse.json(
      { ok: false, error: "Could not read the project files.", code: "UNKNOWN", data: null },
      { status: 500, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }
  if (files.data.length === 0) {
    return NextResponse.json(
      { ok: false, error: "This project has no generated files yet.", code: "PROJECT_NOT_FOUND", data: null },
      { status: 404, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }

  const archive: Record<string, Uint8Array> = {};
  let commitSha = "";
  for (const file of files.data) {
    archive[file.path] = strToU8(file.content);
    if (file.updated_at > commitSha) commitSha = file.updated_at;
  }
  const zipped = zipSync(archive, { level: 6 });
  const body = new Uint8Array(zipped).buffer;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${projectId}.zip"`,
      "x-commit-sha": commitSha,
      "x-files-count": String(files.data.length),
      "cache-control": "private, no-store, max-age=0",
    },
  });
}
