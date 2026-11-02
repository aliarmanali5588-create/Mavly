# Admin authentication rollout

Migration `supabase/migrations/55_admin_authentication.sql` adds the strict
admin identity and session boundary.

## Rollout

1. Confirm the legitimate Supabase Auth account for the approved address
   `aliarmanali5588@gmail.com` exists and has a non-null
   `auth.users.email_confirmed_at`.
2. Apply migration 55 with the Supabase SQL editor or migration runner.
   It inserts the real Auth UUID only when that confirmed account exists; it
   never creates an Auth user or invents an ID.
3. If the account was confirmed after migration 55 was applied, run the
   service-role-only bootstrap function from a trusted operator session:

   ```sql
   select public.bootstrap_admin_user();
   ```

   `true` means the existing confirmed account was registered. `false` means
   the legitimate account is still missing, unconfirmed, deleted, or banned.
4. Deploy the application after the migration is available.

Apply migration 55 and deploy this application as one coordinated change. The
pre-55 application intentionally fails closed once the replacement
`current_user_is_admin()` predicate is installed; schedule the short transition
so the legitimate admin can sign in through the new flow immediately after the
deployment.

To verify the real registration from a privileged SQL session without copying
any credential into the application:

```sql
select id, email, email_confirmed_at
from auth.users
where lower(btrim(email)) = 'aliarmanali5588@gmail.com';

select user_id, email, is_active
from public.admin_users;
```

The UUID in both results must be the same, with a confirmed email and
`is_active = true`.

## Session contract

Supabase SSR cookies remain the browser/PWA session transport. They are
persistent, auto-refreshing and never cached by `public/sw.js`. The database
adds a separate `admin_sessions` row tied to Supabase's `session_id` claim.
The row expires exactly eight hours after a successful admin authentication;
token refreshes update neither `created_at` nor `expires_at`. Every admin page,
API route and admin RPC checks the active row. Expiry is revoked on the next
check, and sign-out revokes the current admin row before clearing Auth cookies.

## Rollback

1. Disable the application deployment or revert application code to the prior
   compatible version if the rollout must be paused. Do not deploy a pre-55
   admin build that cannot create or validate `admin_sessions`.
2. Keep migration 55 applied. It is additive and the old allowlist remains in
   place; no destructive SQL rollback is required.
3. To revoke admin access immediately, set the sole `admin_users.is_active`
   value to `false` from a privileged operator session. Existing requests fail
   the database check; no browser flag can restore access.
4. Re-enable the row only after the approved Auth account and deployment are
   confirmed. Do not drop the tables or delete the Auth user as a rollback.
