import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attemptAudioPlayback,
  claimAgentTaskNotification,
  completedAgentTaskIds,
} from "../src/lib/agent-completion-sound";
import type { WorkflowView } from "../src/lib/vcaas-types";

function workflow(
  tasks: Array<Pick<WorkflowView["tasks"][number], "key" | "role" | "status">>,
): WorkflowView {
  return {
    id: "workflow-1",
    runId: "run-1",
    state: "executing",
    complexity: "standard",
    summary: null,
    errorClass: null,
    startedAt: "2026-10-29T10:00:00.000Z",
    finishedAt: null,
    providerCalls: 1,
    repairAttempts: 0,
    reportedCostUsd: null,
    costKnown: false,
    verification: null,
    tasks: tasks.map(({ key, role, status }) => ({
      key,
      role,
      kind: "verify",
      title: key,
      status,
      dependsOn: [],
      required: false,
      attempt: 1,
      maxAttempts: 1,
      summary: null,
      filesChanged: [],
      findings: [],
      verification: null,
      errorClass: null,
      startedAt: null,
      finishedAt: null,
    })) as WorkflowView["tasks"],
  };
}

test("only a task transition to completed creates a notification", () => {
  const previous = workflow([{ key: "qa-review", role: "qa", status: "running" }]);
  const stillRunning = workflow([{ key: "qa-review", role: "qa", status: "running" }]);
  const completed = workflow([{ key: "qa-review", role: "qa", status: "completed" }]);
  const failed = workflow([{ key: "qa-review", role: "qa", status: "failed" }]);

  assert.deepEqual(completedAgentTaskIds("project-1", previous, stillRunning), []);
  assert.deepEqual(completedAgentTaskIds("project-1", previous, completed), [
    "project-1:run-1:qa-review",
  ]);
  assert.deepEqual(completedAgentTaskIds("project-1", previous, failed), []);
});

test("duplicate completion observations are claimed only once", () => {
  const seen = new Set<string>();
  const previous = workflow([{ key: "plan", role: "planner", status: "running" }]);
  const completed = workflow([{ key: "plan", role: "planner", status: "completed" }]);
  const [id] = completedAgentTaskIds("project-1", previous, completed);

  assert.equal(claimAgentTaskNotification(id, seen), true);
  assert.equal(claimAgentTaskNotification(id, seen), false);
});

test("each completed agent task in the same workflow has its own notification ID", () => {
  const previous = workflow([
    { key: "plan", role: "planner", status: "running" },
    { key: "design-review", role: "ui_ux", status: "running" },
    { key: "implement", role: "coding", status: "running" },
    { key: "qa-review", role: "qa", status: "running" },
    { key: "security-review", role: "security", status: "running" },
    { key: "repair", role: "repair", status: "running" },
    { key: "deployment", role: "deployment", status: "running" },
  ]);
  const completed = workflow(previous.tasks.map((task) => ({
    key: task.key,
    role: task.role,
    status: "completed" as const,
  })));

  assert.deepEqual(
    completedAgentTaskIds("project-1", previous, completed),
    [
      "project-1:run-1:plan",
      "project-1:run-1:design-review",
      "project-1:run-1:implement",
      "project-1:run-1:qa-review",
      "project-1:run-1:security-review",
      "project-1:run-1:repair",
      "project-1:run-1:deployment",
    ],
  );
});

test("a completion from another workflow is not treated as a transition", () => {
  const previous = workflow([{ key: "plan", role: "planner", status: "running" }]);
  const completed = workflow([{ key: "plan", role: "planner", status: "completed" }]);
  completed.id = "workflow-2";
  completed.runId = "run-2";

  assert.deepEqual(completedAgentTaskIds("project-1", previous, completed), []);
});

test("a completed task first observed after monitoring began is notified once", () => {
  const completed = workflow([{ key: "plan", role: "planner", status: "completed" }]);
  completed.tasks[0].finishedAt = "2026-10-29T10:00:02.000Z";
  const observedSince = Date.parse("2026-10-29T10:00:01.000Z");

  assert.deepEqual(
    completedAgentTaskIds("project-1", null, completed, observedSince),
    ["project-1:run-1:plan"],
  );
  assert.deepEqual(
    completedAgentTaskIds("project-1", null, completed, Date.parse("2026-10-29T10:00:03.000Z")),
    [],
  );
});

test("audio playback rejection is handled without throwing", async () => {
  assert.equal(await attemptAudioPlayback(() => Promise.resolve()), true);
  assert.equal(
    await attemptAudioPlayback(() => Promise.reject(new Error("NotAllowedError"))),
    false,
  );
});
