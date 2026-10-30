/**
 * GET|PATCH|DELETE /api/app/v1/apps/{projectId}/data/{resource}/{id}
 *
 * One record. The id must be a UUID and is bound as a parameter; for a
 * user-owned resource the query also binds the session's user id, so another
 * user's record is a 404 rather than a leak.
 */

import type { NextRequest } from "next/server";

import {
  handleDataDelete,
  handleDataRead,
  handleDataUpdate,
} from "@/lib/app-data/gateway";

import {
  badRequest,
  optionsResponse,
  readBody,
  requestOrigin,
  sessionTokenFromRequest,
  toResponse,
} from "../../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; resource: string; id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId, resource, id } = await params;
  const result = await handleDataRead({
    projectId,
    resourceName: resource,
    id,
    sessionToken: sessionTokenFromRequest(request, projectId),
  });
  return toResponse(result, projectId, requestOrigin(request));
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { projectId, resource, id } = await params;
  const body = await readBody(request);
  if (body.ok === false) return badRequest(body.status, "invalid_body");

  const result = await handleDataUpdate({
    projectId,
    resourceName: resource,
    id,
    origin: requestOrigin(request),
    body: body.body,
    sessionToken: sessionTokenFromRequest(request, projectId),
  });
  return toResponse(result, projectId, requestOrigin(request));
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { projectId, resource, id } = await params;
  const result = await handleDataDelete({
    projectId,
    resourceName: resource,
    id,
    origin: requestOrigin(request),
    sessionToken: sessionTokenFromRequest(request, projectId),
  });
  return toResponse(result, projectId, requestOrigin(request));
}

export async function OPTIONS(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  return optionsResponse(projectId, requestOrigin(request));
}
