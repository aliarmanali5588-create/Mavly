import {
  runGenerationWorkerOnce,
  type WorkerTickResult,
} from "../src/lib/generation/worker";
import { emitGenerationEvent } from "../src/lib/observability/events";
import { isCloudflareWorkerDisabled } from "../src/lib/generation/worker-config";

interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

interface ScheduledEnvironment {
  MAVLY_CLOUDFLARE_WORKER_DISABLED?: string;
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
  async scheduled(
    controller: ScheduledController,
    env: ScheduledEnvironment,
  ): Promise<void> {
    const startedAt = Date.now();
    if (
      isCloudflareWorkerDisabled({
        MAVLY_CLOUDFLARE_WORKER_DISABLED: env.MAVLY_CLOUDFLARE_WORKER_DISABLED,
      })
    ) {
      emitGenerationEvent("generation.scheduler.heartbeat", {
        workerId: WORKER_ID,
        scheduledTime: controller.scheduledTime,
        status: "disabled",
      });
      emitGenerationEvent("generation.scheduler.completed", {
        workerId: WORKER_ID,
        scheduledTime: controller.scheduledTime,
        durationMs: Date.now() - startedAt,
        status: "disabled",
        reason: "worker_disabled",
      });
      return;
    }

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
