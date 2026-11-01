import {
  runGenerationWorkerOnce,
  type WorkerTickResult,
} from "../src/lib/generation/worker";

const WORKER_ID = "render-generation-worker";
const IDLE_POLL_INTERVAL_MS = 5_000;
const ERROR_RETRY_INTERVAL_MS = 15_000;

let stopping = false;
let wakeSleep: (() => void) | null = null;

function requestShutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  console.info(`[generation-worker] shutdown requested (${signal})`);
  wakeSleep?.();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, milliseconds);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });
}

function logTick(result: WorkerTickResult, durationMs: number): void {
  console.info(
    "[generation-worker]",
    JSON.stringify({
      workerId: WORKER_ID,
      status: result.status,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      durationMs,
    }),
  );
}

async function run(): Promise<void> {
  const renderDisabled = process.env.MAVLY_RENDER_WORKER_DISABLED?.trim().toLowerCase() === "true" || process.env.MAVLY_RENDER_WORKER_DISABLED?.trim() === "1";
  if (renderDisabled) {
    console.info(`[generation-worker] disabled (${WORKER_ID}); Render worker remains preserved but inactive while AWS is the active host.`);
    return;
  }

  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));
  console.info(`[generation-worker] started (${WORKER_ID})`);

  while (!stopping) {
    const startedAt = Date.now();
    let result: WorkerTickResult;

    try {
      result = await runGenerationWorkerOnce();
    } catch (error) {
      console.error(
        "[generation-worker] tick threw",
        error instanceof Error ? error.name : "UnknownError",
      );
      if (!stopping) await wait(ERROR_RETRY_INTERVAL_MS);
      continue;
    }

    logTick(result, Date.now() - startedAt);
    if (stopping) break;

    if (result.status === "empty") {
      await wait(IDLE_POLL_INTERVAL_MS);
    } else if (result.status === "error" || result.status === "unavailable") {
      await wait(ERROR_RETRY_INTERVAL_MS);
    }
  }

  console.info(`[generation-worker] stopped (${WORKER_ID})`);
}

void run().catch((error: unknown) => {
  console.error(
    "[generation-worker] process failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  process.exitCode = 1;
});
