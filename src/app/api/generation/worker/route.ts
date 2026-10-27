/**
 * ═══ DURABLE GENERATION WORKER — INTERNAL INVOCATION ENDPOINT ═══════════════
 *
 * One call performs one bounded worker tick: recover expired leases, claim one
 * ready job, verify it, execute it, and keep its lease alive while it runs.
 *
 * ⚠️ THIS ENDPOINT HAS NO USER SESSION. It is authenticated by a server-only
 * bearer secret (`MAVLY_GENERATION_WORKER_SECRET`) compared in constant time.
 * It is reachable without a cookie, so the proxy's session gate exempts it by
 * exact path; this handler is then the only access boundary. A request that
 * does not present the secret learns nothing: disabled → 404, unauthorized →
 * 401, and no prompt, project or provider data is ever returned.
 *
 * ⚠️ POST AND GET ARE BOTH ACCEPTED. Schedulers differ; some can only issue a
 * GET. Both carry the same bearer secret and perform the same tick. Do not call
 * this from a browser.
 *
 * ⚠️ NO-OP WHEN DISABLED. Without `MAVLY_GENERATION_WORKER_ENABLED` the route
 * answers 404 and no job is claimed.
 */

import { NextResponse, type NextRequest } from "next/server";

import { timingSafeStringEqual } from "@/lib/generation/leases";
import { runGenerationWorkerOnce, type WorkerTickResult } from "@/lib/generation/worker";
import { generationWorkerConfig } from "@/lib/generation/worker-config";
import { emitGenerationEvent } from "@/lib/observability/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** The generation budget is 240 s; the lease (420 s) outlives this route. */
export const maxDuration = 300;

const NO_STORE = "private, no-store, max-age=0";

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": NO_STORE, pragma: "no-cache" },
  });
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Only non-sensitive outcome fields leave this route. */
function publicResult(result: WorkerTickResult): Record<string, unknown> {
  return {
    status: result.status,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.errorClass ? { errorClass: result.errorClass } : {}),
    ...(result.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: result.retryAfterSeconds }
      : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.recovered !== undefined ? { recovered: result.recovered } : {}),
    ...(result.verification ? { verification: result.verification } : {}),
    ...(result.androidBuild ? { androidBuild: result.androidBuild } : {}),
  };
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const config = generationWorkerConfig();

  // A disabled worker does not reveal that this endpoint exists.
  if (!config.requested) return json({ ok: false }, 404);

  if (!config.ready || !config.secret) {
    return json(
      {
        ok: false,
        code: "BACKEND_NOT_CONFIGURED",
        error: "The generation worker is enabled but not fully configured.",
      },
      503,
    );
  }

  if (!timingSafeStringEqual(bearerToken(request), config.secret)) {
    emitGenerationEvent("generation.rejected", {
      workerId: config.workerId,
      reason: "unauthorized",
    });
    return json({ ok: false, code: "UNAUTHORIZED", error: "Unauthorized." }, 401);
  }

  try {
    const result = await runGenerationWorkerOnce({ config });

    if (result.status === "unavailable") {
      return json(
        {
          ok: false,
          code: "BACKEND_NOT_CONFIGURED",
          status: result.status,
          reason: result.reason ?? null,
        },
        503,
      );
    }
    if (result.status === "error") {
      return json(
        { ok: false, status: result.status, reason: result.reason ?? "worker_error" },
        500,
      );
    }

    return json({ ok: true, ...publicResult(result) }, 200);
  } catch {
    // Never echo an exception message: it may contain a provider body or URL.
    emitGenerationEvent("generation.worker_error", {
      workerId: config.workerId,
      reason: "unhandled",
    });
    return json({ ok: false, status: "error", reason: "unhandled" }, 500);
  }
}

export const POST = handle;
export const GET = handle;
