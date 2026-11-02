import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  adminNotificationDestination,
  desktopNotificationBody,
  formatAdminNotificationAge,
  normalizeAdminNotification,
} from "../src/lib/admin/notifications";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/52_admin_notifications_and_reporting.sql");
const route = read("src/app/api/adminsh/notifications/route.ts");
const hook = read("src/app/adminsh/components/useAdminNotifications.ts");

test("notification payloads are normalized and desktop copy is privacy-safe", () => {
  const row = normalizeAdminNotification({
    id: "notification-id",
    eventType: "user_signup",
    title: "New User Registered",
    message: "A new user has joined Mavly.",
    userId: "user-id",
    metadata: { email: "person@example.com" },
    createdAt: "2026-11-02T10:00:00.000Z",
    readAt: null,
  });
  assert.equal(row?.eventType, "user_signup");
  assert.equal(desktopNotificationBody("user_signup"), "A new user joined Mavly.");
  assert.doesNotMatch(desktopNotificationBody("plan_purchase"), /₹|@|user-id|payment/i);
  assert.equal(adminNotificationDestination("user_signup"), "/adminsh/users");
  assert.equal(adminNotificationDestination("plan_purchase"), "/adminsh/billing");
  assert.equal(formatAdminNotificationAge("2026-11-02T10:00:00.000Z", Date.parse("2026-11-02T10:00:30.000Z")), "Just now");
});

test("the notification migration is persistent, deduplicated and admin-gated", () => {
  assert.match(migration, /create table if not exists public\.admin_notifications/);
  assert.match(migration, /deduplication_key text unique/);
  assert.match(migration, /on conflict \(deduplication_key\) do nothing/);
  assert.match(migration, /create policy admin_notifications_select_admin/);
  assert.match(migration, /public\.current_user_is_admin\(\)/);
  assert.match(migration, /create or replace function public\.handle_new_user\(\)/);
  assert.match(migration, /perform public\.record_admin_notification\(/);
  assert.match(migration, /alter publication supabase_realtime add table public\.admin_notifications/);
  assert.doesNotMatch(migration, /gateway_apply_webhook_payment|payment\.captured|subscription\.charged/i);
});

test("notification API and client use the existing admin boundary and one realtime channel", () => {
  assert.match(route, /await requireAdmin\(\)/);
  assert.match(route, /admin_notifications_page/);
  assert.match(route, /admin_notifications_mark_read/);
  assert.match(route, /admin_notifications_mark_all_read/);
  assert.doesNotMatch(route, /SERVICE_ROLE|service_role|createClient\(/);
  assert.match(hook, /postgres_changes/);
  assert.match(hook, /mavly-admin-notifications/);
  assert.match(hook, /removeChannel/);
  assert.match(hook, /\/sound\/adminpanelnotification\.mp3/);
  assert.match(hook, /Notification\.requestPermission/);
});
