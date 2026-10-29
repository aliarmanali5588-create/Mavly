import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "../../vcaas/_shared";
import { getProject, isStoreFailure } from "@/lib/mavly/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getRuntimeSandboxStatus,
  refreshRuntimeLogs,
  runRuntimeBuildCheck,
  startRuntimeSandbox,
  stopRuntimeSandbox,
  type RuntimeStartOutcome,
} from "@/lib/runtime-sandbox/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** An install plus a Vite start can legitimately take a few minutes. */
export const maxDuration = 300;

const HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
} as const;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function failure(status: number, code: string, error: string, data: unknown = null): NextResponse {
  return json({ ok: false, error, code, data }, status);
}

function failureStatus(outcome: RuntimeStartOutcome): number {
  switch (outcome.code) {
    case "RUNTIME_SANDBOX_UNSUPPORTED":
      return 409;
    case "RUNTIME_SANDBOX_BUSY":
      return 409;
    case "FORBIDDEN":
      return 403;
    case "RUNTIME_SANDBOX_NOT_CONFIGURED":
    case "MIGRATION_REQUIRED":
      return 503;
    default:
      return 502;
  }
}

/**
 * `GET /api/runtime/{projectId}` — the server-validated live-preview state.
 *
 * Ownership is checked before any sandbox, file or provider read. This route
 * never creates a sandbox; `?logs=1` refreshes the bounded terminal log of an
 * existing one and nothing else.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorizeProjectRequest(projectId);
  if ("response" in auth) return auth.response;

  const client = await createSupabaseServerClient();
  if (!client) return failure(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");

  const project = await getProject(auth.team.userId, projectId, client);
  if (isStoreFailure(project)) {
    return failure(500, "UNKNOWN", "Could not read this project.");
  }
  if (!project.data) return failure(404, "PROJECT_NOT_FOUND", "Project not found.");

  const status = await getRuntimeSandboxStatus({
    client,
    projectId,
    projectType: project.data.project_type,
  });

  if (request.nextUrl.searchParams.get("logs") === "1" && status.session) {
    const logs = await refreshRuntimeLogs({ client, projectId });
    if (logs.ok && status.session) {
      status.session = { ...status.session, logs: logs.logs };
    }
  }

  return json({ ok: true, data: status });
}

/**
 * `POST /api/runtime/{projectId}` — `{ action: "start" | "restart" | "stop" | "build" }`.
 *
 * ⚠️ THE BODY CARRIES NO COMMAND, PATH, PORT OR ENVIRONMENT. Every operation is
 * a fixed server-side one; a request can only ask for start, restart, stop or
 * the separately enabled QA build. `build` runs the one fixed `vite build` in an
 * existing ready sandbox and records its result; it never accepts arguments.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorizeProjectRequest(projectId);
  if ("response" in auth) return auth.response;

  const client = await createSupabaseServerClient();
  if (!client) return failure(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");

  const project = await getProject(auth.team.userId, projectId, client);
  if (isStoreFailure(project)) {
    return failure(500, "UNKNOWN", "Could not read this project.");
  }
  if (!project.data) return failure(404, "PROJECT_NOT_FOUND", "Project not found.");
  const projectType = project.data.project_type;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, "VALIDATION", "A JSON body is required.");
  }
  const action =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).action
      : null;
  if (action !== "start" && action !== "restart" && action !== "stop" && action !== "build") {
    return failure(400, "VALIDATION", "action must be start, restart, stop or build.");
  }

  if (action === "build") {
    if (projectType === "android") {
      return failure(
        409,
        "RUNTIME_SANDBOX_UNSUPPORTED",
        "Live runtime previews are available for website projects only.",
      );
    }
    const check = await runRuntimeBuildCheck({ client, projectId });
    return json({ ok: true, data: { check } });
  }

  if (action === "stop") {
    const stopped = await stopRuntimeSandbox({ client, projectId });
    if (!stopped.ok) {
      return failure(failureStatus(stopped), stopped.code ?? "RUNTIME_SANDBOX_FAILED", stopped.message ?? "Stop failed.");
    }
    return json({ ok: true, data: { outcome: stopped.outcome, status: stopped.status } });
  }

  if (action === "restart") {
    const stopped = await stopRuntimeSandbox({ client, projectId });
    if (!stopped.ok && stopped.code !== "RUNTIME_SANDBOX_NOT_CONFIGURED") {
      return failure(failureStatus(stopped), stopped.code ?? "RUNTIME_SANDBOX_FAILED", stopped.message ?? "Restart failed.");
    }
  }

  const started = await startRuntimeSandbox({
    client,
    projectId,
    projectType,
    runId: null,
  });
  if (!started.ok) {
    return failure(
      failureStatus(started),
      started.code ?? "RUNTIME_SANDBOX_FAILED",
      started.message ?? "The live preview could not be started.",
      started.status,
    );
  }
  return json({ ok: true, data: { outcome: started.outcome, status: started.status } });
}
