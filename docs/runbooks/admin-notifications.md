# Admin notifications and reporting

Migration `supabase/migrations/52_admin_notifications_and_reporting.sql` adds the
production admin notification store. Apply it after migration 51 before deploying
the admin UI changes. Apply
`supabase/migrations/54_admin_notifications_realtime_repair.sql` after migration 53
when upgrading an environment that already has migration 52 applied; it reasserts
Realtime publication membership and the existing admin-only RLS boundary.

## What is authoritative

- `auth.users` is the signup source of truth. The existing `on_auth_user_created`
  trigger still creates the profile and now also writes one `user_signup`
  notification in the same transaction.
- Notification deduplication uses `user_signup:<auth-user-id>` and the database
  unique constraint on `deduplication_key`.
- This repository has no Mavly platform subscription/payment table or trusted
  platform Razorpay webhook. Customer-app Razorpay integration rows are not
  treated as Mavly revenue and do not create purchase/upgrade/renewal events.
  Those event types are reserved for a future verified server-side billing path
  calling `record_admin_notification`.
- Overview and AI usage periods use Asia/Kolkata boundaries. `7d` and `30d`
  include today and the preceding calendar dates; `3m` starts at the first day
  of the current month minus two months; `ytd` starts at January 1 in India.

## Security and delivery

`admin_notifications` has RLS and no authenticated write grant. Reads and read
state changes go through admin-gated RPCs, and notification creation is restricted
to the trusted server role plus the database auth trigger. The browser uses the
existing authenticated session-scoped Supabase client for one shared Realtime
channel. The channel is bound before the initial API history fetch, waits for the
Postgres CDC subscription to report `SUBSCRIBED`, and then reconciles history again
after reconnects. Realtime is an acceleration rather than the source of truth, and
database UUIDs deduplicate delivery.

The UI provides explicit desktop-notification permission and sound controls. The
sound manager uses one preloaded `/sound/adminpanelnotification.mp3` element per
browser tab, unlocks only from a real gesture, and logs rejected playback instead
of claiming that a sound played. Historical rows and read/filter changes never
invoke it.
Foreground Chrome `Notification` API delivery is implemented. There is no service
worker/Web Push implementation in this repository, so notifications are not
claimed to arrive when the Admin Panel is closed. The sound asset is the existing
`/sound/adminpanelnotification.mp3`; browser autoplay failures are logged and do
not affect in-app delivery.

## Operator checks

After applying the migration, confirm:

1. `public.admin_notifications_schema_version()` returns `52`.
2. `public.current_user_is_admin()` is true only for the configured admin.
3. `supabase_realtime` includes `public.admin_notifications` when Realtime is enabled.
4. A real OAuth signup creates one notification and a repeated trigger invocation
   cannot create another row for the same user.
5. Confirm the browser console reports `SUBSCRIBED` for
   `mavly-admin-notifications`, and reports incoming notification UUIDs for a real
   signup while the panel is open.
6. Confirm `/sound/adminpanelnotification.mp3` loads successfully in the deployed
   browser and that enabling Sound from a user gesture unlocks playback.
7. No platform billing notification or revenue number is enabled until a verified
   Mavly billing source exists.

The migration is additive. Cleanup is available only to `service_role` through
`cleanup_admin_notifications`, and removes read rows older than the bounded
retention period; unread rows are retained.
