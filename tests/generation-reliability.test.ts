import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BATCH_OUTPUT_TOKENS,
  MANIFEST_OUTPUT_TOKENS,
  MAX_FILE_BYTES,
  PREVIEW_OUTPUT_TOKENS,
  generateApp,
  isGenerationFailure,
  type AgentDependencies,
  type AgentGenerationInput,
  type AgentPlanningCheckpoint,
} from "../src/lib/ai/agent";
import {
  type ChatCompletionFailure,
  type ChatCompletionOptions,
  type ChatCompletionResult,
  type ChatCompletionSuccess,
  type ChatMessage,
} from "../src/lib/ai/provider";
import { resolveModel } from "../src/lib/ai/models";

/**
 * The reliability rules from the generation audit, exercised against the pure
 * agent with an injected provider:
 *
 *  · `finish_reason: "length"` never becomes a success;
 *  · a truncated multi-file batch is split, and earlier valid batches persist;
 *  · a truncated single file gets ONE compact retry, then fails honestly;
 *  · malformed JSON gets ONE repair, and an unsafe/oversized/unexpected file
 *    fails before `onBatch` is called;
 *  · a checkpoint failure is fatal, not silently ignored;
 *  · a resume requests only paths that are not already verified.
 */

const model = resolveModel();
const effectiveManifestOutputTokens = Math.min(
  model.maxOutputTokens,
  MANIFEST_OUTPUT_TOKENS,
);

function success(content: string, finishReason = "stop"): ChatCompletionSuccess {
  return {
    ok: true,
    content,
    model: model.id,
    finishReason,
    truncated: false,
    metadata: {
      status: 200,
      requestedModel: model.id,
      model: model.id,
      finishReason,
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        costUsd: 0.001,
      },
      providerRequestId: "req-test",
      retryAfterMs: null,
      errorCode: null,
      errorDetail: null,
    },
  };
}

function failure(
  code: ChatCompletionFailure["code"],
  options: {
    retryable?: boolean;
    finishReason?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
  } = {},
): ChatCompletionFailure {
  const promptTokens = options.promptTokens ?? null;
  const completionTokens = options.completionTokens ?? null;
  return {
    ok: false,
    code,
    error: `synthetic ${code}`,
    retryable: options.retryable ?? false,
    retryAfterMs: null,
    metadata: {
      status: code === "RATE_LIMITED" ? 429 : 200,
      requestedModel: model.id,
      model: model.id,
      finishReason: options.finishReason ?? null,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens:
          promptTokens !== null && completionTokens !== null
            ? promptTokens + completionTokens
            : null,
        reasoningTokens: null,
        cachedReadTokens: null,
        cachedWriteTokens: null,
        costUsd: null,
      },
      providerRequestId: "req-failure",
      retryAfterMs: null,
      errorCode: code,
      errorDetail: null,
    },
  };
}

function manifestJson(files: string[], deletedPaths: string[] = []): string {
  return JSON.stringify({
    message: "Built the requested app.",
    files: files.map((path) => ({ path, estimatedBytes: 500 })),
    deletedPaths,
  });
}

function batchJson(files: ReadonlyArray<[string, string]>): string {
  return JSON.stringify({
    message: "Batch complete.",
    files: files.map(([path, content]) => ({ path, content })),
  });
}

function isPlanner(messages: ChatMessage[]): boolean {
  return messages[0]?.content.includes("project planner") === true;
}

function isRepair(messages: ChatMessage[]): boolean {
  return messages[messages.length - 1]?.content.startsWith("Your previous answer") === true;
}

function requestedPaths(messages: ChatMessage[]): string[] {
  const paths: string[] = [];
  for (const message of messages) {
    for (const match of message.content.matchAll(/^- (.+?) \(about \d+ bytes\)$/gm)) {
      paths.push(match[1]);
    }
  }
  return paths;
}

function provider(handler: (messages: ChatMessage[]) => ChatCompletionResult) {
  return async (_model: unknown, messages: ChatMessage[]): Promise<ChatCompletionResult> =>
    handler(messages);
}

const noop = async () => {};

test("a planner output-limit response retries once with a compact complete plan", async () => {
  const checkpointed: string[][] = [];
  const planningCheckpoints: AgentPlanningCheckpoint[] = [];
  const attempts: Array<{ phase: string; completionTokens: number | null }> = [];
  const plannerMaxTokens: number[] = [];
  let plannerCalls = 0;

  const outcome = await generateApp(
    {
      prompt: "Build a small notes app.",
      mode: "update",
      onManifest: (manifest) => {
        checkpointed.push(manifest.files.map((file) => file.path));
      },
      onPlanningCheckpoint: (checkpoint) => {
        planningCheckpoints.push(checkpoint);
      },
      onBatch: (batch) => {
        checkpointed.push(batch.files.map((file) => file.path));
      },
    },
    {
      complete: async (_selectedModel, messages, options: number | ChatCompletionOptions = {}) => {
        const maxTokens = typeof options === "number" ? null : options.maxTokens ?? null;
        if (isPlanner(messages)) {
          plannerCalls += 1;
          if (maxTokens !== null) plannerMaxTokens.push(maxTokens);
          if (plannerCalls === 1) {
            return failure("OUTPUT_LIMIT", {
              finishReason: "length",
              promptTokens: 500,
              completionTokens: effectiveManifestOutputTokens,
            });
          }
          assert.match(messages.at(-1)?.content ?? "", /complete replacement plan/i);
          assert.match(messages.at(-1)?.content ?? "", /never omit paths/i);
          return success(JSON.stringify({
            message: "A focused notes app.",
            files: ["app/page.tsx"],
            deletedPaths: [],
          }));
        }
        return success(batchJson([["app/page.tsx", "complete source"]]));
      },
      onProviderAttempt: (event) => {
        if (event.type === "result") {
          attempts.push({
            phase: event.attempt.phase,
            completionTokens: event.attempt.completionTokens,
          });
        }
      },
      sleep: noop,
    },
  );

  assert.equal(isGenerationFailure(outcome), false);
  if (isGenerationFailure(outcome)) return;
  assert.equal(plannerCalls, 2);
  assert.deepEqual(planningCheckpoints, [{
    type: "mavly_planning_checkpoint",
    version: 1,
    nextAttempt: "compact",
  }]);
  assert.deepEqual(plannerMaxTokens, [
    effectiveManifestOutputTokens,
    effectiveManifestOutputTokens,
  ]);
  assert.deepEqual(attempts.map((attempt) => attempt.phase), ["manifest", "manifest", "batch"]);
  assert.deepEqual(
    attempts.slice(0, 2).map((attempt) => attempt.completionTokens),
    [effectiveManifestOutputTokens, 7],
  );
  assert.deepEqual(checkpointed[0], ["app/page.tsx"]);
  assert.deepEqual(outcome.result.manifest.files.map((file) => file.path), ["app/page.tsx"]);
  assert.equal(outcome.result.usage.completionTokens, effectiveManifestOutputTokens + 14);
});

test("repeated planner output limits persist a compact-retry checkpoint for resume", async () => {
  let plannerCalls = 0;
  let manifestCheckpointCount = 0;
  const planningCheckpoints: AgentPlanningCheckpoint[] = [];
  const outcome = await generateApp(
    {
      prompt: "Build a large app.",
      mode: "update",
      onManifest: () => {
        manifestCheckpointCount += 1;
      },
      onPlanningCheckpoint: (checkpoint) => {
        planningCheckpoints.push(checkpoint);
      },
    },
    {
      complete: async (_selectedModel, messages) => {
        if (isPlanner(messages)) {
          plannerCalls += 1;
          return failure("OUTPUT_LIMIT", {
            finishReason: "length",
            promptTokens: 500,
            completionTokens: effectiveManifestOutputTokens,
          });
        }
        throw new Error("Planning failure must not continue to code generation.");
      },
      sleep: noop,
    },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_TRUNCATED");
  assert.match(outcome.error, /incomplete plan was discarded/i);
  assert.equal(plannerCalls, 2);
  assert.equal(manifestCheckpointCount, 0);
  assert.equal(planningCheckpoints.length, 1);
  const planningCheckpoint = planningCheckpoints[0];
  assert.ok(planningCheckpoint);
  assert.equal(outcome.usage.completionTokens, effectiveManifestOutputTokens * 2);
  assert.equal(outcome.attempts.every((attempt) => attempt.phase === "manifest"), true);

  let resumedPlannerCalls = 0;
  let resumedManifestCheckpoints = 0;
  const resumed = await generateApp(
    {
      prompt: "Build a large app.",
      mode: "update",
      resume: { planningCheckpoint },
      onManifest: () => {
        resumedManifestCheckpoints += 1;
      },
    },
    {
      complete: async (_selectedModel, messages) => {
        if (isPlanner(messages)) {
          resumedPlannerCalls += 1;
          assert.match(messages.at(-1)?.content ?? "", /previous project plan reached the output-token limit/i);
          return success(manifestJson(["app/page.tsx"]));
        }
        return success(batchJson([["app/page.tsx", "complete source"]]));
      },
      sleep: noop,
    },
  );

  assert.equal(isGenerationFailure(resumed), false);
  if (isGenerationFailure(resumed)) return;
  assert.equal(resumedPlannerCalls, 1);
  assert.equal(resumedManifestCheckpoints, 1);
  assert.deepEqual(resumed.result.manifest.files.map((file) => file.path), ["app/page.tsx"]);
});

test("planner checkpoint persistence failure stops before the compact retry", async () => {
  let plannerCalls = 0;
  const outcome = await generateApp(
    {
      prompt: "Build a project.",
      mode: "update",
      onPlanningCheckpoint: () => {
        throw new Error("storage unavailable");
      },
    },
    {
      complete: async () => {
        plannerCalls += 1;
        return failure("OUTPUT_LIMIT", {
          finishReason: "length",
          promptTokens: 500,
          completionTokens: effectiveManifestOutputTokens,
        });
      },
      sleep: noop,
    },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_PERSIST_FAILED");
  assert.equal(plannerCalls, 1);
});

test("a truncated batch is split; only validated content is checkpointed", async () => {
  const persisted: string[][] = [];
  const batchCalls: string[][] = [];

  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts", "b.ts"]));
    const paths = requestedPaths(messages);
    batchCalls.push(paths);
    if (paths.length > 1) return failure("OUTPUT_LIMIT", { finishReason: "length" });
    return success(batchJson(paths.map((path) => [path, `content:${path}`])));
  });

  const input: AgentGenerationInput = {
    prompt: "build it",
    mode: "update",
    onBatch: (batch) => {
      persisted.push(batch.files.map((file) => file.path));
    },
  };

  const outcome = await generateApp(input, { complete, sleep: noop });

  assert.equal(isGenerationFailure(outcome), false);
  if (isGenerationFailure(outcome)) return;

  assert.deepEqual(batchCalls, [["a.ts", "b.ts"], ["a.ts"], ["b.ts"]]);
  assert.deepEqual(persisted, [["a.ts"], ["b.ts"]]);
  assert.deepEqual(
    outcome.result.files.map((file) => file.path).sort(),
    ["a.ts", "b.ts"],
  );
  assert.equal(outcome.result.usage.completionTokens > 0, true);
});

async function assertPreviewStaysInItsOwnBatch(mode: "create" | "update") {
  const persisted: Array<[string, string]> = [];
  let returnedPreviewEarly = false;
  const plan = mode === "create"
    ? ["package.json", "app/layout.tsx", "app/page.tsx"]
    : ["app/page.tsx", "preview.html"];

  const outcome = await generateApp(
    {
      prompt: mode === "create" ? "Build a landing page." : "Change the visible page heading.",
      mode,
      existingFiles: mode === "update"
        ? [
            { path: "app/page.tsx", content: "old page" },
            { path: "preview.html", content: "old preview" },
          ]
        : [],
      onBatch: (batch) => {
        persisted.push(
          ...batch.files.map(({ path, content }) => [path, content] as [string, string]),
        );
      },
    },
    {
      complete: async (_selectedModel, messages) => {
        if (isPlanner(messages)) return success(manifestJson(plan));
        const requested = requestedPaths(messages.slice(0, 2));
        if (isRepair(messages)) {
          assert.match(messages.at(-1)?.content ?? "", /only allowed file paths are/i);
          assert.equal(requested.includes("preview.html"), false);
          return success(
            batchJson(requested.map((path) => [path, `valid:${path}`] as [string, string])),
          );
        }
        if (!requested.includes("preview.html") && !returnedPreviewEarly) {
          returnedPreviewEarly = true;
          return success(batchJson([
            ...requested.map((path) => [path, `valid:${path}`] as [string, string]),
            ["preview.html", "preview from the wrong batch"],
          ]));
        }
        return success(batchJson(requested.map((path) => [
          path,
          path === "preview.html"
            ? "<!doctype html><html><body>preview from its requested batch</body></html>"
            : `valid:${path}`,
        ] as [string, string])));
      },
      sleep: noop,
    },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.equal(returnedPreviewEarly, true);
  assert.equal(persisted.filter(([path]) => path === "preview.html").length, 1);
  assert.equal(
    persisted.find(([path]) => path === "preview.html")?.[1],
    "<!doctype html><html><body>preview from its requested batch</body></html>",
  );
}

test("initial generation repairs preview.html returned outside its batch", async () => {
  await assertPreviewStaysInItsOwnBatch("create");
});

test("follow-up edits keep preview.html in its planned batch", async () => {
  await assertPreviewStaysInItsOwnBatch("update");
});

test("follow-up edits resolve retired provider model IDs to the active OpenRouter catalog", async () => {
  const calledModels: string[] = [];
  const outcome = await generateApp(
    {
      prompt: "Change the existing page title.",
      mode: "update",
      requestedModel: "claude-opus-4.7",
      existingFiles: [{ path: "app/page.tsx", content: "old page" }],
    },
    {
      complete: async (selectedModel, messages) => {
        calledModels.push(selectedModel.id);
        return success(
          isPlanner(messages)
            ? manifestJson(["app/page.tsx"])
            : batchJson([["app/page.tsx", "updated page"]]),
        );
      },
      sleep: noop,
    },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.deepEqual(calledModels, [
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4.1-flash",
  ]);
});

test("a truncated single file gets exactly one compact retry", async () => {
  let batchCalls = 0;
  let sawCompactInstruction = false;

  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["only.ts"]));
    batchCalls += 1;
    if (batchCalls === 1) return failure("OUTPUT_LIMIT", { finishReason: "length" });
    sawCompactInstruction = messages.some((message) =>
      message.content.includes("more compact version"),
    );
    return success(batchJson([["only.ts", "compact content"]]));
  });

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.equal(batchCalls, 2);
  assert.equal(sawCompactInstruction, true);
});

test("two truncated single-file attempts fail without persisting", async () => {
  let persisted = 0;

  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["only.ts"]));
    return failure("OUTPUT_LIMIT", { finishReason: "length" });
  });

  const outcome = await generateApp(
    {
      prompt: "build it",
      mode: "update",
      onBatch: () => {
        persisted += 1;
      },
    },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_TRUNCATED");
  assert.equal(persisted, 0);
});

test("malformed JSON gets one focused repair, then succeeds", async () => {
  let batchCalls = 0;
  let repairs = 0;

  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts"]));
    if (isRepair(messages)) {
      repairs += 1;
      return success(batchJson([["a.ts", "repaired"]]));
    }
    batchCalls += 1;
    return success("not json at all");
  });

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.equal(batchCalls, 1);
  assert.equal(repairs, 1);
});

test("a second malformed response fails instead of looping", async () => {
  let calls = 0;

  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts"]));
    calls += 1;
    return success("still not json");
  });

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_MALFORMED");
  assert.equal(calls, 2);
});

test("an unsafe planned path is refused before anything is planned", async () => {
  let planned = false;

  const complete = provider((messages) => {
    if (isPlanner(messages)) {
      planned = true;
      return success(manifestJson(["../escape.ts"]));
    }
    return success(batchJson([["../escape.ts", "x"]]));
  });

  const outcome = await generateApp(
    {
      prompt: "build it",
      mode: "update",
      onManifest: () => {
        throw new Error("must not persist an unsafe plan");
      },
    },
    { complete, sleep: noop },
  );

  assert.equal(planned, true);
  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_UNSAFE_PATH");
});

test("an oversized file is refused before onBatch is called", async () => {
  let persisted = 0;

  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["big.ts"]));
    return success(batchJson([["big.ts", "x".repeat(MAX_FILE_BYTES + 1)]]));
  });

  const outcome = await generateApp(
    {
      prompt: "build it",
      mode: "update",
      onBatch: () => {
        persisted += 1;
      },
    },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_TOO_LARGE");
  assert.equal(persisted, 0);
});

test("a file outside the requested batch is refused", async () => {
  let persisted = 0;

  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts"]));
    return success(batchJson([["unrequested.ts", "x"]]));
  });

  const outcome = await generateApp(
    {
      prompt: "build it",
      mode: "update",
      onBatch: () => {
        persisted += 1;
      },
    },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_MALFORMED");
  assert.equal(persisted, 0);
});

test("a checkpoint failure is fatal and is not reported as success", async () => {
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts"]));
    return success(batchJson([["a.ts", "valid"]]));
  });

  const outcome = await generateApp(
    {
      prompt: "build it",
      mode: "update",
      onBatch: () => {
        throw new Error("database unavailable");
      },
    },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_PERSIST_FAILED");
  assert.deepEqual(outcome.partial.completedPaths, []);
});

test("a resume requests only unverified paths and keeps the original plan", async () => {
  const manifest = {
    message: "Existing plan.",
    files: [
      { path: "a.ts", estimatedBytes: 500 },
      { path: "b.ts", estimatedBytes: 500 },
    ],
    deletedPaths: [],
  };
  const batchCalls: string[][] = [];
  let plannerCalls = 0;
  let checkpointIndex = -1;

  const complete = provider((messages) => {
    if (isPlanner(messages)) {
      plannerCalls += 1;
      return success(manifestJson(["a.ts", "b.ts"]));
    }
    const paths = requestedPaths(messages);
    batchCalls.push(paths);
    return success(batchJson(paths.map((path) => [path, `resumed:${path}`])));
  });

  const outcome = await generateApp(
    {
      prompt: "continue",
      mode: "update",
      resume: {
        manifest,
        completedPaths: ["a.ts"],
        nextBatchIndex: 1,
      },
      onBatch: (batch) => {
        checkpointIndex = batch.batchIndex;
      },
    },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.equal(plannerCalls, 0);
  assert.deepEqual(batchCalls, [["b.ts"]]);
  assert.equal(checkpointIndex, 1);
});

test("the provider's usage is aggregated across attempts", async () => {
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts"]));
    return success(batchJson([["a.ts", "content"]]));
  });

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  if (isGenerationFailure(outcome)) return;

  assert.equal(outcome.result.usage.attempts, 2);
  assert.equal(outcome.result.usage.promptTokens, 22);
  assert.equal(outcome.result.usage.completionTokens, 14);
  assert.equal(outcome.result.usage.totalTokens, 36);
  assert.equal(outcome.result.attempts.length, 2);
  assert.equal(outcome.result.attempts[0].providerRequestId, "req-test");
});

test("project paths cannot escape the project or target internal files", async () => {
  const { sanitizeProjectPath } = await import("../src/lib/ai/agent");

  assert.equal(sanitizeProjectPath("app/page.tsx"), "app/page.tsx");
  assert.equal(sanitizeProjectPath("./app/page.tsx"), "app/page.tsx");
  assert.equal(sanitizeProjectPath("app\\page.tsx"), "app/page.tsx");

  for (const unsafe of [
    "../escape.ts",
    "app/../../escape.ts",
    "/etc/passwd",
    "app//page.tsx",
    "node_modules/pkg/index.js",
    ".git/config",
    ".next/server.js",
    ".env",
    ".env.local",
    "secrets/.env.production",
    "C:/Windows/path",
    "",
  ]) {
    assert.equal(sanitizeProjectPath(unsafe), null, `${unsafe} must be refused`);
  }

  assert.equal(sanitizeProjectPath(".env.example"), ".env.example");
});

// ── Phase 0: preview document integrity and deadline refusal ────────────────

const VALID_PREVIEW =
  "<!doctype html><html><head><style>body{color:#111}</style></head><body><h1>Hi</h1><script>1+1</script></body></html>";

test("a structurally complete preview document is persisted once", async () => {
  const persisted: string[] = [];
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["preview.html"]));
    return success(batchJson([["preview.html", VALID_PREVIEW]]));
  });

  const outcome = await generateApp(
    {
      prompt: "build it",
      mode: "update",
      onBatch: (batch) => {
        persisted.push(...batch.files.map((file) => file.path));
      },
    },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.deepEqual(persisted, ["preview.html"]);
});

test("a preview cut off before </html> is never persisted as a completed preview", async () => {
  let batchCalls = 0;
  const batchTokenLimits: number[] = [];
  let persisted = 0;
  const truncated = "<!doctype html><html><body><h1>Half a page</h1>";

  const complete: NonNullable<AgentDependencies["complete"]> = async (
    _model,
    messages,
    options,
  ) => {
    if (isPlanner(messages)) return success(manifestJson(["preview.html"]));
    batchCalls += 1;
    batchTokenLimits.push(
      typeof options === "number" ? options : options.maxTokens ?? 0,
    );
    return success(batchJson([["preview.html", truncated]]));
  };

  const outcome = await generateApp(
    {
      prompt: "build it",
      mode: "update",
      onBatch: () => {
        persisted += 1;
      },
    },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_TRUNCATED");
  assert.equal(persisted, 0);
  // The incomplete preview is not repaired with the same doomed full-file
  // request; it gets one compact retry with its preview-specific ceiling.
  assert.equal(batchCalls, 2);
  assert.deepEqual(batchTokenLimits, [
    Math.min(model.maxOutputTokens, PREVIEW_OUTPUT_TOKENS),
    Math.min(model.maxOutputTokens, PREVIEW_OUTPUT_TOKENS),
  ]);
});

test("malformed preview repair keeps the preview-specific output ceiling", async () => {
  let repairTokenLimit: number | null = null;
  const complete: NonNullable<AgentDependencies["complete"]> = async (
    _model,
    messages,
    options,
  ) => {
    if (isPlanner(messages)) return success(manifestJson(["preview.html"]));
    if (isRepair(messages)) {
      repairTokenLimit =
        typeof options === "number" ? options : options.maxTokens ?? null;
      return success(batchJson([["preview.html", VALID_PREVIEW]]));
    }
    return success("not json at all");
  };

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.equal(
    repairTokenLimit,
    Math.min(model.maxOutputTokens, PREVIEW_OUTPUT_TOKENS),
  );
  assert.ok(repairTokenLimit !== null);
  assert.ok(
    repairTokenLimit > Math.min(model.maxOutputTokens, BATCH_OUTPUT_TOKENS),
  );
});

test("a success-shaped response with finish_reason length is still a truncation", async () => {
  const batchCalls: string[][] = [];
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts", "b.ts"]));
    const paths = requestedPaths(messages);
    batchCalls.push(paths);
    if (paths.length > 1) {
      return success(
        batchJson(paths.map((path) => [path, `content:${path}`] as [string, string])),
        "length",
      );
    }
    return success(batchJson(paths.map((path) => [path, `content:${path}`] as [string, string])));
  });

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.deepEqual(batchCalls, [["a.ts", "b.ts"], ["a.ts"], ["b.ts"]]);
});

test("a later batch timeout keeps the completed preview and fails as a resumable timeout", async () => {
  const persisted: string[] = [];
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["preview.html", "a.ts"]));
    const paths = requestedPaths(messages);
    if (paths.includes("preview.html")) {
      return success(batchJson([["preview.html", VALID_PREVIEW]]));
    }
    return failure("TIMEOUT", { retryable: true });
  });

  const outcome = await generateApp(
    {
      prompt: "build it",
      mode: "update",
      onBatch: (batch) => {
        persisted.push(...batch.files.map((file) => file.path));
      },
    },
    { complete, sleep: noop, now: () => Date.now() },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_TIMEOUT");
  assert.deepEqual(persisted, ["preview.html"]);
  assert.deepEqual(outcome.partial.completedPaths, ["preview.html"]);
});

test("no provider call starts when the remaining budget is below the minimum useful attempt", async () => {
  let calls = 0;
  const complete = provider((messages) => {
    calls += 1;
    if (isPlanner(messages)) return success(manifestJson(["a.ts"]));
    return success(batchJson([["a.ts", "valid"]]));
  });

  /**
   * A 30 s budget leaves 10 s of provider work after the 20 s finalization
   * reserve — below `MIN_USEFUL_ATTEMPT_MS`. The honest outcome is a typed,
   * resumable deadline failure with no provider request at all.
   */
  const outcome = await generateApp(
    { prompt: "build it", mode: "update", budgetMs: 30_000 },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_TIMEOUT");
  assert.equal(calls, 0);
  assert.equal(outcome.usage.attempts, 0);
  assert.deepEqual(outcome.attempts, []);
});

// ── Timeout retry policy ───────────────────────────────────────────────────

test("a timed-out multi-file batch is reduced in scope, never retried identically", async () => {
  const batchCalls: string[][] = [];
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts", "b.ts"]));
    const paths = requestedPaths(messages);
    batchCalls.push(paths);
    // The oversized request does not fit its window; the smaller ones do.
    if (paths.length > 1) return failure("TIMEOUT", { retryable: true });
    return success(batchJson(paths.map((path) => [path, `content:${path}`])));
  });

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  /**
   * One request for the whole batch, then two narrower ones. The old policy
   * would have sent the SAME two-file request up to four times.
   */
  assert.deepEqual(batchCalls, [["a.ts", "b.ts"], ["a.ts"], ["b.ts"]]);
});

test("a timed-out single file gets exactly one narrower retry", async () => {
  let batchCalls = 0;
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["only.ts"]));
    batchCalls += 1;
    if (batchCalls === 1) return failure("TIMEOUT", { retryable: true });
    return success(batchJson([["only.ts", "content"]]));
  });

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.equal(batchCalls, 2);
});

function manifestWithSizes(files: ReadonlyArray<[string, number]>): string {
  return JSON.stringify({
    message: "Built the requested app.",
    files: files.map(([path, estimatedBytes]) => ({ path, estimatedBytes })),
    deletedPaths: [],
  });
}

/**
 * ═══ CROSS-FILE TIMEOUTS ARE A BUDGET POSITION, NOT A FILE ═════════════════
 *
 * One run has one ~200 s provider window. These tests pin the scheduling rule
 * that made two unrelated SMALL files (`components/ui/icon.tsx`, `app/globals.css`)
 * fail with the same message: whichever file sat at the end of the queue was
 * scheduled inside a window smaller than its own floor.
 */
test("the first of three batches cannot spend the whole run budget", async () => {
  // 17 files at 6 KB each: 8 + 8 + 1 with MAX_BATCH_FILES/MAX_BATCH_ESTIMATED_BYTES.
  const paths = Array.from({ length: 17 }, (_, index) => `f${index + 1}.ts`);
  const batchTimeouts: number[] = [];
  const clock = { now: 1_000_000 };

  const complete: NonNullable<AgentDependencies["complete"]> = async (
    _model,
    messages,
    options,
  ) => {
    if (isPlanner(messages)) {
      return success(manifestWithSizes(paths.map((path) => [path, 6_000] as [string, number])));
    }
    const requested = requestedPaths(messages);
    const timeoutMs = typeof options === "number" ? 0 : options.timeoutMs ?? 0;
    batchTimeouts.push(timeoutMs);
    // The provider uses the window it was given, so the run clock really moves.
    clock.now += timeoutMs;
    return success(batchJson(requested.map((path) => [path, `content:${path}`] as [string, string])));
  };

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop, now: () => clock.now },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.equal(batchTimeouts.length, 3);
  /**
   * 220 s of provider work (240 s budget − the 20 s finalization reserve). The
   * previous schedule gave the first batch 132 s, the second 60 s and then
   * REFUSED the third: the run failed having written 2 of 3 groups. Reserving each
   * queued group's own floor makes all three fit.
   */
  assert.equal(batchTimeouts[0], 148_000);
  assert.ok(batchTimeouts.every((timeout) => timeout >= 12_000));
  assert.ok(
    batchTimeouts.reduce((total, timeout) => total + timeout, 0) <= 220_000,
    "the schedules must fit the window they were planned in",
  );
});

test("a 2 KB file is still attempted when only ~25 s of the run remain", async () => {
  const clock = { now: 1_000_000 };
  const batchTimeouts: number[] = [];

  const complete: NonNullable<AgentDependencies["complete"]> = async (
    _model,
    messages,
    options,
  ) => {
    if (isPlanner(messages)) {
      // A slow plan consumes most of the window, as it does in production.
      clock.now += 195_000;
      return success(manifestWithSizes([["app/globals.css", 2_000]]));
    }
    batchTimeouts.push(typeof options === "number" ? 0 : options.timeoutMs ?? 0);
    return success(batchJson([["app/globals.css", "body{margin:0}"]]));
  };

  const outcome = await generateApp(
    { prompt: "make the theme darker", mode: "update" },
    { complete, sleep: noop, now: () => clock.now },
  );

  // The full-batch 60 s floor used to refuse this call outright.
  assert.equal(isGenerationFailure(outcome), false);
  assert.deepEqual(batchTimeouts, [25_000]);
});

test("a full-size group is not started when its own floor cannot fit, and nothing is spent", async () => {
  const clock = { now: 1_000_000 };
  let batchCalls = 0;

  const complete: NonNullable<AgentDependencies["complete"]> = async (
    _model,
    messages,
  ) => {
    if (isPlanner(messages)) {
      // Leave 45 s: below this 48 KB group's own 60 s floor, so no usable attempt
      // exists. The loop must say so instead of starting a doomed request and
      // then blaming the model for "running out of time twice".
      clock.now += 175_000;
      return success(manifestWithSizes([["only.ts", 48_000]]));
    }
    batchCalls += 1;
    throw new Error("the provider must not be called when the budget refuses the request");
  };

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop, now: () => clock.now },
  );

  assert.equal(batchCalls, 0);
  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.usage.attempts, 1, "only the plan was a provider request");
  assert.equal(outcome.code, "GENERATION_TIMEOUT");
  assert.match(outcome.error, /reached its time budget/);
  assert.doesNotMatch(outcome.error, /narrower retry/);
});

test("a timed-out preview is never persisted as a completed artifact", async () => {
  const persisted: string[] = [];
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["preview.html"]));
    return failure("TIMEOUT", { retryable: true });
  });

  const outcome = await generateApp(
    {
      prompt: "build it",
      mode: "update",
      onBatch: (batch) => {
        persisted.push(...batch.files.map((file) => file.path));
      },
    },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), true);
  if (!isGenerationFailure(outcome)) return;
  assert.equal(outcome.code, "GENERATION_TIMEOUT");
  assert.deepEqual(persisted, []);
});

test("a transient batch failure still gets one backoff retry", async () => {
  let batchCalls = 0;
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts"]));
    batchCalls += 1;
    if (batchCalls === 1) return failure("TRANSIENT", { retryable: true });
    return success(batchJson([["a.ts", "content"]]));
  });

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop, random: () => 0 },
  );

  assert.equal(isGenerationFailure(outcome), false);
  assert.equal(batchCalls, 2);
});

test("the provider-attempt ceiling stops the run before another paid call", async () => {
  const original = process.env.MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN;
  process.env.MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN = "4";
  let calls = 0;
  try {
    const complete = provider((messages) => {
      calls += 1;
      if (isPlanner(messages)) return success(manifestJson(["a.ts", "b.ts", "c.ts", "d.ts"]));
      return failure("TIMEOUT", { retryable: true });
    });

    const outcome = await generateApp(
      { prompt: "build it", mode: "update" },
      { complete, sleep: noop },
    );

    assert.equal(isGenerationFailure(outcome), true);
    if (!isGenerationFailure(outcome)) return;
    assert.equal(outcome.code, "GENERATION_SPEND_LIMIT");
    // The plan plus three real batch calls: the fifth attempt is refused locally.
    assert.equal(calls, 4);
    assert.equal(outcome.usage.attempts, 4);
  } finally {
    if (original === undefined) delete process.env.MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN;
    else process.env.MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN = original;
  }
});

test("usage totals are accumulated even when the attempt list is capped", async () => {
  // Each recorded attempt reports 11 prompt / 7 completion / 0.001 USD.
  const complete = provider((messages) => {
    if (isPlanner(messages)) return success(manifestJson(["a.ts", "b.ts"]));
    const paths = requestedPaths(messages);
    if (paths.length > 1) return failure("TIMEOUT", { retryable: true });
    return success(batchJson(paths.map((path) => [path, `content:${path}`])));
  });

  const outcome = await generateApp(
    { prompt: "build it", mode: "update" },
    { complete, sleep: noop },
  );

  assert.equal(isGenerationFailure(outcome), false);
  if (isGenerationFailure(outcome)) return;
  /**
   * Four real provider calls: the plan, the timed-out batch (which reported no
   * usage) and the two narrower batches. Tokens come from the calls that
   * reported them; the failed call contributes zero, not an invented value.
   */
  assert.equal(outcome.result.usage.attempts, 4);
  assert.equal(outcome.result.usage.promptTokens, 33);
  assert.equal(outcome.result.usage.completionTokens, 21);
  assert.equal(outcome.result.usage.costUsd, 0.003);
});
