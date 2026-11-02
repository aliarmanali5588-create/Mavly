-- Mavly — live public announcement banner settings.
--
-- Apply after migration 52. This migration reuses admin_settings and
-- admin_audit_log; it creates no announcement-management table.
--
-- The Settings card writes enabled + message through one RPC so an enablement
-- can never become visible with a half-written message. Public visitors read a
-- separate, narrow RPC that returns only the current banner message.

begin;

-- ── 1. Add the message to the existing settings registry ────────────────────

create or replace function public.admin_settings_registry()
returns table (
  key text,
  kind text,
  editable boolean,
  default_value jsonb,
  description text
)
language sql
immutable
set search_path = public, pg_temp
as $$
  values
    ('announcements.enabled', 'boolean', true, 'true'::jsonb,
     'Show the saved announcement on the public Mavly website.'),
    ('announcements.message', 'text', true, '""'::jsonb,
     'Plain-text message shown in the public announcement banner (500 characters maximum).'),
    ('credits.max_adjustment', 'integer', true, '100000'::jsonb,
     'Largest single credit grant or adjustment an administrator may apply.'),
    ('audit.retention_days', 'integer', true, '90'::jsonb,
     'How far back the audit log page reads. Older rows are retained, not deleted.'),
    ('console.platform_name', 'text', true, '"Mavly"'::jsonb,
     'Platform name shown in the admin console header.'),
    ('console.support_email', 'text', true, '"support@mavly.xyz"'::jsonb,
     'Support address shown in the admin console. Not wired to public pages.');
$$;

comment on function public.admin_settings_registry() is
  'The only writable settings keys, with type and default. Announcement message is plain text and capped at 500 characters.';

-- ── 2. Keep generic setting writes safe for the new message key ─────────────

create or replace function public.admin_settings_write(
  p_key text,
  p_value jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_key text := nullif(btrim(coalesce(p_key, '')), '');
  v_reg record;
  v_previous jsonb;
  v_text text;
  v_number numeric;
  v_enabled boolean;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_settings_write: not authorized' using errcode = '42501';
  end if;
  if v_key is null then
    raise exception 'INVALID_SETTING_KEY' using errcode = '22023';
  end if;
  if p_value is null then
    raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
  end if;

  select * into v_reg from public.admin_settings_registry() reg where reg.key = v_key;
  if not found then
    raise exception 'UNKNOWN_SETTING' using errcode = '22023';
  end if;
  if not v_reg.editable then
    raise exception 'SETTING_NOT_EDITABLE' using errcode = '42501';
  end if;

  -- Type and range validation remains server-owned.
  if v_reg.kind = 'boolean' then
    if jsonb_typeof(p_value) is distinct from 'boolean' then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
  elsif v_reg.kind = 'integer' then
    if jsonb_typeof(p_value) is distinct from 'number' then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    v_number := (p_value #>> '{}')::numeric;
    if v_number <> trunc(v_number) then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    if v_key = 'credits.max_adjustment' and (v_number < 1 or v_number > 1000000) then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    if v_key = 'audit.retention_days' and (v_number < 1 or v_number > 3650) then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
  elsif v_reg.kind = 'text' then
    if jsonb_typeof(p_value) is distinct from 'string' then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    v_text := btrim(p_value #>> '{}');
    if v_key = 'announcements.message' then
      if char_length(v_text) > 500 then
        raise exception 'ANNOUNCEMENT_MESSAGE_TOO_LONG' using errcode = '22023';
      end if;
      select coalesce((s.value = 'true'::jsonb), true)
        into v_enabled
      from public.admin_settings s
      where s.key = 'announcements.enabled';
      if coalesce(v_enabled, true) and char_length(v_text) < 1 then
        raise exception 'ANNOUNCEMENT_MESSAGE_REQUIRED' using errcode = '22023';
      end if;
    elsif char_length(v_text) < 1 or char_length(v_text) > 200 then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    if v_key = 'console.support_email'
      and v_text !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    p_value := to_jsonb(v_text);
  end if;

  if v_key = 'announcements.enabled' and (p_value = 'true'::jsonb) then
    if not exists (
      select 1
      from public.admin_settings s
      where s.key = 'announcements.message'
        and jsonb_typeof(s.value) = 'string'
        and char_length(btrim(s.value #>> '{}')) > 0
    ) then
      raise exception 'ANNOUNCEMENT_MESSAGE_REQUIRED' using errcode = '22023';
    end if;
  end if;

  select s.value into v_previous from public.admin_settings s where s.key = v_key;

  insert into public.admin_settings (key, value, updated_by, updated_by_email, updated_at)
  values (v_key, p_value, v_actor, (select email from auth.users u where u.id = v_actor), now())
  on conflict (key) do update
    set value = excluded.value,
        updated_by = excluded.updated_by,
        updated_by_email = excluded.updated_by_email,
        updated_at = now();

  select email into v_actor_email from auth.users u where u.id = v_actor;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, outcome, metadata
  ) values (
    v_actor, v_actor_email, 'setting.updated', 'setting', v_key, 'success',
    jsonb_build_object('previous', v_previous, 'next', p_value)
  );

  return jsonb_build_object(
    'key', v_key,
    'value', p_value,
    'previous', v_previous,
    'changed', v_previous is distinct from p_value
  );
end;
$$;

comment on function public.admin_settings_write(text, jsonb) is
  'Admin-only validated write of a runtime setting. Announcement enablement requires a non-empty saved message and every write is audited.';

revoke all on function public.admin_settings_write(text, jsonb) from public, anon;
grant execute on function public.admin_settings_write(text, jsonb) to authenticated, service_role;

-- ── 3. Atomic Settings-card write ───────────────────────────────────────────

create or replace function public.admin_announcement_settings_write(
  p_enabled boolean,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_message text := btrim(coalesce(p_message, ''));
  v_previous_enabled jsonb := 'true'::jsonb;
  v_previous_message jsonb := '""'::jsonb;
  v_previous jsonb;
  v_next jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_announcement_settings_write: not authorized' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
  end if;
  if char_length(v_message) > 500 then
    raise exception 'ANNOUNCEMENT_MESSAGE_TOO_LONG' using errcode = '22023';
  end if;
  if p_enabled and char_length(v_message) < 1 then
    raise exception 'ANNOUNCEMENT_MESSAGE_REQUIRED' using errcode = '22023';
  end if;

  v_previous_enabled := coalesce(
    (select s.value from public.admin_settings s where s.key = 'announcements.enabled'),
    'true'::jsonb
  );
  v_previous_message := coalesce(
    (select s.value from public.admin_settings s where s.key = 'announcements.message'),
    '""'::jsonb
  );

  v_previous := jsonb_build_object(
    'enabled', v_previous_enabled,
    'message', v_previous_message
  );
  v_next := jsonb_build_object(
    'enabled', p_enabled,
    'message', v_message
  );

  insert into public.admin_settings (key, value, updated_by, updated_by_email, updated_at)
  values
    ('announcements.enabled', to_jsonb(p_enabled), v_actor, (select email from auth.users u where u.id = v_actor), now()),
    ('announcements.message', to_jsonb(v_message), v_actor, (select email from auth.users u where u.id = v_actor), now())
  on conflict (key) do update
    set value = excluded.value,
        updated_by = excluded.updated_by,
        updated_by_email = excluded.updated_by_email,
        updated_at = now();

  select email into v_actor_email from auth.users u where u.id = v_actor;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, outcome, metadata
  ) values (
    v_actor, v_actor_email, 'announcement.settings.updated', 'setting', 'announcements', 'success',
    jsonb_build_object('previous', v_previous, 'next', v_next)
  );

  return jsonb_build_object(
    'enabled', p_enabled,
    'message', v_message,
    'previous', v_previous,
    'changed', v_previous is distinct from v_next
  );
end;
$$;

comment on function public.admin_announcement_settings_write(boolean, text) is
  'Admin-only atomic write of the public announcement enabled state and plain-text message, with one before/after audit event.';

revoke all on function public.admin_announcement_settings_write(boolean, text) from public, anon;
grant execute on function public.admin_announcement_settings_write(boolean, text) to authenticated, service_role;

-- ── 4. Public read boundary ─────────────────────────────────────────────────

create or replace function public.active_announcement_banner()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_enabled boolean := true;
  v_message text := '';
begin
  select coalesce((s.value = 'true'::jsonb), true)
    into v_enabled
  from public.admin_settings s
  where s.key = 'announcements.enabled';

  select case
    when jsonb_typeof(s.value) = 'string' then btrim(s.value #>> '{}')
    else ''
  end
    into v_message
  from public.admin_settings s
  where s.key = 'announcements.message';

  if not coalesce(v_enabled, true) or char_length(coalesce(v_message, '')) < 1 then
    return null;
  end if;

  return jsonb_build_object('message', v_message);
end;
$$;

comment on function public.active_announcement_banner() is
  'Public read-only announcement banner. Returns only a non-empty enabled plain-text message, or null when unavailable/inactive.';

revoke all on function public.active_announcement_banner() from public;
grant execute on function public.active_announcement_banner() to anon, authenticated, service_role;

commit;
