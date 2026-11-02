-- Add a caller-scoped read for the active account's suspension reason.
-- The audit table remains admin-readable only; this function returns no row
-- other than the authenticated caller's own latest active block reason.

begin;

create or replace function public.current_user_restriction_reason()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select e.reason
  from public.account_restriction_events e
  join auth.users u on u.id = e.target_user_id
  where e.target_user_id = (select auth.uid())
    and e.action = 'blocked'
    and e.resulting_banned_until = u.banned_until
    and u.banned_until is not null
    and u.banned_until > now()
  order by e.created_at desc, e.id desc
  limit 1;
$$;

comment on function public.current_user_restriction_reason() is
  'Returns only the authenticated caller''s latest active account suspension reason. Does not expose account restriction audit rows to non-admin users.';

revoke all on function public.current_user_restriction_reason() from public;
revoke all on function public.current_user_restriction_reason() from anon;
grant execute on function public.current_user_restriction_reason() to authenticated;

create or replace function public.account_user_is_restricted(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'account_user_is_restricted: not authorized' using errcode = '42501';
  end if;

  return exists (
    select 1
    from auth.users u
    where u.id = p_user_id
      and u.banned_until is not null
      and u.banned_until > now()
  );
end;
$$;

comment on function public.account_user_is_restricted(uuid) is
  'Service-role-only account restriction check for durable generation workers. Authenticated users cannot inspect another account.';

revoke all on function public.account_user_is_restricted(uuid) from public;
revoke all on function public.account_user_is_restricted(uuid) from anon, authenticated;
grant execute on function public.account_user_is_restricted(uuid) to service_role;

create or replace function public.account_restriction_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 49;
$$;

comment on function public.account_restriction_schema_version() is
  'Account restriction schema marker. 49 includes caller-only reason lookup and service-role worker enforcement.';

commit;
