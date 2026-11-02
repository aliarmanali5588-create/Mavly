"use client";

import { Megaphone } from "lucide-react";
import { useEffect, useState } from "react";

interface AnnouncementResponse {
  message: string;
}

/**
 * Reads the public announcement on mount. A failed or empty read renders
 * nothing, so the marketing site never invents a message or becomes dependent
 * on the announcement service for its normal page content.
 */
export function AnnouncementBanner() {
  const [announcement, setAnnouncement] = useState<AnnouncementResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/public/announcement", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; data?: AnnouncementResponse | null }
          | null;
        if (payload?.ok !== true || !payload.data || typeof payload.data.message !== "string") {
          return null;
        }
        const message = payload.data.message.trim();
        return message === "" ? null : { message };
      })
      .then((nextAnnouncement) => {
        if (!controller.signal.aborted) setAnnouncement(nextAnnouncement);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnnouncement(null);
      });

    return () => controller.abort();
  }, []);

  if (!announcement) return null;

  return (
    <aside
      role="status"
      aria-live="polite"
      className="w-full border-b border-[var(--clay-line)] bg-[var(--clay-sunken)] text-foreground"
    >
      <div className="mx-auto flex max-w-7xl items-start gap-2.5 px-4 py-2.5 text-xs sm:px-8 sm:py-3 sm:text-sm">
        <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium leading-relaxed">
          {announcement.message}
        </p>
      </div>
    </aside>
  );
}
