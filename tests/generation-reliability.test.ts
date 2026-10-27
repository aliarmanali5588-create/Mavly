import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_FILE_BYTES,
  generateApp,
  isGenerationFailure,
  type AgentGenerationInput,
} from "../src/lib/ai/agent";
import {
  type ChatCompletionFailure,
  type ChatCompletionResult,
  type ChatCompletionSuccess,
  type ChatMessage,
} from "../src/lib/ai/freemodel";
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
  options: { retryable?: boolean; finishReason?: string | null } = {},
): ChatCompletionFailure {
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
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        reasoningTokens: null,
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
          path === "preview.html" ? "preview from its requested batch" : `valid:${path}`,
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
    "preview from its requested batch",
  );
}

test("initial generation repairs preview.html returned outside its batch", async () => {
  await assertPreviewStaysInItsOwnBatch("create");
});

test("follow-up edits keep preview.html in its planned batch", async () => {
  await assertPreviewStaysInItsOwnBatch("update");
});

test("follow-up edits resolve legacy model IDs to the FreeModel catalog", async () => {
  const calledModels: string[] = [];
  const outcome = await generateApp(
    {
      prompt: "Change the existing page title.",
      mode: "update",
      requestedModel: "deepseek/deepseek-v4.1-flash",
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
  assert.deepEqual(calledModels, ["claude-opus-4.8", "claude-opus-4.8"]);
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
