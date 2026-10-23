import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "../../../vcaas/_shared";
import { getFile } from "@/lib/mavly/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The generated preview is static HTML, not a running backend. It is served
 * with an opaque-origin sandbox: scripts may run inside the frame, but they
 * cannot read Mavly's cookies, call Mavly's APIs as the signed-in user, navigate
 * the top window, or be framed by another site.
 */
const PREVIEW_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

const PREVIEW_HEADERS = {
  "content-security-policy": PREVIEW_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store, max-age=0",
} as const;

/**
 * `GET /api/preview/{projectId}/…` — the workspace's preview frame.
 *
 * Session and ownership are checked before any file is read. Only the generated
 * `preview.html` is served; there is no upstream proxy and no generated server
 * code runs here.
 */
async function handle(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; path?: string[] }> },
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new NextResponse(null, { status: 405, headers: { allow: "GET, HEAD", ...PREVIEW_HEADERS } });
  }

  const { projectId, path = [] } = await params;
  const auth = await authorizeProjectRequest(projectId);
  if ("response" in auth) return auth.response;

  const requested = path.join("/");
  if (requested && requested !== "index.html" && requested !== "preview.html") {
    return new NextResponse("Not found", {
      status: 404,
      headers: { ...PREVIEW_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }

  const file = await getFile(projectId, "preview.html");
  if (!file.ok) {
    return new NextResponse("Preview unavailable", {
      status: 500,
      headers: { ...PREVIEW_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!file.data) {
    return new NextResponse("This project has no preview yet.", {
      status: 404,
      headers: { ...PREVIEW_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new NextResponse(request.method === "HEAD" ? null : file.data.content, {
    status: 200,
    headers: { ...PREVIEW_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

export const GET = handle;
export const HEAD = handle;
