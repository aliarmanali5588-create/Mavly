import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "../../../vcaas/_shared";
import { getFile, getProject, isStoreFailure, listFiles } from "@/lib/mavly/store";
import { rewriteCss, rewriteHtml } from "@/lib/preview-proxy";
import { resolveStaticPreview, staticPreviewPath } from "@/lib/static-site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The preview is static files, not a running backend. It is served with an
 * opaque-origin sandbox: scripts may run inside the frame, but they cannot read
 * Mavly's cookies, call Mavly's APIs as the signed-in user, navigate the top
 * window, or be framed by another site.
 *
 * ⚠️ ASSET LOADS ARE ALLOWED, BUT THE DOCUMENT IS STILL OPAQUE-ORIGIN. An
 * imported static site usually needs its CSS, JS and images from the preview
 * route, and many real sites also use an HTTPS CDN; blocking those was why a
 * correctly imported `index.html` rendered blank. It cannot read Mavly's
 * cookies or call Mavly's APIs, and form submissions and fetch/XHR stay blocked.
 */
const PREVIEW_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' http: https:",
  "style-src 'self' 'unsafe-inline' http: https:",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data: http: https:",
  "media-src 'self' data: blob: http: https:",
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

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".txt":
    case ".md":
    case ".csv":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function notFound(message = "Not found"): NextResponse {
  return new NextResponse(message, {
    status: 404,
    headers: { ...PREVIEW_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * `GET /api/preview/{projectId}/…` — the workspace's preview frame.
 *
 * Session and ownership are checked before any file is read. Only static files
 * already stored for the project are served; there is no upstream proxy and no
 * generated server code runs here.
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

  const project = await getProject(auth.team.userId, projectId);
  if (isStoreFailure(project)) {
    return new NextResponse("Preview unavailable", {
      status: 500,
      headers: { ...PREVIEW_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!project.data || project.data.project_type === "android") {
    return notFound("A web preview is not available for this project.");
  }

  const files = await listFiles(projectId);
  if (!files.ok) {
    return new NextResponse("Preview unavailable", {
      status: 500,
      headers: { ...PREVIEW_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }

  const resolved = resolveStaticPreview(
    files.data.map((file) => ({ path: file.path, content: file.content })),
  );
  if (!resolved.site) return notFound(resolved.reason);
  const site = resolved.site;

  const requested = path.join("/");
  const filePath = staticPreviewPath(site, requested);
  if (!filePath) return notFound();

  const file = await getFile(projectId, filePath);
  if (!file.ok) {
    return new NextResponse("Preview unavailable", {
      status: 500,
      headers: { ...PREVIEW_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!file.data) return notFound("This file is not part of the preview.");

  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (extension === ".html" || extension === ".htm") {
    const base = `/api/preview/${encodeURIComponent(projectId)}`;
    const html = rewriteHtml(file.data.content, base);
    return new NextResponse(request.method === "HEAD" ? null : html, {
      status: 200,
      headers: { ...PREVIEW_HEADERS, "content-type": "text/html; charset=utf-8" },
    });
  }

  const base = `/api/preview/${encodeURIComponent(projectId)}`;
  const content = extension === ".css" ? rewriteCss(file.data.content, base) : file.data.content;
  return new NextResponse(request.method === "HEAD" ? null : content, {
    status: 200,
    headers: { ...PREVIEW_HEADERS, "content-type": contentTypeFor(filePath) },
  });
}

export const GET = handle;
export const HEAD = handle;
