"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { vcaasApi } from "@/lib/vcaas";
import {
  attemptAudioPlayback,
  claimAgentTaskNotification,
  completedAgentTaskIds,
} from "@/lib/agent-completion-sound";
import type { WorkflowView } from "@/lib/vcaas-types";

const SOUND_URL = "/sound/notification.wav";
const ENABLED_KEY = "mavly:agent-completion-sounds-enabled";
const POLL_INTERVAL_MS = 5_000;
const MAX_SAVED_COMPLETIONS = 200;

function seenStorageKey(projectId: string): string {
  return `mavly:agent-completion-sounds:${projectId}:seen`;
}

function isTerminalTask(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "skipped" ||
    status === "cancelled"
  );
}

function makeAudio(): HTMLAudioElement | null {
  try {
    const audio = new Audio(SOUND_URL);
    audio.preload = "auto";
    return audio;
  } catch {
    return null;
  }
}

export function useAgentCompletionSounds(projectId: string) {
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const enabledRef = useRef(true);
  const playbackBlockedRef = useRef(false);
  const seenRef = useRef(new Set<string>());
  const previousWorkflowRef = useRef<WorkflowView | null>(null);
  const previousObservedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestInFlightRef = useRef(false);
  const observeRef = useRef<(() => void) | null>(null);
  const retryCountRef = useRef(0);
  const lifecycleRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedulePolling = useCallback(() => {
    if (!enabledRef.current || timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      observeRef.current?.();
    }, POLL_INTERVAL_MS);
  }, []);

  const observeWorkflow = useCallback(async () => {
    if (!enabledRef.current || requestInFlightRef.current) return;
    const lifecycle = lifecycleRef.current;
    requestInFlightRef.current = true;
    const observedSince = previousObservedAtRef.current ?? Date.now();
    const observedAt = Date.now();

    try {
      const response = await vcaasApi.agent.workflow(projectId);
      if (!enabledRef.current || lifecycle !== lifecycleRef.current) return;

      if (!response.ok) {
        retryCountRef.current += 1;
        const workflowInProgress = previousWorkflowRef.current?.tasks.some(
          (task) => !isTerminalTask(task.status),
        );
        if (retryCountRef.current <= 3 || workflowInProgress) schedulePolling();
        return;
      }

      retryCountRef.current = 0;
      if (!response.data.enabled) {
        previousWorkflowRef.current = null;
        previousObservedAtRef.current = Date.now();
        stopPolling();
        return;
      }

      const current = response.data.workflow;
      if (!current) {
        stopPolling();
        return;
      }

      const previous = previousWorkflowRef.current;
      for (const id of completedAgentTaskIds(projectId, previous, current, observedSince)) {
        if (!enabledRef.current || lifecycle !== lifecycleRef.current) break;
        let alreadyStored = false;
        try {
          const stored = localStorage.getItem(seenStorageKey(projectId));
          const ids: unknown = stored ? JSON.parse(stored) : [];
          alreadyStored = Array.isArray(ids) && ids.includes(id);
        } catch {
          // In-memory deduplication remains active if browser storage is unavailable.
        }
        if (alreadyStored || !claimAgentTaskNotification(id, seenRef.current)) continue;

        try {
          const saved = Array.from(seenRef.current).slice(-MAX_SAVED_COMPLETIONS);
          localStorage.setItem(seenStorageKey(projectId), JSON.stringify(saved));
        } catch {
          // In-memory deduplication remains active if browser storage is unavailable.
        }

        if (playbackBlockedRef.current) continue;
        const audio = makeAudio();
        const played = audio
          ? await attemptAudioPlayback(() => audio.play())
          : false;
        if (
          !played &&
          enabledRef.current &&
          lifecycle === lifecycleRef.current
        ) {
          playbackBlockedRef.current = true;
          setError("Task sound could not play. Check browser audio settings and enable sounds again.");
        }
      }

      previousWorkflowRef.current = current;
      previousObservedAtRef.current = observedAt;
      if (current.tasks.some((task) => !isTerminalTask(task.status))) {
        schedulePolling();
      } else {
        stopPolling();
      }
    } finally {
      if (lifecycle === lifecycleRef.current) requestInFlightRef.current = false;
    }
  }, [projectId, schedulePolling, stopPolling]);

  observeRef.current = () => {
    void observeWorkflow();
  };

  useEffect(() => {
    lifecycleRef.current += 1;
    previousWorkflowRef.current = null;
    previousObservedAtRef.current = null;
    playbackBlockedRef.current = false;
    seenRef.current = new Set();
    let soundsEnabled = true;
    try {
      const stored = localStorage.getItem(seenStorageKey(projectId));
      const ids: unknown = stored ? JSON.parse(stored) : [];
      if (Array.isArray(ids)) {
        seenRef.current = new Set(ids.filter((id): id is string => typeof id === "string"));
      }
      soundsEnabled = localStorage.getItem(ENABLED_KEY) !== "false";
    } catch {
      // The sound preference and deduplication are memory-only when storage is unavailable.
    }
    enabledRef.current = soundsEnabled;
    setEnabled(soundsEnabled);

    if (enabledRef.current) void observeWorkflow();
    return () => {
      lifecycleRef.current += 1;
      enabledRef.current = false;
      stopPolling();
      requestInFlightRef.current = false;
    };
  }, [observeWorkflow, projectId, stopPolling]);

  const enable = useCallback(async () => {
    setError(null);
    const audio = makeAudio();
    const played = audio ? await attemptAudioPlayback(() => audio.play()) : false;
    if (!played) {
      setError("Could not enable sounds. Check browser audio settings and try again.");
      return;
    }

    enabledRef.current = true;
    setEnabled(true);
    playbackBlockedRef.current = false;
    setError(null);
    try {
      localStorage.setItem(ENABLED_KEY, "true");
    } catch {
      // The setting remains enabled for this page session.
    }
    void observeWorkflow();
  }, [observeWorkflow]);

  const disable = useCallback(() => {
    enabledRef.current = false;
    setEnabled(false);
    setError(null);
    stopPolling();
    try {
      localStorage.setItem(ENABLED_KEY, "false");
    } catch {
      // The setting remains disabled for this page session.
    }
  }, [stopPolling]);

  return { enabled, error, enable, disable, observeWorkflow };
}
