import {
  runGenerationWorkerOnce,
  type WorkerTickResult,
} from "../src/lib/generation/worker";
import { emitGenerationEvent } from "../src/lib/observability/events";

interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

const WORKER_ID = "cloudflare-generation-worker";

function logOutcome(result: WorkerTickResult, scheduledTime: number, durationMs: number): void {
  if (result.status === "error" || result.status === "unavailable") {
    emitGenerationEvent("generation.scheduler.failed", {
      workerId: WORKER_ID,
      scheduledTime,
      durationMs,
      status: result.status,
      reason: result.reason ?? result.status,
      ...(result.recovered !== undefined ? { recovered: result.recovered } : {}),
    });
    throw new Error("Generation scheduler could not process a worker tick.");
  }

  emitGenerationEvent("generation.scheduler.completed", {
    workerId: WORKER_ID,
    scheduledTime,
    durationMs,
    status: result.status,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.recovered !== undefined ? { recovered: result.recovered } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  });
}

export default {
  async scheduled(controller: ScheduledController): Promise<void> {
    const startedAt = Date.now();
    emitGenerationEvent("generation.scheduler.heartbeat", {
      workerId: WORKER_ID,
      scheduledTime: controller.scheduledTime,
      status: "started",
    });

    let result: WorkerTickResult;
    try {
      result = await runGenerationWorkerOnce();
    } catch {
      emitGenerationEvent("generation.scheduler.failed", {
        workerId: WORKER_ID,
        scheduledTime: controller.scheduledTime,
        durationMs: Date.now() - startedAt,
        status: "error",
        reason: "unhandled_worker_error",
      });
      throw new Error("Generation scheduler execution failed.");
    }

    logOutcome(result, controller.scheduledTime, Date.now() - startedAt);
  },
};
