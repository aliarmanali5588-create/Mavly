"use client";

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

const CHANNEL_NAME = "mavly-admin-notifications";
const DISPOSE_GRACE_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type AdminNotificationRealtimeStatus =
  | "CONNECTING"
  | "SUBSCRIBING"
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

export type AdminNotificationRealtimeEvent = {
  event: "INSERT" | "UPDATE";
  payload: unknown;
};

type Listener = {
  onEvent: (event: AdminNotificationRealtimeEvent) => void;
  onStatus: (status: AdminNotificationRealtimeStatus, error?: unknown) => void;
};

type SharedRealtime = {
  supabase: SupabaseClient;
  channel: RealtimeChannel | null;
  listeners: Set<Listener>;
  status: AdminNotificationRealtimeStatus;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  opening: boolean;
  generation: number;
  disposed: boolean;
};

let sharedRealtime: SharedRealtime | null = null;
const receivedInsertIds = new Set<string>();

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown Realtime error";
  }
}

function log(message: string, details?: unknown) {
  console.info(`[admin notifications] ${message}`, details ?? "");
}

function logError(message: string, error?: unknown) {
  console.error(`[admin notifications] ${message}`, error ?? "");
}

function notifyStatus(
  state: SharedRealtime,
  status: AdminNotificationRealtimeStatus,
  error?: unknown,
): void {
  state.status = status;
  log(`Realtime status: ${status}`, error ? { error: errorMessage(error) } : undefined);
  for (const listener of state.listeners) {
    try {
      listener.onStatus(status, error);
    } catch (listenerError) {
      logError("Realtime status listener failed", listenerError);
    }
  }
}

function notifyEvent(
  state: SharedRealtime,
  event: AdminNotificationRealtimeEvent,
  notificationId: string | null,
): void {
  if (event.event === "INSERT" && notificationId) {
    if (receivedInsertIds.has(notificationId)) {
      log("duplicate INSERT suppressed", { notificationId });
      return;
    }
    receivedInsertIds.add(notificationId);
  }

  log("incoming database event", { event: event.event, notificationId });
  if (notificationId) log("notification ID received", { notificationId });
  for (const listener of state.listeners) {
    try {
      listener.onEvent(event);
    } catch (listenerError) {
      logError("Realtime event listener failed", listenerError);
    }
  }
}

function payloadNotificationId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { new?: unknown };
  if (!record.new || typeof record.new !== "object") return null;
  const id = (record.new as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function scheduleReconnect(state: SharedRealtime, reason: string): void {
  if (state.disposed || state.listeners.size === 0 || state.reconnectTimer) return;

  state.reconnectAttempt += 1;
  const delay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    1_000 * 2 ** Math.min(state.reconnectAttempt - 1, 5),
  );
  log("Realtime reconnect attempt scheduled", {
    attempt: state.reconnectAttempt,
    delayMs: delay,
    reason,
  });
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.disposed || state.listeners.size === 0) return;

    const previousChannel = state.channel;
    state.channel = null;
    state.generation += 1;
    if (previousChannel) void state.supabase.removeChannel(previousChannel);
    log("attempting Realtime reconnect", { attempt: state.reconnectAttempt });
    void openChannel(state, "reconnect");
  }, delay);
}

async function openChannel(state: SharedRealtime, reason: "initial" | "reconnect"): Promise<void> {
  if (state.disposed || state.listeners.size === 0 || state.opening || state.channel) return;

  state.opening = true;
  const generation = ++state.generation;
  notifyStatus(state, "CONNECTING");
  log("subscription initialization", { channel: CHANNEL_NAME, reason });

  try {
    const { data, error } = await state.supabase.auth.getSession();
    if (state.disposed || state.generation !== generation || state.listeners.size === 0) return;
    if (error) throw error;
    if (!data.session) throw new Error("No authenticated Supabase session is available.");

    // Supabase normally performs this automatically. Doing it after the session
    // read removes the auth-hydration race before the channel join is attempted.
    await state.supabase.realtime.setAuth(data.session.access_token);
    if (state.disposed || state.generation !== generation || state.listeners.size === 0) return;

    const channel = state.supabase.channel(CHANNEL_NAME, {
      config: {
        // SUBSCRIBED must mean the table change subscription is active, not only
        // that the Phoenix channel joined before Postgres CDC was ready.
        postgres_changes_options: { wait: true, timeout: 15_000 },
      },
    });
    state.channel = channel;
    channel
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "admin_notifications" },
        (payload) => notifyEvent(state, { event: "INSERT", payload }, payloadNotificationId(payload)),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "admin_notifications" },
        (payload) => notifyEvent(state, { event: "UPDATE", payload }, payloadNotificationId(payload)),
      );

    notifyStatus(state, "SUBSCRIBING");
    log("Realtime channel subscribe called", { channel: CHANNEL_NAME });
    channel.subscribe((status, error) => {
      if (state.disposed || state.channel !== channel || state.generation !== generation) return;
      if (status === "SUBSCRIBED") {
        state.reconnectAttempt = 0;
        if (state.reconnectTimer) {
          clearTimeout(state.reconnectTimer);
          state.reconnectTimer = null;
        }
        notifyStatus(state, "SUBSCRIBED");
        return;
      }

      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        logError("Realtime error", error ?? new Error(status));
        notifyStatus(state, status, error);
        scheduleReconnect(state, error ? `${status}: ${errorMessage(error)}` : status);
      }
    });
  } catch (error) {
    if (state.disposed || state.generation !== generation) return;
    logError("Realtime subscription initialization failed", error);
    notifyStatus(state, "CHANNEL_ERROR", error);
    scheduleReconnect(state, errorMessage(error));
  } finally {
    if (state.generation === generation) state.opening = false;
  }
}

function disposeLater(state: SharedRealtime): void {
  if (state.disposeTimer) clearTimeout(state.disposeTimer);
  state.disposeTimer = setTimeout(() => {
    state.disposeTimer = null;
    if (state.listeners.size > 0) return;
    state.disposed = true;
    state.generation += 1;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    const channel = state.channel;
    state.channel = null;
    if (channel) void state.supabase.removeChannel(channel);
    if (sharedRealtime === state) sharedRealtime = null;
    log("Realtime channel removed after the last admin listener detached", { channel: CHANNEL_NAME });
  }, DISPOSE_GRACE_MS);
}

export function subscribeToAdminNotificationRealtime(listener: Listener): () => void {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) {
    listener.onStatus("CHANNEL_ERROR", new Error("Supabase is not configured."));
    return () => undefined;
  }

  let state = sharedRealtime;
  if (!state || state.disposed || state.supabase !== supabase) {
    state = {
      supabase,
      channel: null,
      listeners: new Set(),
      status: "CLOSED",
      reconnectAttempt: 0,
      reconnectTimer: null,
      disposeTimer: null,
      opening: false,
      generation: 0,
      disposed: false,
    };
    sharedRealtime = state;
  }

  if (state.disposeTimer) {
    clearTimeout(state.disposeTimer);
    state.disposeTimer = null;
  }
  state.listeners.add(listener);

  if (state.status === "SUBSCRIBED" || state.status === "SUBSCRIBING") {
    Promise.resolve().then(() => {
      if (!state?.disposed && state.listeners.has(listener)) listener.onStatus(state.status);
    });
  }
  if (!state.channel && !state.opening) void openChannel(state, "initial");

  return () => {
    state?.listeners.delete(listener);
    if (state && state.listeners.size === 0) disposeLater(state);
  };
}
