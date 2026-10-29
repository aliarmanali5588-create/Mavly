import type { WorkflowView } from "@/lib/vcaas-types";

export function completedAgentTaskIds(
  projectId: string,
  previous: WorkflowView | null,
  current: WorkflowView,
  observedSince?: number,
): string[] {
  const previousStatuses =
    previous &&
    previous.id === current.id &&
    previous.runId === current.runId
      ? new Map(previous.tasks.map((task) => [task.key, task.status]))
      : null;

  return current.tasks
    .filter(
      (task) => {
        if (task.status !== "completed") return false;
        if (previousStatuses) {
          return (
            previousStatuses.has(task.key) &&
            previousStatuses.get(task.key) !== "completed"
          );
        }
        if (observedSince === undefined || !task.finishedAt) return false;
        const finishedAt = Date.parse(task.finishedAt);
        return Number.isFinite(finishedAt) && finishedAt >= observedSince;
      },
    )
    .map((task) => `${projectId}:${current.runId}:${task.key}`);
}

export function claimAgentTaskNotification(id: string, seen: Set<string>): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

export async function attemptAudioPlayback(play: () => Promise<unknown>): Promise<boolean> {
  try {
    await play();
    return true;
  } catch {
    return false;
  }
}
