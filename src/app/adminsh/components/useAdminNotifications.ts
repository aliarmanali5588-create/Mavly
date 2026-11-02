"use client";

import * as React from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  desktopNotificationBody,
  adminNotificationDestination,
  normalizeAdminNotification,
  type AdminNotification,
  type AdminNotificationsPage,
} from "@/lib/admin/notifications";

const PAGE_SIZE = 20;
const SOUND_PREFERENCE_KEY = "mavly-admin-notification-sound";
const ALERTED_NOTIFICATION_PREFIX = "mavly-admin-alerted-notification:";

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

function alertClaimed(id: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = `${ALERTED_NOTIFICATION_PREFIX}${id}`;
    if (window.localStorage.getItem(key) === "1") return false;
    window.localStorage.setItem(key, "1");
    return true;
  } catch {
    // Private browsing/storage-disabled browsers still get the in-app event.
    return true;
  }
}

function soundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SOUND_PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
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
  const historyOffset = React.useRef(0);
  const alertAudio = React.useRef<HTMLAudioElement | null>(null);
  const audioUnlocked = React.useRef(false);
  const mounted = React.useRef(true);

  const playAlert = React.useCallback(() => {
    if (!soundEnabled()) return;
    const audio = alertAudio.current;
    if (!audio) return;
    audio.currentTime = 0;
    void audio.play().catch(() => {
      // Chrome can reject playback until the admin has interacted with this tab.
    });
  }, []);

  const showDesktopAlert = React.useCallback(
    (notification: AdminNotification) => {
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
      } catch {
        // The in-app notification is authoritative if the browser rejects this.
      }
    },
    [],
  );

  const announce = React.useCallback(
    (notification: AdminNotification) => {
      if (!alertClaimed(notification.id)) return;
      playAlert();
      showDesktopAlert(notification);
    },
    [playAlert, showDesktopAlert],
  );

  React.useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      setState((current) => ({ ...current, loading: false }));
      return () => {
        mounted.current = false;
      };
    }

    setSoundOn(soundEnabled());
    if (typeof window !== "undefined" && "Notification" in window) {
      setDesktopPermission(Notification.permission);
    }

    const audio = new Audio("/sound/adminpanelnotification.mp3");
    audio.preload = "auto";
    alertAudio.current = audio;

    const unlockAudio = () => {
      if (audioUnlocked.current) return;
      audioUnlocked.current = true;
      const previousMuted = audio.muted;
      audio.muted = true;
      void audio.play().then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = previousMuted;
      }).catch(() => {
        audio.muted = previousMuted;
      });
    };
    document.addEventListener("pointerdown", unlockAudio, { once: true });

    const controller = new AbortController();
    fetch(`/api/adminsh/notifications?limit=${PAGE_SIZE}&offset=0`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => readData<AdminNotificationsPage>(response))
      .then((page) => {
        if (!mounted.current) return;
        historyOffset.current = page.rows.length;
        const incoming = page.rows.filter((row) => {
          knownIds.current.add(row.id);
          return true;
        });
        setState((current) => ({
          ...current,
          rows: [
            ...current.rows.filter((row) => !incoming.some((next) => next.id === row.id)),
            ...incoming,
          ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
          unreadCount: page.unreadCount,
          total: page.total,
          hasMore: page.hasMore,
          loading: false,
          error: null,
        }));
      })
      .catch((cause: unknown) => {
        if (!mounted.current || controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: cause instanceof Error ? cause.message : "Admin notifications could not be loaded.",
        }));
      });

    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      ?.channel("mavly-admin-notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "admin_notifications" },
        (payload) => {
          const notification = notificationFromRealtime(payload.new);
          if (!notification || knownIds.current.has(notification.id)) return;
          knownIds.current.add(notification.id);
          setState((current) => ({
            ...current,
            rows: [notification, ...current.rows.filter((row) => row.id !== notification.id)],
            unreadCount: notification.readAt ? current.unreadCount : current.unreadCount + 1,
            total: current.total + 1,
          }));
          announce(notification);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "admin_notifications" },
        (payload) => {
          const notification = notificationFromRealtime(payload.new);
          if (!notification) return;
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
              rows: current.rows.map((row) => (row.id === notification.id ? notification : row)),
            };
          });
        },
      )
      .subscribe((status) => {
        if (!mounted.current) return;
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setState((current) => ({
            ...current,
            error: current.rows.length > 0 ? current.error : "Live notification delivery is unavailable; history remains available.",
          }));
        }
      });

    return () => {
      mounted.current = false;
      controller.abort();
      document.removeEventListener("pointerdown", unlockAudio);
      alertAudio.current?.pause();
      alertAudio.current = null;
      if (channel) void supabase?.removeChannel(channel);
    };
  }, [announce, enabled]);

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

  const setSoundPreference = React.useCallback((value: boolean) => {
    setSoundOn(value);
    try {
      window.localStorage.setItem(SOUND_PREFERENCE_KEY, value ? "on" : "off");
    } catch {
      // A storage restriction must not disable in-app notifications.
    }
  }, []);

  const markRead = React.useCallback(async (id: string) => {
    const response = await fetch("/api/adminsh/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_read", notificationId: id }),
      cache: "no-store",
    });
    const result = await readData<{ unreadCount: number }>(response);
    setState((current) => ({
      ...current,
      unreadCount: result.unreadCount,
      rows: current.rows.map((row) => (row.id === id ? { ...row, readAt: row.readAt ?? new Date().toISOString() } : row)),
    }));
  }, []);

  const markAllRead = React.useCallback(async () => {
    const response = await fetch("/api/adminsh/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_all_read" }),
      cache: "no-store",
    });
    const result = await readData<{ unreadCount: number }>(response);
    setState((current) => ({
      ...current,
      unreadCount: result.unreadCount,
      rows: current.rows.map((row) => ({ ...row, readAt: row.readAt ?? new Date().toISOString() })),
    }));
  }, []);

  const loadMore = React.useCallback(async () => {
    if (!state.hasMore || state.loadingMore) return;
    setState((current) => ({ ...current, loadingMore: true }));
    try {
      const response = await fetch(
        `/api/adminsh/notifications?limit=${PAGE_SIZE}&offset=${historyOffset.current}`,
        { cache: "no-store" },
      );
      const page = await readData<AdminNotificationsPage>(response);
      historyOffset.current += page.limit;
      const rows = page.rows.filter((row) => !knownIds.current.has(row.id));
      rows.forEach((row) => knownIds.current.add(row.id));
      setState((current) => ({
        ...current,
        rows: [...current.rows, ...rows],
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
  }, [state.hasMore, state.loadingMore, state.rows.length]);

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
