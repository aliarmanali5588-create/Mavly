"use client";

const SOUND_URL = "/sound/adminpanelnotification.mp3";

type AudioResult = "queued" | "duplicate" | "disabled";

function log(message: string, details?: unknown) {
  console.info(`[admin notification audio] ${message}`, details ?? "");
}

function logError(message: string, error?: unknown) {
  console.error(`[admin notification audio] ${message}`, error ?? "");
}

/**
 * One audio element and one played-id set per browser tab. Keeping this outside
 * React means a route transition or Strict Mode remount cannot create another
 * element or replay an already delivered notification.
 */
class AdminNotificationAudioManager {
  private audio: HTMLAudioElement | null = null;
  private unlocked = false;
  private playing = false;
  private unlockListenerCount = 0;
  private readonly playedIds = new Set<string>();
  private readonly blockedIds = new Set<string>();
  private readonly queuedIds: string[] = [];

  initialize(): void {
    if (typeof window === "undefined" || this.audio) return;

    const audio = new Audio(SOUND_URL);
    audio.preload = "auto";
    audio.addEventListener("loadeddata", () => log("sound asset loaded", { url: SOUND_URL }));
    audio.addEventListener("error", () => {
      logError("sound asset could not be loaded; verify the production asset returns HTTP 200", {
        url: SOUND_URL,
        mediaErrorCode: audio.error?.code ?? null,
      });
    });
    this.audio = audio;
    log("initialized", { url: SOUND_URL });
  }

  attachUnlockListeners(): () => void {
    if (typeof document === "undefined") return () => undefined;
    this.initialize();
    this.unlockListenerCount += 1;
    if (this.unlockListenerCount === 1) {
      document.addEventListener("pointerdown", this.handleGesture, true);
      document.addEventListener("keydown", this.handleGesture, true);
      document.addEventListener("touchstart", this.handleGesture, true);
    }

    return () => {
      this.unlockListenerCount = Math.max(0, this.unlockListenerCount - 1);
      if (this.unlockListenerCount > 0) return;
      document.removeEventListener("pointerdown", this.handleGesture, true);
      document.removeEventListener("keydown", this.handleGesture, true);
      document.removeEventListener("touchstart", this.handleGesture, true);
    };
  }

  setEnabled(enabled: boolean): void {
    if (enabled) return;
    this.blockedIds.clear();
    this.queuedIds.length = 0;
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
  }

  /** Call this only from a real user gesture, such as the Sound control. */
  async unlockFromGesture(): Promise<boolean> {
    this.initialize();
    const audio = this.audio;
    if (!audio) return false;
    if (this.unlocked) {
      void this.drainQueue();
      return true;
    }

    const previousMuted = audio.muted;
    audio.muted = true;
    try {
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      audio.muted = previousMuted;
      this.unlocked = true;
      log("audio playback unlocked by user gesture");
      this.queuedIds.push(...this.blockedIds);
      this.blockedIds.clear();
      void this.drainQueue();
      return true;
    } catch (error) {
      audio.pause();
      audio.currentTime = 0;
      audio.muted = previousMuted;
      logError("audio unlock was rejected by the browser; notification UI remains available", error);
      return false;
    }
  }

  play(notificationId: string, enabled: boolean): AudioResult {
    if (!enabled) return "disabled";
    if (this.playedIds.has(notificationId)) {
      log("duplicate playback suppressed", { notificationId });
      return "duplicate";
    }

    this.initialize();
    this.playedIds.add(notificationId);
    this.queuedIds.push(notificationId);
    log("queued notification sound", { notificationId });
    void this.drainQueue();
    return "queued";
  }

  private readonly handleGesture = () => {
    void this.unlockFromGesture();
  };

  private async drainQueue(): Promise<void> {
    if (this.playing || this.queuedIds.length === 0) return;
    const audio = this.audio;
    if (!audio) return;

    const notificationId = this.queuedIds.shift();
    if (!notificationId) return;
    this.playing = true;
    let onEnded: EventListener | null = null;

    try {
      audio.currentTime = 0;
      const ended = new Promise<void>((resolve) => {
        onEnded = () => resolve();
        audio.addEventListener("ended", onEnded, { once: true });
      });
      await audio.play();
      this.unlocked = true;
      this.blockedIds.delete(notificationId);
      log("played notification sound", { notificationId });
      await ended;
    } catch (error) {
      // A rejected play() never emits ended; remove the one-shot listener so a
      // blocked browser cannot accumulate listeners for every notification.
      if (onEnded) audio.removeEventListener("ended", onEnded);
      this.blockedIds.add(notificationId);
      logError("notification sound playback was rejected; no fake success is reported", {
        notificationId,
        error,
      });
    } finally {
      this.playing = false;
      void this.drainQueue();
    }
  }
}

let sharedAudioManager: AdminNotificationAudioManager | null = null;

export function getAdminNotificationAudioManager(): AdminNotificationAudioManager {
  if (!sharedAudioManager) sharedAudioManager = new AdminNotificationAudioManager();
  return sharedAudioManager;
}
