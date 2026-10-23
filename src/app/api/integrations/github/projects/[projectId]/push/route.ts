import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import {
  apiData,
  githubFailure,
  isAuthFailure,
  isConfigFailure,
  requireGithubConfig,
  requireGithubUser,
} from "@/lib/integrations/github/http";
import { isGithubServiceFailure, pushProjectSource } from "@/lib/integrations/github/service";

/**
 * Push the project's source to the connected branch.
 *
 * ⚠️ THE PUSH HAPPENS ONLY WHEN THE USER ASKS FOR IT. Nothing here runs after
 * an AI execution, and no branch is ever force-updated: the reference update
 * GitHub performs is a fast-forward, and a branch that moved is reported as a
 * conflict instead of being overwritten.
 *
 * ⚠️ THE COMMIT SHA IN THE ANSWER IS GITHUB'S. Mavly does not compute it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const auth = await requireGithubUser();
  if (isAuthFailure(auth)) return auth.response;

  const config = requireGithubConfig();
  if (isConfigFailure(config)) return config.response;

  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return authorized.response;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const message =
    typeof record.message === "string" && record.message.trim()
      ? record.message.trim().slice(0, 500)
      : "Mavly: update the project source";
  const allowRemoteAdvance = record.allowRemoteAdvance === true;

  const pushed = await pushProjectSource(
    { userId: auth.userId, projectId, message, allowRemoteAdvance },
    config.config,
  );

  if (isGithubServiceFailure(pushed)) {
    return githubFailure(pushed.code, pushed.conflict ? { conflict: pushed.conflict } : undefined);
  }

  return apiData({
    commitSha: pushed.data.commitSha,
    commitUrl: pushed.data.commitUrl,
    changedPaths: pushed.data.changedPaths,
    unchanged: pushed.data.unchanged,
    branch: pushed.data.branch,
    repositoryFullName: pushed.data.repositoryFullName,
  });
}
