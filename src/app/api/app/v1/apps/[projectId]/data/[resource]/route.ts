/**
 * GET|POST /api/app/v1/apps/{projectId}/data/{resource}
 *
 * List (paginated, filtered, searched) and create for one declared resource.
 * The resource name selects a validated model entry; it is never a table name
 * supplied by a client.
 */

import type { NextRequest } from "next/server";

import { handleDataCreate, handleDataList } from "@/lib/app-data/gateway";

import {
  badRequest,
  optionsResponse,
  readBody,
  requestOrigin,
  sessionTokenFromRequest,
  toResponse,
} from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; resource: string }> },
) {
  const { projectId, resource } = await params;
  const result = await handleDataList({
    projectId,
    resourceName: resource,
    searchParams: request.nextUrl.searchParams,
    sessionToken: sessionTokenFromRequest(request, projectId),
  });
  return toResponse(result, projectId, requestOrigin(request));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; resource: string }> },
) {
  const { projectId, resource } = await params;
  const body = await readBody(request);
  if (body.ok === false) return badRequest(body.status, "invalid_body");

  const result = await handleDataCreate({
    projectId,
    resourceName: resource,
    origin: requestOrigin(request),
    body: body.body,
    sessionToken: sessionTokenFromRequest(request, projectId),
  });
  return toResponse(result, projectId, requestOrigin(request));
}

export async function OPTIONS(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; resource: string }> },
) {
  const { projectId } = await params;
  return optionsResponse(projectId, requestOrigin(request));
}
