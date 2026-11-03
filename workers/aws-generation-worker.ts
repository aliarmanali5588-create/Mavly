import {
  runGenerationWorkerOnce,
  type WorkerTickResult,
} from "../src/lib/generation/worker";

const WORKER_ID = "aws-generation-worker";
const IDLE_POLL_INTERVAL_MS = 5_000;
const ERROR_RETRY_INTERVAL_MS = 15_000;

let stopping = false;
let wakeSleep: (() => void) | null = null;

function requestShutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  console.info(`[aws-generation-worker] shutdown requested (${signal})`);
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
    "[aws-generation-worker]",
    JSON.stringify({
      workerId: WORKER_ID,
      status: result.status,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.errorClass ? { errorClass: result.errorClass } : {}),
      ...(result.awsPublication
        ? {
            awsPublication: {
              status: result.awsPublication.status,
              ...(result.awsPublication.projectId
                ? { projectId: result.awsPublication.projectId }
                : {}),
              ...(result.awsPublication.versionId
                ? { versionId: result.awsPublication.versionId }
                : {}),
              ...(result.awsPublication.reason
                ? { reason: result.awsPublication.reason }
                : {}),
            },
          }
        : {}),
      durationMs,
    }),
  );
}

async function run(): Promise<void> {
  const renderDisabled =
    process.env.MAVLY_RENDER_WORKER_DISABLED?.trim().toLowerCase() === "true" ||
    process.env.MAVLY_RENDER_WORKER_DISABLED?.trim() === "1";

  const awsWorkerEnabled =
    process.env.MAVLY_AWS_WORKER?.trim().toLowerCase() === "true" ||
    process.env.MAVLY_AWS_WORKER?.trim() === "1";

  if (!awsWorkerEnabled) {
    console.info(
      `[aws-generation-worker] not activated; set MAVLY_AWS_WORKER=true to start the AWS-hosted worker. Render remains preserved but disabled.`,
    );
    return;
  }

  if (renderDisabled) {
    console.info(
      `[aws-generation-worker] AWS worker is active; Render remains preserved but disabled via MAVLY_RENDER_WORKER_DISABLED=true.`,
    );
  }

  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));
  console.info(`[aws-generation-worker] started (${WORKER_ID})`);

  while (!stopping) {
    const startedAt = Date.now();
    let result: WorkerTickResult;

    try {
      result = await runGenerationWorkerOnce();
    } catch (error) {
      console.error(
        "[aws-generation-worker] tick threw",
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

  console.info(`[aws-generation-worker] stopped (${WORKER_ID})`);
}

void run().catch((error: unknown) => {
  console.error(
    "[aws-generation-worker] process failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  process.exitCode = 1;
});
