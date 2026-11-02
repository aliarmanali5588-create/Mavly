"use client";

import * as React from "react";

import {
  desktopNotificationBody,
  adminNotificationDestination,
  normalizeAdminNotification,
  type AdminNotification,
  type AdminNotificationsPage,
} from "@/lib/admin/notifications";
import { getAdminNotificationAudioManager } from "@/lib/admin/notification-audio";
import {
  subscribeToAdminNotificationRealtime,
  type AdminNotificationRealtimeEvent,
  type AdminNotificationRealtimeStatus,
} from "@/lib/admin/notification-realtime";

const PAGE_SIZE = 20;
const SOUND_PREFERENCE_KEY = "mavly-admin-notification-sound";

interface QueryState {
  rows: AdminNotification[];
  unreadCount: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

function readData<T>(response: Response): Promise<T> {
  return response.json().then((body: { ok?: boolean; data?: T; error?: string }) => {
    if (!response.ok || body.ok !== true || body.data === undefined) {
      throw new Error(body.error || "Admin notifications could not be loaded.");
    }
    return body.data;
  });
}

function notificationFromRealtime(value: unknown): AdminNotification | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return normalizeAdminNotification({
    id: row.id,
    eventType: row.event_type,
    title: row.title,
    message: row.message,
    userId: row.user_id,
    metadata: row.metadata,
    createdAt: row.created_at,
    readAt: row.read_at,
  });
}

function soundPreference(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SOUND_PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

function sortNotifications(rows: AdminNotification[]): AdminNotification[] {
  return [...rows].sort((left, right) => {
    const createdDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return createdDifference || right.id.localeCompare(left.id);
  });
}

function mergeNotifications(
  existing: AdminNotification[],
  incoming: AdminNotification[],
): AdminNotification[] {
  const byId = new Map<string, AdminNotification>();
  existing.forEach((row) => byId.set(row.id, row));
  incoming.forEach((row) => byId.set(row.id, row));
  return sortNotifications([...byId.values()]);
}

function realtimeErrorMessage(status: AdminNotificationRealtimeStatus, error?: unknown): string {
  if (error instanceof Error && error.message) return `${status}: ${error.message}`;
  return status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT"
    ? "Live notification delivery is unavailable; history remains available."
    : "";
}

export function useAdminNotifications(enabled = true) {
  const [state, setState] = React.useState<QueryState>({
    rows: [],
    unreadCount: 0,
    total: 0,
    hasMore: false,
    loading: enabled,
    loadingMore: false,
    error: null,
  });
  const [desktopPermission, setDesktopPermission] = React.useState<NotificationPermission | "unsupported">(
    "unsupported",
  );
  const [soundOn, setSoundOn] = React.useState(true);
  const knownIds = React.useRef(new Set<string>());
  const liveInsertRows = React.useRef(new Map<string, { notification: AdminNotification; receivedAt: number }>());
  const historyOffset = React.useRef(0);
  const historyLoaded = React.useRef(false);
  const rowsRef = React.useRef<AdminNotification[]>([]);
  const soundOnRef = React.useRef(true);
  const mounted = React.useRef(true);
  const audioManager = React.useMemo(() => getAdminNotificationAudioManager(), []);

  const showDesktopAlert = React.useCallback((notification: AdminNotification) => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    try {
      const alert = new Notification(`MAVLY — ${notification.title}`, {
        body: desktopNotificationBody(notification.eventType),
        tag: `mavly-admin-${notification.id}`,
      });
      alert.onclick = () => {
        window.focus();
        window.location.assign(adminNotificationDestination(notification.eventType));
        alert.close();
      };
    } catch (error) {
      console.error("[admin notifications] desktop notification was rejected", error);
    }
  }, []);

  const announce = React.useCallback(
    (notification: AdminNotification) => {
      // This callback is called only from a live INSERT handler. History and
      // reconciliation paths never call it, so historical rows cannot make a
      // sound after refresh or navigation.
      audioManager.play(notification.id, soundOnRef.current);
      showDesktopAlert(notification);
    },
    [audioManager, showDesktopAlert],
  );

  React.useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      setState((current) => ({ ...current, loading: false }));
      return () => {
        mounted.current = false;
      };
    }

    const selectedSound = soundPreference();
    soundOnRef.current = selectedSound;
    setSoundOn(selectedSound);
    audioManager.setEnabled(selectedSound);
    audioManager.initialize();
    const releaseUnlockListeners = audioManager.attachUnlockListeners();

    if (typeof window !== "undefined" && "Notification" in window) {
      setDesktopPermission(Notification.permission);
    }

    let disposed = false;
    let initialRequest: Promise<void> | null = null;
    let reconciliationRequest: Promise<void> | null = null;

    const applyPage = (page: AdminNotificationsPage, initial: boolean, requestedAt: number) => {
      page.rows.forEach((row) => knownIds.current.add(row.id));
      const mergedRows = mergeNotifications(rowsRef.current, page.rows);
      rowsRef.current = mergedRows;
      const pageIds = new Set(page.rows.map((row) => row.id));
      const oldestPageTimestamp =
        page.rows.length >= PAGE_SIZE ? Date.parse(page.rows[page.rows.length - 1]?.createdAt ?? "") : Number.POSITIVE_INFINITY;
      const liveRowsMissedByThisSnapshot = [...liveInsertRows.current.values()]
        .filter(({ notification, receivedAt }) => {
          if (receivedAt < requestedAt || pageIds.has(notification.id)) return false;
          if (page.rows.length < PAGE_SIZE || !Number.isFinite(oldestPageTimestamp)) return true;
          const liveTimestamp = Date.parse(notification.createdAt);
          return !Number.isFinite(liveTimestamp) || liveTimestamp >= oldestPageTimestamp;
        })
        .map(({ notification }) => notification);
      const snapshotUnreadCount =
        page.unreadCount + liveRowsMissedByThisSnapshot.filter((row) => row.readAt === null).length;
      const snapshotTotal = page.total + liveRowsMissedByThisSnapshot.length;
      // The page includes the complete database count. The max in the state
      // updater preserves a live INSERT that was delivered while this request
      // was in flight; the next reconciliation replaces it authoritatively.
      historyOffset.current = Math.max(historyOffset.current, mergedRows.length);
      if (initial) historyLoaded.current = true;
      setState((current) => ({
        ...current,
        rows: mergedRows,
        unreadCount: initial ? Math.max(snapshotUnreadCount, current.unreadCount) : snapshotUnreadCount,
        total: initial ? Math.max(snapshotTotal, current.total) : snapshotTotal,
        hasMore: page.hasMore,
        loading: false,
        error: null,
      }));
    };

    const loadPage = async (offset: number, initial: boolean): Promise<void> => {
      const requestedAt = Date.now();
      try {
        const response = await fetch(`/api/adminsh/notifications?limit=${PAGE_SIZE}&offset=${offset}`, {
          cache: "no-store",
        });
        const page = await readData<AdminNotificationsPage>(response);
        if (disposed || !mounted.current) return;
        applyPage(page, initial, requestedAt);
      } catch (cause) {
        if (disposed || !mounted.current) return;
        setState((current) => ({
          ...current,
          loading: initial ? false : current.loading,
          error: cause instanceof Error ? cause.message : "Admin notifications could not be loaded.",
        }));
      }
    };

    const startInitialHistory = () => {
      if (disposed || historyLoaded.current || initialRequest) return;
      initialRequest = loadPage(0, true).finally(() => {
        initialRequest = null;
      });
      void initialRequest;
    };

    const reconcileHistory = () => {
      if (disposed) return;
      if (!historyLoaded.current) {
        startInitialHistory();
        return;
      }
      if (reconciliationRequest) return;
      reconciliationRequest = loadPage(0, false).finally(() => {
        reconciliationRequest = null;
      });
      void reconciliationRequest;
    };

    const onRealtimeEvent = (event: AdminNotificationRealtimeEvent) => {
      if (disposed || !mounted.current) return;
      const payload = event.payload as { new?: unknown };
      const notification = notificationFromRealtime(payload.new);
      if (!notification) {
        console.warn("[admin notifications] ignored an invalid Realtime payload", { event: event.event });
        return;
      }

      if (event.event === "INSERT") {
        const alreadyKnownFromHistory = knownIds.current.has(notification.id);
        knownIds.current.add(notification.id);
        liveInsertRows.current.set(notification.id, { notification, receivedAt: Date.now() });
        const nextRows = mergeNotifications(rowsRef.current, [notification]);
        rowsRef.current = nextRows;
        if (historyLoaded.current && !alreadyKnownFromHistory) historyOffset.current += 1;
        setState((current) => ({
          ...current,
          rows: nextRows,
          unreadCount:
            notification.readAt || alreadyKnownFromHistory ? current.unreadCount : current.unreadCount + 1,
          total: alreadyKnownFromHistory ? current.total : current.total + 1,
          loading: false,
        }));
        announce(notification);
        return;
      }

      const nextRows = rowsRef.current.map((row) => (row.id === notification.id ? notification : row));
      rowsRef.current = nextRows;
      const liveInsert = liveInsertRows.current.get(notification.id);
      if (liveInsert) liveInsertRows.current.set(notification.id, { notification, receivedAt: liveInsert.receivedAt });
      setState((current) => {
        const previous = current.rows.find((row) => row.id === notification.id);
        const unreadDelta =
          previous && previous.readAt === null && notification.readAt !== null
            ? -1
            : previous && previous.readAt !== null && notification.readAt === null
              ? 1
              : 0;
        return {
          ...current,
          unreadCount: Math.max(0, current.unreadCount + unreadDelta),
          rows: nextRows,
        };
      });
    };

    const onRealtimeStatus = (status: AdminNotificationRealtimeStatus, error?: unknown) => {
      if (disposed || !mounted.current) return;
      if (status === "SUBSCRIBING") startInitialHistory();
      if (status === "SUBSCRIBED") {
        if (historyLoaded.current) {
          reconcileHistory();
        } else if (initialRequest) {
          void initialRequest.then(() => {
            if (disposed) return;
            if (historyLoaded.current) reconcileHistory();
            else startInitialHistory();
          });
        } else {
          startInitialHistory();
        }
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        const message = realtimeErrorMessage(status, error);
        console.warn("[admin notifications] live delivery status", { status, error: message });
        setState((current) => ({
          ...current,
          error: current.rows.length > 0 ? current.error : message,
        }));
        startInitialHistory();
      }
    };

    const releaseRealtime = subscribeToAdminNotificationRealtime({ onEvent: onRealtimeEvent, onStatus: onRealtimeStatus });
    // The manager starts the channel before emitting SUBSCRIBING. This fallback
    // prevents a permanently pending history view if auth or Realtime is down.
    const historyFallback = window.setTimeout(startInitialHistory, 5_000);

    return () => {
      disposed = true;
      mounted.current = false;
      window.clearTimeout(historyFallback);
      releaseRealtime();
      releaseUnlockListeners();
    };
  }, [audioManager, announce, enabled]);

  const requestDesktopNotifications = React.useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setDesktopPermission("unsupported");
      return "unsupported" as const;
    }
    if (Notification.permission === "denied") {
      setDesktopPermission("denied");
      return "denied" as const;
    }
    const permission = await Notification.requestPermission();
    setDesktopPermission(permission);
    return permission;
  }, []);

  const setSoundPreference = React.useCallback(
    (value: boolean) => {
      soundOnRef.current = value;
      setSoundOn(value);
      audioManager.setEnabled(value);
      try {
        window.localStorage.setItem(SOUND_PREFERENCE_KEY, value ? "on" : "off");
      } catch {
        // A storage restriction must not disable in-app notifications.
      }
      if (value) void audioManager.unlockFromGesture();
    },
    [audioManager],
  );

  const markRead = React.useCallback(async (id: string) => {
    const response = await fetch("/api/adminsh/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_read", notificationId: id }),
      cache: "no-store",
    });
    const result = await readData<{ unreadCount: number }>(response);
    const nextRows = rowsRef.current.map((row) =>
      row.id === id ? { ...row, readAt: row.readAt ?? new Date().toISOString() } : row,
    );
    rowsRef.current = nextRows;
    const liveInsert = liveInsertRows.current.get(id);
    if (liveInsert) {
      liveInsertRows.current.set(id, {
        ...liveInsert,
        notification: {
          ...liveInsert.notification,
          readAt: liveInsert.notification.readAt ?? new Date().toISOString(),
        },
      });
    }
    setState((current) => ({ ...current, unreadCount: result.unreadCount, rows: nextRows }));
  }, []);

  const markAllRead = React.useCallback(async () => {
    const response = await fetch("/api/adminsh/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_all_read" }),
      cache: "no-store",
    });
    await readData<{ unreadCount: number }>(response);
    const nextRows = rowsRef.current.map((row) => ({
      ...row,
      readAt: row.readAt ?? new Date().toISOString(),
    }));
    rowsRef.current = nextRows;
    for (const [id, liveInsert] of liveInsertRows.current) {
      liveInsertRows.current.set(id, {
        ...liveInsert,
        notification: {
          ...liveInsert.notification,
          readAt: liveInsert.notification.readAt ?? new Date().toISOString(),
        },
      });
    }
    setState((current) => ({ ...current, unreadCount: 0, rows: nextRows }));
  }, []);

  const loadMore = React.useCallback(async () => {
    if (!state.hasMore || state.loadingMore) return;
    setState((current) => ({ ...current, loadingMore: true }));
    const requestOffset = historyOffset.current;
    try {
      const response = await fetch(
        `/api/adminsh/notifications?limit=${PAGE_SIZE}&offset=${requestOffset}`,
        { cache: "no-store" },
      );
      const page = await readData<AdminNotificationsPage>(response);
      const rows = page.rows.filter((row) => !knownIds.current.has(row.id));
      rows.forEach((row) => knownIds.current.add(row.id));
      const nextRows = mergeNotifications(rowsRef.current, rows);
      rowsRef.current = nextRows;
      historyOffset.current = Math.max(historyOffset.current, requestOffset + page.rows.length);
      setState((current) => ({
        ...current,
        rows: nextRows,
        hasMore: page.hasMore,
        loadingMore: false,
      }));
    } catch (cause) {
      setState((current) => ({
        ...current,
        loadingMore: false,
        error: cause instanceof Error ? cause.message : "Older notifications could not be loaded.",
      }));
    }
  }, [state.hasMore, state.loadingMore]);

  return {
    ...state,
    desktopPermission,
    soundOn,
    requestDesktopNotifications,
    setSoundPreference,
    markRead,
    markAllRead,
    loadMore,
  };
}
