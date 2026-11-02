export type AdminNotificationEventType =
  | "user_signup"
  | "plan_purchase"
  | "plan_upgrade"
  | "plan_renewal"
  | "plan_downgrade"
  | "subscription_cancelled"
  | "subscription_expired"
  | "payment_failed"
  | "refund_completed";

export interface AdminNotification {
  id: string;
  eventType: AdminNotificationEventType;
  title: string;
  message: string;
  userId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface AdminNotificationsPage {
  rows: AdminNotification[];
  total: number;
  unreadCount: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function isAdminNotificationEventType(value: unknown): value is AdminNotificationEventType {
  return (
    typeof value === "string" &&
    [
      "user_signup",
      "plan_purchase",
      "plan_upgrade",
      "plan_renewal",
      "plan_downgrade",
      "subscription_cancelled",
      "subscription_expired",
      "payment_failed",
      "refund_completed",
    ].includes(value)
  );
}

export function normalizeAdminNotification(value: unknown): AdminNotification | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !isAdminNotificationEventType(row.eventType) ||
    typeof row.title !== "string" ||
    typeof row.message !== "string" ||
    typeof row.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    eventType: row.eventType,
    title: row.title,
    message: row.message,
    userId: typeof row.userId === "string" ? row.userId : null,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: row.createdAt,
    readAt: typeof row.readAt === "string" ? row.readAt : null,
  };
}

/** OS notifications intentionally avoid email, ids, amounts and other details. */
export function desktopNotificationBody(eventType: AdminNotificationEventType): string {
  switch (eventType) {
    case "user_signup":
      return "A new user joined Mavly.";
    case "plan_purchase":
      return "A verified plan purchase was recorded.";
    case "plan_upgrade":
      return "A subscription upgrade was recorded.";
    case "plan_renewal":
      return "A subscription renewal was recorded.";
    case "plan_downgrade":
      return "A subscription plan change was recorded.";
    case "subscription_cancelled":
      return "A subscription cancellation was recorded.";
    case "subscription_expired":
      return "A subscription expiration was recorded.";
    case "payment_failed":
      return "A payment failure requires review.";
    case "refund_completed":
      return "A refund completion was recorded.";
  }
}

export function adminNotificationDestination(eventType: AdminNotificationEventType): string {
  if (eventType === "user_signup") return "/adminsh/users";
  if (
    eventType === "plan_purchase" ||
    eventType === "plan_upgrade" ||
    eventType === "plan_renewal" ||
    eventType === "plan_downgrade" ||
    eventType === "subscription_cancelled" ||
    eventType === "subscription_expired" ||
    eventType === "payment_failed" ||
    eventType === "refund_completed"
  ) {
    return "/adminsh/billing";
  }
  return "/adminsh/dashboard";
}

export function formatAdminNotificationAge(value: string, now = Date.now()): string {
  const created = Date.parse(value);
  if (!Number.isFinite(created)) return "Unknown time";
  const seconds = Math.max(0, Math.floor((now - created) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(created));
}
