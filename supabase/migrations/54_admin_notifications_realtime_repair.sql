-- Mavly — re-assert the existing admin notification Realtime contract.
--
-- Apply after migration 53. This is deliberately a repair migration: it does
-- not create another notification table or trigger. It makes a previously
-- applied notification migration safe to upgrade when Realtime publication
-- membership was not present in the production database.

begin;

do $$
begin
  if to_regclass('public.admin_notifications') is null then
    raise exception
      'ADMIN_NOTIFICATIONS_SCHEMA_MISSING: apply migration 52 before migration 54';
  end if;

  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
      from pg_publication p
      join pg_publication_rel pr on pr.prpubid = p.oid
      join pg_class c on c.oid = pr.prrelid
      join pg_namespace n on n.oid = c.relnamespace
     where p.pubname = 'supabase_realtime'
       and n.nspname = 'public'
       and c.relname = 'admin_notifications'
  ) then
    alter publication supabase_realtime add table public.admin_notifications;
  end if;
end;
$$;

-- Realtime needs the complete row for the admin RLS check and UPDATE payloads.
alter table public.admin_notifications replica identity full;

-- Re-state the existing deny-by-default client boundary so this repair cannot
-- accidentally broaden access while fixing publication membership.
revoke all on public.admin_notifications from public, anon;
revoke insert, update, delete, truncate on public.admin_notifications from authenticated;
grant select on public.admin_notifications to authenticated;

drop policy if exists admin_notifications_select_admin on public.admin_notifications;
create policy admin_notifications_select_admin
  on public.admin_notifications
  for select
  to authenticated
  using (public.current_user_is_admin());

commit;
