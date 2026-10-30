import { NextResponse, type NextRequest } from "next/server";
import { zipSync, strToU8 } from "fflate";

import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import { isStoreFailure, listFiles } from "@/lib/mavly/store";

export const runtime = "nodejs";

/**
 * `GET /api/vcaas/source-code/{projectId}?intent=view|download` — download the
 * generated project.
 *
 * After the session and ownership checks, the files stored in Supabase are
 * zipped in memory and streamed back. No generated code is executed, and the
 * caller only ever sees projects they own (RLS plus the explicit user filter).
 *
 * ⚠️ AN OWNED PROJECT WITH NO FILES IS NOT "NOT FOUND". This route used to answer
 * `404 PROJECT_NOT_FOUND` whenever `project_files` was empty, which is the normal
 * state of a project whose first generation has not written its first checkpoint
 * yet. The Code tab then rendered "Failed to load source code" for a project that
 * exists, belongs to the caller, and is simply empty — and the 404 also claimed
 * the project did not exist, which this route can never know (the ownership check
 * answers a non-enumerating 403 for a missing or foreign row). The empty state is
 * now its own answer: `409 PROJECT_EMPTY`, which the panel renders as "no files
 * yet" instead of a failure. A 404 is deliberately never produced here.
 *
 * ⚠️ `intent` IS VALIDATED, NOT IGNORED. The client sends `view` (the Code tab)
 * or `download` (save to disk); anything else is a malformed request. Both
 * intents return the same archive today — the paid-only `download` gate this
 * parameter described upstream does not exist in this backend, and inventing a
 * refusal here would break a working read.
 */
const INTENTS = new Set(["view", "download"]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const auth = await authorizeProjectRequest(projectId);
  if ("response" in auth) return auth.response;

  /*
   * ⚠️ AFTER AUTH, IN THE SAME ORDER AS EVERY OTHER PROJECT ROUTE: the verified
   * session first (401), then the project row (400/403/500) — and only then the
   * shape of the request. An anonymous caller never learns anything from a
   * malformed query string.
   */
  const intent = (req.nextUrl.searchParams.get("intent") ?? "view").trim().toLowerCase();
  if (!INTENTS.has(intent)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Unknown source intent. Use `view` or `download`.",
        code: "VALIDATION",
        data: null,
      },
      { status: 400, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }

  const files = await listFiles(projectId);
  if (isStoreFailure(files)) {
    return NextResponse.json(
      { ok: false, error: "Could not read the project files.", code: "UNKNOWN", data: null },
      { status: 500, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }
  if (files.data.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "This project has no generated files yet.",
        code: "PROJECT_EMPTY",
        data: null,
      },
      { status: 409, headers: { "cache-control": "private, no-store, max-age=0" } },
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
