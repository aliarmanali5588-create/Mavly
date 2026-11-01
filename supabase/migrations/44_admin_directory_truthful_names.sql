-- Keep the existing directory RPC contracts while removing name fallbacks
-- derived from email addresses or project IDs. Apply after migration 43.
--
-- The original functions remain private implementation details; only these
-- wrappers are executable by authenticated callers. Both wrappers repeat the
-- admin check so the authorization boundary stays explicit.

begin;

do $$
begin
  if to_regprocedure('public.admin_user_directory_v41(text,text,integer,integer)') is null then
    alter function public.admin_user_directory(text, text, integer, integer)
      rename to admin_user_directory_v41;
  end if;

  if to_regprocedure('public.admin_project_directory_v41(text,text,text,integer,integer)') is null then
    alter function public.admin_project_directory(text, text, text, integer, integer)
      rename to admin_project_directory_v41;
  end if;
end;
$$;

revoke all on function public.admin_user_directory_v41(text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.admin_project_directory_v41(text, text, text, integer, integer)
  from public, anon, authenticated;

create or replace function public.admin_user_directory(
  p_search text default null,
  p_status text default 'all',
  p_page integer default 1,
  p_page_size integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_rows jsonb;
begin
  if auth.uid() is null or not public.current_user_is_admin() then
    raise exception 'admin_user_directory: not authorized' using errcode = '42501';
  end if;

  v_result := public.admin_user_directory_v41(p_search, p_status, p_page, p_page_size);

  select coalesce(
    jsonb_agg(
      jsonb_set(
        entry.value,
        '{name}',
        coalesce(to_jsonb(names.full_name), 'null'::jsonb),
        true
      )
      order by entry.ordinal
    ),
    '[]'::jsonb
  )
  into v_rows
  from jsonb_array_elements(coalesce(v_result -> 'rows', '[]'::jsonb))
    with ordinality as entry(value, ordinal)
  left join auth.users auth_user
    on auth_user.id = (entry.value ->> 'id')::uuid
  left join public.profiles profile
    on profile.id = auth_user.id
  cross join lateral (
    select coalesce(
      nullif(btrim(profile.full_name), ''),
      nullif(btrim(auth_user.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(auth_user.raw_user_meta_data ->> 'name'), '')
    ) as full_name
  ) names;

  return jsonb_set(v_result, '{rows}', v_rows, true);
end;
$$;

comment on function public.admin_user_directory(text, text, integer, integer) is
  'Admin-only read-only Users directory. Names are null when no profile or auth metadata name is recorded.';

create or replace function public.admin_project_directory(
  p_search text default null,
  p_status text default 'all',
  p_visibility text default 'all',
  p_page integer default 1,
  p_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_rows jsonb;
begin
  if auth.uid() is null or not public.current_user_is_admin() then
    raise exception 'admin_project_directory: not authorized' using errcode = '42501';
  end if;

  v_result := public.admin_project_directory_v41(
    p_search, p_status, p_visibility, p_page, p_page_size
  );

  select coalesce(
    jsonb_agg(
      jsonb_set(
        jsonb_set(
          entry.value,
          '{name}',
          coalesce(to_jsonb(nullif(btrim(project.label), '')), 'null'::jsonb),
          true
        ),
        '{owner}',
        coalesce(to_jsonb(names.full_name), 'null'::jsonb),
        true
      )
      order by entry.ordinal
    ),
    '[]'::jsonb
  )
  into v_rows
  from jsonb_array_elements(coalesce(v_result -> 'rows', '[]'::jsonb))
    with ordinality as entry(value, ordinal)
  join public.projects project
    on project.project_id = entry.value ->> 'id'
  join auth.users auth_user
    on auth_user.id = project.user_id
  left join public.profiles profile
    on profile.id = auth_user.id
  cross join lateral (
    select coalesce(
      nullif(btrim(profile.full_name), ''),
      nullif(btrim(auth_user.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(auth_user.raw_user_meta_data ->> 'name'), '')
    ) as full_name
  ) names;

  return jsonb_set(v_result, '{rows}', v_rows, true);
end;
$$;

comment on function public.admin_project_directory(text, text, text, integer, integer) is
  'Admin-only read-only project directory. Project/owner names are null when no name is recorded.';

revoke all on function public.admin_user_directory(text, text, integer, integer) from public, anon;
revoke all on function public.admin_project_directory(text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_user_directory(text, text, integer, integer) to authenticated;
grant execute on function public.admin_project_directory(text, text, text, integer, integer) to authenticated;

commit;
